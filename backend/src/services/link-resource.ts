import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "../db.ts";
import { compileFxpLink, FxpLinkInputSchema, type FxpPlacementConfig } from "../integrations/forwardx/link-compiler.ts";
import { canonicalConfigDigest } from "../integrations/forwardx/core-contract.ts";
import { newLinkTransportKey, sealLinkTransportKey, unsealLinkTransportKey } from "../integrations/forwardx/transport-secret.ts";
import { loadNodeCapabilityFacts } from "./runtime-admission.ts";
import { acquirePort, releaseLease, type PortPoolDb, type PortPoolTransaction } from "./portPool.ts";
import { sendLinkPlacement } from "./link-transport.ts";
import { createForwardRevision, type ForwardCandidateConfig } from "./forward-revision.ts";
import { withWorkspaceQuotaLock, countWorkspaceTunnels, sumWorkspaceTraffic } from "./policy-service.ts";
import { checkTunnelCreation, checkTunnelUse } from "./capability-policy.ts";
import { getEffectivePolicy } from "./policy-service.ts";
import { resolveForwardPolicy } from "./forward-policy.ts";
import { linkObservation } from "./link-observation.ts";
import { normalizeBindScope } from "../integrations/forwardx/bind-scope.ts";
import { checkAgentVersion } from "../integrations/forwardx/agent-version.ts";
import { LinkTargetSetSchema, persistedLinkTargetSet, targetSetMatchesFirst } from "../integrations/forwardx/target-set.ts";
import { LinkClientSourceSchema, persistedLinkClientSource, validateLinkClientSourceBinding } from "../integrations/forwardx/client-source.ts";

const id = z.number().int().positive().max(2_147_483_647);
const port = id.max(65_535);
export const LinkConfigSchema = z.object({
  ingress_node_id: id, egress_node_id: id, carrier_port: port,
}).strict().refine((v) => v.ingress_node_id !== v.egress_node_id, "point_to_point_requires_distinct_nodes");
export const LinkCreateSchema = z.object({
  name: z.string().trim().min(1).max(255), config: LinkConfigSchema,
}).strict();
export const LinkBindingSchema = z.object({
  name: z.string().trim().min(1).max(255), protocol: z.enum(["tcp", "udp", "both"]),
  listen_port: port, listen_host: z.enum(["", "127.0.0.1", "::1"]).default(""),
  target_host: z.string().trim().min(1).max(255).refine((h) => !/[\s/\x00]/.test(h)),
  target_port: port,
  target_set: LinkTargetSetSchema.optional(),
  client_source: LinkClientSourceSchema.optional(),
  bytes_per_second_in: z.number().int().min(0).max(2_147_483_647).default(0),
  bytes_per_second_out: z.number().int().min(0).max(2_147_483_647).default(0),
  max_connections: z.number().int().min(0).max(1_000_000).default(0),
  max_connections_per_ip: z.number().int().min(0).max(1_000_000).default(0),
}).strict().refine((b) => !b.target_set || targetSetMatchesFirst(b.target_set, b.target_host, b.target_port),
  "target_set_first_mismatch").superRefine(validateLinkClientSourceBinding);
export type LinkConfig = z.infer<typeof LinkConfigSchema>;
export type LinkBindingInput = z.input<typeof LinkBindingSchema>;
const LEASE_MS = 180_000;
const DeploymentSnapshotSchema = z.object({ spec: FxpLinkInputSchema,
  revisions: z.array(z.object({ id, revision: z.number().int().min(0) }).strict()) }).strict();

export class LinkResourceError extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 404 | 409 | 503 = 409) {
    super(code); this.name = "LinkResourceError";
  }
}
function sealKey(): string {
  const secret = process.env.TUNEX_LINK_SEAL_KEY ?? "";
  if (!/^[0-9a-f]{64}$/i.test(secret)) throw new LinkResourceError("link_seal_key_required", 503);
  return secret;
}
export function assertLinkFeature(): void {
  if (process.env.TUNEX_FXP_LINKS_ENABLED !== "true") throw new LinkResourceError("fxp_links_not_enabled", 409);
  sealKey();
}
async function scopedLink(workspaceId: number, linkId: number, client = db) {
  const link = await client.linkResource.findFirst({ where: { id: linkId, workspace_id: workspaceId } });
  if (!link) throw new LinkResourceError("link_not_found", 404);
  return link;
}
async function lockLink(tx: Prisma.TransactionClient, workspaceId: number, linkId: number) {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM link_resource WHERE id=${linkId} AND workspace_id=${workspaceId} FOR UPDATE`);
  const link = await tx.linkResource.findFirst({ where: { id: linkId, workspace_id: workspaceId } });
  if (!link) throw new LinkResourceError("link_not_found", 404);
  if (link.status === "retired") throw new LinkResourceError("link_retired");
  if (link.status === "retiring") throw new LinkResourceError("link_retiring");
  return link;
}
async function endpoints(workspaceId: number, config: LinkConfig) {
  const nodes = await db.node.findMany({ where: { id: { in: [config.ingress_node_id, config.egress_node_id] },
    node_group: { workspace_id: workspaceId } }, include: { node_group: true,
      state_report: { select: { version: true } } } });
  const ingress = nodes.find((n) => n.id === config.ingress_node_id);
  const egress = nodes.find((n) => n.id === config.egress_node_id);
  if (!ingress || !egress) throw new LinkResourceError("link_node_not_found", 404);
  if (!["ingress", "both"].includes(ingress.role ?? "") || !["egress", "both"].includes(egress.role ?? ""))
    throw new LinkResourceError("link_node_role_mismatch");
  for (const node of nodes) {
    if (node.lifecycle !== "active") throw new LinkResourceError("link_node_unavailable");
  }
  const [inFacts, outFacts] = await Promise.all([loadNodeCapabilityFacts(ingress.id), loadNodeCapabilityFacts(egress.id)]);
  const fact = (node: typeof ingress, capabilities: string[] | null | undefined) => {
    // Node.version is a historical display field (new rows default to unknown).
    // Authenticated heartbeats write NodeStateReport.version, not Node.version.
    // Never let the historical field admit a missing/unknown current report.
    const version = node.state_report?.version ?? "";
    const versionFailure = checkAgentVersion(version, null);
    if (versionFailure) throw new LinkResourceError(versionFailure);
    if (!capabilities?.includes("forward.link.fxp.v1"))
      throw new LinkResourceError("agent_fxp_capability_missing");
    return { id: node.id, workspace_id: workspaceId, connect_host: node.connect_ip ?? "",
      version, capabilities };
  };
  // The egress address must be explicitly configured; the ingress connect address
  // is not used for dialing but remains a declared endpoint identity.
  if (!egress.connect_ip) throw new LinkResourceError("hop_address_missing");
  return { ingress, egress, inFact: fact(ingress, inFacts?.capabilities), outFact: fact(egress, outFacts?.capabilities) };
}

export async function listLinks(workspaceId: number) {
  return db.linkResource.findMany({ where: { workspace_id: workspaceId },
    orderBy: { id: "desc" }, include: { _count: { select: { forwards: true } } } });
}
export async function getLink(workspaceId: number, linkId: number) {
  const link = await scopedLink(workspaceId, linkId);
  const [version, deployment, forwards] = await Promise.all([
    db.linkVersion.findUnique({ where: { link_id_version: { link_id: linkId, version: link.desired_version } } }),
    db.linkDeployment.findUnique({ where: { link_id_generation: { link_id: linkId, generation: link.generation } }, include: { placements: true } }),
    db.tunnel.findMany({ where: { link_resource_id: linkId, workspace_id: workspaceId }, select: {
      id: true, name: true, forward_protocol: true, listen_ip: true, listen_port: true,
      remote_host: true, remote_port: true, desired_status: true, apply_status: true,
      config_revision: true, applied_revision: true, user_id: true,
      bytes_per_second_in: true, bytes_per_second_out: true, max_connections: true, max_connections_per_ip: true,
      link_target_config: true, link_source_config: true,
    }, orderBy: { id: "asc" } }),
  ]);
  const reports = deployment ? await db.nodeStateReport.findMany({ where: {
    node_id: { in: deployment.placements.map((p) => p.node_id) } },
    select: { node_id: true, reported_at: true, link_placements: true } }) : [];
  // Bind indexes to the immutable deployed pool, rather than a newer desired
  // edit or an arbitrary rule supplied by the node report.
  const targetCounts = new Map<number, number>(deployment ? DeploymentSnapshotSchema.parse(deployment.binding_snapshot)
    .spec.bindings.filter((b) => b.target_set).map((b) => [b.forward_id, b.target_set!.targets.length]) : []);
  // Cumulative payload facts remain independent of runtime readiness. No
  // checkpoint means unknown, not an invented zero from the native reporter.
  const usage = forwards.length ? await db.linkTrafficCheckpoint.groupBy({
    by: ["forward_id"],
    where: { workspace_id: workspaceId, link_id: linkId, forward_id: { in: forwards.map((f) => f.id) } },
    _sum: { bytes_in: true, bytes_out: true, connections: true },
    _max: { updated_at: true },
  }) : [];
  return { ...link, config: version?.config ?? null,
    deployment: deployment ? { generation: deployment.generation, status: deployment.status,
      version: deployment.status === "active" && deployment.placements.every((p) => p.applied_generation === deployment.generation)
        ? deployment.version : null,
      lease_expires_at: deployment.lease_expires_at, placements: deployment.placements.map((p) => ({
        ...p, observation: linkObservation({ ...p, target_counts: targetCounts }, workspaceId, linkId,
          reports.find((report) => report.node_id === p.node_id) ?? null),
      })) } : null,
    forwards: forwards.map((forward) => {
      const measured = usage.find((row) => row.forward_id === forward.id);
      const { link_target_config, link_source_config, ...publicForward } = forward;
      return { ...publicForward, ...(link_target_config == null ? {} : { target_set: persistedLinkTargetSet(link_target_config) }),
        ...(link_source_config == null ? {} : { client_source: persistedLinkClientSource(link_source_config) }), traffic: measured ? {
        bytes_in: (measured._sum.bytes_in ?? 0n).toString(),
        bytes_out: (measured._sum.bytes_out ?? 0n).toString(),
        connections: (measured._sum.connections ?? 0n).toString(),
        last_received_at: measured._max.updated_at?.toISOString() ?? null,
      } : null };
    }) };
}
export async function createLink(workspaceId: number, actorId: number, raw: unknown) {
  assertLinkFeature();
  const spec = LinkCreateSchema.parse(raw);
  const nodes = await endpoints(workspaceId, spec.config);
  // Admission and actual compiler validation happen before persistence.
  compileFxpLink({ link_id: 1, workspace_id: workspaceId, version: 1, generation: 1,
    ingress: nodes.inFact, egress: nodes.outFact, carrier_port: spec.config.carrier_port,
    lease_expires_at: new Date(Date.now() + LEASE_MS).toISOString(), bindings: [] }, newLinkTransportKey());
  return db.$transaction(async (tx) => {
    const link = await tx.linkResource.create({ data: { workspace_id: workspaceId, created_by: actorId, name: spec.name } });
    await tx.linkVersion.create({ data: { link_id: link.id, version: 1,
      config: spec.config, config_digest: canonicalConfigDigest(spec.config) } });
    return link;
  });
}
export async function updateLink(workspaceId: number, linkId: number, expectedVersion: number, raw: unknown) {
  assertLinkFeature();
  const config = LinkConfigSchema.parse(raw);
  await endpoints(workspaceId, config);
  return db.$transaction(async (tx) => {
    const link = await lockLink(tx, workspaceId, linkId);
    if (link.desired_version !== expectedVersion) throw new LinkResourceError("link_version_conflict");
    const references = await tx.tunnel.count({ where: { link_resource_id: linkId } });
    // Endpoint/port moves need binding placement migration; never silently move
    // existing business listeners while only editing the shared resource.
    if (references) throw new LinkResourceError("link_has_references");
    // A deployed carrier must be retired on its old nodes before selecting new
    // endpoints. Do not abandon a leased remote process by changing metadata.
    if (link.generation > 0) throw new LinkResourceError("link_config_requires_retirement");
    const version = expectedVersion + 1;
    await tx.linkVersion.create({ data: { link_id: linkId, version, config, config_digest: canonicalConfigDigest(config) } });
    return tx.linkResource.update({ where: { id: linkId }, data: { desired_version: version } });
  });
}

type Deployment = Awaited<ReturnType<typeof prepareDeployment>>;
async function reservePlacements(tx: Prisma.TransactionClient, placements: FxpPlacementConfig[]) {
  // Reuse the caller's transaction: a failed second protocol must roll back the
  // first claim and the proposed business revision, without nesting transactions.
  const leaseDb = { node: tx.node, tunnel: tx.tunnel, nodePortLease: tx.nodePortLease,
    $transaction: async <T>(run: (client: PortPoolTransaction) => Promise<T>) =>
      run(tx as unknown as PortPoolTransaction) } as unknown as PortPoolDb;
  for (const placement of placements) for (const slot of placement.ports) {
    const result = await acquirePort({ nodeId: placement.node_id, leaseType: placement.role,
      preferredPort: slot.port, protocol: slot.protocol, bindScope: slot.host,
      linkId: placement.link_id, ownRuntimeIds: [placement.id, ...placement.runtime_ids],
      expiresAt: null, deps: { db: leaseDb } });
    if (!result.ok) throw new LinkResourceError(result.code);
  }
}
async function preflightBinding(tx: Prisma.TransactionClient, workspaceId: number,
  link: Awaited<ReturnType<typeof scopedLink>>, config: LinkConfig,
  nodes: Awaited<ReturnType<typeof endpoints>>, binding: z.output<typeof LinkBindingSchema>,
  forwardId: number, active = true) {
  // Compile suspended candidates too: capability checks, complete target/source
  // authorization and the 1 MiB budget must precede every durable edit.
  const policy = await getEffectivePolicy(workspaceId, { client: tx, noCache: true });
  const rows = await tx.tunnel.findMany({ where: { workspace_id: workspaceId,
    link_resource_id: link.id, desired_status: "active" }, orderBy: { id: "asc" } });
  const bindings = rows.filter((r) => r.id !== forwardId).map((r) => ({ forward_id: r.id,
    protocol: r.forward_protocol as "tcp" | "udp" | "both", listen_port: r.listen_port!,
    listen_host: (r.listen_ip === "127.0.0.1" || r.listen_ip === "::1" ? r.listen_ip : "") as "" | "127.0.0.1" | "::1",
    target_host: r.remote_host!, target_port: r.remote_port!,
    ...(r.link_target_config == null ? {} : { target_set: persistedLinkTargetSet(r.link_target_config) }),
    ...(r.link_source_config == null ? {} : { client_source: persistedLinkClientSource(r.link_source_config) }),
    ...resolveForwardPolicy(r, policy.limits) }));
  bindings.push({ forward_id: forwardId, protocol: binding.protocol,
    listen_port: binding.listen_port, listen_host: binding.listen_host,
    target_host: binding.target_host, target_port: binding.target_port,
    ...(binding.target_set ? { target_set: binding.target_set } : {}),
    ...(binding.client_source ? { client_source: binding.client_source } : {}),
    ...resolveForwardPolicy(binding, policy.limits) });
  let compiled;
  try { compiled = compileFxpLink({ link_id: link.id, workspace_id: workspaceId,
    version: link.desired_version, generation: link.generation + 1, ingress: nodes.inFact, egress: nodes.outFact,
    carrier_port: config.carrier_port, lease_expires_at: new Date(Date.now() + LEASE_MS).toISOString(), bindings }, "00".repeat(32)); }
  catch (error) { throw new LinkResourceError(error instanceof Error && /^[a-z_]{1,64}$/.test(error.message)
    ? error.message : "link_binding_invalid"); }
  // A suspended edit must pass the same capability and byte budget preflight,
  // but must not reserve or deploy its inactive listener.
  if (!active) compiled = compileFxpLink({ link_id: link.id, workspace_id: workspaceId,
    version: link.desired_version, generation: link.generation + 1, ingress: nodes.inFact, egress: nodes.outFact,
    carrier_port: config.carrier_port, lease_expires_at: new Date(Date.now() + LEASE_MS).toISOString(),
    bindings: bindings.filter((b) => b.forward_id !== forwardId) }, "00".repeat(32));
  await reservePlacements(tx, [compiled.egress, compiled.ingress]);
}
async function prepareDeployment(workspaceId: number, linkId: number, rotate: boolean, retiring = false) {
  assertLinkFeature();
  const current = await scopedLink(workspaceId, linkId);
  const version = await db.linkVersion.findUniqueOrThrow({ where: { link_id_version: { link_id: linkId, version: current.desired_version } } });
  const config = LinkConfigSchema.parse(version.config);
  const nodes = await endpoints(workspaceId, config);
  return db.$transaction(async (tx) => {
    const link = await lockLink(tx, workspaceId, linkId);
    if (link.desired_version !== current.desired_version) throw new LinkResourceError("link_version_conflict");
    const generation = link.generation + 1;
    if ((retiring || rotate) && await tx.tunnel.count({ where: { link_resource_id: linkId } }))
      throw new LinkResourceError("link_has_references");
    const rows = await tx.tunnel.findMany({ where: { workspace_id: workspaceId, link_resource_id: linkId, desired_status: "active" }, orderBy: { id: "asc" } });
    const policy = await getEffectivePolicy(workspaceId, { client: tx, noCache: true });
    const trafficUsed = await sumWorkspaceTraffic(workspaceId, policy.limits.traffic_period, new Date(), tx);
    for (const row of rows) {
      for (const protocol of row.forward_protocol === "both" ? ["tcp", "udp"] : [row.forward_protocol ?? ""]) {
        const decision = checkTunnelUse(policy, { trafficUsed, protocol, inGroupOwned: true,
          outGroupOwned: true, inGroupId: nodes.ingress.node_group_id, outGroupId: nodes.egress.node_group_id });
        if (!decision.allowed) throw new LinkResourceError(decision.reason ?? "policy_denied", 403);
      }
    }
    const bindings = rows.map((r) => ({ forward_id: r.id, protocol: r.forward_protocol as "tcp" | "udp" | "both",
      listen_port: r.listen_port!, listen_host: r.listen_ip === "127.0.0.1" || r.listen_ip === "::1" ? r.listen_ip : "" as const,
      target_host: r.remote_host!, target_port: r.remote_port!,
      ...(r.link_target_config == null ? {} : { target_set: persistedLinkTargetSet(r.link_target_config) }),
      ...(r.link_source_config == null ? {} : { client_source: persistedLinkClientSource(r.link_source_config) }),
      ...resolveForwardPolicy(r, policy.limits) }));
    const lease = new Date(Date.now() + LEASE_MS);
    const input = FxpLinkInputSchema.parse({ link_id: linkId, workspace_id: workspaceId,
      version: link.desired_version, generation, ingress: nodes.inFact, egress: nodes.outFact,
      carrier_port: config.carrier_port, lease_expires_at: lease.toISOString(), bindings });
    const previous = link.generation ? await tx.linkTransportCredential.findUnique({
      where: { link_id_generation: { link_id: linkId, generation: link.generation } } }) : null;
    if (link.generation && !previous && !rotate) throw new LinkResourceError("link_credential_missing", 503);
    const secret = !rotate && previous
      ? unsealLinkTransportKey(previous.secret_enc, sealKey(), workspaceId, linkId, previous.generation) : newLinkTransportKey();
    let placements;
    try { placements = compileFxpLink(input, secret); }
    catch (error) { throw new LinkResourceError(error instanceof Error && /^[a-z_]{1,64}$/.test(error.message)
      ? error.message : "link_binding_invalid"); }
    if (!retiring) await reservePlacements(tx, [placements.egress, placements.ingress]);
    await tx.linkTransportCredential.create({ data: { link_id: linkId, generation,
      secret_enc: sealLinkTransportKey(secret, sealKey(), workspaceId, linkId, generation) } });
    const deployment = await tx.linkDeployment.create({ data: { link_id: linkId, generation,
      version: link.desired_version, status: retiring ? "retiring" : "preparing", binding_snapshot: { spec: input,
        revisions: rows.map((r) => ({ id: r.id, revision: r.config_revision ?? 0 })) }, lease_expires_at: lease,
      placements: { create: [placements.egress, placements.ingress].map((p) => ({
        node_id: p.node_id, role: p.role, runtime_id: p.id, generation,
        config_digest: p.config_digest,
      })) } }, include: { placements: true } });
    await tx.linkResource.update({ where: { id: linkId }, data: { generation, status: retiring ? "retiring" : "deploying" } });
    return { link, deployment, placements };
  });
}
async function applyDeployment(prepared: Deployment) {
  const { link, deployment, placements } = prepared;
  let reserved = false;
  try {
    if (!(await deploymentIsCurrent(link, deployment)))
      throw new LinkResourceError("link_desired_state_changed");
    for (const placement of [placements.egress, placements.ingress]) {
      for (const p of placement.ports) {
        const result = await acquirePort({ nodeId: placement.node_id, leaseType: placement.role,
          preferredPort: p.port, protocol: p.protocol, bindScope: p.host, linkId: link.id,
          ownRuntimeIds: [placement.id, ...placement.runtime_ids], expiresAt: null });
        if (!result.ok) throw new LinkResourceError(result.code);
      }
    }
    // Only a fully reserved placement is eligible for startup/reconnect restore.
    // Otherwise a failed create would resurrect through the desired snapshot.
    reserved = true;
    await db.linkDeployment.update({ where: { id: deployment.id }, data: { status: "pending" } });
    // Exit authorization must be installed before a new business listener.
    for (const placement of [placements.egress, placements.ingress]) {
      await sendLinkPlacement(placement);
      await db.linkPlacement.updateMany({ where: { deployment_id: deployment.id, role: placement.role,
        generation: deployment.generation }, data: { status: placement.runner_config ? "running" : "passive",
        applied_generation: deployment.generation, last_error_code: null } });
    }
    await db.$transaction(async (tx) => {
      const updated = await tx.linkResource.updateMany({ where: { id: link.id, generation: deployment.generation,
        status: { in: ["deploying", "degraded"] } }, data: { status: "active" } });
      await tx.linkDeployment.update({ where: { id: deployment.id }, data: { status: "active" } });
      if (updated.count === 1) {
        const snapshot = DeploymentSnapshotSchema.parse(deployment.binding_snapshot);
        // A newer Forward revision must not inherit an older deployment's ACK.
        for (const fact of snapshot.revisions) {
            await tx.tunnel.updateMany({ where: { id: fact.id, workspace_id: link.workspace_id,
              link_resource_id: link.id, config_revision: fact.revision, desired_status: "active" }, data: { apply_status: "active", applied_revision: fact.revision,
              apply_error_code: null, apply_error: null, last_applied_at: new Date() } });
        }
      }
      await tx.tunnel.updateMany({ where: { link_resource_id: link.id, desired_status: "inactive",
        apply_status: "pending" }, data: { apply_status: "suspended" } });
    });
    // Release only after both physical processes confirm the complete snapshot.
    // Old slots are kept through timeout/partial failure; reconcile retries them.
    const latest = await db.linkResource.findUnique({ where: { id: link.id } });
    if (latest?.generation === deployment.generation) {
      const leases = await db.nodePortLease.findMany({ where: { link_id: link.id, status: "active" } });
      for (const lease of leases) {
        const wanted = [placements.ingress, placements.egress].some((p) => p.node_id === lease.node_id &&
          p.ports.some((slot) => slot.port === lease.port && slot.protocol === lease.protocol &&
            normalizeBindScope(slot.host) === lease.bind_scope));
        if (!wanted) await releaseLease({ leaseId: lease.id });
      }
    }
    return getLink(link.workspace_id, link.id);
  } catch (error) {
    const code = error instanceof LinkResourceError ? error.code : error instanceof Error && /^[a-z_]{1,64}$/.test(error.message) ? error.message : "link_apply_unconfirmed";
    await db.linkDeployment.update({ where: { id: deployment.id }, data: { status: reserved ? "degraded" : "blocked" } });
    await db.linkResource.updateMany({ where: { id: link.id, generation: deployment.generation }, data: { status: "degraded" } });
    await db.linkPlacement.updateMany({ where: { deployment_id: deployment.id, applied_generation: null }, data: { status: "error", last_error_code: code } });
    // Unconfirmed processes may still own the listeners; never free their slots.
    throw new LinkResourceError(code);
  }
}
export async function deployLink(workspaceId: number, linkId: number, rotate = false) {
  return applyDeployment(await prepareDeployment(workspaceId, linkId, rotate));
}

export async function createLinkForward(workspaceId: number, linkId: number, actorId: number, raw: unknown) {
  assertLinkFeature();
  const binding = LinkBindingSchema.parse(raw);
  const link = await scopedLink(workspaceId, linkId);
  const version = await db.linkVersion.findUniqueOrThrow({ where: { link_id_version: { link_id: linkId, version: link.desired_version } } });
  const config = LinkConfigSchema.parse(version.config);
  const nodes = await endpoints(workspaceId, config);
  const created = await withWorkspaceQuotaLock(workspaceId, async (tx, policy) => {
    const locked = await lockLink(tx, workspaceId, linkId);
    if (locked.desired_version !== version.version) throw new LinkResourceError("link_version_conflict");
    const tunnelCount = await countWorkspaceTunnels(workspaceId, tx);
    const trafficUsed = await sumWorkspaceTraffic(workspaceId, policy.limits.traffic_period, new Date(), tx);
    for (const protocol of binding.protocol === "both" ? ["tcp", "udp"] : [binding.protocol]) {
      const decision = checkTunnelCreation(policy, { tunnelCount, trafficUsed, protocol,
        inGroupOwned: true, outGroupOwned: true, inGroupId: nodes.ingress.node_group_id, outGroupId: nodes.egress.node_group_id });
      if (!decision.allowed) throw new LinkResourceError(decision.reason ?? "policy_denied", 403);
    }
    await preflightBinding(tx, workspaceId, locked, config, nodes, binding, 2_147_483_647);
    const row = await tx.tunnel.create({ data: {
      name: binding.name, workspace_id: workspaceId, user_id: actorId, category: "port_forward",
      tunnel_type: binding.protocol === "udp" ? "udp" : "tcp", forward_protocol: binding.protocol,
      tunnel_mode: "relay", link_resource_id: linkId,
      in_node_group_id: nodes.ingress.node_group_id, out_node_group_id: nodes.egress.node_group_id,
      ingress_node_id: nodes.ingress.id, egress_node_id: nodes.egress.id,
      listen_ip: binding.listen_host || "0.0.0.0", listen_port: binding.listen_port,
      listen_protocol: binding.protocol === "both" ? ["tcp", "udp"] : [binding.protocol],
      forward_addresses: [], load_balance_type: "round", remote_host: binding.target_host, remote_port: binding.target_port,
      desired_status: "active", apply_status: "pending", config_revision: 0,
      bytes_per_second_in: binding.bytes_per_second_in, bytes_per_second_out: binding.bytes_per_second_out,
      max_connections: binding.max_connections, max_connections_per_ip: binding.max_connections_per_ip,
    } });
    await createForwardRevision({ tunnelId: row.id, desiredStatus: "active", createdById: actorId,
      link_resource_id: linkId,
      candidate: { ...binding, mode: "relay", ingress_node_id: nodes.ingress.id,
        egress_node_id: nodes.egress.id, link_resource_id: linkId } as ForwardCandidateConfig,
      resolvedListenIp: row.listen_ip, egressPort: config.carrier_port }, tx);
    return row.id;
  });
  // The persisted revision survives transport failure and is retried by the Link
  // reconciler. Never start a parallel legacy Tunnel for this business object.
  await deployLink(workspaceId, linkId);
  return { id: created, link_id: linkId };
}

export async function updateLinkForward(workspaceId: number, linkId: number, forwardId: number,
  actorId: number, expectedRevision: number, raw: unknown) {
  assertLinkFeature();
  const parsed = LinkBindingSchema.safeParse(raw);
  if (!parsed.success) {
    if (parsed.error.issues.some((issue) => issue.message === "link_client_source_required"))
      throw new LinkResourceError("link_client_source_required");
    throw parsed.error;
  }
  const binding = parsed.data;
  const link = await scopedLink(workspaceId, linkId);
  const version = await db.linkVersion.findUniqueOrThrow({ where: { link_id_version: { link_id: linkId, version: link.desired_version } } });
  const config = LinkConfigSchema.parse(version.config);
  const nodes = await endpoints(workspaceId, config);
  await db.$transaction(async (tx) => {
    const locked = await lockLink(tx, workspaceId, linkId);
    if (locked.desired_version !== version.version) throw new LinkResourceError("link_version_conflict");
    const row = await tx.tunnel.findFirst({ where: { id: forwardId, workspace_id: workspaceId, link_resource_id: linkId } });
    if (!row) throw new LinkResourceError("forward_not_found", 404);
    if (row.config_revision !== expectedRevision) throw new LinkResourceError("revision_conflict");
    if (row.link_source_config != null && !binding.client_source)
      throw new LinkResourceError("link_client_source_required");
    if (row.link_target_config != null && !binding.target_set)
      throw new LinkResourceError("link_target_set_required");
    if (row.forward_protocol !== binding.protocol) throw new LinkResourceError("protocol_change_requires_new_forward");
    if (normalizeBindScope(row.listen_ip) !== normalizeBindScope(binding.listen_host))
      throw new LinkResourceError("listen_scope_change_requires_new_forward");
    await preflightBinding(tx, workspaceId, locked, config, nodes, binding, row.id, row.desired_status !== "inactive");
    await createForwardRevision({ tunnelId: row.id, desiredStatus: row.desired_status === "inactive" ? "inactive" : "active", createdById: actorId,
      link_resource_id: linkId,
      candidate: { ...binding, mode: "relay", ingress_node_id: row.ingress_node_id!,
        egress_node_id: row.egress_node_id, link_resource_id: linkId } as ForwardCandidateConfig,
      resolvedListenIp: binding.listen_host || "0.0.0.0" }, tx);
    await tx.tunnel.update({ where: { id: row.id }, data: { apply_status: "pending" } });
  });
  return deployLink(workspaceId, linkId);
}
export async function actionLinkForward(workspaceId: number, linkId: number, forwardId: number,
  action: "suspend" | "resume" | "delete" | "retry", actorId?: number) {
  assertLinkFeature();
  const link = await scopedLink(workspaceId, linkId);
  const version = await db.linkVersion.findUniqueOrThrow({ where: { link_id_version: { link_id: linkId, version: link.desired_version } } });
  const config = LinkConfigSchema.parse(version.config);
  const nodes = action === "resume" ? await endpoints(workspaceId, config) : null;
  await db.$transaction(async (tx) => {
    const locked = await lockLink(tx, workspaceId, linkId);
    if (locked.desired_version !== version.version) throw new LinkResourceError("link_version_conflict");
    const row = await tx.tunnel.findFirst({ where: { id: forwardId, workspace_id: workspaceId, link_resource_id: linkId } });
    if (!row) throw new LinkResourceError("forward_not_found", 404);
    if (nodes) await preflightBinding(tx, workspaceId, locked, config, nodes, LinkBindingSchema.parse({
      name: row.name, protocol: row.forward_protocol, listen_port: row.listen_port,
      listen_host: row.listen_ip === "127.0.0.1" || row.listen_ip === "::1" ? row.listen_ip : "",
      target_host: row.remote_host, target_port: row.remote_port,
      ...(row.link_target_config == null ? {} : { target_set: persistedLinkTargetSet(row.link_target_config) }),
    ...(row.link_source_config == null ? {} : { client_source: persistedLinkClientSource(row.link_source_config) }),
      bytes_per_second_in: row.bytes_per_second_in ?? 0, bytes_per_second_out: row.bytes_per_second_out ?? 0,
      max_connections: row.max_connections ?? 0, max_connections_per_ip: row.max_connections_per_ip ?? 0,
    }), row.id);
    if (action !== "retry") {
      await createForwardRevision({ tunnelId: row.id, createdById: actorId ?? row.user_id,
        desiredStatus: action === "resume" ? "active" : "inactive", link_resource_id: linkId,
        candidate: { name: row.name, mode: "relay", protocol: row.forward_protocol,
          listen_port: row.listen_port, ingress_node_id: row.ingress_node_id!,
          egress_node_id: row.egress_node_id, target_host: row.remote_host!, target_port: row.remote_port!,
          ...(row.link_target_config == null ? {} : { target_set: persistedLinkTargetSet(row.link_target_config) }),
          ...(row.link_source_config == null ? {} : { client_source: persistedLinkClientSource(row.link_source_config) }),
          link_resource_id: linkId, bytes_per_second_in: row.bytes_per_second_in,
          bytes_per_second_out: row.bytes_per_second_out, max_connections: row.max_connections,
          max_connections_per_ip: row.max_connections_per_ip } as ForwardCandidateConfig,
        resolvedListenIp: row.listen_ip, egressPort: row.egress_port }, tx);
      await tx.tunnel.update({ where: { id: row.id }, data: { apply_status: "pending" } });
    }
  });
  await deployLink(workspaceId, linkId);
  if (action === "delete") await db.tunnel.deleteMany({ where: { id: forwardId, workspace_id: workspaceId,
    link_resource_id: linkId, desired_status: "inactive" } });
  else if (action === "suspend") await db.tunnel.updateMany({ where: { id: forwardId,
    link_resource_id: linkId, desired_status: "inactive" }, data: { apply_status: "suspended" } });
  return getLink(workspaceId, linkId);
}

export async function retireLink(workspaceId: number, linkId: number) {
  assertLinkFeature();
  if (await db.tunnel.count({ where: { link_resource_id: linkId } })) throw new LinkResourceError("link_has_references");
  const current = await scopedLink(workspaceId, linkId);
  if (current.status === "retired") return { id: linkId, status: "retired" };
  const prepared = current.status === "retiring" ? await hydrateDeployment(current) : await prepareDeployment(workspaceId, linkId, false, true);
  // Ingress stops first. Tombstones are persisted before freeing any DB lease.
  for (const placement of [prepared.placements.ingress, prepared.placements.egress]) await sendLinkPlacement(placement, true);
  const changed = await db.linkResource.updateMany({ where: { id: linkId, generation: prepared.deployment.generation,
    status: "retiring" }, data: { status: "retired" } });
  if (changed.count !== 1) throw new LinkResourceError("link_generation_conflict");
  await db.linkDeployment.update({ where: { id: prepared.deployment.id }, data: { status: "retired" } });
  await releaseLease({ linkId });
  return { id: linkId, status: "retired" };
}

async function hydrateDeployment(link: Awaited<ReturnType<typeof scopedLink>>): Promise<Deployment> {
  const deployment = await db.linkDeployment.findUniqueOrThrow({ where: { link_id_generation: { link_id: link.id,
    generation: link.generation } }, include: { placements: true } });
  const credential = await db.linkTransportCredential.findUniqueOrThrow({ where: { link_id_generation: {
    link_id: link.id, generation: link.generation } } });
  const input = DeploymentSnapshotSchema.parse(deployment.binding_snapshot).spec;
  input.lease_expires_at = new Date(Date.now() + LEASE_MS).toISOString();
  const secret = unsealLinkTransportKey(credential.secret_enc, sealKey(), link.workspace_id, link.id, link.generation);
  const placements = compileFxpLink(input, secret);
  return { link, deployment, placements };
}

/** A renewable lease must describe today's desired revisions and hard ceilings.
 * Never mutate an immutable snapshot in place when an entitlement changes. */
async function deploymentIsCurrent(link: Awaited<ReturnType<typeof scopedLink>>,
  deployment: Pick<Deployment["deployment"], "generation" | "version" | "binding_snapshot">): Promise<boolean> {
  const latest = await scopedLink(link.workspace_id, link.id);
  if (latest.generation !== deployment.generation || latest.status === "retiring" || latest.status === "retired")
    return false;
  const snapshot = DeploymentSnapshotSchema.parse(deployment.binding_snapshot);
  try {
    const nodes = await endpoints(link.workspace_id, { ingress_node_id: snapshot.spec.ingress.id,
      egress_node_id: snapshot.spec.egress.id, carrier_port: snapshot.spec.carrier_port });
    // A snapshot freezes config, not a permanent capability attestation.
    compileFxpLink({ ...snapshot.spec, ingress: nodes.inFact, egress: nodes.outFact }, "00".repeat(32));
  } catch (error) {
    if (error instanceof LinkResourceError) throw new LinkResourceError(error.code, 403);
    if (error instanceof Error && /^agent_fxp_[a-z_]+_capability_missing$/.test(error.message))
      throw new LinkResourceError(error.message, 403);
    throw error;
  }
  const policy = await getEffectivePolicy(link.workspace_id, { noCache: true });
  if (policy.deny_scope) throw new LinkResourceError(policy.deny_reason ?? "policy_denied", 403);
  const rows = await db.tunnel.findMany({ where: { workspace_id: link.workspace_id,
    link_resource_id: link.id, desired_status: "active" }, orderBy: { id: "asc" } });
  const trafficUsed = await sumWorkspaceTraffic(link.workspace_id, policy.limits.traffic_period, new Date());
  for (const row of rows) for (const protocol of row.forward_protocol === "both" ? ["tcp", "udp"] : [row.forward_protocol ?? ""]) {
    const decision = checkTunnelUse(policy, { trafficUsed, protocol, inGroupOwned: true, outGroupOwned: true,
      inGroupId: row.in_node_group_id!, outGroupId: row.out_node_group_id });
    if (!decision.allowed) throw new LinkResourceError(decision.reason ?? "policy_denied", 403);
  }
  const bindings = rows.map((row) => ({ forward_id: row.id, protocol: row.forward_protocol,
    listen_port: row.listen_port, listen_host: row.listen_ip === "127.0.0.1" || row.listen_ip === "::1" ? row.listen_ip : "",
    target_host: row.remote_host, target_port: row.remote_port,
    ...(row.link_target_config == null ? {} : { target_set: persistedLinkTargetSet(row.link_target_config) }),
      ...(row.link_source_config == null ? {} : { client_source: persistedLinkClientSource(row.link_source_config) }),
    ...resolveForwardPolicy(row, policy.limits) }));
  return latest.desired_version === deployment.version &&
    canonicalConfigDigest(bindings) === canonicalConfigDigest(snapshot.spec.bindings) &&
    canonicalConfigDigest(rows.map((row) => ({ id: row.id, revision: row.config_revision ?? 0 }))) ===
      canonicalConfigDigest(snapshot.revisions);
}

/** Startup/reconnect and periodic renewal use the same immutable merge compiler. */
export async function desiredNodeLinks(nodeId: number): Promise<FxpPlacementConfig[]> {
  if (process.env.TUNEX_FXP_LINKS_ENABLED !== "true") return [];
  const placements = await db.linkPlacement.findMany({ where: { node_id: nodeId,
    deployment: { status: { in: ["pending", "active", "degraded"] },
      link: { status: { in: ["active", "deploying", "degraded"] } } } },
    include: { deployment: { include: { link: true } } } });
  const result: FxpPlacementConfig[] = [];
  for (const placement of placements) {
    const deployment = placement.deployment;
    if (deployment.generation !== deployment.link.generation) continue;
    // Revoked/exhausted workspaces receive no new lease. Existing isolated
    // caches expire locally; a panel outage cannot turn a lease into forever.
    try { if (!(await deploymentIsCurrent(deployment.link, deployment))) continue; }
    catch (error) { if (error instanceof LinkResourceError && error.status === 403) continue; throw error; }
    const snapshot = DeploymentSnapshotSchema.parse(deployment.binding_snapshot);
    const cred = await db.linkTransportCredential.findUniqueOrThrow({ where: { link_id_generation: {
      link_id: deployment.link_id, generation: deployment.generation } } });
    const secret = unsealLinkTransportKey(cred.secret_enc, sealKey(), deployment.link.workspace_id,
      deployment.link_id, deployment.generation);
    const lease = new Date(Date.now() + LEASE_MS);
    const input = snapshot.spec;
    input.lease_expires_at = lease.toISOString();
    const config = compileFxpLink(input, secret)[placement.role === "ingress" ? "ingress" : "egress"];
    if (config.node_id !== nodeId || config.config_digest !== placement.config_digest) throw new LinkResourceError("link_snapshot_corrupt", 503);
    await db.linkDeployment.update({ where: { id: deployment.id }, data: { lease_expires_at: lease } });
    result.push(config);
  }
  return result;
}

export async function reconcileLinks(): Promise<{ scanned: number; errors: number }> {
  if (process.env.TUNEX_FXP_LINKS_ENABLED !== "true") return { scanned: 0, errors: 0 };
  const links = await db.linkResource.findMany({ where: { status: { in: ["active", "deploying", "degraded", "retiring"] } } });
  let errors = 0;
  for (const link of links) {
    let prepared: Deployment | undefined;
    try {
      if (link.status === "retiring") { await retireLink(link.workspace_id, link.id); continue; }
      prepared = await hydrateDeployment(link);
      const current = await deploymentIsCurrent(link, prepared.deployment);
      if (!current || prepared.deployment.status === "policy_blocked") {
        await deployLink(link.workspace_id, link.id);
        continue;
      }
      if (link.status !== "active") {
        await applyDeployment(prepared);
        continue;
      }
      // Refresh the exact generation; reconnect and duplicate apply renew its
      // durable lease without creating a new desired-state writer.
      for (const placement of [prepared.placements.egress, prepared.placements.ingress]) await sendLinkPlacement(placement);
      await db.linkDeployment.update({ where: { id: prepared.deployment.id },
        data: { lease_expires_at: new Date(prepared.placements.ingress.lease_expires_at) } });
    } catch (error) {
      errors++;
      if (prepared && error instanceof Error && error.message === "stale_generation") {
        // An authoritative omission/expiry can persist a local tombstone while
        // the panel was unavailable. Reusing that generation cannot revive it.
        await deployLink(link.workspace_id, link.id).catch(() => {});
      }
      if (prepared && error instanceof LinkResourceError && error.status === 403) {
        // Mark non-renewable before sending a removal. Keep port ownership until
        // an acknowledged retirement; a policy restore compiles a higher generation.
        await db.linkDeployment.update({ where: { id: prepared.deployment.id }, data: { status: "policy_blocked" } });
        await db.linkResource.updateMany({ where: { id: link.id, generation: prepared.deployment.generation }, data: { status: "degraded" } });
        for (const placement of [prepared.placements.ingress, prepared.placements.egress])
          await sendLinkPlacement(placement, true).catch(() => {});
      }
    }
  }
  return { scanned: links.length, errors };
}
