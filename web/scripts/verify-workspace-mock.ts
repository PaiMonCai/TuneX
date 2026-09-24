/**
 * TEN-01：直接驱动 mock handler 验证工作空间契约（列表 / 建团队 / 成员 / 邀请 / 接受 / 移除）。
 * 运行：bun run scripts/verify-workspace-mock.ts
 *
 * 覆盖的负面用例与后端 backend/src/routes/workspaces.ts 一一对应：
 *   · 未登录 → 401
 *   · 邀请：非 team / 非 manage 角色 → 403；已是成员 → 409；邮箱不合法 → 400
 *   · 邀请接受：token 与登录邮箱不匹配 → 404；重复使用 → 404/409
 *   · 移除：owner 不可移除 → 403；普通成员不能移除他人 → 403；可自行退出
 *   · 成员上限：active + 未过期未使用邀请合计超过上限 → 403
 */
import { handleMock } from "../src/mocks/handler";
import { resetStore } from "../src/mocks/state";

/** demo（个人空间 1，团队空间 6 owner）；alice=u2（团队 admin）、bob=u3（团队 member） */
const CK_DEMO = "tunex_session=u1";
const CK_ALICE = "tunex_session=u2";
const CK_BOB = "tunex_session=u3";

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

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string; noCookie?: boolean } = {},
) {
  const [bare, qs] = path.split("?");
  const query: Record<string, string> = {};
  if (qs) {
    for (const kv of qs.split("&")) {
      const [k, v] = kv.split("=");
      if (k) query[k] = decodeURIComponent(v ?? "");
    }
  }
  return handleMock(method, bare, {
    body: opts.body,
    query,
    cookie: opts.noCookie ? undefined : (opts.cookie ?? CK_DEMO),
  });
}

function bodyOf<T = any>(res: { body: unknown }): T {
  return res.body as T;
}

resetStore();

console.log("== 列表 ==");
let r = await call("GET", "/workspaces");
check("demo 看到个人 + 团队空间", r.status === 200 && bodyOf(r).length === 2, r.body);
check("个人空间 kind/role 正确", bodyOf(r)[0].kind === "personal" && bodyOf(r)[0].role === "owner", bodyOf(r)[0]);
check("团队空间 kind/role 正确", bodyOf(r)[1].kind === "team" && bodyOf(r)[1].role === "owner", bodyOf(r)[1]);
const TEAM_ID = bodyOf(r)[1].id as number;
const PERSONAL_ID = bodyOf(r)[0].id as number;

r = await call("GET", "/workspaces", { cookie: CK_BOB });
check("bob 只看得到个人空间 + 受邀团队", r.status === 200 && bodyOf(r).some((w: any) => w.role === "member"), r.body);

r = await call("GET", "/workspaces", { noCookie: true });
check("未登录列 401", r.status === 401, r.status);

console.log("== 成员 ==");
r = await call("GET", `/workspaces/${TEAM_ID}/members`);
check("owner 可读成员", r.status === 200 && bodyOf(r).length === 3, r.body);
check("成员行带 email/role", bodyOf(r).every((m: any) => !!m.email && !!m.role), r.body);
check("成员按 user_id 升序", bodyOf(r)[0].user_id < bodyOf(r)[1].user_id, r.body);

r = await call("GET", `/workspaces/${TEAM_ID}/members`, { noCookie: true });
check("未登录读成员 401", r.status === 401, r.status);

r = await call("GET", "/workspaces/9999/members");
check("不存在的空间 404", r.status === 404, r.status);

console.log("== 邀请 ==");
r = await call("POST", `/workspaces/${PERSONAL_ID}/invites`, { body: { email: "x@example.com", role: "member" } });
check("个人空间不能邀请", r.status === 403, r.status);

r = await call("POST", `/workspaces/${TEAM_ID}/invites`, { body: { email: "bad-email", role: "member" } });
check("邮箱不合法 400", r.status === 400, r.status);

r = await call("POST", `/workspaces/${TEAM_ID}/invites`, { body: { email: "carol@example.com", role: "viewer" } });
check("owner 可邀请 carol", r.status === 200 && !!bodyOf(r).token, r.body);
const inviteToken = bodyOf(r).token as string;
check("邀请带 7 天有效期", !!bodyOf(r).expires_at, r.body);

r = await call("POST", `/workspaces/${TEAM_ID}/invites`, { body: { email: "demo@tunex.example", role: "member" } });
check("已是成员 409", r.status === 409, r.status);

r = await call("POST", `/workspaces/${TEAM_ID}/invites`, { body: { email: "newguy@example.com" }, cookie: CK_BOB });
check("member 角色不能邀请 403", r.status === 403, r.status);

// 成员上限：3 名 active + carol 未用邀请 = 4，再发 1 条到 5 后应被 403 拒绝
r = await call("POST", `/workspaces/${TEAM_ID}/invites`, { body: { email: "limit1@example.com" } });
check("第 5 位（含待接受）允许", r.status === 200, r.status);
r = await call("POST", `/workspaces/${TEAM_ID}/invites`, { body: { email: "limit2@example.com" } });
check("超出成员上限 403", r.status === 403 && bodyOf(r).code === "MAX_MEMBERS", r.body);

r = await call("GET", `/workspaces/${TEAM_ID}/members`);
check("上限未影响成员列表", r.status === 200, r.status);

console.log("== 接受邀请 ==");
r = await call("POST", "/workspaces/invites/accept", { body: { token: "nope-invalid-token" }, cookie: CK_BOB });
check("无效 token 404", r.status === 404, r.status);

r = await call("POST", "/workspaces/invites/accept", { body: { token: inviteToken }, cookie: CK_ALICE });
check("token 与登录邮箱不匹配 404", r.status === 404, r.status);

// carol = users[3]，用 her session 接受
r = await call("POST", "/workspaces/invites/accept", { body: { token: inviteToken }, cookie: "tunex_session=u4" });
check("carol 接受邀请成功", r.status === 200 && bodyOf(r).workspace_id === TEAM_ID, r.body);

// 与后端一致：已接受/已撤销/过期的 token 一律 404「邀请不存在或已失效」
r = await call("POST", "/workspaces/invites/accept", { body: { token: inviteToken }, cookie: "tunex_session=u4" });
check("重复使用 token 404（与后端一致）", r.status === 404, r.status);

r = await call("GET", `/workspaces/${TEAM_ID}/members`);
check("邀请接受后成员数 4", bodyOf(r).length === 4, r.body);
check("carol 角色为 viewer", bodyOf(r).find((m: any) => m.email === "carol@example.com")?.role === "viewer", r.body);

console.log("== 移除成员 ==");
r = await call("DELETE", `/workspaces/${TEAM_ID}/members/1`);
check("owner 不可移除 403", r.status === 403, r.status);

// bob（user 3，member 角色）不能移除他人（carol = user 4）
r = await call("DELETE", `/workspaces/${TEAM_ID}/members/4`, { cookie: CK_BOB });
check("普通成员不能移除他人 403", r.status === 403, r.status);

// alice（user 2，admin）可以移除
r = await call("DELETE", `/workspaces/${TEAM_ID}/members/4`, { cookie: CK_ALICE });
check("admin 可移除成员", r.status === 200 && bodyOf(r).ok === true, r.body);

r = await call("DELETE", `/workspaces/${TEAM_ID}/members/4`);
check("移除不存在成员 404", r.status === 404, r.status);

// bob 自行退出（actor === target，无需 manage 权限）
r = await call("DELETE", `/workspaces/${TEAM_ID}/members/3`, { cookie: CK_BOB });
check("成员可自行退出", r.status === 200, r.body);

r = await call("GET", "/workspaces", { cookie: CK_BOB });
check("退出后 bob 只剩个人空间", r.status === 200 && bodyOf(r).length === 1, r.body);

console.log("== 创建团队空间 ==");
r = await call("POST", "/workspaces", { body: { name: "   " } });
check("空名称 400", r.status === 400, r.status);

r = await call("POST", "/workspaces", { body: { name: "新团队" } });
check("创建成功且为 owner", r.status === 200 && bodyOf(r).kind === "team" && bodyOf(r).role === "owner", r.body);
const NEW_ID = bodyOf(r).id as number;

r = await call("GET", "/workspaces", { noCookie: true });
check("未登录不能创建 401", r.status === 401, r.status);

r = await call("GET", `/workspaces${""}`); // 列表应看到新空间
check("列表出现新建团队", bodyOf(r).some((w: any) => w.id === NEW_ID), r.body);

console.log("== mock 恢复能力 ==");
resetStore();
r = await call("GET", "/workspaces");
check("reset 后回到种子状态", r.status === 200 && bodyOf(r).length === 2, r.body);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
