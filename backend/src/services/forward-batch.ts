/**
 * Batch request contract and per-item summaries.
 * ForwardX reference: server/routers/rules.crud.ts deleteBatch at cb0ef0b.
 * Reuse the processing sequence: deduplicate IDs, call the single-delete path,
 * isolate failures, report every outcome. TuneX adds explicit confirmation and
 * retains sequential rollout execution and its existing 50-resource limit.
 */
import type { AuthorizationErrorLayer } from "./authorization-errors.ts";
import type { ForwardAction } from "./forward-service.ts";

export const FORWARD_BATCH_ACTIONS = ["retry", "suspend", "resume", "delete"] as const;

/** Experimental destructive action: opt in at runtime, never from a web build. */
export function forwardBatchDeleteEnabled(): boolean {
  return process.env.FORWARD_BATCH_DELETE_ENABLED === "true";
}

export type ForwardBatchAction = (typeof FORWARD_BATCH_ACTIONS)[number];

/**
 * 单次批量上限。
 *
 * 为什么是 50：每个 action 都可能触发一次 rollout（两端下发 + 租约），
 * 顺序执行时 50 条已接近一次请求的合理耗时上限；再大就该拆成多次调用，
 * 让用户能看见中间结果。上限是**产品约束**（拒绝而不是静默截断）——
 * 静默只处理前 N 条会让用户以为全部都做了。
 */
export const FORWARD_BATCH_MAX_IDS = 50;

export interface ForwardBatchRequest {
  action: ForwardBatchAction;
  ids: number[];
  confirm_delete?: true;
}

export interface ForwardBatchParseError {
  message: string;
}

export function isForwardBatchAction(
  value: unknown,
): value is ForwardBatchAction {
  return (
    typeof value === "string" &&
    (FORWARD_BATCH_ACTIONS as readonly string[]).includes(value)
  );
}

/**
 * 解析批量请求体。
 *
 * 归一化规则（全部是「拒绝」而非「猜测」）：
 *   · `action` 必须在白名单内 —— 否则客户端以为执行了，实际语义由服务端发明；
 *   · `ids` 必须是非空数组，元素必须是**正整数**（字符串数字不放行：调用方是
 *     JSON API，不是表单）；
 *   · 去重（同一 id 出现两次只执行一次，避免对同一行重复 rollout）；
 *   · 超过上限直接报错（见 `FORWARD_BATCH_MAX_IDS` 的理由）。
 */
export function parseForwardBatchRequest(
  payload: unknown,
): ForwardBatchRequest | ForwardBatchParseError {
  if (!payload || typeof payload !== "object") {
    return { message: "批量操作参数不合法" };
  }
  const body = payload as Record<string, unknown>;

  if (!isForwardBatchAction(body.action)) {
    return { message: "不支持的批量动作" };
  }
  if (body.action === "delete" && body.confirm_delete !== true) {
    return { message: "批量删除必须显式确认（confirm_delete: true）" };
  }

  if (!Array.isArray(body.ids)) {
    return { message: "ids 必须是数组" };
  }
  for (const raw of body.ids) {
    if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1) {
      return { message: "ids 只能包含正整数" };
    }
  }

  const ids = [...new Set(body.ids as number[])];
  if (ids.length === 0) {
    return { message: "ids 不能为空" };
  }
  if (ids.length > FORWARD_BATCH_MAX_IDS) {
    return { message: `一次最多处理 ${FORWARD_BATCH_MAX_IDS} 条` };
  }

  return body.action === "delete"
    ? { action: body.action, ids, confirm_delete: true }
    : { action: body.action, ids };
}

export interface ForwardBatchItemResult {
  id: number;
  ok: boolean;
  apply_status: string | null;
  /**
   * Machine-readable reason. RBAC refusals use the same `forbidden` code the
   * single-resource endpoints use (`/api/forwards/:id`), so a client that maps
   * one maps the other; `error_layer` below says which layer refused.
   */
  code?: string;
  message?: string;
  apply_error_code?: string;
  /** Local desired/runtime deletion succeeded, but a remote federated leg is still being reconciled. */
  reconciliation_pending?: boolean;
  warning_code?: string;
  warning_message?: string;
  /** §13.5 error layering; present on refusals that never reached the runtime. */
  error_layer?: AuthorizationErrorLayer;
}

export interface ForwardBatchSummary {
  requested: number;
  succeeded: number;
  failed: number;
}

/**
 * 逐条结果汇总。
 *
 * 放在这里而不是路由里：前端 mock 与真实后端必须给出同一个计数口径，
 * 否则 mock 下的「成功 3 条」与线上的不一致，是最难定位的一类差异。
 */
export function forwardBatchSummary(
  results: ForwardBatchItemResult[],
): ForwardBatchSummary {
  const succeeded = results.filter((row) => row.ok).length;
  return {
    requested: results.length,
    succeeded,
    failed: results.length - succeeded,
  };
}

/**
 * 汇总文案用的失败原因分类：把逐条 `code` 归并成可读标签。
 * Includes RBAC, scope, runtime conflicts and unexpected per-item failures.
 */
export function forwardBatchFailureCodes(
  results: ForwardBatchItemResult[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of results) {
    if (row.ok) continue;
    const key = row.code ?? "unknown";
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/** Single reversible action → batch action; deletion has a separate endpoint. */
export function toForwardBatchAction(action: ForwardAction): ForwardBatchAction | null {
  return isForwardBatchAction(action) ? action : null;
}
