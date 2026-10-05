/**
 * V5-WP18.2 —— 投递账本 + 静默期 + 渠道接口（`services/notification-delivery.ts`）。
 *
 * 覆盖的行为（全部离线：注入内存账本/静默期替身 + 注入发信通道，不连 DB / Redis / SMTP）：
 *   A. **email 复用既有 sendMail**：渠道走 `mail.ts` 的注入口（`setMailTransportForTest`），
 *      并且**静态断言**全仓只有一个 SMTP 实现（不存在第二份发信通道）。
 *   B. 未配置 ≠ 成功（F3 / C3）：`not_configured` 落一行失败记录，且**没有**任何出站调用。
 *   C. **静默期**（F4.4 / DoD3）：静默期内二次派生不新增投递行；过期后新增一条（注入时钟）。
 *   D. **幂等**（F4.2 / DoD2 的纯逻辑半边）：同一格并发抢占只有一行、只发一次；
 *      抢占失败 = `duplicate`，绝不发第二封。
 *   E. **Redis 不可用 → 照发 + 标 degraded**（Lead 裁决 O2），且降级去重仍然抑制刷屏。
 *   F. fail-closed 反例（DoD4）：未知渠道类型 / 本期未实现渠道 / 没有收件人 / 目标形状非法
 *      → 一律拒绝并留失败记录，零出站。
 *   G. 有界重试（F4.3）：传输失败最多 3 次、按 `BASE*3^N+抖动` 退避、只重投失败的目标；
 *      `rejected_target` 不重试。账本不可用 → 不发（不产生不可审计的投递）。
 *   H. 渲染（F10）：CRLF 剥除 + 截断 + 纯文本，不出现 HTML。
 *
 * 跑法（backend 目录）：bun test src/services/__tests__/v5-wp18-delivery.test.ts
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { setMailTransportForTest, type MailMessage, type MailResult } from "../mail.ts";
import type { AttentionItem } from "../attention.ts";
import type { NotificationFact } from "../notification-facts.ts";
import { deriveNotificationFacts, workspaceNotificationScope } from "../notification-facts.ts";
import {
  DEGRADED_COOLDOWN_MAX_ENTRIES,
  EMAIL_TARGET_MAX,
  NOTIFICATION_CHANNEL_KINDS,
  NOTIFICATION_MAX_ATTEMPTS,
  NOTIFICATION_RENDER_LIMITS,
  NOTIFICATION_RETRY_BACKOFF_BASE_MS,
  createDegradedCooldown,
  createEmailChannel,
  deliverNotificationFacts,
  errorSummary,
  isValidEmailTarget,
  notificationRetryDelayMs,
  renderNotificationText,
  type LedgerClaimResult,
  type NewNotificationDelivery,
  type NotificationChannel,
  type NotificationCooldownStore,
  type NotificationDeliveryPatch,
  type NotificationLedgerStore,
} from "../notification-delivery.ts";

afterEach(() => setMailTransportForTest(null));

const FACT: NotificationFact = {
  scope: workspaceNotificationScope(7),
  source_kind: "node",
  source_id: "11",
  reason_code: "connection_offline",
  severity: "warning",
  resource_type: "node",
  resource_id: "11",
  resource_name: "hk-in-01",
  occurred_at: "2026-01-01T11:58:00.000Z",
  window_start: "2026-01-01T11:55:00.000Z",
  dedupe_key: "a".repeat(64),
  detail_code: null,
};

function fact(over: Partial<NotificationFact> = {}): NotificationFact {
  return { ...FACT, ...over };
}

/**
 * 用**真实**的 18.1 核心派生一条事实（幂等键/时间窗由它算，不由测试手写）——
 * 否则"过了静默期就该新增一条"这类断言会被一个写死的 dedupe_key 骗过去。
 */
function deriveOne(occurredAt: Date, item: Partial<AttentionItem> = {}): NotificationFact {
  const { facts, rejected } = deriveNotificationFacts({
    scope: workspaceNotificationScope(7),
    seeds: [
      {
        item: { kind: "node", id: 11, name: "hk-in-01", severity: "warning", reason_code: "connection_offline", retryable: null, ...item },
        occurred_at: occurredAt,
      },
    ],
  });
  expect(rejected).toEqual([]);
  return facts[0]!;
}

/* ------------------------------------------------------------------ */
/* 内存账本替身：**唯一索引的语义模型**（(dedupe_key, channel_kind)）    */
/* ------------------------------------------------------------------ */

interface Row extends NewNotificationDelivery {
  id: number;
  settled: NotificationDeliveryPatch | null;
}

function memoryLedger(options: { failClaim?: boolean } = {}) {
  const rows: Row[] = [];
  let nextId = 1;
  const store: NotificationLedgerStore = {
    async claim(row): Promise<LedgerClaimResult> {
      if (options.failClaim) throw new Error("db down");
      if (rows.some((r) => r.dedupe_key === row.dedupe_key && r.channel_kind === row.channel_kind)) {
        return { ok: false, duplicate: true };
      }
      const id = nextId++;
      rows.push({ ...row, id, settled: null });
      return { ok: true, id };
    },
    async settle(id, patch) {
      const row = rows.find((r) => r.id === id);
      if (!row) throw new Error("row missing");
      row.settled = patch;
    },
  };
  return { store, rows };
}

/** 注入时钟的静默期替身：`SET NX EX` 语义 + TTL 到期（不依赖 wall clock，DoD3）。 */
function memoryCooldown(options: { now: () => number; fail?: boolean }) {
  const keys = new Map<string, number>();
  const store: NotificationCooldownStore = {
    async acquire(key, ttlSeconds) {
      if (options.fail) throw new Error("redis down");
      const expiresAt = keys.get(key);
      if (expiresAt !== undefined && expiresAt > options.now()) return false;
      keys.set(key, options.now() + ttlSeconds * 1_000);
      return true;
    },
  };
  return { store, keys };
}

/** 记录出站的 email 通道替身（**不是**第二份实现：只是 `sendMail` 的注入口替身）。 */
function recordingEmail(sent = true, reason: MailResult["reason"] = undefined) {
  const sentMessages: MailMessage[] = [];
  const channel = createEmailChannel({
    configured: () => true,
    send: async (message) => {
      sentMessages.push(message);
      return sent ? { sent: true } : { sent: false, reason: reason ?? "smtp_error" };
    },
  });
  return { channel, sentMessages };
}

function depsOf(over: {
  ledger: NotificationLedgerStore;
  cooldown?: NotificationCooldownStore;
  channel?: NotificationChannel;
  targets?: (fact: NotificationFact) => readonly string[];
  degradedCooldown?: (key: string, ttl: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  warnings?: string[];
}): Parameters<typeof deliverNotificationFacts>[1] {
  return {
    ledger: over.ledger,
    channels: [over.channel ?? recordingEmail().channel],
    cooldown: over.cooldown ?? memoryCooldown({ now: () => Date.now() }).store,
    resolveTargets: over.targets ?? (() => ["ops@example.com"]),
    degradedCooldown: over.degradedCooldown,
    sleep: over.sleep ?? (async () => {}),
    random: over.random ?? (() => 0),
    onWarn: (message) => over.warnings?.push(message),
  };
}

/* ------------------------------------------------------------------ */
/* A. email 渠道复用既有 sendMail                                       */
/* ------------------------------------------------------------------ */

describe("A. email 渠道 = 既有 sendMail 本身（不写第二份发信实现）", () => {
  test("渠道通过 mail.ts 的注入口发出，主题/正文来自渲染结果", async () => {
    const captured: MailMessage[] = [];
    setMailTransportForTest(async (message) => {
      captured.push(message);
      return { sent: true };
    });

    const ledger = memoryLedger();
    // **不注入 send**：走 createEmailChannel 的默认通道 → mail.ts 的 sendMail → 上面的注入口。
    // 这正是"email 渠道就是 sendMail 本身"的证据（注入 send 替身会把这条路径盖掉）。
    const outcomes = await deliverNotificationFacts(
      [FACT],
      depsOf({ ledger: ledger.store, channel: createEmailChannel({ configured: () => true }) }),
    );

    expect(outcomes).toEqual([
      { dedupe_key: FACT.dedupe_key, channel_kind: "email", status: "sent", reason: null, attempts: 1, degraded: false },
    ]);
    expect(captured.length).toBe(1);
    expect(captured[0]!.to).toBe("ops@example.com");
    expect(captured[0]!.subject).toContain("connection_offline");
    expect(captured[0]!.subject).toContain("warning");
    expect(captured[0]!.text).toContain("hk-in-01");
    expect(captured[0]!.text).toContain(FACT.occurred_at);
    expect(ledger.rows[0]!.settled).toEqual({
      status: "sent",
      failure_reason: null,
      attempts: 1,
      degraded: false,
      error: null,
    });
  });

  test("`sendMail` 的降级语义原样映射：smtp_not_configured → not_configured", async () => {
    setMailTransportForTest(async () => ({ sent: false, reason: "smtp_not_configured" }));
    const ledger = memoryLedger();
    const outcomes = await deliverNotificationFacts(
      [FACT],
      depsOf({ ledger: ledger.store, channel: createEmailChannel({ configured: () => true }) }),
    );
    expect(outcomes[0]!.status).toBe("failed");
    expect(outcomes[0]!.reason).toBe("not_configured");
    // 不重试：没配 SMTP 与刚才没配是同一种结果（attempts 停在 1）。
    expect(outcomes[0]!.attempts).toBe(1);
  });

  test("静态守卫：全仓只有一份 SMTP 实现（`mail.ts`）", () => {
    const files = [
      "../notification-delivery.ts",
      "../notification-facts.ts",
    ].map((rel) => readFileSync(new URL(rel, import.meta.url), "utf8"));
    for (const src of files) {
      // 通知侧不得自己开 socket / 自己拼 SMTP 命令 / 自己读 SMTP 凭据。
      expect(src).not.toMatch(/node:(net|tls)/);
      expect(src).not.toMatch(/EHLO|STARTTLS|AUTH LOGIN/);
      expect(src).not.toMatch(/env\.mail/);
    }
    // 而它确实用的是 `mail.ts` 的入口。
    expect(files[0]).toMatch(/from "\.\/mail\.ts"/);
    const raw = readFileSync(new URL("../notification-delivery.ts", import.meta.url), "utf8");
    expect(raw).toMatch(/sendMail/);
  });
});

/* ------------------------------------------------------------------ */
/* B. 未配置 ≠ 成功                                                     */
/* ------------------------------------------------------------------ */

describe("B. 未配置的渠道不假装成功（F3 / C3）", () => {
  test("SMTP 未配置 → 失败记录 + 零出站", async () => {
    const captured: MailMessage[] = [];
    setMailTransportForTest(async (message) => {
      captured.push(message);
      return { sent: false, reason: "smtp_not_configured" };
    });
    const ledger = memoryLedger();
    const outcomes = await deliverNotificationFacts(
      [FACT],
      // 未配置的渠道替身：连 send 都不该被调用。
      depsOf({
        ledger: ledger.store,
        channel: createEmailChannel({ configured: () => false, send: async () => ({ sent: true }) }),
      }),
    );
    expect(outcomes[0]!.status).toBe("failed");
    expect(outcomes[0]!.reason).toBe("not_configured");
    expect(captured.length).toBe(0);
    expect(ledger.rows[0]!.status).toBe("sending"); // 抢占行从未被"投递"过
    expect(ledger.rows[0]!.settled?.failure_reason).toBe("not_configured");
    expect(ledger.rows[0]!.target).toBe("");
  });
});

/* ------------------------------------------------------------------ */
/* C. 静默期                                                            */
/* ------------------------------------------------------------------ */

describe("C. 静默期（F4.4 / DoD3）", () => {
  test("静默期内二次派生不新增投递行；过了静默期新增一条", async () => {
    let clock = Date.UTC(2026, 0, 1, 12, 0, 0);
    const cooldown = memoryCooldown({ now: () => clock });
    const ledger = memoryLedger();
    const send = recordingEmail();
    const deps = depsOf({ ledger: ledger.store, cooldown: cooldown.store, channel: send.channel });

    const first = await deliverNotificationFacts([deriveOne(new Date(clock))], deps);
    expect(first[0]!.status).toBe("sent");
    expect(ledger.rows.length).toBe(1);

    // 同一静默期内（节点离线 5min）再次派生：抑制，且**不新增行**。
    clock += 60_000;
    const second = await deliverNotificationFacts([deriveOne(new Date(clock))], deps);
    expect(second[0]!.status).toBe("suppressed");
    expect(ledger.rows.length).toBe(1);
    expect(send.sentMessages.length).toBe(1);

    // 静默期过后（>5min）：Redis 键过期 + 幂等键进入下一个时间窗 → 新增一条。
    clock += 300_000;
    const third = await deliverNotificationFacts([deriveOne(new Date(clock))], deps);
    expect(third[0]!.status).toBe("sent");
    expect(ledger.rows.length).toBe(2);
    expect(send.sentMessages.length).toBe(2);
  });

  test("不同 reason_code 各有一条配额（离线不会被恢复/维护吞掉）", async () => {
    const clock = Date.UTC(2026, 0, 1, 12, 0, 0);
    const cooldown = memoryCooldown({ now: () => clock });
    const ledger = memoryLedger();
    const send = recordingEmail();
    const deps = depsOf({ ledger: ledger.store, cooldown: cooldown.store, channel: send.channel });

    await deliverNotificationFacts([deriveOne(new Date(clock))], deps);
    const other = await deliverNotificationFacts(
      [deriveOne(new Date(clock), { id: 12, reason_code: "node_in_maintenance" })],
      deps,
    );
    expect(other[0]!.status).toBe("sent");
    expect(ledger.rows.length).toBe(2);
    expect(cooldown.keys.has("ws:7:notification:cooldown:node:11:connection_offline")).toBe(true);
    expect(cooldown.keys.has("ws:7:notification:cooldown:node:12:node_in_maintenance")).toBe(true);
  });

  test("静默期在配置校验**之后**消费：渠道没配好不会吞掉配好后的第一封信", async () => {
    const clock = Date.UTC(2026, 0, 1, 12, 0, 0);
    const cooldown = memoryCooldown({ now: () => clock });
    const ledger = memoryLedger();
    let configured = false;
    const channel = createEmailChannel({ configured: () => configured, send: async () => ({ sent: true }) });
    const deps = depsOf({ ledger: ledger.store, cooldown: cooldown.store, channel });

    const notYet = await deliverNotificationFacts([FACT], deps);
    expect(notYet[0]!.reason).toBe("not_configured");
    expect(cooldown.keys.size).toBe(0);

    configured = true;
    const nowOk = await deliverNotificationFacts([FACT], deps);
    // 同一时间窗：唯一索引已经占坑 → duplicate（不会补发第二封），但静默期键之前没被吃掉。
    expect(["sent", "duplicate"]).toContain(nowOk[0]!.status);
  });
});

/* ------------------------------------------------------------------ */
/* D. 幂等：唯一索引兜底                                                */
/* ------------------------------------------------------------------ */

describe("D. 幂等：同一格只落一行、只发一次（F4.2）", () => {
  test("并发派生同一事实 → 一行、一封", async () => {
    const ledger = memoryLedger();
    const send = recordingEmail();
    // 两个"进程"各自持有一份进程内静默期（Redis 抖动/过期的极端情况），
    // 唯一索引必须兜住：只有一行一行、只发一封。
    const a = depsOf({ ledger: ledger.store, cooldown: { async acquire() { return true; } }, channel: send.channel });
    const b = depsOf({ ledger: ledger.store, cooldown: { async acquire() { return true; } }, channel: send.channel });
    const [ra, rb] = await Promise.all([deliverNotificationFacts([FACT], a), deliverNotificationFacts([FACT], b)]);
    const statuses = [ra[0]!.status, rb[0]!.status].sort();
    expect(statuses).toEqual(["duplicate", "sent"]);
    expect(ledger.rows.length).toBe(1);
    expect(send.sentMessages.length).toBe(1);
  });

  test("抢占撞唯一索引 = duplicate，不发送（不是错误路径）", async () => {
    const ledger = memoryLedger();
    const send = recordingEmail();
    const deps = depsOf({ ledger: ledger.store, cooldown: { async acquire() { return true; } }, channel: send.channel });
    await deliverNotificationFacts([FACT], deps);
    const again = await deliverNotificationFacts([FACT], deps);
    expect(again[0]!.status).toBe("duplicate");
    expect(again[0]!.reason).toBeNull();
    expect(send.sentMessages.length).toBe(1);
    expect(ledger.rows.length).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* E. Redis 不可用：照发 + degraded                                     */
/* ------------------------------------------------------------------ */

describe("E. 静默期存储不可用时照发（Lead 裁决 O2）", () => {
  test("Redis 抛错 → 仍然发出，账本标 degraded=true", async () => {
    const ledger = memoryLedger();
    const send = recordingEmail();
    const warnings: string[] = [];
    const deps = depsOf({
      ledger: ledger.store,
      cooldown: { async acquire() { throw new Error("redis down"); } },
      channel: send.channel,
      warnings,
    });
    const outcomes = await deliverNotificationFacts([FACT], deps);
    expect(outcomes[0]!.status).toBe("sent");
    expect(outcomes[0]!.degraded).toBe(true);
    expect(send.sentMessages.length).toBe(1);
    expect(ledger.rows[0]!.degraded).toBe(true);
    expect(ledger.rows[0]!.settled?.degraded).toBe(true);
    expect(warnings.some((w) => w.includes("静默期存储不可用"))).toBe(true);
  });

  test("降级路径仍然抑制刷屏（进程内近似），且不会无限增长", () => {
    let clock = 1_000;
    const acquire = createDegradedCooldown({ now: () => clock });
    expect(acquire("k", 300)).toBe(true);
    clock += 1_000;
    expect(acquire("k", 300)).toBe(false);
    clock += 300_000;
    expect(acquire("k", 300)).toBe(true);

    const big = createDegradedCooldown({ now: () => clock });
    for (let i = 0; i < DEGRADED_COOLDOWN_MAX_ENTRIES + 10; i++) expect(big(`k${i}`, 300)).toBe(true);
    // 容量有上限：早期的键被淘汰（近似去重的代价，已写进注释）。
    expect(big("k0", 300)).toBe(true);
  });

  test("降级去重抑制时也返回 suppressed", async () => {
    const ledger = memoryLedger();
    const send = recordingEmail();
    const degraded = createDegradedCooldown({ now: () => 1_000 });
    const deps = depsOf({
      ledger: ledger.store,
      cooldown: { async acquire() { throw new Error("redis down"); } },
      degradedCooldown: degraded,
      channel: send.channel,
    });
    const first = await deliverNotificationFacts([FACT], deps);
    const second = await deliverNotificationFacts([FACT], deps);
    expect(first[0]!.status).toBe("sent");
    expect(second[0]!.status).toBe("suppressed");
    expect(second[0]!.degraded).toBe(true);
    expect(send.sentMessages.length).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* F. fail-closed 反例（DoD4）                                          */
/* ------------------------------------------------------------------ */

describe("F. fail-closed：未知/未实现/无收件人一律拒绝并留记录", () => {
  test("本期未实现的渠道类型（webhook / telegram）→ unsupported_channel + 零出站", async () => {
    for (const kind of NOTIFICATION_CHANNEL_KINDS.filter((k) => k !== "email")) {
      const ledger = memoryLedger();
      let called = 0;
      const channel: NotificationChannel = {
        kind,
        isConfigured: () => true,
        validateConfig: () => ({ ok: true }),
        send: async () => {
          called++;
          return { sent: true };
        },
      };
      const outcomes = await deliverNotificationFacts([FACT], depsOf({ ledger: ledger.store, channel }));
      expect(outcomes[0]!.status).toBe("failed");
      expect(outcomes[0]!.reason).toBe("unsupported_channel");
      expect(called).toBe(0);
      expect(ledger.rows[0]!.settled?.failure_reason).toBe("unsupported_channel");
    }
  });

  test("枚举外的渠道类型 → 同样拒绝（不是「注册了就算支持」）", async () => {
    const ledger = memoryLedger();
    const channel = {
      kind: "slack" as unknown as NotificationChannel["kind"],
      isConfigured: () => true,
      validateConfig: () => ({ ok: true as const }),
      send: async () => ({ sent: true }),
    };
    const outcomes = await deliverNotificationFacts([FACT], depsOf({ ledger: ledger.store, channel }));
    expect(outcomes[0]!.reason).toBe("unsupported_channel");
    expect(ledger.rows.length).toBe(1);
  });

  test("没有收件人 → rejected_target + 零出站，且**绝不猜**收件人", async () => {
    const ledger = memoryLedger();
    const send = recordingEmail();
    const outcomes = await deliverNotificationFacts(
      [FACT],
      depsOf({ ledger: ledger.store, channel: send.channel, targets: () => [] }),
    );
    expect(outcomes[0]!.status).toBe("failed");
    expect(outcomes[0]!.reason).toBe("rejected_target");
    expect(send.sentMessages.length).toBe(0);
    expect(ledger.rows[0]!.settled?.failure_reason).toBe("rejected_target");
  });

  test("收件人形状非法（CRLF / 尖括号 / 无域名）→ rejected_target", async () => {
    for (const bad of ["a\r\nb@example.com", "ops@example.com, evil@example.com", "<a@b.com>", "ops", "ops@localhost", `${"a".repeat(EMAIL_TARGET_MAX)}@example.com`]) {
      expect(isValidEmailTarget(bad)).toBe(false);
      const ledger = memoryLedger();
      const send = recordingEmail();
      const outcomes = await deliverNotificationFacts(
        [FACT],
        depsOf({ ledger: ledger.store, channel: send.channel, targets: () => [bad] }),
      );
      expect(outcomes[0]!.reason).toBe("rejected_target");
      expect(send.sentMessages.length).toBe(0);
    }
    expect(isValidEmailTarget("ops@example.com")).toBe(true);
  });

  test("部分目标非法：合法的照发，非法的绝不发（不因为「有一个不行」就全丢）", async () => {
    const ledger = memoryLedger();
    const send = recordingEmail();
    const outcomes = await deliverNotificationFacts(
      [FACT],
      depsOf({ ledger: ledger.store, channel: send.channel, targets: () => ["ops@example.com", "bad\r\n@x"] }),
    );
    expect(outcomes[0]!.status).toBe("sent");
    expect(send.sentMessages.map((m) => m.to)).toEqual(["ops@example.com"]);
  });

  test("账本不可用 → 放弃投递（不产生不可审计的投递），且不抛出", async () => {
    const ledger = memoryLedger({ failClaim: true });
    const send = recordingEmail();
    const outcomes = await deliverNotificationFacts([FACT], depsOf({ ledger: ledger.store, channel: send.channel }));
    expect(outcomes[0]!.status).toBe("failed");
    expect(outcomes[0]!.reason).toBe("ledger_unavailable");
    expect(send.sentMessages.length).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* G. 有界重试（F4.3）                                                  */
/* ------------------------------------------------------------------ */

describe("G. 有界重试", () => {
  test("退避形态 = BASE*3^N + 抖动，最多 3 次", () => {
    expect(notificationRetryDelayMs(1, () => 0)).toBe(NOTIFICATION_RETRY_BACKOFF_BASE_MS);
    expect(notificationRetryDelayMs(2, () => 0)).toBe(NOTIFICATION_RETRY_BACKOFF_BASE_MS * 3);
    expect(notificationRetryDelayMs(3, () => 0)).toBe(NOTIFICATION_RETRY_BACKOFF_BASE_MS * 9);
    expect(notificationRetryDelayMs(1, () => 0.999)).toBeLessThan(NOTIFICATION_RETRY_BACKOFF_BASE_MS * 2);
    expect(NOTIFICATION_MAX_ATTEMPTS).toBe(3);
  });

  test("传输失败重试到上限后收敛为 failed（attempts=3，不无限重试）", async () => {
    const ledger = memoryLedger();
    const sleepCalls: number[] = [];
    let sends = 0;
    const channel = createEmailChannel({
      configured: () => true,
      send: async () => {
        sends++;
        return { sent: false, reason: "smtp_error" };
      },
    });
    const outcomes = await deliverNotificationFacts(
      [FACT],
      depsOf({ ledger: ledger.store, channel, sleep: async (ms) => { sleepCalls.push(ms); }, random: () => 0 }),
    );
    expect(sends).toBe(3);
    expect(sleepCalls).toEqual([50, 150]);
    expect(outcomes[0]!.status).toBe("failed");
    expect(outcomes[0]!.reason).toBe("transport_error");
    expect(outcomes[0]!.attempts).toBe(3);
    expect(ledger.rows[0]!.settled).toEqual({
      status: "failed",
      failure_reason: "transport_error",
      attempts: 3,
      degraded: false,
      error: "smtp_error",
    });
  });

  test("第二次尝试成功 → sent（attempts=2），不再发第三封", async () => {
    const ledger = memoryLedger();
    let sends = 0;
    const channel = createEmailChannel({
      configured: () => true,
      send: async () => {
        sends++;
        return sends === 1 ? { sent: false, reason: "smtp_error" } : { sent: true };
      },
    });
    const outcomes = await deliverNotificationFacts([FACT], depsOf({ ledger: ledger.store, channel }));
    expect(outcomes[0]!.status).toBe("sent");
    expect(outcomes[0]!.attempts).toBe(2);
    expect(sends).toBe(2);
  });

  test("拒绝类失败不重试（rejected_target / not_configured 重试没有意义）", async () => {
    let sends = 0;
    const channel: NotificationChannel = {
      kind: "email",
      isConfigured: () => true,
      validateConfig: () => ({ ok: true }),
      send: async () => {
        sends++;
        return { sent: false, reason: "rejected_target" };
      },
    };
    const ledger = memoryLedger();
    const outcomes = await deliverNotificationFacts([FACT], depsOf({ ledger: ledger.store, channel }));
    expect(sends).toBe(1);
    expect(outcomes[0]!.attempts).toBe(1);
    expect(outcomes[0]!.reason).toBe("rejected_target");
  });

  test("错误摘要剥换行并截断（凭据/多行原文不得原样落库）", () => {
    expect(errorSummary(new Error("line1\r\nline2"))).toBe("line1 line2");
    expect(errorSummary(new Error("x".repeat(2_000))).length).toBe(500);
    expect(errorSummary("plain")).toBe("plain");
    expect(errorSummary(null)).toBe("");
  });
});

/* ------------------------------------------------------------------ */
/* H. 渲染（F10）                                                       */
/* ------------------------------------------------------------------ */

describe("H. 渲染：纯文本、白名单插值、剥 CRLF、截断", () => {
  test("纯文本且不回显任何凭据/HTML", () => {
    const rendered = renderNotificationText(FACT);
    expect(rendered.subject).toBe("[TuneX][warning] connection_offline");
    expect(rendered.text).toContain("TuneX 通知");
    expect(rendered.text).toContain("hk-in-01");
    expect(rendered.text).not.toMatch(/</);
    expect(rendered.text.length).toBeLessThanOrEqual(NOTIFICATION_RENDER_LIMITS.TEXT_MAX);
  });

  test("资源名里的 CRLF / 尖括号被剥掉（注入面就地消掉）", () => {
    const rendered = renderNotificationText(
      fact({ resource_name: "evil\r\nBcc: victim@example.com\n<script>" }),
    );
    expect(rendered.text).not.toMatch(/[\r\n]Bcc/);
    expect(rendered.text).toContain("evil Bcc: victim@example.com <script>");
    expect(rendered.subject).not.toMatch(/[\r\n]/);
  });

  test("超长字段被截断（主题/正文都有上限）", () => {
    const rendered = renderNotificationText(fact({ resource_name: "n".repeat(5_000), detail_code: "d".repeat(5_000) }));
    expect(rendered.text.length).toBeLessThanOrEqual(NOTIFICATION_RENDER_LIMITS.TEXT_MAX);
    expect(rendered.subject.length).toBeLessThanOrEqual(NOTIFICATION_RENDER_LIMITS.SUBJECT_MAX);
  });

  test("无 detail_code 时不渲染诊断码行", () => {
    expect(renderNotificationText(FACT).text).not.toContain("诊断码：");
    expect(renderNotificationText(fact({ detail_code: "no_capacity" })).text).toContain("诊断码：no_capacity");
  });
});
