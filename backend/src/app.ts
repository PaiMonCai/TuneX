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
import { workspaceRolesRoutes } from "./routes/workspace-roles.ts";
import { adminExtendedRoutes } from "./routes/admin-extended.ts";
import { nodeAdminRoutes } from "./routes/node-admin.ts";
import { nodeLifecycleRoutes } from "./routes/node-lifecycle.ts";
import { nodeHealthRoutes } from "./routes/node-health.ts";
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
import { routeProfilesRoutes } from "./routes/route-profiles.ts";
// V5.5 WP14：联邦。两组端点职责不同、安全边界也不同：
//   · /api/federation/v1/*  面板↔面板机器端点（免用户认证、必须 Ed25519 签名）
//   · /api/admin/federation  Admin Console 接口（管理员 + federation 资源权限）
import { federationRoutes } from "./routes/federation.ts";
import { adminFederationRoutes } from "./routes/admin-federation.ts";

export function createApp() {
  const app = new Hono<{ Variables: AppVariables }>();

  // V5.5 WP15：联邦的停服/撤销钩子必须是**进程级**的，不能只在 worker 里注册。
  // trust 撤销走的是 panel 进程（管理员点撤销），而钩子只在 worker 注册时，
  // panel 里的 revokedHook 是 null ⇒ 已 apply 的远端链路最多还会服务到 worker 下一拍
  // （实测 ~26s），而契约 §2.4 要求的是"立即停止"。ensureFederationWiring 幂等。
  try {
    // 同步 import 会在模块图里拉进 orchestrator/portPool；这里用一次性同步调用是刻意的：
    // 钩子必须在第一次联邦写请求之前就位，异步注册会留下一个真实的竞态窗口。
    void import("./services/federation/lease.ts").then((m) => m.ensureFederationWiring());
  } catch (e) {
    console.error("[app] federation wiring failed:", e instanceof Error ? e.message : e);
  }

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
      // Structured authorization errors carry a response; do not erase its
      // machine-readable code/layer at the global error boundary.
      if (err.res) return err.getResponse();
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
  app.route("/api/workspaces", workspaceRolesRoutes);
  app.route("/api/plans", plansRoutes);
  app.route("/api/topups", topupsRoutes);
  app.route("/api/payments", paymentsRoutes);
  app.route("/api/tickets", ticketsRoutes);
  app.route("/api/settings", settingsRoutes);
  app.route("/api/node-groups", nodeGroupsRoutes);
  app.route("/api/nodes", nodesRoutes);
  // V5-WP13.5B：Route Profile（线路模板）。与 node-groups 同属「网络/基础设施」资源族，
  // 因此用既有 workspace 域 RBAC（read / manage on "node"），不新增 /api/admin/* 权限 key：
  // Admin Console 与 User Console 走同一套后端资源与 RBAC，前端只做 UX 分层（§9.4.1）。
  app.route("/api/route-profiles", routeProfilesRoutes);
  // V5.5 WP14：联邦 M2M 端点。挂载在 publicRoutes 之前：与 /api/internal/* 同理，
  // 路径更具体先落位；免认证白名单已整段豁免 /api/federation/*。
  app.route("/api/federation/v1", federationRoutes);
  app.route("/api", publicRoutes);
  app.route("/api/admin", adminRoutes);
  app.route("/api/admin", nodeGrantRoutes);
  app.route("/api/admin", adminExtendedRoutes);
  // 注意前缀：联邦的管理端接口有自己的子路径（/api/admin/federation/*）。
  // 若按 `/api/admin` 挂载，路由内的 "/status" 会变成 `/api/admin/status` —— 既与文档不符，
  // 也会和既有 admin 路由抢同一个命名空间（实测被 Gate 抓到）。
  app.route("/api/admin/federation", adminFederationRoutes);
  // WP10：管理端节点角色 / 凭据状态 / 出口池 / 运行态查询。与上面三个同批
  // 挂载，中间件（adminRequired → adminPermissionGuard）已在 §⑥ 统一施加。
  app.route("/api/admin", nodeAdminRoutes);
  // WP5：管理端 Node 生命周期（GET/PATCH lifecycle、impact check、retiring 后删除）。
  // 与节点管理接口共用 adminPermissionGuard（§⑥ 已统一施加，本文件不再套中间件）。
  // 敏感写（PATCH/DELETE）目前走 api-global 限流：lifecycle 变更不是凭据轮换那种
  // 高频攻击面，且 409 拒绝本身可挡住误操作重复提交；若后续证明需要更严的用户
  // 维度限额，见 routes/node-lifecycle.ts 顶部「限流」小节的决策记录。
  app.route("/api/admin", nodeLifecycleRoutes);
  // V4-WP6：管理端 Node health（单节点判定 + 全量巡检）。路径在同前缀下，
  // 与 WP5 的 lifecycle、WP10 的 state 互不重叠；中间件同样由 §⑥ 统一施加。
  // health 是**读**接口（判定由 services/node-health.ts 的纯函数给出），
  // 因此不新增限流规则，走 api-global。
  app.route("/api/admin", nodeHealthRoutes);

  app.get("/", (c) => c.json({ service: "tunex-backend", site_url: env.siteUrl }));

  return app;
}

export const app = createApp();
