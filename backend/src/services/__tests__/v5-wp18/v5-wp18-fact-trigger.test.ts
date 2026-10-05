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
  selectForwardRecoveryFacts,
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
      openDenials: { forward_id: number; name: string }[];
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
          // 默认没有未配对的拒绝 ⇒ 既有断言语义不变（"恢复"是新增的一路输入）。
          openDenials: over.openDenials ?? [],
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
    // `occurred_at` 在**两侧同名不同型**：输入侧 `NotificationFactSeed.occurred_at` 是 `Date`
    // （且派生层用 `instanceof Date` 校验、把字符串判成 `invalid_occurred_at`），输出侧
    // `NotificationFact.occurred_at` 是 **ISO 字符串**（派生即序列化 —— 一次序列化才能让
    // `dedupe_key` 跨进程/跨次派生稳定）。这里按**输出侧**的声明断言。
    // 更正记录：我最初把它报成"类型说谎"（声明 Date、实际 string），通知模块作者用行号与
    // 校验逻辑核对后指出不成立 —— 真坑是"同名不同型"。诊断的错误应当与结论一起可见。
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

/* ================================================================== */
/* 恢复事实：与拒绝配对的那一半                                          */
/* ================================================================== */

describe("V5-WP18 触发器：恢复事实", () => {
  const rows = new Map<number, Date>([[42, new Date("2026-10-05T03:00:00.000Z")]]);
  const sel = (over: Partial<{ openDenials: { forward_id: number; name: string }[]; still: number[] }> = {}) =>
    selectForwardRecoveryFacts({
      openDenials: over.openDenials ?? [{ forward_id: 42, name: "office-web" }],
      stillDeniedIds: new Set(over.still ?? []),
      occurredAtOf: (id) => rows.get(id) ?? null,
    });

  test("未配对的拒绝 + 已不再被拒 ⇒ 一条恢复事实（新码 / info / 来源表时刻）", () => {
    const { seeds, skipped } = sel();
    expect(skipped).toEqual([]);
    expect(seeds).toHaveLength(1);
    expect(seeds[0]!.item.reason_code).toBe("forward_apply_recovered");
    expect(seeds[0]!.item.severity).toBe("info");
    expect(seeds[0]!.item.id).toBe(42);
    expect(seeds[0]!.item.name).toBe("office-web");
    expect(seeds[0]!.occurred_at.getTime()).toBe(rows.get(42)!.getTime());
  });

  test("**仍在拒绝中 ⇒ 不产生恢复事实**（同一台 Forward 不能被同时说成坏了和好了）", () => {
    expect(sel({ still: [42] }).seeds).toEqual([]);
  });

  test("恢复事实**不带故障期的字段**：错误码与可重试性一律 null（不是编一个出来）", () => {
    const { seeds } = sel();
    expect(seeds[0]!.item.apply_error_code).toBeNull();
    expect(seeds[0]!.item.retryable).toBeNull();
    expect(seeds[0]!.detail_code).toBeNull();
  });

  test("取不到来源时刻 ⇒ 跳过并说明原因（绝不回落到「现在」，否则幂等键每拍变）", () => {
    const { seeds, skipped } = selectForwardRecoveryFacts({
      openDenials: [{ forward_id: 99, name: "x" }],
      stillDeniedIds: new Set(),
      occurredAtOf: () => null,
    });
    expect(seeds).toEqual([]);
    expect(skipped).toEqual([{ forward_id: 99, reason: "occurred_at_unavailable" }]);
  });

  test("同一转发出现两条未配对拒绝 ⇒ 只产生一条恢复（重复的事实就是重复的通知）", () => {
    const { seeds } = sel({ openDenials: [{ forward_id: 42, name: "a" }, { forward_id: 42, name: "b" }] });
    expect(seeds).toHaveLength(1);
  });
});

describe("V5-WP18 触发器：拒绝与恢复走**同一次投递**", () => {
  test("未配对的拒绝 + 已不在拒绝集 ⇒ 同一批里既有拒绝也有恢复，且只调一次投递", async () => {
    const delivered: Array<{ facts: readonly DeliverableNotification[] }> = [];
    const summary = await runForwardDenialNotifications({
      load: async () => ({
        // 42 仍在拒绝中（会产生拒绝事实），77 曾被拒但已恢复（会产生恢复事实）
        items: [
          { kind: "forward", id: 42, name: "a", severity: "error", reason_code: "forward_apply_error", apply_error_code: "port_in_use", retryable: false },
        ],
        openDenials: [{ forward_id: 42, name: "a" }, { forward_id: 77, name: "b" }],
        rowOf: (id: number) =>
          id === 42 || id === 77
            ? { updated_at: new Date("2026-10-05T02:00:00.000Z"), workspace_id: 7 }
            : null,
      }),
      deliver: async (facts) => {
        delivered.push({ facts });
        return [];
      },
      channels: () => [{ kind: "email" } as unknown as NotificationChannel],
    });

    expect(delivered).toHaveLength(1);
    const codes = delivered[0]!.facts.map((f) => f.reason_code).sort();
    expect(codes).toEqual(["forward_apply_error", "forward_apply_recovered"]);
    expect(summary).toMatchObject({ built: 2, recovered: 1, delivered: true });
  });

  test("只有恢复、没有新拒绝时也照常投递（否则「好了」这件事永远说不出口）", async () => {
    const delivered: Array<{ facts: readonly DeliverableNotification[] }> = [];
    const summary = await runForwardDenialNotifications({
      load: async () => ({
        items: [],
        openDenials: [{ forward_id: 77, name: "b" }],
        rowOf: () => ({ updated_at: new Date("2026-10-05T02:00:00.000Z"), workspace_id: 7 }),
      }),
      deliver: async (facts) => {
        delivered.push({ facts });
        return [];
      },
      channels: () => [{ kind: "email" } as unknown as NotificationChannel],
    });
    expect(delivered[0]!.facts.map((f) => f.reason_code)).toEqual(["forward_apply_recovered"]);
    expect(summary).toMatchObject({ built: 1, recovered: 1, delivered: true });
  });
});
