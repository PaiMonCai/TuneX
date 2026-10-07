/** Public Link API projection. Transport keys and runner configurations never enter UI state. */
export type LinkProtocol = "tcp" | "udp" | "both";
export type LinkForwardAction = "suspend" | "resume" | "retry" | "delete";
export interface LinkConfig { ingress_node_id: number; egress_node_id: number; carrier_port: number }
export interface LinkCreateInput { name: string; config: LinkConfig }
export const LINK_TARGET_LIMIT = 10;
export interface LinkTarget { host: string; port: number }
export interface LinkTargetSet {
  version: 1; targets: LinkTarget[]; strategy: "fallback" | "round_robin" | "random";
  failure_seconds: number; recover_seconds: number; probe: "tcp" | "none";
}
export type LinkTargetHealth = "unknown" | "healthy" | "suspect" | "recovering" | "unhealthy";
/** Exit observations for one immutable generation; selected indices are last chosen, not session destinations. */
export interface LinkTargetStatus {
  forward_id: number; states: LinkTargetHealth[]; selected_tcp: number | null; selected_udp: number | null;
  last_checked_at: string | null;
  reason: "initial" | "selected" | "target_failed" | "target_recovered" | "all_unavailable";
}
export interface LinkBindingInput {
  name: string; protocol: LinkProtocol; listen_port: number; listen_host: "" | "127.0.0.1" | "::1";
  target_host: string; target_port: number;
  target_set?: LinkTargetSet;
  bytes_per_second_in: number; bytes_per_second_out: number;
  max_connections: number; max_connections_per_ip: number;
}
export interface LinkResource {
  id: number; workspace_id: number; name: string; carrier: string; status: string;
  desired_version: number; generation: number; ref_count: number | null;
}
export interface LinkPlacement {
  node_id: number; role: string; generation: number; applied_generation: number | null;
  status: string; last_error_code: string | null; updated_at: string | null;
  observation?: LinkObservation | null;
}
/** Capacity snapshot; a durable statistics ACK is independent of runtime Ready. */
export interface LinkTrafficStatus {
  rotation_supported: boolean; producer_count: number; sample_count: number; rule_count: number;
  spool_bytes: number; last_ack_at: string | null; state: "idle" | "collecting" | "backlogged" | "blocked";
}
export interface LinkObservation {
  state: string; ready: boolean | null; observed_generation: number | null;
  traffic_status?: LinkTrafficStatus | null;
  target_status?: LinkTargetStatus[];
}
export interface LinkDeployment {
  generation: number; version?: number | null; status: string; lease_expires_at: string; placements: LinkPlacement[];
}
/** Checkpoint sums over all historical producers/days, not rate or live concurrency. */
export interface LinkTraffic {
  bytes_in: string; bytes_out: string; connections: string; last_received_at: string;
}
export interface LinkForward {
  user_id?: number | null;
  id: number; name: string; forward_protocol: LinkProtocol; listen_ip: string | null; listen_port: number;
  remote_host: string; remote_port: number; desired_status: string; apply_status: string;
  target_set?: LinkTargetSet;
  config_revision: number; applied_revision: number | null;
  bytes_per_second_in: number | null; bytes_per_second_out: number | null;
  max_connections: number | null; max_connections_per_ip: number | null;
  traffic?: LinkTraffic | null;
}
export interface LinkDetail extends LinkResource {
  config: LinkConfig | null; deployment: LinkDeployment | null; forwards: LinkForward[];
}

export class LinksPayloadError extends Error {
  readonly code = "invalid_link_response";
  constructor() { super("invalid_link_response"); this.name = "LinksPayloadError"; }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LinksPayloadError();
  return value as Record<string, unknown>;
}
function number(value: unknown, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) throw new LinksPayloadError();
  return value;
}
function boundedNumber(value: unknown, min: number, max: number): number {
  const result = number(value, min);
  if (result > max) throw new LinksPayloadError();
  return result;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new LinksPayloadError();
  return value;
}
const nullableNumber = (value: unknown) => value == null ? null : number(value);
const nullableText = (value: unknown) => value == null ? null : text(value);
/** Host and port are separate. The browser's IPv6 URL parser validates raw colon-containing IPs. */
export function isLinkTargetHost(host: string): boolean {
  if (!host || host.length > 255 || /[\s/\\\x00-\x1f\x7f\[\]]/.test(host)) return false;
  if (!host.includes(":")) return true;
  try { return new URL(`http://[${host}]/`).hostname.startsWith("["); }
  catch { return false; }
}
/** Strict bounded parser and closed projection shared by response and form boundaries. */
export function projectLinkTargetSet(value: unknown): LinkTargetSet {
  const raw = object(value);
  if (raw.version !== 1 || !["fallback", "round_robin", "random"].includes(text(raw.strategy))
    || !["tcp", "none"].includes(text(raw.probe))) throw new LinksPayloadError();
  const input = array(raw.targets);
  if (!input.length || input.length > LINK_TARGET_LIMIT) throw new LinksPayloadError();
  const seen = new Set<string>();
  const targets = input.map((value): LinkTarget => {
    const target = object(value);
    const host = text(target.host);
    if (!isLinkTargetHost(host)) throw new LinksPayloadError();
    const port = boundedNumber(target.port, 1, 65_535);
    const key = JSON.stringify([host.toLowerCase(), port]);
    if (seen.has(key)) throw new LinksPayloadError();
    seen.add(key);
    return { host, port };
  });
  return { version: 1, targets, strategy: raw.strategy as LinkTargetSet["strategy"],
    failure_seconds: boundedNumber(raw.failure_seconds, 10, 3600),
    recover_seconds: boundedNumber(raw.recover_seconds, 10, 3600), probe: raw.probe as LinkTargetSet["probe"] };
}
function projectTargetStatus(value: unknown): LinkTargetStatus[] {
  const rows = array(value);
  if (rows.length > 500) throw new LinksPayloadError();
  const seen = new Set<number>();
  return rows.map((value): LinkTargetStatus => {
    const raw = object(value);
    const forward_id = boundedNumber(raw.forward_id, 1, 2_147_483_647);
    if (seen.has(forward_id)) throw new LinksPayloadError();
    seen.add(forward_id);
    const input = array(raw.states);
    if (!input.length || input.length > LINK_TARGET_LIMIT) throw new LinksPayloadError();
    const states = input.map((value) => {
      if (!["unknown", "healthy", "suspect", "recovering", "unhealthy"].includes(text(value))) throw new LinksPayloadError();
      return value as LinkTargetHealth;
    });
    if (!["initial", "selected", "target_failed", "target_recovered", "all_unavailable"].includes(text(raw.reason))) throw new LinksPayloadError();
    const selected = (value: unknown) => value === null ? null : boundedNumber(value, 0, states.length - 1);
    return { forward_id, states, selected_tcp: selected(raw.selected_tcp), selected_udp: selected(raw.selected_udp),
      last_checked_at: raw.last_checked_at === null ? null : trafficReceivedAt(raw.last_checked_at),
      reason: raw.reason as LinkTargetStatus["reason"] };
  });
}
function counter(value: unknown): string {
  const result = /^(?:0|[1-9][0-9]*)$/.exec(text(value));
  // Preserve the complete canonical decimal rather than a normalized number.
  if (!result || result[0] !== value) throw new LinksPayloadError();
  return result[0];
}
function trafficReceivedAt(value: unknown): string {
  const input = text(value);
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(input);
  if (!match || match[0] !== input) throw new LinksPayloadError();
  // Date.parse alone normalizes impossible dates (e.g. February 30 or 24:00).
  // Validate the local calendar/time before applying a timezone offset.
  const local = Date.parse(`${match[1]}Z`);
  if (!Number.isFinite(local) || new Date(local).toISOString().slice(0, 19) !== match[1]
    || !Number.isFinite(Date.parse(input))) throw new LinksPayloadError();
  return input;
}
function projectTraffic(value: unknown): LinkTraffic | null {
  if (value == null) return null;
  const raw = object(value);
  return { bytes_in: counter(raw.bytes_in), bytes_out: counter(raw.bytes_out),
    connections: counter(raw.connections), last_received_at: trafficReceivedAt(raw.last_received_at) };
}
function projectTrafficStatus(value: unknown): LinkTrafficStatus | null {
  if (value == null) return null;
  const raw = object(value);
  if (typeof raw.rotation_supported !== "boolean" || !["idle", "collecting", "backlogged", "blocked"].includes(text(raw.state))) {
    throw new LinksPayloadError();
  }
  const bounded = (value: unknown, max: number) => {
    const result = number(value);
    if (result > max) throw new LinksPayloadError();
    return result;
  };
  return { rotation_supported: raw.rotation_supported, producer_count: bounded(raw.producer_count, 128),
    sample_count: bounded(raw.sample_count, 262144), rule_count: bounded(raw.rule_count, 262144),
    spool_bytes: bounded(raw.spool_bytes, 403701760),
    last_ack_at: raw.last_ack_at === null ? null : trafficReceivedAt(raw.last_ack_at),
    state: raw.state as LinkTrafficStatus["state"] };
}
function projectObservation(value: unknown): LinkObservation | null {
  if (value == null) return null;
  const raw = object(value);
  if (raw.ready !== null && typeof raw.ready !== "boolean") throw new LinksPayloadError();
  return { state: text(raw.state), ready: raw.ready,
    observed_generation: nullableNumber(raw.observed_generation),
    ...(raw.traffic_status === undefined ? {} : { traffic_status: projectTrafficStatus(raw.traffic_status) }),
    ...(raw.target_status === undefined ? {} : { target_status: projectTargetStatus(raw.target_status) }) };
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new LinksPayloadError();
  return value;
}
/** Validate tenant identity before accepting a resource, including mutation responses. */
export function projectLinkResource(value: unknown, workspaceId: number): LinkResource {
  const row = object(value);
  if (number(row.workspace_id, 1) !== workspaceId) throw new LinksPayloadError();
  const count = row.ref_count ?? (row._count ? object(row._count).forwards : null);
  return { id: number(row.id, 1), workspace_id: workspaceId, name: text(row.name),
    carrier: text(row.carrier), status: text(row.status), desired_version: number(row.desired_version, 1),
    generation: number(row.generation), ref_count: nullableNumber(count) };
}
export function projectLinkList(value: unknown, workspaceId: number): LinkResource[] {
  return array(value).map((row) => projectLinkResource(row, workspaceId));
}
export function projectLinkDetail(value: unknown, workspaceId: number): LinkDetail {
  const row = object(value);
  const resource = projectLinkResource(row, workspaceId);
  const config = row.config == null ? null : object(row.config);
  const deployment = row.deployment == null ? null : object(row.deployment);
  const forwards = array(row.forwards).map((value): LinkForward => {
    const f = object(value);
    if (!["tcp", "udp", "both"].includes(text(f.forward_protocol))) throw new LinksPayloadError();
    const targetSet = f.target_set === undefined ? undefined : projectLinkTargetSet(f.target_set);
    if (targetSet && (targetSet.targets[0].host.toLowerCase() !== text(f.remote_host).trim().toLowerCase()
      || targetSet.targets[0].port !== f.remote_port)) throw new LinksPayloadError();
    return { id: number(f.id, 1), user_id: nullableNumber(f.user_id), name: text(f.name), forward_protocol: f.forward_protocol as LinkProtocol,
      listen_ip: nullableText(f.listen_ip), listen_port: number(f.listen_port, 1),
      remote_host: text(f.remote_host), remote_port: number(f.remote_port, 1),
      ...(targetSet ? { target_set: targetSet } : {}),
      desired_status: text(f.desired_status), apply_status: text(f.apply_status),
      config_revision: number(f.config_revision), applied_revision: nullableNumber(f.applied_revision),
      bytes_per_second_in: nullableNumber(f.bytes_per_second_in), bytes_per_second_out: nullableNumber(f.bytes_per_second_out),
      max_connections: nullableNumber(f.max_connections), max_connections_per_ip: nullableNumber(f.max_connections_per_ip),
      traffic: projectTraffic(f.traffic) };
  });
  return { ...resource, ref_count: resource.ref_count ?? forwards.length, forwards,
    config: config ? { ingress_node_id: number(config.ingress_node_id, 1),
      egress_node_id: number(config.egress_node_id, 1), carrier_port: number(config.carrier_port, 1) } : null,
    deployment: deployment ? { generation: number(deployment.generation), version: nullableNumber(deployment.version), status: text(deployment.status),
      lease_expires_at: text(deployment.lease_expires_at),
      placements: array(deployment.placements).map((value): LinkPlacement => {
        const p = object(value);
        return { node_id: number(p.node_id, 1), role: text(p.role), generation: number(p.generation),
          applied_generation: nullableNumber(p.applied_generation), status: text(p.status),
          last_error_code: nullableText(p.last_error_code), updated_at: nullableText(p.updated_at), observation: projectObservation(p.observation) };
      }) } : null };
}
