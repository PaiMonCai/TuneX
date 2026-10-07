/**
 * N3 —— 事实类通知的**生产接线**行为测试。
 *
 * ── 这份测试要证明什么（对应 task-11 的五条要求）──
 *  ① worker 真的注册了这条节拍、处理器真的调用 `runForwardDenialNotifications()`；
 *  ② 生产依赖被补齐：`load()`（候选 workspace 收窄 + 复用 `collectAttention`）、
 *     `channels()`（F5 配置 → 注册表 → 部署闸门）、**`resolveTargets` 本身**；
 *  ③ 收件人解析的纪律：目标只能来自用户自己（邮箱 / `tg_id`），**绝不把 user id 当 chat id**；
 *     解析不出来 ⇒ 空目标 ⇒ 投递层留一条 `rejected_target`（可见），而不是静默跳过；
 *  ④ 免打扰按 `(渠道, 类别=source_kind)` 生效，读不到时按"没人静音"（多报方向）；
 *  ⑤ 幂等**只在投递层**：job 每拍调用，job 内部没有去抖/冷却；
 *     webhook 显式**不**参与事实通知（不是塞进注册表制造未接线出口）。
 *
 * 这里用**真实** `runForwardDenialNotifications()` + **真实** `deliverNotificationFacts()`
 * （只把账本/静默期/渠道换成内存替身）：这样"空目标 ⇒ 账本里真的多一行 rejected_target"
 * 是跑出来的，而不是靠读代码推断的。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  FACT_NOTIFICATION_CHANNEL_KINDS,
  createFactTargetResolver,
  shouldWarnNoChannels,
  createForwardDenialDeps,
  factNotificationChannels,
  runForwardDenialNotifications,
} from "../../notification-facts-trigger.ts";
import type { ForwardDenialWiringDeps } from "../../notification-facts-trigger.ts";
import {
  deliverNotificationFacts,
  type ChannelResult,
  type NewNotificationDelivery,
  type NotificationChannel,
  type NotificationCooldownStore,
  type NotificationDeliveryPatch,
  type NotificationLedgerStore,
} from "../../notification-delivery.ts";
import { ANNOUNCEMENT_CHANNEL_KINDS } from "../../announcement-delivery.ts";
import { createWebhookChannel } from "../../notification-webhook.ts";
import type { AttentionItem } from "../../attention.ts";
import type { NotificationMute } from "../../announcement-mute.ts";

/* ================================================================== */
/* 替身：内存账本 / 静默期 / 渠道                                        */
/* ================================================================== */

interface LedgerRow {
  id: number;
  row: NewNotificationDelivery;
  patch?: NotificationDeliveryPatch;
}

function memoryLedger() {
  const rows: LedgerRow[] = [];
  const keys = new Set<string>();
  let nextId = 1;
  const store: NotificationLedgerStore = {
    async claim(row) {
      const key = `${row.dedupe_key}\u0000${row.channel_kind}`;
      if (keys.has(key)) return { ok: false, duplicate: true };
      keys.add(key);
      const id = nextId++;
      rows.push({ id, row });
      return { ok: true, id };
    },
    async settle(id, patch) {
      const found = rows.find((row) => row.id === id);
      if (found) found.patch = patch;
    },
  };
  return { rows, store };
}

const allowAllCooldown: NotificationCooldownStore = { acquire: async () => true };

/** 最小的 email 渠道替身：只记录"发给了谁"，形状校验与真渠道同口径。 */
function emailChannel() {
  const sent: string[] = [];
  const channel: NotificationChannel = {
    kind: "email",
    isConfigured: () => true,
    validateConfig: ({ target }) =>
      typeof target === "string" && target.includes("@") ? { ok: true } : { ok: false, reason: "rejected_target" },
    async send(_rendered, target): Promise<ChannelResult> {
      sent.push(target);
      return { sent: true };
    },
  };
  return { channel, sent };
}

function telegramChannel() {
  const sent: string[] = [];
  const channel: NotificationChannel = {
    kind: "telegram",
    isConfigured: () => true,
    validateConfig: ({ target }) =>
      typeof target === "string" && /^-?\d{1,19}$/.test(target.trim()) ? { ok: true } : { ok: false, reason: "rejected_target" },
    async send(_rendered, target): Promise<ChannelResult> {
      sent.push(target);
      return { sent: true };
    },
  };
  return { channel, sent };
}

/* ================================================================== */
/* 受控接线                                                            */
/* ================================================================== */

interface TunnelRow {
  id: number;
  workspace_id: number;
  name: string;
  apply_status: string;
  updated_at: Date;
  category?: string;
}

const T0 = new Date("2026-10-06T10:00:00.000Z");

function denialItem(over: Partial<AttentionItem> = {}): AttentionItem {
  return {
    kind: "forward",
    id: 42,
    name: "office-web",
    severity: "error",
    reason_code: "forward_apply_error",
    apply_error_code: "port_in_use",
    retryable: false,
    ...over,
  };
}

/** 只实现本模块用到的两种 `where` 形状（candidates / rows），与真实查询逐条对应。 */
function tunnelDb(tunnels: readonly TunnelRow[]) {
  const queries: Array<Record<string, unknown>> = [];
  return {
    queries,
    tunnel: {
      async findMany(args: Record<string, unknown>) {
        queries.push(args);
        const where = args.where as {
          category?: string;
          OR?: Array<{ apply_status?: string; id?: { in: number[] } }>;
          workspace_id?: { in: number[] };
        };
        return tunnels
          .filter((row) => (where.category === undefined ? true : (row.category ?? "port_forward") === where.category))
          .filter((row) => {
            if (where.OR) {
              return where.OR.some((clause) =>
                clause.apply_status !== undefined
                  ? row.apply_status === clause.apply_status
                  : (clause.id?.in ?? []).includes(row.id),
              );
            }
            if (where.workspace_id?.in) return where.workspace_id.in.includes(row.workspace_id);
            return true;
          })
          .map((row) => ({ ...row }));
      },
    },
  };
}

function harness(over: {
  tunnels?: readonly TunnelRow[];
  openDenials?: Array<{ source_id: string; channel_kind: string }>;
  itemsByWorkspace?: Record<number, AttentionItem[]>;
  collectThrows?: Record<number, Error>;
  channels?: readonly NotificationChannel[];
  channelsThrows?: Error;
  audience?: (scope: { kind: string; workspace_id?: number }) => Promise<
    { ok: true; recipients: Array<{ user_id: number; email: string | null; tg_id: string | null }> } | { ok: false; reason: string }
  >;
  audienceThrows?: Error;
  mutes?: Map<number, readonly NotificationMute[]>;
  mutesThrows?: Error;
}) {
  const warns: string[] = [];
  const collectCalls: number[] = [];
  const channelLoads = { count: 0 };
  const db = tunnelDb(over.tunnels ?? []);
  const ledger = memoryLedger();

  const deliverFacts: ForwardDenialWiringDeps["deliverFacts"] = async (facts, channels, resolveTargets) =>
    deliverNotificationFacts(facts, {
      channels,
      resolveTargets,
      ledger: ledger.store,
      cooldown: allowAllCooldown,
      degradedCooldown: () => true,
      sleep: async () => {},
    });

  const deps = createForwardDenialDeps({
    db,
    loadOpenDenials: async () => over.openDenials ?? [],
    collectItems: async (workspaceId) => {
      collectCalls.push(workspaceId);
      const thrown = over.collectThrows?.[workspaceId];
      if (thrown) throw thrown;
      return over.itemsByWorkspace?.[workspaceId] ?? [];
    },
    loadChannels: async () => {
      channelLoads.count += 1;
      if (over.channelsThrows) throw over.channelsThrows;
      return over.channels ?? [];
    },
    deliverFacts,
    resolveTargetsDeps: {
      audienceOf: async (scope) => {
        if (over.audienceThrows) throw over.audienceThrows;
        if (over.audience) return await over.audience(scope as { kind: string; workspace_id?: number });
        return { ok: true, recipients: [] };
      },
      loadMutes: async (userIds) => {
        if (over.mutesThrows) throw over.mutesThrows;
        const mutes = over.mutes ?? new Map<number, readonly NotificationMute[]>();
        const selected = new Map<number, readonly NotificationMute[]>();
        for (const id of userIds) selected.set(id, mutes.get(id) ?? []);
        return { ok: true, mutes: selected };
      },
      warn: (message) => warns.push(message),
    },
    warn: (message) => warns.push(message),
  });

  return { deps, ledger, db, collectCalls, channelLoads, warns };
}

const MEMBER = { user_id: 7, email: "ops@example.com", tg_id: "100200300" };

/* ================================================================== */
/* ① 生产依赖：load() 的候选收窄与失败隔离                               */
/* ================================================================== */

describe("N3 load()：只扫可能有事实的 workspace，且失败不拖垮整轮", () => {
  test("候选 = 正在拒绝的转发 ∪ 账本里开着拒绝的转发（恢复事实的来源）", async () => {
    const harnessed = harness({
      tunnels: [
        { id: 1, workspace_id: 10, name: "denied", apply_status: "error", updated_at: T0 },
        { id: 2, workspace_id: 20, name: "recovered", apply_status: "active", updated_at: T0 },
        { id: 3, workspace_id: 30, name: "healthy", apply_status: "active", updated_at: T0 },
      ],
      openDenials: [{ source_id: "2", channel_kind: "email" }],
      itemsByWorkspace: { 10: [], 20: [] },
    });
    const source = await harnessed.deps.load();
    // workspace 30 既不在拒绝中、也没有开着的拒绝 ⇒ 不该被扫（不收窄就等于每拍全表扫描）。
    expect(harnessed.collectCalls.sort((a, b) => a - b)).toEqual([10, 20]);
    expect(source.openDenials).toEqual([{ forward_id: 2, name: "recovered" }]);
    expect(source.rowOf(1)?.workspace_id).toBe(10);
    expect(source.rowOf(99)).toBeNull();
  });

  test("单个 workspace 的待办聚合失败 ⇒ 跳过它并留告警，其余照样扫", async () => {
    const harnessed = harness({
      tunnels: [
        { id: 1, workspace_id: 10, name: "a", apply_status: "error", updated_at: T0 },
        { id: 2, workspace_id: 20, name: "b", apply_status: "error", updated_at: T0 },
      ],
      itemsByWorkspace: { 10: [], 20: [denialItem({ id: 2, name: "b" })] },
      collectThrows: { 10: new Error("db down") },
      channels: [emailChannel().channel],
      audience: async () => ({ ok: true, recipients: [MEMBER] }),
    });
    const summary = await runForwardDenialNotifications(harnessed.deps);
    expect(summary.delivered).toBe(true);
    expect(harnessed.warns.some((w) => w.includes("workspace 10"))).toBe(true);
    // workspace 20 的事实照样投递（一次失败没有把整轮变成"什么都没发生"）。
    expect(harnessed.ledger.rows.filter((row) => row.row.source_id === "2").length).toBe(1);
  });

  test("渠道配置读取抛错 ⇒ 本拍不投递并留告警，不把异常当成「没配置」", async () => {
    const harnessed = harness({
      tunnels: [{ id: 1, workspace_id: 10, name: "a", apply_status: "error", updated_at: T0 }],
      itemsByWorkspace: { 10: [denialItem({ id: 1 })] },
      channelsThrows: new Error("config storage down"),
    });
    const summary = await runForwardDenialNotifications(harnessed.deps);
    expect(summary.delivered).toBe(false);
    expect(harnessed.ledger.rows.length).toBe(0);
    expect(harnessed.warns.some((w) => w.includes("渠道配置读取失败"))).toBe(true);
  });

  test("同一拍只读一次渠道配置（一次抖动不该让两个事实走不同渠道集合）", async () => {
    const harnessed = harness({
      tunnels: [
        { id: 1, workspace_id: 10, name: "a", apply_status: "error", updated_at: T0 },
        { id: 2, workspace_id: 10, name: "b", apply_status: "error", updated_at: T0 },
      ],
      itemsByWorkspace: { 10: [denialItem({ id: 1 }), denialItem({ id: 2 })] },
      channels: [emailChannel().channel],
      audience: async () => ({ ok: true, recipients: [MEMBER] }),
    });
    const summary = await runForwardDenialNotifications(harnessed.deps);
    expect(summary.built).toBe(2);
    expect(harnessed.channelLoads.count).toBe(1);
  });

  test("读失败的 workspace 被**记录下来**（供编排层排除它的恢复候选）", async () => {
    const harnessed = harness({
      tunnels: [
        { id: 1, workspace_id: 10, name: "a", apply_status: "error", updated_at: T0 },
        { id: 2, workspace_id: 20, name: "b", apply_status: "error", updated_at: T0 },
      ],
      itemsByWorkspace: { 10: [], 20: [] },
      collectThrows: { 10: new Error("db down") },
    });
    const source = await harnessed.deps.load();
    expect(source.unreadableWorkspaceIds).toEqual([10]);
    // 行快照仍然在：排除恢复候选靠它定位"这条拒绝属于哪个空间"，而**不是**去查 `apply_status`
    // 另立第二套判据（状态列回答不了"这一拍我们读到了什么"）。
    expect(source.rowOf(1)?.workspace_id).toBe(10);
  });
});

/* ================================================================== */
/* ⑦ 假恢复（task-47）：读失败的 workspace 不得产生恢复事实                */
/* ================================================================== */
//
// 缺陷现场（P1）：`load()` 的循环对单个 workspace 的 `collectItems` 抛错只 `warn`，
// `items` 里没有它的条目 ⇒ 编排层用 `source.items` 反推 `stillDenied` 时，该空间在账本里
// **仍然开着**的历史拒绝会被当成"已经不在拒绝里"，于是生成一条 `forward_apply_recovered`
// （假恢复：转发其实还在 error，只是这一拍没读到）。

describe("N3 假恢复：读失败的 workspace 既不报故障、也不报恢复", () => {
  test("历史拒绝 + 读取异常 + 另一个 workspace 成功：本拍不发恢复，下一拍读到了才发", async () => {
    const email = emailChannel();
    const throws: Record<number, Error> = { 10: new Error("db down") };
    const over: Parameters<typeof harness>[0] = {
      tunnels: [
        { id: 1, workspace_id: 10, name: "still-denied", apply_status: "error", updated_at: T0 },
        { id: 2, workspace_id: 20, name: "other-denied", apply_status: "error", updated_at: T0 },
      ],
      // 账本里两条"开着的拒绝"：1 在**读失败**的空间（它的状态未知），2 在读得到的空间。
      openDenials: [
        { source_id: "1", channel_kind: "email" },
        { source_id: "2", channel_kind: "email" },
      ],
      itemsByWorkspace: { 20: [denialItem({ id: 2, name: "other-denied" })] },
      collectThrows: throws,
      channels: [email.channel],
      audience: async () => ({ ok: true, recipients: [MEMBER] }),
    };
    const harnessed = harness(over);

    const first = await runForwardDenialNotifications(harnessed.deps);
    // ★ 核心断言：修复前这里是 1（把"没读到"渲染成"已经好了"）。
    expect(first.recovered_derived).toBe(0);
    expect(first.recovered).toBe(0);
    expect(harnessed.ledger.rows.filter((row) => row.row.reason_code === "forward_apply_recovered")).toEqual([]);
    // 跳过必须**可解释**：这条被推迟的恢复计进 `skipped`，并且失败空间有告警点名。
    expect(first.skipped).toBeGreaterThanOrEqual(1);
    expect(harnessed.warns.some((w) => w.includes("workspace 10"))).toBe(true);
    // 成功空间继续：ws 20 的拒绝事实照常投递（一次失败没有把整轮变成"什么都没发生"）。
    expect(
      harnessed.ledger.rows.some((row) => row.row.source_id === "2" && row.row.reason_code === "forward_apply_error"),
    ).toBe(true);

    // 下一拍：读成功、且该转发确实不再被拒 ⇒ 恢复事实**这时才**说出口（不是丢失）。
    delete throws[10];
    const second = await runForwardDenialNotifications(harnessed.deps);
    expect(second.recovered_derived).toBe(1);
    expect(second.recovered).toBe(1);
    expect(
      harnessed.ledger.rows
        .filter((row) => row.row.reason_code === "forward_apply_recovered")
        .map((row) => row.row.source_id),
    ).toEqual(["1"]);
  });

  test("读失败的空间里**仍在拒绝**的转发：下一拍读到后不报恢复（它还在拒绝）", async () => {
    const throws: Record<number, Error> = { 10: new Error("db down") };
    const harnessed = harness({
      tunnels: [{ id: 1, workspace_id: 10, name: "still-denied", apply_status: "error", updated_at: T0 }],
      openDenials: [{ source_id: "1", channel_kind: "email" }],
      itemsByWorkspace: { 10: [denialItem({ id: 1, name: "still-denied" })] },
      collectThrows: throws,
      channels: [emailChannel().channel],
      audience: async () => ({ ok: true, recipients: [MEMBER] }),
    });

    const first = await runForwardDenialNotifications(harnessed.deps);
    expect(first.recovered_derived).toBe(0);

    // 下一拍读到了，但它**仍在拒绝** ⇒ 依旧不发恢复（同一台转发不能被同时说成坏了和好了）。
    delete throws[10];
    const second = await runForwardDenialNotifications(harnessed.deps);
    expect(second.recovered_derived).toBe(0);
    expect(harnessed.ledger.rows.filter((row) => row.row.reason_code === "forward_apply_recovered")).toEqual([]);
  });
});

/* ================================================================== */
/* ② 收件人解析：只能来自用户自己，解析不出来要留行                       */
/* ================================================================== */

describe("N3 resolveTargets：目标只来自用户自己 + 空目标必须留行", () => {
  test("真实投递一遍：拒绝事实发到该 workspace 成员的邮箱，账本 status=sent", async () => {
    const email = emailChannel();
    const harnessed = harness({
      tunnels: [{ id: 42, workspace_id: 10, name: "office-web", apply_status: "error", updated_at: T0 }],
      itemsByWorkspace: { 10: [denialItem()] },
      channels: [email.channel],
      audience: async () => ({ ok: true, recipients: [MEMBER, { user_id: 8, email: "second@example.com", tg_id: null }] }),
    });
    const summary = await runForwardDenialNotifications(harnessed.deps);
    expect(summary).toMatchObject({ built: 1, delivered: true, recovered: 0 });
    expect(email.sent.sort()).toEqual(["ops@example.com", "second@example.com"]);
    const row = harnessed.ledger.rows[0]!;
    expect(row.row).toMatchObject({
      scope_kind: "workspace",
      workspace_id: 10,
      source_kind: "forward",
      source_id: "42",
      reason_code: "forward_apply_error",
      channel_kind: "email",
    });
    expect(row.patch).toMatchObject({ status: "sent", failure_reason: null });
  });

  test("受众解析失败 ⇒ 空目标 ⇒ 账本留一条 rejected_target（不静默跳过）", async () => {
    const email = emailChannel();
    const harnessed = harness({
      tunnels: [{ id: 42, workspace_id: 10, name: "office-web", apply_status: "error", updated_at: T0 }],
      itemsByWorkspace: { 10: [denialItem()] },
      channels: [email.channel],
      audience: async () => ({ ok: false, reason: "storage_error" }),
    });
    const summary = await runForwardDenialNotifications(harnessed.deps);
    expect(summary.delivered).toBe(true);
    expect(email.sent).toEqual([]);
    expect(harnessed.ledger.rows).toHaveLength(1);
    expect(harnessed.ledger.rows[0]!.patch).toMatchObject({ status: "failed", failure_reason: "rejected_target" });
    expect(harnessed.warns.some((w) => w.includes("受众解析失败"))).toBe(true);
  });

  test("受众解析抛错同样收敛成 rejected_target，异常不冒泡", async () => {
    const email = emailChannel();
    const harnessed = harness({
      tunnels: [{ id: 42, workspace_id: 10, name: "office-web", apply_status: "error", updated_at: T0 }],
      itemsByWorkspace: { 10: [denialItem()] },
      channels: [email.channel],
      audienceThrows: new Error("boom"),
    });
    const summary = await runForwardDenialNotifications(harnessed.deps);
    expect(summary.delivered).toBe(true);
    expect(harnessed.ledger.rows[0]!.patch).toMatchObject({ status: "failed", failure_reason: "rejected_target" });
  });

  test("telegram 目标只能来自该用户自己的 tg_id；未绑定 ⇒ 无目标 ⇒ 留行（绝不拿 user id 顶上）", async () => {
    const telegram = telegramChannel();
    const harnessed = harness({
      tunnels: [{ id: 42, workspace_id: 10, name: "office-web", apply_status: "error", updated_at: T0 }],
      itemsByWorkspace: { 10: [denialItem()] },
      channels: [telegram.channel],
      audience: async () => ({
        ok: true,
        recipients: [MEMBER, { user_id: 8, email: null, tg_id: null }, { user_id: 9, email: null, tg_id: "  " }],
      }),
    });
    const summary = await runForwardDenialNotifications(harnessed.deps);
    expect(summary.delivered).toBe(true);
    expect(telegram.sent).toEqual(["100200300"]);
    expect(telegram.sent).not.toContain("8");
    expect(telegram.sent).not.toContain("9");
    expect(harnessed.ledger.rows[0]!.row.target).toBe("100200300");
  });

  test("失败分档：解析不出目标走 rejected_target（可查），不是 transport_error（会重试）", async () => {
    const email = emailChannel();
    const resolver = createFactTargetResolver({
      audienceOf: async () => ({ ok: false, reason: "audience_too_large" }),
      loadMutes: async () => ({ ok: true, mutes: new Map() }),
      warn: () => {},
    });
    const outcome = await deliverNotificationFacts(
      [
        {
          scope: { kind: "workspace", workspace_id: 10 },
          source_kind: "forward",
          source_id: "42",
          reason_code: "forward_apply_error",
          severity: "error",
          resource_type: "forward",
          resource_id: "42",
          occurred_at: T0.toISOString(),
          window_start: T0.toISOString(),
          dedupe_key: "dedupe-42",
        } as never,
      ],
      { channels: [email.channel], resolveTargets: resolver, ledger: memoryLedger().store, cooldown: allowAllCooldown },
    );
    expect(outcome[0]).toMatchObject({ status: "failed", reason: "rejected_target", attempts: 0 });
  });

  test("同一拍内受众只解析一次（多事实共享同一份快照），但跨 scope 不串用", async () => {
    const calls: string[] = [];
    const resolver = createFactTargetResolver({
      audienceOf: async (scope) => {
        calls.push(scope.kind === "platform" ? "platform" : `ws:${scope.workspace_id}`);
        return { ok: true, recipients: [MEMBER] };
      },
      loadMutes: async () => ({ ok: true, mutes: new Map() }),
      warn: () => {},
    });
    const fact = (workspaceId: number, id: string) =>
      ({
        scope: { kind: "workspace", workspace_id: workspaceId },
        source_kind: "forward",
        source_id: id,
        reason_code: "forward_apply_error",
        severity: "error",
        resource_type: "forward",
        resource_id: id,
        occurred_at: T0.toISOString(),
        window_start: T0.toISOString(),
        dedupe_key: `dedupe-${id}`,
      }) as never;
    const channel = emailChannel().channel;
    await resolver(fact(10, "1"), channel);
    await resolver(fact(10, "2"), channel);
    await resolver(fact(20, "3"), channel);
    expect(calls).toEqual(["ws:10", "ws:20"]);
  });
});

/* ================================================================== */
/* ③ 免打扰：按 (渠道, 类别=source_kind) 生效，读不到按"没人静音"        */
/* ================================================================== */

describe("N3 免打扰：与公告同一套判据", () => {
  test("成员静音了「email × forward」⇒ 不发给他；类别是 forward 而不是别的", async () => {
    const email = emailChannel();
    const mutes = new Map<number, readonly NotificationMute[]>([
      [7, [{ channel_kind: "email", category: "forward" }]],
    ]);
    const harnessed = harness({
      tunnels: [{ id: 42, workspace_id: 10, name: "office-web", apply_status: "error", updated_at: T0 }],
      itemsByWorkspace: { 10: [denialItem()] },
      channels: [email.channel],
      audience: async () => ({ ok: true, recipients: [MEMBER, { user_id: 8, email: "second@example.com", tg_id: null }] }),
      mutes,
    });
    await runForwardDenialNotifications(harnessed.deps);
    expect(email.sent).toEqual(["second@example.com"]);
  });

  test("「email × node」的静音**不**影响 forward 事实（类别必须真的被区分）", async () => {
    const email = emailChannel();
    const harnessed = harness({
      tunnels: [{ id: 42, workspace_id: 10, name: "office-web", apply_status: "error", updated_at: T0 }],
      itemsByWorkspace: { 10: [denialItem()] },
      channels: [email.channel],
      audience: async () => ({ ok: true, recipients: [MEMBER] }),
      mutes: new Map<number, readonly NotificationMute[]>([[7, [{ channel_kind: "email", category: "node" }]]]),
    });
    await runForwardDenialNotifications(harnessed.deps);
    expect(email.sent).toEqual(["ops@example.com"]);
  });

  test("免打扰读不到 ⇒ 按「没人静音」继续（多报方向）+ 告警", async () => {
    const email = emailChannel();
    const harnessed = harness({
      tunnels: [{ id: 42, workspace_id: 10, name: "office-web", apply_status: "error", updated_at: T0 }],
      itemsByWorkspace: { 10: [denialItem()] },
      channels: [email.channel],
      audience: async () => ({ ok: true, recipients: [MEMBER] }),
      mutesThrows: new Error("mute store down"),
    });
    await runForwardDenialNotifications(harnessed.deps);
    expect(email.sent).toEqual(["ops@example.com"]);
    expect(harnessed.warns.some((w) => w.includes("免打扰清单读取"))).toBe(true);
  });
});

/* ================================================================== */
/* ④ 幂等只在投递层；webhook 显式排除                                    */
/* ================================================================== */

describe("N3 幂等与渠道范围", () => {
  test("同一拍重复调用不重复发送（幂等键 × 渠道的唯一性由投递层保证）", async () => {
    const email = emailChannel();
    const harnessed = harness({
      tunnels: [{ id: 42, workspace_id: 10, name: "office-web", apply_status: "error", updated_at: T0 }],
      itemsByWorkspace: { 10: [denialItem()] },
      channels: [email.channel],
      audience: async () => ({ ok: true, recipients: [MEMBER] }),
    });
    await runForwardDenialNotifications(harnessed.deps);
    const second = await runForwardDenialNotifications(harnessed.deps);
    expect(email.sent).toEqual(["ops@example.com"]);
    // 第二拍：账本唯一索引把这一格判成 duplicate ⇒ 不再发第二封（而不是靠 job 里的去抖）。
    expect(second.delivered).toBe(true);
    expect(harnessed.ledger.rows).toHaveLength(1);
  });

  test("job 内没有去抖/冷却：源码里不出现第二套抑制判据", () => {
    const source = readFileSync(new URL("../../notification-facts-trigger.ts", import.meta.url), "utf8");
    // 抑制只允许来自投递层的 `deliverNotificationFacts`（账本 + Redis 静默期）。
    expect(source).not.toContain("setTimeout");
    expect(source).not.toContain("cooldownSecondsForReason");
    expect(source).not.toContain("lastSentAt");
  });

  test("webhook 不参与事实通知（即使部署开关开着），且渠道白名单与公告同源", () => {
    const webhook = createWebhookChannel({ enabled: () => true });
    expect(webhook.isConfigured({ kind: "platform" } as never)).toBe(true);
    expect(factNotificationChannels([webhook])).toEqual([]);
    // 同一份常量，不是副本：改一处即两处同时改。
    expect(FACT_NOTIFICATION_CHANNEL_KINDS).toBe(ANNOUNCEMENT_CHANNEL_KINDS);
  });

  test("一个渠道都没打开 ⇒ 不投递、零账本行（不制造 not_configured 噪音）", async () => {
    const harnessed = harness({
      tunnels: [{ id: 42, workspace_id: 10, name: "office-web", apply_status: "error", updated_at: T0 }],
      itemsByWorkspace: { 10: [denialItem()] },
      channels: [],
      audience: async () => ({ ok: true, recipients: [MEMBER] }),
    });
    const summary = await runForwardDenialNotifications(harnessed.deps);
    expect(summary.delivered).toBe(false);
    expect(summary.built).toBe(0);
    expect(harnessed.ledger.rows).toHaveLength(0);
  });

  /* ── task-47：零渠道 ≠ 零事实（这条路径必须能被回答） ── */
  test("零渠道但**有事实**：summary 必须把 `facts_derived` 与 `built` 分开，并打一行明确告警", async () => {
    const harnessed = harness({
      tunnels: [{ id: 42, workspace_id: 10, name: "office-web", apply_status: "error", updated_at: T0 }],
      // **两条待办**：一条是 E 类事实（error），一条不是（pending）⇒ `considered:2` 但 `facts_derived:1`。
      // 这个差值就是"告警必须按 facts_derived 计数、不能按 considered"的可测形式。
      itemsByWorkspace: { 10: [denialItem(), denialItem({ id: 43, name: "other", reason_code: "forward_pending_apply", severity: "info" })] },
      channels: [],
      audience: async () => ({ ok: true, recipients: [MEMBER] }),
    });
    const summary = await runForwardDenialNotifications(harnessed.deps);

    // ① 拆分：看到了 1 条**事实**（considered 是 2 条待办），一个渠道都没打开 ⇒ 投出 0 条。
    //    （反向变异：把拆分改回单一计数 ⇒ `facts_derived` 不存在/等于 considered ⇒ 立刻红。）
    expect(summary).toMatchObject({
      considered: 2,
      facts_derived: 1,
      recovered_derived: 0,
      channels_open: 0,
      built: 0,
      recovered: 0,
      delivered: false,
    });
    // ② 告警必须**说清"看到了几条 + 为什么没投"**，而不是一句泛化的失败。
    const warning = harnessed.warns.find((w) => w.includes("没有任何已配置渠道"));
    expect(warning).toBeTruthy();
    expect(warning).toContain("派生 1 条事实");
    expect(warning).toContain("不投递");
    // ③ 账本仍然零行：零渠道下没有 (事实 × 渠道) 这一格，不伪造投递记录（理由见报告）。
    expect(harnessed.ledger.rows).toHaveLength(0);
  });

  test("有渠道时行为**不变**（回归）：facts_derived === built，且没有零渠道告警", async () => {
    const email = emailChannel();
    const harnessed = harness({
      tunnels: [{ id: 42, workspace_id: 10, name: "office-web", apply_status: "error", updated_at: T0 }],
      itemsByWorkspace: { 10: [denialItem()] },
      channels: [email.channel],
      audience: async () => ({ ok: true, recipients: [MEMBER] }),
    });
    const summary = await runForwardDenialNotifications(harnessed.deps);
    expect(summary).toMatchObject({ considered: 1, facts_derived: 1, channels_open: 1, built: 1, delivered: true });
    expect(harnessed.warns.filter((w) => w.includes("没有任何已配置渠道"))).toHaveLength(0);
    expect(email.sent).toEqual(["ops@example.com"]);
  });

  test("零渠道且**零事实**：不打告警（空闲不等于异常），但 summary 仍然两个数都在", async () => {
    const harnessed = harness({ tunnels: [], itemsByWorkspace: {}, channels: [] });
    const summary = await runForwardDenialNotifications(harnessed.deps);
    expect(summary).toMatchObject({ considered: 0, facts_derived: 0, channels_open: 0, built: 0, delivered: false });
    expect(harnessed.warns.filter((w) => w.includes("没有任何已配置渠道"))).toHaveLength(0);
  });

  test("**反噪**：告警条件是 `facts_derived>0 && 零渠道`，**不是** `considered>0`", () => {
    // 真实安装里 `considered` 长期 >0（只要库里有一条 error 转发或任一待办）；
    // 按 `considered>0` 告警 = 每 30 秒一行的永久刷屏（评审实测：清理后仍是 considered:1）。
    // 这里直接钉住判定本身（纯函数），并说明为什么它必须只看 `facts_derived`。
    expect(shouldWarnNoChannels({ facts_derived: 1, channels_open: 0 })).toBe(true);
    expect(shouldWarnNoChannels({ facts_derived: 0, channels_open: 0 })).toBe(false);
    expect(shouldWarnNoChannels({ facts_derived: 3, channels_open: 1 })).toBe(false);
  });

  test("恢复事实同样分开计数：零渠道时 recovered_derived 也要报出来", async () => {
    const harnessed = harness({
      tunnels: [{ id: 42, workspace_id: 10, name: "office-web", apply_status: "active", updated_at: T0 }],
      openDenials: [{ source_id: "42", channel_kind: "email" }],
      itemsByWorkspace: { 10: [] },
      channels: [],
    });
    const summary = await runForwardDenialNotifications(harnessed.deps);
    expect(summary).toMatchObject({ facts_derived: 1, recovered_derived: 1, built: 0, recovered: 0, delivered: false });
    expect(harnessed.warns.some((w) => w.includes("恢复 1 条"))).toBe(true);
  });
});

/* ================================================================== */
/* ⑤ worker 接线锚点                                                   */
/* ================================================================== */

describe("N3 worker 接线", () => {
  test("注册了 cron_notification_facts，处理器调用 runForwardDenialNotifications（接线锚点）", () => {
    // 为什么读源码文本：`worker.ts` 顶层会真的建 BullMQ/Redis 连接（`import` 它等于连 Redis），
    // 与 ddns-sync-sweep.test.ts 同一处理。行为正确性由上面的用例 + 真机证据证明。
    const source = readFileSync(new URL("../../../worker.ts", import.meta.url), "utf8");
    expect(source).toContain('name: "cron_notification_facts"');
    expect(source).toContain('case "cron_notification_facts"');
    expect(source).toContain("runForwardDenialNotifications");
    expect(source).toContain("defaultForwardDenialDeps");
    // 这条节拍必须是**自己的** case，不能搭别的扫描的车（否则缺省配置下又会永不触发）。
    expect(source).toContain('"./services/notification-facts-trigger.ts"');
    // task-47 的修法收窄：打印条件**故意不含** `facts_derived` —— 否则只要库里有一条
    // 长期 error 的转发，summary 就会每 30 秒打一行（永久噪音）。"有事实但零渠道"这件事
    // 由触发器自己的告警行承载（见下一条反噪测试）。
    expect(source).not.toContain("r.facts_derived > 0");
  });
});

/* ================================================================== */
/* ⑥ 收窄判据与 attention 派生等价（这条不等价就会静默漏事实）             */
/* ================================================================== */

describe("N3 候选收窄：与 attention 的派生逐条对齐", () => {
  test("forward_apply_error 只可能来自 apply_status='error'（收窄不会漏掉别的入口）", async () => {
    // 为什么必须有这条：`load()` 用 `apply_status='error'` 收窄候选 workspace。
    // 如果 attention 里还有**第二个**产生 `forward_apply_error` 的分支，收窄就会静默漏事实。
    // 这里直接驱动**真实** `collectAttention()`（注入受控 db），把等价关系钉在行为上。
    const { collectAttention } = await import("../../attention.ts");
    const payload = await collectAttention(
      10,
      {
        db: {
          tunnel: {
            findMany: async () => [
              { id: 1, name: "err", apply_status: "error", apply_error_code: "port_in_use", config_revision: 3, applied_revision: 3 },
              { id: 2, name: "behind", apply_status: "active", apply_error_code: null, config_revision: 3, applied_revision: 2 },
              { id: 3, name: "pending", apply_status: "pending", apply_error_code: null, config_revision: 3, applied_revision: null },
              { id: 4, name: "ok", apply_status: "active", apply_error_code: null, config_revision: 3, applied_revision: 3 },
            ],
          },
        },
        now: () => T0,
        isRetryable: () => false,
      } as never,
      { nodes: false, forwards: true },
    );
    expect(payload.items.map((item) => [item.id, item.reason_code])).toEqual([
      [1, "forward_apply_error"],
      [2, "runtime_revision_behind"],
      [3, "forward_pending_apply"],
    ]);
  });
});
