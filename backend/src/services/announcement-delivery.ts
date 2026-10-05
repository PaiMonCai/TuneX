/**
 * V5-WP18.5 —— 公告的**投递接线**（契约 §12.3-D10 / D1 裁决 = (b)）。
 *
 * ── 这一层为什么存在，以及它**不**做什么 ──
 * Lead 的裁决是两句话同时成立的：
 *   ① 公告**不是** `NotificationFact`（真相在公告表，不是 attention 的派生，F2-N6）；
 *   ② 公告**必须走同一本账本、同一套免打扰与静默判据**，不得开第二条投递路径。
 * 唯一能同时满足的做法在 `notification-delivery.ts` 里：把投递层的入参从
 * `NotificationFact` 放宽成 `DeliverableNotification`（前者是后者的超集）。
 * 所以本文件**不实现任何投递逻辑**：没有自己的重试、没有自己的账本、没有自己的静默期、
 * 没有自己的渠道开关判定 —— 它只做三件事：
 *   · 把一条公告翻译成"可投递形状"（含幂等键，用 `notification-facts.ts` 的**同一个**算法）；
 *   · 把"给谁发"翻译成**带 user_id 的收件人**（本层绝不猜收件人，见下）；
 *   · 调 `deliverNotificationFacts()` 一次，并把**本安装真正打开的渠道**显式传给它。
 *
 * ── "本安装真正打开的渠道"（Lead 的硬要求）──
 * 不用 `defaultNotificationChannels()`：那个注册表回答"支持哪些渠道"，未配置的会被投递层
 * 记一条 `not_configured` 失败行 —— 一次公告就变成"1 条 sent + 2 条 not_configured"，
 * 把"失败可见"稀释成噪音。这里用 `enabledNotificationChannels()`（渠道自己的 `isConfigured`，
 * fail-closed），再按 `ANNOUNCEMENT_CHANNEL_KINDS` 收窄（理由见该常量）。
 *
 * ── 收件人 = 读侧受众（F6.2 的同一口径，不另造一套）──
 * 公告的推送受众就是**它可见的受众**：平台公告 → 全体活跃用户；租户公告 → 该 workspace 的
 * 活跃成员。目标按**渠道**从用户自己身上取（email / `tg_id`），因此"未绑定 telegram 的用户"
 * 自然没有目标（WP18.4 的"未绑定 = 不投递"在这条路径上自动成立，不需要再写一遍）。
 * 免打扰是 (用户 × 渠道 × 类别) 的偏好，两个渠道都是"给人"的，所以**每个渠道都过 DND**。
 */
import {
  createPrismaLedgerStore,
  deliverNotificationFacts,
  enabledNotificationChannels,
  type DeliverableNotification,
  type NotificationChannel,
  type NotificationChannelKind,
  type NotificationCooldownStore,
  type NotificationLedgerStore,
  type NotificationOutcome,
  type RenderedNotification,
} from "./notification-delivery.ts";
import {
  cooldownSecondsForReason,
  notificationDedupeKey,
  notificationWindowStartMs,
  type NotificationScope,
} from "./notification-facts.ts";
import {
  buildPlatformNotificationChannels,
  loadPlatformChannelConfig,
  type NotificationChannelConfigDb,
} from "./notification-channel-config.ts";
import { isMuted, loadMutesByUserIds, type NotificationMute, type NotificationMuteDb } from "./announcement-mute.ts";
import { renderAnnouncementText } from "./announcement.ts";

/* ================================================================== */
/* 原因码：公告自己的码空间（不进 attention 的词表）                     */
/* ================================================================== */

/**
 * 公告投递用的原因码。**故意不是 `AttentionReasonCode`**：
 * attention 的码表回答"人和机器要处理什么"，公告不是待办事项（这就是 D1 裁决 (b) 的实质）。
 * 自己一份、只用于幂等键与账本列；静默期按 `cooldownSecondsForReason` 的既定行为回落默认值
 * （30 分钟，契约 O2 的"其余"一档）—— **不新造一套时长**。
 */
export const ANNOUNCEMENT_NOTIFICATION_REASON_CODES = ["announcement_published"] as const;
export type AnnouncementNotificationReasonCode = (typeof ANNOUNCEMENT_NOTIFICATION_REASON_CODES)[number];
export const ANNOUNCEMENT_PUBLISHED: AnnouncementNotificationReasonCode = "announcement_published";

/* ================================================================== */
/* 可投递形状                                                         */
/* ================================================================== */

/**
 * 一条公告的可投递形态：投递层要的字段（`DeliverableNotification`）+ 渲染要的正文。
 * 正文放在这里而不是塞进 `resource_name`：账本列只描述投递，正文属于渲染输入。
 */
export interface AnnouncementDeliverable extends DeliverableNotification {
  readonly announcement_type: string;
  readonly title: string;
  readonly body: string;
}

/**
 * 喂进投递接线的最小来源形状。**行与视图都满足它**（`published_at` 收 `Date | string`）：
 * 路由手里是落库后返回的**视图**（ISO 串），worker 手里可能是行（`Date`）——
 * 让两种调用点都能直接用，比让调用方各自 `new Date(...)` 再传更少出错。
 */
export interface AnnouncementDeliverySource {
  readonly id: number;
  readonly type: string;
  readonly title: string;
  readonly body: string;
  readonly published_at: Date | string;
}

function sourcePublishedAt(row: AnnouncementDeliverySource): Date {
  const at = row.published_at instanceof Date ? row.published_at : new Date(row.published_at);
  if (Number.isNaN(at.getTime())) {
    // 调用方的编程错误（与 `workspaceNotificationScope` 对坏 id 抛错同一取向）：静默当成
    // "刚刚发布"会让幂等键每次都变，反而更难查。
    throw new Error("announcement delivery: published_at is not a valid date");
  }
  return at;
}

/**
 * 公告 → 可投递形状（纯函数）。幂等键与时间窗用 `notification-facts.ts` 的**同一套算法**：
 * 换一份实现就等于"同一件事有两个键"，账本的唯一索引随即失效。
 *
 * `severity` 固定 `info`：公告不是告警；它的重要程度由 `type="popup"` 表达，
 * **不**为公告另造一份严重度词表（那又会是一处两套判定）。
 */
export function announcementDeliverable(
  row: AnnouncementDeliverySource,
  scope: NotificationScope,
): AnnouncementDeliverable {
  const reasonCode = ANNOUNCEMENT_PUBLISHED;
  const publishedAt = sourcePublishedAt(row);
  const occurredAtMs = publishedAt.getTime();
  const windowStartMs = notificationWindowStartMs(occurredAtMs, cooldownSecondsForReason(reasonCode));
  const sourceId = String(row.id);
  return {
    scope,
    source_kind: "announcement",
    source_id: sourceId,
    reason_code: reasonCode,
    severity: "info",
    resource_type: "announcement",
    resource_id: sourceId,
    resource_name: row.title,
    occurred_at: publishedAt.toISOString(),
    window_start: new Date(windowStartMs).toISOString(),
    dedupe_key: notificationDedupeKey({
      scope,
      source_kind: "announcement",
      source_id: sourceId,
      reason_code: reasonCode,
      window_start_ms: windowStartMs,
    }),
    detail_code: null,
    announcement_type: row.type,
    title: row.title,
    body: row.body,
  };
}

/** 公告的渲染器（纯文本；与站内展示同源，前端与邮件不会各说一套）。 */
export function renderAnnouncementDelivery(item: AnnouncementDeliverable): RenderedNotification {
  return renderAnnouncementText({
    title: item.title,
    body: item.body,
    type: item.announcement_type,
    published_at: new Date(item.occurred_at),
  });
}

/* ================================================================== */
/* 渠道：哪些渠道"参与公告"                                             */
/* ================================================================== */

/**
 * 参与公告投递的渠道类型。
 *
 * 只列**"给人"**的两个：email 与 telegram —— 它们的目标都来自**某个用户**自己
 * （邮箱 / `tg_id`），所以免打扰 `(用户 × 渠道 × 类别)` 在它们身上语义成立。
 * `webhook` **不列**：它是机器通道（URL 属于运维，不属于任何用户），把用户的免打扰套在一个
 * 运维端点上没有意义；而且它的目标来自 `notification_channel` 表，与"发给谁"是两回事。
 * 这条取舍写进了契约 §12.3-D11 请 Lead 定夺（若要给 webhook 也发公告，那是给运维看的订阅，
 * 应当单列"平台级渠道受众"，而不是混进用户偏好）。
 */
export const ANNOUNCEMENT_CHANNEL_KINDS: readonly NotificationChannelKind[] = ["email", "telegram"];

/**
 * 本次投递实际要用的渠道：**本安装已打开** ∩ **参与公告的**。
 * 空数组 = 这台安装没有任何可用的公告渠道 ⇒ 不投递（调用方留一条告警，站内公告照常可见）。
 */
export function announcementChannels(
  channels: readonly NotificationChannel[] = enabledNotificationChannels(),
): NotificationChannel[] {
  return channels.filter((channel) => ANNOUNCEMENT_CHANNEL_KINDS.includes(channel.kind));
}

/* ================================================================== */
/* 收件人：读侧受众 + 每渠道目标                                        */
/* ================================================================== */

/**
 * 收件人上限。**超限 = 不投递**（不是截断）：
 * 截断会让"发了"变成"发了一部分"而不留任何信号（账本显示 sent），那是谎；
 * 而不推送只是"这次没走邮件"，公告本身对所有人照常可见（站内），以及时延最坏是"下一次"。
 * 数值取 1000 是**保守的初始值**：平台公告是全体广播，一次 SMTP 会话里塞几千封既拖长
 * 请求也不可控；要放开应当先有分批投递的设计，而不是把上限调大。
 */
export const ANNOUNCEMENT_RECIPIENT_MAX = 1_000;

/** 一个收件人：目标按渠道从这个用户身上取（本层不拼、不猜）。 */
export interface AnnouncementRecipient {
  user_id: number;
  email: string | null;
  tg_id: string | null;
}

export interface AnnouncementAudienceDb {
  /** 租户公告受众：该 workspace 的活跃成员。 */
  workspaceMember: {
    findMany(args: Record<string, unknown>): Promise<Array<{ user_id: number }>>;
  };
  /** 平台公告受众：活跃用户。 */
  user: {
    findMany(args: Record<string, unknown>): Promise<Array<{ id: number; email: string | null; tg_id: string | null }>>;
  };
}

export type AnnouncementAudienceResult =
  | { ok: true; recipients: AnnouncementRecipient[] }
  | { ok: false; reason: "audience_too_large" | "storage_error" };

function toRecipient(user: { id: number; email: string | null; tg_id: string | null }): AnnouncementRecipient {
  const email = typeof user.email === "string" && user.email.trim() !== "" ? user.email.trim() : null;
  const tgId = typeof user.tg_id === "string" && user.tg_id.trim() !== "" ? user.tg_id.trim() : null;
  return { user_id: user.id, email, tg_id: tgId };
}

/**
 * 平台公告受众 = **全体活跃用户**（与读侧可见性同口径：平台公告对所有人可见）。
 * 只取 `status="active"`：停用账号不该收到广播（与登录判定同一取向），且这**不是**新造判据 ——
 * `User.status` 是既有列那个"这个账号还能不能用"的答案。
 */
export async function platformAnnouncementAudience(
  db: AnnouncementAudienceDb,
): Promise<AnnouncementAudienceResult> {
  try {
    const rows = await db.user.findMany({
      where: { status: "active" },
      select: { id: true, email: true, tg_id: true },
      orderBy: { id: "asc" },
      take: ANNOUNCEMENT_RECIPIENT_MAX + 1,
    });
    if (rows.length > ANNOUNCEMENT_RECIPIENT_MAX) return { ok: false, reason: "audience_too_large" };
    return { ok: true, recipients: rows.map(toRecipient) };
  } catch {
    return { ok: false, reason: "storage_error" };
  }
}

/** 租户公告受众 = **该 workspace 的活跃成员**（与读侧可见性同口径：只有他们看得见）。 */
export async function workspaceAnnouncementAudience(
  db: AnnouncementAudienceDb,
  workspaceId: number,
): Promise<AnnouncementAudienceResult> {
  try {
    const rows = await db.workspaceMember.findMany({
      where: { workspace_id: workspaceId, active: true },
      select: { user_id: true },
      orderBy: { user_id: "asc" },
      take: ANNOUNCEMENT_RECIPIENT_MAX + 1,
    });
    if (rows.length > ANNOUNCEMENT_RECIPIENT_MAX) return { ok: false, reason: "audience_too_large" };
    const userIds = [...new Set(rows.map((row) => row.user_id).filter((id) => Number.isInteger(id) && id > 0))];
    if (userIds.length === 0) return { ok: true, recipients: [] };
    const users = await db.user.findMany({
      where: { id: { in: userIds }, status: "active" },
      select: { id: true, email: true, tg_id: true },
    });
    return { ok: true, recipients: users.map(toRecipient) };
  } catch {
    return { ok: false, reason: "storage_error" };
  }
}

/* ================================================================== */
/* 投递编排（只有一次调用：投递层的那一次）                              */
/* ================================================================== */

export interface DeliverAnnouncementInput {
  row: AnnouncementDeliverySource;
  scope: NotificationScope;
  recipients: readonly AnnouncementRecipient[];
  /** 免打扰清单：按 user_id 索引（调用方一次查出，避免逐条 round-trip）。 */
  mutes: ReadonlyMap<number, readonly NotificationMute[]>;
}

export interface AnnouncementDeliveryDeps {
  ledger: NotificationLedgerStore;
  /** 默认平台 Redis（`deliverNotificationFacts` 的默认值）。 */
  cooldown?: NotificationCooldownStore;
  /** 默认 `announcementChannels()`（本安装已打开 ∩ 参与公告的渠道）。 */
  channels?: readonly NotificationChannel[];
  degradedCooldown?: (key: string, ttlSeconds: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onWarn?: (message: string, err?: unknown) => void;
}

const CATEGORY: "announcement" = "announcement";

/**
 * 投递一条公告。**它只是一次 `deliverNotificationFacts()` 调用** ——
 * 静默期、账本抢占、有界重试、失败留痕全部沿用 18.2 的实现（"不得开第二条投递路径"的证据
 * 就是这条：本函数里没有任何一次 `channel.send` / 没有任何账本写入）。
 *
 * 收件人解析：按渠道类型从用户身上取目标 ——
 *  · email → 用户邮箱；telegram → `tg_id`（未绑定 = 没有目标，WP18.4 的语义自动成立）；
 *  · 两者都先过免打扰（`(user, channel, announcement)`）；
 *  · 渠道形状校验仍由渠道自己（`validateConfig`）做 —— 本层不复制第二套地址校验。
 */
export async function deliverAnnouncement(
  deps: AnnouncementDeliveryDeps,
  input: DeliverAnnouncementInput,
): Promise<NotificationOutcome[]> {
  const warn = deps.onWarn ?? ((message: string) => console.warn(`[announcement-delivery] ${message}`));
  const channels = deps.channels ?? announcementChannels();
  if (channels.length === 0) {
    // 没有任何打开的公告渠道：**不投递、也不留 not_configured 噪音行**，只留一句告警。
    warn("本安装没有打开任何公告渠道，公告仅站内可见");
    return [];
  }
  if (input.recipients.length === 0) {
    warn("公告受众为空，不投递（公告仍站内可见）");
    return [];
  }

  const deliverable = announcementDeliverable(input.row, input.scope);

  return deliverNotificationFacts([deliverable], {
    ledger: deps.ledger,
    channels,
    cooldown: deps.cooldown,
    degradedCooldown: deps.degradedCooldown,
    sleep: deps.sleep,
    random: deps.random,
    onWarn: deps.onWarn,
    // 渲染器忽略入参：投递层回传的就是上面那一条 `deliverable` 本身
    // （`render` 的签名只承诺 `DeliverableNotification`，公告正文不在那个结构里，
    //   所以用闭包而不是把正文塞进共享类型 —— 共享类型不该认识公告的字段）。
    render: () => renderAnnouncementDelivery(deliverable),
    resolveTargets: (_deliverable, channel) => {
      const targets: string[] = [];
      for (const recipient of input.recipients) {
        if (isMuted(input.mutes.get(recipient.user_id) ?? [], { channel_kind: channel.kind, category: CATEGORY })) {
          continue;
        }
        const target = channel.kind === "telegram" ? recipient.tg_id : recipient.email;
        if (target !== null) targets.push(target);
      }
      return targets;
    },
  });
}

/* ================================================================== */
/* 生产入口：发布公告后触发（fire-and-forget，永不抛出）                  */
/* ================================================================== */

export interface AnnouncementPublishDb extends AnnouncementAudienceDb, NotificationMuteDb, NotificationChannelConfigDb {}

export interface PublishDeliveryOptions {
  row: AnnouncementDeliverySource;
  scope: NotificationScope;
  onWarn?: (message: string, err?: unknown) => void;
}

/**
 * 发布公告后的投递入口（路由调用它，**不 await**：投递失败绝不拖挂发布本身，
 * 与 `mail.ts`/`audit.ts` 同一取向）。
 *
 * 顺序：解析受众 → 一次查全免打扰 → 交给 `deliverAnnouncement`。任何一步失败都收敛成
 * 一句告警（公告已经落库、站内已可见 —— 投递只是旁路）。
 */
export async function deliverAnnouncementOnPublish(
  db: AnnouncementPublishDb,
  options: PublishDeliveryOptions,
  /**
   * 投递依赖的可选覆盖（**只为测试与将来的接线**）：生产调用点不传 ⇒ 用默认
   * （平台 Redis + Prisma 账本 + `announcementChannels()`）。有了它，"免打扰读失败仍照发"
   * 这类断言才能真实跑完整条路径，而不是靠"渠道恰好没配"绕过去。
   */
  overrides: Partial<AnnouncementDeliveryDeps> = {},
): Promise<NotificationOutcome[]> {
  const warn = options.onWarn ?? ((message: string) => console.warn(`[announcement-delivery] ${message}`));
  try {
    const audience =
      options.scope.kind === "platform"
        ? await platformAnnouncementAudience(db)
        : await workspaceAnnouncementAudience(db, options.scope.workspace_id);
    if (!audience.ok) {
      warn(`公告受众解析失败（${audience.reason}），本次不投递（公告仍站内可见）`);
      return [];
    }

    // 渠道实例从 F5 的 `notification_channel` 行接上（WP18.6 的加载器）：接上之后
    // "配置了 telegram 行"才会让 telegram 真的进入投递 —— 在那之前
    // `createTelegramChannel()` 的 `sealedToken` 恒为 null，渠道永远"未配置"。
    // 读不到配置时**不假装有渠道**（fallback 到"只有部署级 gate 能判定的渠道"），
    // 因为把读取失败说成"这台安装没配渠道"同样是一次谎。
    const config = await loadPlatformChannelConfig(db);
    const configuredChannels = config.ok
      ? announcementChannels(enabledNotificationChannels(buildPlatformNotificationChannels(config.value)))
      : undefined;
    if (!config.ok) warn("渠道配置读取失败，按「只有部署级 gate 能判定的渠道」继续");

    const mutes = await loadMutesByUserIds(db, audience.recipients.map((r) => r.user_id));
    if (!mutes.ok) {
      // 免打扰读不到 = **不知道谁静音了**。方向按 O2 的裁决：抑制机制失效时**多报**
      // —— 当成"没人静音"照发，而不是当成"全都静音"而静默丢弃。
      warn("免打扰清单读取失败，按「没人静音」继续（O2 的 fail 方向：宁可多报）");
    }

    return await deliverAnnouncement(
      {
        ledger: overrides.ledger ?? createPrismaLedgerStore(),
        // 渠道由上面的 F5 加载器给出；调用方仍可用 overrides 覆盖（测试 / 将来的接线）。
        ...(configuredChannels === undefined ? {} : { channels: configuredChannels }),
        ...overrides,
        onWarn: options.onWarn,
      },
      {
        row: options.row,
        scope: options.scope,
        recipients: audience.recipients,
        mutes: mutes.ok ? mutes.value : new Map(),
      },
    );
  } catch (err) {
    // 兜底：投递是旁路，任何异常都不许冒泡到发布接口。
    warn("公告投递出现未预期异常（发布本身不受影响）", err);
    return [];
  }
}
