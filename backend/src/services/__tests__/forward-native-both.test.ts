import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { forwardNativeBothEnabled, nativeBothEntryDisabled, FORWARD_NATIVE_BOTH_CAPABILITY as CAP } from "../forward-native-both.ts";
import { admitPersistedProtocol, buildForwardRuntimePlan, dispatchFactsFromRow, legacyTunnelTypeColumn,
  legacyTunnelTypeForForwardProtocol, persistedForwardProtocol } from "../forward-contract.ts";
import { capabilityFactsFromStoredV2 } from "../capability-manifest.ts";
import { admitRuntime, admitRuntimeFromStore } from "../runtime-admission.ts";
import { checkTunnelCreation, checkTunnelUse } from "../capability-policy.ts";
import { computeForwardImpact, createForwardRevision, validateForwardCandidate, type ForwardCandidateConfig } from "../forward-revision.ts";
import { planRollout } from "../forward-rollout.ts";
import { probeTargetsForForward } from "../forward-probe-plan.ts";
import { checkForwardRuntimeUse } from "../forward-capability.ts";
import { aggregateTrafficRows } from "../traffic.ts";

const original = process.env.FORWARD_NATIVE_BOTH_ENABLED;
afterEach(() => { if (original === undefined) delete process.env.FORWARD_NATIVE_BOTH_ENABLED; else process.env.FORWARD_NATIVE_BOTH_ENABLED = original; });
const candidate: ForwardCandidateConfig = { name: "composite", mode: "direct", protocol: "both",
  ingress_node_id: 11, egress_node_id: null, listen_port: 23000, target_host: "127.0.0.1", target_port: 8080 };
const advertisement = (extra: any = {}) => capabilityFactsFromStoredV2({ control_protocol_version: 2,
  capabilities: ["apply_tunnel", "remove_tunnel", CAP], capability_manifest: { schema_version: 2,
    protocols: ["tcp", "udp", "both"], transports: ["stream", "datagram", "mixed"], runtime: [], diagnostics: [] },
  reported_at: new Date(), credential_rotated_at: new Date(Date.now() - 5000), ...extra });

test("native both flag is exact/default-off and only blocks entry, never existing both recovery", () => {
  for (const value of [undefined, "", "1", "TRUE", " true", "true ", "false", "on"]) {
    if (value === undefined) delete process.env.FORWARD_NATIVE_BOTH_ENABLED; else process.env.FORWARD_NATIVE_BOTH_ENABLED = value;
    expect(forwardNativeBothEnabled()).toBe(false);
    expect(nativeBothEntryDisabled("both")).toBe(true);
    expect(nativeBothEntryDisabled("both", "tcp")).toBe(true);
    expect(nativeBothEntryDisabled("both", "both")).toBe(false);
    expect(nativeBothEntryDisabled("tcp", "both")).toBe(false);
  }
  process.env.FORWARD_NATIVE_BOTH_ENABLED = "true";
  expect(nativeBothEntryDisabled("both")).toBe(false);
});

test("both is one canonical mixed connection-and-mapping runtime with NULL legacy projection", () => {
  expect(buildForwardRuntimePlan("direct", "both", { revision: 7, listener: { port: 23000 } })).toMatchObject({
    protocol: { name: "both" }, transport: { name: "mixed", lifecycle: "connection_and_mapping" }, revision: 7, listener: { port: 23000 } });
  expect(legacyTunnelTypeForForwardProtocol("both")).toBeNull();
  expect(legacyTunnelTypeColumn("both")).toEqual({ tunnel_type: null });
  expect(persistedForwardProtocol("both", "tcp")).toBe("both");
  expect(admitPersistedProtocol({ forward_protocol: "both", tunnel_mode: "direct", tunnel_type: "tcp" })).toBe("both");
  expect(admitPersistedProtocol({ forward_protocol: "both" })).toBeNull();
});

test("only plain DIRECT and single-hop RELAY; unsupported metadata cannot relabel a row", () => {
  expect(validateForwardCandidate(candidate).ok).toBe(true);
  expect(validateForwardCandidate({ ...candidate, mode: "relay", egress_node_id: 22 }).ok).toBe(true);
  for (const [extra, reason] of [
    [{ middle_node_id: 33 }, "native_both_middle_unsupported"],
    [{ federated_egress_peer: "peer" }, "native_both_federated_unsupported"],
    [{ tls_cert_path: "/cert", tls_key_path: "/key" }, "native_both_tls_unsupported"],
    [{ client_source: { version: 1, preserve: false } }, "native_both_source_unsupported"],
    [{ lb_strategy: "IP_HASH" }, "native_both_ip_hash_unsupported"],
  ] as const) {
    expect(validateForwardCandidate({ ...candidate, ...extra } as any).reasons).toContain(reason);
    expect(dispatchFactsFromRow({ forward_protocol: "both", tunnel_mode: "relay", ...extra } as any)).toBeNull();
  }
});

test("both EGRESS derives UDP hop peer from the same reported ingress identity with no TCP downgrade", () => {
  const facts = dispatchFactsFromRow({ forward_protocol: "both", tunnel_mode: "relay", ingress_runtime_id: "tunex-71-relay",
    ingress_node: { connect_ip: "192.0.2.1, 192.0.2.2", state_report: { tunnels: [{ id: "tunex-71-relay", diag: { hop_local_addr: "[2001:db8::1]:45678" } }] } } });
  expect(facts).toEqual({ protocol: "both", hopPeer: "2001:db8::1" });
});

test("fresh native capability and both/mixed manifest are mandatory on EVERY node, not tcp+udp fallback", async () => {
  process.env.FORWARD_NATIVE_BOTH_ENABLED = "false";
  const nodes = [11, 22].map((nodeId, index) => ({ nodeId, role: index ? "egress" as const : "ingress" as const, facts: advertisement() }));
  expect(admitRuntime(nodes, { action: "apply_tunnel", protocol: "both" }).ok).toBe(true);
  for (const facts of [null, advertisement({ capabilities: ["apply_tunnel", "forward.protocol.both.v1"] }),
    advertisement({ reported_at: null }), advertisement({ reported_at: new Date(Date.now() - 180_000) }),
    advertisement({ reported_at: new Date(Date.now() + 60_000) }), advertisement({ credential_rotated_at: new Date(Date.now() + 1000) }),
    advertisement({ capability_manifest: { schema_version: 2, protocols: ["tcp", "udp"], transports: ["stream", "datagram"], runtime: [], diagnostics: [] } }),
    advertisement({ capability_manifest: { schema_version: 2, protocols: ["both"], transports: ["stream", "datagram"], runtime: [], diagnostics: [] } }),
  ]) for (const index of [0, 1]) {
    const changed = nodes.map((node, i) => i === index ? { ...node, facts } : node);
    expect(admitRuntime(changed, { action: "apply_tunnel", protocol: "both" })).toMatchObject({ ok: false, node_id: changed[index]!.nodeId });
  }
  expect(await admitRuntimeFromStore(nodes, { action: "apply_tunnel", protocol: "both" }, async () => { throw new Error("offline read failure"); })).toMatchObject({ ok: false });
});

test("both needs TCP AND UDP entitlement after ceilings; explicit both grants cannot bypass a forbidden lane", () => {
  const context = { protocol: "both", tunnelCount: 0, trafficUsed: 0, inGroupOwned: true, inGroupId: 1, outGroupId: null, outGroupOwned: true };
  for (const [types, allowed] of [[["tcp", "udp"], true], [["tcp"], false], [["udp"], false], [["both"], false], [["tcp", "both"], false]] as const) {
    const policy = { deny_scope: false, entitlements: { tunnel_types: types }, limits: { max_tunnels: 1, traffic_limit: null, bandwidth_limit: null, client_limit: null } } as any;
    expect(checkTunnelCreation(policy, context).allowed).toBe(allowed);
    expect(checkTunnelUse(policy, context).allowed).toBe(allowed);
    if (allowed) expect(checkTunnelCreation(policy, { ...context, tunnelCount: 1 })).toMatchObject({ allowed: false, reason: "tunnel_limit" });
  }
});

test("shared node grants never authorize native both, even when each lane is entitled", async () => {
  const resource = { user_id: 1, in_node_group_id: 11, out_node_group_id: 22, protocol: "both" };
  for (const foreign of [11, 22]) {
    const denied = await checkForwardRuntimeUse(7, resource, {
      group: async (id) => ({ id, user_id: 1, workspace_id: id === foreign ? 8 : 7 }),
      personalWorkspace: async () => 7, granted: async () => true, traffic: async () => 0,
      policy: async () => ({ deny_scope: false, entitlements: { tunnel_types: ["tcp", "udp"] },
        limits: { traffic_limit: null, traffic_period: "month" } } as any),
    });
    expect(denied).toMatchObject({ code: "forbidden", reason: "native_both_self_owned_required", error_layer: "resource_scope" });
  }
});

test("one immutable revision/CAS and port identity, with flag-off existing-both revision compatibility", async () => {
  process.env.FORWARD_NATIVE_BOTH_ENABLED = "false";
  const writes: any[] = [], snapshots: any[] = [];
  const row = { config_revision: 7, forward_protocol: "both", tunnel_mode: "direct", link_resource_id: null, listen_port: 23000, listen_ip: "0.0.0.0" };
  const tx = { tunnel: { findUnique: async () => row, updateMany: async (args: any) => { writes.push(args); return { count: 1 }; } },
    forwardRevision: { findMany: async () => [{ revision: 7 }], create: async (args: any) => { snapshots.push(args.data); return { id: 81 }; } } };
  expect(await createForwardRevision({ tunnelId: 71, candidate, desiredStatus: "active", expectedRevision: 7, createdById: 1 }, tx as any)).toMatchObject({ revision: 8 });
  expect(snapshots).toHaveLength(1); expect(writes).toHaveLength(1);
  expect(snapshots[0]).toMatchObject({ tunnel_id: 71, revision: 8, protocol: "both", listen_port: 23000 });
  expect(writes[0]).toMatchObject({ where: { id: 71, config_revision: 7 }, data: { forward_protocol: "both", tunnel_type: null, config_revision: 8, listen_port: 23000 } });
  row.forward_protocol = "tcp";
  await expect(createForwardRevision({ tunnelId: 71, candidate, desiredStatus: "active", createdById: 1 }, tx as any)).rejects.toMatchObject({ code: "invalid_input" });
  expect(snapshots).toHaveLength(1);
});

test("both retarget and protocol transitions request atomic listener replacement without changing address", () => {
  for (const base of [candidate, { ...candidate, protocol: "tcp" }]) {
    const next = { ...candidate, target_port: 8081 };
    const impact = computeForwardImpact({ current: base, candidate: next, ingressNodeId: "in", egressNodeId: null,
      currentIngressNodeId: "in", currentEgressNodeId: null, ingressConnectIp: "127.0.0.1", resolvedListenPort: 23000,
      currentResolvedListenPort: 23000, bindingRequired: false });
    expect(impact).toMatchObject({ runtime_change: true, listener_replacement: true, changes_external_address: false });
    const desired = { ...next, listen_ip: "0.0.0.0", egress_port: null, egress_pool_id: null, egress_targets: null, desired_status: "active" };
    const plan = planRollout({ revision: 8, base_revision: 7, impact, desired, applied: { ...desired, protocol: base.protocol },
      nodes: { ingress: { id: 11, node_id: "in", role: "ingress", connect_ip: "127.0.0.1", lifecycle: "active" }, egress: null, ingress_previous: null, egress_previous: null } }, 71);
    expect(plan.blocking).toHaveLength(0);
    expect(plan.strategy).toBe("listener_replace");
    expect(plan.steps.find((s) => s.kind === "cutover_ingress")?.meta).toMatchObject({ same_listener: false });
  }
});

test("probes keep both identity but clearly report TCP-only evidence; unsupported topology refuses planning", () => {
  const forward = { id: 71, protocol: "both", mode: "direct", ingress_node_id: 11, ingress_node_key: "in", ingress_connect_ip: "127.0.0.1",
    egress_node_id: null, egress_node_key: null, egress_connect_ip: null, egress_port: null, remote_host: "127.0.0.1", remote_port: 8080, config_revision: 7, pool_targets: [] as { host: string; port: number }[] } as const;
  expect(probeTargetsForForward(forward)).toMatchObject({ ok: true, segments: [{ kind: "tcp_probe", protocol: "tcp", resource_id: "tunex-71-direct" }] });
  expect(probeTargetsForForward({ ...forward, middle_node_id: 33 })).toMatchObject({ ok: false, code: "native_both_middle_unsupported" });
});

test("migration makes projection nullable without shrinking the legacy enum or touching shared FXP both", () => {
  const sql = readFileSync(new URL("../../../prisma/migrations/20261101008000_native_both_projection/migration.sql", import.meta.url), "utf8");
  expect(sql).toContain("NULL DEFAULT 'wss'");
  for (const name of ["tcp", "mtcp", "udp", "tunex", "mtls", "mwss", "wss", "tls", "quic"]) expect(sql).toContain(`'${name}'`);
  expect(sql).toContain("`link_resource_id` IS NULL");
});

test("mixed TCP and UDP counters aggregate once under the same Forward identity without a legacy projection", () => {
  const now = new Date("2026-10-08T00:00:00Z");
  const tunnel = { name: "both", forward_protocol: "both", tunnel_type: null, in_node_group_id: 11 };
  const aggregate = aggregateTrafficRows([100, 200].map((traffic) => ({ tunnel_id: 71, date: now,
    traffic, traffic_cost: traffic, tunnel })), { days: 1, now });
  expect(aggregate.total_traffic).toBe(300);
  expect(aggregate.by_tunnel).toHaveLength(1);
  expect(aggregate.by_tunnel[0]).toMatchObject({ tunnel_id: 71, tunnel_type: "both", traffic: 300 });
});
