/** Offline real Hono + workspace RBAC + Forward service; global mocks stay in a child. */
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("batch deletion isolates scope/RBAC/runtime failures and reuses single-delete cleanup", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const scenario = String.raw`
    import { mock } from "bun:test";
    import assert from "node:assert/strict";
    import { Hono } from "hono";
    const root = process.env.BATCH_DELETE_TEST_ROOT;
    process.env.AUTH_SECRET = "offline-batch-delete-fixture-only";
    process.env.DATABASE_URL = "mysql://unused:unused@127.0.0.1:1/unused";
    delete process.env.FORWARD_BATCH_DELETE_ENABLED;
    mock.module("ioredis", () => ({ default: class { on() { return this; } } }));
    let role = "owner", grants = null;
    let rows = [], calls = [], pools = [], releases = [];
    const seed = () => {
      rows = [1,2,3,4,5,6].map(id => ({ id, workspace_id: 77, category: "port_forward", user_id: id === 2 ? 8 : 7,
        tunnel_mode: "relay", egress_pool: { id: 100 + id, name: id === 6 ? "shared-pool" : "forward-" + id } }));
      rows.push({ id: 99, workspace_id: 88, category: "port_forward", user_id: 7 });
      rows.push({ id: 98, workspace_id: 77, category: "other", user_id: 7 });
      calls = []; pools = []; releases = [];
    };
    seed();
    mock.module(root + "db.ts", () => ({ db: {
      workspace: { findUnique: async () => ({ id: 1 }) },
      workspaceMember: { findUnique: async () => ({ active: true, role, workspace: { kind: "team" },
        role_id: grants ? 44 : null, custom_role: grants ? { id: 44, workspace_id: 77, permissions: grants } : null }) },
      tunnel: { findFirst: async ({where}) => {
        if (where.id === 4) throw Error("private database connection string");
        return rows.find(r => r.id === where.id && r.workspace_id === where.workspace_id && r.category === where.category) ?? null;
      } },
      egressPool: { delete: async ({where}) => { pools.push(where.id); } },
    } }));
    mock.module(root + "services/relay-wiring.ts", () => ({ getOrchestrator: () => ({}) }));
    mock.module(root + "services/tunnel-api.ts", () => ({
      TUNNEL_API_ERROR_STATUS: { not_found: 404, apply_failed: 409 },
      runTunnelAction: async (id, action, ws) => {
        calls.push({ id, action, ws });
        await new Promise(resolve => setTimeout(resolve, 1));
        if (id === 3) return { ok: false, code: "apply_failed", message: "teardown unconfirmed", apply_error_code: "runtime_teardown_unconfirmed", error_layer: "runtime_admission" };
        if (action !== "delete") throw Error("delete must not enter reversible action path");
        rows = rows.filter(r => r.id !== id);
        return { ok: true };
      },
    }));
    const realHop = await import(root + "services/federation/forward-hop.ts");
    mock.module(root + "services/federation/forward-hop.ts", () => ({
      ...realHop,
      validateFederatedEgressDeclaration: async () => ({ ok: true }),
      releaseStaleFederatedEgressForTunnel: async (id, revision) => {
        releases.push({ id, revision });
        return id === 6
          ? { evaluated: 1, released: 0, failed: [{ intent_id: "remote-6", code: "peer_unreachable", message: "fixture" }] }
          : { evaluated: 0, released: 0, failed: [] };
      },
    }));
    const { forwardsRoutes } = await import(root + "routes/forwards.ts");
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("user", { id: 7, email: "fixture@example.invalid" }); await next(); });
    app.route("/api/forwards", forwardsRoutes);
    const request = (body, path = "/api/forwards/batch", method = "POST") => app.request(path, {
      method, headers: { "content-type": "application/json", "x-workspace-id": "77" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let res = await request(undefined, "/api/forwards/batch/capabilities", "GET");
    assert.equal((await res.json()).data.delete_enabled, false);
    res = await request({ action: "delete", ids: [1] });
    assert.equal(res.status, 400); assert.equal(calls.length, 0);
    res = await request({ action: "delete", ids: [1], confirm_delete: true });
    assert.equal(res.status, 409); assert.equal((await res.json()).code, "feature_disabled");
    process.env.FORWARD_BATCH_DELETE_ENABLED = "true";
    res = await request(undefined, "/api/forwards/batch/capabilities", "GET");
    assert.equal((await res.json()).data.delete_enabled, true);
    role = "admin"; grants = { "forward:read": true, "forward:update": true, "forward:delete": false };
    res = await request({ action: "delete", ids: [1], confirm_delete: true });
    assert.equal(res.status, 403); assert.equal(calls.length, 0);
    // Delete-only custom grant works; update permission must not be required.
    grants = { "forward:read": true, "forward:delete": true, "forward:update": false };
    res = await request({ action: "delete", ids: [1], confirm_delete: true });
    assert.equal(res.status, 200); assert.equal((await res.json()).data.succeeded, 1);
    seed(); role = "member"; grants = null;
    res = await request({ action: "delete", ids: [1,2,99,98,3,4,5,6,1], confirm_delete: true });
    assert.equal(res.status, 200);
    const data = (await res.json()).data;
    assert.deepEqual({ requested: data.requested, succeeded: data.succeeded, failed: data.failed }, { requested: 8, succeeded: 3, failed: 5 });
    assert.deepEqual(data.results.map(r => [r.id, r.ok, r.code ?? null]), [
      [1,true,null], [2,false,"forbidden"], [99,false,"not_found"], [98,false,"not_found"],
      [3,false,"apply_failed"], [4,false,"internal_error"], [5,true,null], [6,true,null],
    ]);
    assert.equal(data.results.find(r => r.id === 6).reconciliation_pending, true);
    assert.equal(data.results.find(r => r.id === 6).warning_code, "federation_release_pending");
    assert.match(data.results.find(r => r.id === 6).warning_message, /远端出口/);
    assert.equal(data.results[1].error_layer, "rbac");
    assert.equal(data.results[2].error_layer, "resource_scope");
    assert.equal(data.results[4].error_layer, "runtime_admission");
    assert.equal(data.results[4].apply_error_code, "runtime_teardown_unconfirmed");
    assert.equal(JSON.stringify(data).includes("private database"), false);
    assert.deepEqual(calls, [1,3,5,6].map(id => ({ id, action: "delete", ws: 77 })));
    assert.deepEqual(pools, [101,105]); // Never delete a shared pool or a failed rule's pool.
    assert.deepEqual(releases, [1,5,6].map(id => ({ id, revision: -1 })));
    assert.deepEqual(rows.map(r => r.id), [2,3,4,99,98]);
    res = await request({ action: "delete", ids: [1], confirm_delete: true });
    assert.equal((await res.json()).data.results[0].code, "not_found");
    // No accidental expansion of the legacy single POST action whitelist.
    res = await request({}, "/api/forwards/5/delete");
    assert.equal(res.status, 400);
    console.log("batch-delete-lifecycle-ok");
  `;
  const child = Bun.spawnSync([process.execPath, "--eval", scenario], {
    env: { ...process.env, BATCH_DELETE_TEST_ROOT: root }, stdout: "pipe", stderr: "pipe",
  });
  expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
  expect(new TextDecoder().decode(child.stdout)).toContain("batch-delete-lifecycle-ok");
}, 15000);
