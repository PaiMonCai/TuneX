/**
 * 免认证端点：支付回调 / 隧道观测 / 站点配置 / license
 * 对应 noAuthPaths 白名单中的业务路径（部分端点仍为占位实现）。
 */
import { Hono } from "hono";
import { db } from "../db.ts";
import { redis, RedisKeys } from "../redis.ts";
import { systemConfig } from "../services/config.ts";
import { resolveUserByKey } from "../services/user-keys.ts";
import type { AppVariables } from "../middlewares/auth.ts";

export const publicRoutes = new Hono<{ Variables: AppVariables }>();

/** POST /api/tunnel/observer —— agent 观测数据回传（免认证） */
publicRoutes.post("/tunnel/observer", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "invalid json" }, 400);

  // Writes to Redis buffer; DB persistence via HINCRBYFLOAT + cron archiving.
  try {
    await redis.rpush(
      `${RedisKeys.observerBuffer}:raw`,
      JSON.stringify({ at: Date.now(), body }),
    );
  } catch {
    /* Redis 故障返回 200 避免 agent 重试风暴 */
  }
  return c.json({ data: { ok: true } });
});

/** GET /api/tunnel/subscription —— 订阅式配置分发（免认证，凭 subscription_key） */
publicRoutes.get("/tunnel/subscription", async (c) => {
  const key = c.req.query("token") ?? c.req.query("key") ?? "";
  if (!key) return c.json({ error: "missing token" }, 400);
  // SEC-02：凭据哈希化查询 —— 先 subscription_key_hash，未命中再查 legacy 明文列
  //（存量 60+ 用户的旧行，命中时同事务写哈希并清空明文，完成惰性迁移）。
  const user = await resolveUserByKey("subscription_key", key);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  // The legacy subscription key belongs to the account, not to a team. It must never
  // grant access to team assets even when the account created those assets.
  const personal = await db.workspace.findUnique({ where: { personal_user_id: user.id }, select: { id: true } });
  if (!personal) return c.json({ error: "Unauthorized" }, 401);
  return c.json({ data: { tunnels: await db.tunnel.findMany({ where: { workspace_id: personal.id } }) } });
});

/** GET /api/system/config/site —— 站点公开配置（免认证） */
publicRoutes.get("/system/config/site", async (c) => {
  const names = [
    "SITE_NAME",
    "SITE_DESCRIPTION",
    "LOGO_URL",
    "NOTICE",
    "NOTICE_POPUP",
    "NOTICE_POPUP_INTERVAL_HOURS",
    "ALLOW_REGISTER",
    "HIDE_NODE_STATUS",
    "HIDE_FOOTER",
    "HIDE_DOCS",
    "LANDING_PAGE_URL",
    "MIN_TOPUP_AMOUNT",
    "ENABLE_SUBSCRIPTION",
  ];
  const rows = await systemConfig.listAll();
  const data: Record<string, string> = {};
  for (const n of names) {
    const row = rows.find((r) => String(r.name) === n);
    if (row) data[n] = row.value;
  }
  return c.json({ data });
});

/** GET /api/license —— 授权状态（免认证，原版语义） */
publicRoutes.get("/license", async (c) => {
  const { licenseService } = await import("../services/license.ts");
  return c.json({ data: (await licenseService.getLicense()) ?? { type: "none" } });
});

/** POST /api/pay/:id/callback —— 支付网关回调（免认证） */
publicRoutes.post("/pay/:id/callback", async (c) => {
  const id = c.req.param("id");
  const raw = await c.req.text();
  try {
    await redis.rpush(`pay:callback:${id}`, JSON.stringify({ at: Date.now(), raw }));
  } catch {
    /* ignore */
  }
  return c.text("success");
});
