/**
 * V5-WP18 事实投递触发器：**事实选择**。
 *
 * 钉住的不变量（每条都对应契约里 Lead 的三条裁定，或契约自己写下的反例）：
 * ① **只选 E 类**：kind=forward 且 reason_code 精确等于既有词表里的 `forward_apply_error`。
 *    通知范围悄悄变大是事后最难发现的问题之一 —— 所以"其它理由码必须被忽略"要有断言。
 * ② **`occurred_at` 只能来自来源表**：它参与幂等键，用扫描时刻会让时间窗每拍前进一格，
 *    一条持续故障就变成每拍一条新通知（契约 DoD3 的反例）。
 * ③ **取不到来源时刻 ⇒ 跳过并说明原因**，绝不回落到"现在"（回落就是那个反例的实现）。
 * ④ 细码取既有的 `apply_error_code`，不新造字段。
 */
import { describe, expect, test } from "bun:test";
import { FORWARD_DENIAL_REASON, selectForwardDenialFacts } from "../../notification-facts-trigger.ts";
import type { AttentionItem } from "../../attention.ts";

const item = (over: Partial<AttentionItem> = {}): AttentionItem => ({
  kind: "forward",
  id: 42,
  name: "office-web",
  severity: "error",
  reason_code: FORWARD_DENIAL_REASON,
  apply_error_code: "port_in_use",
  retryable: false,
  ...over,
});

const at = new Date("2026-10-05T02:00:00.000Z");

describe("V5-WP18 触发器：只选 E 类事实", () => {
  test("E 类条目被选中，且细码来自既有 apply_error_code", () => {
    const { seeds, skipped } = selectForwardDenialFacts({ items: [item()], occurredAtOf: () => at });
    expect(skipped).toEqual([]);
    expect(seeds).toHaveLength(1);
    expect(seeds[0]!.item.id).toBe(42);
    expect(seeds[0]!.occurred_at).toBe(at);
    expect(seeds[0]!.detail_code).toBe("port_in_use");
  });

  test("其它理由码与节点类条目一律不选（通知范围不能悄悄变大）", () => {
    const { seeds } = selectForwardDenialFacts({
      items: [
        item({ id: 1, reason_code: "forward_pending_apply" }),
        item({ id: 2, kind: "node", reason_code: "connection_offline" }),
        item({ id: 3, reason_code: FORWARD_DENIAL_REASON }),
      ],
      occurredAtOf: () => at,
    });
    expect(seeds.map((s) => s.item.id)).toEqual([3]);
  });

  test("**occurred_at 必须来自来源表**：传进来什么就是什么，不会被换成扫描时刻", () => {
    const source = new Date("2026-10-05T02:00:00.000Z");
    const { seeds } = selectForwardDenialFacts({ items: [item()], occurredAtOf: () => source });
    expect(seeds[0]!.occurred_at.getTime()).toBe(source.getTime());
  });

  test("取不到来源时刻 ⇒ 跳过并说明原因（不回落到「现在」）", () => {
    const { seeds, skipped } = selectForwardDenialFacts({ items: [item()], occurredAtOf: () => null });
    expect(seeds).toEqual([]);
    expect(skipped).toEqual([{ forward_id: 42, reason: "occurred_at_unavailable" }]);
  });

  test("没有细码时 detail_code 为 null（不编一个空串出来）", () => {
    const { seeds } = selectForwardDenialFacts({
      items: [item({ apply_error_code: null })],
      occurredAtOf: () => at,
    });
    expect(seeds[0]!.detail_code).toBeNull();
  });

  test("同一 id 重复出现只产生一条事实（重复的事实就是重复的通知）", () => {
    const { seeds } = selectForwardDenialFacts({ items: [item(), item()], occurredAtOf: () => at });
    expect(seeds).toHaveLength(1);
  });
});
