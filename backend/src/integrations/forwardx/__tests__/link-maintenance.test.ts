import { describe, expect, test } from "bun:test";
import { buildLinkMaintenancePreview, LINK_MAINTENANCE_STAGES, LinkMaintenancePreviewSchema,
  type LinkMaintenancePreviewInput, type MaintenanceState } from "../link-maintenance.ts";

const now = new Date("2030-01-01T00:00:00Z");
const rotation: LinkMaintenancePreviewInput = { expected_version: 2, expected_generation: 4, change: { type: "rotate_key" } };
function state(): MaintenanceState {
  return {
    link: { id: 3, workspace_id: 5, status: "active", desired_version: 2, generation: 4 },
    config: { ingress_node_id: 11, egress_node_id: 12, carrier_port: 25000 },
    forwards: [
      { id: 9, name: "suspended", forward_protocol: "tcp", desired_status: "inactive", config_revision: 2,
        ingress_node_id: 11, listen_ip: "::1", listen_port: 26001 },
      { id: 8, name: "live", forward_protocol: "both", desired_status: "active", config_revision: 3,
        ingress_node_id: 11, listen_ip: "0.0.0.0", listen_port: 26000 },
    ],
    held_ports: [{ id: 1, node_id: 12, role: "egress", protocol: "tcp", bind_scope: "*", port: 25000 }],
    deployment: { id: 10, version: 2, generation: 4, status: "active", lease_expires_at: "2030-01-01T00:03:00Z",
      bindings_current: true,
      bindings: [{ forward_id: 8, protocol: "both", revision: 3 }],
      placements: [11, 12].map((node_id) => ({ runtime_id: `link-${node_id}`, node_id, role: node_id === 11 ? "ingress" : "egress",
        generation: 4, config_digest: "51".repeat(32), applied_generation: 4,
        observation: { state: "ready", ready: true, observed_generation: 4 } })) },
  };
}
const preview = (s = state(), input = rotation) => buildLinkMaintenancePreview(s, input, [], now);

describe("F5 maintenance contract", () => {
  test("rotation includes suspended refs but never invents live concurrency, port availability or execution", () => {
    const s = state(), before = structuredClone(s), result = preview(s);
    expect(result).toMatchObject({ schema_version: 1, link_id: 3, workspace_id: 5, operation: "rotate_key",
      candidate: { version: 2, generation: 5, key_action: "rotate" }, references: { total: 2, active: 1, suspended: 1 },
      runtime: { state: "ready", tcp_connections: null, udp_mappings: null }, ports: { availability: "not_checked", reserved: false },
      impact: { tcp: "drain_required", udp: "mapping_rebuild_required", listener_move: false },
      execution: { supported: false, blockers: ["maintenance_executor_unavailable"] }, expires_at: "2030-01-01T00:01:00.000Z" });
    expect(result.references.forwards.map((f) => f.id)).toEqual([8, 9]);
    expect(result.references.forwards[0].listener.bind_scope).toBe("*");
    expect(result.references.forwards[1].candidate_listener.bind_scope).toBe("::1");
    expect(result.snapshot.state_token).toMatch(/^[a-f0-9]{64}$/); expect(s).toEqual(before);
  });
  test("ingress move requires client reconnect; hypothetical version does not change current listeners", () => {
    const s = state(); const result = preview(s, { ...rotation, change: { type: "update_endpoints", config: { ...s.config, ingress_node_id: 13 } } });
    expect(result.impact).toEqual({ listener_move: true, tcp: "reconnect_required", udp: "mapping_rebuild_required" });
    expect(result.candidate).toMatchObject({ version: 3, generation: 5, key_action: "preserve" });
    expect(result.references.forwards[1].candidate_listener).toEqual({ node_id: 13, bind_scope: "::1", port: 26001 });
  });
  test("unchanged endpoints have no impact or version advance", () => {
    const s = state(); const result = preview(s, { ...rotation, change: { type: "update_endpoints", config: s.config } });
    expect(result.execution.blockers).toContain("link_no_change");
    expect(result.candidate.version).toBe(2); expect(result.impact.tcp).toBe("none"); expect(result.impact.udp).toBe("none");
  });
  test("pending suspend/delete and incomplete snapshots cannot claim Ready or no interruption", () => {
    for (const mutate of [
      (s: MaintenanceState) => { s.forwards[1].desired_status = "inactive"; },
      (s: MaintenanceState) => { s.forwards[1].config_revision++; },
      (s: MaintenanceState) => { s.forwards.pop(); },
      (s: MaintenanceState) => { s.deployment!.bindings[0].revision--; },
      (s: MaintenanceState) => { s.deployment!.bindings_current = false; },
      (s: MaintenanceState) => { s.deployment!.placements[0].observation = { state: "stale", ready: null, observed_generation: null }; },
      (s: MaintenanceState) => { s.deployment!.placements[0].observation = { state: "mismatch", ready: false, observed_generation: 3 }; },
      (s: MaintenanceState) => { s.deployment!.placements[0].node_id = 99; },
      (s: MaintenanceState) => { s.deployment!.placements[0].applied_generation = 3; },
      (s: MaintenanceState) => { s.deployment!.version = 1; },
      (s: MaintenanceState) => { s.deployment!.status = "degraded"; },
      (s: MaintenanceState) => { s.link.status = "deploying"; },
      (s: MaintenanceState) => { s.deployment!.lease_expires_at = now.toISOString(); },
      (s: MaintenanceState) => { s.deployment!.placements.pop(); },
      (s: MaintenanceState) => { s.deployment!.placements[1].role = "ingress"; },
    ]) {
      const s = state(); mutate(s); const result = preview(s);
      expect(result.runtime.state).not.toBe("ready"); expect(result.execution.blockers).toContain("link_runtime_unconfirmed");
      expect(result.impact.tcp).not.toBe("none"); expect(result.impact.udp).not.toBe("none");
    }
  });
  test("passive ingress is safe only with a confirmed empty desired/deployed binding set", () => {
    const s = state(); s.deployment!.placements[0].observation = { state: "passive", ready: false, observed_generation: 0 };
    expect(preview(s).runtime.state).toBe("not_ready");
    s.forwards.forEach((f) => { f.desired_status = "inactive"; }); s.deployment!.bindings = [];
    expect(preview(s).runtime.state).toBe("ready"); expect(preview(s).impact.tcp).toBe("none");
    expect(preview(s).references).toMatchObject({ total: 2, active: 0, suspended: 2 });
    s.deployment = null; s.link.generation = 0;
    expect(preview(s).runtime.state).toBe("not_deployed"); expect(preview(s).execution.blockers).toContain("link_not_deployed");
  });
  test("single-protocol deployed rules do not fabricate another lane", () => {
    const s = state(); s.forwards[1].forward_protocol = "udp"; s.deployment!.bindings[0].protocol = "udp";
    expect(preview(s).impact.tcp).toBe("none");
    s.forwards[1].forward_protocol = "tcp"; s.deployment!.bindings[0].protocol = "tcp"; expect(preview(s).impact.udp).toBe("none");
  });
  test("stages verify egress before cutover and confirm retirement before freeing old ports", () => {
    expect(preview().execution.stages).toEqual([...LINK_MAINTENANCE_STAGES]);
    expect(LINK_MAINTENANCE_STAGES.indexOf("verify_egress")).toBeLessThan(LINK_MAINTENANCE_STAGES.indexOf("cutover_ingress"));
    expect(LINK_MAINTENANCE_STAGES.indexOf("retire_old")).toBeLessThan(LINK_MAINTENANCE_STAGES.indexOf("release_old_ports"));
  });
  test("state token fences suspended revisions, candidates, deployment and durable ownership, not heartbeat renewal", () => {
    const original = preview().snapshot.state_token;
    for (const mutate of [
      (s: MaintenanceState) => { s.link.workspace_id++; }, (s: MaintenanceState) => { s.link.id++; },
      (s: MaintenanceState) => { s.link.desired_version++; }, (s: MaintenanceState) => { s.link.generation++; },
      (s: MaintenanceState) => { s.link.status = "degraded"; }, (s: MaintenanceState) => { s.config.carrier_port++; },
      (s: MaintenanceState) => { s.forwards[0].config_revision++; }, (s: MaintenanceState) => { s.forwards[0].desired_status = "active"; },
      (s: MaintenanceState) => { s.forwards.pop(); }, (s: MaintenanceState) => { s.deployment!.placements[0].config_digest = "52".repeat(32); },
      (s: MaintenanceState) => { s.held_ports[0].id++; }, (s: MaintenanceState) => { s.held_ports[0].protocol = "udp"; },
    ]) { const s = state(); mutate(s); expect(preview(s).snapshot.state_token).not.toBe(original); }
    const s = state(); const move = { ...rotation, change: { type: "update_endpoints" as const, config: { ...s.config, carrier_port: 25001 } } };
    expect(preview(s, move).snapshot.state_token).not.toBe(original);
    expect(preview(s, { ...move, change: { ...move.change, config: { ...s.config, carrier_port: 25002 } } }).snapshot.state_token)
      .not.toBe(preview(s, move).snapshot.state_token);
    s.forwards.reverse(); s.deployment!.placements.reverse(); s.deployment!.lease_expires_at = "2030-01-01T00:04:00Z";
    s.deployment!.placements[0].observation.ready = false; expect(preview(s).snapshot.state_token).toBe(original);
  });
  test("public projection drops secrets, runner JSON, targets and lease row IDs", () => {
    const s = state(); Object.assign(s, { secret_enc: "never-public", runner_config: { key: "never-public" } });
    Object.assign(s.link, { secret: "never-public" }); Object.assign(s.forwards[0], { remote_host: "never-public" });
    const result = preview(s); expect(JSON.stringify(result)).not.toContain("never-public");
    expect(result.ports.held[0]).not.toHaveProperty("id");
    s.held_ports[0].protocol = "not-a-known-protocol"; expect(preview(s).ports.held[0].protocol).toBe("unknown");
    s.held_ports[0].protocol = "tls"; expect(preview(s).ports.held[0].protocol).toBe("tcp");
  });
  test("input refuses client keys, unknown operations, missing CAS, self-links and numeric overflow", () => {
    expect(LinkMaintenancePreviewSchema.parse(rotation)).toEqual(rotation);
    for (const raw of [{ ...rotation, key: "private" }, { ...rotation, expected_generation: -1 },
      { ...rotation, expected_generation: 2_147_483_647 }, { ...rotation, expected_version: 0 },
      { ...rotation, expected_generation: undefined }, { ...rotation, change: { type: "deploy" } },
      { ...rotation, change: { type: "rotate_key", key: "private" } },
      { ...rotation, change: { type: "update_endpoints", config: { ingress_node_id: 11, egress_node_id: 11, carrier_port: 25000 } } },
      { ...rotation, change: { type: "update_endpoints", config: { ingress_node_id: 11, egress_node_id: 12, carrier_port: 65536 } } },
    ]) expect(LinkMaintenancePreviewSchema.safeParse(raw).success).toBe(false);
  });
});
