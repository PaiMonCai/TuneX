import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";

/**
 * TEN-03 HTTP 集成用例（真实 MySQL，需 TUNEX_DB_TEST=1，与 workspace-db.test.mjs 同一门槛）。
 * 覆盖：
 *   1. 注册 → 落一封未用验证邮件 token；点链接 → email_verified_at 置位；
 *   2. 同一 token **二次使用被拒**（单次使用）；
 *   3. forgot-password 对「存在/不存在」的邮箱返回**逐字节相同**的响应（防枚举），
 *      且只有真实邮箱的库里留下记录；
 *   4. 重置 token 过期后拒绝；重置成功后旧密码失效、token 失效、验证信一齐作废。
 */
if (process.env.TUNEX_DB_TEST !== "1") {
  test("email verification + password reset integration (requires TUNEX_DB_TEST=1)", { skip: true }, () => {});
} else {
  process.env.AUTH_SECRET ??= "test-only-auth-secret-must-not-be-used-in-production";
  process.env.LICENSE_SECRET ??= "test-only-license-secret-must-not-be-used-in-production";
  process.env.TUNEX_CONFIG_KEY ??= Buffer.alloc(32, 5).toString("base64url");
  process.env.TUNEX_LICENSE_KEY ??= Buffer.alloc(32, 6).toString("base64url");
  process.env.PAYMENTS_ENABLED = "false";
  process.env.ALLOW_REGISTER_FALLBACK = "true";
  // 与其它集成用例一致：邮件降级为日志（不连 SMTP），token 从 DB 哈希反查不可行，
  // 因此在进程内捕获 sendMail()（见下方 monkey patch）。

  // 捕获「邮件」：把 SMTP 通道替换成进程内收集器（只在本测试进程生效），
  // 因此不需要真的连邮件服务器，也能断言「注册后确实发出验证邮件且正文含 token 链接」。
  const sent = [];
  const mailModule = await import("../src/services/mail.ts");
  mailModule.setMailTransportForTest(async (m) => {
    sent.push(m);
    return { sent: true };
  });

  const { db } = await import("../src/db.ts");
  const { redis } = await import("../src/redis.ts");
  const { hashEmailToken } = await import("../src/services/mail-tokens.ts");
  const { getEffectivePolicy } = await import("../src/services/policy-service.ts");

  const authRoutesModule = await import("../src/routes/auth.ts");
  assert.ok(authRoutesModule.authRoutes, "authRoutes 应可导入");
  const { app } = await import("../src/app.ts");

  after(async () => {
    mailModule.setMailTransportForTest(null);
    redis.disconnect();
    await db.$disconnect();
  });

  const nonce = randomUUID().slice(0, 12);
  const email = `email-auth-${nonce}@example.test`;
  const otherEmail = `no-such-user-${nonce}@example.test`;
  const password = "ci-only-password-12";
  const newPassword = "ci-only-password-99";
  let userId = 0;

  async function request(path, method, cookie, body, query) {
    const q = query ? `?${new URLSearchParams(query)}` : "";
    return app.request(`http://localhost${path}${q}`, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }

  /** 从 DB 直接读出某用户某用途的全部 token 行（含 used_at 状态）。 */
  async function rowsFor(userId, purpose) {
    return db.emailVerification.findMany({ where: { user_id: userId, purpose }, orderBy: { id: "asc" } });
  }

  test("注册后发出验证邮件；点击链接后 email_verified_at 置位", async () => {
    sent.length = 0;
    const reg = await request("/api/auth/register", "POST", "", { email, password });
    const regBody = await reg.json();
    assert.equal(reg.status, 201, JSON.stringify(regBody));
    userId = regBody.data.id;
    assert.equal(regBody.data.email_verified_at, null, "注册时不应已验证");

    // 注册流程发了一封验证邮件（降级到进程内捕获）
    assert.equal(sent.length, 1, `应发出 1 封邮件，实际 ${sent.length}`);
    assert.equal(sent[0].to, email);
    assert.match(sent[0].subject, /验证/);
    const link = sent[0].text.match(/https?:\/\/\S+\/verify-email\?token=([^\s]+)/);
    assert.ok(link, `邮件正文应含验证链接：${sent[0].text}`);

    // 访问链接（GET + query）
    const verify = await request("/api/auth/verify-email", "GET", "", null, { token: link[1] });
    const verifyBody = await verify.json();
    assert.equal(verify.status, 200, JSON.stringify(verifyBody));
    assert.equal(verifyBody.status, "verified");

    const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
    assert.ok(user.email_verified_at, "email_verified_at 应已置位");

    // 登录响应带 email_verified
    const login = await request("/api/auth/login", "POST", "", { email, password });
    assert.equal(login.status, 200);
    assert.equal((await login.json()).data.email_verified, true);
  });

  test("验证 token 单次使用：第二次点击同一链接被拒", async () => {
    // 让该用户重新变成未验证，再发一封（直接调服务，绕开 60s 节流）
    await db.user.update({ where: { id: userId }, data: { email_verified_at: null } });
    const { issueEmailToken } = await import("../src/services/mail-tokens.ts");
    const { token } = await issueEmailToken(userId, email, "email_verify");

    const first = await request("/api/auth/verify-email", "GET", "", null, { token });
    assert.equal(first.status, 200);
    const replay = await request("/api/auth/verify-email", "GET", "", null, { token });
    const replayBody = await replay.json();
    assert.equal(replay.status, 400);
    assert.equal(replayBody.status, "invalid");

    // 库里该 token 已标记 used_at
    const rows = await rowsFor(userId, "email_verify");
    const usedCount = rows.filter((r) => r.used_at).length;
    assert.ok(usedCount >= 2, `已用 token 应至少有两条，实际 ${usedCount}`);
  });

  test("伪造 token 与过期 token 一律拒绝", async () => {
    const forged = await request("/api/auth/verify-email", "GET", "", null, {
      token: "totally-made-up-token-value-0123456789",
    });
    assert.equal(forged.status, 400);

    // 直接构造一条已过期的 token 记录来验证过期分支
    const { issueEmailToken } = await import("../src/services/mail-tokens.ts");
    const { token } = await issueEmailToken(userId, email, "password_reset");
    await db.emailVerification.updateMany({
      where: { token_hash: hashEmailToken(token) },
      data: { expires_at: new Date(Date.now() - 1000) },
    });
    const expired = await request("/api/auth/reset-password", "POST", "", { token, password: newPassword });
    assert.equal(expired.status, 400);
    assert.equal((await expired.json()).error, "重置链接无效或已过期");
  });

  test("邮箱枚举防护：存在与不存在的邮箱响应完全一致", async () => {
    // 清掉该用户可能残留的重置信，保证这是本用例发出的第一封
    await db.emailVerification.updateMany({
      where: { user_id: userId, purpose: "password_reset", used_at: null },
      data: { used_at: new Date() },
    });
    sent.length = 0;
    const exists = await request("/api/auth/forgot-password", "POST", "", { email });
    const existsBody = await exists.json();
    // 先记住「真实邮箱收到了几封」——下面会清空数组去验证另一个邮箱是否静默。
    const existsSent = sent.map((m) => ({ to: m.to, text: m.text }));
    const existsRows = await db.emailVerification.findMany({
      where: { user_id: userId, purpose: "password_reset", used_at: null },
    });

    sent.length = 0;
    const missing = await request("/api/auth/forgot-password", "POST", "", { email: otherEmail });
    const missingBody = await missing.json();

    assert.equal(exists.status, missing.status, "状态码必须一致");
    assert.deepEqual(existsBody, missingBody, "响应体必须逐字节一致");
    assert.deepEqual(existsBody, { data: { ok: true, expires_in: 3600 } });

    // 只有真实邮箱收到邮件；DB 里也只有一条重置信
    assert.equal(existsSent.length, 1, `应只给真实邮箱发信，实际 ${existsSent.length}`);
    assert.equal(existsSent[0].to, email);
    assert.match(existsSent[0].text, /reset-password\?token=/);
    assert.equal(existsRows.length, 1, `真实邮箱应只留一条重置信，实际 ${existsRows.length}`);
    // 另一个（不存在）邮箱：静默无信、无记录
    assert.equal(sent.length, 0, `不存在的邮箱不应收到邮件，实际 ${sent.length}`);
    const otherRows = await db.emailVerification.findMany({ where: { email: otherEmail } });
    assert.equal(otherRows.length, 0, "不存在的邮箱不应落 token 记录");
  });

  test("重复 forgot 不重复发信（已有未过期重置信时）", async () => {
    sent.length = 0;
    const again = await request("/api/auth/forgot-password", "POST", "", { email });
    assert.equal(again.status, 200);
    assert.equal(sent.length, 0, "已有未过期重置信时不应再发一封");
  });

  test("重置密码：成功后旧密码失效、token 失效、验证信一并作废", async () => {
    sent.length = 0;
    // 把旧的未用重置信标成已用，迫使 forgot 发一封新信，从而拿到明文 token。
    await db.emailVerification.updateMany({
      where: { user_id: userId, purpose: "password_reset", used_at: null },
      data: { used_at: new Date() },
    });
    const forgot = await request("/api/auth/forgot-password", "POST", "", { email });
    assert.equal(forgot.status, 200);
    assert.equal(sent.length, 1);
    const link = sent[0].text.match(/\/reset-password\?token=([^\s]+)/);
    assert.ok(link, `邮件正文应含重置链接：${sent[0].text}`);

    // 换密码
    const reset = await request("/api/auth/reset-password", "POST", "", {
      token: link[1],
      password: newPassword,
    });
    assert.equal(reset.status, 200, JSON.stringify(await reset.clone().json()));

    // 同一 token 不能再用
    const replay = await request("/api/auth/reset-password", "POST", "", {
      token: link[1],
      password: newPassword,
    });
    assert.equal(replay.status, 400);

    // 旧密码登录失败，新密码成功
    const oldLogin = await request("/api/auth/login", "POST", "", { email, password });
    assert.equal(oldLogin.status, 401);
    const newLogin = await request("/api/auth/login", "POST", "", { email, password: newPassword });
    assert.equal(newLogin.status, 200, "新密码应可登录");

    // 该用户所有未用令牌（含邮箱验证信）都已作废
    const unused = await db.emailVerification.count({ where: { user_id: userId, used_at: null } });
    assert.equal(unused, 0, "重置后不应留下任何未用令牌");
  });

  test("重新发送验证邮件：未验证可发；60s 内第二次 429；已验证 409", async () => {
    // 上一个用例重置后邮箱仍处于「已验证」，先确认 409 分支；
    // 再手动置为未验证，走完「可发 → 60s 内 429」。
    await db.user.update({ where: { id: userId }, data: { email_verified_at: null } });

    // 注意：上一个用例已把所有未用令牌作废，这里不会命中「60s 内」的应用层节流。
    const login = await request("/api/auth/login", "POST", "", { email, password: newPassword });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie?.startsWith("access="));

    sent.length = 0;
    const first = await request("/api/auth/resend-verification", "POST", cookie);
    assert.equal(first.status, 200, JSON.stringify(await first.clone().json()));
    assert.equal(sent.length, 1);

    // 60s 内第二次 → 429 + Retry-After
    const tooSoon = await request("/api/auth/resend-verification", "POST", cookie);
    assert.equal(tooSoon.status, 429);
    assert.ok(Number(tooSoon.headers.get("retry-after")) >= 1);
    assert.equal(sent.length, 1, "被节流时不应再发信");

    // 已验证（先把刚发的 token 用掉）→ 409
    const rows = await db.emailVerification.findMany({
      where: { user_id: userId, purpose: "email_verify", used_at: null },
    });
    assert.ok(rows.length >= 1, "上一封重发应留下未用 token");
    // 直接把用户标成已验证，验证「已验证即拒发」
    await db.user.update({ where: { id: userId }, data: { email_verified_at: new Date() } });
    const done = await request("/api/auth/resend-verification", "POST", cookie);
    assert.equal(done.status, 409, "已验证用户应拒发");
  });

  test("未登录请求 resend-verification → 401", async () => {
    const res = await request("/api/auth/resend-verification", "POST", "");
    assert.equal(res.status, 401);
  });

  test("注册流程同步分配默认能力策略（与个人 workspace 同事务语义）", async () => {
    const ws = await db.workspace.findUniqueOrThrow({ where: { personal_user_id: userId } });
    const member = await db.workspaceMember.findUniqueOrThrow({
      where: { workspace_id_user_id: { workspace_id: ws.id, user_id: userId } },
    });
    assert.equal(member.role, "owner");
    assert.equal(ws.kind, "personal");

    // SOFT-01/TEN-03：注册流程必须与 user 创建在同一事务内发放免费默认策略
    // （TuneX 新增能力，RelayX 无此逻辑——原版注册只建 user 行）。
    // 免费模板按 workspace 类型区分：personal → free_personal，team → free_team；
    // 均由迁移 SQL 预置，source=system_default 且不设截止/不被撤销。
    const assignments = await db.workspacePolicyAssignment.findMany({
      where: { workspace_id: ws.id, revoked_at: null },
      select: {
        source: true,
        expires_at: true,
        policy: { select: { key: true, applies_to: true, status: true, is_default: true } },
      },
    });
    assert.equal(assignments.length, 1, `个人 workspace 应恰好发放一条默认策略，实际 ${assignments.length}`);
    const [assigned] = assignments;
    assert.equal(assigned.policy.key, "free_personal", "注册用户应获得免费个人策略");
    assert.equal(assigned.policy.applies_to, "personal");
    assert.equal(assigned.policy.is_default, true, "该模板应标记为默认发放模板");
    assert.equal(assigned.policy.status, "active");
    assert.equal(assigned.source, "system_default", "默认发放来源应为 system_default");
    assert.equal(assigned.expires_at, null, "免费默认策略不设截止时间");

    // 有效策略可合成：有发放 → 非 deny_scope，且免费额度生效。
    const effective = await getEffectivePolicy(ws.id, { noCache: true });
    assert.equal(effective.deny_scope, false, "发放免费策略后不应处于全局拒绝态");
    assert.equal(effective.active_policies.length, 1);
    assert.equal(effective.active_policies[0].key, "free_personal");
  });
}
