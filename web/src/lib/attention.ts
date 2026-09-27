/**
 * V4-WP8 §13.7 Wave 4 —— Dashboard 待办的**前端纯逻辑**（无 React / 无网络）。
 *
 * ── 它做什么、不做什么 ──
 * 后端 `services/attention.ts` 已经判定完「哪些节点/转发需要处理、为什么」，
 * 本模块只做三件翻译工作：
 *   1. **归组**：把条目分成「节点」「转发」两组并按后端给的 severity 排好；
 *   2. **下一步动作**：按 `reason_code` 命中**既有**文案表 ——
 *      `node-health-i18n.ts` 的 `reasonAction`（WP6）与
 *      `node-lifecycle-i18n.ts` 的 `conditionAction`（WP7），Forward 侧用
 *      `forward-status.ts` 的 `applyErrorAction`（本 WP）；
 *   3. **链接**：跳到能真正解决它的页面（节点页 / 转发详情页）。
 *
 * **判定一行都没有**：本模块不读 `last_seen_at`、不算 revision 关系、不判断
 * 生命周期合法性。缺失字段时返回 `null` 动作而不是猜一句建议。
 */
import { conditionAction } from "./node-lifecycle-i18n";
import { reasonAction } from "./node-health-i18n";
import { applyErrorAction } from "./forward-status";
import { attentionText } from "./attention-i18n";
import type { Locale } from "./i18n";
import type { AttentionItem, AttentionKind, AttentionPayload, AttentionSummary } from "./types";

/** 待办条目 → 可点击目标。（节点列表页；转发详情页。） */
export function attentionHref(item: Pick<AttentionItem, "kind" | "id">): string {
  return item.kind === "node" ? `/nodes?focus=${item.id}` : `/forwards/${item.id}`;
}

/**
 * 待办条目 → 「下一步做什么」。
 *
 * 逐类命中**既有**码表，顺序即优先级：
 *   1. `forward_apply_error` → `applyErrorAction`（编排错误码，WP8 新增）；
 *   2. 节点准入/生命周期码 → `conditionAction`（WP7，`node_waiting_install`
 *      也在这张表里 —— 它的下一步是「去安装」，而不是「改生命周期」）；
 *   3. 健康理由码（`connection_offline` / `runtime_revision_behind`）→
 *      `reasonAction`（WP6）；
 *   4. `forward_pending_apply` → 本模块自有的「等」语义（后端没有对应码表：
 *      它不是故障，用户不需要动手，所以没有可执行的建议）。
 *
 * 返回 `null` = 没有已知动作。调用方**必须**显示后端原文/症状，而不是编造一句通用建议。
 *
 * ⚠️ 「错误必须给下一步」（§13.5）与「不编造建议」在 `forward_apply_error` 上会
 * 打架：后端只给码，聚合接口没有 `apply_error` 原文可显示。所以对错误条目是
 * **两段式**回落 —— 码在表里 → 那句具体动作；码不在表里（后端新加码 / 该行没有
 * 码）→ 按 `retryable` 给一句**语义上确定**的话（`false` = 重试不会自行恢复；
 * 其它 = 打开详情看原文）。两句都不猜「是什么错」，只陈述用户能做的一步。
 */
export function attentionAction(locale: Locale, item: AttentionItem): string | null {
  const code = item.reason_code;
  if (code === "forward_apply_error") {
    const known = applyErrorAction(locale, item.apply_error_code ?? null);
    if (known) return known;
    const txt = attentionText(locale);
    return item.retryable === false ? txt.needsOperator : txt.openDetail;
  }
  // WP7 的条件码表（含 node_waiting_install / node_in_maintenance / …）。
  const condition = conditionAction(locale, code);
  if (condition) return condition;
  // WP6 的健康理由码表（connection_offline / runtime_revision_behind 都在）。
  const reason = reasonAction(locale, code);
  if (reason) return reason;
  // 「正在下发」在两张码表里都没有对应项 —— 它不是故障，用户要做的事是等。
  if (code === "forward_pending_apply") return attentionText(locale).waitingDelivery;
  return null;
}

/**
 * 该条目是否值得给「重试」按钮。
 *
 * 只有 Forward 下发失败才有重试语义，且**只信后端的结论**：
 *   · 聚合接口给了 `retryable` → 用它；
 *   · 没给（缺字段）→ `null`，调用方不显示按钮（不猜）。
 *
 * 注意这里刻意**不**回落到 `applyErrorIsRetryable`：那是给**详情页**用的
 * （详情页只有 `apply_error_code`，没有聚合接口的 `retryable` 字段）。
 * 聚合接口既然已经给了结论，前端就不该再用本地表覆盖它 —— 两处判断同一个
 * 问题正是 WP8 要消灭的形态。
 */
export function attentionRetryable(item: AttentionItem): boolean | null {
  if (item.retryable === true) return true;
  if (item.retryable === false) return false;
  return null;
}

/** 分组后的待办（渲染顺序：节点先，转发后）。 */
export interface AttentionGroup {
  kind: AttentionKind;
  items: AttentionItem[];
}

/**
 * 归组 + 排序。
 *
 * 后端已按 severity → kind → id 排好，这里**保持其相对顺序**（JS 的 sort 在
 * 现代引擎里稳定，但不依赖它：直接按出现顺序 push），只做分组。理由是让
 * 「严重度」这个跨组的顺序在分组后仍然可读——组内顺序即后端给的优先级。
 */
export function groupAttention(items: AttentionItem[] | null | undefined): AttentionGroup[] {
  const list = Array.isArray(items) ? items : [];
  const nodes = list.filter((i) => i.kind === "node");
  const forwards = list.filter((i) => i.kind === "forward");
  const groups: AttentionGroup[] = [];
  if (nodes.length > 0) groups.push({ kind: "node", items: nodes });
  if (forwards.length > 0) groups.push({ kind: "forward", items: forwards });
  return groups;
}

/** 容错归一：后端 / mock 缺字段时给完整形状，避免渲染 `undefined`。
 *
 * `degraded` 保持三态：`true`（取不到）/ `undefined`（正常拿到）。
 * 不把缺字段当成 `true`：那会让旧后端下的面板永远显示「暂时取不到」。
 */
export function normalizeAttentionPayload(input: unknown): AttentionPayload | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const items = Array.isArray(raw.items) ? (raw.items as AttentionItem[]) : [];
  const summary = (raw.summary && typeof raw.summary === "object" ? raw.summary : {}) as Partial<AttentionSummary>;
  return {
    items,
    summary: {
      nodes_offline: num(summary.nodes_offline),
      nodes_waiting_install: num(summary.nodes_waiting_install),
      nodes_restricted: num(summary.nodes_restricted),
      forwards_error: num(summary.forwards_error),
      forwards_pending: num(summary.forwards_pending),
    },
    total: num(raw.total) || items.length,
    generated_at: typeof raw.generated_at === "string" ? raw.generated_at : "",
    ...(raw.degraded === true ? { degraded: true } : {}),
  };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
