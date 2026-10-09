/** Public JSON fixtures only; never used by product code or imported from the backend builder. */
import { LINK_MAINTENANCE_STAGES, type LinkMaintenanceObservationState, type LinkMaintenancePreview, type LinkMaintenancePreviewInput } from "@/lib/link-maintenance-types";
import type { LinkConfig, LinkDetail } from "@/lib/links-types";
import { link } from "./links-fixtures";

export function maintenanceInput(row = link(), operation: "update_endpoints" | "rotate_key" = "update_endpoints", config?: LinkConfig): LinkMaintenancePreviewInput {
  return { expected_version: row.desired_version, expected_generation: row.generation,
    change: operation === "rotate_key" ? { type: operation } : { type: operation, config: config ?? { ...row.config!, carrier_port: 26002 } } };
}
export function maintenancePreview(row: LinkDetail = link(), input = maintenanceInput(row), now = Date.now()): LinkMaintenancePreview {
  const config = input.change.type === "update_endpoints" ? input.change.config : row.config!;
  const changes = { ingress_changed: config.ingress_node_id !== row.config!.ingress_node_id,
    egress_changed: config.egress_node_id !== row.config!.egress_node_id,
    carrier_port_changed: config.carrier_port !== row.config!.carrier_port, credentials_changed: input.change.type === "rotate_key" };
  const changed = Object.values(changes).some(Boolean);
  const active = row.forwards.filter((f) => f.desired_status === "active");
  const ready = row.generation > 0 && row.deployment?.placements.length === 2 && row.deployment.placements.every((p) => p.observation?.ready === true);
  const state = row.generation === 0 ? "not_deployed" : ready ? "ready" : "unknown";
  return { schema_version: 1, link_id: row.id, workspace_id: row.workspace_id, operation: input.change.type,
    created_at: new Date(now).toISOString(), expires_at: new Date(now + 60_000).toISOString(),
    snapshot: { desired_version: row.desired_version, generation: row.generation, state_token: "a".repeat(64) },
    candidate: { config: { ...config }, version: row.desired_version + (input.change.type === "update_endpoints" && changed ? 1 : 0),
      generation: row.generation + 1, key_action: input.change.type === "rotate_key" ? "rotate" : "preserve" }, changes,
    references: { total: row.forwards.length, active: active.length, suspended: row.forwards.length - active.length,
      forwards: row.forwards.map((f) => ({ id: f.id, name: f.name, protocol: f.forward_protocol, desired_status: f.desired_status as "active" | "inactive",
        config_revision: f.config_revision, listener: { node_id: row.config!.ingress_node_id, bind_scope: f.listen_ip === "127.0.0.1" || f.listen_ip === "::1" ? f.listen_ip : "*", port: f.listen_port },
        candidate_listener: { node_id: config.ingress_node_id, bind_scope: f.listen_ip === "127.0.0.1" || f.listen_ip === "::1" ? f.listen_ip : "*", port: f.listen_port } })) },
    runtime: { state, placements: row.deployment?.placements.map((p) => ({ node_id: p.node_id, role: p.role as "ingress" | "egress",
      state: (p.observation?.state ?? "unknown") as LinkMaintenanceObservationState, ready: p.observation?.ready ?? null })) ?? [], tcp_connections: null, udp_mappings: null },
    ports: { held: [{ node_id: row.config!.egress_node_id, role: "egress", protocol: "tcp", bind_scope: "*", port: row.config!.carrier_port }],
      candidate: [{ node_id: config.egress_node_id, role: "egress", protocol: "tcp", bind_scope: "*", port: config.carrier_port },
        { node_id: config.egress_node_id, role: "egress", protocol: "udp", bind_scope: "*", port: config.carrier_port }], availability: "not_checked", reserved: false },
    impact: { listener_move: changes.ingress_changed,
      tcp: !changed || (state === "ready" && !active.some((f) => f.forward_protocol !== "udp")) ? "none" : changes.ingress_changed ? "reconnect_required" : "drain_required",
      udp: !changed || (state === "ready" && !active.some((f) => f.forward_protocol !== "tcp")) ? "none" : "mapping_rebuild_required" },
    execution: { supported: false, blockers: ["maintenance_executor_unavailable", ...(!changed ? ["link_no_change" as const] : []),
      ...(input.change.type === "rotate_key" && !row.generation ? ["link_not_deployed" as const] : []), ...(row.generation && !ready ? ["link_runtime_unconfirmed" as const] : [])], stages: [...LINK_MAINTENANCE_STAGES] } };
}
