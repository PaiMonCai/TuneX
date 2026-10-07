/** Closed Link runtime facts. Desired/applied placement rows remain authoritative. */
import { z } from "zod";
import type { Prisma } from "@prisma/client";

export const LINK_REPORT_MAX_ENTRIES = 4096;
export const LINK_REPORT_MAX_BYTES = 1 << 20;
const id = z.number().int().min(1).max(2147483647);
const generation = z.number().int().min(0).max(2147483647);
const runtimeID = z.string().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/);
const digest = z.union([z.literal(""), z.string().regex(/^[a-f0-9]{64}$/)]);
// In-memory capacity facts, never counters to add to historical usage or Ready.
const trafficAckAt = z.string().max(64).refine((value) => {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!match || match[0] !== value) return false;
  const local = Date.parse(`${match[1]}Z`);
  return Number.isFinite(local) && new Date(local).toISOString().slice(0, 19) === match[1]
    && Number.isFinite(Date.parse(value));
});
const trafficStatus = z.object({
  rotation_supported: z.boolean(),
  producer_count: z.number().int().min(0).max(128),
  sample_count: z.number().int().min(0).max(262144),
  rule_count: z.number().int().min(0).max(262144),
  spool_bytes: z.number().int().min(0).max(403701760),
  last_ack_at: trafficAckAt.nullable(),
  state: z.enum(["idle", "collecting", "backlogged", "blocked"]),
}).strict();
const targetStatus = z.object({
  forward_id: id,
  states: z.array(z.enum(["unknown", "healthy", "suspect", "recovering", "unhealthy"])).min(1).max(10),
  selected_tcp: z.number().int().min(0).max(9).nullable(),
  selected_udp: z.number().int().min(0).max(9).nullable(),
  last_checked_at: trafficAckAt.nullable(),
  reason: z.enum(["initial", "selected", "target_failed", "target_recovered", "all_unavailable"]),
}).strict().refine((s) => [s.selected_tcp, s.selected_udp].every((index) => index === null || index < s.states.length))
  .refine((s) => s.last_checked_at !== null || s.states.every((state) => state === "unknown"));
const port = z.object({
  protocol: z.enum(["tcp", "udp"]),
  host: z.string().max(255).refine((value) => !/[\s\u0000-\u001f]/.test(value)),
  port: z.number().int().min(1).max(65535),
}).strict();
const placement = z.object({
  id: runtimeID, link_id: id, workspace_id: id, node_id: id,
  role: z.enum(["ingress", "egress"]),
  generation: generation.min(1), observed_generation: generation,
  config_digest: digest, desired_config_digest: digest,
  ready: z.boolean(),
  state: z.enum(["updating", "ready", "rolled_back", "failed", "expired", "removed", "passive", "cached", "closed", "exited"]),
  lease_expires_at: z.union([z.literal(""), z.string().max(64).datetime({ offset: true })]),
  ports: z.array(port).max(1024),
  runtime_ids: z.array(runtimeID).max(4096),
  traffic_status: trafficStatus.optional(),
  target_status: z.array(targetStatus).max(500).optional(),
}).strict().refine((value) => value.observed_generation <= value.generation)
  .refine((value) => value.target_status === undefined || (value.role === "egress" &&
    new Set(value.target_status.map((s) => s.forward_id)).size === value.target_status.length))
  .refine((value) => !value.ready || (
    (value.state === "ready" || value.state === "rolled_back") && value.observed_generation > 0 &&
    value.config_digest !== "" && value.lease_expires_at !== ""
  ))
  .refine((value) => new Set(value.runtime_ids).size === value.runtime_ids.length)
  .refine((value) => new Set(value.ports.map((p) => `${p.protocol}/${p.host}/${p.port}`)).size === value.ports.length);

export type ReportedLinkPlacement = z.infer<typeof placement>;
export type ReportedTrafficStatus = z.infer<typeof trafficStatus>;
export type ReportedTargetStatus = z.infer<typeof targetStatus>;
export type LinkReportRejection = "bad_link_placements" | "link_placement_node_mismatch" |
  "link_placement_workspace_mismatch" | "link_placement_not_owned";
type ParsedLinkReport = { ok: true; placements: ReportedLinkPlacement[] | null } |
  { ok: false; reason: LinkReportRejection };

/** Undefined is an older report with no Link facts, never an idle claim. */
export function parseLinkPlacements(value: unknown): ParsedLinkReport {
  if (value === undefined) return { ok: true, placements: null };
  if (!Array.isArray(value) || value.length > LINK_REPORT_MAX_ENTRIES) {
    return { ok: false, reason: "bad_link_placements" };
  }
  try {
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > LINK_REPORT_MAX_BYTES) {
      return { ok: false, reason: "bad_link_placements" };
    }
  } catch {
    return { ok: false, reason: "bad_link_placements" };
  }
  const parsed = z.array(placement).max(LINK_REPORT_MAX_ENTRIES).safeParse(value);
  if (!parsed.success || new Set(parsed.data.map((p) => p.id)).size !== parsed.data.length) {
    return { ok: false, reason: "bad_link_placements" };
  }
  if (Buffer.byteLength(JSON.stringify(parsed.data), "utf8") > LINK_REPORT_MAX_BYTES) {
    return { ok: false, reason: "bad_link_placements" };
  }
  return { ok: true, placements: parsed.data };
}

export interface LinkPlacementOwnership {
  runtime_id: string;
  node_id: number;
  role: string;
  deployment: { link_id: number; link: { workspace_id: number } };
}

/** Scope 0 denotes a shared node; its tenant claim still requires a stored owner. */
export function checkLinkPlacementOwnership(
  placements: readonly ReportedLinkPlacement[],
  nodeId: number,
  workspaceId: number,
  owners: readonly LinkPlacementOwnership[],
): { ok: true } | { ok: false; reason: LinkReportRejection } {
  for (const report of placements) {
    if (report.node_id !== nodeId) return { ok: false, reason: "link_placement_node_mismatch" };
    if (workspaceId !== 0 && report.workspace_id !== workspaceId) return { ok: false, reason: "link_placement_workspace_mismatch" };
    if (!owners.some((owner) => owner.runtime_id === report.id && owner.node_id === nodeId &&
      owner.role === report.role && owner.deployment.link_id === report.link_id &&
      owner.deployment.link.workspace_id === report.workspace_id)) {
      return { ok: false, reason: "link_placement_not_owned" };
    }
  }
  return { ok: true };
}

/** The ownership read and state write share one transaction; report facts never
 * advance LinkPlacement.applied_generation or renew a Link deployment lease. */
export async function storeLinkPlacementReport(
  tx: Pick<Prisma.TransactionClient, "linkPlacement" | "nodeStateReport">,
  nodeId: number,
  workspaceId: number,
  placements: ReportedLinkPlacement[],
  core: Omit<Prisma.NodeStateReportUncheckedCreateInput, "node_id">,
): Promise<{ ok: true } | { ok: false; reason: LinkReportRejection }> {
  const owners = placements.length === 0 ? [] : await tx.linkPlacement.findMany({
    where: { node_id: nodeId, runtime_id: { in: placements.map((p) => p.id) } },
    select: { runtime_id: true, node_id: true, role: true,
      deployment: { select: { link_id: true, link: { select: { workspace_id: true } } } } },
  });
  const ownership = checkLinkPlacementOwnership(placements, nodeId, workspaceId, owners);
  if (!ownership.ok) return ownership;
  await tx.nodeStateReport.upsert({
    where: { node_id: nodeId }, create: { node_id: nodeId, ...core }, update: core,
  });
  return { ok: true };
}
