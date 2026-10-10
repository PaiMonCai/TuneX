import { projectLinkMaintenanceInput, type LinkMaintenancePreviewInput } from "./link-maintenance-types";
import { LinksPayloadError, type LinkConfig } from "./links-types";

export type LinkMaintenanceStatus = "awaiting_executor" | "cancelled" | "invalidated" | "expired";
export interface LinkMaintenanceCommitInput extends LinkMaintenancePreviewInput { receipt: string; idempotency_key: string }
export interface LinkMaintenanceMigration {
  schema_version: 1; id: number; link_id: number; workspace_id: number; created_by: number;
  operation: "update_endpoints" | "rotate_key"; status: LinkMaintenanceStatus; state_version: number;
  expected_version: number; expected_generation: number; candidate_config: LinkConfig;
  references: { total: number; active: number; suspended: number };
  created_at: string; updated_at: string; hold_expires_at: string; reason_code: string | null;
  execution: { supported: false }; ports: { reserved: false; availability: "not_checked" };
}
const fail = (): never => { throw new LinksPayloadError(); };
const obj = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : fail();
const int = (v: unknown, min = 1, max = 2_147_483_647): number => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max ? v : fail();
const choice = <T extends string>(v: unknown, values: readonly T[]): T => typeof v === "string" && values.includes(v as T) ? v as T : fail();
function stamp(v: unknown): string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)
    || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) fail();
  return v as string;
}
export function projectMaintenanceCommit(value: unknown): LinkMaintenanceCommitInput {
  const raw = obj(value);
  if (Object.keys(raw).length !== 5) fail();
  const request = projectLinkMaintenanceInput({ expected_version: raw.expected_version,
    expected_generation: raw.expected_generation, change: raw.change });
  if (typeof raw.idempotency_key !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(raw.idempotency_key)
    || typeof raw.receipt !== "string" || raw.receipt.length > 2048 || !/^lm1\.[A-Za-z0-9_-]+\.[0-9a-f]{64}$/.test(raw.receipt)) fail();
  return { ...request, idempotency_key: raw.idempotency_key as string, receipt: raw.receipt as string };
}
/** Closed metadata only. Private snapshots, targets, receipt, credentials and runner JSON never reach UI state. */
export function projectMaintenanceMigration(value: unknown, workspaceId: number, linkId: number): LinkMaintenanceMigration {
  const r = obj(value), config = obj(r.candidate_config), refs = obj(r.references);
  if (r.schema_version !== 1 || r.workspace_id !== int(workspaceId) || r.link_id !== int(linkId)
    || obj(r.execution).supported !== false || obj(r.ports).reserved !== false || obj(r.ports).availability !== "not_checked") fail();
  const candidate_config = { ingress_node_id: int(config.ingress_node_id), egress_node_id: int(config.egress_node_id), carrier_port: int(config.carrier_port, 1, 65535) };
  if (candidate_config.ingress_node_id === candidate_config.egress_node_id) fail();
  const total = int(refs.total, 0, 500), active = int(refs.active, 0, total), suspended = int(refs.suspended, 0, total);
  if (active + suspended !== total) fail();
  const status = choice<LinkMaintenanceStatus>(r.status, ["awaiting_executor", "cancelled", "invalidated", "expired"]);
  const state_version = int(r.state_version);
  if (status === "awaiting_executor" ? state_version !== 1 : state_version !== 2) fail();
  const created_at = stamp(r.created_at), updated_at = stamp(r.updated_at), hold_expires_at = stamp(r.hold_expires_at);
  if (Date.parse(updated_at) < Date.parse(created_at) || Date.parse(hold_expires_at) - Date.parse(created_at) !== 300_000) fail();
  if (r.reason_code !== null && (typeof r.reason_code !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(r.reason_code))) fail();
  return { schema_version: 1, id: int(r.id), link_id: linkId, workspace_id: workspaceId, created_by: int(r.created_by),
    operation: choice(r.operation, ["rotate_key", "update_endpoints"]), status, state_version,
    expected_version: int(r.expected_version), expected_generation: int(r.expected_generation), candidate_config,
    references: { total, active, suspended }, created_at, updated_at, hold_expires_at, reason_code: r.reason_code as string | null,
    execution: { supported: false }, ports: { reserved: false, availability: "not_checked" } };
}
export function projectMaintenanceList(value: unknown, workspaceId: number, linkId: number) {
  if (!Array.isArray(value) || value.length > 20) fail();
  const ids = new Set<number>();
  return (value as unknown[]).map((v) => { const row = projectMaintenanceMigration(v, workspaceId, linkId);
    if (ids.has(row.id)) fail(); ids.add(row.id); return row; });
}
