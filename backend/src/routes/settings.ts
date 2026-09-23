/**
 * 个人设置路由（用户侧）—— 前端 api.settings.*
 *
 * 端点：
 *   GET    /api/settings/profile             当前用户资料（含 api_key / subscription_key）
 *   PATCH  /api/settings/profile             更新 email / note / tg_id / auto_renew
 *   POST   /api/settings/password            修改密码（校验旧密码）
 *   POST   /api/settings/api-key             重新生成 API Key（UUID，供 Bearer 通道）
 *   POST   /api/settings/api-key/regenerate  同上（兼容旧客户端）
 *   POST   /api/settings/subscription-key            重新生成订阅密钥
 *   POST   /api/settings/subscription-key/regenerate 同上（兼容旧客户端）
 *
 * 挂载方式（由 app.ts 的收尾子代理执行，本模块不修改 app.ts）：
 *   import { settingsRoutes } from "./routes/settings.ts";
 *   app.route("/api/settings", settingsRoutes);
 *
 * 响应封装：前端 lib/api.ts 的 request() 会剥掉 **一层** 顶层 `data`，
 * 故本模块统一返回 `{ data: <业务对象> }`，前端拿到的即为业务对象本身。
 *
 * 认证：本路径不在免认证白名单内，app.ts 全局 authRequired 已注入 c.get("user")；
 * 这里仍做一次空值防御（模块可被单独挂载 / 测试）。
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { randomUUID } from "node:crypto";
import { db } from "../db.ts";
import { hashPassword, verifyPassword } from "../auth.ts";
import type { AppVariables } from "../middlewares/auth.ts";

export const settingsRoutes = new Hono<{ Variables: AppVariables }>();

/* ------------------------------------------------------------------ */
/* 工具                                                               */
/* ------------------------------------------------------------------ */

function requireUser(c: Context<{ Variables: AppVariables }>): NonNullable<AppVariables["user"]> {
  const user = c.get("user");
  if (!user) throw new HTTPException(401, { message: "Unauthorized" });
  return user;
}

/** 对外用户视图：剔除 credential 等敏感关联（c.get("user") 本身已不含 credential） */
function publicUser(u: Record<string, unknown>) {
  return u;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function pickStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s || null;
}

/* ------------------------------------------------------------------ */
/* GET /profile                                                       */
/* ------------------------------------------------------------------ */

settingsRoutes.get("/profile", (c) => {
  const user = requireUser(c);
  return c.json({ data: publicUser(user as unknown as Record<string, unknown>) });
});

/* ------------------------------------------------------------------ */
/* PATCH /profile                                                     */
/* ------------------------------------------------------------------ */

settingsRoutes.patch("/profile", async (c) => {
  const user = requireUser(c);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return c.json({ error: "参数错误" }, 400);

  const data: Record<string, unknown> = {};

  if ("email" in body) {
    const email = String(body.email ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return c.json({ error: "邮箱格式不正确" }, 400);
    if (email !== user.email) {
      const dup = await db.user.findUnique({ where: { email } });
      if (dup && dup.id !== user.id) return c.json({ error: "该邮箱已被占用" }, 400);
      data.email = email;
    }
  }
  if ("note" in body) data.note = pickStr(body.note);
  if ("tg_id" in body) data.tg_id = pickStr(body.tg_id);
  if ("auto_renew" in body) data.auto_renew = Boolean(body.auto_renew);

  const updated =
    Object.keys(data).length > 0
      ? await db.user.update({ where: { id: user.id }, data })
      : user;

  return c.json({ data: publicUser(updated as unknown as Record<string, unknown>) });
});

/* ------------------------------------------------------------------ */
/* POST /password                                                     */
/* ------------------------------------------------------------------ */

settingsRoutes.post("/password", async (c) => {
  const user = requireUser(c);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;

  const current = String(body?.current_password ?? "");
  const next = String(body?.new_password ?? "");
  if (!current || !next) return c.json({ error: "缺少必填字段" }, 400);
  if (next.length < 6) return c.json({ error: "新密码至少 6 位" }, 400);

  const cred = await db.userCredential.findUnique({ where: { user_id: user.id } });
  if (!cred) return c.json({ error: "账号未设置密码" }, 400);

  const ok = await verifyPassword(current, cred.password);
  if (!ok) return c.json({ error: "当前密码不正确" }, 400);

  await db.userCredential.update({
    where: { user_id: user.id },
    data: { password: await hashPassword(next) },
  });
  return c.json({ data: { ok: true } });
});

/* ------------------------------------------------------------------ */
/* POST /api-key (+ /api-key/regenerate)                              */
/* ------------------------------------------------------------------ */

async function regenerateApiKey(c: Context<{ Variables: AppVariables }>) {
  const user = requireUser(c);
  // 必须为 UUID：承载 Bearer 认证通道（middlewares/auth.ts 走 isUUID）
  const key = randomUUID();
  const updated = await db.user.update({ where: { id: user.id }, data: { api_key: key } });
  return c.json({ data: { ok: true, api_key: key, user: updated } });
}

settingsRoutes.post("/api-key", regenerateApiKey);
settingsRoutes.post("/api-key/regenerate", regenerateApiKey);

/* ------------------------------------------------------------------ */
/* POST /subscription-key (+ /subscription-key/regenerate)            */
/* ------------------------------------------------------------------ */

async function regenerateSubscriptionKey(c: Context<{ Variables: AppVariables }>) {
  const user = requireUser(c);
  const key = randomUUID();
  const updated = await db.user.update({
    where: { id: user.id },
    data: { subscription_key: key },
  });
  return c.json({ data: { ok: true, subscription_key: key, user: updated } });
}

settingsRoutes.post("/subscription-key", regenerateSubscriptionKey);
settingsRoutes.post("/subscription-key/regenerate", regenerateSubscriptionKey);
