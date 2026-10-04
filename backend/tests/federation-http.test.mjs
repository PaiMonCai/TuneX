/**
 * V5.5 WP14 —— 联邦信任层的**真库**回归（node:test + 真 MySQL）。
 *
 * 与 `src/services/__tests__/federation-wp14-pure.test.ts` 的分工：那边钉纯判定，
 * 这边钉"落库 + 走真实 HTTP 中间件链"的行为。之所以必须有这一层：
 *   · 握手 token 的**单次消费**是数据库唯一约束与事务的事，纯函数测不出来；
 *   · 回执幂等（重复投递返回首次响应快照）是中间件 + 回执表的行为；
 *   · 密钥轮转的宽限期、撤销的级联停服都是"写进去之后还认不认"的问题。
 *
 * 两 Panel 的端到端（两个真实 Panel 进程 + 跨容器网络）由 Gate V5-G5 覆盖；
 * 本文件用"本机 app + 一个自造的对端密钥"代替第二条进程，只验证**入站**语义。
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.TUNEX_DB_TEST = process.env.TUNEX_DB_TEST ?? "0";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "mysql://root:verify-only@127.0.0.1:3306/tunex_verify";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "federation-test-auth-secret";
process.env.LICENSE_SECRET = process.env.LICENSE_SECRET ?? "federation-test-license-secret";
process.env.PAYMENTS_ENABLED = process.env.PAYMENTS_ENABLED ?? "false";

const enabled = process.env.TUNEX_DB_TEST === "1";
const maybe = enabled ? test : test.skip;

const { db } = await import("../src/db.ts");
const { createApp } = await import("../src/app.ts");
const { ensurePanelIdentity, setFederationEnabled, resetPanelIdentityCache } = await import(
  "../src/services/federation/identity.ts"
);
const { createInvitation } = await import("../src/services/federation/trust.ts");
const { buildSignatureHeaders, HDR } = await import("../src/services/federation/signing.ts");
const { generatePanelKeyPair, keyIdFor } = await import("../src/services/federation/keys.ts");
const { verifyHandshakeProof } = await import("../src/services/federation/tokens.ts");

const APPLICATION = createApp();

/**
 * 本文件**只清理自己造的数据**。
 *
 * 教训：第一版直接 `deleteMany({})` 清空全部 federated 表 —— 结果在 `bun run test`
 * （node --test 并行跑多个文件、共用同一个库）里把**别的文件**正在用的 peer 一起删了，
 * 对端报 `peer ... is not known`。破坏性 reset 是共享库测试里的经典自杀行为：
 * 它在单跑时"通过"，在全量时随机失败。所以 peer 一律带 `test-wp14-` 前缀，
 * 只删这个命名空间下的行。
 */
const TEST_PEER_PREFIX = "test-wp14-";

async function resetFederationTables() {
  const mine = await db.federationPeer.findMany({
    where: { peer_panel_id: { startsWith: TEST_PEER_PREFIX } },
    select: { id: true, peer_panel_id: true },
  });
  const ids = mine.map((p) => p.id);
  const panelIds = mine.map((p) => p.peer_panel_id);
  if (ids.length > 0) {
    await db.federationLease.deleteMany({ where: { grant_id: { in: await grantIdsFor(ids) } } });
    await db.federationGrant.deleteMany({ where: { peer_id: { in: ids } } });
    await db.federationCredential.deleteMany({ where: { peer_id: { in: ids } } });
  }
  if (panelIds.length > 0) {
    await db.federationMessageReceipt.deleteMany({ where: { peer_panel_id: { in: panelIds } } });
    await db.federationPlacement.deleteMany({ where: { peer_panel_id: { in: panelIds } } });
    await db.federationUsageRecord.deleteMany({ where: { peer_panel_id: { in: panelIds } } });
    await db.federationIntent.deleteMany({ where: { peer_panel_id: { in: panelIds } } });
    await db.federationLease.deleteMany({ where: { peer_panel_id: { in: panelIds } } });
  }
  await db.federationPeer.deleteMany({ where: { peer_panel_id: { startsWith: TEST_PEER_PREFIX } } });
}

async function grantIdsFor(peerIds) {
  const rows = await db.federationGrant.findMany({ where: { peer_id: { in: peerIds } }, select: { id: true } });
  return rows.map((r) => r.id);
}

/**
 * 保证本机身份可用。**不删**身份行（那是全局共享状态，别的文件也在用）：
 * 只有当它已经被**另一个 AUTH_SECRET** 加过密（解封失败）时才重建 —— 否则同一台机器上
 * 换一次测试密钥就会让所有相关用例一起失败，而原因看起来像"签名坏了"。
 */
async function ensureIdentityForTest() {
  const { loadSigningKey } = await import("../src/services/federation/identity.ts");
  try {
    await loadSigningKey();
    return;
  } catch {
    await db.federationSetting.deleteMany({});
    resetPanelIdentityCache();
    await ensurePanelIdentity();
    await loadSigningKey();
  }
}

function req(path, init = {}) {
  return APPLICATION.request(`http://panel.local${path}`, init);
}

async function signedPost(path, body, keys, panelId, overrides = {}) {
  const bodyStr = JSON.stringify(body ?? {});
  const headers = await buildSignatureHeaders({
    identity: { panel_id: panelId, key_id: keys.key_id, public_jwk: keys.public_jwk },
    privateJwk: keys.private_jwk,
    body: bodyStr,
    messageId: overrides.messageId ?? crypto.randomUUID(),
    nowMs: overrides.nowMs,
    ttlSeconds: overrides.ttlSeconds,
  });
  const res = await req(path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: bodyStr });
  return { res, headers };
}

/** 造一个"对端 panel"：自己的密钥对 + 已在本机登记为 trusted 的 peer 行。 */
async function makePeer(displayName = "Peer B") {
  const keys = await generatePanelKeyPair();
  const panelId = `${TEST_PEER_PREFIX}${crypto.randomUUID()}`;
  const peer = await db.federationPeer.create({
    data: {
      peer_panel_id: panelId,
      display_name: displayName,
      endpoint_url: "http://peer.invalid:3000",
      public_keys: [{ key_id: keys.key_id, jwk: keys.public_jwk, state: "active", not_after: null }],
      status: "trusted",
      trust_scope: { hop_roles: ["egress"] },
    },
  });
  return { keys, panelId, peer };
}

test.after(async () => {
  // 与 tests/workspace-db.test.mjs 同口径：把 Redis 连接显式关掉，
  // 否则 node:test 会因为仍有打开的句柄而挂住（表现为"测试通过了但不退出"）。
  try {
    const { redis } = await import("../src/redis.ts");
    redis?.disconnect?.();
  } catch {
    /* Redis 未接线时忽略 */
  }
  await db.$disconnect().catch(() => {});
});

maybe("WP14 federation: 未开启时拒绝所有联邦端点（fail-closed）", async () => {
  await resetFederationTables();
  await ensureIdentityForTest();
  await setFederationEnabled(false);
  const { res } = await signedPost("/api/federation/v1/ping", {}, await generatePanelKeyPair(), `${TEST_PEER_PREFIX}${crypto.randomUUID()}`);
  // 开关关闭时连"验签"都不该发生：先拒，再谈身份。
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.code, "federation_disabled");
});

maybe("WP14 federation: 握手是一次性的，且响应能被 token 持有者验证", async () => {
  await resetFederationTables();
  await ensureIdentityForTest();
  await setFederationEnabled(true);

  const invite = await createInvitation({ display_name: "面板 A", endpoint_url: "http://127.0.0.1:18181" });
  const clientKeys = await generatePanelKeyPair();
  const clientPanelId = `${TEST_PEER_PREFIX}${crypto.randomUUID()}`;

  const handshakeBody = {
    peer_panel_id: clientPanelId,
    key_id: clientKeys.key_id,
    public_jwk: clientKeys.public_jwk,
    endpoint_url: "http://127.0.0.1:18181",
    display_name: "面板 A",
    token: invite.token,
  };
  const first = await req("/api/federation/v1/handshake", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(handshakeBody),
  });
  assert.equal(first.status, 200);
  const payload = await first.json();
  assert.equal(keyIdFor(payload.public_jwk), payload.key_id);
  assert.equal(
    verifyHandshakeProof(invite.token, { panel_id: payload.panel_id, key_id: payload.key_id, public_jwk: payload.public_jwk }, payload.proof),
    true,
    "响应必须携带只有 token 持有者能验证的 proof",
  );

  const row = await db.federationPeer.findUnique({ where: { peer_panel_id: clientPanelId } });
  assert.ok(row, "握手后必须存在 trusted peer 行");
  assert.equal(row.status, "trusted");

  const second = await req("/api/federation/v1/handshake", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(handshakeBody),
  });
  assert.equal(second.status, 403, "同一个 token 不得第二次使用");
  assert.equal((await second.json()).code, "handshake_invalid");
});

maybe("WP14 federation: 签名请求可用；重复投递返回首次快照而不是再执行一次", async () => {
  await resetFederationTables();
  await ensureIdentityForTest();
  await setFederationEnabled(true);
  const peer = await makePeer();

  const messageId = crypto.randomUUID();
  const first = await signedPost("/api/federation/v1/ping", {}, peer.keys, peer.panelId, { messageId });
  assert.equal(first.res.status, 200);
  const firstBody = await first.res.json();
  assert.equal(firstBody.ok, true);

  const second = await signedPost("/api/federation/v1/ping", {}, peer.keys, peer.panelId, { messageId });
  assert.equal(second.res.status, 200, "重复投递必须成功返回首次结果");
  const secondBody = await second.res.json();
  assert.deepEqual(secondBody, firstBody, "重复投递返回的是快照，不是重新执行的第二次结果");

  const receipts = await db.federationMessageReceipt.count();
  assert.equal(receipts, 1, "同一条消息只应留下一条回执");
});

maybe("WP14 federation: 篡改 / 时钟偏移 / 未知 peer 都被拒", async () => {
  await resetFederationTables();
  await ensureIdentityForTest();
  await setFederationEnabled(true);
  const peer = await makePeer();

  // 1) 签名后篡改请求体
  const bodyStr = JSON.stringify({ tampered: false });
  const headers = await buildSignatureHeaders({
    identity: { panel_id: peer.panelId, key_id: peer.keys.key_id, public_jwk: peer.keys.public_jwk },
    privateJwk: peer.keys.private_jwk,
    body: bodyStr,
    messageId: crypto.randomUUID(),
  });
  const tampered = await req("/api/federation/v1/ping", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ tampered: true }),
  });
  assert.equal(tampered.status, 401);
  assert.equal((await tampered.json()).code, "signature_invalid");

  // 2) 未来的时间戳
  const future = await signedPost("/api/federation/v1/ping", {}, peer.keys, peer.panelId, {
    nowMs: Date.now() + 10 * 60 * 1000,
  });
  assert.equal(future.res.status, 401);
  assert.equal((await future.res.json()).code, "clock_skew");

  // 3) 未知 panel
  const stranger = await generatePanelKeyPair();
  const unknown = await signedPost("/api/federation/v1/ping", {}, stranger, `${TEST_PEER_PREFIX}${crypto.randomUUID()}`);
  assert.equal(unknown.res.status, 403);
  assert.equal((await unknown.res.json()).code, "peer_unknown");
});

maybe("WP14 federation: 密钥轮转先通知后生效，旧钥匙在宽限期内仍可验签", async () => {
  await resetFederationTables();
  await ensureIdentityForTest();
  await setFederationEnabled(true);
  const peer = await makePeer();
  const nextKeys = await generatePanelKeyPair();

  const rotate = await signedPost(
    "/api/federation/v1/keys/rotate",
    { old_key_id: peer.keys.key_id, new_key_id: nextKeys.key_id, new_public_jwk: nextKeys.public_jwk },
    peer.keys,
    peer.panelId,
  );
  assert.equal(rotate.res.status, 200);

  // 新钥匙立刻可用
  const withNew = await signedPost("/api/federation/v1/ping", {}, nextKeys, peer.panelId);
  assert.equal(withNew.res.status, 200, "轮转后新密钥必须立刻可用");

  // 旧钥匙在 retiring 宽限期内仍可用（在途请求不会因为轮转而失败）
  const withOld = await signedPost("/api/federation/v1/ping", {}, peer.keys, peer.panelId);
  assert.equal(withOld.res.status, 200, "宽限期内旧密钥仍应可验签");

  // 宽限期结束后旧钥匙失效
  const row = await db.federationPeer.findUnique({ where: { peer_panel_id: peer.panelId } });
  const keys = row.public_keys;
  const expired = keys.map((k) =>
    k.key_id === peer.keys.key_id ? { ...k, state: "retired", not_after: null } : k,
  );
  await db.federationPeer.update({ where: { id: row.id }, data: { public_keys: expired } });
  const afterRetire = await signedPost("/api/federation/v1/ping", {}, peer.keys, peer.panelId);
  assert.equal(afterRetire.res.status, 401);
  assert.equal((await afterRetire.res.json()).code, "key_unknown");
});

maybe("WP14 federation: 撤销是终态，撤销后该 peer 的调用一律被拒", async () => {
  await resetFederationTables();
  await ensureIdentityForTest();
  await setFederationEnabled(true);
  const peer = await makePeer();

  const before = await signedPost("/api/federation/v1/ping", {}, peer.keys, peer.panelId);
  assert.equal(before.res.status, 200);

  const revoke = await signedPost("/api/federation/v1/trust/revoke", { reason: "test" }, peer.keys, peer.panelId);
  assert.equal(revoke.res.status, 200);

  const after = await signedPost("/api/federation/v1/ping", {}, peer.keys, peer.panelId);
  assert.equal(after.res.status, 403);
  assert.equal((await after.res.json()).code, "peer_revoked");

  const row = await db.federationPeer.findUnique({ where: { peer_panel_id: peer.panelId } });
  assert.equal(row.status, "revoked");
  assert.ok(row.revoked_at);
});

maybe("WP14 federation: 瞬态失败不留回执快照（一次抖动不得被永久化）", async () => {
  await resetFederationTables();
  await ensureIdentityForTest();
  await setFederationEnabled(true);
  const peer = await makePeer();

  const { claimInboundMessage, completeInboundMessage, releaseInboundMessage } = await import(
    "../src/services/federation/receipts.ts"
  );
  const messageId = crypto.randomUUID();

  // 首次处理"失败"为 503：写进快照然后释放
  const claim = await claimInboundMessage({ peer_panel_id: peer.panelId, message_id: messageId, path: "/x" });
  assert.equal(claim.kind, "new");
  await completeInboundMessage({ message_key: claim.messageKey, status: 503, body: { code: "internal_error" } });
  await releaseInboundMessage(claim.messageKey);

  const row = await db.federationMessageReceipt.findUnique({ where: { message_key: claim.messageKey } });
  assert.equal(row, null, "瞬态失败必须被释放，否则重试永远拿到同一次抖动的结果");

  // 成功（409 也是决策结果）则保留快照：重试必须返回同一个结论
  const claim2 = await claimInboundMessage({ peer_panel_id: peer.panelId, message_id: messageId, path: "/x" });
  assert.equal(claim2.kind, "new", "释放之后同一条消息应当可以重新执行");
  await completeInboundMessage({ message_key: claim2.messageKey, status: 409, body: { code: "grant_not_active" } });
  const retry = await claimInboundMessage({ peer_panel_id: peer.panelId, message_id: messageId, path: "/x" });
  assert.equal(retry.kind, "duplicate_done");
  if (retry.kind === "duplicate_done") {
    assert.equal(retry.status, 409);
    assert.deepEqual(retry.body, { code: "grant_not_active" });
  }
});

maybe("WP14 federation: 握手不得清空对端地址（否则永远回呼不到对方）", async () => {
  await resetFederationTables();
  await ensureIdentityForTest();
  await setFederationEnabled(true);

  const INVITED_ENDPOINT = "http://panel-a.invalid:3000";

  // 1) 对方没自报地址（空串）→ 必须保留邀请里登记的那个地址
  const invite = await createInvitation({ display_name: "面板 A", endpoint_url: INVITED_ENDPOINT });
  const clientKeys = await generatePanelKeyPair();
  const clientPanelId = `${TEST_PEER_PREFIX}${crypto.randomUUID()}`;
  const empty = await req("/api/federation/v1/handshake", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      peer_panel_id: clientPanelId,
      key_id: clientKeys.key_id,
      public_jwk: clientKeys.public_jwk,
      display_name: "面板 A",
      token: invite.token,
      endpoint_url: "",
    }),
  });
  assert.equal(empty.status, 200);
  let row = await db.federationPeer.findUnique({ where: { peer_panel_id: clientPanelId } });
  assert.equal(row.endpoint_url, INVITED_ENDPOINT, "空串不是'清空我的地址'，而是'我没告诉你'");

  // 2) 对方自报地址 → 采纳（新建一个 peer，避免复用已消费的 token）
  const invite2 = await createInvitation({ display_name: "面板 C", endpoint_url: INVITED_ENDPOINT });
  const keys2 = await generatePanelKeyPair();
  const panel2 = `${TEST_PEER_PREFIX}${crypto.randomUUID()}`;
  const advertised = await req("/api/federation/v1/handshake", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      peer_panel_id: panel2,
      key_id: keys2.key_id,
      public_jwk: keys2.public_jwk,
      display_name: "面板 C",
      token: invite2.token,
      endpoint_url: "http://panel-c:3000",
    }),
  });
  assert.equal(advertised.status, 200);
  row = await db.federationPeer.findUnique({ where: { peer_panel_id: panel2 } });
  assert.equal(row.endpoint_url, "http://panel-c:3000");
});

maybe("WP14 federation: 公布地址规范化（浏览器地址 ≠ 容器网络地址）", async () => {
  const { federationSelfUrl, normalizeSelfUrl } = await import("../src/services/federation/trust.ts");
  // 纯函数部分：尾斜杠必须被去掉，否则拼出 `//api/federation/...`，peer 侧的 URL 校验会拒
  assert.equal(normalizeSelfUrl("http://panel:3000/"), "http://panel:3000");
  assert.equal(normalizeSelfUrl("  http://panel:3000//  "), "http://panel:3000");
  // 真实取值：未配置 FEDERATION_PUBLIC_URL 时回落 SITE_URL，且必须非空
  assert.ok(federationSelfUrl().length > 0);
  assert.equal(federationSelfUrl().endsWith("/"), false);
});
