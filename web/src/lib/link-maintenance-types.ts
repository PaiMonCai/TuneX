import { LinksPayloadError, type LinkConfig, type LinkDetail, type LinkProtocol } from "./links-types";

export type LinkMaintenanceOperation = "update_endpoints" | "rotate_key";
export interface LinkMaintenancePreviewInput {
  expected_version: number; expected_generation: number;
  change: { type: "update_endpoints"; config: LinkConfig } | { type: "rotate_key" };
}
export const LINK_MAINTENANCE_REFERENCE_LIMIT = 500;
export const LINK_MAINTENANCE_PORT_LIMIT = 2048;
export const LINK_MAINTENANCE_STAGES = ["reserve_candidate", "prepare_egress", "verify_egress", "cutover_ingress",
  "verify_ingress", "drain_old", "retire_old", "release_old_ports"] as const;
export type MaintenanceBlocker = "maintenance_executor_unavailable" | "link_no_change" | "link_not_deployed" | "link_runtime_unconfirmed";
type Role = "ingress" | "egress";
const OBSERVATION_STATES = ["unknown", "stale", "absent", "mismatch", "updating", "ready", "rolled_back", "failed", "expired", "removed", "passive", "cached", "closed", "exited"] as const;
export type LinkMaintenanceObservationState = (typeof OBSERVATION_STATES)[number];
interface Listener { node_id: number; bind_scope: string; port: number }
export interface LinkMaintenancePort extends Listener { role: Role; protocol: "tcp" | "udp" | "unknown" }
export interface LinkMaintenanceReference {
  id: number; name: string; protocol: LinkProtocol; desired_status: "active" | "inactive"; config_revision: number;
  listener: Listener; candidate_listener: Listener;
}
export interface LinkMaintenancePreview {
  schema_version: 1; link_id: number; workspace_id: number; operation: LinkMaintenanceOperation;
  created_at: string; expires_at: string;
  snapshot: { desired_version: number; generation: number; state_token: string; receipt?: string };
  submission?: { supported: boolean; hold_seconds: 300 };
  candidate: { config: LinkConfig; version: number; generation: number; key_action: "rotate" | "preserve" };
  changes: { ingress_changed: boolean; egress_changed: boolean; carrier_port_changed: boolean; credentials_changed: boolean };
  references: { total: number; active: number; suspended: number; forwards: LinkMaintenanceReference[] };
  runtime: { state: "not_deployed" | "ready" | "unknown" | "not_ready";
    placements: { node_id: number; role: Role; state: LinkMaintenanceObservationState; ready: boolean | null }[];
    tcp_connections: null; udp_mappings: null };
  ports: { held: LinkMaintenancePort[]; candidate: LinkMaintenancePort[]; availability: "not_checked"; reserved: false };
  impact: { listener_move: boolean; tcp: "none" | "reconnect_required" | "drain_required"; udp: "none" | "mapping_rebuild_required" };
  execution: { supported: false; blockers: MaintenanceBlocker[]; stages: (typeof LINK_MAINTENANCE_STAGES)[number][] };
}
const MAX_ID = 2_147_483_647;
const fail = (): never => { throw new LinksPayloadError(); };
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fail();
}
function integer(value: unknown, min = 0, max = MAX_ID): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : fail();
}
function text(value: unknown, max = 255): string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value : fail();
}
/** Existing rule names can legally contain tabs/newlines; React renders them as text, never markup. */
function name(value: unknown): string {
  return typeof value === "string" && value.length > 0 && value.length <= 255 ? value : fail();
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  return typeof value === "string" && choices.includes(value as T) ? value as T : fail();
}
function boolean(value: unknown): boolean { return typeof value === "boolean" ? value : fail(); }
function rows(value: unknown, max: number): unknown[] { return Array.isArray(value) && value.length <= max ? value : fail(); }
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) fail();
}
function config(value: unknown): LinkConfig {
  const raw = object(value);
  const result = { ingress_node_id: integer(raw.ingress_node_id, 1), egress_node_id: integer(raw.egress_node_id, 1),
    carrier_port: integer(raw.carrier_port, 1, 65_535) };
  if (result.ingress_node_id === result.egress_node_id) fail();
  return result;
}
function timestamp(value: unknown): string {
  const result = text(value, 24);
  const time = Date.parse(result);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result) || !Number.isFinite(time)
    || new Date(time).toISOString() !== result) fail();
  return result;
}
function listener(value: unknown): Listener {
  const raw = object(value);
  return { node_id: integer(raw.node_id, 1), bind_scope: text(raw.bind_scope), port: integer(raw.port, 1, 65_535) };
}
function port(value: unknown): LinkMaintenancePort {
  const raw = object(value);
  return { ...listener(raw), role: choice(raw.role, ["ingress", "egress"]), protocol: choice(raw.protocol, ["tcp", "udp", "unknown"]) };
}
/** Match the strict request schema before HTTP; never forward arbitrary keys or key material. */
export function projectLinkMaintenanceInput(value: unknown): LinkMaintenancePreviewInput {
  const raw = object(value); exactKeys(raw, ["expected_version", "expected_generation", "change"]);
  const change = object(raw.change);
  const type = choice(change.type, ["update_endpoints", "rotate_key"]);
  exactKeys(change, type === "rotate_key" ? ["type"] : ["type", "config"]);
  if (type === "update_endpoints") exactKeys(object(change.config), ["ingress_node_id", "egress_node_id", "carrier_port"]);
  return { expected_version: integer(raw.expected_version, 1, MAX_ID - 1), expected_generation: integer(raw.expected_generation, 0, MAX_ID - 1),
    change: type === "rotate_key" ? { type } : { type, config: config(change.config) } };
}
/** Closed, bounded public projection. Extra transport/runner secrets are discarded at every level. */
export function projectLinkMaintenancePreview(value: unknown, workspaceId: number, linkId: number,
  requested: LinkMaintenancePreviewInput): LinkMaintenancePreview {
  integer(workspaceId, 1); integer(linkId, 1);
  const input = projectLinkMaintenanceInput(requested);
  const raw = object(value);
  if (raw.schema_version !== 1 || raw.workspace_id !== workspaceId || raw.link_id !== linkId || raw.operation !== input.change.type) fail();
  const snap = object(raw.snapshot), cand = object(raw.candidate), diff = object(raw.changes);
  if (snap.desired_version !== input.expected_version || snap.generation !== input.expected_generation) fail();
  const token = text(snap.state_token, 64); if (!/^[0-9a-f]{64}$/.test(token)) fail();
  let submission: LinkMaintenancePreview["submission"];
  let receipt: string | undefined;
  if (raw.submission !== undefined) {
    const value = object(raw.submission);
    if (value.hold_seconds !== 300) fail();
    submission = { supported: boolean(value.supported), hold_seconds: 300 };
    if (submission.supported) {
      receipt = text(snap.receipt, 2048);
      if (!/^lm1\.[A-Za-z0-9_-]+\.[0-9a-f]{64}$/.test(receipt)) fail();
    }
  }
  const created_at = timestamp(raw.created_at), expires_at = timestamp(raw.expires_at);
  const duration = Date.parse(expires_at) - Date.parse(created_at);
  if (duration <= 0 || duration > 60_000) fail();
  const changes = { ingress_changed: boolean(diff.ingress_changed), egress_changed: boolean(diff.egress_changed),
    carrier_port_changed: boolean(diff.carrier_port_changed), credentials_changed: boolean(diff.credentials_changed) };
  const rotate = input.change.type === "rotate_key";
  if (changes.credentials_changed !== rotate || (rotate && (changes.ingress_changed || changes.egress_changed || changes.carrier_port_changed))) fail();
  const changed = Object.values(changes).some(Boolean);
  const candidateConfig = config(cand.config);
  if (input.change.type === "update_endpoints" && !sameConfig(candidateConfig, input.change.config)) fail();
  const version = integer(cand.version, 1), generation = integer(cand.generation);
  if (version !== input.expected_version + (!rotate && changed ? 1 : 0) || generation !== input.expected_generation + 1
    || cand.key_action !== (rotate ? "rotate" : "preserve")) fail();
  const refs = object(raw.references), seen = new Set<number>();
  const forwards = rows(refs.forwards, LINK_MAINTENANCE_REFERENCE_LIMIT).map((value): LinkMaintenanceReference => {
    const f = object(value), id = integer(f.id, 1); if (seen.has(id)) fail(); seen.add(id);
    const old = listener(f.listener), next = listener(f.candidate_listener);
    if (next.node_id !== candidateConfig.ingress_node_id || old.bind_scope !== next.bind_scope || old.port !== next.port) fail();
    return { id, name: name(f.name), protocol: choice(f.protocol, ["tcp", "udp", "both"]),
      desired_status: choice(f.desired_status, ["active", "inactive"]), config_revision: integer(f.config_revision),
      listener: old, candidate_listener: next };
  });
  const total = integer(refs.total, 0, LINK_MAINTENANCE_REFERENCE_LIMIT), active = integer(refs.active, 0, total), suspended = integer(refs.suspended, 0, total);
  if (total !== forwards.length || active !== forwards.filter((f) => f.desired_status === "active").length || active + suspended !== total) fail();
  const rt = object(raw.runtime), roles = new Set<string>();
  if (rt.tcp_connections !== null || rt.udp_mappings !== null) fail();
  const placements = rows(rt.placements, 2).map((value) => {
    const p = object(value), role = choice(p.role, ["ingress", "egress"]); if (roles.has(role)) fail(); roles.add(role);
    return { node_id: integer(p.node_id, 1), role, state: choice(p.state, OBSERVATION_STATES),
      ready: p.ready === null ? null : boolean(p.ready) };
  });
  const state = choice(rt.state, ["not_deployed", "ready", "unknown", "not_ready"]);
  if ((input.expected_generation === 0) !== (state === "not_deployed")) fail();
  const ports = object(raw.ports), impact = object(raw.impact), exec = object(raw.execution);
  if (ports.availability !== "not_checked" || ports.reserved !== false || exec.supported !== false) fail();
  const blockers = rows(exec.blockers, 4).map((v) => choice<MaintenanceBlocker>(v,
    ["maintenance_executor_unavailable", "link_no_change", "link_not_deployed", "link_runtime_unconfirmed"]));
  const expectedBlockers: MaintenanceBlocker[] = ["maintenance_executor_unavailable", ...(!changed ? ["link_no_change" as const] : []),
    ...(rotate && !input.expected_generation ? ["link_not_deployed" as const] : []),
    ...(input.expected_generation && state !== "ready" ? ["link_runtime_unconfirmed" as const] : [])];
  if (JSON.stringify(blockers) !== JSON.stringify(expectedBlockers) || JSON.stringify(rows(exec.stages, 8)) !== JSON.stringify(LINK_MAINTENANCE_STAGES)) fail();
  // Impact includes deployed bindings and conservative unknown-runtime lanes, not just desired enabled references.
  const tcp = choice(impact.tcp, ["none", "reconnect_required", "drain_required"]);
  const udp = choice(impact.udp, ["none", "mapping_rebuild_required"]);
  if (impact.listener_move !== changes.ingress_changed) fail();
  return { schema_version: 1, workspace_id: workspaceId, link_id: linkId, operation: input.change.type, created_at, expires_at,
    snapshot: { desired_version: input.expected_version, generation: input.expected_generation, state_token: token,
      ...(receipt ? { receipt } : {}) }, ...(submission ? { submission } : {}),
    candidate: { config: candidateConfig, version, generation, key_action: rotate ? "rotate" : "preserve" }, changes,
    references: { total, active, suspended, forwards }, runtime: { state, placements, tcp_connections: null, udp_mappings: null },
    ports: { held: rows(ports.held, LINK_MAINTENANCE_PORT_LIMIT).map(port), candidate: rows(ports.candidate, LINK_MAINTENANCE_PORT_LIMIT).map(port), availability: "not_checked", reserved: false },
    impact: { listener_move: changes.ingress_changed, tcp, udp }, execution: { supported: false, blockers, stages: [...LINK_MAINTENANCE_STAGES] } };
}
function sameConfig(a: LinkConfig, b: LinkConfig): boolean {
  return a.ingress_node_id === b.ingress_node_id && a.egress_node_id === b.egress_node_id && a.carrier_port === b.carrier_port;
}
/** Cached planning facts cannot outlive their CAS, references, request, lease or 60s lifetime. */
export function isLinkMaintenancePreviewCurrent(preview: LinkMaintenancePreview, link: LinkDetail, now: number): boolean {
  if (!Number.isFinite(now) || now >= Date.parse(preview.expires_at) || Date.parse(preview.created_at) - now > 5_000
    || preview.link_id !== link.id || preview.workspace_id !== link.workspace_id || !link.config
    || ["retired", "retiring"].includes(link.status) || preview.snapshot.desired_version !== link.desired_version
    || preview.snapshot.generation !== link.generation || preview.references.total !== link.forwards.length
    || (link.ref_count !== null && link.ref_count !== preview.references.total)) return false;
  const c = preview.candidate.config, changes = preview.changes;
  if (changes.ingress_changed !== (c.ingress_node_id !== link.config.ingress_node_id)
    || changes.egress_changed !== (c.egress_node_id !== link.config.egress_node_id)
    || changes.carrier_port_changed !== (c.carrier_port !== link.config.carrier_port)) return false;
  const lease = Date.parse(link.deployment?.lease_expires_at ?? "");
  if (lease > Date.parse(preview.created_at) && lease <= now) return false;
  return preview.references.forwards.every((ref) => {
    const f = link.forwards.find((f) => f.id === ref.id);
    const scope = f?.listen_ip === null || ["", "0.0.0.0", "::", "*"].includes(f?.listen_ip ?? "") ? "*" : f?.listen_ip;
    return f && f.config_revision === ref.config_revision && f.desired_status === ref.desired_status
      && f.forward_protocol === ref.protocol && f.name === ref.name && ref.listener.node_id === link.config!.ingress_node_id
      && f.listen_port === ref.listener.port && scope === ref.listener.bind_scope;
  });
}
