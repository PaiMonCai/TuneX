/**
 * 仪表盘流量数据装配（OPS-03）—— 与 React 解耦，便于单测。
 *
 * 数据源：`GET /api/workspaces/:id/traffic`（workspace 级聚合，口径与策略
 * 流量一致），旧的 `GET /api/dashboard/traffic`（用户级、无归属过滤）已弃用。
 *
 * ── 为什么要包一层而不是在组件里 await ──
 * DashboardBody 是服务端组件，一次渲染里并发拉 stats / traffic / tunnels。
 * 把「取哪个 workspace、失败怎么退化、空数据怎么表示」从 JSX 里抽出来，
 * 单测就能用 fake api 把三种状态（有数据 / 空数据 / 接口失败）各跑一遍，
 * 不需要起 Next 服务器。
 *
 * ── 失败/空数据语义（验收要求）──
 *   · 接口失败（403/500/网络错）：**不伪装成没有流量**。返回 `error` 标记，
 *     页面显示「流量数据暂时不可用」而不是空白图表——否则用户会以为
 *     「没有流量」而不是「看不到」。
 *   · 接口成功但 `by_day` 全 0：这是真实的「还没有流量」，显示空状态。
 *   · `workspaceId` 缺失（未登录 / 列表还没加载出来）：跳过请求，
 *     返回 loading 语义（AppShell 的 Suspense 会兜住首帧）。
 */
import type { WorkspaceTrafficSummary } from "@/lib/types";

/** 趋势图默认天数（与后端 TRAFFIC_DEFAULT_DAYS 一致）。 */
export const TRAFFIC_TREND_DAYS = 14;

/** 仪表盘流量装配的输入。 */
export interface DashboardTrafficInput {
  /** 当前 workspace id；null/undefined 时跳过请求（无作用域 = 后端回落个人空间，不猜）。 */
  workspaceId: number | null | undefined;
  /** 取当前 workspace 的流量聚合（失败应 reject）。 */
  fetchTraffic: (workspaceId: number, days: number) => Promise<WorkspaceTrafficSummary>;
  /** 趋势天数（默认 {@link TRAFFIC_TREND_DAYS}）。 */
  days?: number;
}

/** 仪表盘流量装配结果。 */
export interface DashboardTraffic {
  status: "ok" | "empty" | "error" | "no-workspace";
  /** 流量摘要（status=ok/empty 时有值；error 时可能留有上次成功的数据，页面可选择展示并标注）。 */
  summary: WorkspaceTrafficSummary | null;
  /** status=error 时的原因（可直接展示，不泄露堆栈）。 */
  message: string | null;
  /** by_day 传给 TrafficChart 的序列（status=ok 时有值；否则空数组）。 */
  points: WorkspaceTrafficSummary["by_day"];
  /** by_tunnel 排行（status=ok 时有值；否则空数组）。 */
  tunnels: WorkspaceTrafficSummary["by_tunnel"];
}

/** 从 ApiError 取可展示的原因消息。 */
function messageOf(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return "流量数据暂时不可用";
}

/**
 * 拉取并装配仪表盘流量。永不抛错（失败收敛为 `status: "error"`），
 * 因为调用方是服务端组件的渲染路径：一个 403 不该把整页打成 500。
 */
export async function loadDashboardTraffic(input: DashboardTrafficInput): Promise<DashboardTraffic> {
  const days = input.days ?? TRAFFIC_TREND_DAYS;

  if (!input.workspaceId || !Number.isInteger(input.workspaceId) || input.workspaceId <= 0) {
    return { status: "no-workspace", summary: null, message: null, points: [], tunnels: [] };
  }

  let summary: WorkspaceTrafficSummary | null = null;
  try {
    summary = await input.fetchTraffic(input.workspaceId, days);
  } catch (err) {
    return { status: "error", summary: null, message: messageOf(err), points: [], tunnels: [] };
  }

  // 防御：后端契约异常（数组缺失）时按空数据处理，不让 .map 抛错整页 500。
  const points = Array.isArray(summary?.by_day) ? summary.by_day : [];
  const tunnels = Array.isArray(summary?.by_tunnel) ? summary.by_tunnel : [];

  const hasData = points.some((p) => p.traffic > 0) || tunnels.length > 0;
  return {
    status: hasData ? "ok" : "empty",
    summary,
    message: null,
    points,
    tunnels,
  };
}
