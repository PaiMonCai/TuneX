import type { DiagnoseReport, PortForward, UserNode } from "@/lib/types";
import type { ForwardTopology } from "@/lib/api/forwards";
export function nativeBothFixtureNodes(): UserNode[] {
  return [{ id: 11, node_id: "Local ingress", role: "ingress" }, { id: 12, node_id: "Local egress", role: "egress" }].map((node) => ({
    ...node, agent_id: `fixture-agent-${node.id}`, accepts_new_business: true, connect_ip: "127.0.0.1" } as UserNode));
}
export function nativeBothFixtureRule(over: Partial<PortForward> = {}): PortForward {
  return { id: 40, name: "native loopback", protocol: "both", protocol_supported: true, mode: "direct", ingress_node_id: 11,
    egress_node_id: null, listen_ip: "127.0.0.1", listen_port: 25000, target_host: "127.0.0.1", target_port: 9000,
    tls_cert_path: null, tls_key_path: null, bytes_per_second_in: 1234, bytes_per_second_out: 5678,
    max_connections: 9, max_connections_per_ip: 2, desired_status: "active", apply_status: "pending",
    config_revision: 7, applied_revision: 6, latest_revision: 7, ...over } as PortForward;
}
export function nativeBothFixtureReport(): DiagnoseReport {
  return { forward_id: 40, protocol: "both", mode: "direct", generated_at: "2026-10-08T00:00:00Z", next_step: "Fixture TCP result only; UDP unverified.",
    segments: [{ segment: "ingress_to_target", method: "tcp_probe", verified: true, node_id: 11, node_key: "Local ingress", outcome: "ok",
      targets: [], results: [{ host: "127.0.0.1", port: 9000, status: "reachable", elapsed_ms: 2 }] }] };
}
export function nativeBothFixtureTopology(): ForwardTopology {
  const endpoint = { node_id: 11, node_key: "Local ingress", runtime_id: "tunex-40-relay", running: true, revision: 6,
    diag: { protocol: "both", facts: { bytes: 120, live_connections: 0, future_fact: "retained" }, truncated: false } };
  return { forward_id: 40, mode: "relay", observed_at: "2026-10-08T00:00:00Z", stale_segments: 0, segments: [{
    segment: "ingress_to_egress", from: endpoint, to: { ...endpoint, node_id: 12, node_key: "Local egress", runtime_id: "tunex-40-egress" }, hop: null, expected_revision: 7 }] };
}
