/**
 * V5-WP18.6 —— F5 行 → 渠道配置（`services/notification-channel-config.ts`）。
 *
 * 这一层的存在理由是可断言的：**没有它**，`createTelegramChannel()` 的默认 `sealedToken`
 * 恒为 `() => null`，于是即便运维把行配好了，telegram 也永远"未配置"——而账本会显示
 * `not_configured`（看起来像"没人配过"，实际是"没人接上"）。所以下面每组断言都在回答：
 * 「配了行之后，渠道**真的**变成可用了吗」，而不是"读到了几行"。
 *
 * 全部离线：注入内存 db 替身；涉及部署开关的用例显式设置并还原 `process.env`
 * （只调 `isConfigured()`，**不发送**任何东西）。
 *
 * 跑法（backend 目录）：bun test src/services/__tests__/v5-wp18-channel-config.test.ts
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  buildPlatformNotificationChannels,
  loadPlatformChannelConfig,
  platformChannelTargets,
  type NotificationChannelConfigDb,
  type NotificationChannelRow,
} from "../notification-channel-config.ts";
import { enabledNotificationChannels, NOTIFICATION_CHANNEL_KINDS } from "../notification-delivery.ts";
import { TELEGRAM_ENABLED_ENV } from "../notification-telegram.ts";
import { WEBHOOK_ENABLED_ENV } from "../notification-webhook.ts";

const ORIGINAL_ENV = {
  telegram: process.env[TELEGRAM_ENABLED_ENV],
  webhook: process.env[WEBHOOK_ENABLED_ENV],
};

afterEach(() => {
  for (const [key, value] of [
    [TELEGRAM_ENABLED_ENV, ORIGINAL_ENV.telegram],
    [WEBHOOK_ENABLED_ENV, ORIGINAL_ENV.webhook],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function row(over: Partial<NotificationChannelRow> = {}): NotificationChannelRow {
  return {
    id: 1,
    scope_kind: "platform",
    workspace_id: null,
    kind: "webhook",
    target: "https://hooks.example.com/a",
    secret_enc: null,
    enabled: true,
    ...over,
  };
}

function dbWith(rows: NotificationChannelRow[], fail = false): NotificationChannelConfigDb {
  return {
    notificationChannel: {
      async findMany(args) {
        if (fail) throw new Error("db down");
        const where = args.where as { scope_kind?: string; workspace_id?: unknown };
        // 只实现本模块真正发出的条件：platform + workspace_id IS NULL。
        return rows
          .filter((r) => (where.scope_kind === undefined ? true : r.scope_kind === where.scope_kind))
          .filter((r) => (where.workspace_id === null ? r.workspace_id === null : true))
          .sort((a, b) => a.id - b.id);
      },
    },
  };
}

const load = async (rows: NotificationChannelRow[], fail = false) => {
  const result = await loadPlatformChannelConfig(dbWith(rows, fail));
  if (!result.ok) throw new Error("expected ok");
  return result.value;
};

/* ================================================================== */
/* A. 只读平台级、按 id 定序、停用≠删除                                 */
/* ================================================================== */

describe("A. 只认平台级启用行（停用 ≠ 删除）", () => {
  test("租户行不参与平台配置；停用行不进目标/密文，但仍留在 rows 里可诊断", async () => {
    const config = await load([
      row({ id: 1, kind: "webhook", target: "https://hooks.example.com/a" }),
      row({ id: 2, kind: "webhook", target: "https://hooks.example.com/b", enabled: false }),
      row({ id: 3, kind: "webhook", target: "https://hooks.example.com/tenant", scope_kind: "workspace", workspace_id: 7 }),
      row({ id: 4, kind: "telegram", target: "1001", secret_enc: "v1.aa.bb.cc" }),
    ]);

    expect(config.rows.map((r) => r.id)).toEqual([1, 2, 4]); // 租户行（id=3）被 where 挡掉；替身按同一条件过滤
    expect(config.webhook_targets).toEqual(["https://hooks.example.com/a"]);
    expect(config.telegram_sealed_token).toBe("v1.aa.bb.cc");
    expect(config.warnings).toEqual([]);
  });

  test("多条 telegram 行 → 取 id 最新的一条，并把这件事写进 warnings（多行是可能状态）", async () => {
    const config = await load([
      row({ id: 5, kind: "telegram", target: "1001", secret_enc: "old" }),
      row({ id: 9, kind: "telegram", target: "1002", secret_enc: "new" }),
    ]);
    expect(config.telegram_sealed_token).toBe("new");
    expect(config.warnings.join("\n")).toContain("telegram 有 2 条启用行");
  });

  test("telegram 行没有密文 → 视为未配置，并说明原因（不是静默 null）", async () => {
    const config = await load([row({ id: 6, kind: "telegram", target: "1001", secret_enc: "   " })]);
    expect(config.telegram_sealed_token).toBeNull();
    expect(config.warnings.join("\n")).toContain("没有可用的 secret_enc");
  });

  test("多条 webhook 行 = 多个接收方，全部是目标且顺序确定（按 id 升序）", async () => {
    const config = await load([
      row({ id: 3, kind: "webhook", target: "https://hooks.example.com/c" }),
      row({ id: 1, kind: "webhook", target: "https://hooks.example.com/a" }),
    ]);
    expect(config.webhook_targets).toEqual(["https://hooks.example.com/a", "https://hooks.example.com/c"]);
  });

  test("空目标/空白目标不产生目标（不拿空串去投递）", async () => {
    const config = await load([
      row({ id: 1, kind: "webhook", target: "   " }),
      row({ id: 2, kind: "webhook", target: "https://hooks.example.com/a" }),
    ]);
    expect(config.webhook_targets).toEqual(["https://hooks.example.com/a"]);
  });

  test("读不到 = storage_error（不是「没配置」：那是两件事）", async () => {
    const result = await loadPlatformChannelConfig(dbWith([], true));
    expect(result).toEqual({ ok: false, reason: "storage_error" });
  });
});

/* ================================================================== */
/* B. 配置 → 渠道实例（这一步才是"接上"）                                */
/* ================================================================== */

describe("B. 配了行之后渠道真的变成可用（部署开关仍各自把关）", () => {
  test("有 URL 才有 webhook 渠道；没 URL 就不进注册表（免得留 rejected_target 噪音）", async () => {
    const without = buildPlatformNotificationChannels(await load([]));
    const withUrl = buildPlatformNotificationChannels(
      await load([row({ kind: "webhook", target: "https://hooks.example.com/a" })]),
    );
    expect(without.map((c) => c.kind)).not.toContain("webhook");
    expect(withUrl.map((c) => c.kind)).toContain("webhook");
    // 不变的三个 kind 仍是闭集里的那三个。
    for (const channel of [...without, ...withUrl]) {
      expect(NOTIFICATION_CHANNEL_KINDS as readonly string[]).toContain(channel.kind);
    }
  });

  test("telegram：开关关 ⇒ 即使行里有密文也不算配置好；开关开 + 有密文 ⇒ 可用", async () => {
    const config = await load([row({ id: 7, kind: "telegram", target: "1001", secret_enc: "v1.aa.bb.cc" })]);
    const [telegram] = buildPlatformNotificationChannels(config).filter((c) => c.kind === "telegram");

    delete process.env[TELEGRAM_ENABLED_ENV];
    expect(telegram!.isConfigured({ kind: "platform", workspace_id: null })).toBe(false);

    process.env[TELEGRAM_ENABLED_ENV] = "true";
    expect(telegram!.isConfigured({ kind: "platform", workspace_id: null })).toBe(true);

    // 没有 telemetry 行时，即便开关开着也"未配置"。
    const [noToken] = buildPlatformNotificationChannels(await load([])).filter((c) => c.kind === "telegram");
    expect(noToken!.isConfigured({ kind: "platform", workspace_id: null })).toBe(false);
    delete process.env[TELEGRAM_ENABLED_ENV];
  });

  test("webhook：开关关 ⇒ 不算配置好（`enabledNotificationChannels` 把它滤掉）", async () => {
    const config = await load([row({ kind: "webhook", target: "https://hooks.example.com/a" })]);
    const channels = buildPlatformNotificationChannels(config).filter((c) => c.kind === "webhook");

    delete process.env[WEBHOOK_ENABLED_ENV];
    expect(enabledNotificationChannels(channels)).toEqual([]);

    process.env[WEBHOOK_ENABLED_ENV] = "true";
    expect(enabledNotificationChannels(channels).map((c) => c.kind)).toEqual(["webhook"]);
    delete process.env[WEBHOOK_ENABLED_ENV];
  });

  test("平台级目标：只有 webhook 有（email/telegram 的目标属于收件人，不走这里）", async () => {
    const config = await load([row({ kind: "webhook", target: "https://hooks.example.com/a" })]);
    expect(platformChannelTargets(config, "webhook")).toEqual(["https://hooks.example.com/a"]);
    expect(platformChannelTargets(config, "email")).toEqual([]);
    expect(platformChannelTargets(config, "telegram")).toEqual([]);
  });
});
