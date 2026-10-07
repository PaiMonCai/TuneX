import { beforeEach, expect, test } from "bun:test";
import { policyFixture as state } from "./forward-policy-offline-preload.ts";
import { OutboundAgentTransport, buildDesiredNodeSnapshot, desiredTunnelConfigFor, type CommandBusStore, type DesiredRowProjection } from "../agent-command-bus.ts";
import { Orchestrator, type AgentTunnelConfig, type AgentTransport } from "../orchestrator.ts";
import { loadForwardPolicyForDispatch } from "../relay-wiring.ts";
import { FORWARD_POLICY_CAPABILITY } from "../forward-policy.ts";
import { createCommand } from "../control-protocol/index.ts";
import { getEffectivePolicy } from "../policy-service.ts";
import type { AgentV2CapabilityFacts } from "../capability-manifest.ts";

const node = { id: 11, node_id: "fixture", connect_ip: "127.0.0.1", role: "both" as const };
const facts: AgentV2CapabilityFacts = { protocolVersion: 2, capabilities: ["apply_tunnel", FORWARD_POLICY_CAPABILITY],
  capabilitiesMalformed: false, manifestMalformed: false, manifest: { schema_version: 2, protocols: ["tcp", "udp"], transports: ["stream", "datagram"], runtime: [], diagnostics: [] } };
const row: DesiredRowProjection = { id: 71, workspace_id: 7, tunnel_mode: "direct", config_revision: 3, desired_status: "active",
  forward_protocol: "tcp", ingress_node_id: 11, egress_node_id: null, listen_port: 23000, listen_ip: null,
  remote_host: "business.example", remote_port: 8080, egress_port: null, bytes_per_second_in: 2_000_000,
  bytes_per_second_out: 0, max_connections: 20, max_connections_per_ip: 2 };
function queuedTransport(advertisement: AgentV2CapabilityFacts | null) {
  const queued: any[] = [], ledger = new Map<string, string>();
  let ack: string | null = null, writes = 0;
  const store: CommandBusStore = {
    get: async (key) => ledger.get(key) ?? ack, del: async (key) => ledger.delete(key),
    set: async (key, value) => { writes++; ledger.set(key, value); },
    setIfAbsent: async (key, value) => { ledger.set(key, value); return "OK"; },
    shift: async () => null,
    push: async (_key, value) => { const item = JSON.parse(value); queued.push(item);
      ack = JSON.stringify({ command_id: item.envelope.command_id, ok: true, applied_revision: item.envelope.revision }); },
  };
  return { transport: new OutboundAgentTransport(async () => advertisement, store), queued, writes: () => writes };
}
const config: AgentTunnelConfig = { id: "tunex-71-direct", mode: "DIRECT", ingress_port: 23000, egress_port: 0,
  remote_host: "business.example", remote_port: 8080, next_hop: "", targets: [], lb_strategy: "ROUND_ROBIN", protocol: "tcp", speed_limit: 0, revision: 3 };
function commandFor(c: AgentTunnelConfig) {
  return createCommand({ resource: "tunnel", resource_id: c.id, revision: c.revision, action: "apply_tunnel",
    payload: { tunnel: { name: c.id, listen_port: c.ingress_port, tunnel_type: c.protocol,
      targets: [{ address: c.remote_host, port: c.remote_port }] } } });
}
beforeEach(() => {
  state.rows = [{ ...row }]; state.snapshot = null; state.report = { control_protocol_version: 2,
    capabilities: facts.capabilities, capability_manifest: facts.manifest, reported_at: new Date(), node: { credential_rotated_at: null } };
  state.limits = { bandwidth_limit: null, client_limit: null }; state.policyReads = 0; state.reads = []; state.mutations = 0;
});
test("actual outgoing transport rejects nonzero policies on old agents before any queue write", async () => {
  for (const key of ["bytes_per_second_in", "bytes_per_second_out", "max_connections", "max_connections_per_ip", "speed_limit"]) {
    const f = queuedTransport(null);
    const c = { ...config, [key]: 1 };
    const command = commandFor(c);
    await expect(f.transport.applyDirect(node, c, command)).rejects.toThrow(FORWARD_POLICY_CAPABILITY);
    expect(f.writes()).toBe(0); expect(f.queued).toHaveLength(0);
  }
  const zero = queuedTransport(null);
  expect(await zero.transport.applyDirect(node, config, commandFor(config))).toMatchObject({ ok: true });
  expect(zero.queued).toHaveLength(1);
});
test("production policy loader plus real orchestrator and command queue preserve requested revision and fresh ceilings", async () => {
  state.snapshot = { bytes_per_second_in: 2_000_000, bytes_per_second_out: 250_000, max_connections: 20, max_connections_per_ip: 2 };
  state.limits = { bandwidth_limit: 8, client_limit: 3 };
  // Deliberately prime the effective-policy cache, then change the entitlement.
  await getEffectivePolicy(7); state.limits.bandwidth_limit = 16; state.limits.client_limit = 5;
  const f = queuedTransport(facts);
  const orchestrator = new Orchestrator({ transport: f.transport, probeReachable: false, loadForwardPolicy: loadForwardPolicyForDispatch });
  expect((await orchestrator.dispatchDirect({ tunnelId: 71, revision: 3, ingressNode: node, ingressPort: 23000,
    remoteHost: "business.example", remotePort: 8080 })).ok).toBe(true);
  expect(f.queued[0].config).toMatchObject({ bytes_per_second_in: 2_000_000, bytes_per_second_out: 250_000,
    max_connections: 5, max_connections_per_ip: 2, policy_scope: "runtime", speed_limit: 0 });
  // The runtime config travels as the command's sibling, matching Agent decoding.
  expect(f.queued[0].config.revision).toBe(f.queued[0].envelope.revision);
  expect(f.queued[0].envelope.payload.tunnel.listen_port).toBe(f.queued[0].config.ingress_port);
  expect(state.snapshot.max_connections).toBe(20);
  expect(state.policyReads).toBe(2);
});
test("full desired snapshot uses fresh ceilings and advertisements, including UDP native restore", async () => {
  for (const protocol of ["tcp", "udp"] as const) {
    state.rows = [{ ...row, forward_protocol: protocol }]; state.limits = { bandwidth_limit: 8, client_limit: 3 };
    let snapshot = await buildDesiredNodeSnapshot(11);
    expect(snapshot.tunnels[0]).toMatchObject({ protocol, bytes_per_second_in: 1_000_000, bytes_per_second_out: 1_000_000,
      max_connections: 3, max_connections_per_ip: 2, policy_scope: "runtime" });
    state.limits = { bandwidth_limit: 32, client_limit: 30 };
    snapshot = await buildDesiredNodeSnapshot(11);
    expect(snapshot.tunnels[0]).toMatchObject({ bytes_per_second_in: 2_000_000, bytes_per_second_out: 4_000_000, max_connections: 20 });
    state.report.capabilities = ["apply_tunnel"];
    snapshot = await buildDesiredNodeSnapshot(11);
    expect(snapshot.tunnels).toHaveLength(0);
    expect(snapshot.skipped).toContainEqual({ id: 71, reason: "forward_policy_upgrade_required" });
    state.report.capabilities = facts.capabilities;
  }
});
test("zero request still gates an old agent when a workspace ceiling is finite; stale advertisement does not restore", async () => {
  state.rows = [{ ...row, bytes_per_second_in: 0, max_connections: 0, max_connections_per_ip: 0 }];
  state.report.capabilities = ["apply_tunnel"]; state.limits.client_limit = 1;
  expect((await buildDesiredNodeSnapshot(11)).skipped).toContainEqual({ id: 71, reason: "forward_policy_upgrade_required" });
  state.report.capabilities = facts.capabilities; state.report.node.credential_rotated_at = new Date(Date.now() + 1000);
  expect((await buildDesiredNodeSnapshot(11)).tunnels).toHaveLength(0);
  state.limits.client_limit = null;
  expect((await buildDesiredNodeSnapshot(11)).tunnels).toHaveLength(1);
});
test("snapshot authority survives a synthetic rollback generation and desired restore matches command policy", async () => {
  state.rows[0].config_revision = 4;
  state.snapshot = { tunnel_id: 71, revision: 4, bytes_per_second_in: 500_000, bytes_per_second_out: 250_000,
    max_connections: 2, max_connections_per_ip: 1 };
  state.limits = { bandwidth_limit: 8, client_limit: 3 };
  const restored = await buildDesiredNodeSnapshot(11);
  expect(restored.tunnels[0]).toMatchObject({ revision: 4, bytes_per_second_in: 500_000,
    bytes_per_second_out: 250_000, max_connections: 2, max_connections_per_ip: 1 });
  const source = await loadForwardPolicyForDispatch(71, 4);
  expect(source.requested).toMatchObject({ bytes_per_second_in: 500_000, max_connections: 2 });
  expect(state.rows[0].max_connections).toBe(20);
});
test("only business ingress gets policy: relay ingress enforces, middle and exit omit all four fields", async () => {
  const relay: DesiredRowProjection = { ...row, tunnel_mode: "relay", egress_node_id: 22, middle_node_id: 33,
    egress_port: 23001, egress_node: { connect_ip: "127.0.0.2" }, middle_node: { connect_ip: "127.0.0.3" },
    egress_pool: { lb_strategy: "ROUND_ROBIN", targets: [{ host: "business.example", port: 8080, weight: 1, order_by: 1 }] },
    port_leases: [{ node_id: 33, port: 23002, status: "active" }] };
  for (const id of [11, 22, 33]) {
    const outcome = desiredTunnelConfigFor(relay, id, new Map(), facts, { client_limit: 1 });
    expect(outcome.kind).toBe("config");
    if (outcome.kind !== "config") throw new Error("missing fixture config");
    expect(outcome.config.max_connections).toBe(id === 11 ? 1 : undefined);
    expect(outcome.config.max_connections_per_ip).toBe(id === 11 ? 2 : undefined);
  }
  const configs: AgentTunnelConfig[] = [];
  const unused = async (): Promise<never> => { throw new Error("unused transport"); };
  const transport: AgentTransport = { applyRelay: async (_n, c) => { configs.push(c); return { ok: true, applied_revision: c.revision }; },
    applyDirect: unused, applyEgress: async (_n, c) => { configs.push(c); return { ok: true, applied_revision: c.revision }; }, removeTunnel: unused };
  const orchestrator = new Orchestrator({ transport, probeReachable: false, loadForwardPolicy: loadForwardPolicyForDispatch, healthSource: async () => [] });
  expect((await orchestrator.dispatchIngress({ tunnelId: 71, revision: 3, ingressNode: node, ingressPort: 23000, nextHop: "127.0.0.2:23001" })).ok).toBe(true);
  expect(configs[0]!.max_connections).toBe(20);
  expect((await orchestrator.dispatchEgress({ tunnelId: 71, revision: 3, egressNode: node, egressPort: 23001, poolId: null,
    targets: [{ host: "business.example", port: 8080 }] })).ok).toBe(true);
  expect(configs[1]!.max_connections).toBeUndefined();
});
