/**
 * V5-WP13.5B —— Route Profile HTTP / DB 契约测试（`DEVELOPMENT.md` §9.4.2–§9.4.6 / §12.1）。
 *
 * 契约（FROZEN）：`docs/v5-wp13-5b-route-profile-contract.md`。
 *
 * 为什么这一组放在 `backend/tests/*.mjs`（node --test）而不是 `bun test src`：
 * 仓库里多个单测文件用 `mock.module` 替换共享模块（db / auth / scheduler…），
 * 在同一个 `bun test src` 进程里会互相污染（实测：注册接口在这种上下文中返回 403）。
 * 既有 DB/HTTP 用例（authorization / workspace-db / forward-revision-migration）
 * 一律放在本目录、由 `node --test` 每个文件独立进程执行 —— 这里沿用同一口径，
 * 也正是 CI 的 `bun run test` 覆盖面。
 *
 * 覆盖：
 *   · CRUD 的 workspace RBAC 分层（owner 可写 / viewer 只读 / 外部 workspace 404）；
 *   · impact analysis **只读**（调用前后 forward_revision / forward_rollout 行数不变）；
 *   · apply 落 provenance（forward_revision 快照 + tunnel 指针 + 申请账本）；
 *   · **模板发布不得静默重写正在运行的 Forward**（config_revision / applied_revision /
 *     revision 行数全部不变）；
 *   · 消费侧可见性：INTERNAL 对普通成员隐藏，PUBLIC 可见。
 *
 * 环境变量：
 *   TUNEX_DB_TEST=1   本文件才真正执行（未设置时整文件 skip）
 *   DATABASE_URL / REDIS_URL / AUTH_SECRET / LICENSE_SECRET 指向测试实例
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

const DB_TEST = process.env.TUNEX_DB_TEST === "1";

if (!DB_TEST) {
  test("route profile HTTP/DB integration (requires TUNEX_DB_TEST=1)", { skip: true }, () => {});
} else {
  process.env.AUTH_SECRET ??= "test-only-auth-secret-must-not-be-used-in-production";
  process.env.LICENSE_SECRET ??= "test-only-license-secret-must-not-be-used-in-production";
  process.env.PAYMENTS_ENABLED = "false";
  process.env.ALLOW_REGISTER_FALLBACK = "true";

  const { app } = await import("../src/app.ts");
  const { db } = await import("../src/db.ts");
  const { redis } = await import("../src/redis.ts");
  after(async () => {
    redis.disconnect();
    await db.$disconnect();
  });

  const nonce = randomUUID().slice(0, 8);
  const password = "ci-only-password-12";
  let seq = 0;
  let registerSeq = 0;

  async function request(path, method, cookie, body, workspaceId) {
    return app.request(`http://localhost${path}`, {
      method,
      headers: {
        "x-forwarded-for": `198.51.100.${++seq}`,
        ...(cookie ? { cookie, "x-csrf-token": "test" } : {}),
        ...(workspaceId ? { "x-workspace-id": String(workspaceId) } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }

  async function json(response) {
    return response.json();
  }

  /**
   * 注册 + 登录（走真实 HTTP 路径，与 `tests/workspace-db.test.mjs` 同口径）：
   * 账户凭据、personal workspace、成员行、策略发放全部由生产代码建立。
   */
  async function registerUser(label) {
    registerSeq += 1;
    const email = `rp-${label}-${nonce}-${registerSeq}@example.test`;
    const created = await request("/api/auth/register", "POST", "", { email, password });
    const createdBody = await json(created);
    assert.equal(created.status, 201, JSON.stringify(createdBody));
    const login = await request("/api/auth/login", "POST", "", { email, password });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    assert.ok(cookie.startsWith("access="));

    const user = await db.user.findUnique({ where: { email } });
    assert.ok(user);
    const personal = await db.workspace.findUnique({ where: { personal_user_id: user.id } });
    assert.ok(personal);
    return { id: user.id, email, workspaceId: personal.id, cookie };
  }

  /** 一个 workspace 内的入口节点（凭据 + 心跳齐全 ⇒ 能过既有 §13.4.2 准入）。 */
  async function createNode(workspaceId, userId, label, portBase) {
    const group = await db.nodeGroup.create({
      data: {
        token: `rp-group-${label}-${nonce}-${randomUUID()}`,
        name: `RP group ${label} ${nonce}`,
        node_type: "in",
        user_id: userId,
        workspace_id: workspaceId,
      },
    });
    const node = await db.node.create({
      data: {
        node_id: `rp-node-${label}-${nonce}-${randomUUID().slice(0, 6)}`,
        agent_id: `rp-agent-${label}-${nonce}-${randomUUID().slice(0, 6)}`,
        node_group_id: group.id,
        role: "both",
        status: "active",
        lifecycle: "active",
        connect_ip: "127.0.0.1",
        port_range_min: portBase,
        port_range_max: portBase + 200,
        last_seen_at: new Date(),
        node_credential_hash: createHash("sha256").update(`cred-${label}-${randomUUID()}`).digest("hex"),
      },
    });
    return { group, node };
  }

  const templateFor = (nodeId) => ({
    ingress: { kind: "fixed_node", node_id: nodeId },
    transit: [],
    egress: null,
  });

  test("HTTP: CRUD respects workspace RBAC and isolates workspaces", async () => {
    const owner = await registerUser("owner");
    const outsider = await registerUser("outsider");
    const { group, node } = await createNode(owner.workspaceId, owner.id, "crud-a", 41000);

    // 未认证：401。
    assert.equal((await request("/api/route-profiles", "GET", "")).status, 401);

    // 创建：需要 workspace 的 manage 权限（node 资源族，与 node-groups 同口径）。
    const created = await request(
      "/api/route-profiles",
      "POST",
      owner.cookie,
      { name: `RP ${nonce}`, description: "test", visibility: "PUBLIC", template: templateFor(node.id) },
      owner.workspaceId,
    );
    const createdBody = await json(created);
    assert.equal(created.status, 201, JSON.stringify(createdBody));
    const profileId = createdBody.data.id;
    assert.ok(profileId > 0);

    // 跨 workspace：读 / 改 / 删一律 404（不泄露存在性）。
    assert.equal((await request(`/api/route-profiles/${profileId}`, "GET", outsider.cookie)).status, 404);
    assert.equal(
      (await request(`/api/route-profiles/${profileId}`, "PATCH", outsider.cookie, { enabled: false })).status,
      404,
    );
    const ownList = await request("/api/route-profiles", "GET", outsider.cookie);
    assert.equal((await json(ownList)).data.total, 0);

    // workspace 内的只读成员：GET 通过，写 403 + error_layer=rbac。
    await db.workspaceMember.create({
      data: { workspace_id: owner.workspaceId, user_id: outsider.id, role: "viewer", active: true },
    });
    assert.equal(
      (await request(`/api/route-profiles/${profileId}`, "GET", outsider.cookie, undefined, owner.workspaceId)).status,
      200,
    );
    const viewerWrite = await request(
      `/api/route-profiles/${profileId}/versions`,
      "POST",
      outsider.cookie,
      { template: templateFor(node.id) },
      owner.workspaceId,
    );
    assert.equal(viewerWrite.status, 403);
    assert.equal((await json(viewerWrite)).error_layer, "rbac");

    // unknown visibility：fail-closed 400（不是默认成 INTERNAL/PUBLIC）。
    const badVisibility = await request(
      "/api/route-profiles",
      "POST",
      owner.cookie,
      { name: `RP bad ${nonce}`, visibility: "EVERYONE", template: templateFor(node.id) },
      owner.workspaceId,
    );
    assert.equal(badVisibility.status, 400);
    assert.equal((await json(badVisibility)).code, "invalid_input");

    // dynamic middle pool / 超跳数：422 unsupported_topology（合法但未开放的形态）。
    const unsupported = await request(
      "/api/route-profiles",
      "POST",
      owner.cookie,
      {
        name: `RP unsupported ${nonce}`,
        // dynamic middle pool（中间跳用候选池）在第一阶段**关闭**：合法形态、未开放能力。
        template: {
          ingress: { kind: "fixed_node", node_id: node.id },
          transit: [{ kind: "node_group", node_group_id: group.id, strategy: "round_robin" }],
          egress: null,
        },
      },
      owner.workspaceId,
    );
    assert.equal(unsupported.status, 422);
    assert.equal((await json(unsupported)).code, "unsupported_topology");
  });

  test("HTTP: impact analysis is read-only, apply writes provenance, and publishing never rewrites a running Forward", async () => {
    const owner = await registerUser("apply");
    const ingressA = await createNode(owner.workspaceId, owner.id, "apply-a", 43000);
    const ingressB = await createNode(owner.workspaceId, owner.id, "apply-b", 43500);
    // Forward 起点与模板 v1 解析出的节点**不同**，apply 才是真改动。
    const ingressOrig = await createNode(owner.workspaceId, owner.id, "apply-orig", 43700);

    const created = await request(
      "/api/route-profiles",
      "POST",
      owner.cookie,
      { name: `RP apply ${nonce}`, visibility: "INTERNAL", template: templateFor(ingressA.node.id) },
      owner.workspaceId,
    );
    const createdBody = await json(created);
    assert.equal(created.status, 201, JSON.stringify(createdBody));
    const profileId = createdBody.data.id;

    // 一条已存在的 DIRECT Forward（直接落库，避免依赖 Agent 侧创建流程）。
    // suspended：§13.3.6「suspended 编辑 = 存 desired 不启 runtime」——本用例验证的是
    // Route Profile 的契约（新 revision + provenance + 不静默重写），不需要数据面参与。
    const forward = await db.tunnel.create({
      data: {
        name: `RP forward ${nonce}`,
        category: "port_forward",
        tunnel_mode: "direct",
        forward_protocol: "tcp",
        tunnel_type: "tcp",
        forward_addresses: ["127.0.0.1:8080"],
        load_balance_type: "round",
        in_node_group_id: ingressOrig.group.id,
        workspace_id: owner.workspaceId,
        user_id: owner.id,
        ingress_node_id: ingressOrig.node.id,
        listen_port: 43100,
        remote_host: "127.0.0.1",
        remote_port: 8080,
        desired_status: "inactive",
        apply_status: "suspended",
        config_revision: 0,
      },
    });

    /** 不可变历史行数快照：只读接口与「发布不影响运行」的唯一判据。 */
    const historyCounts = async () => ({
      revisions: await db.forwardRevision.count({ where: { tunnel_id: forward.id } }),
      rollouts: await db.forwardRollout.count({ where: { tunnel_id: forward.id } }),
    });

    // ① 第一次 apply 之前：影响面为空（模板是意图，是否属于它只能由显式 apply 建立）。
    const impactBefore = await request(
      `/api/route-profiles/${profileId}/impact`,
      "GET",
      owner.cookie,
      undefined,
      owner.workspaceId,
    );
    assert.equal(impactBefore.status, 200);
    const impactBeforeBody = (await json(impactBefore)).data;
    assert.equal(impactBeforeBody.read_only, true);
    assert.equal(impactBeforeBody.scope, "referencing_forwards");
    assert.deepEqual(impactBeforeBody.affected, []);

    // ② dry-run 只读。
    const beforeDryRun = await historyCounts();
    const dry = await request(
      `/api/route-profiles/${profileId}/apply`,
      "POST",
      owner.cookie,
      { forward_ids: [forward.id], dry_run: true },
      owner.workspaceId,
    );
    assert.equal(dry.status, 200);
    assert.equal((await json(dry)).data.outcomes[0].status, "previewed");
    assert.deepEqual(await historyCounts(), beforeDryRun);

    // ③ 显式 apply：走既有 patchForward（新 revision）+ 落 provenance。
    const applied = await request(
      `/api/route-profiles/${profileId}/apply`,
      "POST",
      owner.cookie,
      { forward_ids: [forward.id], expected_revisions: { [forward.id]: 0 } },
      owner.workspaceId,
    );
    assert.equal(applied.status, 200);
    const appliedBody = (await json(applied)).data;
    assert.equal(appliedBody.applied_count, 1);
    assert.equal(appliedBody.outcomes[0].runtime_changed, true);
    const newRevision = appliedBody.outcomes[0].revision;
    assert.ok(newRevision > 0);

    const revisionRow = await db.forwardRevision.findFirst({
      where: { tunnel_id: forward.id, revision: newRevision },
    });
    assert.equal(revisionRow.route_profile_id, profileId);
    assert.equal(revisionRow.route_profile_version, 1);
    assert.equal(revisionRow.ingress_node_id, ingressA.node.id);

    const afterApply = await db.tunnel.findUnique({ where: { id: forward.id } });
    assert.equal(afterApply.route_profile_id, profileId);
    assert.equal(afterApply.route_profile_version, 1);
    assert.equal(afterApply.ingress_node_id, ingressA.node.id);
    const appliedRevision = afterApply.applied_revision ?? null;
    const configRevision = afterApply.config_revision;

    const ledger = await db.routeProfileApplication.findFirst({
      where: { tunnel_id: forward.id, forward_revision: newRevision },
    });
    assert.equal(ledger.route_profile_version, 1);
    assert.ok(Array.isArray(ledger.resolved_hops));

    // ③b 再 apply 同一版本：解析结果 == 当前放置 ⇒ 不产生新 revision，如实报告"只认领来源"。
    const reapply = await request(
      `/api/route-profiles/${profileId}/apply`,
      "POST",
      owner.cookie,
      { forward_ids: [forward.id] },
      owner.workspaceId,
    );
    assert.equal(reapply.status, 200);
    assert.equal((await json(reapply)).data.outcomes[0].runtime_changed, false);
    assert.deepEqual(await historyCounts(), { revisions: 1, rollouts: 1 });

    // ③c impact analysis 只读：列表给出这条 Forward，且**一行都不写**。
    const beforeImpact = await historyCounts();
    const impact = await request(
      `/api/route-profiles/${profileId}/impact`,
      "GET",
      owner.cookie,
      undefined,
      owner.workspaceId,
    );
    assert.equal(impact.status, 200);
    const impactBody = (await json(impact)).data;
    assert.equal(impactBody.read_only, true);
    assert.deepEqual(impactBody.affected.map((a) => a.forward_id), [forward.id]);
    assert.equal(impactBody.affected[0].change.noop, true);
    assert.deepEqual(await historyCounts(), beforeImpact);

    // ④ 发布新版本（换成另一台入口节点）：**不得**静默重写这条正在运行的 Forward。
    const beforePublish = await historyCounts();
    const published = await request(
      `/api/route-profiles/${profileId}/versions`,
      "POST",
      owner.cookie,
      { template: templateFor(ingressB.node.id), expected_version: 1, change_summary: "switch ingress" },
      owner.workspaceId,
    );
    assert.equal(published.status, 201);
    assert.equal((await json(published)).data.version, 2);

    const afterPublish = await db.tunnel.findUnique({ where: { id: forward.id } });
    assert.equal(afterPublish.ingress_node_id, ingressA.node.id); // 运行中的路由没变
    assert.equal(afterPublish.config_revision, configRevision);
    assert.equal(afterPublish.applied_revision, appliedRevision);
    assert.equal(afterPublish.route_profile_version, 1); // 指针停在已应用的版本
    assert.deepEqual(await historyCounts(), beforePublish); // 发布不产生 revision / rollout

    // 版本冲突：过期 expected_version → 409（不静默覆盖）。
    const stale = await request(
      `/api/route-profiles/${profileId}/versions`,
      "POST",
      owner.cookie,
      { template: templateFor(ingressA.node.id), expected_version: 1 },
      owner.workspaceId,
    );
    assert.equal(stale.status, 409);
    assert.equal((await json(stale)).code, "version_conflict");

    // 新版本的 impact 指出这条 Forward 将换入口节点（仍只读）。
    const beforeImpact2 = await historyCounts();
    const impact2 = await request(
      `/api/route-profiles/${profileId}/impact?version=2`,
      "GET",
      owner.cookie,
      undefined,
      owner.workspaceId,
    );
    const impact2Body = (await json(impact2)).data;
    assert.equal(impact2Body.version, 2);
    assert.equal(impact2Body.affected[0].resolved_hops[0].node_id, ingressB.node.id);
    assert.equal(impact2Body.affected[0].change.ingress_change, true);
    assert.deepEqual(await historyCounts(), beforeImpact2);

    // ⑤ PATCH 想改模板内容 ⇒ 400（模板内容变更只能发新版本）。
    const sneaky = await request(
      `/api/route-profiles/${profileId}`,
      "PATCH",
      owner.cookie,
      { template: templateFor(ingressB.node.id) },
      owner.workspaceId,
    );
    assert.equal(sneaky.status, 400);

    // ⑥ apply 不提供「应用到全部」的隐式形式。
    const implicit = await request(
      `/api/route-profiles/${profileId}/apply`,
      "POST",
      owner.cookie,
      {},
      owner.workspaceId,
    );
    assert.equal(implicit.status, 400);
    assert.equal((await json(implicit)).code, "invalid_input");

    // ⑦ 停用后不再允许 apply（已运行的 Forward 不受影响）。
    await request(`/api/route-profiles/${profileId}`, "PATCH", owner.cookie, { enabled: false }, owner.workspaceId);
    const disabledApply = await request(
      `/api/route-profiles/${profileId}/apply`,
      "POST",
      owner.cookie,
      { forward_ids: [forward.id] },
      owner.workspaceId,
    );
    assert.equal(disabledApply.status, 409);
    assert.equal((await json(disabledApply)).code, "profile_disabled");
    const stillRunning = await db.tunnel.findUnique({ where: { id: forward.id } });
    assert.equal(stillRunning.ingress_node_id, ingressA.node.id);
    assert.equal(stillRunning.applied_revision, appliedRevision);
  });

  test("HTTP: the consumer list is read-only and hides INTERNAL templates from plain members", async () => {
    const owner = await registerUser("consume");
    const member = await registerUser("consume-member");
    const ingress = await createNode(owner.workspaceId, owner.id, "consume-a", 45000);
    await db.workspaceMember.create({
      data: { workspace_id: owner.workspaceId, user_id: member.id, role: "member", active: true },
    });

    const internal = await request(
      "/api/route-profiles",
      "POST",
      owner.cookie,
      { name: `RP internal ${nonce}`, visibility: "INTERNAL", template: templateFor(ingress.node.id) },
      owner.workspaceId,
    );
    assert.equal(internal.status, 201);
    const internalId = (await json(internal)).data.id;

    const publicOne = await request(
      "/api/route-profiles",
      "POST",
      owner.cookie,
      { name: `RP public ${nonce}`, visibility: "PUBLIC", template: templateFor(ingress.node.id) },
      owner.workspaceId,
    );
    assert.equal(publicOne.status, 201);
    const publicId = (await json(publicOne)).data.id;

    const ownerList = await request("/api/route-profiles/available", "GET", owner.cookie, undefined, owner.workspaceId);
    assert.equal(ownerList.status, 200);
    const ownerVisible = (await json(ownerList)).data.data.map((p) => p.id);
    assert.ok(ownerVisible.includes(publicId));
    assert.ok(ownerVisible.includes(internalId)); // 管理面可以看到 INTERNAL

    const memberList = await request("/api/route-profiles/available", "GET", member.cookie, undefined, owner.workspaceId);
    assert.equal(memberList.status, 200);
    const memberVisible = (await json(memberList)).data.data.map((p) => p.id);
    assert.ok(memberVisible.includes(publicId));
    assert.ok(!memberVisible.includes(internalId)); // 普通成员看不到 INTERNAL

    // 消费侧接口是只读的：普通成员依旧不能改。
    assert.equal(
      (await request(`/api/route-profiles/${publicId}`, "PATCH", member.cookie, { enabled: false }, owner.workspaceId))
        .status,
      403,
    );
  });
}
