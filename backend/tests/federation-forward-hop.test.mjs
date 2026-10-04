/**
 * V5.5 WP15 产品级接线 —— Forward 远端出口腿（homeless egress → peer）的 MySQL 集成测试。
 *
 * 运行：`TUNEX_DB_TEST=1 bun test tests/federation-forward-hop.test.mjs`（需要真 MySQL + Redis）。
 *
 * 与 `src/services/__tests__/federation-forward-hop.test.ts` 的分工：
 *   · 那边是**纯逻辑 + 替身**，钉判定、幂等键与请求形状；
 *   · 这边跑**真 MySQL**，钉"跨表副作用"：`federation_placement` 的最终行、
 *     `tunnel` 的投影列、以及**本机没有为远端那一跳建任何资源**（`node_port_lease`
 *     与 `node` 行都不该多出来）。
 *
 * 下行侧（Agent 下发 / 对面面板）用注入替身：本机没有第二个真实 Panel，
 * 而"这一跳没有变成本机资源"这件事**必须**用真库验 —— 替身会把这件事掩盖掉。
 * 真实的两面板拓扑由 Gate 脚本负责，本文件不假装覆盖它。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";

if (process.env.TUNEX_DB_TEST !== "1") {
  test("federation forward-hop MySQL integration (requires TUNEX_DB_TEST=1)", { skip: true }, () => {});
} else {
  process.env.AUTH_SECRET ??= "test-only-auth-secret-must-not-be-used-in-production";
  process.env.LICENSE_SECRET ??= "test-only-license-secret-must-not-be-used-in-production";
  process.env.PAYMENTS_ENABLED = "false";

  const { randomUUID } = await import("node:crypto");
  const { db } = await import("../src/db.ts");
  // portPool 的并发锁走 Redis；不显式断开，node:test 会挂在事件循环上。
  const { redis } = await import("../src/redis.ts");
  const {
    delegateFederatedEgress,
    federatedEgressIntentId,
    releaseFederatedEgress,
    releaseStaleFederatedEgressForTunnel,
  } = await import("../src/services/federation/forward-hop.ts");
  const { registerRollout } = await import("../src/services/forward-rollout-exec.ts");

  const nonce = randomUUID().slice(0, 8);
  const peerPanelId = `it-fh-peer-${nonce}`;
  const created = { userId: null, workspaceId: null, groupId: null, nodeId: null, peerId: null, tunnelIds: [] };

  /* ---------------- 夹具 ---------------- */

  const user = await db.user.create({ data: { email: `fh-${nonce}@example.test` } });
  created.userId = user.id;
  const workspace = await db.workspace.create({
    data: { slug: `fh-${nonce}`, name: `fh ${nonce}`, kind: "team", created_by_id: user.id },
  });
  created.workspaceId = workspace.id;
  const inGroup = await db.nodeGroup.create({
    data: { name: `fh-in-${nonce}`, node_type: "in", user_id: user.id, workspace_id: workspace.id, port_range: "19200-19299" },
  });
  created.groupId = inGroup.id;
  const ingressNode = await db.node.create({
    data: {
      node_group_id: inGroup.id,
      node_id: `fh-ing-${nonce}`,
      connect_ip: "10.42.1.7",
      status: "active",
      role: "ingress",
      port_range_min: 19200,
      port_range_max: 19299,
      node_credential_hash: randomUUID().replace(/-/g, "").padEnd(64, "0").slice(0, 64),
      credential_revoked: false,
      lifecycle: "active",
    },
  });
  created.nodeId = ingressNode.id;
  const peer = await db.federationPeer.create({
    data: {
      peer_panel_id: peerPanelId,
      display_name: `it peer ${nonce}`,
      endpoint_url: "http://panel-b.example.test:3000",
      public_keys: [],
      status: "trusted",
    },
  });
  created.peerId = peer.id;
  // 联邦开关：forward-hop 与 CLI 校验都会读它。
  const existingSetting = await db.federationSetting.findFirst();
  const settingRow = existingSetting ?? (await db.federationSetting.create({
    data: {
      panel_id: `it-panel-${nonce}`,
      key_id: `it-key-${nonce}`,
      private_key_enc: "not-used",
      public_key: {},
      enabled: true,
    },
  }));
  const previousEnabled = settingRow.enabled;
  if (!previousEnabled) await db.federationSetting.update({ where: { id: settingRow.id }, data: { enabled: true } });

  /* ---------------- 替身：下行 transport ---------------- */

  function fakeSender(plan = {}) {
    const calls = [];
    const sender = async (input) => {
      calls.push({ method: input.method, path: input.path, body: input.body });
      if (input.method === "DELETE") return { ok: true, status: 200, body: { ok: true, state: "released" }, messageId: "m-del" };
      if (input.path.endsWith("/apply")) {
        if (plan.failApply) {
          return { ok: false, code: "quota_exhausted", status: 429, message: "容量耗尽", retryable: false, messageId: "m-apply" };
        }
        return {
          ok: true,
          status: 200,
          body: {
            ok: true,
            state: "active",
            applied_revision: Number(input.body.revision),
            lease_epoch: 3,
            replayed: false,
            node_ref: "9001",
            port: plan.remotePort ?? 22060,
          },
          messageId: "m-apply",
        };
      }
      if (plan.failReserve) {
        return { ok: false, code: "peer_unreachable", status: 0, message: "超时", retryable: true, messageId: "m-res" };
      }
      return {
        ok: true,
        status: 200,
        body: {
          lease_ref: plan.leaseRef ?? `lease-${nonce}`,
          lease_epoch: 3,
          state: "reserved",
          node_ref: "9001",
          node_address: plan.remoteAddress ?? "203.0.113.60",
          port: plan.remotePort ?? 22060,
          expires_at: new Date(Date.now() + 300_000).toISOString(),
          applied_revision: null,
          replayed: false,
          reused: false,
        },
        messageId: "m-res",
      };
    };
    return { sender, calls };
  }

  /* ---------------- 替身：本机 orchestrator ---------------- */

  function fakeOrchestrator() {
    const calls = { dispatchIngress: [], dispatchEgress: [], dispatchDirect: [], removeTunnel: [], releaseOwnership: [] };
    return {
      calls,
      dispatchIngress: async (input) => {
        calls.dispatchIngress.push(input);
        return { ok: true, result: { commandId: "cmd-i", revision: Number(input.revision), ack: {} } };
      },
      dispatchEgress: async (input) => {
        calls.dispatchEgress.push(input);
        return { ok: true, result: { commandId: "cmd-e", revision: Number(input.revision), ack: {} }, egress_host: "10.42.1.99", egress_port: Number(input.egressPort) };
      },
      dispatchDirect: async (input) => {
        calls.dispatchDirect.push(input);
        return { ok: true, result: { commandId: "cmd-d", revision: Number(input.revision), ack: {} } };
      },
      removeTunnel: async (input) => {
        calls.removeTunnel.push(input);
        return { ok: true, result: { commandId: "cmd-r", revision: Number(input.revision), ack: {} } };
      },
      releaseOwnership: async (input) => {
        calls.releaseOwnership.push(input);
        return { ok: true };
      },
    };
  }

  /** 建一条"出口腿在远端 peer"的 RELAY Forward（tunnel + revision snapshot）。 */
  async function createFederatedForward(revision = 2) {
    const tunnel = await db.tunnel.create({
      data: {
        name: `fh-fwd-${nonce}-${revision}`,
        category: "port_forward",
        tunnel_type: "tcp",
        forward_protocol: "tcp",
        tunnel_mode: "relay",
        listen_ip: "0.0.0.0",
        listen_port: null,
        forward_addresses: [],
        forward_addresses_protocol: [],
        load_balance_type: "round",
        ip_type: "ipv4",
        order_by: 1000,
        in_node_group_id: inGroup.id,
        out_node_group_id: null,
        user_id: user.id,
        workspace_id: workspace.id,
        ingress_node_id: ingressNode.id,
        egress_node_id: null,
        egress_pool_id: null,
        egress_port: null,
        remote_host: "10.9.9.9",
        remote_port: 8080,
        federated_egress_peer: peerPanelId,
        desired_status: "active",
        apply_status: "pending",
        config_revision: 0,
        applied_revision: null,
      },
    });
    created.tunnelIds.push(tunnel.id);
    const snapshot = await db.forwardRevision.create({
      data: {
        tunnel_id: tunnel.id,
        revision,
        name: tunnel.name,
        desired_status: "active",
        mode: "relay",
        protocol: "tcp",
        ingress_node_id: ingressNode.id,
        egress_node_id: null,
        listen_port: null,
        egress_pool_id: null,
        egress_port: null,
        federated_egress_peer: peerPanelId,
        targets: [{ host: "10.9.9.9", port: 8080, weight: 1, order_by: 10 }],
      },
    });
    await db.tunnel.update({
      where: { id: tunnel.id },
      data: { config_revision: revision, desired_revision_id: snapshot.id },
    });
    return { tunnelId: tunnel.id, revision };
  }

  const impact = {
    metadata_only: false,
    runtime_change: true,
    changes_external_address: true,
    listen_port_change: true,
    listener_replacement: true,
    ingress_node_change: false,
    egress_node_change: true,
    federated_egress_change: true,
    middle_node_change: false,
    mode_change: true,
    target_change: false,
    egress_target_change: true,
    nodes_prepare_drain: [],
    binding_required: false,
    port_status: "auto",
    desired_address: null,
  };

  /* ---------------- 测试 ---------------- */

  test("A. 远端委托：真库只落镜像行，本机不为那一跳建任何资源", async () => {
    const { tunnelId, revision } = await createFederatedForward(2);
    const { sender, calls } = fakeSender();

    const outcome = await delegateFederatedEgress(
      {
        tunnelId,
        revision,
        declaredPeer: peerPanelId,
        mode: "relay",
        ingress_node_id: ingressNode.id,
        local_egress_node_id: null,
        protocol: "tcp",
        targets: [{ host: "10.9.9.9", port: 8080, weight: 1, order_by: 10 }],
      },
      { sender, now: () => new Date() },
    );

    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.equal(outcome.intent_id, federatedEgressIntentId(tunnelId, revision));
    assert.equal(outcome.next_hop, "203.0.113.60:22060", "next_hop 必须来自 host 响应（不许猜 IP）");
    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.path}`),
      ["POST /api/federation/v1/leases", `POST /api/federation/v1/leases/${outcome.lease_ref}/apply`],
    );

    const row = await db.federationPlacement.findUnique({
      where: { peer_panel_id_intent_id: { peer_panel_id: peerPanelId, intent_id: outcome.intent_id } },
    });
    assert.ok(row, "镜像行必须存在（它是 home 侧唯一的证据行）");
    assert.equal(row.tunnel_id, tunnelId);
    assert.equal(row.hop_role, "egress");
    assert.equal(row.desired_revision, revision);
    assert.equal(row.applied_revision, revision);
    assert.equal(row.state, "active");
    assert.equal(row.lease_ref, outcome.lease_ref);
    assert.equal(row.peer_node_ref, "9001");
    assert.equal(row.peer_port, 22060);

    // ── 红线：远端资源**不得**变成本机资源（契约 §1/§7）──
    const leases = await db.nodePortLease.findMany({ where: { tunnel_id: tunnelId } });
    assert.equal(leases.length, 0, "远端那一跳不得在本机产生 node_port_lease");
    // 也没有第二份 node 行（远端节点只以 peer_node_ref 字符串存在）。
    const remoteNodes = await db.node.findMany({ where: { node_id: { contains: "9001" } } });
    assert.equal(remoteNodes.length, 0);
  });

  test("B. 远端 reserve 失败：镜像 degraded、本机无任何资源、不回落本地", async () => {
    const { tunnelId, revision } = await createFederatedForward(2);
    const { sender } = fakeSender({ failReserve: true });

    const outcome = await delegateFederatedEgress(
      {
        tunnelId,
        revision,
        declaredPeer: peerPanelId,
        mode: "relay",
        ingress_node_id: ingressNode.id,
        local_egress_node_id: null,
        protocol: "tcp",
        targets: [{ host: "10.9.9.9", port: 8080 }],
      },
      { sender, now: () => new Date() },
    );

    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, "peer_unreachable");
    assert.equal(outcome.retryable, true);
    const row = await db.federationPlacement.findUnique({
      where: { peer_panel_id_intent_id: { peer_panel_id: peerPanelId, intent_id: outcome.intent_id } },
    });
    assert.equal(row.state, "degraded");
    assert.equal(row.last_error_code, "peer_unreachable");
    assert.equal((await db.nodePortLease.count({ where: { tunnel_id: tunnelId } })), 0);
  });

  test("C. 释放：镜像落 expired，且重复释放幂等", async () => {
    const { tunnelId, revision } = await createFederatedForward(2);
    const { sender } = fakeSender();
    const delegated = await delegateFederatedEgress(
      {
        tunnelId,
        revision,
        declaredPeer: peerPanelId,
        mode: "relay",
        ingress_node_id: ingressNode.id,
        local_egress_node_id: null,
        protocol: "tcp",
        targets: [{ host: "10.9.9.9", port: 8080 }],
      },
      { sender, now: () => new Date() },
    );
    assert.equal(delegated.ok, true);

    const first = await releaseFederatedEgress({ tunnelId, revision }, { sender, now: () => new Date() });
    assert.equal(first.ok, true);
    const row = await db.federationPlacement.findUnique({
      where: { peer_panel_id_intent_id: { peer_panel_id: peerPanelId, intent_id: delegated.intent_id } },
    });
    assert.equal(row.state, "expired");

    // 幂等：第二次仍然是 ok（远端已是终态 = 已经没了），且状态不回退。
    const second = await releaseFederatedEgress({ tunnelId, revision }, { sender, now: () => new Date() });
    assert.equal(second.ok, true);
    const again = await db.federationPlacement.findUnique({
      where: { peer_panel_id_intent_id: { peer_panel_id: peerPanelId, intent_id: delegated.intent_id } },
    });
    assert.equal(again.state, "expired");
  });

  test("D. 换代清理：释放除 keepRevision 之外的旧腿（每次重试不留在对面留孤儿）", async () => {
    const { tunnelId, revision } = await createFederatedForward(2);
    const senderSpy = fakeSender();
    // 第 2 代
    const first = await delegateFederatedEgress(
      {
        tunnelId,
        revision,
        declaredPeer: peerPanelId,
        mode: "relay",
        ingress_node_id: ingressNode.id,
        local_egress_node_id: null,
        protocol: "tcp",
        targets: [{ host: "10.9.9.9", port: 8080 }],
      },
      { sender: senderSpy.sender, now: () => new Date() },
    );
    assert.equal(first.ok, true);
    // 第 3 代（= 重试/编辑后又委托了一次）
    const second = await delegateFederatedEgress(
      {
        tunnelId,
        revision: revision + 1,
        declaredPeer: peerPanelId,
        mode: "relay",
        ingress_node_id: ingressNode.id,
        local_egress_node_id: null,
        protocol: "tcp",
        targets: [{ host: "10.9.9.9", port: 8080 }],
      },
      { sender: senderSpy.sender, now: () => new Date() },
    );
    assert.equal(second.ok, true);

    const result = await releaseStaleFederatedEgressForTunnel(tunnelId, revision + 1, {
      sender: senderSpy.sender,
      now: () => new Date(),
    });
    assert.equal(result.released, 1);
    const oldRow = await db.federationPlacement.findUnique({
      where: { peer_panel_id_intent_id: { peer_panel_id: peerPanelId, intent_id: first.intent_id } },
    });
    const keepRow = await db.federationPlacement.findUnique({
      where: { peer_panel_id_intent_id: { peer_panel_id: peerPanelId, intent_id: second.intent_id } },
    });
    assert.equal(oldRow.state, "expired");
    assert.equal(keepRow.state, "active", "当前这一代不得被清理");
  });

  test("E. rollout 接线：真库跑完一次「远端出口 + 本机入口」，入口 next_hop = host 返回的地址", async () => {
    const { tunnelId, revision } = await createFederatedForward(2);
    const orch = fakeOrchestrator();
    const { sender, calls } = fakeSender();

    const result = await registerRollout(
      { tunnelId, impact, revision, baseRevision: null },
      { db, orchestrator: orch, runtimeUse: async () => null, federatedSender: sender, now: () => new Date() },
    );

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.status, "done");
    // **不本机下发出口**：这一跳在对面。
    assert.equal(orch.calls.dispatchEgress.length, 0);
    // 入口按 host 给的地址启动（不是猜的 IP）。
    assert.equal(orch.calls.dispatchIngress.length, 1);
    assert.equal(orch.calls.dispatchIngress[0].nextHop, "203.0.113.60:22060");

    // 远端腿的调用：只允许 `POST /leases` 与 `POST /leases/:ref/apply` 这两个形状。
    // PREPARE 与 CUTOVER 各委托一次是**有意的**（同一 intent/revision 幂等重发，
    // host 侧返回首次结果），但绝不允许出现第三种路径（例如偷偷发本机命令）。
    const placementForIntent = await db.federationPlacement.findUnique({
      where: { peer_panel_id_intent_id: { peer_panel_id: peerPanelId, intent_id: federatedEgressIntentId(tunnelId, revision) } },
    });
    assert.ok(placementForIntent?.lease_ref, "镜像行必须带 host 给的 lease_ref");
    const allowed = [
      "POST /api/federation/v1/leases",
      `POST /api/federation/v1/leases/${placementForIntent.lease_ref}/apply`,
    ];
    for (const call of calls) {
      assert.ok(allowed.includes(`${call.method} ${call.path}`), `意外的远端调用：${call.method} ${call.path}`);
    }
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].path, "/api/federation/v1/leases");

    const tunnel = await db.tunnel.findUnique({ where: { id: tunnelId } });
    assert.equal(tunnel.apply_status, "active");
    assert.equal(tunnel.applied_revision, revision);
    // 本机没有出口节点、没有出口端口 —— 远端那一跳不在本机 ownership 里。
    assert.equal(tunnel.egress_node_id, null);
    assert.equal(tunnel.egress_port, null);
    assert.equal(tunnel.federated_egress_peer, peerPanelId);

    const egressLeases = await db.nodePortLease.findMany({ where: { tunnel_id: tunnelId } });
    assert.equal(egressLeases.length, 1, "只应有入口一个本地端口租约");
    assert.equal(egressLeases[0].lease_type, "ingress");

    const placement = await db.federationPlacement.findUnique({
      where: { peer_panel_id_intent_id: { peer_panel_id: peerPanelId, intent_id: federatedEgressIntentId(tunnelId, revision) } },
    });
    assert.equal(placement.state, "active");
    assert.equal(placement.applied_revision, revision);
  });

  test("F. rollout 接线：远端失败 ⇒ 整条 rollout 失败、本机无出口资源、绝不回落本地", async () => {
    const { tunnelId, revision } = await createFederatedForward(2);
    const orch = fakeOrchestrator();
    const { sender, calls } = fakeSender({ failReserve: true });

    const result = await registerRollout(
      { tunnelId, impact, revision, baseRevision: null },
      { db, orchestrator: orch, runtimeUse: async () => null, federatedSender: sender, now: () => new Date() },
    );

    assert.equal(result.ok, false);
    // 没有本机出口下发 = 没有静默重放置（契约 §5：禁止回落本地）。
    assert.equal(orch.calls.dispatchEgress.length, 0);
    assert.equal(orch.calls.dispatchIngress.length, 0);
    assert.equal(calls.filter((c) => c.path.endsWith("/apply")).length, 0);

    const tunnel = await db.tunnel.findUnique({ where: { id: tunnelId } });
    assert.equal(tunnel.egress_node_id, null);
    assert.equal(tunnel.egress_port, null);
    assert.notEqual(tunnel.apply_status, "active");

    const placement = await db.federationPlacement.findUnique({
      where: { peer_panel_id_intent_id: { peer_panel_id: peerPanelId, intent_id: federatedEgressIntentId(tunnelId, revision) } },
    });
    assert.equal(placement.state, "degraded");
    // 入口端口的补偿：本机不留占用（入口租约由失败路径释放）。
    const live = await db.nodePortLease.findMany({ where: { tunnel_id: tunnelId, status: "active" } });
    assert.equal(live.length, 0);
  });

  test("G. 创建/重试路径（scheduler）：只分配入口端口，出口腿委托给 peer", async () => {
    // 这是"创建一条声明远端出口的 Forward"真正走的那条路
    // （forward-service.createForward → reapplyRelayTunnel）。用真库 + 假
    // orchestrator/callPeer 跑它，钉住三件事：
    //   1. 本机**不**选出口节点、**不**分配出口端口；
    //   2. 入口的 next_hop 是 host 返回的地址（不猜 IP）；
    //   3. tunnel 行落 active 且 egress_node_id / egress_port 都是 NULL（本机没有那一跳）。
    const { tunnelId } = await createFederatedForward(1);
    const orch = fakeOrchestrator();
    const { sender, calls } = fakeSender();

    const { reapplyRelayTunnel } = await import("../src/services/scheduler.ts");
    const result = await reapplyRelayTunnel(tunnelId, orch, {
      db,
      runtimeUse: async () => null,
      federatedSender: sender,
      now: () => new Date(),
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(orch.calls.dispatchEgress.length, 0, "远端出口不得走本机 dispatchEgress");
    assert.equal(orch.calls.dispatchIngress.length, 1);
    assert.equal(orch.calls.dispatchIngress[0].nextHop, "203.0.113.60:22060");
    assert.equal(calls[0].path, "/api/federation/v1/leases");

    const tunnel = await db.tunnel.findUnique({ where: { id: tunnelId } });
    assert.equal(tunnel.apply_status, "active");
    assert.equal(tunnel.egress_node_id, null);
    assert.equal(tunnel.egress_port, null);

    const leases = await db.nodePortLease.findMany({ where: { tunnel_id: tunnelId } });
    assert.equal(leases.length, 1, "只应有入口端口租约（出口端口归 host）");
    assert.equal(leases[0].lease_type, "ingress");

    const placement = await db.federationPlacement.findUnique({
      where: {
        peer_panel_id_intent_id: {
          peer_panel_id: peerPanelId,
          // 创建路径每走一次都会 bump revision ⇒ intent 是"新的一代"。这正是
          // 必须在委托前清理上一代的原因（见 D 用例）。
          intent_id: federatedEgressIntentId(tunnelId, Number(tunnel.config_revision)),
        },
      },
    });
    assert.equal(placement.state, "active");
    assert.equal(placement.applied_revision, Number(tunnel.config_revision));
  });

  /* ---------------- 清理 ---------------- */

  after(async () => {
    await db.federationPlacement.deleteMany({ where: { peer_panel_id: peerPanelId } });
    if (created.tunnelIds.length > 0) {
      await db.forwardRollout.deleteMany({ where: { tunnel_id: { in: created.tunnelIds } } });
      await db.forwardRevision.deleteMany({ where: { tunnel_id: { in: created.tunnelIds } } });
      await db.nodePortLease.deleteMany({ where: { tunnel_id: { in: created.tunnelIds } } });
      await db.tunnel.deleteMany({ where: { id: { in: created.tunnelIds } } });
    }
    await db.federationPeer.deleteMany({ where: { peer_panel_id: peerPanelId } });
    if (created.nodeId !== null) {
      await db.nodeStateReport.deleteMany({ where: { node_id: created.nodeId } });
      await db.node.deleteMany({ where: { id: created.nodeId } });
    }
    if (created.groupId !== null) await db.nodeGroup.deleteMany({ where: { id: created.groupId } });
    if (created.workspaceId !== null) await db.workspace.deleteMany({ where: { id: created.workspaceId } });
    if (created.userId !== null) await db.user.deleteMany({ where: { id: created.userId } });
    await db.federationSetting.update({ where: { id: settingRow.id }, data: { enabled: previousEnabled } }).catch(() => {});
    await db.$disconnect();
    redis.disconnect();
  });
}
