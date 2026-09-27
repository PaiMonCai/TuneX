import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

/**
 * V4-F2 回归：role / 端口区间的 impact 预检与实际写入**必须同源**。
 *
 * 这个文件跑的是**真 HTTP + 真 MySQL**（`backend/tests/*.test.mjs` 由 CI 在
 * 带 MySQL 服务的 job 里用 `TUNEX_DB_TEST=1` 执行），不是替身：
 * `services/__tests__/node-admin.test.ts` 钉住判定逻辑与事务内顺序，
 * 这里钉住真库上的端到端事实——**预检拒绝时 PATCH 必须拒绝，且列值不许变**。
 *
 * 复现的是 Gate 里抓到的原始缺陷（F2.9.11 / F2.9.12）：
 *   · 节点 role=both，有一条活跃 Forward 以它为入口，端口区间内有一条 active 租约；
 *   · `GET /impact` 正确回 `role_check.ok=false`（node_still_used_as_ingress）；
 *   · 但 `PATCH /role` 返回 200 并把 role 改成 egress、把区间缩到 21020-21099。
 * 修好后两个 PATCH 都必须是 409，且 DB 列值原样不动（fail-closed）。
 *
 * 时间：预检与写入在同一次请求序列里紧邻执行，不存在「预检时依赖已清空」的
 * 解释空间——拒绝时依赖仍然在，落库就是缺陷。
 */

if (process.env.TUNEX_DB_TEST !== "1") {
  test("node role impact gate (real MySQL, requires TUNEX_DB_TEST=1)", { skip: true }, () => {});
} else {
  process.env.AUTH_SECRET ??= "test-only-auth-secret-must-not-be-used-in-production";
  process.env.LICENSE_SECRET ??= "test-only-license-secret-must-not-be-used-in-production";
  process.env.PAYMENTS_ENABLED = "false";
  process.env.ALLOW_REGISTER_FALLBACK = "true";

  const { app } = await import("../src/app.ts");
  const { db } = await import("../src/db.ts");
  const { redis } = await import("../src/redis.ts");

  const nonce = randomUUID().slice(0, 12);
  const created = { users: [], tunnels: [], leases: [], nodes: [], groups: [] };

  after(async () => {
    // 先删依赖再删被依赖，顺序与真实外键相反；失败不掩盖测试结论。
    try {
      await db.nodePortLease.deleteMany({ where: { node_id: { in: created.nodes } } });
      await db.tunnel.deleteMany({ where: { id: { in: created.tunnels } } });
      await db.node.deleteMany({ where: { id: { in: created.nodes } } });
      await db.nodeGroup.deleteMany({ where: { id: { in: created.groups } } });
      await db.user.deleteMany({ where: { id: { in: created.users } } });
    } catch {
      /* 清理尽力而为 */
    }
    redis.disconnect();
    await db.$disconnect();
  });

  let requestSeq = 0;
  async function request(path, method, cookie, body) {
    return app.request(`http://localhost${path}`, {
      method,
      headers: {
        "x-forwarded-for": `198.18.${++requestSeq % 250}.9`,
        ...(cookie ? { cookie, "x-csrf-token": "test" } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }

  /**
   * 注册 + 登录，并**确定性地**把账号提成超管（不依赖「库里的第一个用户」）。
   *
   * 每次调用用独立邮箱：`../src/app.ts` 是进程级单例，同一文件里的两个用例共享
   * 同一个库与同一份路由实例，复用邮箱会在第二次注册时撞唯一键（409）。
   */
  let sessionSeq = 0;
  async function adminSession() {
    const email = `f2-role-${nonce}-${++sessionSeq}@example.test`;
    const password = "ci-only-password-12";
    const reg = await request("/api/auth/register", "POST", "", { email, password });
    // 先取正文再断言：断言消息里的模板串**无条件求值**，会让成功的响应也被读掉
    // 一次 body，随后的 `.json()` 直接抛 "Body is unusable"。
    const regText = await reg.text();
    assert.equal(reg.status, 201, `register failed: ${reg.status} ${regText}`);
    const userId = JSON.parse(regText).data.id;
    created.users.push(userId);
    await db.user.update({ where: { id: userId }, data: { super_admin: true } });

    const login = await request("/api/auth/login", "POST", "", { email, password });
    const loginText = await login.text();
    assert.equal(login.status, 200, `login failed: ${login.status} ${loginText}`);
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie?.startsWith("access="), "expected access cookie");
    return { cookie, userId, email };
  }

  let nodeSeq = 0;
  async function seedNode(groupId, role, min, max) {
    const node = await db.node.create({
      data: {
        node_group_id: groupId,
        node_id: `f2-role-${nonce}-${++nodeSeq}`,
        connect_ip: "127.0.0.1",
        status: "active",
        lifecycle: "active",
        role,
        last_seen_at: new Date(),
        port_range_min: min,
        port_range_max: max,
      },
    });
    created.nodes.push(node.id);
    return node;
  }

  /** 一条活跃的 Forward（以该节点为入口）+ 一条区间内的 active 租约。 */
  async function seedIngressForward(userId, groupId, nodeId, leasePort, leaseTunnelSlot) {
    const tunnel = await db.tunnel.create({
      data: {
        name: `f2-role-forward-${nonce}-${leaseTunnelSlot}`,
        tunnel_type: "tcp",
        category: "port_forward",
        status: "active",
        load_balance_type: "round",
        forward_addresses: ["127.0.0.1:8080"],
        tunnel_mode: "direct",
        desired_status: "active",
        in_node_group_id: groupId,
        user_id: userId,
        workspace_id: (await db.workspace.findFirstOrThrow({ where: { personal_user_id: userId } })).id,
        ingress_node_id: nodeId,
        listen_port: leasePort,
      },
    });
    created.tunnels.push(tunnel.id);
    const lease = await db.nodePortLease.create({
      data: {
        node_id: nodeId,
        tunnel_id: tunnel.id,
        port: leasePort,
        lease_type: "ingress",
        status: "active",
      },
    });
    created.leases.push(lease.id);
    return tunnel;
  }

  test("F2.9.11/F2.9.12：预检拒绝的 role / 区间收缩，PATCH 必须 409 且不落库", async () => {
    const { cookie, userId } = await adminSession();

    const group = await db.nodeGroup.create({
      data: {
        name: `f2-role-group-${nonce}`,
        node_type: "in",
        user_id: userId,
        workspace_id: (await db.workspace.findFirstOrThrow({ where: { personal_user_id: userId } })).id,
      },
    });
    created.groups.push(group.id);

    const node = await seedNode(group.id, "both", 21000, 21099);
    await seedIngressForward(userId, group.id, node.id, 21010, 1);

    // ── 1) 预检：丢入口能力会被活跃 Forward 挡住 ──────────────────────
    const roleImpact = await request(
      `/api/admin/node/${node.id}/impact?next_role=egress&current_role=both`,
      "GET",
      cookie,
    );
    assert.equal(roleImpact.status, 200);
    const roleCheck = (await roleImpact.json()).data.role_check;
    assert.equal(roleCheck.ok, false, `impact must reject the shrink: ${JSON.stringify(roleCheck)}`);
    assert.equal(roleCheck.condition, "node_still_used_as_ingress");

    // ── 2) 真写入：必须与预检同结论，且列值不动 ──────────────────────
    const rolePatch = await request(`/api/admin/node/${node.id}/role`, "PATCH", cookie, { role: "egress" });
    const roleBody = await rolePatch.text();
    assert.equal(rolePatch.status, 409, `PATCH role must fail closed, got ${rolePatch.status}: ${roleBody}`);
    assert.equal(JSON.parse(roleBody).condition, "node_still_used_as_ingress");

    const afterRole = await db.node.findUniqueOrThrow({ where: { id: node.id } });
    assert.equal(afterRole.role, "both", "role must not change when the impact check rejects");

    // ── 3) 预检：区间收缩会让 active 租约悬空 ────────────────────────
    const rangeImpact = await request(
      `/api/admin/node/${node.id}/impact?port_min=21020&port_max=21099`,
      "GET",
      cookie,
    );
    assert.equal(rangeImpact.status, 200);
    const rangeCheck = (await rangeImpact.json()).data.role_check;
    assert.equal(rangeCheck.ok, false, `impact must reject the shrink: ${JSON.stringify(rangeCheck)}`);
    assert.equal(rangeCheck.condition, "port_range_would_orphan_leases");

    // ── 4) 真写入：同样必须 409，区间原样保留 ────────────────────────
    const rangePatch = await request(`/api/admin/node/${node.id}/role`, "PATCH", cookie, {
      port_range_min: 21020,
      port_range_max: 21099,
    });
    const rangeBody = await rangePatch.text();
    assert.equal(rangePatch.status, 409, `PATCH range must fail closed, got ${rangePatch.status}: ${rangeBody}`);
    assert.equal(JSON.parse(rangeBody).condition, "port_range_would_orphan_leases");

    const afterRange = await db.node.findUniqueOrThrow({ where: { id: node.id } });
    assert.equal(afterRange.port_range_min, 21000, "port_range_min must not change");
    assert.equal(afterRange.port_range_max, 21099, "port_range_max must not change");
    assert.equal(afterRange.role, "both", "range-only PATCH must not touch role either");
  });

  test("依赖清空后同一请求必须放行（守卫不是无条件拒绝）", async () => {
    const { cookie, userId } = await adminSession();
    const workspace = await db.workspace.findFirstOrThrow({ where: { personal_user_id: userId } });

    const group = await db.nodeGroup.create({
      data: { name: `f2-role-group2-${nonce}`, node_type: "in", user_id: userId, workspace_id: workspace.id },
    });
    created.groups.push(group.id);

    const node = await seedNode(group.id, "both", 22000, 22099);
    const tunnel = await seedIngressForward(userId, group.id, node.id, 22010, 2);
    void tunnel;

    // 先确认此时确实被挡住（否则下面的「放行」毫无说服力）。
    const blocked = await request(`/api/admin/node/${node.id}/role`, "PATCH", cookie, { role: "egress" });
    const blockedBody = await blocked.text();
    assert.equal(blocked.status, 409, `expected pre-condition rejection: ${blockedBody}`);

    // 清空依赖：迁移掉 Forward（清 ingress 绑定 + 释放租约）。
    await db.nodePortLease.deleteMany({ where: { node_id: node.id } });
    await db.tunnel.deleteMany({ where: { id: { in: created.tunnels } } });
    created.tunnels.length = 0;

    const allowed = await request(`/api/admin/node/${node.id}/role`, "PATCH", cookie, { role: "egress" });
    const allowedBody = await allowed.text();
    assert.equal(allowed.status, 200, `expected 200 after deps cleared, got ${allowed.status}: ${allowedBody}`);
    const after = await db.node.findUniqueOrThrow({ where: { id: node.id } });
    assert.equal(after.role, "egress", "role change must persist once dependencies are gone");
  });
}
