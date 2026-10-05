/**
 * V5-WP18.6 —— 渠道配置读取：F5 的 `notification_channel` 行 → 可用的渠道实例（契约 §F5）。
 *
 * ── 这一层为什么必须单独存在 ──
 * 18.3/18.4 把"渠道怎么发"写完了，但**没说"从哪一行拿到 URL / token"**：两个渠道工厂的
 * 注释都写着"配置由调用方给出"（`createWebhookChannel` 的 target、`createTelegramChannel` 的
 * `sealedToken`）。那个"调用方"就是本模块 —— 没有它，`createTelegramChannel()` 的默认
 * `sealedToken` 恒为 `() => null`，于是**通信渠道永远"未配置"**，而失败还会以
 * `not_configured` 的形式留在账本里（看起来像"没人配过"，实际是"没人接上"）。
 *
 * ── 三条口径 ──
 *  1. **平台级**：F5 与 O6 都冻结了"本期只有平台级渠道"，所以只读
 *     `scope_kind="platform"` 且 `workspace_id IS NULL` 的行（结构条件与 `Announcement`
 *     同款；租户自带渠道是 O6 未拍板的事）。
 *  2. **停用 ≠ 不存在**：`enabled=false` 的行不参与配置（`telegramSealedTokenFromRow`
 *     已经这么判），但**不删**——停用是运维动作，删是数据动作。
 *  3. **不猜**：同一渠道多行时要有确定答案（下面逐个写明），DB 不可用时返回
 *     `storage_error` 而不是"空配置"——那会把一次读取失败说成"这台安装没配渠道"。
 *
 * ── 为什么 telegram 取"最新一条"，而 webhook 取"全部" ──
 *   · telegram 的凭据是**实例级一份**（一个 bot token 对应一个 bot）：两行不同 token 时
 *     "用哪个"没有正确答案，取 `id` 最新的那条并把它写进 `warnings`，让运维看得见；
 *     行顺序由 `id` 决定 ⇒ 同一份数据两次读取结果相同（可断言）。
 *   · webhook 的每一行是一个**独立接收方**（不同 Slack 频道 / 不同端点），所以全部启用行
 *     都是目标，顺序按 `id` 升序（确定性）。
 *   · 注意 F5 的表**没有** `(scope_kind, workspace_id, kind)` 唯一索引（MySQL 里 NULL 互不相等，
 *     平台行之间等于没有约束 —— 见契约 §12.2-D4 的实测），所以"多行"是**真实可发生的状态**，
 *     必须在这里给出确定语义，而不是假设它不会发生。
 */
import { createEmailChannel, type NotificationChannel } from "./notification-delivery.ts";
// webhook 工厂从它自己的模块取：`notification-delivery.ts` 只是**用它**（默认注册表），
// 并不转出它 —— 从那里 import 会在 tsc 下立刻红（这是好事：依赖方向清楚）。
import { createTelegramChannel, telegramSealedTokenFromRow } from "./notification-telegram.ts";

/** 一行的最小形状（本模块只认这几列；`SELECT` 出来直接用）。 */
export interface NotificationChannelRow {
  id: number;
  scope_kind: string;
  workspace_id: number | null;
  kind: string;
  target: string;
  secret_enc: string | null;
  enabled: boolean;
}

export interface NotificationChannelConfigDb {
  notificationChannel: {
    findMany(args: Record<string, unknown>): Promise<NotificationChannelRow[]>;
  };
}

export interface PlatformChannelConfig {
  /** 参与配置的行（按 id 升序），诊断与断言用。 */
  readonly rows: readonly NotificationChannelRow[];
  /** webhook 的投递目标（每条启用行一个）。**URL 本身就是凭据**：落账本必须经渠道脱敏。 */
  readonly webhook_targets: readonly string[];
  /** telegram 的密文 bot token（最新一条启用行；没有则 null）。**明文绝不在这里出现**。 */
  readonly telegram_sealed_token: string | null;
  /** 读到了但需要人看一眼的情况（例如多条 telegram 行）。**不抛错、不静默**。 */
  readonly warnings: readonly string[];
}

export type PlatformChannelConfigResult =
  | { ok: true; value: PlatformChannelConfig }
  | { ok: false; reason: "storage_error" };

/**
 * 读出平台级渠道配置（纯 SELECT；绝不写库、绝不生成明文 token）。
 *
 * `enabled: false` 的行仍会被读出来（放进 `rows`），但**不产生任何目标/密文**：
 * 停用的渠道 = 未配置，而不是"静默不发"（账本里会留一条 `not_configured`，可见）。
 */
export async function loadPlatformChannelConfig(
  db: NotificationChannelConfigDb,
): Promise<PlatformChannelConfigResult> {
  let rows: NotificationChannelRow[];
  try {
    rows = await db.notificationChannel.findMany({
      where: { scope_kind: "platform", workspace_id: null },
      orderBy: { id: "asc" },
    });
  } catch {
    // 读不到 ≠ 没配置：把两者混起来会让一次 DB 抖动变成"这台安装没有渠道"。
    return { ok: false, reason: "storage_error" };
  }

  const warnings: string[] = [];
  const enabled = rows.filter((row) => row.enabled !== false);
  const webhookRows = enabled.filter((row) => row.kind === "webhook");
  const telegramRows = enabled.filter((row) => row.kind === "telegram");

  if (telegramRows.length > 1) {
    warnings.push(
      `telegram 有 ${telegramRows.length} 条启用行，取 id 最大的一条（${telegramRows[telegramRows.length - 1]!.id}）：` +
        `F5 的表没有"一 scope 一 kind"的唯一索引（NULL 互不相等），多行是可能状态，这里给出确定答案`,
    );
  }

  const newestTelegram = telegramRows.length > 0 ? telegramRows[telegramRows.length - 1]! : null;
  const sealed = newestTelegram === null ? null : telegramSealedTokenFromRow(newestTelegram);
  if (newestTelegram !== null && sealed === null) {
    // 有行但拿不到密文（`secret_enc` 为空/空白）—— 说清楚，别让它看起来像"没配过 telegram"。
    warnings.push(`telegram 行 ${newestTelegram.id} 没有可用的 secret_enc（视为未配置）`);
  }

  return {
    ok: true,
    value: {
      rows,
      webhook_targets: webhookRows
        .map((row) => (typeof row.target === "string" ? row.target.trim() : ""))
        .filter((target) => target !== ""),
      telegram_sealed_token: sealed,
      warnings,
    },
  };
}

/**
 * 配置 → 渠道实例。用的就是 18.2/18.3/18.4 的那三个工厂（**不是第二套实现**），
 * 只是把"从哪拿到 URL / token"接上：
 *   · email：SMTP 凭据齐备（部署级 env，与 F5 表无关）；
 *   · webhook：**不进注册表**（今天没有消费者，见文件末尾）。它的 URL 仍会被加载出来
 *     （`webhook_targets` 是数据，不是假装能用的出口）；
 *   · telegram：行里带密文才可能 `isConfigured`（`createTelegramChannel` 自己判"开关 + 有密文"，
 *     且**不试解封** —— 解不开是 `secret_unreadable`，是可排查的坏数据，不是"没配"）。
 *
 * 注意这里**不**过滤部署开关：那是 `enabledNotificationChannels()` 的职责（渠道自己的
 * `isConfigured`，fail-closed）。两件事分开——"有没有配置来源"vs"这台安装开没开"——
 * 才不会让一次开关误判变成"这台安装没有渠道"。
 */
export function buildPlatformNotificationChannels(config: PlatformChannelConfig): NotificationChannel[] {
  // **只给今天真有消费者的渠道**：email（SMTP）与 telegram（公告推送，WP18.5 的接线）。
  // webhook 不进这里 —— 领取它那些 URL 的调用者（事实类通知的投递触发器）还不存在；
  // 把"构造出来就被丢掉"的渠道塞进注册表，就是 Lead 说的"未接线出口"，
  // 下一个接手的人会以为它已经接上了（触发器 WP 立起来时与目标一起加回）。
  return [
    createEmailChannel(),
    createTelegramChannel({ sealedToken: () => config.telegram_sealed_token }),
  ];
}

/*
 * ── 这里**故意没有**"平台级渠道目标"的出口（Lead 2026-10-05 裁决）──
 *
 * 曾经有一个 `platformChannelTargets(config, "webhook")`：把配置里的 webhook URL 交出去，
 * 而**调用者不存在**（事实类通知的投递触发器还没立项）。Lead 的裁决是「给它一个调用者，
 * 或者删掉它」—— 留着的未接线出口，下一个接手的人很容易当成已接线。函数与它的测试都删了。
 *
 * `webhook_targets` 本身留在配置里，因为它是**加载器的产物（数据）**，不是出口：
 * 谁需要它，谁就在触发器 WP 里连同"哪些事实要送 webhook、多久送一次"一起决定。
 * 触发器 WP 的三件待办见契约 §12.4-D4。
 */
