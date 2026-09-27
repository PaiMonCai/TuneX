/**
 * V4-WP9 §13.6「必要批量操作」——请求校验与逐条结果汇总的**纯函数**。
 *
 * 为什么批量只做 retry / suspend / resume：
 *   · 这三个动作只改 `desired_status`，**可逆**且**逐条幂等**（retry 是同 revision
 *     重放，不抬高 revision），重复点击不产生副作用；
 *   · 「批量删除」被有意排除：删除不可逆、每次删除都要走完整 rollout + 租约释放，
 *     批量语义下无法逐条确认影响面，且失败是部分成功（哪些没删掉会成为难解释的
 *     中间态）；§13.5 的权限矩阵（WP10）尚未冻结，破坏性批量接口应先定义权限与
 *     资源作用域。用户路径：批量 suspend（可逆）→ 逐条删除。
 *   · 「批量改端口/改目标」被有意排除：端口唯一性与 listener replacement 是逐条
 *     判定（以「同入口节点已占用端口」为口径），批量应用需要先做全局端口分配，
 *     属于新特性而非交互补全（§13.7 Wave 4 明确「重点不是增加新协议」）。
 */
import type { ForwardAction } from "./forward-service.ts";

/**
 * 批量动作白名单。
 *
 * 与单条 `POST /api/forwards/:id/:action` 的 `ACTIONS` 保持一致，但**不含 delete**：
 * 单条删除有逐条确认与明确的影响面，批量删除没有。
 */
export const FORWARD_BATCH_ACTIONS = ["retry", "suspend", "resume"] as const;

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

  if (!Array.isArray(body.ids)) {
    return { message: "ids 必须是数组" };
  }
  for (const raw of body.ids) {
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
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

  return { action: body.action, ids };
}

export interface ForwardBatchItemResult {
  id: number;
  ok: boolean;
  apply_status: string | null;
  code?: string;
  message?: string;
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
 * 只有 `not_found` 与 `conflict` 会出现在批量结果里（见 runForwardBatch）。
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

/** 单条动作类型 → 批量动作类型（编译期保证批量白名单是单条白名单的子集）。 */
export function toForwardBatchAction(action: ForwardAction): ForwardBatchAction | null {
  return isForwardBatchAction(action) ? action : null;
}
