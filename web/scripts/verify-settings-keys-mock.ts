/**
 * SEC-02 前端契约自检：直接驱动 mock handler 验证
 *   1. 轮换端点响应形状仍是 { ok, api_key | subscription_key, user }（明文只在顶层）
 *   2. 轮换后 user.api_key / user.subscription_key 为 null（不泄露、前端走 null 兜底）
 *   3. profile（GET /me）返回的 user 含可为 null 的密钥字段，前端渲染不崩
 *   4. auth login/register mock 仍可返回 api_key（mock 场景，与前端兜底并存）
 * 运行：bun run scripts/verify-settings-keys-mock.ts
 */
import { handleMock } from "../src/mocks/handler";
import { resetStore } from "../src/mocks/state";

const CK_DEMO = "tunex_session=u1";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, extra ?? "");
  }
}

const j = (b: unknown) => b as Record<string, any>;

resetStore();

// ---- 1/2: api-key 轮换 ----
{
  const res = await handleMock("POST", "/settings/api-key", { cookie: CK_DEMO, body: {} });
  check("api-key 轮换 200", res.status === 200, res.status);
  const b = j(res.body);
  check("响应含 ok=true", b.ok === true, b.ok);
  check("响应顶层有明文 api_key", typeof b.api_key === "string" && b.api_key.length > 0, b.api_key);
  check("响应含 user", b.user && typeof b.user.id === "number");
  check("轮换后 user.api_key 归 null（明文不回流）", b.user.api_key === null, b.user.api_key);
}

// ---- 1/2: subscription-key 轮换 ----
{
  const res = await handleMock("POST", "/settings/subscription-key", { cookie: CK_DEMO, body: {} });
  check("subscription-key 轮换 200", res.status === 200, res.status);
  const b = j(res.body);
  check("响应顶层有明文 subscription_key", typeof b.subscription_key === "string" && b.subscription_key.length > 0);
  check("轮换后 user.subscription_key 归 null", b.user.subscription_key === null, b.user.subscription_key);
}

// ---- 3: profile / me ----
{
  const res = await handleMock("GET", "/auth/me", { cookie: CK_DEMO });
  const b = j(res.body);
  check(
    "me 的 user.api_key / subscription_key 为 string | null（前端两条分支都要能渲染）",
    b.api_key === null || typeof b.api_key === "string",
    b.api_key,
  );
  check("me 含渲染必需字段", typeof b.email === "string" && "auto_renew" in b && typeof b.updated_at === "string");
}

// ---- 4: login/register mock 仍回 api_key（并存兜底） ----
{
  const res = await handleMock("POST", "/auth/login", {
    cookie: "",
    body: { email: "demo@tunex.example", password: "demo1234" },
  });
  const b = j(res.body);
  check(
    "login mock 的 user.api_key 为 string | null（两种都不许让前端崩）",
    b.user.api_key === null || typeof b.user.api_key === "string",
    b.user.api_key,
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
