import { test, after } from "node:test";
import assert from "node:assert/strict";

// No real DB/Redis or payment gateway is needed: the kill switch runs first.
process.env.DATABASE_URL = "mysql://root:test@127.0.0.1:3306/tunex_test";
process.env.REDIS_URL = "redis://127.0.0.1:6379";
process.env.AUTH_SECRET = "test-only-not-a-real-session-secret-32-bytes";
process.env.LICENSE_SECRET = "test-only-not-a-real-license-secret-32-bytes";
process.env.TUNEX_CONFIG_KEY = Buffer.alloc(32, 5).toString("base64url");
process.env.TUNEX_LICENSE_KEY = Buffer.alloc(32, 6).toString("base64url");
process.env.PAYMENTS_ENABLED = "false";

const { app } = await import("../src/app.ts");
const { redis } = await import("../src/redis.ts");
const { db } = await import("../src/db.ts");
after(async () => { redis.disconnect(); await db.$disconnect(); });

test("HTTP payment kill switch denies every write and forged GET/POST callbacks", async () => {
  for (const [path, method] of [
    ["/api/pay/create", "POST"], ["/api/topups", "POST"],
    ["/api/plans/purchase", "POST"], ["/api/pay/1/callback", "GET"],
    ["/api/pay/1/callback", "POST"], ["/api/admin/payments", "POST"],
  ]) {
    const res = await app.request(`http://localhost${path}`, { method });
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.deepEqual(await res.json(), { error: "支付功能未启用" });
  }
});

test("HTTP health and non-payment endpoints are not blocked by billing policy", async () => {
  const health = await app.request("http://localhost/healthz");
  assert.equal(health.status, 200);
  assert.equal((await health.json()).service, "tunex-backend");
  const tunnels = await app.request("http://localhost/api/tunnels", { method: "POST" });
  assert.equal(tunnels.status, 401);
});

test("config admission: no plan is needed for owned groups; any unauthorized hop denies the tunnel", async () => {
  const { filterAvailableTunnels } = await import("../src/socket/config-generator.ts");
  const own = { id: 4, user_id: 12, node_type: "in" };
  const shared = { id: 9, user_id: 88, node_type: "out" };
  const tunnel = {
    id: 1, user_id: 12, in_node_group_id: 4, in_node_group: own,
    out_node_group_id: null, user: { id: 12, user_plan: null, node_group_grants: [] },
    tunnel_chains: [],
  };
  assert.equal(filterAvailableTunnels([tunnel], 4).length, 1);
  assert.equal(filterAvailableTunnels([{ ...tunnel, in_node_group: { id: 4 } }], 4).length, 0);
  const withHop = { ...tunnel, tunnel_chains: [{ id: 5, node_group_id: 9, node_type: "out", node_group: shared }] };
  assert.equal(filterAvailableTunnels([withHop], 4).length, 0);
  const granted = { ...withHop, user: { ...tunnel.user, node_group_grants: [{ node_group_id: 9, direction: "out", active: true }] } };
  assert.equal(filterAvailableTunnels([granted], 4).length, 1);
  assert.equal(filterAvailableTunnels([{ ...granted, user: { ...granted.user, node_group_grants: [{ node_group_id: 9, direction: "out", active: false }] } }], 4).length, 0);
});
