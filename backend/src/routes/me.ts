/**
 * Read-only current-workspace capability, quota and usage view.
 *
 * Traffic usage is derived from archived traffic within the effective policy
 * window; legacy `UserPlan.traffic_used` is not an authorization source.
 * Workspace membership resolves the scope, while detailed resources remain
 * protected by their own route permissions.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppVariables } from "../middlewares/auth.ts";
import { getWorkspaceUsageReport } from "../services/policy-service.ts";
import { resolveWorkspaceMembership } from "../services/workspace.ts";

export const meRoutes = new Hono<{ Variables: AppVariables }>();

type Ctx = Context<{ Variables: AppVariables }>;

/**
 * GET /capabilities —— 当前工作空间的能力/额度/用量视图。
 *
 * 时间点显式取一次并透传：窗口起点由策略周期决定，同一次请求里不该出现两个 `now`
 * （否则跨月那一秒的月首会算两次，读路径与判定层可能差一个月）。
 */
meRoutes.get("/capabilities", async (c: Ctx) => {
  const user = c.get("user");
  if (!user) throw new HTTPException(401, { message: "Unauthorized" });
  const workspace = await resolveWorkspaceMembership(c);
  const now = new Date();
  const report = await getWorkspaceUsageReport(workspace.id, { now });
  return c.json({ data: report });
});
