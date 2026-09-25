/**
 * Hono 应用装配 —— 中间件链顺序严格对齐原版 src/app.ts
 * 依据: auth-rbac-source-verification-report.md §1
 *
 * 链序：
 *   ① getRequestIP + requestLogger
 *   ② CORS（仅非生产）
 *   ③ 免认证白名单命中 → 直接放行（/api/auth/*, /api/pay/*\/callback,
 *      /api/tunnel/observer, /healthz, /api/system/config/site, /api/license ...）
 *   ③.5 CSRF 防护（createCsrfMiddleware：Origin/Referer + 自定义头存在性）
 *   ④ authRequired（双通道：Cookie access JWT | Bearer api_key）
 *   ⑤ [/api/admin/*] adminRequired → adminPermissionGuard
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { env } from "./env.ts";
import { isBillingBlocked } from "./services/billing-access.ts";
import { db } from "./db.ts";
import { redisPing } from "./redis.ts";
import {
  authRequired,
  adminRequired,
  adminPermissionGuard,
  extractIp,
  type AppVariables,
} from "./middlewares/auth.ts";
import { createAuditMiddleware } from "./middlewares/audit.ts";
import { createCsrfMiddleware } from "./middlewares/csrf.ts";
import { createRateLimitMiddleware } from "./middlewares/rate-limit.ts";
import { authRoutes } from "./routes/auth.ts";
import { adminRoutes } from "./routes/admin.ts";
import { nodeGrantRoutes } from "./routes/admin-node-grants.ts";
import { workspaceRoutes } from "./routes/workspaces.ts";
import { adminExtendedRoutes } from "./routes/admin-extended.ts";
import { nodeAdminRoutes } from "./routes/node-admin.ts";
import { publicRoutes } from "./routes/public.ts";
import { internalNodeRoutes } from "./routes/internal-node.ts";
import { payRoutes } from "./routes/pay.ts";
import { dashboardRoutes } from "./routes/dashboard.ts";
import { tunnelsRoutes } from "./routes/tunnels.ts";
import { forwardsRoutes } from "./routes/forwards.ts";
import { plansRoutes } from "./routes/plans.ts";
import { topupsRoutes } from "./routes/topups.ts";
import { paymentsRoutes } from "./routes/topups.ts";
import { ticketsRoutes } from "./routes/tickets.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { nodeGroupsRoutes } from "./routes/node-groups.ts";
import { nodesRoutes } from "./routes/nodes.ts";

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
  app.get("/healthz", (c) => c.json({ status: "ok", service: "tunex-backend" }));
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

  // Billing is opt-in; deny callbacks and writes before auth or route handlers.
  app.use("*", async (c, next) => {
    if (isBillingBlocked(c.req.path, c.req.method, env.paymentsEnabled)) {
      return c.json({ error: "支付功能未启用" }, 403);
    }
    await next();
  });

  // ③.5 CSRF 防护（billing gate 之后、authRequired 之前）
  //   必须早于认证：它只看 cookie 头存在性（不需要知道用户是谁），
  //   提前挡住跨站写，避免未认证的 CSRF 探测产生任何副作用；
  //   /api/auth/* 登录/注册 POST 同受其保护（防登录 CSRF），这是有意的。
  app.use("*", createCsrfMiddleware());

  // ④ 全局认证（白名单在 authRequired 内部短路）
  app.use("*", authRequired);

  // ⑤ 审计日志 + 全局限流
  //   审计在限流之前：被限流的请求也要留痕；两者对免认证白名单同样生效
  //   （登录/注册/支付回调的滥用同样进入审计与限流规则）。
  app.use("*", createAuditMiddleware());
  app.use("*", createRateLimitMiddleware());

  // ⑥ 管理端两道闸
  app.use("/api/admin/*", adminRequired);
  app.use("/api/admin/*", adminPermissionGuard);

  // 路由挂载
  app.route("/api/auth", authRoutes);
  // WP7：节点机器端点（/api/internal/node/*）。在 publicRoutes 之前挂载是
  // 有意的：两者都免用户认证，但本路由的路径更具体，先匹配可以先落到
  // 节点凭据语义上（顺序不影响结果，白名单已整段豁免 /api/internal/*）。
  app.route("/api/internal", internalNodeRoutes);
  app.route("/api/pay", payRoutes);
  app.route("/api/dashboard", dashboardRoutes);
  app.route("/api/tunnels", tunnelsRoutes);
  app.route("/api/forwards", forwardsRoutes);
  app.route("/api/workspaces", workspaceRoutes);
  app.route("/api/plans", plansRoutes);
  app.route("/api/topups", topupsRoutes);
  app.route("/api/payments", paymentsRoutes);
  app.route("/api/tickets", ticketsRoutes);
  app.route("/api/settings", settingsRoutes);
  app.route("/api/node-groups", nodeGroupsRoutes);
  app.route("/api/nodes", nodesRoutes);
  app.route("/api", publicRoutes);
  app.route("/api/admin", adminRoutes);
  app.route("/api/admin", nodeGrantRoutes);
  app.route("/api/admin", adminExtendedRoutes);
  // WP10：管理端节点角色 / 凭据状态 / 出口池 / 运行态查询。与上面三个同批
  // 挂载，中间件（adminRequired → adminPermissionGuard）已在 §⑥ 统一施加。
  app.route("/api/admin", nodeAdminRoutes);

  app.get("/", (c) => c.json({ service: "tunex-backend", site_url: env.siteUrl }));

  return app;
}

export const app = createApp();
