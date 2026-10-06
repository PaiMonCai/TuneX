/**
 * Hono application assembly.
 *
 * Order is security-significant: request context/logging → optional dev CORS →
 * billing gate → CSRF → authentication → audit/rate limit → admin RBAC → routes.
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
import { lookingGlassRoutes } from "./routes/looking-glass.ts";
import { publicRoutes } from "./routes/public.ts";
import { internalNodeRoutes } from "./routes/internal-node.ts";
import { payRoutes } from "./routes/pay.ts";
import { dashboardRoutes } from "./routes/dashboard.ts";
import { meRoutes } from "./routes/me.ts";
import { tunnelsRoutes } from "./routes/tunnels.ts";
import { forwardsRoutes } from "./routes/forwards.ts";
import { ddnsRoutes } from "./routes/ddns.ts";
// User/workspace announcements and the Admin announcement surface share the same backend truth.
import { announcementRoutes } from "./routes/announcements.ts";
import { announcementAdminRoutes } from "./routes/announcements-admin.ts";
import { notificationChannelRoutes } from "./routes/notification-channels.ts";
import { plansRoutes } from "./routes/plans.ts";
import { topupsRoutes } from "./routes/topups.ts";
import { paymentsRoutes } from "./routes/topups.ts";
import { ticketsRoutes } from "./routes/tickets.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { nodeGroupsRoutes } from "./routes/node-groups.ts";
import { nodesRoutes } from "./routes/nodes.ts";
import { routeProfilesRoutes } from "./routes/route-profiles.ts";
// Federation separates signed panel-to-panel machine endpoints from Admin Console APIs.
import { federationRoutes } from "./routes/federation.ts";
import { adminFederationRoutes } from "./routes/admin-federation.ts";
import { ensureFederationWiring } from "./services/federation/lease.ts";

export const APP_ROUTE_MOUNTS = [
  "/api/auth",
  "/api/internal",
  "/api/pay",
  "/api/dashboard",
  "/api/me",
  "/api/tunnels",
  "/api/forwards",
  "/api/ddns",
  "/api/workspaces",
  "/api/plans",
  "/api/topups",
  "/api/payments",
  "/api/tickets",
  "/api/settings",
  "/api/node-groups",
  "/api/nodes",
  "/api/route-profiles",
  "/api/announcements",
  "/api/federation/v1",
  "/api",
  "/api/admin",
  "/api/admin/federation",
  "/api/looking-glass",
] as const;

export function createApp() {
  const app = new Hono<{ Variables: AppVariables }>();

  // Federation routes are already loaded synchronously, so their teardown/revoke
  // hooks must be wired synchronously too. Otherwise the first request can arrive
  // in the microtask window before dynamic import completion and revoke authority
  // without immediately stopping its runtime.
  ensureFederationWiring();

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

  // Development-only CORS; production stays same-origin by default.
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

  // Public liveness/readiness probes.
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

  // CSRF runs before auth so cookie-bearing cross-site writes are rejected before handlers,
  // including login/register POSTs.
  app.use("*", createCsrfMiddleware());

  // Global authentication; authRequired owns the public allowlist.
  app.use("*", authRequired);

  // Audit before rate limiting so rejected requests remain observable.
  app.use("*", createAuditMiddleware());
  app.use("*", createRateLimitMiddleware());

  // Admin authentication + resource permission guard.
  app.use("/api/admin/*", adminRequired);
  app.use("/api/admin/*", adminPermissionGuard);

  // 路由挂载
  app.route("/api/auth", authRoutes);
  // Mount node machine endpoints before the broad public router so node-credential semantics stay explicit.
  app.route("/api/internal", internalNodeRoutes);
  app.route("/api/pay", payRoutes);
  app.route("/api/dashboard", dashboardRoutes);
  app.route("/api/me", meRoutes);
  app.route("/api/tunnels", tunnelsRoutes);
  app.route("/api/forwards", forwardsRoutes);
  app.route("/api/ddns", ddnsRoutes);
  app.route("/api/workspaces", workspaceRoutes);
  app.route("/api/workspaces", workspaceRolesRoutes);
  app.route("/api/plans", plansRoutes);
  app.route("/api/topups", topupsRoutes);
  app.route("/api/payments", paymentsRoutes);
  app.route("/api/tickets", ticketsRoutes);
  app.route("/api/settings", settingsRoutes);
  app.route("/api/node-groups", nodeGroupsRoutes);
  app.route("/api/nodes", nodesRoutes);
  // Route Profiles use the workspace/network authorization model shared with node groups.
  app.route("/api/route-profiles", routeProfilesRoutes);
  // User/workspace announcement routes; platform management is mounted under /api/admin below.
  app.route("/api/announcements", announcementRoutes);
  // Signed federation M2M endpoints are mounted before the broad public router.
  app.route("/api/federation/v1", federationRoutes);
  app.route("/api", publicRoutes);
  app.route("/api/admin", adminRoutes);
  app.route("/api/admin", nodeGrantRoutes);
  app.route("/api/admin", adminExtendedRoutes);
  // Keep the federation admin router on its dedicated prefix to avoid colliding with generic admin routes.
  app.route("/api/admin/federation", adminFederationRoutes);
  // Admin node role/credential/egress/runtime routes inherit the admin guards above.
  app.route("/api/admin", nodeAdminRoutes);
  // Node lifecycle writes share the admin permission guard and global rate limiter.
  app.route("/api/admin", nodeLifecycleRoutes);
  // Node health is a read surface under the same admin guards.
  app.route("/api/admin", nodeHealthRoutes);
  // Looking Glass is disabled by default; enable explicitly with LOOKING_GLASS_ENABLED.
  app.route("/api/looking-glass", lookingGlassRoutes);
  // Platform announcement management uses the admin permission guard above.
  app.route("/api/admin", announcementAdminRoutes);
  // N2: platform notification channel config (telegram/webhook). Secret values are write-only
  // and never echoed; this router inherits the admin guards (registered `notification_channels` key).
  app.route("/api/admin", notificationChannelRoutes);

  app.get("/", (c) => c.json({ service: "tunex-backend", site_url: env.siteUrl }));

  return app;
}

export const app = createApp();
