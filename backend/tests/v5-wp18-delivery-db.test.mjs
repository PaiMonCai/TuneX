/**
 * V5-WP18.7 —— DoD2 / DoD3 / DoD4 的**真实账本**半边（契约 §8 收口）。
 *
 * ── 这份测试与 18.2 单测的分工 ──
 * 18.2 的 `v5-wp18-delivery.test.ts` 用**内存账本替身**建模了唯一索引语义（快、离线、可断言行为）；
 * 这里跑的是**真的 MySQL、真的唯一索引、真的 Redis**，它回答单测回答不了的那个问题：
 * 「把同一事实并发投递 N 次，**库里**到底有几行」。契约 §8 把 DoD2 明确放在这一层。
 *
 * 覆盖：
 *   · DoD2 幂等：同一事实并发 N 次 → 账本**恰好 1 行**；且唯一索引**真的在库里**
 *     （`information_schema` 反查，不是"信代码里有 @@unique"）；换渠道 → 2 行（每渠道一条配额）。
 *   · DoD3 静默期：注入时钟 + **真 Redis**（`SET NX EX`）：窗口内二次派生不新增行、不重发；
 *     跨窗口（新的 `occurred_at` ⇒ 新的幂等键）新增一条。断言 `degraded=false`
 *     —— 否则这测试会在"Redis 其实连不上"时静默退化成内存去重而仍然全绿。
 *   · DoD4 fail-closed：未知渠道类型 / 解不开的密文 → 一律拒绝**并留失败行**（可见，不静默丢）；
 *     未知 source_kind / 缺 source_id → 连候选事实都不产生，自然不落账本。
 *
 * 需要真实依赖：`TUNEX_DB_TEST=1` + `DATABASE_URL` + `REDIS_URL`（无则整份跳过）。
 * 跑法（有 MySQL/Redis 的环境，或 Lead 的一次性容器）：
 *   TUNEX_DB_TEST=1 DATABASE_URL=... REDIS_URL=... node --experimental-transform-types --test tests/v5-wp18-delivery-db.test.mjs
 * （容器里没有 node 时用 `bun test tests/v5-wp18-delivery-db.test.mjs` —— 已验证 bun 能跑 node:test。）
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/db.ts";
import { redis } from "../src/redis.ts";
import {
  createEmailChannel,
  createPrismaLedgerStore,
  createRedisCooldownStore,
  deliverNotificationFacts,
} from "../src/services/notification-delivery.ts";
import {
  deriveNotificationFacts,
  notificationCooldownKey,
  workspaceNotificationScope,
} from "../src/services/notification-facts.ts";
import { createTelegramChannel } from "../src/services/notification-telegram.ts";

const ENABLED = process.env.TUNEX_DB_TEST === "1";
const LEDGER = createPrismaLedgerStore();
const CREATED_DEDUPE_KEYS = new Set();
const CREATED_COOLDOWN_KEYS = new Set();

const SCOPE = workspaceNotificationScope(9901);

after(async () => {
  // 只清**本文件造出来的**行与键（一次性 scratch 库上也无妨，但不留给下一个人猜）。
  if (CREATED_DEDUPE_KEYS.size > 0) {
    await db.notificationDelivery.deleteMany({ where: { dedupe_key: { in: [...CREATED_DEDUPE_KEYS] } } });
  }
  if (CREATED_COOLDOWN_KEYS.size > 0 && ENABLED) {
    try {
      await redis.del([...CREATED_COOLDOWN_KEYS]);
    } catch {
      /* Redis 不可用时忽略（跳过路径本来也没写键） */
    }
  }
  try {
    await redis.disconnect();
  } catch {
    /* ignore */
  }
  await db.$disconnect();
});

/** 派生一条**真实**事实（幂等键/时间窗由 18.1 的核心算，不由测试手写）。 */
function factAt(occurredAt) {
  const { facts, rejected } = deriveNotificationFacts({
    scope: SCOPE,
    seeds: [
      {
        item: {
          kind: "node",
          id: 9901,
          name: "wp18-db-node",
          severity: "warning",
          reason_code: "connection_offline",
          retryable: null,
        },
        occurred_at: occurredAt,
      },
    ],
  });
  assert.deepEqual(rejected, []);
  return facts[0];
}

/** 记录出站的渠道替身（**只有 email 用替身**；telegram 用真实现以覆盖 `secret_unreadable`）。 */
function recordingEmail() {
  const sent = [];
  const channel = createEmailChannel({
    configured: () => true,
    send: async (message) => {
      sent.push(message.to);
      return { sent: true };
    },
  });
  return { channel, sent };
}

function memoryCooldown(now) {
  const keys = new Map();
  const store = {
    async acquire(key, ttlSeconds) {
      const t = now();
      const expiresAt = keys.get(key);
      if (expiresAt !== undefined && expiresAt > t) return false;
      keys.set(key, t + ttlSeconds * 1_000);
      CREATED_COOLDOWN_KEYS.add(key);
      return true;
    },
  };
  return { store, keys };
}

/** 每个并发分支各拿一份"没被置位"的去重存储 ⇒ 让它们都走到账本抢占那一步。 */
const freshCooldown = () => {
  const store = {
    async acquire() {
      return true;
    },
  };
  return store;
};

const deps = (over = {}) => ({
  ledger: LEDGER,
  channels: [over.channel ?? recordingEmail().channel],
  // 按渠道给目标：telegram 要的是 chat id，给它邮箱地址会被 `validateConfig` 拒成 rejected_target
  // （这条一开始就写错了一次，正是"目标形状属于渠道"的现场演示）。
  resolveTargets: (_fact, channel) => (channel.kind === "telegram" ? ["1001"] : ["wp18@example.com"]),
  cooldown: over.cooldown ?? freshCooldown(),
  sleep: async () => {},
  random: () => 0,
  onWarn: () => {},
});

/** MySQL 8 的 information_schema 列名是大写，Prisma/Bun 可能原样返回 —— 两种都认。 */
function col(row, name) {
  return row[name] ?? row[name.toUpperCase()];
}

test("DoD2 -- 唯一索引真的在库里（不是「代码里有 @@unique」）", { skip: !ENABLED }, async () => {
  const rows = await db.$queryRawUnsafe(
    `SELECT index_name, column_name, non_unique, seq_in_index FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = 'notification_delivery'`,
  );
  const INDEX = "notification_delivery_dedupe_channel_key";
  assert.ok(rows.some((r) => col(r, "index_name") === INDEX), `缺少唯一索引：${INDEX}`);
  const parts = rows
    .filter((r) => col(r, "index_name") === INDEX)
    .sort((a, b) => Number(col(a, "seq_in_index")) - Number(col(b, "seq_in_index")));
  assert.equal(Number(col(parts[0], "non_unique")), 0, "该索引必须是 UNIQUE");
  // 唯一约束必须**带渠道**：否则"每渠道一条记录"会退化成"每事实一条"（WP18.5 修的缺陷）。
  assert.deepEqual(parts.map((r) => col(r, "column_name")), ["dedupe_key", "channel_kind"]);
});

test("DoD2 -- 同一事实并发投递 N 次，库里恰好 1 行", { skip: !ENABLED }, async () => {
  const fact = factAt(new Date("2026-02-01T10:00:00.000Z"));
  CREATED_DEDUPE_KEYS.add(fact.dedupe_key);
  const email = recordingEmail();

  const outcomes = await Promise.all(
    Array.from({ length: 5 }, () => deliverNotificationFacts([fact], deps({ channel: email.channel }))),
  );

  const flat = outcomes.map((o) => o[0].status);
  assert.equal(flat.filter((s) => s === "sent").length, 1, `只有一个能抢占成功：${flat}`);
  assert.equal(flat.filter((s) => s === "duplicate").length, 4, `其余是 duplicate：${flat}`);
  assert.equal(email.sent.length, 1, "只发一封");

  const rows = await db.notificationDelivery.findMany({ where: { dedupe_key: fact.dedupe_key } });
  assert.equal(rows.length, 1, "唯一索引兜底：同一 (dedupe_key, channel_kind) 只有一行");
  assert.equal(rows[0].status, "sent");
  assert.equal(rows[0].attempts, 1);
  assert.equal(rows[0].degraded, false);
});

test("DoD2 -- 同一事实、不同渠道 = 各一行（每渠道一条配额）", { skip: !ENABLED }, async () => {
  const fact = factAt(new Date("2026-02-01T11:00:00.000Z"));
  CREATED_DEDUPE_KEYS.add(fact.dedupe_key);
  const email = recordingEmail();
  const telegramSent = [];
  const telegram = createTelegramChannel({
    enabled: () => true,
    sealedToken: () => "not-a-real-sealed-token", // 形状不对 ⇒ 会在 send 时给出 secret_unreadable
    masterSecret: () => "x",
    transport: async (request) => {
      telegramSent.push(request.url);
      return { status: 200, json: { ok: true } };
    },
  });

  const outcomes = await deliverNotificationFacts([fact], deps({ channel: email.channel }));
  const outcomes2 = await deliverNotificationFacts([fact], {
    ...deps({ channel: telegram }),
    cooldown: freshCooldown(),
  });

  assert.equal(outcomes[0].status, "sent");
  // 第 2 个渠道**不该**被第 1 个渠道的静默期吞掉（这正是 WP18.5 修的缺陷的 DB 侧复现）。
  assert.notEqual(outcomes2[0].status, "suppressed", "换渠道必须重新投递，而不是 suppressed");
  const rows = await db.notificationDelivery.findMany({ where: { dedupe_key: fact.dedupe_key } });
  assert.deepEqual(rows.map((r) => r.channel_kind).sort(), ["email", "telegram"]);
});

test("DoD3 -- 真 Redis：窗口内二次派生不新增行，跨窗口新增一条", { skip: !ENABLED }, async () => {
  // 真实的 Redis `SET NX EX`（不是内存替身）——契约 F4.5 要的正是这个。
  const realCooldown = createRedisCooldownStore();
  const email = recordingEmail();
  const first = factAt(new Date("2026-02-01T12:00:00.000Z"));
  CREATED_DEDUPE_KEYS.add(first.dedupe_key);
  CREATED_COOLDOWN_KEYS.add(notificationCooldownKey(first, "email"));

  // 上一次运行的键可能还在（TTL = 静默期 5 分钟）：测试**不该依赖外部残留**，先清干净。
  await redis.del([notificationCooldownKey(first, "email")]);

  const one = await deliverNotificationFacts([first], { ...deps({ channel: email.channel }), cooldown: realCooldown });
  assert.equal(one[0].status, "sent");
  assert.equal(one[0].degraded, false, "degraded=true 说明 Redis 其实没连上，这条断言会立刻暴露");

  const two = await deliverNotificationFacts([first], { ...deps({ channel: email.channel }), cooldown: realCooldown });
  assert.equal(two[0].status, "suppressed");
  assert.equal(email.sent.length, 1, "静默期内不重发");
  let rows = await db.notificationDelivery.findMany({ where: { dedupe_key: first.dedupe_key } });
  assert.equal(rows.length, 1, "静默期内不新增账本行");

  // 真 Redis 的 TTL 是**真的**（`SET NX EX`）：键存在时它一定带剩余寿命，这是
  // "静默期落在 Redis 而不是进程内 Map"的可观察形式。
  const ttl = await redis.ttl(notificationCooldownKey(first, "email"));
  assert.ok(ttl > 0 && ttl <= 300, `静默期键必须带 TTL（实际 ${ttl}）`);

  // 跨窗口：新的 occurred_at 落在下一个时间窗 ⇒ 新的幂等键 ⇒ 新的一条。
  // 测试不能真的等 5 分钟，所以**显式模拟 TTL 到期**（删键 = Redis 自己到期的效果）；
  // "键还在时被拦下"已经由上面的 suppressed 一步证明了。
  await redis.del([notificationCooldownKey(first, "email")]);
  const later = factAt(new Date("2026-02-01T18:00:00.000Z"));
  assert.notEqual(later.dedupe_key, first.dedupe_key);
  CREATED_DEDUPE_KEYS.add(later.dedupe_key);
  CREATED_COOLDOWN_KEYS.add(notificationCooldownKey(later, "email"));
  const three = await deliverNotificationFacts([later], { ...deps({ channel: email.channel }), cooldown: realCooldown });
  assert.equal(three[0].status, "sent");
  rows = await db.notificationDelivery.findMany({ where: { dedupe_key: { in: [first.dedupe_key, later.dedupe_key] } } });
  assert.equal(rows.length, 2, "跨窗口后新增一条（旧行仍在：账本是证据，不改写）");
});

test("DoD3 -- 注入时钟的窗口边界：静默期内 suppressed、过期后同键仍受唯一索引保护", { skip: !ENABLED }, async () => {
  let now = Date.UTC(2026, 1, 1, 13, 0, 0);
  const cooldown = memoryCooldown(() => now);
  const email = recordingEmail();
  const fact = factAt(new Date(now));
  CREATED_DEDUPE_KEYS.add(fact.dedupe_key);

  const a = await deliverNotificationFacts([fact], { ...deps({ channel: email.channel }), cooldown: cooldown.store });
  assert.equal(a[0].status, "sent");
  // 时钟推进到静默期之外：静默期不再拦，但**幂等键相同** ⇒ 唯一索引兜住（不产生第二行、不重发）。
  now += 4 * 60 * 60 * 1_000;
  const b = await deliverNotificationFacts([fact], { ...deps({ channel: email.channel }), cooldown: cooldown.store });
  assert.equal(b[0].status, "duplicate");
  assert.equal(email.sent.length, 1);
  const rows = await db.notificationDelivery.findMany({ where: { dedupe_key: fact.dedupe_key } });
  assert.equal(rows.length, 1, "窗口过期 ≠ 可以重复投递同一幂等键");
});

test("DoD4 -- 未知渠道类型：拒绝 + 留失败行（可见，不静默丢）", { skip: !ENABLED }, async () => {
  const fact = factAt(new Date("2026-02-01T14:00:00.000Z"));
  CREATED_DEDUPE_KEYS.add(fact.dedupe_key);
  const bogusChannel = {
    kind: "sms",
    isConfigured: () => true,
    validateConfig: () => ({ ok: true }),
    send: async () => ({ sent: true }),
  };

  const outcomes = await deliverNotificationFacts([fact], deps({ channel: bogusChannel }));
  assert.equal(outcomes[0].status, "failed");
  assert.equal(outcomes[0].reason, "unsupported_channel");
  const rows = await db.notificationDelivery.findMany({ where: { dedupe_key: fact.dedupe_key } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "failed");
  assert.equal(rows[0].failure_reason, "unsupported_channel");
});

test("DoD4 -- 解不开的密文 = secret_unreadable（不是 not_configured，也不静默降级）", { skip: !ENABLED }, async () => {
  const fact = factAt(new Date("2026-02-01T15:00:00.000Z"));
  CREATED_DEDUPE_KEYS.add(fact.dedupe_key);
  const telegram = createTelegramChannel({
    enabled: () => true,
    sealedToken: () => "v1.bm90LWEtcmVhbC1jaXBoZXJ0ZXh0.bm90LXJlYWw=.bm90LXJlYWw=",
    masterSecret: () => "wrong-master-secret-32-bytes-long",
    transport: async () => {
      throw new Error("不该出站：密文解不开时零出站");
    },
  });

  const outcomes = await deliverNotificationFacts([fact], {
    ...deps({ channel: telegram }),
    resolveTargets: () => ["1001"],
  });
  assert.equal(outcomes[0].status, "failed");
  assert.equal(outcomes[0].reason, "secret_unreadable");
  const rows = await db.notificationDelivery.findMany({ where: { dedupe_key: fact.dedupe_key } });
  assert.equal(rows[0].failure_reason, "secret_unreadable", "密钥事故必须留下可排查的痕迹");
  assert.equal(rows[0].target, "1001");
});

test("DoD4 -- 未知 source_kind / 缺 source_id：连候选事实都不产生 ⇒ 不落账本", { skip: !ENABLED }, async () => {
  const before = await db.notificationDelivery.count();
  for (const item of [
    { kind: "not_a_source", id: 9902, name: "x", severity: "warning", reason_code: "connection_offline", retryable: null },
    { kind: "node", id: null, name: "x", severity: "warning", reason_code: "connection_offline", retryable: null },
    { kind: "node", id: 9903, name: "x", severity: "warning", reason_code: "invented_code", retryable: null },
  ]) {
    const { facts, rejected } = deriveNotificationFacts({ scope: SCOPE, seeds: [{ item, occurred_at: new Date() }] });
    assert.equal(facts.length, 0, "坏种子不得进候选集");
    assert.equal(rejected.length, 1);
  }
  assert.equal(await db.notificationDelivery.count(), before, "拒绝不产生投递行");
});
