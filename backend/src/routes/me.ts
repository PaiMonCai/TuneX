/**
 * `/api/me/*` —— **当前用户视角**的只读视图（V5-WP20-6b）。
 *
 * ── 为什么这个文件存在 ──
 * 契约 §3.3.2 已经指定「前端展示已用流量要改读 `GET /api/me/capabilities`」，
 * 但那个端点在代码里**从来不存在**，而它背后的 `policy-service#getWorkspaceUsageReport`
 * 是**零调用者的死代码**。死代码只有两种解法：删掉，或给它一个调用者 —— 契约已经选了后者
 * （用「能力/额度视图」这个名字写死了读路径），所以这里把端点补上。
 *
 * 这与本仓 `route-mount-coverage.test.ts` 记录的那族缺陷同源（模块/断言全绿、应用里根本不可达），
 * 因此本文件除了被单测覆盖，**还必须在 `app.ts` 里真的挂载**（那个守卫是机械检查，会自动盯着）。
 *
 * ── 口径（与 dashboard 一致，不能各算一套）──
 * 返回的就是 `getWorkspaceUsageReport`：
 *   · `traffic_used` = **窗口求和**（`tunnel_traffic` 的已归档事实，窗口 = 生效策略的
 *     `traffic_period`），**不是** `UserPlan.traffic_used` 那个冻结的 legacy 列；
 *   · `traffic_used_unattributed_federated` = 联邦远端腿用量（不计入额度，只让缺口可观测）；
 *   · `limits` / `policy` = 生效策略的额度与合成结果（判定层同一真相）。
 * 工作空间解析沿用 `resolveWorkspaceMembership`（`x-workspace-id` 头优先，缺省个人空间）——
 * 与 dashboard 同一个函数，因此「同一个人在两个页面看到的用量」不会不一致。
 *
 * ── 权限面 ──
 * 需要是**该工作空间的成员**（`resolveWorkspaceMembership` 自己会拒非成员）。这里不再叠加
 * `forward:read` 之类的资源权限：本端点返回的是「租户自己的额度与用量」，成员本就可见，
 * 而资源明细仍受各自页面权限约束（dashboard 的可见性开关管的是明细，不是额度）。
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
