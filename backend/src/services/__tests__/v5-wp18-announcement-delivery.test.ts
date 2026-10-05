/**
 * V5-WP18.5 —— 公告投递接线（`services/announcement-delivery.ts`，契约 §12.3-D10/D11/D12）。
 *
 * 这份测试要钉住的三句话：
 *   A. **公告走的是同一条投递路径**：本模块自己不写账本、不发信、不重试 —— 全部委托给
 *      `deliverNotificationFacts`（源码级断言 + 行为断言各一条）。
 *   B. **显式传"本安装真正打开的渠道"**：未打开的渠道不参与投递，因此**不会**留下
 *      `not_configured` 噪音行（那是 Lead 点名的要求）。
 *   C. **每渠道一条配额**（`notificationCooldownKey` 带渠道，WP18.5 修的缺陷）：
 *      两个渠道必须都发出去、各留一行账本；否则"打开 webhook 会把 telegram 静音"而账本看不出来。
 *
 * 全部离线：注入内存账本 / 内存静默期 / 记录型渠道替身，不连 DB / Redis / SMTP。
 *
 * 跑法（backend 目录）：bun test src/services/__tests__/v5-wp18-announcement-delivery.test.ts
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { NOTIFICATION_REASON_CODES } from "../notification-facts.ts";
import {
  createEmailChannel,
  enabledNotificationChannels,
  type LedgerClaimResult,
  type NewNotificationDelivery,
  type NotificationChannel,
  type NotificationChannelKind,
  type NotificationCooldownStore,
  type NotificationDeliveryPatch,
  type NotificationLedgerStore,
  type RenderedNotification,
} from "../notification-delivery.ts";
import {
  cooldownSecondsForReason,
  notificationDedupeKey,
  notificationWindowStartMs,
  platformNotificationScope,
  workspaceNotificationScope,
} from "../notification-facts.ts";
import {
  ANNOUNCEMENT_CHANNEL_KINDS,
  ANNOUNCEMENT_NOTIFICATION_REASON_CODES,
  ANNOUNCEMENT_RECIPIENT_MAX,
  announcementChannels,
  announcementDeliverable,
  deliverAnnouncement,
  deliverAnnouncementOnPublish,
  platformAnnouncementAudience,
  renderAnnouncementDelivery,
  workspaceAnnouncementAudience,
  type AnnouncementPublishDb,
  type AnnouncementRecipient,
} from "../announcement-delivery.ts";
import type { NotificationMute } from "../announcement-mute.ts";

/* ================================================================== */
/* 替身：账本 / 静默期 / 渠道                                          */
/* ================================================================== */

interface LedgerRow extends NewNotificationDelivery {
  id: number;
  settled: NotificationDeliveryPatch | null;
}

function memoryLedger() {
  const rows: LedgerRow[] = [];
  let nextId = 1;
  const store: NotificationLedgerStore = {
    async claim(row): Promise<LedgerClaimResult> {
      if (rows.some((r) => r.dedupe_key === row.dedupe_key && r.channel_kind === row.channel_kind)) {
        return { ok: false, duplicate: true };
      }
      rows.push({ ...row, id: nextId++, settled: null });
      return { ok: true, id: nextId - 1 };
    },
    async settle(id, patch) {
      const row = rows.find((r) => r.id === id);
      if (row) row.settled = patch;
    },
  };
  return { store, rows };
}

function memoryCooldown() {
  const keys = new Map<string, number>();
  const store: NotificationCooldownStore = {
    async acquire(key, ttlSeconds) {
      const now = Date.now();
      const expiresAt = keys.get(key);
      if (expiresAt !== undefined && expiresAt > now) return false;
      keys.set(key, now + ttlSeconds * 1_000);
      return true;
    },
  };
  return { store, keys };
}

/** 记录型 email 渠道（走既有注入口，不是第二份发信实现）。 */
function recordingEmail() {
  const sent: string[] = [];
  const channel: NotificationChannel = createEmailChannel({
    configured: () => true,
    send: async (message) => {
      sent.push(message.to);
      return { sent: true };
    },
  });
  return { channel, sent };
}

/** telegram 替身（只实现接口；真实实现在 `notification-telegram.ts`）。 */
function fakeTelegram() {
  const sent: string[] = [];
  const channel: NotificationChannel = {
    kind: "telegram",
    isConfigured: () => true,
    validateConfig: (input) => (typeof input.target === "string" && /^-?\d+$/.test(input.target) ? { ok: true } : { ok: false, reason: "rejected_target" }),
    async send(_rendered: RenderedNotification, target: string) {
      sent.push(target);
      return { sent: true };
    },
  };
  return { channel, sent };
}

function fakeChannel(kind: NotificationChannelKind, configured = true, throws = false): NotificationChannel {
  return {
    kind,
    isConfigured: () => {
      if (throws) throw new Error("cannot tell");
      return configured;
    },
    validateConfig: () => ({ ok: true }),
    async send() {
      return { sent: true };
    },
  };
}

const ROW = {
  id: 42,
  type: "normal",
  title: "维护通知",
  body: "今晚 22:00 起维护十分钟。",
  published_at: new Date("2026-01-02T03:04:05.000Z"),
};

const RECIPIENTS: AnnouncementRecipient[] = [
  { user_id: 1, email: "a@example.com", tg_id: "1001" },
  { user_id: 2, email: "b@example.com", tg_id: null },
  { user_id: 3, email: null, tg_id: "3003" },
];

/* ================================================================== */
/* A. 可投递形状（纯）                                                 */
/* ================================================================== */

describe("A. 公告 → 可投递形状（纯函数，DoD1 的同一纪律）", () => {
  test("同一输入两次构造逐字段一致（含幂等键）", () => {
    const scope = workspaceNotificationScope(7);
    const first = announcementDeliverable(ROW, scope);
    const second = announcementDeliverable(ROW, scope);
    expect(first).toEqual(second);
    expect(first.dedupe_key).toMatch(/^[0-9a-f]{64}$/);
    expect(first.source_kind).toBe("announcement");
    expect(first.source_id).toBe("42");
    expect(first.reason_code).toBe("announcement_published");
    // 公告不是告警：严重度固定 info，不另造一份严重度词表。
    expect(first.severity).toBe("info");
    // 静默期走"其余 30 分钟"那一档（不新造时长常量）。
    expect(new Date(first.window_start).getTime()).toBe(
      Math.floor(ROW.published_at.getTime() / 1_800_000) * 1_800_000,
    );
    expect(first.window_start).not.toBe(first.occurred_at);
  });

  test("幂等键与 attention 派生用**同一套算法**（换实现 = 同一件事两个键）", () => {
    const scope = platformNotificationScope();
    const deliverable = announcementDeliverable(ROW, scope);
    // 手算一遍同源算法：与 `notificationDedupeKey` 的组成（五段 + JSON 规范化）一致。
    expect(deliverable.dedupe_key).toBe(
      notificationDedupeKey({
        scope,
        source_kind: "announcement",
        source_id: "42",
        reason_code: "announcement_published",
        window_start_ms: notificationWindowStartMs(
          ROW.published_at.getTime(),
          cooldownSecondsForReason("announcement_published"),
        ),
      }),
    );
  });

  test("公告的原因码**不在** attention 的词表里（D1 裁决 (b) 的可断言形式）", () => {
    for (const code of ANNOUNCEMENT_NOTIFICATION_REASON_CODES) {
      expect(NOTIFICATION_REASON_CODES as readonly string[]).not.toContain(code);
    }
  });

  test("`published_at` 收 Date 与 ISO 串都得到同一结果；坏日期抛错（调用方的编程错误）", () => {
    const scope = workspaceNotificationScope(7);
    const fromDate = announcementDeliverable(ROW, scope);
    const fromIso = announcementDeliverable({ ...ROW, published_at: ROW.published_at.toISOString() }, scope);
    expect(fromIso).toEqual(fromDate);
    expect(() => announcementDeliverable({ ...ROW, published_at: "not-a-date" }, scope)).toThrow();
  });

  test("渲染是纯文本：标题与正文原样出现，不新增 HTML 包装", () => {
    const rendered = renderAnnouncementDelivery(
      announcementDeliverable({ ...ROW, body: "<b>加粗</b>" }, workspaceNotificationScope(7)),
    );
    expect(rendered.subject).toBe("[TuneX][公告] 维护通知");
    expect(rendered.text).toContain("<b>加粗</b>");
    expect(rendered.text).not.toContain("<p>");
    expect(rendered.text.length).toBeLessThanOrEqual(4_000);
  });
});

/* ================================================================== */
/* B. 渠道：显式传"本安装真正打开的渠道"                                */
/* ================================================================== */

describe("B. 渠道选择：未打开的渠道不参与投递（不留 not_configured 噪音）", () => {
  test("`enabledNotificationChannels` 只保留已配置的渠道；判定抛错按「没打开」处理（fail-closed）", () => {
    const kept = enabledNotificationChannels([
      fakeChannel("email", true),
      fakeChannel("webhook", false),
      fakeChannel("telegram", true, true),
    ]);
    expect(kept.map((c) => c.kind)).toEqual(["email"]);
  });

  test("公告只走「给人」的渠道：webhook 被排除（它是机器通道，套用户偏好没有意义）", () => {
    expect(ANNOUNCEMENT_CHANNEL_KINDS as readonly string[]).toEqual(["email", "telegram"]);
    const channels = announcementChannels([
      fakeChannel("email"),
      fakeChannel("webhook"),
      fakeChannel("telegram"),
    ]);
    expect(channels.map((c) => c.kind)).toEqual(["email", "telegram"]);
  });

  test("一个渠道都没打开 → 不投递、**零账本行**、留一句告警（不制造 not_configured 噪音）", async () => {
    const ledger = memoryLedger();
    const warnings: string[] = [];
    const outcomes = await deliverAnnouncement(
      { ledger: ledger.store, channels: [], onWarn: (m) => warnings.push(m) },
      { row: ROW, scope: workspaceNotificationScope(7), recipients: RECIPIENTS, mutes: new Map() },
    );
    expect(outcomes).toEqual([]);
    expect(ledger.rows.length).toBe(0);
    expect(warnings.join("\n")).toContain("没有打开任何公告渠道");
  });

  test("受众为空 → 不投递、零账本行、留告警", async () => {
    const ledger = memoryLedger();
    const warnings: string[] = [];
    const outcomes = await deliverAnnouncement(
      { ledger: ledger.store, channels: [fakeChannel("email")], onWarn: (m) => warnings.push(m) },
      { row: ROW, scope: workspaceNotificationScope(7), recipients: [], mutes: new Map() },
    );
    expect(outcomes).toEqual([]);
    expect(ledger.rows.length).toBe(0);
    expect(warnings.join("\n")).toContain("受众为空");
  });
});

/* ================================================================== */
/* C. 同一本账本 + 同一套判据（含每渠道一条配额）                        */
/* ================================================================== */

describe("C. 同一本账本、同一套静默期与免打扰判据", () => {
  test("两个渠道各发一次、各留一行账本（每渠道一条配额）", async () => {
    const ledger = memoryLedger();
    const cooldown = memoryCooldown();
    const email = recordingEmail();
    const telegram = fakeTelegram();

    const outcomes = await deliverAnnouncement(
      { ledger: ledger.store, cooldown: cooldown.store, channels: [email.channel, telegram.channel] },
      { row: ROW, scope: workspaceNotificationScope(7), recipients: RECIPIENTS, mutes: new Map() },
    );

    expect(outcomes.map((o) => `${o.channel_kind}:${o.status}`)).toEqual(["email:sent", "telegram:sent"]);
    // email 只发给有邮箱的两个人；telegram 只发给绑定了 tg_id 的两个人（未绑定者自然没有目标）。
    expect(email.sent.sort()).toEqual(["a@example.com", "b@example.com"]);
    expect(telegram.sent.sort()).toEqual(["1001", "3003"]);
    const byChannel = ledger.rows.map((r) => r.channel_kind).sort();
    expect(byChannel).toEqual(["email", "telegram"]);
    expect(ledger.rows.every((r) => r.settled?.status === "sent")).toBe(true);
    // 账本里落的来源是公告表本身（F8-B：每条投递都指回一张既有表）。
    expect(ledger.rows.every((r) => r.source_kind === "announcement" && r.source_id === "42")).toBe(true);
  });

  test("免打扰按 (用户 × 渠道 × 类别) 生效：静音 email 的人不上邮件，telegram 照发", async () => {
    const ledger = memoryLedger();
    const email = recordingEmail();
    const telegram = fakeTelegram();
    const mutes = new Map<number, readonly NotificationMute[]>([
      [1, [{ channel_kind: "email", category: "announcement" }]],
    ]);

    await deliverAnnouncement(
      { ledger: ledger.store, cooldown: memoryCooldown().store, channels: [email.channel, telegram.channel] },
      { row: ROW, scope: workspaceNotificationScope(7), recipients: RECIPIENTS, mutes },
    );

    expect(email.sent).toEqual(["b@example.com"]);
    expect(telegram.sent.sort()).toEqual(["1001", "3003"]);
  });

  test("静默期仍然生效：同一公告二次投递是 suppressed，不新增账本行、不重发", async () => {
    const ledger = memoryLedger();
    const cooldown = memoryCooldown();
    const email = recordingEmail();
    const deps = { ledger: ledger.store, cooldown: cooldown.store, channels: [email.channel] };
    const input = { row: ROW, scope: workspaceNotificationScope(7), recipients: RECIPIENTS, mutes: new Map() };

    await deliverAnnouncement(deps, input);
    const second = await deliverAnnouncement(deps, input);

    expect(second[0]!.status).toBe("suppressed");
    expect(ledger.rows.length).toBe(1);
    expect(email.sent.length).toBe(2);
  });

  test("源码级断言：本模块**没有**第二条投递路径（不自己发信、不自己写账本、不自己重试）", () => {
    const src = readFileSync(new URL("../announcement-delivery.ts", import.meta.url), "utf8");
    // 不直接调渠道发信：投递只有 `deliverNotificationFacts` 一条路。
    expect(src).not.toMatch(/\.send\(/);
    // 不自己写账本：账本只用注入的 store（由 18.2 的实现占有）。
    expect(src).not.toMatch(/notificationDelivery\s*\.\s*(create|update)/);
    expect(src).not.toMatch(/ledger\.(claim|settle)/);
    // 不自己实现退避/重试。
    expect(src).not.toMatch(/setTimeout|sleep\s*\(/);
    // 不自己生成静默期键（复用 notification-facts 的那一个）。
    expect(src).not.toMatch(/scopedKey|RedisKeys/);
    // 而它确实用了唯一那条路。
    expect(src).toMatch(/deliverNotificationFacts\(/);
  });
});

/* ================================================================== */
/* D. 受众：读侧可见受众（F6.2 的同一口径）                              */
/* ================================================================== */

/** 记下每次用户查询的 where：受众口径（只看 active）是**查询条件**，所以要断言条件本身。 */
const userQueries: Array<Record<string, unknown>> = [];

function audienceDb(over: {
  users?: Array<{ id: number; email: string | null; tg_id: string | null }>;
  members?: Array<{ user_id: number }>;
  fail?: "user" | "member";
}) {
  const db: AnnouncementPublishDb = {
    user: {
      async findMany(args) {
        if (over.fail === "user") throw new Error("db down");
        userQueries.push(args.where as Record<string, unknown>);
        const where = args.where as { id?: { in: number[] } };
        let rows = over.users ?? [];
        if (where.id?.in) {
          const ids = where.id.in;
          rows = rows.filter((u) => ids.includes(u.id));
        }
        return rows;
      },
    },
    workspaceMember: {
      async findMany() {
        if (over.fail === "member") throw new Error("db down");
        return over.members ?? [];
      },
    },
    notificationMute: {
      async findMany() {
        return [];
      },
      async deleteMany() {
        return {};
      },
      async createMany() {
        return {};
      },
    },
  };
  return db;
}

describe("D. 受众 = 读侧可见受众", () => {
  test("平台公告：全体活跃用户（查询条件写明 `status=active`），空邮箱/空 tg_id 不猜", async () => {
    userQueries.length = 0;
    const db = audienceDb({
      users: [
        { id: 1, email: "a@example.com", tg_id: "1001" },
        { id: 2, email: "  ", tg_id: null },
      ],
    });
    const result = await platformAnnouncementAudience(db);
    expect(result.ok && result.recipients).toEqual([
      { user_id: 1, email: "a@example.com", tg_id: "1001" },
      { user_id: 2, email: null, tg_id: null },
    ]);
    // 口径是**查询条件**（不是内存过滤）：停用账号不该收到广播。
    expect(userQueries[0]).toMatchObject({ status: "active" });
  });

  test("租户公告：该 workspace 的活跃成员 ∩ 用户仍 active", async () => {
    const db = audienceDb({
      members: [{ user_id: 1 }, { user_id: 2 }],
      users: [{ id: 2, email: "b@example.com", tg_id: null }],
    });
    const result = await workspaceAnnouncementAudience(db, 7);
    expect(result.ok && result.recipients).toEqual([{ user_id: 2, email: "b@example.com", tg_id: null }]);
  });

  test("受众超过上限 → `audience_too_large`（不截断：截断会把「发了」变成「发了一半」）", async () => {
    const many = Array.from({ length: ANNOUNCEMENT_RECIPIENT_MAX + 1 }, (_, i) => ({
      id: i + 1,
      email: `u${i + 1}@example.com`,
      tg_id: null,
    }));
    const result = await platformAnnouncementAudience(audienceDb({ users: many }));
    expect(result).toEqual({ ok: false, reason: "audience_too_large" });
  });

  test("存储不可用 → storage_error（不抛出）", async () => {
    expect(await platformAnnouncementAudience(audienceDb({ fail: "user" }))).toEqual({
      ok: false,
      reason: "storage_error",
    });
    expect(await workspaceAnnouncementAudience(audienceDb({ fail: "member" }), 7)).toEqual({
      ok: false,
      reason: "storage_error",
    });
  });
});

/* ================================================================== */
/* E. 发布后的投递入口（fire-and-forget，永不抛出）                      */
/* ================================================================== */

describe("E. 发布后的投递入口", () => {
  test("受众超限 ⇒ 不投递 + 一句告警（公告仍站内可见）", async () => {
    const warnings: string[] = [];
    const many = Array.from({ length: ANNOUNCEMENT_RECIPIENT_MAX + 1 }, (_, i) => ({
      id: i + 1,
      email: `u${i + 1}@example.com`,
      tg_id: null,
    }));
    const outcomes = await deliverAnnouncementOnPublish(audienceDb({ users: many }), {
      row: ROW,
      scope: platformNotificationScope(),
      onWarn: (m) => warnings.push(m),
    });
    expect(outcomes).toEqual([]);
    expect(warnings.join("\n")).toContain("audience_too_large");
  });

  test("入口永不抛出（db 全挂也只是告警）", async () => {
    const warnings: string[] = [];
    const outcomes = await deliverAnnouncementOnPublish(audienceDb({ fail: "user" }), {
      row: ROW,
      scope: platformNotificationScope(),
      onWarn: (m) => warnings.push(m),
    });
    expect(outcomes).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("免打扰读不到 ⇒ 按「没人静音」继续照发（O2 的 fail 方向：抑制失效应当多报）", async () => {
    const db = audienceDb({ users: [{ id: 1, email: "a@example.com", tg_id: null }] });
    db.notificationMute.findMany = async () => {
      throw new Error("mute store down");
    };
    const ledger = memoryLedger();
    const email = recordingEmail();
    const warnings: string[] = [];

    // 注入渠道/账本，让这条断言真正跑完投递（生产调用点不传第三个参数）。
    const outcomes = await deliverAnnouncementOnPublish(
      db,
      { row: ROW, scope: platformNotificationScope(), onWarn: (m) => warnings.push(m) },
      { ledger: ledger.store, cooldown: memoryCooldown().store, channels: [email.channel] },
    );

    // 关键：免打扰**读不到**不等于「全都静音」—— 照发（一次存储抖动不该静默吞掉一次广播）。
    expect(outcomes.map((o) => o.status)).toEqual(["sent"]);
    expect(email.sent).toEqual(["a@example.com"]);
    expect(warnings.join("\n")).toContain("按「没人静音」继续");
  });
});
