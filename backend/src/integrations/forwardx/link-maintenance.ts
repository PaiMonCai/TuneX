import { z } from "zod";
import { canonicalConfigDigest } from "./core-contract.ts";
import { leaseProtocol, normalizeBindScope } from "./bind-scope.ts";

const id = z.number().int().positive().max(2_147_483_647);
const sequence = z.number().int().min(0).max(2_147_483_646);
export const LinkEndpointConfigSchema = z.object({
  ingress_node_id: id, egress_node_id: id, carrier_port: id.max(65_535),
}).strict().refine((v) => v.ingress_node_id !== v.egress_node_id, "point_to_point_requires_distinct_nodes");
export type LinkEndpointConfig = z.infer<typeof LinkEndpointConfigSchema>;

/** This endpoint previews only. Neither a token nor candidate numbers reserve anything. */
export const LinkMaintenancePreviewSchema = z.object({
  expected_version: sequence.refine((v) => v > 0), expected_generation: sequence,
  change: z.discriminatedUnion("type", [
    z.object({ type: z.literal("update_endpoints"), config: LinkEndpointConfigSchema }).strict(),
    z.object({ type: z.literal("rotate_key") }).strict(),
  ]),
}).strict();
export type LinkMaintenancePreviewInput = z.infer<typeof LinkMaintenancePreviewSchema>;

export interface MaintenanceForward {
  id: number; name: string; forward_protocol: "tcp" | "udp" | "both";
  desired_status: "active" | "inactive"; config_revision: number;
  ingress_node_id: number; listen_ip: string; listen_port: number;
}
export interface MaintenancePort {
  node_id: number; role: "ingress" | "egress"; protocol: string; bind_scope: string; port: number;
}
export interface MaintenancePlacement {
  runtime_id: string; node_id: number; role: string; generation: number;
  config_digest: string; applied_generation: number | null;
  observation: { state: string; ready: boolean | null; observed_generation: number | null };
}
export interface MaintenanceState {
  link: { id: number; workspace_id: number; status: string; desired_version: number; generation: number };
  config: LinkEndpointConfig;
  deployment: { id: number; version: number; generation: number; status: string;
    lease_expires_at: string; placements: MaintenancePlacement[];
    bindings_current: boolean;
    bindings: { forward_id: number; protocol: "tcp" | "udp" | "both"; revision: number }[] } | null;
  forwards: MaintenanceForward[];
  held_ports: (MaintenancePort & { id: number })[];
  /** Secret-free desired bindings, endpoints and effective policy, excluding lease/report clocks. */
  admission_digest?: string;
}

/** Versioned planning order, not an implemented executor or zero-downtime promise. */
export const LINK_MAINTENANCE_STAGES = ["reserve_candidate", "prepare_egress", "verify_egress",
  "cutover_ingress", "verify_ingress", "drain_old", "retire_old", "release_old_ports"] as const;
export const LINK_MAINTENANCE_PREVIEW_MS = 60_000;
export const LINK_MAINTENANCE_REFERENCE_LIMIT = 500;
export const LINK_MAINTENANCE_PORT_LIMIT = 2048;

export function buildLinkMaintenancePreview(state: MaintenanceState, input: LinkMaintenancePreviewInput,
  candidatePorts: MaintenancePort[], now: Date) {
  const { link, deployment } = state;
  const config = LinkEndpointConfigSchema.parse(state.config);
  const candidate = input.change.type === "update_endpoints" ? input.change.config : config;
  const changes = {
    ingress_changed: candidate.ingress_node_id !== config.ingress_node_id,
    egress_changed: candidate.egress_node_id !== config.egress_node_id,
    carrier_port_changed: candidate.carrier_port !== config.carrier_port,
    credentials_changed: input.change.type === "rotate_key",
  };
  const changed = Object.values(changes).some(Boolean);
  const forwards = [...state.forwards].sort((a, b) => a.id - b.id).map((f) => ({
    id: f.id, name: f.name, protocol: f.forward_protocol, desired_status: f.desired_status,
    config_revision: f.config_revision,
    listener: { node_id: f.ingress_node_id, bind_scope: normalizeBindScope(f.listen_ip), port: f.listen_port },
    candidate_listener: { node_id: candidate.ingress_node_id, bind_scope: normalizeBindScope(f.listen_ip), port: f.listen_port },
  }));
  const active = forwards.filter((f) => f.desired_status === "active");
  // Runtime facts come through the existing authenticated identity/freshness/lease fence.
  // Database ACKs and cumulative connection checkpoints are not live connections.
  const placements = deployment?.placements.map((p) => ({
    node_id: p.node_id, role: p.role, state: p.observation.state, ready: p.observation.ready,
  })) ?? [];
  const validDeployment = deployment != null && deployment.generation === link.generation &&
    deployment.version === link.desired_version && deployment.status === "active" && link.status === "active" &&
    Date.parse(deployment.lease_expires_at) > now.getTime() && deployment.placements.length === 2 &&
    ["ingress", "egress"].every((role) => deployment.placements.filter((p) => p.role === role).length === 1) &&
    deployment.bindings_current && deployment.bindings.length === active.length && active.every((f) =>
      deployment.bindings.filter((b) => b.forward_id === f.id && b.revision === f.config_revision && b.protocol === f.protocol).length === 1);
  const ready = validDeployment && deployment!.placements.every((p) => p.generation === link.generation &&
    p.node_id === (p.role === "ingress" ? config.ingress_node_id : config.egress_node_id) &&
    p.applied_generation === link.generation && (p.observation.observed_generation === link.generation &&
    p.observation.ready === true || (p.role === "ingress" && !active.length && p.observation.state === "passive")));
  const runtimeState = link.generation === 0 ? "not_deployed" as const : ready ? "ready" as const
    : placements.some((p) => p.ready === null || ["unknown", "stale"].includes(p.state)) || !deployment
      ? "unknown" as const : "not_ready" as const;
  const blockers = ["maintenance_executor_unavailable"];
  if (!changed) blockers.push("link_no_change");
  if (input.change.type === "rotate_key" && !link.generation) blockers.push("link_not_deployed");
  if (link.generation && !ready) blockers.push("link_runtime_unconfirmed");
  const held = [...state.held_ports].sort((a, b) => a.id - b.id);
  // Exclude mutable runtime observations/lease renewal timestamps. An executor must
  // freshly revalidate those, while this token binds desired/deployed state, all
  // references (including suspended ones), durable occupancy and the requested change.
  const stateToken = canonicalConfigDigest({
    link: { id: link.id, workspace_id: link.workspace_id, status: link.status,
      desired_version: link.desired_version, generation: link.generation },
    config, operation: input.change.type, candidate,
    ...(state.admission_digest ? { admission_digest: state.admission_digest } : {}),
    deployment: deployment ? { id: deployment.id, version: deployment.version, generation: deployment.generation,
      status: deployment.status, bindings_current: deployment.bindings_current,
      bindings: [...deployment.bindings].sort((a, b) => a.forward_id - b.forward_id),
      placements: [...deployment.placements].sort((a, b) => a.node_id - b.node_id)
        .map((p) => ({ runtime_id: p.runtime_id, node_id: p.node_id, role: p.role,
          generation: p.generation, config_digest: p.config_digest, applied_generation: p.applied_generation })) } : null,
    forwards, held,
  });
  const publicPort = (p: MaintenancePort) => ({ node_id: p.node_id, role: p.role,
    protocol: leaseProtocol(p.protocol), bind_scope: normalizeBindScope(p.bind_scope), port: p.port });
  // Desired suspension/removal does not prove physical shutdown. Account for
  // deployed bindings, and conservatively warn for both lanes while an old or
  // partially updated carrier cannot be confirmed (even after refs are removed).
  const possiblyRunning = [...active.map((f) => f.protocol), ...(deployment?.bindings.map((b) => b.protocol) ?? [])];
  if (link.generation && !ready) possiblyRunning.push("both");
  return {
    schema_version: 1 as const, link_id: link.id, workspace_id: link.workspace_id, operation: input.change.type,
    created_at: now.toISOString(), expires_at: new Date(now.getTime() + LINK_MAINTENANCE_PREVIEW_MS).toISOString(),
    snapshot: { desired_version: link.desired_version, generation: link.generation, state_token: stateToken },
    candidate: { config: { ...candidate }, version: link.desired_version + (input.change.type === "update_endpoints" && changed ? 1 : 0),
      generation: link.generation + 1, key_action: input.change.type === "rotate_key" ? "rotate" as const : "preserve" as const },
    changes, references: { total: forwards.length, active: active.length,
      suspended: forwards.filter((f) => f.desired_status === "inactive").length, forwards },
    runtime: { state: runtimeState, placements, tcp_connections: null, udp_mappings: null },
    ports: { held: held.map(publicPort), candidate: candidatePorts.map(publicPort), availability: "not_checked" as const, reserved: false as const },
    impact: { listener_move: changes.ingress_changed,
      tcp: !changed || !possiblyRunning.some((p) => p !== "udp") ? "none" as const
        : changes.ingress_changed ? "reconnect_required" as const : "drain_required" as const,
      udp: !changed || !possiblyRunning.some((p) => p !== "tcp") ? "none" as const : "mapping_rebuild_required" as const },
    execution: { supported: false as const, blockers, stages: [...LINK_MAINTENANCE_STAGES] },
  };
}
