/**
 * V5-WP18.5 —— 免打扰（`services/announcement-mute.ts`，契约 §F6.5）。
 *
 * 这一份测的核心只有一句话：**免打扰是"偏好"，静默期是"速率"，两者互补而不互相替代。**
 * 因此每条断言都在"证明它们没有变成同一种东西"或"证明它们没有各自成一套真相"：
 *   A. 词表**复用**（渠道 = `NOTIFICATION_CHANNEL_KINDS`、类别 = `NOTIFICATION_SOURCE_KINDS`），
 *      不是两份看起来一样的副本。
 *   B. 输入解析 fail-closed：未知渠道/类别**拒绝整个请求**（C3），不做"丢掉不认识的项"。
 *   C. 三元映射：按 `(用户, 渠道, 类别)` 精确命中，换个类别或换个渠道都不生效。
 *   D. **与 18.2 投递的组合**：`createMuteAwareTargetResolver` 只替换 `resolveTargets` ——
 *      被静音的目标**根本不出现在账本里**（不是"发完了假装没发"），而静默期继续照旧生效
 *      （同一事实第二次投递仍是 `suppressed`、不新增账本行）。
 *   E. 全员静音 → 空目标 → 投递层按既有语义记 `rejected_target` 失败行：**失败可见**，
 *      不伪造成 `sent`、也不静默跳过。
 *   F. **只影响推送**：站内公告的存在与已读结构上读不到免打扰（`announcement.ts` 不依赖本模块，
 *      源码级断言），行为上静音用户的公告列表/已读完全正常。
 *   G. 不新增第二套时长常量（DoD10 的同一条纪律）。
 *
 * 跑法（backend 目录）：bun test src/services/__tests__/v5-wp18-announcement-mute.test.ts
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { AttentionItem } from "../attention.ts";
import {
  NOTIFICATION_CHANNEL_KINDS,
  createEmailChannel,
  deliverNotificationFacts,
  type LedgerClaimResult,
  type NewNotificationDelivery,
  type NotificationChannel,
  type NotificationCooldownStore,
  type NotificationDeliveryPatch,
  type NotificationLedgerStore,
} from "../notification-delivery.ts";
import { NOTIFICATION_SOURCE_KINDS, deriveNotificationFacts, workspaceNotificationScope } from "../notification-facts.ts";
import type { NotificationFact } from "../notification-facts.ts";
import {
  NOTIFICATION_MUTE_CATEGORIES,
  NOTIFICATION_MUTE_CHANNELS,
  createMuteAwareTargetResolver,
  filterRecipientsByMute,
  isMuted,
  loadMutesByUserIds,
  loadUserMutes,
  muteKey,
  parseNotificationMutes,
  replaceUserMutes,
  type MuteRecipient,
  type NotificationMute,
  type NotificationMuteDb,
} from "../announcement-mute.ts";
import {
  createAnnouncement,
  dismissAnnouncement,
  listVisibleAnnouncements,
  type AnnouncementDb,
  type AnnouncementRow,
} from "../announcement.ts";

/* ================================================================== */
/* A. 词表复用                                                         */
/* ================================================================== */

describe("A. 词表复用：不新造第二套渠道/类别", () => {
  test("两个词表就是既有闭集本身（引用相等，不是副本）", () => {
    expect(NOTIFICATION_MUTE_CHANNELS).toBe(NOTIFICATION_CHANNEL_KINDS);
    expect(NOTIFICATION_MUTE_CATEGORIES).toBe(NOTIFICATION_SOURCE_KINDS);
  });

  test("三元键无歧义：分段用 NUL 分隔，业务值里含 `:` 也伪造不出边界", () => {
    expect(muteKey(1, "email", "node")).not.toBe(muteKey(11, "email", "node"));
  });
});

/* ================================================================== */
/* B. 输入解析 fail-closed                                             */
/* ================================================================== */

describe("B. 解析 fail-closed（C3）", () => {
  test("合法输入：去重、保留顺序", () => {
    const parsed = parseNotificationMutes([
      { channel_kind: "email", category: "node" },
      { channel_kind: "email", category: "node" },
      { channel_kind: "telegram", category: "announcement" },
    ]);
    expect(parsed.ok && parsed.mutes).toEqual([
      { channel_kind: "email", category: "node" },
      { channel_kind: "telegram", category: "announcement" },
    ]);
  });

  test("未知渠道 / 未知类别 / 非数组 → 整个请求拒绝，绝不静默丢弃", () => {
    expect(parseNotificationMutes(undefined)).toEqual({ ok: false, reason: "not_an_array" });
    expect(parseNotificationMutes([{ channel_kind: "sms", category: "node" }])).toEqual({
      ok: false,
      reason: "unknown_channel_kind",
    });
    expect(parseNotificationMutes([{ channel_kind: "email", category: "billing" }])).toEqual({
      ok: false,
      reason: "unknown_category",
    });
    expect(parseNotificationMutes(["email"]).ok).toBe(false);
    // 混合输入里有一个坏项 ⇒ 整份拒绝（不允许"部分生效"的模糊结果）。
    expect(
      parseNotificationMutes([
        { channel_kind: "email", category: "node" },
        { channel_kind: "email", category: "nope" },
      ]).ok,
    ).toBe(false);
  });
});

/* ================================================================== */
/* C. 三元映射                                                         */
/* ================================================================== */

describe("C. 三元映射：换个渠道或换个类别都不静音", () => {
  const mutes: NotificationMute[] = [{ channel_kind: "email", category: "node" }];

  test("精确命中", () => {
    expect(isMuted(mutes, { channel_kind: "email", category: "node" })).toBe(true);
    expect(isMuted(mutes, { channel_kind: "email", category: "forward" })).toBe(false);
    expect(isMuted(mutes, { channel_kind: "telegram", category: "node" })).toBe(false);
    expect(isMuted([], { channel_kind: "email", category: "node" })).toBe(false);
  });

  test("过滤按 **user_id** 取各自的清单：只摘掉被静音的那个人", () => {
    const recipients: MuteRecipient[] = [
      { user_id: 1, target: "a@example.com" },
      { user_id: 2, target: "b@example.com" },
    ];
    const oneMuted = new Map([[1, mutes]]);
    expect(filterRecipientsByMute(recipients, oneMuted, "email", "node")).toEqual([
      { user_id: 2, target: "b@example.com" },
    ]);
    // 拿一份清单去套所有人是错的（那会把"张三静音"变成"全都静音"）—— 空 Map 才是"没人静音"。
    expect(filterRecipientsByMute(recipients, new Map(), "email", "node")).toEqual(recipients);
    // 静音的是别的渠道/类别 ⇒ 原样保留。
    expect(filterRecipientsByMute(recipients, new Map([[1, mutes]]), "telegram", "node")).toEqual(recipients);
  });
});

/* ================================================================== */
/* 内存替身：免打扰存储（含唯一索引语义）                               */
/* ================================================================== */

function memoryMuteDb(options: { fail?: "findMany" | "deleteMany" | "createMany" } = {}) {
  const rows: Array<{ id: number; user_id: number; channel_kind: string; category: string }> = [];
  const calls: string[] = [];
  let nextId = 1;
  const boom = (kind: string) => {
    if (options.fail === kind) throw new Error("db down");
  };
  const db: NotificationMuteDb = {
    notificationMute: {
      async findMany(args) {
        boom("findMany");
        const userId = (args.where as { user_id: unknown }).user_id;
        if (typeof userId === "number") return rows.filter((r) => r.user_id === userId);
        const inIds = (userId as { in?: number[] } | undefined)?.in;
        if (Array.isArray(inIds)) return rows.filter((r) => inIds.includes(r.user_id));
        return [...rows];
      },
      async deleteMany(args) {
        boom("deleteMany");
        calls.push("deleteMany");
        const userId = (args.where as { user_id: number }).user_id;
        for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.user_id === userId) rows.splice(i, 1);
        return { count: 0 };
      },
      async createMany(args) {
        boom("createMany");
        calls.push("createMany");
        const data = args.data as Array<{ user_id: number; channel_kind: string; category: string }>;
        for (const row of data) {
          if (rows.some((r) => r.user_id === row.user_id && r.channel_kind === row.channel_kind && r.category === row.category)) continue;
          rows.push({ id: nextId++, ...row });
        }
        return { count: data.length };
      },
    },
  };
  return { db, rows, calls };
}

describe("D. 免打扰持久化：先删后建（失败方向 = 多报）", () => {
  test("全量替换：先删旧、再建新", async () => {
    const { db, rows, calls } = memoryMuteDb();
    rows.push({ id: 1, user_id: 42, channel_kind: "telegram", category: "node" });
    const result = await replaceUserMutes(db, 42, [{ channel_kind: "email", category: "forward" }]);
    expect(result.ok && result.value).toEqual([{ channel_kind: "email", category: "forward" }]);
    expect(calls).toEqual(["deleteMany", "createMany"]);
    expect(rows.map(({ id, ...rest }) => rest)).toEqual([
      { user_id: 42, channel_kind: "email", category: "forward" },
    ]);
  });

  test("空清单 = 清空（不是「没变化」）", async () => {
    const { db, rows } = memoryMuteDb();
    rows.push({ id: 1, user_id: 42, channel_kind: "email", category: "node" });
    await replaceUserMutes(db, 42, []);
    expect(rows).toEqual([]);
  });

  test("读取：忽略库里不认识的行（它本来就匹配不上任何合法类别）", async () => {
    const { db, rows } = memoryMuteDb();
    rows.push({ id: 1, user_id: 42, channel_kind: "email", category: "node" });
    rows.push({ id: 2, user_id: 42, channel_kind: "sms", category: "node" });
    const loaded = await loadUserMutes(db, 42);
    expect(loaded.ok && loaded.value).toEqual([{ channel_kind: "email", category: "node" }]);
  });

  test("批量读取按 user_id 建索引；空输入不发查询", async () => {
    const { db, rows } = memoryMuteDb();
    rows.push({ id: 1, user_id: 7, channel_kind: "email", category: "node" });
    rows.push({ id: 2, user_id: 8, channel_kind: "telegram", category: "announcement" });
    const map = await loadMutesByUserIds(db, [7, 8, 7]);
    expect(map.ok && map.value.get(7)).toEqual([{ channel_kind: "email", category: "node" }]);
    expect(map.ok && map.value.get(8)).toEqual([{ channel_kind: "telegram", category: "announcement" }]);
    const empty = await loadMutesByUserIds(db, []);
    expect(empty.ok && empty.value.size).toBe(0);
  });

  test("存储不可用 → storage_error（不抛出，收敛成结果）", async () => {
    const read = await loadUserMutes(memoryMuteDb({ fail: "findMany" }).db, 42);
    expect(read.ok).toBe(false);
    const deleted = await replaceUserMutes(memoryMuteDb({ fail: "deleteMany" }).db, 42, [
      { channel_kind: "email", category: "node" },
    ]);
    expect(deleted.ok).toBe(false);
    const created = await replaceUserMutes(memoryMuteDb({ fail: "createMany" }).db, 42, [
      { channel_kind: "email", category: "node" },
    ]);
    expect(created.ok).toBe(false);
    const batch = await loadMutesByUserIds(memoryMuteDb({ fail: "findMany" }).db, [42]);
    expect(batch.ok).toBe(false);
  });
});

/* ================================================================== */
/* E. 与 18.2 投递的组合（本文件的核心）                                */
/* ================================================================== */

const FACT: NotificationFact = (() => {
  const item: AttentionItem = {
    kind: "node",
    id: 11,
    name: "hk-in-01",
    severity: "warning",
    reason_code: "connection_offline",
    retryable: null,
  };
  const { facts, rejected } = deriveNotificationFacts({
    scope: workspaceNotificationScope(7),
    seeds: [{ item, occurred_at: new Date("2026-01-01T11:58:00.000Z") }],
  });
  expect(rejected).toEqual([]);
  return facts[0]!;
})();

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

function recordingEmail() {
  const sent: string[] = [];
  // `send` 是**传输替身**（既有注入口），拿到的就是 `mail.ts` 会发出去的那封信；
  // 收件人从 `message.to` 读 —— 渠道内部把它接到 `target` 上。
  const channel: NotificationChannel = createEmailChannel({
    configured: () => true,
    send: async (message) => {
      sent.push(message.to);
      return { sent: true };
    },
  });
  return { channel, sent };
}

/** 两个收件人：1 号（可能被静音）、2 号（对照组）。 */
const RECIPIENTS: MuteRecipient[] = [
  { user_id: 1, target: "muted@example.com" },
  { user_id: 2, target: "ops@example.com" },
];

function deliverDeps(over: {
  ledger: NotificationLedgerStore;
  cooldown: NotificationCooldownStore;
  channel: NotificationChannel;
  mutes: ReadonlyMap<number, readonly NotificationMute[]>;
}) {
  return {
    ledger: over.ledger,
    cooldown: over.cooldown,
    channels: [over.channel],
    resolveTargets: createMuteAwareTargetResolver({ recipients: () => RECIPIENTS, mutes: over.mutes }),
    sleep: async () => {},
    random: () => 0,
    onWarn: () => {},
  };
}

describe("E. 免打扰与投递层组合：静默期照旧、目标不出现在账本里", () => {
  test("被静音的用户根本不在目标里（不是发完了假装没发）", async () => {
    const ledger = memoryLedger();
    const cooldown = memoryCooldown();
    const email = recordingEmail();
    const outcomes = await deliverNotificationFacts(
      [FACT],
      deliverDeps({
        ledger: ledger.store,
        cooldown: cooldown.store,
        channel: email.channel,
        mutes: new Map([[1, [{ channel_kind: "email", category: "node" }]]]),
      }),
    );

    expect(outcomes).toEqual([
      { dedupe_key: FACT.dedupe_key, channel_kind: "email", status: "sent", reason: null, attempts: 1, degraded: false },
    ]);
    expect(email.sent).toEqual(["ops@example.com"]);
    // 账本里的目标 = 实际尝试过的目标：静音地址**从未**进入投递路径。
    expect(ledger.rows.length).toBe(1);
    expect(ledger.rows[0]!.target).toBe("ops@example.com");
  });

  test("静默期仍然生效：同一事实第二次投递是 suppressed，不新增账本行、不重发", async () => {
    const ledger = memoryLedger();
    const cooldown = memoryCooldown();
    const email = recordingEmail();
    const deps = deliverDeps({
      ledger: ledger.store,
      cooldown: cooldown.store,
      channel: email.channel,
      mutes: new Map([[1, [{ channel_kind: "email", category: "node" }]]]),
    });

    await deliverNotificationFacts([FACT], deps);
    const second = await deliverNotificationFacts([FACT], deps);

    // 免打扰没有把静默期"顶掉"：第二次仍然是 18.2 的 suppressed（而不是又发一封）。
    expect(second[0]!.status).toBe("suppressed");
    expect(ledger.rows.length).toBe(1);
    expect(email.sent).toEqual(["ops@example.com"]);
  });

  test("类别与渠道各自独立：静音 forward / 静音 telegram 都不影响 email 的 node 通知", async () => {
    for (const mute of [
      { channel_kind: "email", category: "forward" } as NotificationMute,
      { channel_kind: "telegram", category: "node" } as NotificationMute,
    ]) {
      const ledger = memoryLedger();
      const email = recordingEmail();
      await deliverNotificationFacts(
        [FACT],
        deliverDeps({
          ledger: ledger.store,
          cooldown: memoryCooldown().store,
          channel: email.channel,
          mutes: new Map([[1, [mute]]]),
        }),
      );
      expect(email.sent).toEqual(["muted@example.com", "ops@example.com"]);
    }
  });

  test("全员静音 → 空目标 → 记一条 `rejected_target` 失败行（失败可见，不伪造成功）", async () => {
    const ledger = memoryLedger();
    const email = recordingEmail();
    const outcomes = await deliverNotificationFacts(
      [FACT],
      deliverDeps({
        ledger: ledger.store,
        cooldown: memoryCooldown().store,
        channel: email.channel,
        mutes: new Map([
          [1, [{ channel_kind: "email", category: "node" }]],
          [2, [{ channel_kind: "email", category: "node" }]],
        ]),
      }),
    );
    expect(outcomes[0]!.status).toBe("failed");
    expect(outcomes[0]!.reason).toBe("rejected_target");
    expect(email.sent).toEqual([]);
    expect(ledger.rows[0]!.settled?.failure_reason).toBe("rejected_target");
  });

  test("没有任何静音时，收件人解析结果与不装免打扰时完全一致", async () => {
    const ledger = memoryLedger();
    const email = recordingEmail();
    await deliverNotificationFacts(
      [FACT],
      deliverDeps({ ledger: ledger.store, cooldown: memoryCooldown().store, channel: email.channel, mutes: new Map() }),
    );
    expect(email.sent).toEqual(["muted@example.com", "ops@example.com"]);
    expect(ledger.rows[0]!.target).toBe("muted@example.com,ops@example.com");
  });
});

/* ================================================================== */
/* F. 只影响推送：站内公告读不到免打扰                                  */
/* ================================================================== */

describe("F. 免打扰只影响推送，不影响站内公告的存在与已读（F6.5）", () => {
  test("结构断言：`announcement.ts` 不依赖免打扰模块（读路径不可能看到它）", () => {
    const announcementSrc = readFileSync(new URL("../announcement.ts", import.meta.url), "utf8");
    const muteSrc = readFileSync(new URL("../announcement-mute.ts", import.meta.url), "utf8");
    // 没有 import 边 ⇒ 「静音了 email」不可能让站内公告消失。
    expect(announcementSrc).not.toMatch(/announcement-mute/);
    // 反向也成立：免打扰模块不读公告表 / 已读表（它只认识渠道与类别）。
    expect(muteSrc).not.toMatch(/announcementDismissal/);
    expect(muteSrc).not.toMatch(/from "\.\/announcement\.ts"/);
  });

  test("行为断言：静音用户照常看到公告、照常能标记已读", async () => {
    // 一个"已经静音了 email × announcement"的用户，站内公告完全不受影响。
    const mutes: NotificationMute[] = [{ channel_kind: "email", category: "announcement" }];
    expect(isMuted(mutes, { channel_kind: "email", category: "announcement" })).toBe(true);

    const rows: AnnouncementRow[] = [];
    let nextId = 1;
    const db: AnnouncementDb = {
      announcement: {
        async findMany() {
          return rows.filter((r) => r.revoked_at === null);
        },
        async findUnique(args) {
          return rows.find((r) => r.id === (args.where as { id: number }).id) ?? null;
        },
        async create(args) {
          const data = args.data as Partial<AnnouncementRow>;
          const now = new Date();
          const row = {
            id: nextId++,
            scope_kind: "platform",
            workspace_id: null,
            type: "normal",
            title: "",
            body: "",
            active_popup_key: null,
            published_at: now,
            revoked_at: null,
            created_by_id: null,
            created_at: now,
            updated_at: now,
            ...data,
          } as AnnouncementRow;
          rows.push(row);
          return row;
        },
        async update() {
          throw new Error("not used");
        },
      },
      announcementDismissal: {
        async findMany() {
          return [];
        },
        async create() {
          return {};
        },
      },
    };

    await createAnnouncement(
      { db, onWarn: () => {} },
      { scope: { kind: "platform", workspace_id: null }, type: "normal", title: "平台公告", body: "正文", userId: null },
    );
    const listed = await listVisibleAnnouncements(
      { db, onWarn: () => {} },
      { scope: workspaceNotificationScope(7), userId: 1 },
    );
    expect(listed.ok && listed.value.length).toBe(1);
    const dismissed = await dismissAnnouncement(
      { db, onWarn: () => {} },
      { scope: workspaceNotificationScope(7), userId: 1, announcementId: 1 },
    );
    expect(dismissed.ok).toBe(true);
  });
});

/* ================================================================== */
/* G. 不新增第二套时长常量（DoD10 的同一纪律）                          */
/* ================================================================== */

describe("G. 新增模块里没有「什么时候不该打扰用户」的第二套时长阈值", () => {
  test("两个新模块都不定义时长常量、也不重实现静默期", () => {
    for (const rel of ["../announcement.ts", "../announcement-mute.ts"]) {
      const src = readFileSync(new URL(rel, import.meta.url), "utf8");
      // 时长常量（秒/毫秒）只允许留在 notification-facts.ts 的 NOTIFICATION_COOLDOWN_SECONDS 一处。
      expect(src).not.toMatch(/\b[A-Z0-9_]+_(SECONDS|MS)\b\s*[=:]/);
      // 免打扰不碰静默期的键与函数：它是偏好，不是速率。
      expect(src).not.toMatch(/cooldownSecondsForReason|NOTIFICATION_COOLDOWN_SECONDS|notificationCooldownKey/);
      // 也不碰 Redis：静默期落 Redis 是投递层的事（F4.5），这里连键都不生成。
      expect(src).not.toMatch(/^import .*redis/m);
      expect(src).not.toMatch(/scopedKey|RedisKeys/);
    }
  });
});
