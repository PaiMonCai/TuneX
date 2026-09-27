/**
 * 仪表盘路由（用户侧）—— 前端 api.dashboard.*
 *
 * 端点（挂载于 /api/dashboard）：
 *   GET /stats      个人概览：余额 / 佣金 / 隧道数 / 套餐流量 / 节点数 / 今日流量
 *   GET /traffic    近 N 天流量趋势（TrafficPoint[]）
 *   GET /attention  V4-WP8 §13.7 Wave 4：需要处理的异常/离线/等待安装条目
 *                   （离线或未安装的节点、管理态挡掉新业务的节点、失败或
 *                   仍在下发中的 Forward），每条带既有理由码供前端给下一步
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
import { collectAttention } from "../services/attention.ts";
import { projectUserNode } from "../services/node-view.ts";
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
    db.node.findMany({
      where: { node_group: { workspace_id: workspace.id } },
      // V4-WP8：节点计数也要用 Connection 层的事实。改造前这里只数
      // `status === "active"`（legacy 列），所以「从未安装过 Agent 的节点」
      // 与「已装但掉线的节点」都会被算成在线 —— Dashboard 的节点卡片因此
      // 与节点页显示的在线数不一致。这里改读同一批事实列，判定交给
      // services/node-view.ts（唯一实现）。
      select: {
        status: true,
        last_seen_at: true,
        node_credential_hash: true,
        credential_revoked: true,
        lifecycle: true,
      },
    }),
    db.tunnelTraffic.aggregate({
      where: { date: { gte: startOfToday() }, tunnel: { workspace_id: workspace.id } },
      _sum: { traffic: true },
    }),
    db.tunnelTraffic.aggregate({
      where: { date: { gte: monthStart }, tunnel: { workspace_id: workspace.id } },
      _sum: { traffic: true },
    }),
  ]);

  const activeNodes = nodes.filter((n) =>
    projectUserNode({
      status: n.status,
      last_seen_at: n.last_seen_at,
      has_credential: Boolean(n.node_credential_hash),
      credential_revoked: n.credential_revoked,
      lifecycle: n.lifecycle,
    }).online,
  ).length;
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

/* ------------------------------------------------------------------ */
/* GET /attention —— 需要处理的异常 / 离线 / 等待安装                  */
/* ------------------------------------------------------------------ */

/**
 * V4-WP8 §13.7 Wave 4：Dashboard 优先显示异常、离线、等待安装与快捷操作。
 *
 * 判定全部在 `services/attention.ts` 里（复用 WP5 的 `deriveConnection` /
 * `nodeAdmission` 与 WP3 的 `isRetryable`）；本路由只做三件事：
 *   · 用 `resolveWorkspaceAccess` 落到当前 workspace（不跨空间泄漏节点/转发）；
 *   · 把结果装进标准 `{ data }` 信封；
 *   · 让 DB 不可用时**不 500** —— Dashboard 是首页，一个聚合查询失败不该让
 *     整个页面打不开；返回空清单并标注 `degraded`，由前端提示「暂时取不到
 *     待办」而不是伪装成「一切正常」。
 *
 * 注册为 GET：轮询 Dashboard 时会重复命中，走 `api-global` 限流即可
 * （与 `/stats` / `/traffic` 同一取向；读端点不新建专属规则）。
 */
dashboardRoutes.get("/attention", async (c) => {
  const workspace = await resolveWorkspaceAccess(c, "read");
  try {
    const payload = await collectAttention(workspace.id);
    return c.json({ data: payload });
  } catch {
    return c.json({
      data: {
        items: [],
        summary: {
          nodes_offline: 0,
          nodes_waiting_install: 0,
          nodes_restricted: 0,
          forwards_error: 0,
          forwards_pending: 0,
        },
        total: 0,
        generated_at: new Date().toISOString(),
        // 显式标记降级：空清单 ≠ 没有待办。前端据此显示「暂时取不到」。
        degraded: true,
      },
    });
  }
});
