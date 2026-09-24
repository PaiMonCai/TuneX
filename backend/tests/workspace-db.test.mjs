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

  let requestSeq = 0;
  async function request(path, method, cookie, body, workspaceId) {
    return app.request(`http://localhost${path}`, {
      method,
      headers: { "x-forwarded-for": `203.0.113.${++requestSeq}`, ...(cookie ? { cookie, "x-csrf-token": "test" } : {}), ...(workspaceId ? { "x-workspace-id": String(workspaceId) } : {}), ...(body ? { "content-type": "application/json" } : {}) },
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

  // 显式放宽超时：本用例串起 2 次注册（每次注册含 user + credential + workspace +
  // member + 免费策略发放 + 验证邮件 token）、建团、建组、建隧道与邀请全流程。
  // 策略发放为同事务内的额外查询；CI 的 node --test 每文件单进程隔离，本地
  // bun test 多文件共享进程，默认 5s 在累积执行下会偶发触顶。
  test(
    "personal workspaces, two-user isolation, team invitation and revocation",
    { timeout: 30_000 },
    async () => {
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
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      await db.tunnelTraffic.create({ data: { tunnel_id: tunnelId, traffic: 8192, traffic_cost: 0, date: today } });
      await db.node.create({ data: { node_group_id: groupData.id, node_id: `ci-${nonce}`, connect_ip: "127.0.0.1", status: "active" } });
      const personalGroup = await request("/api/node-groups", "POST", a.cookie, { name: "Personal ingress", node_type: "in" });
      assert.equal(personalGroup.status, 201);
      const personalTunnel = await request("/api/tunnels", "POST", a.cookie, { name: "Personal TCP", tunnel_type: "tcp", in_node_group_id: (await personalGroup.json()).data.id, forward_addresses: ["127.0.0.1:8081"] });
      assert.equal(personalTunnel.status, 200, JSON.stringify(await personalTunnel.clone().json()));
      const personalTunnelId = (await personalTunnel.json()).data.id;
      const subscriptionKey = (await db.user.findUniqueOrThrow({ where: { id: a.id }, select: { subscription_key: true } })).subscription_key;
      const legacySubscription = await request(`/api/tunnel/subscription?token=${subscriptionKey}`, "GET", "", undefined, teamId);
      assert.equal(legacySubscription.status, 200);
      assert.deepEqual((await legacySubscription.json()).data.tunnels.map((t) => t.id), [personalTunnelId], "account subscription must never include team tunnels");
      assert.equal((await request("/api/tunnel/subscription?token=invalid", "GET", "")).status, 401);
      const personalStats = (await (await request("/api/dashboard/stats", "GET", a.cookie)).json()).data;
      const teamStats = (await (await request("/api/dashboard/stats", "GET", a.cookie, undefined, teamId)).json()).data;
      assert.equal(personalStats.tunnel_count, 1);
      assert.equal(personalStats.total_nodes, 0);
      assert.equal(personalStats.today_traffic, 0);
      assert.equal(teamStats.tunnel_count, 1);
      assert.equal(teamStats.active_nodes, 1);
      assert.equal(teamStats.today_traffic, 8192);
      assert.equal(teamStats.month_traffic, 8192);
      const personalTraffic = (await (await request("/api/dashboard/traffic", "GET", a.cookie)).json()).data;
      const teamTraffic = (await (await request("/api/dashboard/traffic", "GET", a.cookie, undefined, teamId)).json()).data;
      assert.equal(personalTraffic.reduce((sum, row) => sum + row.traffic, 0), 0);
      assert.equal(teamTraffic.reduce((sum, row) => sum + row.traffic, 0), 8192);
      assert.equal((await request("/api/dashboard/stats", "GET", b.cookie, undefined, teamId)).status, 404);
      const personalTunnelList = await request("/api/tunnels", "GET", a.cookie);
      assert.equal((await personalTunnelList.json()).data.total, 1);
      const personalGroups = await request("/api/node-groups", "GET", a.cookie);
      assert.equal((await personalGroups.json()).data.total, 1);
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
      assert.equal((await (await request("/api/dashboard/stats", "GET", b.cookie, undefined, teamId)).json()).data.today_traffic, 8192);
      assert.equal((await request(`/api/tunnels/${tunnelId}`, "PATCH", b.cookie, { name: "Forbidden" }, teamId)).status, 403);
      assert.equal((await request("/api/node-groups", "POST", b.cookie, { name: "Forbidden", node_type: "in" }, teamId)).status, 403);
      const bearer = await app.request("http://localhost/api/tunnels", { headers: { authorization: `Bearer ${b.apiKey}`, "x-workspace-id": String(teamId) } });
      assert.equal(bearer.status, 403);
      assert.equal((await request(`/api/workspaces/${teamId}/invites`, "POST", b.cookie, { email: aEmail })).status, 403);
      const removed = await request(`/api/workspaces/${teamId}/members/${b.id}`, "DELETE", a.cookie);
      assert.equal(removed.status, 200);
      assert.equal((await request(`/api/workspaces/${teamId}`, "GET", b.cookie)).status, 404);
      assert.equal((await request("/api/tunnels", "GET", b.cookie, undefined, teamId)).status, 404);
      assert.equal((await request("/api/dashboard/stats", "GET", b.cookie, undefined, teamId)).status, 404);
      assert.ok((await db.auditEvent.count({ where: { workspace_id: teamId } })) >= 3);
    } finally {
      if (teamId) {
        await db.tunnelTraffic.deleteMany({ where: { tunnel: { workspace_id: teamId } } });
        await db.tunnel.deleteMany({ where: { workspace_id: teamId } });
        await db.node.deleteMany({ where: { node_group: { workspace_id: teamId } } });
        await db.nodeGroup.deleteMany({ where: { workspace_id: teamId } });
        await db.workspace.deleteMany({ where: { id: teamId } });
      }
      if (ids.length) {
        await db.tunnel.deleteMany({ where: { workspace: { personal_user_id: { in: ids } } } });
        await db.nodeGroup.deleteMany({ where: { workspace: { personal_user_id: { in: ids } } } });
        await db.workspace.deleteMany({ where: { personal_user_id: { in: ids } } });
        await db.userCredential.deleteMany({ where: { user_id: { in: ids } } });
        await db.user.deleteMany({ where: { id: { in: ids } } });
      }
    }
  });
}
