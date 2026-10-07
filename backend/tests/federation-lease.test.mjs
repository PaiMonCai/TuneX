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
  process.env.PAYMENTS_ENABLED = "false";

  const { randomUUID: uuid } = await import("node:crypto");
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
  const created = { userId: null, workspaceId: null, groupId: null, nodeId: null, peerId: null, grantRefs: [], leaseRefs: [], extraNodeIds: [] };

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

  test("task-7 A: a revision superseded mid-dispatch neither rolls back nor tears down the newer runtime", async () => {
    const grant = await makeGrant();
    const runtime = runtimeStub();

    const reserved = await reserve(grant, { deps: runtime.deps });
    assert.equal(reserved.ok, true);
    const ref = reserved.lease.lease_ref;
    const port = reserved.port;

    // revision 1 先落地（正常路径）。
    const first = await applyRemoteLease(
      { lease_ref: ref, intent_id: reserved.lease.intent_id, revision: 1, targets: [{ host: "203.0.113.9", port: 443 }] },
      runtime.deps,
    );
    assert.equal(first.ok, true);

    // revision 2 下发期间，revision 3 已经落库（并发）。补偿**不得**碰 runtime。
    const racing = {
      ...runtime.deps,
      dispatch: async (input) => {
        runtime.calls.dispatch.push(input);
        await db.federationLease.update({ where: { lease_ref: ref }, data: { applied_revision: 3, state: "active" } });
        return { ok: true };
      },
    };
    const superseded = await applyRemoteLease(
      { lease_ref: ref, intent_id: reserved.lease.intent_id, revision: 2, targets: [{ host: "203.0.113.9", port: 443 }] },
      racing,
    );

    assert.equal(superseded.ok, false);
    assert.equal(superseded.code, "intent_revision_stale");
    assert.equal(runtime.calls.teardown.length, 0, "a superseded revision must not tear down the newer runtime");

    const row = await db.federationLease.findUnique({ where: { lease_ref: ref } });
    assert.equal(row.applied_revision, 3, "applied_revision must stay monotonic");
    assert.equal(row.state, "active");
    const portRows = await activePortLeases(port);
    assert.equal(portRows[0].status, "active", "the port still belongs to the live lease");
  });

  test("task-7 D1: an expired lease whose port release failed is retried port-only by the sweeper", async () => {
    const grant = await makeGrant();
    const runtime = runtimeStub();

    const reserved = await reserve(grant, { deps: runtime.deps, ttlSeconds: 1 });
    assert.equal(reserved.ok, true);
    const ref = reserved.lease.lease_ref;
    const port = reserved.port;

    const applied = await applyRemoteLease(
      { lease_ref: ref, intent_id: reserved.lease.intent_id, revision: 1, targets: [{ host: "203.0.113.9", port: 443 }] },
      runtime.deps,
    );
    assert.equal(applied.ok, true);

    // 到期：停服成功，但还端口失败 → 必须留下显式标记，且状态照样收口。
    const failingRelease = {
      ...runtime.deps,
      releasePort: () => ({ ok: false, message: "portPool is down" }),
    };
    const expired = await expireLeases({ now: new Date(Date.now() + 5_000), deps: failingRelease });
    assert.equal(expired.expired >= 1, true);
    assert.equal(expired.ports_pending >= 1, true);

    const afterExpiry = await db.federationLease.findUnique({ where: { lease_ref: ref } });
    assert.equal(afterExpiry.state, "expired");
    assert.equal(afterExpiry.last_error_code, "port_release_failed");

    // 下一拍扫尾：只补还端口（**不再**拆一次 runtime），随后标记清空。
    const { sweepRevokedLeaseCleanup } = await import("../src/services/federation/lease.ts");
    const teardownsBefore = runtime.calls.teardown.length;
    const swept = await sweepRevokedLeaseCleanup({ now: new Date(Date.now() + 10_000), deps: runtime.deps });
    assert.equal(swept.port_only_retried >= 1, true);
    assert.equal(swept.ports_released >= 1, true);
    assert.equal(runtime.calls.teardown.length, teardownsBefore, "the sweeper must not tear down an already-stopped runtime");

    const settled = await db.federationLease.findUnique({ where: { lease_ref: ref } });
    assert.equal(settled.last_error_code, null);
    const portRows = await activePortLeases(port);
    assert.equal(portRows[0].status, "released", "the port must really be returned on the retry");
  });

  test("task-7 B1: the reconnect resend payload is accepted by the real /leases handler (not a 400)", async () => {
    const { createApp } = await import("../src/app.ts");
    const { ensurePanelIdentity, setFederationEnabled, resetPanelIdentityCache } = await import(
      "../src/services/federation/identity.ts"
    );
    const { buildSignatureHeaders } = await import("../src/services/federation/signing.ts");
    const { generatePanelKeyPair } = await import("../src/services/federation/keys.ts");
    const { upsertPlacement, reconcilePlacements } = await import("../src/services/federation/placement.ts");

    const app = createApp();

    // 我的"对端 panel"身份：与夹具里那条 trusted peer 共用（它拿着私钥，本机只存公钥）。
    const keys = await generatePanelKeyPair();
    await db.federationPeer.update({
      where: { peer_panel_id: panelId },
      data: { public_keys: [{ key_id: keys.key_id, jwk: keys.public_jwk, state: "active", not_after: null }] },
    });
    await ensurePanelIdentity();
    await setFederationEnabled(true);
    // 路由选点要求 120s 内有 state report。
    await db.nodeStateReport.upsert({
      where: { node_id: node.id },
      create: { node_id: node.id, role: "egress", reported_at: new Date() },
      update: { reported_at: new Date() },
    });

    // 已有一次预留（非终态）：路由按解析顺序 ② 就能找回 grant，无需 home 记得 grant_ref。
    const grant = await makeGrant();
    const runtime = runtimeStub();
    const reserved = await reserve(grant, { deps: runtime.deps });
    assert.equal(reserved.ok, true);

    // 镜像行落后于期望 → 需要对账重发。
    const mirrored = await upsertPlacement(
      {
        peer_panel_id: panelId,
        forward_ref: `fwd-${nonce}`,
        intent_id: reserved.lease.intent_id,
        hop_role: "egress",
        desired_revision: 2,
        applied_revision: 1,
        state: "active",
        tunnel_id: null,
      },
      { db },
    );
    assert.equal(mirrored.ok, true);

    const seen = [];
    const signedSender = async (input) => {
      const bodyStr = JSON.stringify(input.body ?? {});
      const headers = await buildSignatureHeaders({
        identity: { panel_id: panelId, key_id: keys.key_id, public_jwk: keys.public_jwk },
        privateJwk: keys.private_jwk,
        body: bodyStr,
        method: "POST",
        path: input.path,
        messageId: uuid(),
      });
      const res = await app.request(`http://panel.local${input.path}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: bodyStr,
      });
      const json = await res.json().catch(() => null);
      seen.push({ status: res.status, body: json, sent: input.body });
      if (res.status < 400) return { ok: true, status: res.status, body: json, messageId: "resend-1" };
      return {
        ok: false,
        code: json?.code ?? "internal_error",
        status: res.status,
        message: json?.message ?? `HTTP ${res.status}`,
        retryable: Boolean(json?.retryable),
        messageId: "resend-1",
      };
    };

    const result = await reconcilePlacements({ deps: { db, sender: signedSender } });
    assert.equal(seen.length, 1, `the mirror should have been resent exactly once, got ${JSON.stringify(seen)}`);
    assert.notEqual(seen[0].status, 400, `the resend payload must parse (got ${JSON.stringify(seen[0])})`);
    assert.notEqual(seen[0].body?.code, "message_malformed");
    assert.equal(result.resent, 1);
    assert.equal(result.degraded, 0);

    // 收尾：关掉开关，避免影响同库的其它套件。
    await setFederationEnabled(false);
    resetPanelIdentityCache();
    await db.federationPlacement.deleteMany({ where: { peer_panel_id: panelId } });
  });

  test("task-10: a placement past its expires_at terminates locally without any remote call", async () => {
    const { upsertPlacement, reconcilePlacements } = await import("../src/services/federation/placement.ts");
    const intentId = `intent-exp-${uuid().slice(0, 8)}`;

    const written = await upsertPlacement(
      {
        peer_panel_id: panelId,
        forward_ref: `fwd-${nonce}`,
        intent_id: intentId,
        hop_role: "egress",
        desired_revision: 1,
        applied_revision: 1,
        state: "active",
        lease_ref: `lease-exp-${nonce}`,
        expires_at: new Date(Date.now() - 1_000),
      },
      { db },
    );
    assert.equal(written.ok, true);

    const sends = [];
    const sender = async (input) => {
      sends.push(input);
      return { ok: true, status: 200, body: {}, messageId: "probe-0" };
    };
    const result = await reconcilePlacements({ deps: { db, sender } });

    assert.equal(result.expired >= 1, true, JSON.stringify(result));
    assert.equal(sends.length, 0, "expiry is local knowledge: the peer must not be asked");
    const row = await db.federationPlacement.findUnique({
      where: { peer_panel_id_intent_id: { peer_panel_id: panelId, intent_id: intentId } },
    });
    assert.equal(row.state, "expired");
    assert.equal(row.last_error_code, "lease_expired");

    // 终态吸收：下一拍不再是候选。
    const again = await reconcilePlacements({ deps: { db, sender } });
    assert.equal(again.expired, 0);
    assert.equal(sends.length, 0);
  });

  test("task-10: an active mirror goes degraded when the peer cannot be probed, and recovers later", async () => {
    const { upsertPlacement, reconcilePlacements } = await import("../src/services/federation/placement.ts");
    const intentId = `intent-live-${uuid().slice(0, 8)}`;

    const written = await upsertPlacement(
      {
        peer_panel_id: panelId,
        forward_ref: `fwd-${nonce}`,
        intent_id: intentId,
        hop_role: "egress",
        desired_revision: 1,
        applied_revision: 1,
        state: "active",
        lease_ref: `lease-live-${nonce}`,
        expires_at: new Date(Date.now() + 3_600_000),
      },
      { db },
    );
    assert.equal(written.ok, true);

    // 1) 探活不可达（host 停机）→ degraded，且码可解释。
    const down = [];
    const downSender = async (input) => {
      down.push(input);
      return { ok: false, code: "peer_unreachable", status: 0, message: "connection refused", retryable: true, messageId: "probe-down" };
    };
    const degradedResult = await reconcilePlacements({ deps: { db, sender: downSender } });
    assert.equal(down.length, 1, "the converged row must actually be probed");
    assert.equal(down[0].method, "GET");
    assert.equal(down[0].path, `/api/federation/v1/leases/lease-live-${nonce}`);
    assert.equal(degradedResult.probed, 1);
    assert.equal(degradedResult.degraded >= 1, true, JSON.stringify(degradedResult));

    const degradedRow = await db.federationPlacement.findUnique({
      where: { peer_panel_id_intent_id: { peer_panel_id: panelId, intent_id: intentId } },
    });
    assert.equal(degradedRow.state, "degraded");
    assert.equal(degradedRow.last_error_code, "peer_unreachable");

    // 2) host 恢复：探活成功且远端已收敛 → 回到 active（"恢复后收敛"）。
    const upSender = async () => ({
      ok: true,
      status: 200,
      body: { lease_ref: `lease-live-${nonce}`, state: "active", applied_revision: 1, lease_epoch: 1, expires_at: new Date(Date.now() + 3_600_000).toISOString() },
      messageId: "probe-up",
    });
    const recoveredResult = await reconcilePlacements({ deps: { db, sender: upSender } });
    assert.equal(recoveredResult.probed, 1);
    assert.equal(recoveredResult.recovered >= 1, true, JSON.stringify(recoveredResult));

    const recoveredRow = await db.federationPlacement.findUnique({
      where: { peer_panel_id_intent_id: { peer_panel_id: panelId, intent_id: intentId } },
    });
    assert.equal(recoveredRow.state, "active");
    assert.equal(recoveredRow.last_error_code, null);
  });

  test("task-11: a contract-shaped ingress apply is really delivered through the HTTP route", async () => {
    const { createApp } = await import("../src/app.ts");
    const { ensurePanelIdentity, setFederationEnabled, resetPanelIdentityCache } = await import(
      "../src/services/federation/identity.ts"
    );
    const { buildSignatureHeaders } = await import("../src/services/federation/signing.ts");
    const { generatePanelKeyPair } = await import("../src/services/federation/keys.ts");
    const { resetOrchestrator, setOrchestrator } = await import("../src/services/relay-wiring.ts");

    const app = createApp();
    const keys = await generatePanelKeyPair();
    await db.federationPeer.update({
      where: { peer_panel_id: panelId },
      data: { public_keys: [{ key_id: keys.key_id, jwk: keys.public_jwk, state: "active", not_after: null }] },
    });
    await ensurePanelIdentity();
    await setFederationEnabled(true);

    // 假 orchestrator：让"经 HTTP 送达的参数"这件事本身可断言（真机 agent 不在本容器里）。
    const seen = [];
    const fake = {
      async dispatchIngress(input) {
        seen.push({ kind: "ingress", ...input });
        return { ok: true, result: { commandId: "c-ingress", revision: input.revision, ack: {} } };
      },
      async dispatchEgress(input) {
        seen.push({ kind: "egress", ...input });
        return { ok: true, result: { commandId: "c-egress", revision: input.revision, ack: {} }, egress_host: "10.8.0.7", egress_port: input.egressPort };
      },
      async removeTunnel(input) {
        seen.push({ kind: "remove", ...input });
        return { ok: true, result: { commandId: "c-remove", revision: input.revision, ack: {} } };
      },
    };
    setOrchestrator(fake);

    async function signedApply(ref, body) {
      const bodyStr = JSON.stringify(body);
      const headers = await buildSignatureHeaders({
        identity: { panel_id: panelId, key_id: keys.key_id, public_jwk: keys.public_jwk },
        privateJwk: keys.private_jwk,
        body: bodyStr,
        method: "POST",
        path: `/api/federation/v1/leases/${ref}/apply`,
        messageId: uuid(),
      });
      const res = await app.request(`http://panel.local/api/federation/v1/leases/${ref}/apply`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: bodyStr,
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    }

    try {
      // ---- ingress 腿 ----
      const ingressGrant = await makeGrant({ hopRoles: ["ingress"] });
      const ingressRuntime = runtimeStub();
      const ingressLease = await reserve(ingressGrant, { deps: ingressRuntime.deps, hopRole: "ingress" });
      assert.equal(ingressLease.ok, true, ingressLease.ok ? "" : ingressLease.message);
      const ingressRef = ingressLease.lease.lease_ref;

      // 契约 §3.2 形状：link 里给 next_hop；ingress 允许空 targets。
      const okRun = await signedApply(ingressRef, {
        intent_id: ingressLease.lease.intent_id,
        revision: 1,
        link: { next_hop: "10.8.0.9:19302", targets: [] },
      });
      assert.equal(okRun.status, 200, `contract-shaped ingress apply must pass the route: ${JSON.stringify(okRun)}`);
      const delivered = seen.find((c) => c.kind === "ingress");
      assert.ok(delivered, "dispatchIngress must have been called through the real path");
      assert.equal(delivered.nextHop, "10.8.0.9:19302", "link.next_hop must reach the orchestrator");
      assert.equal(delivered.runtimeId, `tunex-fed-${ingressRef}-relay`);

      // 缺 next_hop → 400 message_malformed（不猜地址），且不得下发。
      const ingressGrant2 = await makeGrant({ hopRoles: ["ingress"] });
      const secondRuntime = runtimeStub();
      const secondLease = await reserve(ingressGrant2, { deps: secondRuntime.deps, hopRole: "ingress" });
      assert.equal(secondLease.ok, true);
      const before = seen.length;
      const missingHop = await signedApply(secondLease.lease.lease_ref, {
        intent_id: secondLease.lease.intent_id,
        revision: 1,
        link: { targets: [{ host: "203.0.113.9", port: 443 }] },
      });
      assert.equal(missingHop.status, 400);
      assert.equal(missingHop.body?.code, "message_malformed");
      assert.equal(seen.length, before, "a rejected apply must not reach the orchestrator");

      // ---- egress 腿：空 targets 仍然是 400（"空目标 = 一条永远不通的链路"）----
      const egressGrant = await makeGrant();
      const egressRuntime = runtimeStub();
      const egressLease = await reserve(egressGrant, { deps: egressRuntime.deps });
      assert.equal(egressLease.ok, true);
      const emptyTargets = await signedApply(egressLease.lease.lease_ref, {
        intent_id: egressLease.lease.intent_id,
        revision: 1,
        link: { targets: [] },
      });
      assert.equal(emptyTargets.status, 400);
      assert.equal(emptyTargets.body?.code, "message_malformed");

      // 出口腿正常形状 → 200，且 targets 真的送达。
      const egressOk = await signedApply(egressLease.lease.lease_ref, {
        intent_id: egressLease.lease.intent_id,
        revision: 1,
        link: { targets: [{ host: "203.0.113.9", port: 443 }], protocol: "tcp" },
      });
      assert.equal(egressOk.status, 200, JSON.stringify(egressOk));
      const egressDelivered = seen.filter((c) => c.kind === "egress").pop();
      assert.equal(egressDelivered.targets.length, 1);
      assert.equal(egressDelivered.targets[0].host, "203.0.113.9");
      assert.equal(egressDelivered.runtimeId, `tunex-fed-${egressLease.lease.lease_ref}-egress`);
    } finally {
      resetOrchestrator();
      await setFederationEnabled(false);
      resetPanelIdentityCache();
    }
  });

  test("task-11: periodic renewal really extends the deadline over HTTP (the old idempotency key killed it)", async () => {
    const { createApp } = await import("../src/app.ts");
    const { ensurePanelIdentity, setFederationEnabled, resetPanelIdentityCache } = await import(
      "../src/services/federation/identity.ts"
    );
    const { buildSignatureHeaders } = await import("../src/services/federation/signing.ts");
    const { generatePanelKeyPair } = await import("../src/services/federation/keys.ts");

    const app = createApp();
    const keys = await generatePanelKeyPair();
    await db.federationPeer.update({
      where: { peer_panel_id: panelId },
      data: { public_keys: [{ key_id: keys.key_id, jwk: keys.public_jwk, state: "active", not_after: null }] },
    });
    await ensurePanelIdentity();
    await setFederationEnabled(true);

    async function signedRenew(ref, body) {
      const bodyStr = JSON.stringify(body);
      const headers = await buildSignatureHeaders({
        identity: { panel_id: panelId, key_id: keys.key_id, public_jwk: keys.public_jwk },
        privateJwk: keys.private_jwk,
        body: bodyStr,
        method: "POST",
        path: `/api/federation/v1/leases/${ref}/renew`,
        messageId: uuid(),
      });
      const res = await app.request(`http://panel.local/api/federation/v1/leases/${ref}/renew`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: bodyStr,
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    }

    try {
      const grant = await makeGrant({ expiresInMs: 3_600_000 });
      const runtime = runtimeStub();
      // 租约以 2s TTL 预留：这样"续约真的把到期时间往后推"是可观测的
      // （若当前剩余时间已经比 TTL 长，monotonic max 会让续约成为 no-op —— 那是正确的防回退行为）。
      const reserved = await reserve(grant, { deps: runtime.deps, ttlSeconds: 2 });
      assert.equal(reserved.ok, true);
      const ref = reserved.lease.lease_ref;
      const intentId = reserved.lease.intent_id;

      // 同一 revision（home 侧在 Forward 没改版时只能这么发），ttl=2s → 窗口每两秒一格。
      const ttlSeconds = 2;
      const before = Date.now();
      const first = await signedRenew(ref, { intent_id: intentId, revision: 1, ttl_seconds: ttlSeconds });
      assert.equal(first.status, 200, JSON.stringify(first));
      const w1 = Math.floor(before / (ttlSeconds * 1000));

      // 睡过一个窗口（并留出余量），再续一次。
      await new Promise((r) => setTimeout(r, 2_300));
      const mid = Date.now();
      const second = await signedRenew(ref, { intent_id: intentId, revision: 1, ttl_seconds: ttlSeconds });
      assert.equal(second.status, 200, JSON.stringify(second));
      const w2 = Math.floor(mid / (ttlSeconds * 1000));

      assert.ok(w2 > w1, `test needs the clock to cross a window (w1=${w1} w2=${w2})`);
      assert.ok(
        new Date(second.body.expires_at).getTime() > new Date(first.body.expires_at).getTime(),
        `cross-window renewal must extend: ${first.body.expires_at} -> ${second.body.expires_at}`,
      );

      const row = await db.federationLease.findUnique({ where: { lease_ref: ref } });
      assert.equal(row.expires_at.toISOString(), new Date(second.body.expires_at).toISOString());

      // 同一窗口内的重投递：返回首次结果，**不推期**（幂等的收益还在）。
      const t1 = Date.now();
      const third = await signedRenew(ref, { intent_id: intentId, revision: 1, ttl_seconds: 60 });
      const t2 = Date.now();
      const fourth = await signedRenew(ref, { intent_id: intentId, revision: 1, ttl_seconds: 60 });
      const sameWindow = Math.floor(t1 / 60_000) === Math.floor(t2 / 60_000);
      if (sameWindow) {
        assert.equal(fourth.body.expires_at, third.body.expires_at, "a same-window replay must not move the deadline");
        const renewRows = await db.federationIntent.count({ where: { intent_id: intentId, action: { startsWith: "renew@" } } });
        // 1s 窗口两次 + 60s 窗口一次 = 3 行；同窗口的重投递不新增行。
        assert.equal(renewRows, 3, `expected 3 renew ledger rows, got ${renewRows}`);
      }
      // 不论窗口是否跨越，到期时间都不许倒退。
      assert.ok(new Date(fourth.body.expires_at).getTime() >= new Date(third.body.expires_at).getTime());
    } finally {
      await setFederationEnabled(false);
      resetPanelIdentityCache();
    }
  });

  test("task-11: a contract-named usage push (top-level + lease_id) lands; unknown keys still 400", async () => {
    const { createApp } = await import("../src/app.ts");
    const { ensurePanelIdentity, setFederationEnabled, resetPanelIdentityCache } = await import(
      "../src/services/federation/identity.ts"
    );
    const { buildSignatureHeaders } = await import("../src/services/federation/signing.ts");
    const { generatePanelKeyPair } = await import("../src/services/federation/keys.ts");

    const app = createApp();
    const keys = await generatePanelKeyPair();
    await db.federationPeer.update({
      where: { peer_panel_id: panelId },
      data: { public_keys: [{ key_id: keys.key_id, jwk: keys.public_jwk, state: "active", not_after: null }] },
    });
    await ensurePanelIdentity();
    await setFederationEnabled(true);

    async function signedPost(path, body) {
      const bodyStr = JSON.stringify(body);
      const headers = await buildSignatureHeaders({
        identity: { panel_id: panelId, key_id: keys.key_id, public_jwk: keys.public_jwk },
        privateJwk: keys.private_jwk,
        body: bodyStr,
        method: "POST",
        path,
        messageId: uuid(),
      });
      const res = await app.request(`http://panel.local${path}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: bodyStr,
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    }

    try {
      const usageId = `u-${uuid().slice(0, 8)}`;
      // 契约 §4.1 形状：顶层字段 + `lease_id`（历史字段名，解析器按别名接受）。
      const pushed = await signedPost("/api/federation/v1/usage", {
        usage_id: usageId,
        lease_id: `lease-usage-${nonce}`,
        window_start: new Date(Date.now() - 60_000).toISOString(),
        window_end: new Date().toISOString(),
        bytes_in: 11,
        bytes_out: 22,
        connections: 3,
      });
      assert.equal(pushed.status, 200, JSON.stringify(pushed));
      assert.equal(pushed.body.duplicate, false);

      const row = await db.federationUsageRecord.findUnique({ where: { usage_id: usageId } });
      assert.ok(row, "the usage fact must really be persisted");
      assert.equal(row.lease_ref, `lease-usage-${nonce}`);
      assert.equal(Number(row.bytes_in), 11);
      assert.equal(row.attribution, "unattributed", "no placement row => unattributed bucket (by design)");

      // 未知键仍然 fail-closed。
      const bogus = await signedPost("/api/federation/v1/usage", {
        usage_id: `u-${uuid().slice(0, 8)}`,
        lease_ref: "lease-x",
        window_start: new Date(Date.now() - 60_000).toISOString(),
        window_end: new Date().toISOString(),
        foo: 1,
      });
      assert.equal(bogus.status, 400, JSON.stringify(bogus));
      assert.equal(bogus.body.code, "message_malformed");
    } finally {
      await db.federationUsageRecord.deleteMany({ where: { peer_panel_id: panelId } });
      await setFederationEnabled(false);
      resetPanelIdentityCache();
    }
  });

  test("task-12: the applied federated leg is published into the node's authoritative desired snapshot", async () => {
    const { buildDesiredNodeSnapshot } = await import("../src/services/agent-command-bus.ts");
    const { resetOrchestrator, setOrchestrator } = await import("../src/services/relay-wiring.ts");

    const seen = [];
    const fake = {
      async dispatchEgress(input) {
        seen.push({ kind: "egress", ...input });
        return { ok: true, result: { commandId: "c-e", revision: input.revision, ack: {} }, egress_host: "10.42.0.7", egress_port: input.egressPort };
      },
      async dispatchIngress(input) {
        seen.push({ kind: "ingress", ...input });
        return { ok: true, result: { commandId: "c-i", revision: input.revision, ack: {} } };
      },
      async removeTunnel() {
        return { ok: true, result: { commandId: "c-r", revision: 1, ack: {} } };
      },
    };
    setOrchestrator(fake);
    try {
      // 0) 基线：**没有联邦腿的节点**，快照必须逐字节是今天的样子（tunnels 空、无 skipped）。
      const bare = await db.node.create({
        data: {
          node_group_id: group.id,
          node_id: `fed-bare-${nonce}`,
          connect_ip: "10.42.0.8",
          status: "active",
          role: "egress",
          port_range_min: 19400,
          port_range_max: 19499,
          node_credential_hash: uuid().replace(/-/g, "").padEnd(64, "0").slice(0, 64),
          credential_revoked: false,
        },
      });
      created.extraNodeIds.push(bare.id);
      assert.deepEqual(await buildDesiredNodeSnapshot(bare.id), {
        version: "tunex-v3", node_db_id: bare.id, links: [], tunnels: [], skipped: [],
      });
      // 本文件里前面的用例可能已经留下活跃联邦腿，所以这里按**增量**断言，而不是裸的 0/1。
      const before = await buildDesiredNodeSnapshot(node.id);

      const grant = await makeGrant();
      const runtime = runtimeStub();
      const reserved = await reserve(grant, { deps: runtime.deps });
      assert.equal(reserved.ok, true);
      const ref = reserved.lease.lease_ref;

      // 真实 apply（默认 dispatch 钩子 + 假 orchestrator）：配置必须落库。
      const applied = await applyRemoteLease(
        { lease_ref: ref, intent_id: reserved.lease.intent_id, revision: 1, targets: [{ host: "203.0.113.9", port: 443 }], protocol: "tcp" },
        { db, audit: () => {}, teardown: null },
      );
      assert.equal(applied.ok, true, applied.ok ? "" : applied.message);
      assert.equal(seen.length, 1);

      const leaseRow = await db.federationLease.findUnique({ where: { lease_ref: ref } });
      assert.ok(leaseRow.applied_config, "apply must persist the exact config it dispatched");
      assert.equal(leaseRow.applied_config.id, `tunex-fed-${ref}-egress`);
      assert.equal(leaseRow.applied_config.mode, "EGRESS");
      assert.equal(leaseRow.applied_config.egress_port, reserved.port);
      assert.equal(leaseRow.applied_config.revision, 1);

      // 1) 快照里必须能看到这条腿（这就是 Agent 不再剪它的原因）。
      const withLeg = await buildDesiredNodeSnapshot(node.id);
      assert.equal(withLeg.tunnels.length, before.tunnels.length + 1, JSON.stringify(withLeg));
      const published = withLeg.tunnels.find((t) => t.id === `tunex-fed-${ref}-egress`);
      assert.ok(published, "the federated leg must be published");
      assert.equal(published.revision, 1);
      assert.equal(published.egress_port, reserved.port);
      assert.deepEqual(published.targets, [{ host: "203.0.113.9", port: 443, weight: 1, order: 10 }]);
      // 既有 tunnel 派生条目一条不差（同一批 id、同样的顺序前缀）。
      assert.deepEqual(withLeg.tunnels.slice(0, before.tunnels.length).map((t) => t.id), before.tunnels.map((t) => t.id));
      assert.equal(withLeg.skipped.length, 0);

      // 2) 到期即不发布（host 到期必须停服）。
      await db.federationLease.update({ where: { lease_ref: ref }, data: { expires_at: new Date(Date.now() - 1_000) } });
      const expired = await buildDesiredNodeSnapshot(node.id);
      assert.equal(expired.tunnels.some((t) => t.id === `tunex-fed-${ref}-egress`), false, JSON.stringify(expired));
      assert.equal(expired.tunnels.length, before.tunnels.length);

      // 3) 终态也不发布。
      await db.federationLease.update({
        where: { lease_ref: ref },
        data: { state: "released", released_at: new Date(), expires_at: new Date(Date.now() + 3_600_000) },
      });
      const releasedSnapshot = await buildDesiredNodeSnapshot(node.id);
      assert.equal(releasedSnapshot.tunnels.some((t) => t.id === `tunex-fed-${ref}-egress`), false, JSON.stringify(releasedSnapshot));
      assert.equal(releasedSnapshot.tunnels.length, before.tunnels.length);

      // 4) 回到 active 又出现（幂等，不是一次性开关）。
      await db.federationLease.update({ where: { lease_ref: ref }, data: { state: "active" } });
      const again = await buildDesiredNodeSnapshot(node.id);
      assert.equal(again.tunnels.some((t) => t.id === `tunex-fed-${ref}-egress`), true);
      assert.equal(again.tunnels.length, before.tunnels.length + 1);
    } finally {
      resetOrchestrator();
    }
  });

  /* ---------------- 清理 ---------------- */

  after(async () => {
    // 只清本文件造的夹具（按 id/前缀），避免影响同一个库里的其它测试。
    await db.federationLease.deleteMany({ where: { peer_panel_id: panelId } });
    await db.federationPlacement.deleteMany({ where: { peer_panel_id: panelId } });
    if (created.nodeId !== null) await db.nodeStateReport.deleteMany({ where: { node_id: created.nodeId } });
    await db.federationIntent.deleteMany({ where: { peer_panel_id: panelId } });
    await db.federationGrant.deleteMany({ where: { peer_id: created.peerId ?? -1 } });
    await db.federationPeer.deleteMany({ where: { peer_panel_id: panelId } });
    if (created.nodeId !== null) {
      await db.nodePortLease.deleteMany({ where: { node_id: created.nodeId } });
      await db.node.deleteMany({ where: { id: created.nodeId } });
    }
    for (const extra of created.extraNodeIds) {
      await db.nodePortLease.deleteMany({ where: { node_id: extra } });
      await db.node.deleteMany({ where: { id: extra } });
    }
    if (created.groupId !== null) await db.nodeGroup.deleteMany({ where: { id: created.groupId } });
    if (created.workspaceId !== null) await db.workspace.deleteMany({ where: { id: created.workspaceId } });
    if (created.userId !== null) await db.user.deleteMany({ where: { id: created.userId } });
    await db.$disconnect();
    redis.disconnect();
  });
}
