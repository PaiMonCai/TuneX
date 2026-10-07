import type { LinkBindingInput, LinkDetail, LinkForward, LinkTraffic } from "@/lib/links-types";

export const binding: LinkBindingInput = { name: "Game UDP and TCP", protocol: "both", listen_host: "", listen_port: 24001,
  target_host: "127.0.0.1", target_port: 25001, bytes_per_second_in: 1024,
  bytes_per_second_out: 2048, max_connections: 30, max_connections_per_ip: 3 };
export function traffic(over: Partial<LinkTraffic> = {}): LinkTraffic {
  return { bytes_in: "1024", bytes_out: "2048", connections: "7", last_received_at: "2029-01-01T00:00:00.000Z", ...over };
}
export function forward(over: Partial<LinkForward> = {}): LinkForward {
  return { id: 7, name: binding.name, forward_protocol: "both", listen_ip: "0.0.0.0", listen_port: 24001,
    remote_host: "127.0.0.1", remote_port: 25001, desired_status: "active", apply_status: "active",
    config_revision: 8, applied_revision: 8, bytes_per_second_in: 1024, bytes_per_second_out: 2048,
    max_connections: 30, max_connections_per_ip: 3, ...over };
}
export function link(over: Partial<LinkDetail> = {}): LinkDetail {
  return { id: 3, workspace_id: 5, name: "EU link", carrier: "fxp_v1", status: "active", desired_version: 2,
    generation: 4, ref_count: 1, config: { ingress_node_id: 11, egress_node_id: 12, carrier_port: 26001 },
    deployment: { generation: 4, status: "active", lease_expires_at: "2030-01-01T00:00:00.000Z", placements: [
      { node_id: 11, role: "ingress", generation: 4, applied_generation: 4, status: "running", last_error_code: null, updated_at: null },
      { node_id: 12, role: "egress", generation: 4, applied_generation: 4, status: "running", last_error_code: null, updated_at: null },
    ] }, forwards: [forward()], ...over };
}
