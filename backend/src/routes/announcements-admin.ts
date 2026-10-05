/**
 * V5-WP18.5 —— 平台公告的管理端接口（契约 §F6 / §F7）。挂载于 `/api/admin/announcements`。
 *
 * 端点：
 *   GET  /api/admin/announcements                平台公告（含已撤回）
 *   POST /api/admin/announcements                发布平台公告（`type`: normal | popup）
 *   POST /api/admin/announcements/:id/revoke     撤回平台公告
 *
 * ── 权限：本文件**故意不碰** `permissions.ts` ──
 * `/api/admin/*` 的 `adminRequired` + `adminPermissionGuard` 由 `app.ts` 统一施加
 * （§⑥），而 `adminPermissionGuard` 对**未登记前缀**一律 403、只放行 `super_admin`
 * —— 这正是契约 F7 写的行为（「不登记 = 只有超管」fail-closed）。
 *
 * 把 `/admin/announcements` 登记进 `ADMIN_RESOURCES`（让被授权的管理员角色也能用）是
 * **WP18.6 的动作**：权限接线与实现分开交付，这里不预先登记 —— 一旦这里登记了，18.6 的
 * 「登记生效」断言就没有可观察的起点（改动前 403 → 改动后 200 才是它的证据）。
 *
 * ── 为什么平台公告不能由租户管理员发布 ──
 * `createAnnouncement` 的 scope 是 `{kind:"platform", workspace_id:null}`（判别联合，
 * 类型层面就带不上 workspace_id）。租户侧的发布入口在 `announcements.ts`，它只构造
 * `workspace` 作用域 —— 两条路径各写各的，不存在"用请求体指定 scope"的入口（那才是
 * 越权面）。因此这里**没有**任何来自请求体的 scope 参数：scope 由"挂在哪个路由上"决定。
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { db } from "../db.ts";
import type { AppVariables } from "../middlewares/auth.ts";
import { platformNotificationScope } from "../services/notification-facts.ts";
import {
  createAnnouncement,
  listAnnouncementsForManagement,
  revokeAnnouncement,
  type AnnouncementDeps,
  type AnnouncementErrorCode,
  type AnnouncementResult,
} from "../services/announcement.ts";

export const announcementAdminRoutes = new Hono<{ Variables: AppVariables }>();

type Ctx = Context<{ Variables: AppVariables }>;

function requireUser(c: Ctx): NonNullable<AppVariables["user"]> {
  const user = c.get("user");
  if (!user) throw new HTTPException(401, { message: "Unauthorized" });
  return user;
}

function deps(): AnnouncementDeps {
  return { db: db as unknown as AnnouncementDeps["db"] };
}

const STATUS_BY_CODE: Record<AnnouncementErrorCode, 400 | 404 | 409 | 500 | 503> = {
  invalid_scope: 400,
  invalid_type: 400,
  invalid_title: 400,
  invalid_body: 400,
  not_found: 404,
  active_popup_exists: 409,
  storage_error: 503,
};

function send<T>(c: Ctx, result: AnnouncementResult<T>, successStatus: 200 | 201 = 200) {
  if (!result.ok) {
    return c.json({ error: result.error, code: result.code, error_layer: "announcement" }, STATUS_BY_CODE[result.code]);
  }
  return c.json({ data: result.value }, successStatus);
}

announcementAdminRoutes.get("/announcements", async (c) => {
  const result = await listAnnouncementsForManagement(deps(), platformNotificationScope());
  return send(c, result);
});

announcementAdminRoutes.post("/announcements", async (c) => {
  const user = requireUser(c);
  const raw = await c.req.json().catch(() => null);
  if (typeof raw !== "object" || raw === null) {
    return c.json({ error: "请求体不是合法 JSON 对象", code: "invalid_body" }, 400);
  }
  const body = raw as { type?: unknown; title?: unknown; body?: unknown };
  const result = await createAnnouncement(deps(), {
    scope: platformNotificationScope(),
    type: typeof body.type === "string" ? body.type : "",
    title: body.title,
    body: body.body,
    // 发布者 = 当前超管；审计面另有 audit_log（本层不写审计：公告表本身就是事实）。
    userId: user.id,
  });
  return send(c, result, 201);
});

announcementAdminRoutes.post("/announcements/:id/revoke", async (c) => {
  const result = await revokeAnnouncement(deps(), {
    scope: platformNotificationScope(),
    announcementId: Number(c.req.param("id")),
  });
  return send(c, result);
});
