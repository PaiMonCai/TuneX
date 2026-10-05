/**
 * V5-WP18.5 —— 公告的**用户侧 + 租户侧**接口（契约 §F6 / §F7）。
 *
 * 端点：
 *   GET    /api/announcements                可见公告（platform ∪ 本 workspace）+ 本用户已读标记
 *   POST   /api/announcements/:id/dismiss    标记已读（幂等）
 *   GET    /api/announcements/preferences    当前用户的免打扰清单（每用户 × 每渠道 × 每类别）
 *   PUT    /api/announcements/preferences    全量替换免打扰清单
 *   GET    /api/announcements/manage         本租户公告（含已撤回）—— 需 `settings:read`
 *   POST   /api/announcements                发布本租户公告 —— 需 `settings:manage`
 *   POST   /api/announcements/:id/revoke     撤回本租户公告 —— 需 `settings:manage`
 *
 * ── 权限：为什么"读公告"不是 `settings:read` ──
 * 公告是**发给所有人**的内容。若把可见列表挂在 `settings:read` 上，一个自定义角色里没有
 * `settings:read` 的成员就看不到平台公告 —— 那不是权限收紧，那是功能坏掉。因此：
 *   · 可见列表 / 已读 = **活跃成员**即可（`resolveWorkspaceMembership`，任何角色都能读）；
 *   · 管理面（列全部含已撤回 / 发布 / 撤回）= F7 的口径，复用 `settings:read` / `settings:manage`，
 *     **不新增**权限键（`WORKSPACE_PERMISSIONS` 是白名单，改它要同步 UI + 测试）。
 * 这条取舍已写回契约 §12，等 Lead 复核。
 *
 * ── 免打扰为什么在 `/announcements/preferences` 而不是工作空间作用域 ──
 * 它是**用户级**偏好（F6.5 的三元映射里没有 workspace），所以这两个端点只认会话用户、
 * 不需要 `x-workspace-id`，也不经过任何工作空间权限判定。
 *
 * 平台公告（发布/撤回/列全部）在 `announcements-admin.ts`（挂 `/api/admin/announcements`）。
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { db } from "../db.ts";
import type { AppVariables } from "../middlewares/auth.ts";
import { resolveWorkspaceMembership, resolveWorkspaceAccess } from "../services/workspace.ts";
import { workspaceNotificationScope } from "../services/notification-facts.ts";
import {
  deliverAnnouncementOnPublish,
  type AnnouncementPublishDb,
} from "../services/announcement-delivery.ts";
import {
  createAnnouncement,
  dismissAnnouncement,
  listAnnouncementsForManagement,
  listVisibleAnnouncements,
  revokeAnnouncement,
  type AnnouncementDeps,
  type AnnouncementErrorCode,
  type AnnouncementResult,
} from "../services/announcement.ts";
import {
  NOTIFICATION_MUTE_CATEGORIES,
  NOTIFICATION_MUTE_CHANNELS,
  loadUserMutes,
  parseNotificationMutes,
  replaceUserMutes,
  type NotificationMuteDb,
} from "../services/announcement-mute.ts";

export const announcementRoutes = new Hono<{ Variables: AppVariables }>();

type Ctx = Context<{ Variables: AppVariables }>;

function requireUser(c: Ctx): NonNullable<AppVariables["user"]> {
  const user = c.get("user");
  if (!user) throw new HTTPException(401, { message: "Unauthorized" });
  return user;
}

function deps(): AnnouncementDeps {
  return { db: db as unknown as AnnouncementDeps["db"] };
}

/**
 * 发布成功后的**投递接线**（V5-WP18.5 §12.3-D10）。
 *
 * 三条纪律：
 *  ① **不 await、不冒泡**：公告已经落库、站内已可见，投递是旁路（`mail.ts`/`audit.ts` 同一取向）。
 *     `deliverAnnouncementOnPublish` 自己吞掉所有异常，`.catch` 只是防"不可达的拒绝"变成
 *     进程级 unhandled rejection。
 *  ② **scope 由调用点决定**（不由请求体决定）：平台公告只会在管理端路由里生成，
 *     租户公告只在这里 —— 请求体里没有 scope 参数，也就没有越权的入口。
 *  ③ 走**同一本账本、同一套免打扰/静默判据**：`deliverAnnouncementOnPublish` 内部就是
 *     一次 `deliverNotificationFacts()` 调用。
 */
function fireAnnouncementDelivery(
  row: { id: number; type: string; title: string; body: string; published_at: string },
  scope: ReturnType<typeof workspaceNotificationScope>,
): void {
  void deliverAnnouncementOnPublish(db as unknown as AnnouncementPublishDb, { row, scope }).catch(() => {});
}

/** 错误码 → HTTP 状态。未知码一律 500（不把编程错误伪装成业务拒绝）。 */
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

/** 解析请求体：只认 `type` / `title` / `body` 三个键，多余的键不参与（也不报错）。 */
async function readCreateBody(c: Ctx): Promise<{ type: string; title: unknown; body: unknown } | null> {
  const raw = await c.req.json().catch(() => null);
  if (typeof raw !== "object" || raw === null) return null;
  const body = raw as { type?: unknown; title?: unknown; body?: unknown };
  return {
    type: typeof body.type === "string" ? body.type : "",
    title: body.title,
    body: body.body,
  };
}

/* ------------------------------------------------------------------ */
/* 用户侧：可见列表 + 已读                                             */
/* ------------------------------------------------------------------ */

announcementRoutes.get("/", async (c) => {
  const access = await resolveWorkspaceMembership(c);
  const user = requireUser(c);
  const result = await listVisibleAnnouncements(deps(), {
    scope: workspaceNotificationScope(access.id),
    userId: user.id,
  });
  return send(c, result);
});

announcementRoutes.post("/:id/dismiss", async (c) => {
  const access = await resolveWorkspaceMembership(c);
  const user = requireUser(c);
  const result = await dismissAnnouncement(deps(), {
    scope: workspaceNotificationScope(access.id),
    userId: user.id,
    announcementId: Number(c.req.param("id")),
  });
  return send(c, result);
});

/* ------------------------------------------------------------------ */
/* 免打扰（用户级偏好）                                                */
/* ------------------------------------------------------------------ */

const muteDb = (): NotificationMuteDb => db as unknown as NotificationMuteDb;

announcementRoutes.get("/preferences", async (c) => {
  const user = requireUser(c);
  const result = await loadUserMutes(muteDb(), user.id);
  if (!result.ok) {
    return c.json({ error: "免打扰存储暂时不可用", code: "storage_error", error_layer: "announcement" }, 503);
  }
  return c.json({
    data: {
      mutes: result.value,
      // 可选值 = 后端的两份闭集（渠道 / 类别），前端不必硬编码一份会漂移的副本。
      channels: NOTIFICATION_MUTE_CHANNELS,
      categories: NOTIFICATION_MUTE_CATEGORIES,
    },
  });
});

announcementRoutes.put("/preferences", async (c) => {
  const user = requireUser(c);
  const raw = await c.req.json().catch(() => null);
  const parsed = parseNotificationMutes((raw as { mutes?: unknown } | null)?.mutes);
  if (!parsed.ok) {
    // fail-closed：不认识的渠道/类别**整个请求拒绝**，不做"丢掉不认识的项"的降级（C3）。
    return c.json({ error: "免打扰清单不合法", code: parsed.reason, error_layer: "announcement" }, 400);
  }
  const result = await replaceUserMutes(muteDb(), user.id, parsed.mutes);
  if (!result.ok) {
    return c.json({ error: "免打扰存储暂时不可用", code: "storage_error", error_layer: "announcement" }, 503);
  }
  return c.json({ data: { mutes: result.value } });
});

/* ------------------------------------------------------------------ */
/* 租户管理面（settings:read / settings:manage）                       */
/* ------------------------------------------------------------------ */

announcementRoutes.get("/manage", async (c) => {
  const access = await resolveWorkspaceAccess(c, "read", "settings");
  const result = await listAnnouncementsForManagement(deps(), workspaceNotificationScope(access.id));
  return send(c, result);
});

announcementRoutes.post("/", async (c) => {
  const access = await resolveWorkspaceAccess(c, "manage", "settings");
  const user = requireUser(c);
  const body = await readCreateBody(c);
  if (!body) return c.json({ error: "请求体不是合法 JSON 对象", code: "invalid_body" }, 400);
  const scope = workspaceNotificationScope(access.id);
  const result = await createAnnouncement(deps(), {
    scope,
    type: body.type,
    title: body.title,
    body: body.body,
    userId: user.id,
  });
  if (result.ok) fireAnnouncementDelivery(result.value, scope);
  return send(c, result, 201);
});

announcementRoutes.post("/:id/revoke", async (c) => {
  const access = await resolveWorkspaceAccess(c, "manage", "settings");
  const result = await revokeAnnouncement(deps(), {
    scope: workspaceNotificationScope(access.id),
    announcementId: Number(c.req.param("id")),
  });
  return send(c, result);
});
