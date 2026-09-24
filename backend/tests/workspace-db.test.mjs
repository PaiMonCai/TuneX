import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

if (process.env.TUNEX_DB_TEST !== "1") {
  test("workspace MySQL integration (requires TUNEX_DB_TEST=1)", { skip: true }, () => {});
} else {
  process.env.AUTH_SECRET ??= "test-only-auth-secret-must-not-be-used-in-production";
  process.env.LICENSE_SECRET ??= "test-only-license-secret-must-not-be-used-in-production";
  process.env.PAYMENTS_ENABLED = "false";
  process.env.ALLOW_REGISTER_FALLBACK = "true";
  const { app } = await import("../src/app.ts");
  const { db } = await import("../src/db.ts");
  const { redis } = await import("../src/redis.ts");
  after(async () => { redis.disconnect(); await db.$disconnect(); });
  const nonce = randomUUID().slice(0, 12);
  const aEmail = `workspace-a-${nonce}@example.test`;
  const bEmail = `workspace-b-${nonce}@example.test`;
  const password = "ci-only-password-12";
  const ids = [];

  async function request(path, method, cookie, body, workspaceId) {
    return app.request(`http://localhost${path}`, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(workspaceId ? { "x-workspace-id": String(workspaceId) } : {}), ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  async function register(email) {
    const response = await request("/api/auth/register", "POST", "", { email, password });
    const result = await response.json();
    assert.equal(response.status, 201, JSON.stringify(result));
    const id = result.data.id;
    const apiKey = result.data.api_key;
    ids.push(id);
    const login = await request("/api/auth/login", "POST", "", { email, password });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie?.startsWith("access="));
    return { id, cookie, apiKey };
  }

  test("personal workspaces, two-user isolation, team invitation and revocation", async () => {
    let teamId;
    try {
      const a = await register(aEmail);
      const b = await register(bEmail);
      const aPersonal = await db.workspace.findUniqueOrThrow({ where: { personal_user_id: a.id } });
      const bPersonal = await db.workspace.findUniqueOrThrow({ where: { personal_user_id: b.id } });
      assert.notEqual(aPersonal.id, bPersonal.id);
      assert.equal((await db.workspaceMember.findUniqueOrThrow({ where: { workspace_id_user_id: { workspace_id: aPersonal.id, user_id: a.id } } })).role, "owner");
      assert.equal((await request(`/api/workspaces/${aPersonal.id}`, "GET", b.cookie)).status, 404);
      const create = await request("/api/workspaces", "POST", a.cookie, { name: `Team ${nonce}` });
      assert.equal(create.status, 201);
      teamId = (await create.json()).data.id;
      const createdGroup = await request("/api/node-groups", "POST", a.cookie, { name: "Team ingress", node_type: "in" }, teamId);
      assert.equal(createdGroup.status, 201);
      const groupData = (await createdGroup.json()).data;
      assert.equal(groupData.workspace_id, teamId);
      assert.ok(groupData.token);
      const ownTunnel = await request("/api/tunnels", "POST", a.cookie, { name: "Team TCP", tunnel_type: "tcp", in_node_group_id: groupData.id, forward_addresses: ["127.0.0.1:8080"] }, teamId);
      const tunnelPayload = await ownTunnel.json();
      assert.equal(ownTunnel.status, 200, JSON.stringify(tunnelPayload));
      const tunnelId = tunnelPayload.data.id;
      const personalTunnelList = await request("/api/tunnels", "GET", a.cookie);
      assert.equal((await personalTunnelList.json()).data.total, 0);
      const personalGroups = await request("/api/node-groups", "GET", a.cookie);
      assert.equal((await personalGroups.json()).data.total, 0);
      assert.equal((await request(`/api/workspaces/${teamId}`, "GET", b.cookie)).status, 404);
      const invited = await request(`/api/workspaces/${teamId}/invites`, "POST", a.cookie, { email: bEmail, role: "viewer" });
      assert.equal(invited.status, 201);
      const { token } = (await invited.json()).data;
      const tokenHash = createHash("sha256").update(token).digest("hex");
      const record = await db.workspaceInvite.findUniqueOrThrow({ where: { token_hash: tokenHash } });
      assert.notEqual(record.token_hash, token);
      const accepted = await request("/api/workspaces/invites/accept", "POST", b.cookie, { token });
      assert.equal(accepted.status, 200);
      assert.equal((await request("/api/workspaces/invites/accept", "POST", b.cookie, { token })).status, 404);
      const bTeam = await request(`/api/workspaces/${teamId}`, "GET", b.cookie);
      assert.equal((await bTeam.json()).data.role, "viewer");
      const teamGroupList = await request("/api/node-groups", "GET", b.cookie, undefined, teamId);
      const groups = (await teamGroupList.json()).data.data;
      assert.equal(groups.length, 1);
      assert.equal(groups[0].id, groupData.id);
      assert.equal("token" in groups[0], false);
      const teamTunnelList = await request("/api/tunnels", "GET", b.cookie, undefined, teamId);
      assert.equal((await teamTunnelList.json()).data.total, 1);
      assert.equal((await request(`/api/tunnels/${tunnelId}`, "GET", b.cookie, undefined, teamId)).status, 200);
      assert.equal((await request(`/api/tunnels/${tunnelId}`, "PATCH", b.cookie, { name: "Forbidden" }, teamId)).status, 403);
      assert.equal((await request("/api/node-groups", "POST", b.cookie, { name: "Forbidden", node_type: "in" }, teamId)).status, 403);
      const bearer = await app.request("http://localhost/api/tunnels", { headers: { authorization: `Bearer ${b.apiKey}`, "x-workspace-id": String(teamId) } });
      assert.equal(bearer.status, 403);
      assert.equal((await request(`/api/workspaces/${teamId}/invites`, "POST", b.cookie, { email: aEmail })).status, 403);
      const removed = await request(`/api/workspaces/${teamId}/members/${b.id}`, "DELETE", a.cookie);
      assert.equal(removed.status, 200);
      assert.equal((await request(`/api/workspaces/${teamId}`, "GET", b.cookie)).status, 404);
      assert.equal((await request("/api/tunnels", "GET", b.cookie, undefined, teamId)).status, 404);
      assert.ok((await db.auditEvent.count({ where: { workspace_id: teamId } })) >= 3);
    } finally {
      if (teamId) {
        await db.tunnel.deleteMany({ where: { workspace_id: teamId } });
        await db.nodeGroup.deleteMany({ where: { workspace_id: teamId } });
        await db.workspace.deleteMany({ where: { id: teamId } });
      }
      if (ids.length) {
        await db.workspace.deleteMany({ where: { personal_user_id: { in: ids } } });
        await db.userCredential.deleteMany({ where: { user_id: { in: ids } } });
        await db.user.deleteMany({ where: { id: { in: ids } } });
      }
    }
  });
}
