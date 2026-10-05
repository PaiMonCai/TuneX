/**
 * V5-WP18.7 —— DoD9：权限的**HTTP 半边**（契约 F7 / §8 收口）。
 *
 * 18.6 已经把"登记生效"用**判定**证明了（`resolveAdminRoute` 解析 / `sanitizePermissions` 收得下 /
 * 无键角色拿不到 / 未登记前缀仍 `undefined`）。这里补的是端到端那一半：**真的发请求**，
 * 看 `adminRequired → adminPermissionGuard → 路由` 这条链在 HTTP 上给出的状态码。
 * 两条断言各自独立成证据：403 证明"权限没被放宽"，201 证明"被授权的人真的能用"。
 *
 * 覆盖：
 *   · 未认证 → 401；有 `{nodes:"write"}`（别的资源）的角色 → **403**（fail-closed 未松）；
 *   · `{announcements:"read"}` → GET 200 / POST 403（写需要 write）；
 *   · `{announcements:"write"}` → POST 201；超管 → 200/201（既有直通语义）；
 *   · 对照组：未登记前缀 → 403（登记没有顺手把"未登记 = 拒绝"这条规则弄丢）；
 *   · 租户侧：`member` 发布 → 403（缺 `settings:manage`），`owner` → 201；
 *     用户侧**可见列表**只需活跃成员 → `member` GET 200（§12.3-D4 的口径）。
 *
 * 需要真实依赖：`TUNEX_DB_TEST=1` + `DATABASE_URL` + `REDIS_URL`（认证中间件会碰 Redis 缓存；
 * 无则整份跳过）。
 * 跑法：`TUNEX_DB_TEST=1 DATABASE_URL=... REDIS_URL=... bun test tests/v5-wp18-permissions-http.test.mjs`
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";

process.env.AUTH_SECRET ||= "wp18-only-not-a-real-session-secret-32-bytes";
process.env.LICENSE_SECRET ||= "wp18-only-not-a-real-license-secret-32-bytes";

const { app } = await import("../src/app.ts");
const { db } = await import("../src/db.ts");
const { redis } = await import("../src/redis.ts");
const { signAccessToken } = await import("../src/auth.ts");

const ENABLED = process.env.TUNEX_DB_TEST === "1";
const SUFFIX = "wp18rbac";
const CREATED = { users: [], roles: [], announcements: [], workspaces: [] };

async function login(userId, email, superAdmin) {
  const token = await signAccessToken({ userId, email, superAdmin });
  return { Cookie: `access=${token}` };
}

/**
 * 造一个可用的用户：**必须带个人空间** —— `resolveWorkspaceMembership()` 在个人空间缺失时
 * 直接 403（"个人空间不存在"），于是租户侧的断言会以一个与被测行为无关的理由失败
 * （这条一开始确实踩到了：`member` 与 `owner` 都拿 403，看起来像"权限接线错了"）。
 */
async function mkUser(email, superAdmin = false, permissionMap = null) {
  const role = permissionMap
    ? await db.adminRole.create({ data: { name: `${email}-role`, permissions: permissionMap } })
    : null;
  if (role) CREATED.roles.push(role.id);
  const user = await db.user.create({
    data: {
      email,
      super_admin: superAdmin,
      status: "active",
      ...(role ? { admin_roles: { connect: { id: role.id } } } : {}),
    },
  });
  CREATED.users.push(user.id);
  const personal = await db.workspace.create({
    data: {
      slug: `personal-${user.id}-${SUFFIX}`,
      name: `Personal ${user.id}`,
      kind: "personal",
      personal_user_id: user.id,
      created_by_id: user.id,
      members: { create: { user_id: user.id, role: "owner", active: true } },
    },
  });
  CREATED.workspaces.push(personal.id);
  return { user, cookie: await login(user.id, user.email, superAdmin) };
}

async function get(path, cookie, extraHeaders = {}) {
  return app.request(`http://localhost${path}`, { headers: { ...cookie, ...extraHeaders } });
}
async function post(path, cookie, body, extraHeaders = {}) {
  return app.request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // 带会话 cookie 的写请求必须过 CSRF：自定义头**存在即凭证**（`middlewares/csrf.ts`）。
      // 少了它会拿到 403 `CSRF_REJECTED` —— 那与本 WP 的权限判据无关，
      // 会让"member 发布被拒"这类断言以错误的理由通过（一开始就踩到了）。
      "x-csrf-token": "1",
      ...cookie,
      ...extraHeaders,
    },
    body: JSON.stringify(body ?? {}),
  });
}

after(async () => {
  await db.announcementDismissal.deleteMany({ where: { announcement_id: { in: CREATED.announcements } } });
  await db.announcement.deleteMany({
    where: { OR: [{ id: { in: CREATED.announcements } }, { title: `wp18-http-${SUFFIX}` }] },
  });
  await db.workspaceMember.deleteMany({ where: { workspace_id: { in: CREATED.workspaces } } });
  await db.workspace.deleteMany({ where: { id: { in: CREATED.workspaces } } });
  await db.user.deleteMany({ where: { id: { in: CREATED.users } } });
  await db.adminRole.deleteMany({ where: { id: { in: CREATED.roles } } });
  try {
    await redis.disconnect();
  } catch {
    /* ignore */
  }
  await db.$disconnect();
});

test("DoD9 -- 未认证 401 / 别的资源键 403 / 未登记前缀 403", { skip: !ENABLED }, async () => {
  const unauth = await app.request(`http://localhost/api/admin/announcements`);
  assert.equal(unauth.status, 401, "未认证先被挡住");

  const unrelated = await mkUser(`${SUFFIX}-nodes@example.com`, false, { nodes: "write" });
  const res = await get("/api/admin/announcements", unrelated.cookie);
  assert.equal(res.status, 403, "只有 nodes 权限的角色不得访问公告（fail-closed 未松）");

  // 对照组：登记没有顺手把"未登记前缀 = 拒绝"这条规则弄丢。
  const control = await get("/api/admin/definitely-not-registered", unrelated.cookie);
  assert.equal(control.status, 403);
});

test("DoD9 -- read 能看不能改；write 两样都行；超管直通", { skip: !ENABLED }, async () => {
  const reader = await mkUser(`${SUFFIX}-reader@example.com`, false, { announcements: "read" });
  const writer = await mkUser(`${SUFFIX}-writer@example.com`, false, { announcements: "write" });
  const superAdmin = await mkUser(`${SUFFIX}-super@example.com`, true);

  assert.equal((await get("/api/admin/announcements", reader.cookie)).status, 200);
  assert.equal(
    (await post("/api/admin/announcements", reader.cookie, { type: "normal", title: "wp18-http-reader", body: "b" })).status,
    403,
    "写操作需要 write",
  );

  const created = await post("/api/admin/announcements", writer.cookie, {
    type: "normal",
    title: "wp18-http-writer",
    body: "写权限真的能用",
  });
  assert.equal(created.status, 201, "被授权的角色必须真的能发布");
  const createdBody = await created.json();
  CREATED.announcements.push(createdBody.data.id);
  assert.equal(createdBody.data.scope_kind, "platform");
  assert.equal(createdBody.data.workspace_id, null, "平台公告的 workspace_id 必须是 NULL");

  assert.equal((await get("/api/admin/announcements", superAdmin.cookie)).status, 200);
  const revoke = await post(`/api/admin/announcements/${createdBody.data.id}/revoke`, superAdmin.cookie);
  assert.equal(revoke.status, 200, "撤回也是同一个资源键（超管直通）");
});

test("DoD9 -- 租户侧：member 发布 403；owner 发布 201；可见列表 member 也能读", { skip: !ENABLED }, async () => {
  const member = await mkUser(`${SUFFIX}-tenant-member@example.com`);
  const owner = await mkUser(`${SUFFIX}-tenant-owner@example.com`);

  const workspace = await db.workspace.create({
    data: {
      slug: `${SUFFIX}-ws`,
      name: `${SUFFIX} ws`,
      kind: "team",
      created_by_id: owner.user.id,
      members: {
        create: [
          { user_id: owner.user.id, role: "owner", active: true },
          { user_id: member.user.id, role: "member", active: true },
        ],
      },
    },
  });
  CREATED.workspaces.push(workspace.id);
  const scopeHeader = { "x-workspace-id": String(workspace.id) };

  // 发布/撤回 = settings:manage（F7）：基础成员没有它 ⇒ 403。
  const memberCreate = await post(
    "/api/announcements",
    member.cookie,
    { type: "normal", title: "wp18-http-tenant", body: "b" },
    scopeHeader,
  );
  assert.equal(memberCreate.status, 403, "member 不得发布租户公告");

  const ownerCreate = await post(
    "/api/announcements",
    owner.cookie,
    { type: "normal", title: "wp18-http-tenant", body: "b" },
    scopeHeader,
  );
  assert.equal(ownerCreate.status, 201, "owner 复用 settings:manage 发布");
  const ownerBody = await ownerCreate.json();
  CREATED.announcements.push(ownerBody.data.id);
  assert.equal(ownerBody.data.scope_kind, "workspace");
  assert.equal(ownerBody.data.workspace_id, workspace.id);

  // 用户侧可见列表**不经过** settings 判据：任何活跃成员都能读（§12.3-D4 的口径）。
  const memberList = await get("/api/announcements", member.cookie, scopeHeader);
  assert.equal(memberList.status, 200, "公告是发给所有人的：member 必须看得到");
  const listBody = await memberList.json();
  assert.ok(listBody.data.some((a) => a.id === ownerBody.data.id), "刚发布的租户公告在列表里");
  // 已读同样是成员级操作。
  const dismiss = await post(`/api/announcements/${ownerBody.data.id}/dismiss`, member.cookie, {}, scopeHeader);
  assert.equal(dismiss.status, 200);
});
