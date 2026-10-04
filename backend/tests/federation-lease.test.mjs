/**
 * V5.5 WP15 —— 联邦租约的 MySQL 集成测试（node:test + 真库；`TUNEX_DB_TEST=1`）。
 *
 * 与 `src/services/__tests__/federation-lease.test.ts` 的分工：
 *   · 那边是**纯逻辑 + 替身**，钉判定与状态机；
 *   · 这边跑**真 MySQL**，钉"跨表副作用"——`federation_lease` / `federation_intent` /
 *     `node_port_lease` 三张表在同一件事上的最终状态。
 *
 * 运行时侧（Agent 下发/停服）用注入的替身：本机没有第二台真实 Agent，
 * 而"端口是否真的被 host 侧归还"这件事**必须**用真库验（替身会把这件事掩盖掉）。
 * 真实的两面板拓扑由 Gate 脚本负责，这里不假装覆盖它。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

if (process.env.TUNEX_DB_TEST !== "1") {
  test("federation lease MySQL integration (requires TUNEX_DB_TEST=1)", { skip: true }, () => {});
} else {
  process.env.AUTH_SECRET ??= "test-only-auth-secret-must-not-be-used-in-production";
  process.env.LICENSE_SECRET ??= "test-only-license-secret-must-not-be-used-in-production";
  process.env.PAYMENTS_ENABLED = "false";

  const { db } = await import("../src/db.ts");
  // Redis 是 portPool 的并发锁通道（本文件会真的走 acquirePort）。它惰性连接但**不会自己退出**，
  // 不显式断开，node:test 会一直挂在事件循环上（与 workspace-db.test.mjs 同款收尾）。
  const { redis } = await import("../src/redis.ts");
  const { createGrant, revokeGrant } = await import("../src/services/federation/grant.ts");
  const {
    applyRemoteLease,
    expireLeases,
    releaseRemoteLease,
    reserveRemoteLease,
  } = await import("../src/services/federation/lease.ts");

  const nonce = randomUUID().slice(0, 8);
  const panelId = `it-panel-${nonce}`;
  const created = { userId: null, workspaceId: null, groupId: null, nodeId: null, peerId: null, grantRefs: [], leaseRefs: [] };

  /* ---------------- 夹具 ---------------- */

  const user = await db.user.create({ data: { email: `fed-lease-${nonce}@example.test` } });
  created.userId = user.id;
  const workspace = await db.workspace.create({
    data: { slug: `fed-lease-${nonce}`, name: `fed-lease ${nonce}`, kind: "team", created_by_id: user.id },
  });
  created.workspaceId = workspace.id;
  const group = await db.nodeGroup.create({
    data: {
      name: `fed-group-${nonce}`,
      node_type: "out",
      user_id: user.id,
      workspace_id: workspace.id,
      port_range: "19100-19199",
    },
  });
  created.groupId = group.id;
  const node = await db.node.create({
    data: {
      node_group_id: group.id,
      node_id: `fed-node-${nonce}`,
      connect_ip: "10.42.0.7",
      status: "active",
      role: "egress",
      port_range_min: 19100,
      port_range_max: 19199,
      node_credential_hash: randomUUID().replace(/-/g, "").padEnd(64, "0").slice(0, 64),
      credential_revoked: false,
    },
  });
  created.nodeId = node.id;
  const peer = await db.federationPeer.create({
    data: {
      peer_panel_id: panelId,
      display_name: `it peer ${nonce}`,
      endpoint_url: "https://peer-b.example.test",
      public_keys: [],
      status: "trusted",
    },
  });
  created.peerId = peer.id;

  /** 运行时替身：只记录调用，不碰 Agent（本机没有第二个面板的 Agent）。 */
  function runtimeStub({ dispatchOk = true, teardownOk = true } = {}) {
    const calls = { dispatch: [], teardown: [], ports: [] };
    return {
      calls,
      deps: {
        now: () => new Date(),
        dispatch: (input) => {
          calls.dispatch.push(input);
          return dispatchOk ? { ok: true } : { ok: false, message: "stub: agent unreachable" };
        },
        teardown: (input) => {
          calls.teardown.push(input);
          return teardownOk ? { ok: true } : { ok: false, message: "stub: teardown failed" };
        },
      },
    };
  }

  async function makeGrant({ scopeOver = {}, capacity = { max_legs: 3 }, expiresInMs = 60 * 60 * 1000, hopRoles = ["egress"] } = {}) {
    const outcome = await createGrant({
      peerPanelId: panelId,
      workspaceId: workspace.id,
      scope: { node_group_ids: [group.id], hop_roles: hopRoles, ...scopeOver },
      capacity,
      expiresAt: new Date(Date.now() + expiresInMs),
      createdById: user.id,
    });
    assert.equal(outcome.ok, true, `createGrant failed: ${outcome.ok ? "" : outcome.message}`);
    created.grantRefs.push(outcome.grant.grant_ref);
    return outcome.grant;
  }

  async function reserve(grant, { intentId = `intent-${randomUUID().slice(0, 8)}`, revision = 1, deps = {}, ttlSeconds, hopRole = "egress" } = {}) {
    const outcome = await reserveRemoteLease(
      {
        intent: { intent_id: intentId, revision, hop_role: hopRole, forward_ref: `fwd-${nonce}`, requested: {} },
        grant: {
          id: grant.id,
          grant_ref: grant.grant_ref,
          peer_panel_id: panelId,
          workspace_id: grant.workspace_id,
          grant_epoch: grant.grant_epoch,
          status: grant.status,
          scope: grant.scope,
          capacity: grant.capacity,
          expires_at: grant.expires_at,
        },
        workspaceId: workspace.id,
        resolvedNodeId: node.id,
        resolvedNodeGroupId: group.id,
        appliedRevision: null,
        previousEpoch: null,
      },
      { ttlSeconds: ttlSeconds ?? 300, ...deps },
    );
    if (outcome.ok) created.leaseRefs.push(outcome.lease.lease_ref);
    return outcome;
  }

  const activePortLeases = (port) =>
    db.nodePortLease.findMany({ where: { node_id: node.id, ...(port === undefined ? {} : { port }) }, select: { port: true, status: true } });

  /* ---------------- 场景 ---------------- */

  test("grant -> reserve -> apply -> active: the port is really held, and revoke stops and returns it", async () => {
    const grant = await makeGrant();
    const runtime = runtimeStub();

    const reserved = await reserve(grant, { deps: runtime.deps });
    assert.equal(reserved.ok, true, reserved.ok ? "" : reserved.message);
    const port = reserved.port;
    assert.equal(reserved.lease.state, "reserved");
    assert.ok(port >= 19100 && port <= 19199, `port ${port} outside the node range`);

    const held = await activePortLeases(port);
    assert.equal(held.length, 1);
    assert.equal(held[0].status, "active");

    const applied = await applyRemoteLease(
      {
        lease_ref: reserved.lease.lease_ref,
        intent_id: reserved.lease.intent_id,
        revision: 1,
        targets: [{ host: "203.0.113.9", port: 443 }],
        lb_strategy: "ROUND_ROBIN",
        protocol: "tcp",
      },
      runtime.deps,
    );
    assert.equal(applied.ok, true, applied.ok ? "" : applied.message);
    assert.equal(applied.applied_revision, 1);
    assert.equal(applied.node_ref, node.node_id);

    const active = await db.federationLease.findUnique({ where: { lease_ref: reserved.lease.lease_ref } });
    assert.equal(active.state, "active");
    assert.equal(active.applied_revision, 1);
    assert.ok(active.applied_at !== null);
    assert.equal(runtime.calls.dispatch.length, 1);
    assert.equal(runtime.calls.dispatch[0].runtime_id, `tunex-fed-${reserved.lease.lease_ref}-egress`);

    // 重投递同一 (intent_id, revision, apply)：必须返回首次结果且**不再下发**。
    const replay = await applyRemoteLease(
      {
        lease_ref: reserved.lease.lease_ref,
        intent_id: reserved.lease.intent_id,
        revision: 1,
        targets: [{ host: "203.0.113.9", port: 443 }],
      },
      runtime.deps,
    );
    assert.equal(replay.ok, true);
    assert.equal(replay.replayed, true);
    assert.equal(runtime.calls.dispatch.length, 1, "a replay must not dispatch a second time");

    // 撤销 grant：级联停服 + 归还端口。
    const revoked = await revokeGrant(
      { grantRef: grant.grant_ref },
      { teardown: runtime.deps.teardown, releasePort: undefined },
    );
    assert.equal(revoked.ok, true, revoked.ok ? "" : revoked.message);
    assert.equal(revoked.leases_revoked, 1);
    assert.equal(revoked.teardown_ok, 1);
    assert.equal(revoked.ports_released, 1);
    assert.equal(runtime.calls.teardown.length >= 1, true);

    const afterRevoke = await db.federationLease.findUnique({ where: { lease_ref: reserved.lease.lease_ref } });
    assert.equal(afterRevoke.state, "revoked");
    const releasedRows = await activePortLeases(port);
    assert.equal(releasedRows.length, 1);
    assert.equal(releasedRows[0].status, "released", "the host-side port lease must be returned on revoke");
  });

  test("quota exhaustion refuses the second intent and leaks neither a lease nor a port", async () => {
    const grant = await makeGrant({ capacity: { max_legs: 1 } });
    const runtime = runtimeStub();

    const first = await reserve(grant, { deps: runtime.deps });
    assert.equal(first.ok, true, first.ok ? "" : first.message);

    const leasesBefore = await db.federationLease.count({ where: { grant_id: grant.id } });
    const portsBefore = (await activePortLeases()).filter((r) => r.status === "active").length;

    const second = await reserve(grant, { deps: runtime.deps });
    assert.equal(second.ok, false);
    assert.equal(second.code, "quota_exhausted");

    assert.equal(await db.federationLease.count({ where: { grant_id: grant.id } }), leasesBefore);
    assert.equal((await activePortLeases()).filter((r) => r.status === "active").length, portsBefore);
    assert.equal(await db.federationIntent.count({ where: { intent_id: second.ok ? "" : "unreachable" } }), 0);
  });

  test("a failed apply compensates: no orphan runtime, and the port goes back immediately", async () => {
    const grant = await makeGrant();
    const runtime = runtimeStub({ dispatchOk: false });

    const reserved = await reserve(grant, { deps: runtime.deps });
    assert.equal(reserved.ok, true);
    const port = reserved.port;

    const applied = await applyRemoteLease(
      {
        lease_ref: reserved.lease.lease_ref,
        intent_id: reserved.lease.intent_id,
        revision: 1,
        targets: [{ host: "203.0.113.9", port: 443 }],
      },
      runtime.deps,
    );
    assert.equal(applied.ok, false);
    assert.equal(applied.code, "internal_error");

    const row = await db.federationLease.findUnique({ where: { lease_ref: reserved.lease.lease_ref } });
    assert.equal(row.state, "failed");
    assert.equal(row.applied_revision, null);
    assert.equal(runtime.calls.teardown.length, 1, "compensation must revoke what it may have created");

    const portRows = await activePortLeases(port);
    assert.equal(portRows[0].status, "released", "the allocated port must not stay held after a failed apply");
  });

  test("expiry stops the service, returns the port, and lands on expired", async () => {
    const grant = await makeGrant();
    const runtime = runtimeStub();

    const reserved = await reserve(grant, { deps: runtime.deps, ttlSeconds: 1 });
    assert.equal(reserved.ok, true);
    const port = reserved.port;

    const applied = await applyRemoteLease(
      {
        lease_ref: reserved.lease.lease_ref,
        intent_id: reserved.lease.intent_id,
        revision: 1,
        targets: [{ host: "203.0.113.9", port: 443 }],
      },
      runtime.deps,
    );
    assert.equal(applied.ok, true);

    const summary = await expireLeases({ now: new Date(Date.now() + 5_000), deps: runtime.deps });
    assert.equal(summary.expired >= 1, true, `expected at least one expiry, got ${JSON.stringify(summary)}`);
    assert.equal(summary.teardown_failed, 0);

    const row = await db.federationLease.findUnique({ where: { lease_ref: reserved.lease.lease_ref } });
    assert.equal(row.state, "expired");
    const portRows = await activePortLeases(port);
    assert.equal(portRows[0].status, "released");
  });

  test("an explicit release is idempotent and returns the port exactly once", async () => {
    const grant = await makeGrant();
    const runtime = runtimeStub();

    const reserved = await reserve(grant, { deps: runtime.deps });
    assert.equal(reserved.ok, true);
    const port = reserved.port;

    const first = await releaseRemoteLease(
      { intent_id: reserved.lease.intent_id, revision: 1, lease_ref: reserved.lease.lease_ref },
      runtime.deps,
    );
    assert.equal(first.ok, true);
    const second = await releaseRemoteLease(
      { intent_id: reserved.lease.intent_id, revision: 1, lease_ref: reserved.lease.lease_ref },
      runtime.deps,
    );
    assert.equal(second.ok, true);
    assert.equal(second.replayed || second.already_released, true);
    assert.equal(runtime.calls.teardown.length, 1, "a repeated release must not tear down twice");

    const row = await db.federationLease.findUnique({ where: { lease_ref: reserved.lease.lease_ref } });
    assert.equal(row.state, "released");
    const portRows = await activePortLeases(port);
    assert.equal(portRows[0].status, "released");
  });

  test("a remote ingress hop applies through dispatchIngress with the relay runtime id", async () => {
    const grant = await makeGrant({ hopRoles: ["ingress"] });
    const runtime = runtimeStub();

    const reserved = await reserve(grant, { deps: runtime.deps, hopRole: "ingress" });
    assert.equal(reserved.ok, true, reserved.ok ? "" : reserved.message);
    assert.equal(reserved.lease.hop_role, "ingress");
    const port = reserved.port;

    // 缺 next_hop：必须在**下发之前**就拒（不猜地址）。
    const noHop = await applyRemoteLease(
      {
        lease_ref: reserved.lease.lease_ref,
        intent_id: reserved.lease.intent_id,
        revision: 1,
        targets: [],
      },
      runtime.deps,
    );
    assert.equal(noHop.ok, false);
    assert.equal(noHop.code, "message_malformed");
    assert.equal(runtime.calls.dispatch.length, 0);

    const applied = await applyRemoteLease(
      {
        lease_ref: reserved.lease.lease_ref,
        intent_id: reserved.lease.intent_id,
        revision: 1,
        targets: [],
        next_hop: "10.42.0.9:19002",
      },
      runtime.deps,
    );
    assert.equal(applied.ok, true, applied.ok ? "" : applied.message);
    assert.equal(runtime.calls.dispatch.length, 1, "the malformed attempt must not have dispatched");
    assert.equal(runtime.calls.dispatch[0].runtime_id, `tunex-fed-${reserved.lease.lease_ref}-relay`);
    assert.equal(runtime.calls.dispatch[0].link.next_hop, "10.42.0.9:19002");
    assert.equal(runtime.calls.dispatch[0].lease.hop_role, "ingress");

    // 拆除必须用同一个方向（拆错方向 = 没拆）。
    const released = await releaseRemoteLease(
      { intent_id: reserved.lease.intent_id, revision: 1, lease_ref: reserved.lease.lease_ref },
      runtime.deps,
    );
    assert.equal(released.ok, true);
    assert.equal(runtime.calls.teardown[0].hop_role, "ingress");
    const portRows = await activePortLeases(port);
    assert.equal(portRows[0].status, "released");
  });

  test("an ingress apply failure compensates and frees the port", async () => {
    const grant = await makeGrant({ hopRoles: ["ingress"] });
    const runtime = runtimeStub({ dispatchOk: false });

    const reserved = await reserve(grant, { deps: runtime.deps, hopRole: "ingress" });
    assert.equal(reserved.ok, true);
    const port = reserved.port;

    const applied = await applyRemoteLease(
      {
        lease_ref: reserved.lease.lease_ref,
        intent_id: reserved.lease.intent_id,
        revision: 1,
        targets: [],
        next_hop: "10.42.0.9:19002",
      },
      runtime.deps,
    );
    assert.equal(applied.ok, false);

    const row = await db.federationLease.findUnique({ where: { lease_ref: reserved.lease.lease_ref } });
    assert.equal(row.state, "failed");
    assert.equal(runtime.calls.teardown.length, 1);
    assert.equal(runtime.calls.teardown[0].hop_role, "ingress");
    const portRows = await activePortLeases(port);
    assert.equal(portRows[0].status, "released");
  });

  test("cross-panel transit is closed: no dispatch, no port left behind", async () => {
    const grant = await makeGrant({ hopRoles: ["transit"] });
    const runtime = runtimeStub();

    const reserved = await reserve(grant, { deps: runtime.deps, hopRole: "transit" });
    assert.equal(reserved.ok, true);
    const port = reserved.port;

    const applied = await applyRemoteLease(
      {
        lease_ref: reserved.lease.lease_ref,
        intent_id: reserved.lease.intent_id,
        revision: 1,
        targets: [],
        next_hop: "10.42.0.9:19002",
      },
      runtime.deps,
    );
    assert.equal(applied.ok, false);
    assert.equal(applied.code, "unsupported_topology");
    assert.equal(runtime.calls.dispatch.length, 0);

    // 被拒之后端口仍由 reserved 租约持有（不是泄漏：租约还在，release/expire 会归还）。
    const released = await releaseRemoteLease(
      { intent_id: reserved.lease.intent_id, revision: 1, lease_ref: reserved.lease.lease_ref },
      runtime.deps,
    );
    assert.equal(released.ok, true);
    const portRows = await activePortLeases(port);
    assert.equal(portRows[0].status, "released");
  });

  /* ---------------- 清理 ---------------- */

  after(async () => {
    // 只清本文件造的夹具（按 id/前缀），避免影响同一个库里的其它测试。
    await db.federationLease.deleteMany({ where: { peer_panel_id: panelId } });
    await db.federationIntent.deleteMany({ where: { peer_panel_id: panelId } });
    await db.federationGrant.deleteMany({ where: { peer_id: created.peerId ?? -1 } });
    await db.federationPeer.deleteMany({ where: { peer_panel_id: panelId } });
    if (created.nodeId !== null) {
      await db.nodePortLease.deleteMany({ where: { node_id: created.nodeId } });
      await db.node.deleteMany({ where: { id: created.nodeId } });
    }
    if (created.groupId !== null) await db.nodeGroup.deleteMany({ where: { id: created.groupId } });
    if (created.workspaceId !== null) await db.workspace.deleteMany({ where: { id: created.workspaceId } });
    if (created.userId !== null) await db.user.deleteMany({ where: { id: created.userId } });
    await db.$disconnect();
    redis.disconnect();
  });
}
