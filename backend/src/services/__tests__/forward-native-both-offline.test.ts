import { beforeEach, expect, mock, test } from "bun:test";
import { fileURLToPath } from "node:url";

// No process-global mocks can contaminate unrelated suites, including shared FXP.
if (process.env.TUNEX_NATIVE_BOTH_OFFLINE !== "1") {
  test("isolated native both service/HTTP/DB/builders regression suite", () => {
    const child = Bun.spawnSync([process.execPath, "test", "--preload",
      fileURLToPath(new URL("./forward-native-both-offline-preload.ts", import.meta.url)), fileURLToPath(import.meta.url)],
      { env: { ...process.env, TUNEX_NATIVE_BOTH_OFFLINE: "1" }, stdout: "pipe", stderr: "pipe", timeout: 30000 });
    expect(child.exitCode, child.stdout.toString() + child.stderr.toString()).toBe(0);
  });
} else {
const { bothFixture: f, resetBothFixture } = await import("./forward-native-both-offline-preload.ts");
const { Hono } = await import("hono");
const { authRequired } = await import("../../middlewares/auth.ts");
const { signAccessToken } = await import("../../auth.ts");
const { forwardsRoutes } = await import("../../routes/forwards.ts");
const { createForward, forwardView, patchForward, previewForwardUpdate } = await import("../forward-service.ts");
const { desiredTunnelConfigFor, buildDesiredNodeSnapshot, OutboundAgentTransport } = await import("../agent-command-bus.ts");
const { Orchestrator } = await import("../orchestrator.ts");
const { capabilityFactsFromStoredV2 } = await import("../capability-manifest.ts");
const { createRuntimeReconcileSink } = await import("../runtime-reconcile-sink.ts");
const { FORWARD_NATIVE_BOTH_CAPABILITY: CAP } = await import("../forward-native-both.ts");
const app = new Hono(); app.use("*", authRequired); app.route("/api/forwards", forwardsRoutes);
const cookie = `access=${await signAccessToken({ userId: 1, email: "fixture@tunex.test", superAdmin: false })}`;
const input = { name: "composite", protocol: "both" as const, mode: "direct" as const, ingress_node_id: 11,
  listen_port: 23000, target_host: "127.0.0.1", target_port: 8080 };
beforeEach(() => { resetBothFixture(); process.env.FORWARD_NATIVE_BOTH_ENABLED = "true"; });
function seed(mode: "direct" | "relay" = "direct") {
  const row = { id: 71, workspace_id: 7, user_id: 1, category: "port_forward", name: "composite", forward_protocol: "both", tunnel_type: null,
    link_resource_id: null, tunnel_mode: mode, middle_node_id: null, federated_egress_peer: null,
    ingress_node_id: 11, egress_node_id: mode === "relay" ? 22 : null, in_node_group_id: 11, out_node_group_id: mode === "relay" ? 22 : null,
    listen_ip: "0.0.0.0", listen_port: 23000, remote_host: mode === "direct" ? "127.0.0.1" : null,
    remote_port: mode === "direct" ? 8080 : null, egress_port: mode === "relay" ? 23001 : null, egress_pool_id: mode === "relay" ? 91 : null,
    desired_status: "active", apply_status: "active", config_revision: 7, applied_revision: 7, desired_revision_id: 1,
    bytes_per_second_in: 100, bytes_per_second_out: 200, max_connections: 4, max_connections_per_ip: 2 };
  f.rows.push(row); if (mode === "relay") f.pools.push({ id: 91, name: "forward-71", node_id: 22, lb_strategy: "round", targets: [{ host: "127.0.0.1", port: 8080, weight: 1, order_by: 1 }] });
  return row;
}
test("real auth and workspace middleware protect discovery, default-off/exact true with no Forward/lease write", async () => {
  expect((await app.request("/api/forwards/capabilities")).status).toBe(401);
  expect((await app.request("/api/forwards/capabilities", { headers: { cookie, "x-workspace-id": "9" } })).status).toBe(404);
  for (const value of [undefined, "1", "TRUE", "true ", "true"]) {
    if (value === undefined) delete process.env.FORWARD_NATIVE_BOTH_ENABLED; else process.env.FORWARD_NATIVE_BOTH_ENABLED = value;
    const response = await app.request("/api/forwards/capabilities", { headers: { cookie } });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ data: { native_both_enabled: value === "true" } });
  }
  f.memberActive = false;
  expect((await app.request("/api/forwards/capabilities", { headers: { cookie } })).status).toBe(404);
  expect(f.writes).toHaveLength(0);
});
test("NEW both HTTP writes blocked by flag, and endpoint/source combinations fail closed before reservation", async () => {
  process.env.FORWARD_NATIVE_BOTH_ENABLED = "false";
  const response = await app.request("/api/forwards", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(input) });
  expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "feature_disabled" });
  expect(f.writes).toHaveLength(0);
  process.env.FORWARD_NATIVE_BOTH_ENABLED = "true";
  for (const extra of [{ mode: "relay", egress_node_id: 22, middle_node_id: 33 }, { mode: "relay", federated_egress_peer: "peer" },
    { tls_cert_path: "/cert", tls_key_path: "/key" }, { client_source: { preserve: false } }]) {
    const r = await app.request("/api/forwards", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ ...input, ...extra }) });
    expect(r.status).toBe(400); expect((await r.json() as any).code).toBe("invalid_input");
  }
  expect(f.writes).toHaveLength(0);
});
test("fresh native capability on both endpoints precedes all rows, pools and bindings; tcp+udp is not support", async () => {
  for (const missing of [11, 22]) {
    f.reports.get(missing).capabilities = ["apply_tunnel", "forward.protocol.both.v1"];
    const r = await createForward(1, 7, { ...input, mode: "relay", egress_node_id: 22 });
    expect(r).toMatchObject({ ok: false, status: 409, code: "protocol_not_supported", error_layer: "runtime_admission", data: { node_id: missing } });
    expect(f.writes).toHaveLength(0); resetBothFixture();
  }
  f.reports.get(22).node.credential_rotated_at = new Date(Date.now() + 1000);
  expect(await createForward(1, 7, { ...input, mode: "relay", egress_node_id: 22 })).toMatchObject({ ok: false });
  expect(f.writes).toHaveLength(0);
});

test("IP_HASH is refused before create reservation and cannot be restored or advertised as supported", async () => {
  f.egressStrategy = "ip_hash";
  expect(await createForward(1, 7, { ...input, mode: "relay", egress_node_id: 22 })).toMatchObject({
    ok: false, status: 400, code: "invalid_input", data: { reasons: ["native_both_ip_hash_unsupported"] } });
  expect(f.writes).toHaveLength(0);
  const row = seed("relay"); f.pools[0].lb_strategy = "IP_HASH";
  expect(forwardView({ ...row, egress_pool: f.pools[0] }).protocol_supported).toBe(false);
  for (const nodeId of [11, 22]) expect((await buildDesiredNodeSnapshot(nodeId)).tunnels).toHaveLength(0);
});

test("transition cannot discard stored source metadata just because candidate lacks a source field", async () => {
  const row = seed(); row.forward_protocol = "tcp"; (row as any).link_source_config = { version: 1, preserve: false };
  expect(await previewForwardUpdate(71, 7, { protocol: "both" })).toMatchObject({
    ok: false, status: 400, data: { reasons: ["native_both_source_unsupported"] } });
  expect(f.writes).toHaveLength(0);
});
test("both create consumes ONE rule with NULL projection; missing either entitlement never grants the other lane", async () => {
  for (const types of [["tcp"], ["udp"], ["both"], ["tcp", "both"]]) {
    f.types = types; expect(await createForward(1, 7, input)).toMatchObject({ ok: false, status: 403, code: "protocol_not_allowed" });
    expect(f.rows).toHaveLength(0);
  }
  f.types = ["tcp", "udp"];
  expect(await createForward(1, 7, input)).toMatchObject({ ok: true, data: { id: 71, protocol: "both" } });
  expect(f.rows).toHaveLength(1); expect(f.rows[0]).toMatchObject({ forward_protocol: "both", tunnel_type: null, listen_port: 23000 });
  const response = await app.request("/api/forwards/71", { headers: { cookie } });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ data: { id: 71, protocol: "both", transport: "mixed", config_revision: 0 } });
});
test("flag-off existing both metadata/preflight remain compatible; INTO both flag gate has zero mutations", async () => {
  const row = seed(); process.env.FORWARD_NATIVE_BOTH_ENABLED = "false";
  expect(await patchForward(71, 7, { name: "renamed", expected_revision: 7 })).toMatchObject({ ok: true, data: { protocol: "both", config_revision: 7 } });
  expect(f.snapshots).toHaveLength(0);
  expect((await previewForwardUpdate(71, 7, { target_port: 8081 })).ok).toBe(true);
  row.forward_protocol = "tcp"; f.writes = [];
  for (const result of [await previewForwardUpdate(71, 7, { protocol: "both" }), await patchForward(71, 7, { protocol: "both" })])
    expect(result).toMatchObject({ ok: false, status: 409, code: "feature_disabled" });
  expect(f.writes).toHaveLength(0);
});
test("protocol transition commits one revision/CAS with same rule and port; transaction failure leaves no partial snapshot", async () => {
  const row = seed(); row.forward_protocol = "tcp";
  const preview = await previewForwardUpdate(71, 7, { protocol: "both", expected_revision: 7 });
  expect(preview.ok).toBe(true); expect(f.writes).toHaveLength(0);
  // No real worker in this fixture: service must accurately say saved/not applied.
  expect(await patchForward(71, 7, { protocol: "both", expected_revision: 7 })).toMatchObject({ ok: false, status: 503, code: "apply_failed" });
  expect(f.rows).toHaveLength(1); expect(f.rows[0]).toMatchObject({ id: 71, listen_port: 23000, forward_protocol: "both", tunnel_type: null, config_revision: 8 });
  expect(f.snapshots).toHaveLength(1); expect(f.snapshots[0]).toMatchObject({ tunnel_id: 71, revision: 8, protocol: "both" });
  resetBothFixture(); const before = seed(); before.forward_protocol = "tcp"; f.failCommit = true;
  await patchForward(71, 7, { protocol: "both", expected_revision: 7 }).catch(() => {});
  expect(f.rows[0]).toMatchObject({ forward_protocol: "tcp", config_revision: 7 }); expect(f.snapshots).toHaveLength(0);
});

test("target edits preserve the bound scope instead of replacing it with the node connect address", async () => {
  for (const protocol of ["both", "tcp", "udp"] as const) {
    for (const mode of ["direct", "relay"] as const) {
      for (const host of ["0.0.0.0", "::", "127.0.0.1"]) {
        resetBothFixture(); const row = seed(mode);
        row.forward_protocol = protocol; row.listen_ip = host;
        const preview = await previewForwardUpdate(71, 7, { target_port: 8081, expected_revision: 7 });
        expect(preview.ok).toBe(true);
        // The fixture has no worker; persistence still follows the real service path.
        expect(await patchForward(71, 7, { target_port: 8081, expected_revision: 7 }))
          .toMatchObject({ ok: false, status: 503, code: "apply_failed" });
        expect(f.rows[0]).toMatchObject({ listen_ip: host, listen_port: 23000, config_revision: 8 });
        expect(f.snapshots[0]).toMatchObject({ listen_ip: host, listen_port: 23000, protocol });
      }
    }
  }
});
test("listing and metadata checks preserve unsupported both fact without claiming topology is supported", async () => {
  const row = seed(); row.middle_node_id = 33 as any;
  expect(forwardView(row)).toMatchObject({ protocol: "both", protocol_supported: false });
  expect(await patchForward(71, 7, { name: "hidden downgrade" })).toMatchObject({ ok: false, status: 400, data: { reasons: ["native_both_middle_unsupported"] } });
  expect(f.writes).toHaveLength(0);
  row.middle_node_id = null; (row as any).link_source_config = { version: 1, preserve: false };
  expect(await previewForwardUpdate(71, 7, { name: "source must not disappear" })).toMatchObject({ ok: false, status: 400,
    data: { reasons: ["native_both_source_unsupported"] } });
});
test("flag-off full desired snapshot restores BOTH on DIRECT/RELAY and hop_peer EGRESS with one ingress policy budget", async () => {
  process.env.FORWARD_NATIVE_BOTH_ENABLED = "false";
  for (const mode of ["direct", "relay"] as const) {
    resetBothFixture(); seed(mode);
    const ingress = await buildDesiredNodeSnapshot(11);
    expect(ingress.tunnels).toHaveLength(1); expect(ingress.tunnels[0]).toMatchObject({ protocol: "both", ingress_port: 23000,
      bytes_per_second_in: 100, bytes_per_second_out: 200, max_connections: 4, max_connections_per_ip: 2, policy_scope: "runtime" });
    if (mode === "relay") {
      const egress = await buildDesiredNodeSnapshot(22);
      expect(egress.tunnels).toHaveLength(1); expect(egress.tunnels[0]).toMatchObject({ protocol: "both", egress_port: 23001, hop_peer: "127.0.0.11" });
      expect(egress.tunnels[0]!.max_connections).toBeUndefined();
      f.reports.get(11).capabilities = ["apply_tunnel"];
      expect((await buildDesiredNodeSnapshot(22)).tunnels).toHaveLength(0);
    }
    f.types = ["tcp"]; expect((await buildDesiredNodeSnapshot(11)).skipped).toContainEqual({ id: 71, reason: "protocol_not_allowed" });
  }
});
test("actual orchestrator and desired builders send both, require hop_peer, and never attach EGRESS policy", async () => {
  seed("relay"); const configs: any[] = [];
  const transport = { applyDirect: async (_n:any,c:any) => { configs.push(c); return { ok: true, applied_revision: c.revision }; },
    applyRelay: async (_n:any,c:any) => { configs.push(c); return { ok: true, applied_revision: c.revision }; },
    applyEgress: async (_n:any,c:any) => { configs.push(c); return { ok: true, applied_revision: c.revision }; }, removeTunnel: async () => ({ ok: true }) } as any;
  const tcpHealth = [{ host: "127.0.0.1", port: 8080, state: "healthy", latency_ms: 1, age_ms: 1, evidence: true }];
  const orch = new Orchestrator({ transport, probeReachable: false, healthSource: async () => tcpHealth,
    loadForwardPolicy: async () => ({ requested: { bytes_per_second_in: 100, bytes_per_second_out: 200, max_connections: 4, max_connections_per_ip: 2 }, workspace: {} }) });
  const node = { id: 11, node_id: "in", connect_ip: "127.0.0.11", role: "both" as const };
  expect((await orch.dispatchDirect({ tunnelId: 71, revision: 7, ingressNode: node, ingressPort: 23000, remoteHost: "127.0.0.1", remotePort: 8080, protocol: "both" })).ok).toBe(true);
  expect((await orch.dispatchIngress({ tunnelId: 71, revision: 7, ingressNode: node, ingressPort: 23000, nextHop: "127.0.0.22:23001", protocol: "both" })).ok).toBe(true);
  const e = { tunnelId: 71, revision: 7, egressNode: node, egressPort: 23001, poolId: null, protocol: "both" as const, targets: [{ host: "127.0.0.1", port: 8080 }] };
  expect(await orch.dispatchEgress(e)).toMatchObject({ ok: false, error_code: "datagram_hop_peer_missing" });
  expect((await orch.dispatchEgress({ ...e, hopPeer: "127.0.0.11" })).ok).toBe(true);
  expect(configs.map((c) => c.protocol)).toEqual(["both", "both", "both"]);
  expect(configs[2].max_connections).toBeUndefined();
  expect(configs[2].target_health).toBeUndefined();
  expect(configs[0].max_connections).toBe(4); expect(configs[1].max_connections).toBe(4);
});

test("authenticated HTTP desired JSON retains native both EGRESS hop_peer, decoder-visible without filtering", async () => {
  process.env.FORWARD_NATIVE_BOTH_ENABLED = "false"; seed("relay");
  const credentials = await import("../node-credential.ts");
  const state = await import("../node-state.ts");
  mock.module(fileURLToPath(new URL("../node-credential.ts", import.meta.url)), () => ({ ...credentials,
    authenticateNode: async (credential: string) => credential === "fixture-egress" ? { ok: true, node_id: 22, scope: 7 } : { ok: false, reason: "invalid" } }));
  mock.module(fileURLToPath(new URL("../node-state.ts", import.meta.url)), () => ({ ...state, renewOwnedLeases: async () => [] }));
  const { internalNodeRoutes } = await import("../../routes/internal-node.ts");
  const internal = new Hono(); internal.route("/api/internal", internalNodeRoutes);
  expect((await internal.request("/api/internal/node/desired")).status).toBe(401);
  const response = await internal.request("/api/internal/node/desired", { headers: { authorization: "Bearer fixture-egress" } });
  expect(response.status).toBe(200);
  const json = await response.json() as any;
  expect(json.data.snapshot.tunnels).toHaveLength(1);
  expect(json.data.snapshot.tunnels[0]).toMatchObject({ id: "tunex-71-egress", protocol: "both", egress_port: 23001, hop_peer: "127.0.0.11", revision: 7 });
});
test("flag-off reconcile resends both at the same revision only after both participants pass fresh admission", async () => {
  process.env.FORWARD_NATIVE_BOTH_ENABLED = "false"; seed("relay");
  const row = (await import("../../db.ts")).db.tunnel.findUnique({ where: { id: 71 } });
  const tunnel = await row; const sent: any[] = []; let applied = 0;
  const ok = { ok: true, result: { revision: 7, commandId: "offline", ack: {} }, egress_host: "127.0.0.22" };
  const sink = createRuntimeReconcileSink({ ledger: { loadTunnel: async () => tunnel as any, markApplied: async () => { applied++; } } as any,
    orchestrator: () => ({ dispatchEgress: async (c:any) => { sent.push(c); return ok; }, dispatchIngress: async (c:any) => { sent.push(c); return ok; } } as any),
    runtimeUse: async () => null, loadCapabilityFacts: async (id) => capabilityFactsFromStoredV2(f.reports.get(id)) });
  await sink.resendSameRevision({ tunnel_id: 71, revision: 7, envelope: null });
  expect(sent.map((c) => c.protocol)).toEqual(["both", "both"]); expect(sent[0].hopPeer).toBe("127.0.0.11"); expect(applied).toBe(1);
  sent.length = 0; f.reports.get(11).capabilities = ["apply_tunnel"];
  await expect(sink.resendSameRevision({ tunnel_id: 71, revision: 7, envelope: null })).rejects.toThrow("runtime_admission");
  expect(sent).toHaveLength(0); expect(applied).toBe(1);
});
}
