/**
 * V5-WP18.4 —— Telegram 渠道 + token 密文存储 + `tg_id` 绑定语义
 * （`services/notification-seal.ts` / `services/notification-telegram.ts`，契约 F3 / F5 / F6.6 / R5）。
 *
 * 覆盖的行为（全部离线：注入传输替身 + 内存账本，不发任何真实请求）：
 *   A. **密钥域分离**（R5）：通知用途的 HKDF info 独立于联邦/DDNS，同一 AUTH_SECRET 派生出的
 *      两把密钥不同；用联邦密钥封的密文用通知密钥解不开；篡改密文/换主密钥一律抛错（fail-closed）。
 *   B. **解封失败 = `secret_unreadable`**（DoD4）：既不是 not_configured（掩盖事故）、也不是静默不发；
 *      解出来的东西形状不对同样归这一类，且都留一行失败记录、零出站。
 *   C. **`tg_id` 绑定语义**：未绑定/非法 → **不投递**（`rejected_target` + 零出站）；
 *      绝不回落 `User.id`（入参类型里根本没有 user id）；批量解析去重且**漏掉的收件人可见**。
 *   D. 部署级开关默认关（与 Lead 在 O4 给 webhook 的取向一致）。
 *   E. 成功路径：请求打向固定 `api.<host>` 端点、URL 里带 token、正文 `parse_mode=HTML` + 转义、
 *      chat_id 以**字符串**下发（64 位整数精度）。
 *   F. **token 任何形态都不落账本/摘要**（F5）：出站 URL 带 token（协议要求）但错误摘要与账本不含。
 *   G. 失败映射：400/403 → `rejected_target`（不重试）；429/5xx/3xx → `transport_error`（F4.3 有界重试）。
 *   H. 渲染：HTML 转义 + 截断**不切断实体**（切坏 `&amp;` 会被 Telegram 400）。
 *   I. F5 行 → 渠道依赖的纯映射（kind 不匹配 / enabled=false / 空密文 一律不猜）。
 *
 * 跑法（backend 目录）：bun test src/services/__tests__/v5-wp18-telegram.test.ts
 */
import { describe, expect, test } from "bun:test";
import type { AttentionItem } from "../attention.ts";
import { deriveDdnsSealKey, deriveSealKey, sealSecret, unsealSecret } from "../federation/seal.ts";
import {
  deliverNotificationFacts,
  renderNotificationText,
  type LedgerClaimResult,
  type NewNotificationDelivery,
  type NotificationCooldownStore,
  type NotificationDeliveryPatch,
  type NotificationLedgerStore,
} from "../notification-delivery.ts";
import { deriveNotificationFacts, workspaceNotificationScope, type NotificationFact } from "../notification-facts.ts";
import {
  NOTIFICATION_SEAL_INFO,
  deriveNotificationSealKey,
  notificationSealMasterSecret,
  sealNotificationSecret,
  unsealNotificationSecret,
} from "../notification-seal.ts";
import {
  TELEGRAM_ENABLED_ENV,
  TELEGRAM_MESSAGE_MAX,
  buildTelegramSendUrl,
  createTelegramChannel,
  escapeTelegramHtml,
  isTelegramChannelEnabled,
  isValidTelegramBotToken,
  isValidTelegramChatId,
  redactTelegramToken,
  renderTelegramMessage,
  resolveTelegramChatTarget,
  resolveTelegramChatTargets,
  telegramSealedTokenFromRow,
  truncateTelegramHtml,
  type TelegramTransport,
} from "../notification-telegram.ts";

/* ------------------------------------------------------------------ */
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

const MASTER = "test-master-secret-for-wp18-4";
const TOKEN = "123456789:AAHkqwertyuiopasdfghjklzxcvbnm";

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
  dedupe_key: "c".repeat(64),
  detail_code: null,
};

function deriveOne(): NotificationFact {
  const item: AttentionItem = {
    kind: "node",
    id: 11,
    name: "hk-in-01",
    severity: "warning",
    reason_code: "connection_offline",
    retryable: null,
  };
  const { facts } = deriveNotificationFacts({
    scope: workspaceNotificationScope(7),
    seeds: [{ item, occurred_at: new Date("2026-01-01T11:58:00.000Z") }],
  });
  return facts[0]!;
}

interface Row extends NewNotificationDelivery {
  id: number;
  settled: NotificationDeliveryPatch | null;
}

function memoryLedger() {
  const rows: Row[] = [];
  let nextId = 1;
  const store: NotificationLedgerStore = {
    async claim(row): Promise<LedgerClaimResult> {
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

function memoryCooldown(): NotificationCooldownStore {
  const keys = new Set<string>();
  return {
    async acquire(key) {
      if (keys.has(key)) return false;
      keys.add(key);
      return true;
    },
  };
}

/** 出站替身：记录 URL/正文，不联网（"零出站"与"token 不落账本"的断言都靠它）。 */
function recordingTransport(response: { status: number; json: unknown } = { status: 200, json: { ok: true } }) {
  const calls: { url: string; body: string }[] = [];
  const transport: TelegramTransport = async (request) => {
    calls.push({ url: request.url, body: request.body });
    return response;
  };
  return { transport, calls };
}

function depsOf(over: {
  ledger: NotificationLedgerStore;
  channel: ReturnType<typeof createTelegramChannel>;
  targets: readonly string[];
}) {
  return {
    ledger: over.ledger,
    channels: [over.channel],
    cooldown: memoryCooldown(),
    resolveTargets: () => over.targets,
    sleep: async () => {},
    random: () => 0,
    onWarn: () => {},
  };
}

/** 已配置好的渠道（开关开 + 一份用 MASTER 封好的 token 密文）。 */
function channelWith(over: Partial<Parameters<typeof createTelegramChannel>[0]> = {}) {
  return createTelegramChannel({
    enabled: () => true,
    sealedToken: () => sealNotificationSecret(TOKEN, MASTER),
    masterSecret: () => MASTER,
    ...over,
  });
}

/* ------------------------------------------------------------------ */
/* A. 密钥域分离（R5）                                                  */
/* ------------------------------------------------------------------ */

describe("A. 密钥域分离：通知用途的 HKDF info 独立（R5）", () => {
  test("同一 AUTH_SECRET 派生出的三把密钥互不相同（联邦 / DDNS / 通知）", () => {
    const federation = deriveSealKey(MASTER).toString("hex");
    const ddns = deriveDdnsSealKey(MASTER).toString("hex");
    const notification = deriveNotificationSealKey(MASTER).toString("hex");
    expect(new Set([federation, ddns, notification]).size).toBe(3);
    // 确定性：同一输入两次派生一致（否则密文在重启后全部解不开）
    expect(deriveNotificationSealKey(MASTER).equals(deriveNotificationSealKey(MASTER))).toBe(true);
    expect(NOTIFICATION_SEAL_INFO).toBe("tunex-notification-v1");
  });

  test("跨域不通用：联邦密钥封的密文，通知密钥解不开（反之亦然）", () => {
    const byFederation = sealSecret("federation-secret", deriveSealKey(MASTER));
    expect(() => unsealNotificationSecret(byFederation, MASTER)).toThrow();

    const byNotification = sealNotificationSecret(TOKEN, MASTER);
    expect(() => unsealSecret(byNotification, deriveSealKey(MASTER))).toThrow();
    // 自己的密钥能解开
    expect(unsealNotificationSecret(byNotification, MASTER)).toBe(TOKEN);
  });

  test("空主密钥 = 配置错误，直接抛（不许拿空串派生一把人人可推的密钥）", () => {
    expect(() => deriveNotificationSealKey("")).toThrow();
    expect(() => deriveNotificationSealKey("   ")).toThrow();
    expect(() => sealNotificationSecret(TOKEN, "")).toThrow();
    expect(notificationSealMasterSecret({})).toBe("");
  });

  test("密文形态与 fail-closed：单行 4 段；篡改/换主密钥/畸形一律抛错且错误消息不含密文", () => {
    const sealed = sealNotificationSecret(TOKEN, MASTER);
    expect(sealed.split(".").length).toBe(4);
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed.includes(TOKEN)).toBe(false);

    const tampered = `${sealed.slice(0, -2)}xx`;
    for (const bad of [tampered, sealed, "not-a-ciphertext", ""]) {
      const wrongKey = bad === sealed ? "another-master" : MASTER;
      let thrown: unknown = null;
      try {
        unsealNotificationSecret(bad, wrongKey);
      } catch (err) {
        thrown = err;
      }
      expect({ input: bad.slice(0, 8), threw: thrown !== null }).toEqual({ input: bad.slice(0, 8), threw: true });
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      expect(message.includes(sealed)).toBe(false);
      expect(message.includes(TOKEN)).toBe(false);
    }
    // 空明文不允许封（否则"有密文、无 token"这种状态会被当成配置成功）
    expect(() => sealNotificationSecret("", MASTER)).toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* B/C. token 形状与 tg_id 绑定语义                                     */
/* ------------------------------------------------------------------ */

describe("B. bot token 形状校验", () => {
  test("合法形状通过；畸形一律拒", () => {
    expect(isValidTelegramBotToken(TOKEN)).toBe(true);
    expect(isValidTelegramBotToken(`  ${TOKEN}  `)).toBe(true);
    for (const bad of ["", "12345", "abc:def", "12345:", ":AAHkqwertyuiopasdfghjklzxcvbnm", "12345:short", `${TOKEN} extra`, null, 42]) {
      expect({ token: String(bad), ok: isValidTelegramBotToken(bad) }).toEqual({ token: String(bad), ok: false });
    }
  });
});

describe("C. tg_id 绑定语义：未绑定 = 不投递，绝不猜用户", () => {
  test("空 / 空白 / 缺失 → unbound；形状非法 → invalid_tg_id", () => {
    expect(resolveTelegramChatTarget({ tg_id: null })).toEqual({ ok: false, reason: "unbound" });
    expect(resolveTelegramChatTarget({})).toEqual({ ok: false, reason: "unbound" });
    expect(resolveTelegramChatTarget({ tg_id: "" })).toEqual({ ok: false, reason: "unbound" });
    expect(resolveTelegramChatTarget({ tg_id: "   " })).toEqual({ ok: false, reason: "unbound" });
    for (const value of ["abc", "@channel", "+12345", "1e5", "12 34", "12345678901234567890123", "1.5"]) {
      expect({ value, result: resolveTelegramChatTarget({ tg_id: value }) }).toEqual({
        value,
        result: { ok: false, reason: "invalid_tg_id" },
      });
    }
  });

  test("合法 chat id：私聊正数、群负数、前后空白被 trim", () => {
    expect(resolveTelegramChatTarget({ tg_id: "123456789" })).toEqual({ ok: true, chat_id: "123456789" });
    expect(resolveTelegramChatTarget({ tg_id: "-1001234567890" })).toEqual({ ok: true, chat_id: "-1001234567890" });
    expect(resolveTelegramChatTarget({ tg_id: " 42 " })).toEqual({ ok: true, chat_id: "42" });
  });

  test("**绝不猜用户**：即便调用方多塞了 user id / email，也只读 tg_id", () => {
    const withExtras = { tg_id: null, id: 4242, email: "a@b.c", user_id: 4242 };
    expect(resolveTelegramChatTarget(withExtras)).toEqual({ ok: false, reason: "unbound" });
    // 结果里不可能出现被猜出来的 id
    expect(JSON.stringify(resolveTelegramChatTarget(withExtras))).not.toContain("4242");
    expect(isValidTelegramChatId(undefined)).toBe(false);
    expect(isValidTelegramChatId("42")).toBe(true);
  });

  test("批量解析：去重 + 漏掉的收件人**可见**（下标 + 原因）", () => {
    const resolved = resolveTelegramChatTargets([
      { tg_id: "42" },
      { tg_id: null },
      { tg_id: "42" },
      { tg_id: "nope" },
      { tg_id: " -1001 " },
    ]);
    expect(resolved.chat_ids).toEqual(["42", "-1001"]);
    expect(resolved.skipped).toEqual([
      { index: 1, reason: "unbound" },
      { index: 3, reason: "invalid_tg_id" },
    ]);
  });

  test("端到端：未绑定收件人 → rejected_target + 零出站（不投递、不猜）", async () => {
    const ledger = memoryLedger();
    const send = recordingTransport();
    const channel = channelWith({ transport: send.transport });
    const resolved = resolveTelegramChatTargets([{ tg_id: null }, { tg_id: "abc" }]);
    expect(resolved.chat_ids).toEqual([]);

    const outcomes = await deliverNotificationFacts(
      [deriveOne()],
      depsOf({ ledger: ledger.store, channel, targets: resolved.chat_ids }),
    );
    expect(outcomes[0]!.status).toBe("failed");
    expect(outcomes[0]!.reason).toBe("rejected_target");
    expect(send.calls.length).toBe(0);
    expect(ledger.rows[0]!.settled?.failure_reason).toBe("rejected_target");
  });
});

/* ------------------------------------------------------------------ */
/* D. 部署级开关                                                        */
/* ------------------------------------------------------------------ */

describe("D. 部署级开关默认关", () => {
  test("只有显式 =true 才算打开", () => {
    expect(isTelegramChannelEnabled({})).toBe(false);
    expect(isTelegramChannelEnabled({ [TELEGRAM_ENABLED_ENV]: "1" })).toBe(false);
    expect(isTelegramChannelEnabled({ [TELEGRAM_ENABLED_ENV]: "true" })).toBe(true);
  });

  test("开关关 / 没有密文 → isConfigured=false；投递落 not_configured + 零出站", async () => {
    const disabled = channelWith({ enabled: () => false });
    expect(disabled.isConfigured(workspaceNotificationScope(7))).toBe(false);
    const noSecret = createTelegramChannel({ enabled: () => true, sealedToken: () => null });
    expect(noSecret.isConfigured(workspaceNotificationScope(7))).toBe(false);

    const ledger = memoryLedger();
    const send = recordingTransport();
    const outcomes = await deliverNotificationFacts(
      [deriveOne()],
      depsOf({ ledger: ledger.store, channel: channelWith({ enabled: () => false, transport: send.transport }), targets: ["42"] }),
    );
    expect(outcomes[0]!.reason).toBe("not_configured");
    expect(send.calls.length).toBe(0);
    expect(ledger.rows[0]!.settled?.failure_reason).toBe("not_configured");
  });

  test("开关开 + 有密文 → isConfigured=true（**不**试解封：解不开是另一类失败）", () => {
    const channel = channelWith({ sealedToken: () => "v1.bogus.bogus.bogus" });
    expect(channel.isConfigured(workspaceNotificationScope(7))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* E. 解密失败（DoD4）                                                  */
/* ------------------------------------------------------------------ */

describe("E. 密文解不开 → secret_unreadable（DoD4：拒绝 + 留失败记录 + 零出站）", () => {
  test("用错主密钥封的密文：解封失败，投递失败可见，且不冒充 not_configured", async () => {
    const ledger = memoryLedger();
    const send = recordingTransport();
    const channel = createTelegramChannel({
      enabled: () => true,
      sealedToken: () => sealNotificationSecret(TOKEN, "a-different-master-secret"),
      masterSecret: () => MASTER,
      transport: send.transport,
    });
    const outcomes = await deliverNotificationFacts(
      [deriveOne()],
      depsOf({ ledger: ledger.store, channel, targets: ["42"] }),
    );
    expect(outcomes[0]!.status).toBe("failed");
    expect(outcomes[0]!.reason).toBe("secret_unreadable");
    expect(send.calls.length).toBe(0);
    expect(ledger.rows[0]!.settled?.failure_reason).toBe("secret_unreadable");
    expect(ledger.rows[0]!.settled?.error ?? "").not.toContain(TOKEN);
  });

  test("解出来形状不对（存的不是 bot token）→ 同样归 secret_unreadable，零出站", async () => {
    const send = recordingTransport();
    const channel = createTelegramChannel({
      enabled: () => true,
      sealedToken: () => sealNotificationSecret("this-is-not-a-bot-token", MASTER),
      masterSecret: () => MASTER,
      transport: send.transport,
    });
    const result = await channel.send(renderNotificationText(FACT), "42");
    expect({ reason: result.reason, detail: result.detail }).toEqual({
      reason: "secret_unreadable",
      detail: "telegram bot token has invalid shape",
    });
    expect(send.calls.length).toBe(0);
  });

  test("空主密钥（部署配错）→ 也是 secret_unreadable，不抛到调用方", async () => {
    const channel = channelWith({ masterSecret: () => "" });
    const result = await channel.send(renderNotificationText(FACT), "42");
    expect(result.sent).toBe(false);
    expect(result.reason).toBe("secret_unreadable");
  });
});

/* ------------------------------------------------------------------ */
/* F. 成功路径与凭据边界                                                */
/* ------------------------------------------------------------------ */

describe("F. 成功路径：固定端点、HTML 正文、token 不进账本", () => {
  test("请求形状：URL 带 token、正文 chat_id 字符串 + parse_mode=HTML + 转义、主题加粗", async () => {
    const send = recordingTransport({ status: 200, json: { ok: true, result: { message_id: 1 } } });
    const ledger = memoryLedger();
    const channel = channelWith({ transport: send.transport });
    const fact = { ...deriveOne(), resource_name: "hk & <in> 01" };

    const outcomes = await deliverNotificationFacts(
      [fact],
      depsOf({ ledger: ledger.store, channel, targets: ["-1001234567890"] }),
    );
    expect(outcomes[0]!.status).toBe("sent");
    expect(send.calls.length).toBe(1);
    expect(send.calls[0]!.url).toBe(`${buildTelegramSendUrl("https://api.telegram.org", TOKEN)}`);
    const body = JSON.parse(send.calls[0]!.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["chat_id", "parse_mode", "text"]);
    expect(body.chat_id).toBe("-1001234567890");
    expect(body.parse_mode).toBe("HTML");
    const text = body.text as string;
    expect(text.startsWith("<b>[TuneX][warning] connection_offline</b>")).toBe(true);
    expect(text).toContain("hk &amp; &lt;in&gt; 01"); // 转义（F6.6）
    expect(text).not.toContain("<in>");
    // 账本落 chat id（与邮箱地址同口径），**不含 token**
    expect(ledger.rows[0]!.target).toBe("-1001234567890");
    expect(ledger.rows[0]!.target).not.toContain(TOKEN);
  });

  test("传输层抛出的错误里带上了 URL（含 token）→ 摘要与账本都已脱敏", async () => {
    const ledger = memoryLedger();
    const channel = channelWith({
      transport: async (request) => {
        throw new Error(`fetch failed: POST ${request.url} (timeout)`);
      },
    });
    const outcomes = await deliverNotificationFacts(
      [deriveOne()],
      depsOf({ ledger: ledger.store, channel, targets: ["42"] }),
    );
    expect(outcomes[0]!.status).toBe("failed");
    const error = ledger.rows[0]!.settled?.error ?? "";
    expect(error).not.toContain(TOKEN);
    expect(error).toContain("***");
    expect(error).not.toContain("123456789:AAH");
  });

  test("Telegram 的 description 里回显了 token → 摘要脱敏（防御性）", () => {
    const detail = redactTelegramToken(`Bad Request: token ${TOKEN} rejected`, TOKEN);
    expect(detail).not.toContain(TOKEN);
    expect(detail).toContain("***");
    // URL 编码形态同样处理（`:` → `%3A`）
    const encoded = redactTelegramToken(`url=/bot${encodeURIComponent(TOKEN)}/sendMessage`, TOKEN);
    expect(encoded).not.toContain("123456789");
  });

  test("redactTarget 不落非 chat id 的原文（防调用方把 URL/token 当目标传进来）", () => {
    const channel = channelWith();
    expect(channel.redactTarget?.("42")).toBe("42");
    expect(channel.redactTarget?.(`https://api.telegram.org/bot${TOKEN}/sendMessage`)).toBe("***");
  });
});

/* ------------------------------------------------------------------ */
/* G. 失败映射与有界重试                                                */
/* ------------------------------------------------------------------ */

describe("G. 失败映射：400/403 不重试；429/5xx/3xx 走传输失败", () => {
  test("error_code 400 / 403 → rejected_target（确定性目标问题）", async () => {
    for (const code of [400, 403]) {
      const send = recordingTransport({
        status: 200,
        json: { ok: false, error_code: code, description: "Bad Request: chat not found" },
      });
      const channel = channelWith({ transport: send.transport });
      const result = await channel.send(renderNotificationText(FACT), "42");
      expect({ code, reason: result.reason }).toEqual({ code, reason: "rejected_target" });
    }
  });

  test("429 / 500 / 3xx / 2xx 但 ok=false → transport_error", async () => {
    const cases: readonly (readonly [number, unknown])[] = [
      [429, { ok: false, error_code: 429, description: "Too Many Requests: retry after 3" }],
      [500, { ok: false, error_code: 500, description: "Internal Server Error" }],
      [302, { ok: false }],
      [200, { ok: false }],
      [200, null],
    ];
    for (const [status, json] of cases) {
      const channel = channelWith({ transport: recordingTransport({ status, json }).transport });
      const result = await channel.send(renderNotificationText(FACT), "42");
      expect({ status, reason: result.reason }).toEqual({ status, reason: "transport_error" });
    }
  });

  test("传输失败按 F4.3 有界重试（最多 3 次），不无限重试", async () => {
    const ledger = memoryLedger();
    let attempts = 0;
    const channel = channelWith({
      transport: async () => {
        attempts++;
        throw new Error("network unreachable");
      },
    });
    const outcomes = await deliverNotificationFacts(
      [deriveOne()],
      depsOf({ ledger: ledger.store, channel, targets: ["42"] }),
    );
    expect(outcomes[0]!.status).toBe("failed");
    expect(outcomes[0]!.reason).toBe("transport_error");
    expect(attempts).toBe(3);
    expect(ledger.rows[0]!.settled?.attempts).toBe(3);
  });

  test("目标不是 chat id → rejected_target + 零出站（形状先于凭据）", async () => {
    const send = recordingTransport();
    const channel = channelWith({ transport: send.transport });
    for (const target of ["@channel", "not-an-id", ""]) {
      const result = await channel.send(renderNotificationText(FACT), target);
      expect({ target, reason: result.reason }).toEqual({ target, reason: "rejected_target" });
    }
    expect(send.calls.length).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* H. 渲染                                                              */
/* ------------------------------------------------------------------ */

describe("H. 渲染：转义 + 截断不切断实体（F6.6）", () => {
  test("HTML 三个字符被转义，& 先转（避免二次转义）", () => {
    expect(escapeTelegramHtml("a & b <c> \"d\"")).toBe("a &amp; b &lt;c&gt; \"d\"");
    expect(escapeTelegramHtml("&lt;")).toBe("&amp;lt;");
  });

  test("超长内容截断到上限，且**不切断** HTML 实体", () => {
    const long = "x".repeat(TELEGRAM_MESSAGE_MAX + 10);
    expect(truncateTelegramHtml(long).length).toBe(TELEGRAM_MESSAGE_MAX);
    expect(truncateTelegramHtml("short").length).toBe(5);

    // 截断点正好落在 `&amp;` 中间：必须回退到实体之前，而不是留下 `&am`
    const entity = "a".repeat(TELEGRAM_MESSAGE_MAX - 2) + "&amp;tail";
    const cut = truncateTelegramHtml(entity);
    expect(cut.endsWith("&")).toBe(false);
    expect(cut.endsWith("&am")).toBe(false);
    expect(cut.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX);
    // 用 ≥2 字节字符也不会截出半个实体
    const rendered = renderTelegramMessage({ subject: "s", text: "é".repeat(TELEGRAM_MESSAGE_MAX + 5) });
    expect(rendered.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX);
  });

  test("渲染结果不超过 Telegram 上限（主题 + 正文 + 标签一起算）", () => {
    const rendered = renderTelegramMessage(renderNotificationText(FACT));
    expect(rendered.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX);
    expect(rendered).toContain("connection_offline");
    expect(rendered).not.toContain("<script");
  });
});

/* ------------------------------------------------------------------ */
/* I. F5 行 → 渠道依赖                                                  */
/* ------------------------------------------------------------------ */

describe("I. F5 行 → 密文（纯映射，不猜）", () => {
  test("kind/enabled/secret_enc 的判定表", () => {
    const sealed = sealNotificationSecret(TOKEN, MASTER);
    expect(telegramSealedTokenFromRow({ kind: "telegram", secret_enc: sealed })).toBe(sealed);
    expect(telegramSealedTokenFromRow({ kind: "telegram", enabled: true, secret_enc: sealed })).toBe(sealed);
    for (const row of [
      null,
      undefined,
      { kind: "webhook", secret_enc: sealed }, // 别的渠道的行：不猜
      { kind: "telegram" }, // 没有密文
      { kind: "telegram", secret_enc: "" },
      { kind: "telegram", secret_enc: "   " },
      { kind: "telegram", enabled: false, secret_enc: sealed }, // 停用
      { secret_enc: sealed }, // 没有 kind
    ]) {
      expect({ row, value: telegramSealedTokenFromRow(row) }).toEqual({ row, value: null });
    }
  });

  test("行里的密文经渠道能真正发出去（存储 → 使用 的闭环）", async () => {
    const send = recordingTransport();
    const channel = createTelegramChannel({
      enabled: () => true,
      sealedToken: () => telegramSealedTokenFromRow({ kind: "telegram", enabled: true, secret_enc: sealNotificationSecret(TOKEN, MASTER) }),
      masterSecret: () => MASTER,
      transport: send.transport,
    });
    expect(await channel.send(renderNotificationText(FACT), "42")).toEqual({ sent: true });
    expect(send.calls.length).toBe(1);
  });
});
