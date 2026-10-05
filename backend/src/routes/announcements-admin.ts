/**
 * Platform announcement management mounted at `/api/admin/announcements`.
 *
 * Admin authentication and the registered `announcements` resource permission
 * are enforced by the application-level admin guards. Scope is structural:
 * this router can only create platform announcements and accepts no request-body
 * scope override, so tenant callers cannot escalate a workspace announcement
 * into a platform announcement.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { db } from "../db.ts";
import type { AppVariables } from "../middlewares/auth.ts";
import { platformNotificationScope } from "../services/notification-facts.ts";
import {
  deliverAnnouncementOnPublish,
  type AnnouncementPublishDb,
} from "../services/announcement-delivery.ts";
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
  const scope = platformNotificationScope();
  const result = await createAnnouncement(deps(), {
    scope,
    type: typeof body.type === "string" ? body.type : "",
    title: body.title,
    body: body.body,
    // Publisher is the authenticated admin; the announcement row is the content fact.
    userId: user.id,
  });
  if (result.ok) {
    // Delivery is a side effect after the durable announcement exists; failures do not roll back visibility.
    void deliverAnnouncementOnPublish(db as unknown as AnnouncementPublishDb, {
      row: result.value,
      scope,
    }).catch(() => {});
  }
  return send(c, result, 201);
});

announcementAdminRoutes.post("/announcements/:id/revoke", async (c) => {
  const result = await revokeAnnouncement(deps(), {
    scope: platformNotificationScope(),
    announcementId: Number(c.req.param("id")),
  });
  return send(c, result);
});
