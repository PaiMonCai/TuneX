/**
 * 用户域：**投递账本的只读投影**（切片 N4）。
 *
 * 端点（`backend/src/routes/notification-deliveries.ts`，挂 `/api/notifications`）：
 *   GET /api/notifications/deliveries       本工作空间的投递记录（严格 workspace 作用域）
 *   GET /api/notifications/deliveries/:id   单条（不存在 / 别的空间 / 平台行 → 逐字同形 404）
 *
 * ── 三条纪律落在这一层 ──
 *  1. **只读服务端字段**：`status` / `failure_reason` / `attempts` / `degraded` / 汇总计数全是
 *     服务端算好的；前端**不推断**"成功/失败/是否正常"。汇总也来自服务端（`summary`），
 *     免得"界面上的数字"与"账本里的行"两处口径分叉。
 *  2. **目标一律是脱敏形态**：服务端对所有人一视同仁地掩码（邮箱只留域名、chat id 全掩码、
 *     webhook 只留 origin+摘要）。这一层不做任何"还原"或猜测，`target` 只当字符串展示。
 *  3. **载荷辨认失败 ⇒ 抛错**（上层进"取不到"分支），绝不退回空列表 —— "读不到"与"没有失败"
 *     必须可分，否则这个页面就成了另一个谎。
 */
import { get } from "./core";

export type DeliveryStatus = "sending" | "sent" | "failed";

/** 失败原因闭集（与后端 `NOTIFICATION_FAILURE_REASONS` 同源；未知码原样透出）。 */
export const DELIVERY_FAILURE_REASON_CODES = [
  "not_configured",
  "transport_error",
  "rejected_target",
  "unsupported_channel",
  "secret_unreadable",
  "ledger_unavailable",
] as const;

export interface DeliveryRow {
  id: number;
  status: string;
  failure_reason: string | null;
  /** `false` = 服务端出现了前端还不认识的失败码（原样显示并标注，不猜）。 */
  failure_reason_known: boolean;
  attempts: number;
  /** 静默期降级（Redis 不可用 ⇒ 抑制可能失效、**可能多报**）。与 `failed` 正交。 */
  degraded: boolean;
  channel_kind: string;
  /** 已脱敏的目标（永不还原）。 */
  target: string;
  target_masked: boolean;
  /** 这条通知一共投给了几个目标（服务端数出来的）。 */
  targets_count: number;
  error: string | null;
  source_kind: string;
  source_id: string;
  reason_code: string;
  severity: string;
  resource_type: string;
  resource_id: string;
  occurred_at: string | null;
  window_start: string | null;
}

export interface DeliverySummary {
  total: number;
  sent: number;
  failed: number;
  sending: number;
  degraded: number;
  by_failure_reason: Record<string, number>;
}

export interface DeliveryPage {
  scope_kind: string;
  workspace_id: number;
  truncated: boolean;
  limit: number;
  summary: DeliverySummary;
  rows: DeliveryRow[];
}

export interface DeliveryQueryInput {
  limit?: number;
  status?: DeliveryStatus;
  failure_reason?: string;
  channel_kind?: string;
  source_kind?: string;
}

function unwrapEnvelope(raw: unknown): unknown {
  if (raw && typeof raw === "object" && "data" in (raw as Record<string, unknown>)) {
    return (raw as Record<string, unknown>).data;
  }
  return raw;
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function toRow(raw: unknown): DeliveryRow | null {
  const row = asRecord(raw);
  if (!row || typeof row.id !== "number" || typeof row.status !== "string") return null;
  const summarySource = asRecord(row.by_failure_reason);
  void summarySource;
  return {
    id: row.id,
    status: row.status,
    failure_reason: stringOrNull(row.failure_reason),
    failure_reason_known: row.failure_reason_known === true,
    attempts: typeof row.attempts === "number" ? row.attempts : 0,
    degraded: row.degraded === true,
    channel_kind: typeof row.channel_kind === "string" ? row.channel_kind : "",
    target: typeof row.target === "string" ? row.target : "",
    target_masked: row.target_masked === true,
    targets_count: typeof row.targets_count === "number" ? row.targets_count : 0,
    error: stringOrNull(row.error),
    source_kind: typeof row.source_kind === "string" ? row.source_kind : "",
    source_id: typeof row.source_id === "string" ? row.source_id : "",
    reason_code: typeof row.reason_code === "string" ? row.reason_code : "",
    severity: typeof row.severity === "string" ? row.severity : "",
    resource_type: typeof row.resource_type === "string" ? row.resource_type : "",
    resource_id: typeof row.resource_id === "string" ? row.resource_id : "",
    occurred_at: stringOrNull(row.occurred_at),
    window_start: stringOrNull(row.window_start),
  };
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toSummary(raw: unknown): DeliverySummary {
  const summary = asRecord(raw) ?? {};
  const byReasonRaw = asRecord(summary.by_failure_reason) ?? {};
  const by_failure_reason: Record<string, number> = {};
  for (const [key, value] of Object.entries(byReasonRaw)) by_failure_reason[key] = numberOrZero(value);
  return {
    total: numberOrZero(summary.total),
    sent: numberOrZero(summary.sent),
    failed: numberOrZero(summary.failed),
    sending: numberOrZero(summary.sending),
    degraded: numberOrZero(summary.degraded),
    by_failure_reason,
  };
}

/** 辨认整页载荷。缺行/缺汇总 ⇒ 抛错（不显示残缺列表冒充"全部记录"）。 */
export function readDeliveryPage(raw: unknown): DeliveryPage {
  const payload = asRecord(unwrapEnvelope(raw));
  if (!payload || !Array.isArray(payload.rows)) {
    throw new Error("投递记录应答无法辨认（缺少 rows）：已按「取不到」处理，不做任何推测");
  }
  const rows = payload.rows.map(toRow).filter((row): row is DeliveryRow => row !== null);
  if (rows.length !== payload.rows.length) {
    throw new Error("投递记录里有无法辨认的行：已按「取不到」处理，不显示残缺列表");
  }
  return {
    scope_kind: typeof payload.scope_kind === "string" ? payload.scope_kind : "workspace",
    workspace_id: typeof payload.workspace_id === "number" ? payload.workspace_id : 0,
    truncated: payload.truncated === true,
    limit: numberOrZero(payload.limit),
    summary: toSummary(payload.summary),
    rows,
  };
}

export const notificationsApi = {
  /** 本工作空间的投递记录（**服务端**按 membership 作用域过滤；本层不接受任何作用域参数）。 */
  deliveries: async (query: DeliveryQueryInput = {}, cookie?: string): Promise<DeliveryPage> => {
    const listQuery: Record<string, string | number> = {};
    if (query.limit !== undefined) listQuery.limit = query.limit;
    if (query.status !== undefined) listQuery.status = query.status;
    if (query.failure_reason !== undefined) listQuery.failure_reason = query.failure_reason;
    if (query.channel_kind !== undefined) listQuery.channel_kind = query.channel_kind;
    if (query.source_kind !== undefined) listQuery.source_kind = query.source_kind;
    return readDeliveryPage(await get<unknown>("/notifications/deliveries", listQuery, cookie));
  },
  /** 单条记录（跨工作空间与不存在同形 404 —— 调用方不必区分，也不该区分）。 */
  delivery: async (id: number, cookie?: string): Promise<DeliveryRow> => {
    const payload = asRecord(unwrapEnvelope(await get<unknown>(`/notifications/deliveries/${id}`, undefined, cookie)));
    const row = toRow(payload?.row);
    if (!row) throw new Error("投递记录应答无法辨认：已按「取不到」处理");
    return row;
  },
};
