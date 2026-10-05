/**
 * V5-WP18 —— **事实类通知的投递触发器：事实选择**（第一步，纯函数）。
 *
 * 作用域由契约里 Lead 的三条裁定定死（`docs/v5-wp18-announcements-notifications-contract.md`）：
 *
 *   1. **本期只投 E 类事实**（Forward 下发被拒，reason_code = `forward_apply_error`）与其恢复。
 *      它是既有事实清单里**唯一已经有持久化真相**的一类（`tunnel.apply_status="error"` +
 *      `apply_error_code`，由 `markBlocked()` 写）；G 类（对账 findings / 联邦汇总）今天**只打日志**，
 *      而 N3 已写明"若要通知必须先把 finding 落成持久行" ⇒ 属另一个 WP。
 *   2. 骑既有 reconcile 节拍（不在本文件；本文件只管"这一拍该说哪些事实"）。
 *   3. 受众与渠道在投递层解决（本文件不碰）。
 *
 * ── 本文件刻意**不**做的事 ──
 * 不加载数据、不发信、不写账本、不读静默期。它只把"既有的 attention 条目"翻译成"可投递的事实
 * 种子"，因此可以在一张纯函数测试里被穷尽断言。派生本身复用 `collectAttention()` —— **不新建
 * 事实真相**（这是契约 D1「观测不得成为第二份真相」对通知的同一要求）。
 */
import type { AttentionItem } from "./attention.ts";
import type { NotificationFactSeed } from "./notification-facts.ts";

/**
 * E 类的理由码（取自既有词表 `AttentionReasonCode`，不是新造的字符串）。
 *
 * 用常量而不是散落的字面量：这个值同时决定"哪些 attention 条目会变成通知"，
 * 而"通知范围悄悄变大"是这类系统里最难在事后发现的问题之一。
 */
export const FORWARD_DENIAL_REASON = "forward_apply_error" as const;

/** 被跳过的事实 + 原因（跳过必须**可解释**，否则等于静默丢弃）。 */
export interface SkippedDenialFact {
  readonly forward_id: number;
  readonly reason: "occurred_at_unavailable";
}

export interface SelectResult {
  readonly seeds: NotificationFactSeed[];
  readonly skipped: SkippedDenialFact[];
}

/**
 * 从既有 attention 条目里选出 E 类事实。
 *
 * `occurredAtOf` 由调用方从**来源表**提供（`tunnel.updated_at`）。为什么不让本函数自己取
 * "现在"：`NotificationFactSeed.occurred_at` 参与幂等键，而**用扫描时刻会让时间窗每扫一次
 * 前进一格** —— 一条持续存在的故障就会变成每拍一条新通知，静默期形同虚设（契约 DoD3 的反例，
 * 原文写在 `notification-facts.ts` 的类型注释里）。
 *
 * 取不到来源时刻时**跳过并记录原因**，而不是回落到"现在"：回落正是上面那个反例的实现方式。
 */
export function selectForwardDenialFacts(input: {
  readonly items: readonly AttentionItem[];
  readonly occurredAtOf: (forwardId: number) => Date | null;
}): SelectResult {
  const seeds: NotificationFactSeed[] = [];
  const skipped: SkippedDenialFact[] = [];
  const seen = new Set<number>();

  for (const item of input.items) {
    // 只认 E 类：kind 必须是 forward，且理由码精确等于既有词表里的那一个。
    if (item.kind !== "forward") continue;
    if (item.reason_code !== FORWARD_DENIAL_REASON) continue;
    // attention 理论上不会重复给同一 id；这里去重是**防御性**的：重复的事实会变成重复的通知。
    if (seen.has(item.id)) continue;
    seen.add(item.id);

    const occurredAt = input.occurredAtOf(item.id);
    if (!occurredAt) {
      skipped.push({ forward_id: item.id, reason: "occurred_at_unavailable" });
      continue;
    }
    seeds.push({
      item,
      occurred_at: occurredAt,
      // 细码取既有的结构化错误码，**不**新增字段：前端/账本用它给出"重试 / 联系管理员"的下一步。
      detail_code: item.apply_error_code ?? null,
    });
  }

  return { seeds, skipped };
}
