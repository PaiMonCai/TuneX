/**
 * 仪表盘路由（用户侧）—— 前端 api.dashboard.*
 *
 * 端点（挂载于 /api/dashboard）：
 *   GET /stats     个人概览：余额 / 佣金 / 隧道数 / 套餐流量 / 节点数 / 今日流量
 *   GET /traffic   近 N 天流量趋势（TrafficPoint[]）
 *
 * 挂载方式（由 app.ts 的收尾子代理执行，本模块不修改 app.ts）：
 *   import { dashboardRoutes } from "./routes/dashboard.ts";
 *   app.route("/api/dashboard", dashboardRoutes);
 *
 * 响应封装：前端 lib/api.ts 的 request() 会剥掉 **一层** 顶层 `data`，
 * 故统一 `c.json({ data: <payload> })`；前端拿到即是 payload。
 *
 * 字段口径（对齐 web/src/lib/types.ts 的 DashboardStats / TrafficPoint）：
 *   · traffic / traffic_used / today_traffic / month_traffic 均为 **字节**
 *     （前端用 formatBytes 渲染，与 schema 的 Float 存储口径一致）
 *   · TrafficPoint = { date, traffic, traffic_cost }（注意不是 cost）
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { db } from "../db.ts";
import { resolveWorkspaceAccess } from "../services/workspace.ts";
import type { AppVariables } from "../middlewares/auth.ts";

export const dashboardRoutes = new Hono<{ Variables: AppVariables }>();

type Ctx = Context<{ Variables: AppVariables }>;

function requireUser(c: Ctx): NonNullable<AppVariables["user"]> {
  const user = c.get("user");
  if (!user) throw new HTTPException(401, { message: "Unauthorized" });
  return user;
}

/** 取本地零点（避免 UTC 偏移导致「今日」错位） */
function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** 近 N 天（含今天）的日期键，升序 */
function dayKeys(days: number): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* GET /traffic —— 流量趋势                                            */
/* ------------------------------------------------------------------ */

dashboardRoutes.get("/traffic", async (c) => {
  requireUser(c);
  const workspace = await resolveWorkspaceAccess(c, "read");
  const days = Math.max(1, Math.min(90, Number(c.req.query("days") ?? 14) || 14));
  const since = startOfToday();
  since.setDate(since.getDate() - (days - 1));

  // Only count tunnels in the selected, authorized workspace.
  const rows = await db.tunnelTraffic.findMany({
    where: { date: { gte: since }, tunnel: { workspace_id: workspace.id } },
    orderBy: { date: "asc" },
  });

  const byDate = new Map<string, { traffic: number; traffic_cost: number }>();
  for (const r of rows) {
    const key = r.date.toISOString().slice(0, 10);
    const acc = byDate.get(key) ?? { traffic: 0, traffic_cost: 0 };
    acc.traffic += r.traffic;
    acc.traffic_cost += r.traffic_cost;
    byDate.set(key, acc);
  }

  const points = dayKeys(days).map((key) => {
    const hit = byDate.get(key);
    return {
      date: key,
      traffic: hit ? Number(hit.traffic.toFixed(2)) : 0,
      traffic_cost: hit ? Number(hit.traffic_cost.toFixed(4)) : 0,
    };
  });

  return c.json({ data: points });
});

/* ------------------------------------------------------------------ */
/* GET /stats —— 个人概览                                              */
/* ------------------------------------------------------------------ */

dashboardRoutes.get("/stats", async (c) => {
  const user = requireUser(c);

  const workspace = await resolveWorkspaceAccess(c, "read");
  const monthStart = startOfToday();
  monthStart.setDate(1);

  const [userPlan, tunnelCount, nodes, todayAgg, monthAgg] = await Promise.all([
    workspace.kind === "personal" ? db.userPlan.findUnique({ where: { user_id: user.id }, include: { plan: true } }) : null,
    db.tunnel.count({ where: { workspace_id: workspace.id } }),
    db.node.findMany({ where: { node_group: { workspace_id: workspace.id } }, select: { status: true } }),
    db.tunnelTraffic.aggregate({
      where: { date: { gte: startOfToday() }, tunnel: { workspace_id: workspace.id } },
      _sum: { traffic: true },
    }),
    db.tunnelTraffic.aggregate({
      where: { date: { gte: monthStart }, tunnel: { workspace_id: workspace.id } },
      _sum: { traffic: true },
    }),
  ]);

  const activeNodes = nodes.filter((n) => n.status === "active").length;
  const totalNodes = nodes.length;

  const stats = {
    balance: workspace.kind === "personal" ? user.balance : 0,
    commission_balance: workspace.kind === "personal" ? user.commission_balance : 0,
    tunnel_count: tunnelCount,
    max_tunnels: userPlan?.max_tunnels ?? userPlan?.plan?.max_tunnels ?? null,
    traffic_used: userPlan?.traffic_used ?? 0,
    traffic_limit: userPlan?.traffic ?? null,
    plan_name: userPlan?.plan?.name ?? null,
    expired_at: userPlan?.expired_at ?? null,
    active_nodes: activeNodes,
    total_nodes: totalNodes,
    today_traffic: todayAgg._sum.traffic ?? 0,
    month_traffic: monthAgg._sum.traffic ?? 0,
  };

  return c.json({ data: stats });
});
