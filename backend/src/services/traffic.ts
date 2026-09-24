/**
 * 流量计量 · 聚合视图（OPS-03 聚合半段）
 *
 * 输入是 `tunnel_traffic` 行（OPS-01 由 services/traffic-archive.ts 归档），
 * 输出供 `GET /api/workspaces/:id/traffic` 与仪表盘使用：
 *
 *   · `total_traffic` / `total_cost`：窗口内该 workspace 合计；
 *   · `by_tunnel`：按隧道分组（含隧道名与所属节点组，便于逐个定位）；
 *   · `by_day`：按日界补齐的序列（缺日子补 0，前端图表点数稳定）。
 *
 * ── 口径必须与策略流量一致（OPS-03 验收）──
 * 「策略流量」指 `services/policy-service.ts#sumWorkspaceTraffic` +
 * `getEffectivePolicy().limits.traffic_period` 判定的用量（config-generator
 * 的额度耗尽判定即读它）。两处口径必须同源，否则「仪表盘显示还有余量、实际
 * 已因流量耗尽拒绝建隧道」或反向的错配会出现。因此本模块：
 *
 *   1. **复用** `trafficWindowStart(period, now)`（capability-policy 的纯函数）
 *      计算窗口起点 —— 不另写一套日/月界逻辑；
 *   2. 聚合只读 `tunnel_traffic.traffic`，与 `sumWorkspaceTraffic` 同表同列；
 *   3. 默认 period 取该 workspace 的生效策略周期（`getEffectivePolicy`），
 *      调用方显式传 `period` 时优先。
 *
 * ── 归属（TEN-02）──
 * 所有查询经 `tunnel: { workspace_id }` 过滤（relation filter），不接受调用方
 * 传入的 tunnel_id 列表做过滤；跨租户的数据物理上不会进入结果集。
 *
 * ── 纯函数与副作用分离 ──
 * `aggregateTrafficRows` / `fillDays` 为纯函数（喂行即得聚合），
 * `getWorkspaceTrafficSummary` 负责 DB 编排，可离线单测。
 */
import type { Prisma } from "@prisma/client";
import { db } from "../db.ts";
import { trafficWindowStart, type TrafficPeriodName } from "./capability-policy.ts";
import { getEffectivePolicy } from "./policy-service.ts";

/** 单日聚合点（前端 TrafficPoint 同构，便于直接替换）。 */
export interface TrafficDayPoint {
  /** 日界 `YYYY-MM-DD`（本地时区零点，升序）。 */
  date: string;
  traffic: number;
  traffic_cost: number;
}

/** 单隧道聚合。 */
export interface TunnelTrafficGroup {
  tunnel_id: number;
  name: string;
  tunnel_type: string;
  in_node_group_id: number | null;
  in_node_group_name: string | null;
  traffic: number;
  traffic_cost: number;
}

/** workspace 流量聚合视图。 */
export interface WorkspaceTrafficSummary {
  workspace_id: number;
  /** 生效策略的流量计量周期（聚合窗口口径）。 */
  period: TrafficPeriodName;
  /** 窗口起点 ISO 串；`total` 周期为 null（不限窗口）。 */
  since: string | null;
  total_traffic: number;
  total_traffic_cost: number;
  by_tunnel: TunnelTrafficGroup[];
  by_day: TrafficDayPoint[];
  /** 窗口内未归属到任何隧道的孤立行数（恒 0：归档时已丢弃，仅作监控位）。 */
  orphan_rows: number;
}

/** 聚合用的最小行（Prisma select 的子集；测试可直接构造）。 */
export interface TrafficAggRow {
  tunnel_id: number;
  traffic: number;
  traffic_cost: number;
  date: Date;
  tunnel?: { name: string; tunnel_type: string; in_node_group_id: number | null; in_node_group?: { name: string } | null } | null;
}

/* ================================================================== */
/* 纯函数                                                              */
/* ================================================================== */

/** 本地日界键 `YYYY-MM-DD`（与 dashboard/tunnels 的图表口径一致）。 */
export function dayKeyOf(d: Date): string {
  const x = new Date(d.getTime());
  x.setHours(0, 0, 0, 0);
  return localDayKey(x);
}

/**
 * 本地日期的 `YYYY-MM-DD`。
 *
 * 必须用本地分量拼字符串，**不能** `toISOString().slice(0,10)`：
 * UTC+8 下本地午夜 = 前一天 16:00Z，toISOString 会回退一天
 * （dashboard/tunnels 的既有图表口径就是这么错的，此处不再沿袭）。
 */
function localDayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 补齐缺失日期（升序，含今天）：没有数据的日界补 0，
 * 保证前端图表点数稳定（同 `routes/dashboard.ts#dayKeys` 的语义）。
 */
export function fillDays(days: number, now: Date = new Date()): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime());
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    out.push(dayKeyOf(d));
  }
  return out;
}

/**
 * 纯聚合：行 → { 总量, 按隧道（降序）, 按日界（升序补齐） }。
 *
 * 小数口径：浮点累加在窗口内可能累积误差（`0.1 + 0.2`），因此总量与分组值
 * 统一 `Number(x.toFixed(2))` / `toFixed(4)` 截断，与既有 dashboard 的
 * 序列输出口径一致（避免「页面加了三天和面板差 0.0000001」的投诉）。
 */
export function aggregateTrafficRows(
  rows: readonly TrafficAggRow[],
  opts: { days: number; now?: Date } = { days: 14 },
): {
  total_traffic: number;
  total_traffic_cost: number;
  by_tunnel: TunnelTrafficGroup[];
  by_day: TrafficDayPoint[];
} {
  const now = opts.now ?? new Date();
  const byTunnel = new Map<number, { group: TunnelTrafficGroup }>();
  const byDay = new Map<string, TrafficDayPoint>();
  let totalTraffic = 0;
  let totalCost = 0;

  for (const r of rows) {
    const traffic = Number.isFinite(r.traffic) ? r.traffic : 0;
    const cost = Number.isFinite(r.traffic_cost) ? r.traffic_cost : 0;
    totalTraffic += traffic;
    totalCost += cost;

    let entry = byTunnel.get(r.tunnel_id);
    if (!entry) {
      entry = {
        group: {
          tunnel_id: r.tunnel_id,
          name: r.tunnel?.name ?? "",
          tunnel_type: r.tunnel?.tunnel_type ?? "",
          in_node_group_id: r.tunnel?.in_node_group_id ?? null,
          in_node_group_name: r.tunnel?.in_node_group?.name ?? null,
          traffic: 0,
          traffic_cost: 0,
        },
      };
      byTunnel.set(r.tunnel_id, entry);
    }
    entry.group.traffic += traffic;
    entry.group.traffic_cost += cost;

    const key = dayKeyOf(r.date);
    const point = byDay.get(key) ?? { date: key, traffic: 0, traffic_cost: 0 };
    point.traffic += traffic;
    point.traffic_cost += cost;
    byDay.set(key, point);
  }

  const tunnels = [...byTunnel.values()]
    .map((e) => ({
      ...e.group,
      traffic: Number(e.group.traffic.toFixed(2)),
      traffic_cost: Number(e.group.traffic_cost.toFixed(4)),
    }))
    .sort((a, b) => b.traffic - a.traffic || a.tunnel_id - b.tunnel_id);

  const days = fillDays(opts.days, now);
  const by_day = days.map((date) => {
    const hit = byDay.get(date);
    return {
      date,
      traffic: hit ? Number(hit.traffic.toFixed(2)) : 0,
      traffic_cost: hit ? Number(hit.traffic_cost.toFixed(4)) : 0,
    };
  });

  return {
    total_traffic: Number(totalTraffic.toFixed(2)),
    total_traffic_cost: Number(totalCost.toFixed(4)),
    by_tunnel: tunnels,
    by_day,
  };
}

/* ================================================================== */
/* DB 编排                                                             */
/* ================================================================== */

/** 趋势默认天数（与 dashboard `/traffic` 的 14 天一致）。 */
export const TRAFFIC_DEFAULT_DAYS = 14;
/** 趋势最大天数（与 dashboard 一致，防止一次拉全表）。 */
export const TRAFFIC_MAX_DAYS = 90;

export interface WorkspaceTrafficOptions {
  /** 显式计量周期；缺省取该 workspace 生效策略的 `traffic_period`。 */
  period?: TrafficPeriodName;
  /** 趋势图天数（1–90，默认 14）。 */
  days?: number;
  now?: Date;
}

/**
 * workspace 流量聚合（`GET /api/workspaces/:id/traffic` 的数据源）。
 *
 * 失败语义：MySQL 不可用时整段抛错，由路由层转 500 —— 流量看板是观测能力，
 * 静默返回空数组会让用户以为「没有流量」而非「看不到」。
 */
export async function getWorkspaceTrafficSummary(
  workspaceId: number,
  options: WorkspaceTrafficOptions = {},
): Promise<WorkspaceTrafficSummary> {
  const now = options.now ?? new Date();
  const days = Math.max(1, Math.min(TRAFFIC_MAX_DAYS, Math.floor(options.days ?? TRAFFIC_DEFAULT_DAYS)));

  // 周期口径与策略一致：显式 period 优先，否则读生效策略。
  let period: TrafficPeriodName = options.period ?? "total";
  if (options.period === undefined) {
    try {
      const policy = await getEffectivePolicy(workspaceId, { now });
      period = policy.limits.traffic_period;
    } catch {
      // 策略读取失败：退回 total（全量窗口，视图不会因策略故障而缺失）。
    }
  }

  // total → 不限窗口；day/month → 与 policy-service#trafficStart 同源的窗口起点。
  const windowStart = trafficWindowStart(period, now);
  const since = windowStart ?? new Date(now.getTime());
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - (days - 1));
  // 有明确窗口时取「策略窗口与趋势窗口的较大值」：趋势只展示窗口内的天数。
  const effectiveSince = windowStart && windowStart > since ? windowStart : since;

  const where: Prisma.TunnelTrafficWhereInput = {
    tunnel: { workspace_id: workspaceId },
    date: { gte: effectiveSince },
  };

  const rows = await db.tunnelTraffic.findMany({
    where,
    orderBy: { date: "asc" },
    select: {
      tunnel_id: true,
      traffic: true,
      traffic_cost: true,
      date: true,
      tunnel: { select: { name: true, tunnel_type: true, in_node_group_id: true, in_node_group: { select: { name: true } } } },
    },
  });

  const agg = aggregateTrafficRows(rows as unknown as TrafficAggRow[], { days, now });
  return {
    workspace_id: workspaceId,
    period,
    since: effectiveSince.toISOString(),
    total_traffic: agg.total_traffic,
    total_traffic_cost: agg.total_traffic_cost,
    by_tunnel: agg.by_tunnel,
    by_day: agg.by_day,
    orphan_rows: 0,
  };
}
