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
import {
  FORWARD_DENIAL_REASON,
  runForwardDenialNotifications,
  selectForwardDenialFacts,
} from "../../notification-facts-trigger.ts";
import type { DeliverableNotification, NotificationChannel } from "../../notification-delivery.ts";
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

/* ================================================================== */
/* 第二步：编排 —— 投递只走既有核心、渠道显式、失败不稀释              */
/* ================================================================== */

describe("V5-WP18 触发器：编排", () => {
  const row = (over: Partial<{ updated_at: Date; workspace_id: number }> = {}) => ({
    updated_at: new Date("2026-10-05T02:00:00.000Z"),
    workspace_id: 7,
    ...over,
  });
  const channel = { kind: "email" } as unknown as NotificationChannel;

  const deps = (
    over: Partial<{
      items: AttentionItem[];
      rows: Map<number, ReturnType<typeof row>>;
      channels: NotificationChannel[];
      delivered: Array<{ facts: readonly DeliverableNotification[]; channels: readonly NotificationChannel[] }>;
    }> = {},
  ) => {
    const delivered = over.delivered ?? [];
    return {
      deps: {
        load: async () => ({
          items: over.items ?? [item()],
          rowOf: (id: number) => (over.rows ?? new Map([[42, row()]])).get(id) ?? null,
        }),
        deliver: async (facts: readonly DeliverableNotification[], channels: readonly NotificationChannel[]) => {
          delivered.push({ facts, channels });
          return [];
        },
        channels: () => over.channels ?? [channel],
      },
      delivered,
    };
  };

  test("有事实且有渠道 ⇒ 调用投递核心一次，fact 的 scope 是**该隧道所属工作空间**", async () => {
    const { deps: d, delivered } = deps();
    const summary = await runForwardDenialNotifications(d);
    expect(summary).toMatchObject({ built: 1, rejected: 0, skipped: 0, delivered: true });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.channels).toEqual([channel]);
    expect(delivered[0]!.facts[0]!.scope).toMatchObject({ kind: "workspace", workspace_id: 7 });
    // 注意：**派生出来的 fact 里 `occurred_at` 是 ISO 字符串**（`NotificationFactSeed` 的类型
    // 声明是 `Date`，实际值不是 —— 类型与值不一致，下一个调 `.getTime()` 的人会炸；已上报给
    // 通知模块的作者）。这里按**实际值**断言，不按声明的类型断言。
    expect(String(delivered[0]!.facts[0]!.occurred_at)).toBe(row().updated_at.toISOString());
  });

  test("**一个渠道都没打开 ⇒ 不投递**（避免用 not_configured 把失败可见稀释成噪音）", async () => {
    const { deps: d, delivered } = deps({ channels: [] });
    const summary = await runForwardDenialNotifications(d);
    expect(summary.delivered).toBe(false);
    expect(summary.built).toBe(0);
    expect(delivered).toHaveLength(0);
  });

  test("没有 E 类事实 ⇒ 不投递", async () => {
    const { deps: d, delivered } = deps({ items: [item({ reason_code: "forward_pending_apply" })] });
    const summary = await runForwardDenialNotifications(d);
    expect(summary).toMatchObject({ built: 0, delivered: false });
    expect(delivered).toHaveLength(0);
  });

  test("来源行消失 ⇒ 计入 skipped（选择层已用同一判据跳过）且不投递", async () => {
    const { deps: d, delivered } = deps({ rows: new Map() });
    const summary = await runForwardDenialNotifications(d);
    // 编排层**不再**重复判一次"行是否存在"：同一个判断写两遍就有两份真相。
    expect(summary).toMatchObject({ built: 0, rejected: 0, skipped: 1, delivered: false });
    expect(delivered).toHaveLength(0);
  });

  test("来源时刻缺失 ⇒ 计入 skipped（原因由选择层给出）", async () => {
    const { deps: d } = deps({ rows: new Map([[42, row({ updated_at: null as unknown as Date })]]) });
    const summary = await runForwardDenialNotifications(d);
    // `updated_at` 为 null 时选择层按"取不到来源时刻"跳过 —— 这里断言它**不会**变成一条用
    // 扫描时刻的通知（那正是 DoD3 的反例）。
    expect(summary.built).toBe(0);
    expect(summary.delivered).toBe(false);
  });
});
