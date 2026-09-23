/**
 * Hono 应用装配 —— 中间件链顺序严格对齐原版 src/app.ts
 * 依据: relayx-auth-rbac-source-verification-report.md §1
 *
 * 链序：
 *   ① getRequestIP + requestLogger
 *   ② CORS（仅非生产）
 *   ③ 免认证白名单命中 → 直接放行（/api/auth/*, /api/pay/*\/callback,
 *      /api/tunnel/observer, /healthz, /api/system/config/site, /api/license ...）
 *   ④ authRequired（双通道：Cookie access JWT | Bearer api_key）
 *   ⑤ [/api/admin/*] adminRequired → adminPermissionGuard
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { env } from "./env.ts";
import { db } from "./db.ts";
import { redisPing } from "./redis.ts";
import {
  authRequired,
  adminRequired,
  adminPermissionGuard,
  extractIp,
  type AppVariables,
} from "./middlewares/auth.ts";
import { authRoutes } from "./routes/auth.ts";
import { adminRoutes } from "./routes/admin.ts";
import { adminExtendedRoutes } from "./routes/admin-extended.ts";
import { publicRoutes } from "./routes/public.ts";
import { payRoutes } from "./routes/pay.ts";
import { dashboardRoutes } from "./routes/dashboard.ts";
import { tunnelsRoutes } from "./routes/tunnels.ts";
import { plansRoutes } from "./routes/plans.ts";
import { topupsRoutes } from "./routes/topups.ts";
import { paymentsRoutes } from "./routes/topups.ts";
import { ticketsRoutes } from "./routes/tickets.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { nodeGroupsRoutes } from "./routes/node-groups.ts";

export function createApp() {
  const app = new Hono<{ Variables: AppVariables }>();

  // ① 请求 IP 提取 + 结构化访问日志
  app.use("*", async (c, next) => {
    c.set("ip", extractIp(c.req.raw.headers));
    const start = Date.now();
    await next();
    const ms = Date.now() - start;
    console.log(
      JSON.stringify({
        t: new Date().toISOString(),
        ip: c.get("ip"),
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms,
      }),
    );
  });

  // ② CORS（生产不启用，与原版一致）
  if (!env.isProduction) app.use("*", cors());

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message || "Error" }, err.status);
    }
    console.error("[unhandled]", err);
    return c.json({ error: "Internal Server Error" }, 500);
  });

  // ③ 健康检查（免认证）
  app.get("/healthz", (c) => c.json({ status: "ok", service: "tunex-backend", w: "W1" }));
  app.get("/readyz", async (c) => {
    const checks: Record<string, boolean> = {};
    try {
      await db.$queryRaw`SELECT 1`;
      checks.mysql = true;
    } catch {
      checks.mysql = false;
    }
    checks.redis = await redisPing();
    const ok = Object.values(checks).every(Boolean);
    return c.json({ status: ok ? "ok" : "degraded", checks }, ok ? 200 : 503);
  });

  // ④ 全局认证（白名单在 authRequired 内部短路）
  app.use("*", authRequired);

  // ⑤ 管理端两道闸
  app.use("/api/admin/*", adminRequired);
  app.use("/api/admin/*", adminPermissionGuard);

  // 路由挂载
  app.route("/api/auth", authRoutes);
  app.route("/api/pay", payRoutes);
  app.route("/api/dashboard", dashboardRoutes);
  app.route("/api/tunnels", tunnelsRoutes);
  app.route("/api/plans", plansRoutes);
  app.route("/api/topups", topupsRoutes);
  app.route("/api/payments", paymentsRoutes);
  app.route("/api/tickets", ticketsRoutes);
  app.route("/api/settings", settingsRoutes);
  app.route("/api/node-groups", nodeGroupsRoutes);
  app.route("/api", publicRoutes);
  app.route("/api/admin", adminRoutes);
  app.route("/api/admin", adminExtendedRoutes);

  app.get("/", (c) => c.json({ service: "tunex-backend", week: "W1", site_url: env.siteUrl }));

  return app;
}

export const app = createApp();
