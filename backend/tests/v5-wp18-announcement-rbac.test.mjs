/**
 * V5-WP18.6 —— 权限接线：`/admin/announcements` 的 RBAC 登记**真的生效**（契约 F7 / DoD9）。
 *
 * ── 为什么这条断言是"登记"这件事的全部证据 ──
 * `adminPermissionGuard` 的行为是「未登记前缀 ⇒ 403，只放行超管」（fail-closed）。所以
 * 「登记生效」不能靠"代码里出现了一个资源键"来证明，只能靠**可观察的判定变化**：
 *   · 登记**前**：`resolveAdminRoute("/admin/announcements")` 是 `undefined`（谁都得 403）；
 *   · 登记**后**：它解析到 `announcements`，于是**持该键的角色真的能过**，而
 *     **没有该键的角色仍然被挡**（这才是 fail-closed 没被顺手拆掉）。
 * 另外两件事必须一起成立，否则"能授权"是假的：`sanitizePermissions()` 必须**收得下**这个键
 * （角色入库前的白名单），`requiredLevel()` 必须让读/写分级（GET=read，POST=write）。
 *
 * 同一条原则的另一半：**租户侧不新增权限键**（F7）。租户公告的发布/撤回复用
 * `settings:manage`，用户侧的可见列表与已读只需"是本 workspace 的活跃成员"—— 这条口径
 * 在 §12.3-D4 由 Lead 确认，这里把它钉成可执行断言（含那个反例：缺 `settings:read` 的
 * 自定义角色成员**仍然看得到**平台公告）。
 *
 * 跑法（backend 目录）：node --experimental-transform-types --test tests/v5-wp18-announcement-rbac.test.mjs
 * （CI 的 `bun run test` 用 `tests/*.test.mjs` glob，所以这份文件自动进 CI。）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ADMIN_RESOURCE_KEYS,
  ADMIN_RESOURCES,
  getEffectiveAccess,
  isAdminResourceKey,
  levelSatisfies,
  requiredLevel,
  resolveAdminRoute,
  sanitizePermissions,
} from "../src/permissions.ts";
import { canWorkspaceResourceAction } from "../src/services/workspace.ts";

// `import.meta.url` = `<repo>/backend/tests/<file>`，所以：
//   `../`     → `<repo>/backend/`（后端源码根）
//   `../../`  → `<repo>/`（web/ 与 backend/ 的父目录）
const BACKEND = new URL("../", import.meta.url);
const WEB = new URL("../../web/", import.meta.url);

test("登记生效：/admin/announcements 解析到 announcements，且读写按方法分级", () => {
  assert.equal(isAdminResourceKey("announcements"), true);
  assert.deepEqual(resolveAdminRoute("/admin/announcements"), { prefix: "/admin/announcements", key: "announcements" });
  // 子路径（发布 / 撤回）走同一个前缀 —— 否则撤回会掉进"未登记 ⇒ 403"。
  assert.equal(resolveAdminRoute("/admin/announcements/42/revoke")?.key, "announcements");
  assert.equal(requiredLevel("GET"), "read");
  assert.equal(requiredLevel("POST"), "write");
  // 前缀匹配必须在段边界上收住：`/admin/announcements-x` 不是这个资源。
  assert.equal(resolveAdminRoute("/admin/announcements-x"), undefined);
});

test("能授权（这是「登记」的可观察效果，不只是表里多一行）", () => {
  // 登记前这个键会被 `sanitizePermissions` 丢掉 ⇒ 角色根本存不下它。
  assert.deepEqual(sanitizePermissions({ announcements: "write", "not-a-resource": "write" }), {
    announcements: "write",
  });

  const reader = getEffectiveAccess({ super_admin: false, admin_roles: [{ permissions: { announcements: "read" } }] });
  const writer = getEffectiveAccess({ super_admin: false, admin_roles: [{ permissions: { announcements: "write" } }] });
  const other = getEffectiveAccess({ super_admin: false, admin_roles: [{ permissions: { nodes: "write" } }] });

  // read 能看不能改；write 两样都行；**别的资源键仍然拦得住**（fail-closed 没被顺手拆掉）。
  assert.equal(levelSatisfies(reader.get("announcements"), requiredLevel("GET")), true);
  assert.equal(levelSatisfies(reader.get("announcements"), requiredLevel("POST")), false);
  assert.equal(levelSatisfies(writer.get("announcements"), requiredLevel("POST")), true);
  assert.equal(other.has("announcements"), false);
  // 超管直通（既有语义）。
  const superAdmin = getEffectiveAccess({ super_admin: true, admin_roles: [] });
  assert.equal(superAdmin.get("announcements"), "write");
});

test("未登记前缀依旧 fail-closed（对照组不能因为这次登记而消失）", () => {
  assert.equal(resolveAdminRoute("/admin/definitely-not-registered"), undefined);
  // 全表也没有重复键（重复会让"最长前缀优先"的排序变成不确定行为）。
  assert.equal(new Set(ADMIN_RESOURCE_KEYS).size, ADMIN_RESOURCE_KEYS.length);
  const url = ADMIN_RESOURCES.find((r) => r.key === "announcements")?.url;
  assert.equal(url, "/admin/announcements");
});

test("租户侧：发布/撤回复用 settings:manage，用户侧读只要活跃成员（不新增权限键）", () => {
  const base = { id: 7, personalWorkspaceId: 7, kind: "personal", customRoleId: null };
  const member = { ...base, role: "member" };
  const viewer = { ...base, role: "viewer" };
  // 管理面（routes/announcements.ts 的 /manage、POST /、/revoke 用的正是这一对）。
  assert.equal(canWorkspaceResourceAction(member, "manage", "settings"), false);
  assert.equal(canWorkspaceResourceAction({ ...base, role: "admin" }, "manage", "settings"), true);
  assert.equal(canWorkspaceResourceAction({ ...base, role: "owner" }, "manage", "settings"), true);
  // 用户侧可见列表**不经过**这一层（路由只做成员解析）：连 viewer 也能读公告——
  // 若把它挂在 settings:read 上，缺该键的自定义角色成员就看不到平台公告（D4 的反例）。
  assert.equal(canWorkspaceResourceAction(viewer, "read", "settings"), true);
  const customWithoutSettings = {
    ...base,
    role: "member",
    customRoleId: 3,
    customPermissions: { "forward:read": true },
  };
  // 这一对说明"自定义角色缺 settings:read 时，管理面被挡"（这是对的），
  // 而用户侧可见列表压根不走这里（下面用源码级断言钉住路由确实这么接的）。
  assert.equal(canWorkspaceResourceAction(customWithoutSettings, "read", "settings"), false);
});

test("路由确实按上面的口径接线（源码级；行为层受 DB 认证链阻挡，这里钉住的是「选了哪对判据」）", () => {
  const routes = readFileSync(new URL("src/routes/announcements.ts", BACKEND), "utf8");
  // 用户侧：成员解析（任何活跃成员都能看公告、标记已读）。
  assert.match(routes, /get\("\/",[\s\S]{0,200}resolveWorkspaceMembership\(c\)/);
  assert.match(routes, /post\("\/:id\/dismiss",[\s\S]{0,200}resolveWorkspaceMembership\(c\)/);
  // 管理面：settings:read / settings:manage。
  assert.match(routes, /get\("\/manage",[\s\S]{0,200}resolveWorkspaceAccess\(c, "read", "settings"\)/);
  assert.match(routes, /post\("\/",[\s\S]{0,200}resolveWorkspaceAccess\(c, "manage", "settings"\)/);
  assert.match(routes, /post\("\/:id\/revoke",[\s\S]{0,300}resolveWorkspaceAccess\(c, "manage", "settings"\)/);
  // 免打扰是用户级偏好：那两个端点不套工作空间判据。
  assert.match(routes, /put\("\/preferences",[\s\S]{0,200}requireUser\(c\)/);
});

test("闭环：菜单入口不再挂 planned，且与资源键指向同一路径（同一个 WP 里收口）", () => {
  const nav = readFileSync(new URL("src/lib/nav.ts", WEB), "utf8");
  const item = nav.slice(nav.indexOf('href: "/admin/announcements"'));
  const block = item.slice(0, item.indexOf("},"));
  assert.equal(/status:\s*"planned"/.test(block), false, "登记完成后必须摘掉 planned（否则页面在、入口点不动）");
  assert.equal(nav.includes('labelKey: "admin.announcements"'), true);
  // 页面真的存在（不是"声明得到、点进去 404"）。
  assert.doesNotThrow(() =>
    readFileSync(new URL("src/app/(admin)/admin/announcements/page.tsx", WEB), "utf8"),
  );
});
