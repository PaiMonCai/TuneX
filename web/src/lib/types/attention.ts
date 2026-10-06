/** Domain types extracted from the legacy flat types.ts facade. */
import type { ID } from "./base";
import type { HealthReasonCode } from "./node-health";
import type { NodeAdmissionRejection } from "./node-lifecycle";
/* ================================================================== */
/* V4-WP8 Monitoring —— Dashboard 待办聚合（§13.7 Wave 4）              */
/* ================================================================== */

/**
 * 待办条目种类（后端 `services/attention.ts` 的 `AttentionKind`）。
 *
 * 只分两类：需要处理的**节点**与需要处理的**转发**。更细的差别走
 * `reason_code`，不走类型 —— 多一个 kind 就要多一处 switch，而渲染差异
 * 其实全在「下一步动作」上。
 */
export type AttentionKind = "node" | "forward";

/** 严重度（与后端同值；前端只用于排序与配色，不做判定）。 */
export type AttentionSeverity = "error" | "warning" | "info";

/**
 * 待办理由码（后端 `AttentionReasonCode` 的镜像）。
 *
 * 刻意复用**既有**码族（`HealthReasonCode` / `NodeAdmissionRejection`）而不是
 * 新造一套：`connection_offline` / `runtime_revision_behind` /
 * `node_waiting_install` / `node_in_maintenance` 这些码在后端与 WP6/WP7 共用
 * 同一个判定函数，前端据此直接命中已存在的 `reasonAction` / `conditionAction`
 * 文案表（见 `lib/monitor-i18n.ts`）。新造码名会让「同一件事」有两套说法。
 */
export type AttentionReasonCode =
  | "node_waiting_install"
  | "node_in_maintenance"
  | "node_disabled"
  | "node_retiring"
  | "connection_offline"
  | "forward_apply_error"
  | "runtime_revision_behind"
  | "forward_pending_apply";

/** 单条待办：足以渲染一行 + 决定一个动作，不含任何 raw revision。 */
export interface AttentionItem {
  kind: AttentionKind;
  /** 目标资源 id（node.id / forward.id），用于跳转与去重。 */
  id: ID;
  /** 目标资源名（node_id / forward.name）。 */
  name: string;
  severity: AttentionSeverity;
  reason_code: AttentionReasonCode;
  /**
   * 失败前端的编排错误码（仅 `forward_apply_error` 有）。
   *
   * 这是**码**不是文案：前端按码查 `applyErrorAction` 与 `isRetryable`
   * 的本地镜像，给出「重试」还是「联系管理员」。
   */
  apply_error_code?: string | null;
  /**
   * 该错误是否值得用户重试（后端 `isRetryable` 的结论）。
   *
   * `null` = 后端没给结论（无错误码 / 不属于重试域）——前端此时**不显示**
   * 重试按钮，而不是猜一个「应该能重试」。
   */
  retryable?: boolean | null;
}

/** 计数摘要（过滤前口径，与后端 items 同源）。 */
export interface AttentionSummary {
  nodes_offline: number;
  nodes_waiting_install: number;
  /** 管理态（maintenance / disabled / retiring）导致不接受新业务的节点数。 */
  nodes_restricted: number;
  forwards_error: number;
  /** 未收敛的在途转发（pending / applying / revision 落后）。 */
  forwards_pending: number;
}

/** `GET /api/dashboard/attention` 的载荷。 */
export interface AttentionPayload {
  items: AttentionItem[];
  summary: AttentionSummary;
  /** 命中总数（`items` 可能被后端截断，见后端 `ATTENTION_MAX_ITEMS`）。 */
  total: number;
  generated_at: string;
  /**
   * 聚合降级标记（后端兜底分支才带）。
   *
   * `true` 表示**取不到**待办（查询失败），与「没有待办」是两件事：
   * 面板必须显示「暂时取不到」而不是「一切正常」，否则一次 DB 抖动会被
   * 用户读成「我的节点都健康」。
   */
  degraded?: boolean;
}

/** 空摘要（降级 / 缺字段时的兜底，避免渲染 `undefined`）。 */
export const EMPTY_ATTENTION_SUMMARY: AttentionSummary = {
  nodes_offline: 0,
  nodes_waiting_install: 0,
  nodes_restricted: 0,
  forwards_error: 0,
  forwards_pending: 0,
};

export interface AdminDashboardStats {
  user_count: number;
  tunnel_count: number;
  node_count: number;
  online_node_count: number;
  order_count: number;
  pending_topup_count: number;
  open_ticket_count: number;
  total_balance: number;
  today_revenue: number;
  today_traffic: number;
  tunnel_type_distribution: { type: string; count: number }[];
  revenue_trend: { date: string; amount: number }[];
}

export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  page_size: number;
}

export interface ListQuery {
  page?: number;
  page_size?: number;
  keyword?: string;
  status?: string;
  [key: string]: string | number | boolean | undefined;
}

