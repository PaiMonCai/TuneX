/**
 * 通知偏好（免打扰）域的中英文案 + **只读判定**的纯函数（切片 N1）。
 *
 * ── 为什么不进 `@/lib/i18n/dictionaries.ts` ──
 * 与 `ddns-i18n.ts` / `node-health-i18n.ts` / `node-lifecycle-i18n.ts` 同一决策：并行分支
 * 各自持一份按码点的表，避免多人同一个大对象字面量上收口。`dictionaries.ts` 也不在本任务
 * 的写入范围内。
 *
 * ── 这个模块回答两件事，且都只陈述**后端今天的事实** ──
 *  ① "今天哪些类别真的会投递"（R4-A 的 G9）。6 个类别里今天只有 `announcement` 真的会投递：
 *     `node` / `forward` 的**派生**已有（`DERIVABLE_SOURCE_KINDS`），但事实类触发器
 *     **没有生产调用者**（`services/notification-facts-trigger.ts` 只被自己的测试引用）；另外
 *     三个类别连派生都没有。**不得**把 6 类渲染成等价可用 —— 那等于对用户说假话。
 *     ⚠️ 这里的映射是"接线事实的注解"，不是"可选值清单"：可选值**只**来自服务端下发的
 *     `categories`；服务端出现本表不认识的类别时按 `unknown` 渲染（如实说"不知道"），
 *     绝不隐藏、也绝不假装它可用。
 *  ② "哪些渠道是给人收的"。`webhook` 是机器通道，公告推送只走 email / telegram
 *     （`announcement-delivery.ts` 的 `ANNOUNCEMENT_CHANNEL_KINDS`），且 webhook 今天
 *     不在投递注册表里（`notification-channel-config.ts` 有意排除）。若将来 N3 把它纳入，
 *     本文件必须同步改 —— 注解漂移和撒谎是同一件事。
 */
import { interpolate } from "./i18n";
import type { Locale } from "./i18n";

/* ================================================================== */
/* 类别/渠道的投递状态（注解，来自后端接线事实）                          */
/* ================================================================== */

/**
 * 类别的投递状态闭集：
 *  · `live`            公告：今天**真的会**按偏好过滤推送；
 *  · `pending_wiring`  派生已有、投递触发器**未接线**（N3 才接）⇒ 保存后暂不产生推送；
 *  · `no_derivation`   连派生都没有 ⇒ 保存后不会产生推送；
 *  · `unknown`         服务端出现了本前端不认识的类别 ⇒ 一律说"不知道"，不做任何保证。
 */
export type NotificationCategoryDelivery = "live" | "pending_wiring" | "no_derivation" | "unknown";

/** 类别 → 投递状态。**只描述后端接线事实**，不是可选值清单（后者只来自服务端）。 */
export const NOTIFICATION_CATEGORY_DELIVERY: Record<string, NotificationCategoryDelivery> = {
  announcement: "live",
  node: "pending_wiring",
  forward: "pending_wiring",
  reconcile_finding: "no_derivation",
  workspace_event: "no_derivation",
  federation_event: "no_derivation",
};

export function categoryDelivery(category: string): NotificationCategoryDelivery {
  return NOTIFICATION_CATEGORY_DELIVERY[category] ?? "unknown";
}

/** 渠道角色：人收的渠道 / 机器通道 / 不认识。 */
export type NotificationChannelRole = "user_channel" | "machine_only" | "unknown";

export const NOTIFICATION_CHANNEL_ROLES: Record<string, NotificationChannelRole> = {
  email: "user_channel",
  telegram: "user_channel",
  webhook: "machine_only",
};

export function channelRole(channel: string): NotificationChannelRole {
  return NOTIFICATION_CHANNEL_ROLES[channel] ?? "unknown";
}

/* ================================================================== */
/* 文案                                                                */
/* ================================================================== */

/** 类别的展示名（未知类别回落到原始值，不隐藏）。 */
export interface NotificationText {
  cardTitle: string;
  cardSubtitle: string;
  /** 一句话讲清"这份偏好是什么、不是什么"。 */
  scopeNote: string;
  /** 明确否认"订阅"语义（本页不是订阅开关）。 */
  notSubscription: string;
  loading: string;
  /** 取不到（网络/存储）：**不等于**"全部未静音"。 */
  unavailableTitle: string;
  unavailableHint: string;
  retry: string;
  /** 可选值来自服务端（因此页面不会漂移）。 */
  closedSetHint: string;
  /** 服务端下发了空闭集（渠道或类别为空）：这不是"全部未静音"。 */
  emptyClosedSet: string;
  /** 服务端返回了本页无法表示的一条偏好（页面过期）：保存时原样保留，`{items}` 会被替换。 */
  unrepresentableHint: string;
  muted: string;
  unmuted: string;
  /** 开关的无障碍标签模板：`{channel}` × `{category}`。 */
  toggleLabel: string;
  save: string;
  saving: string;
  saved: string;
  /** 保存成功了，但这不等于"你会收到"。 */
  savedNotDelivered: string;
  unsavedHint: string;
  /** 400 与 503 是两件事：前者要刷新，后者可重试。 */
  rejectedTitle: string;
  rejectedHint: string;
  unavailableSaveTitle: string;
  unavailableSaveHint: string;
  /** 权限/未知失败时的兜底说明。 */
  failedFallback: string;
  unknownCategory: string;
  unknownChannel: string;
  categoryDeliveryTitle: Record<NotificationCategoryDelivery, string>;
  categoryDeliveryNote: Record<NotificationCategoryDelivery, string>;
  channelRoleTitle: Record<NotificationChannelRole, string>;
  channelRoleNote: Record<NotificationChannelRole, string>;
  /** 逐渠道的补充说明（只对已知渠道；未知渠道走 channelRoleNote.unknown）。 */
  channelExtraNote: Record<string, string>;
  /** 类别 → 展示名（未知类别不在此表）。 */
  categoryLabel: Record<string, string>;
  /** 渠道 → 展示名（未知渠道不在此表）。 */
  channelLabel: Record<string, string>;
  /** 错误码 → 人话；未知码原样回落后端 message。 */
  errors: Record<string, string>;
}

const zh: NotificationText = {
  cardTitle: "通知偏好",
  cardSubtitle: "按「类别 × 渠道」决定哪些推送不要打扰你。",
  scopeNote:
    "这是**你个人的**偏好，跨所有工作空间生效（不属于某一个空间，切换空间不会改变它）。",
  notSubscription:
    "本页只表达「不要打扰我」：静音 = 这类通知不在这个渠道推给你；不静音 ≠ 一定会收到（渠道是否可用、你能不能收到都由平台侧配置与你的个人资料决定）。",
  loading: "正在读取通知偏好…",
  unavailableTitle: "取不到通知偏好",
  unavailableHint:
    "这不代表「你什么都没静音」，也不代表一切正常：面板没读到你的偏好，所以这里不显示任何开关状态。请重试。",
  retry: "重试",
  closedSetHint: "下面的渠道与类别就是服务端当前下发的可选值（本页不硬编码一份会漂移的副本）。",
  emptyClosedSet:
    "服务端没有下发可选的渠道或类别：这不代表「你什么都没静音」，也不代表通知功能不可用——请刷新或联系平台管理员。",
  unrepresentableHint:
    "服务端返回了本页无法显示的一条偏好（{items}）：保存时它会按原样保留，但本页不给它画开关（页面上的可选值可能已过期）。",
  muted: "已静音",
  unmuted: "未静音",
  toggleLabel: "{channel}：将「{category}」静音",
  save: "保存偏好",
  saving: "正在保存…",
  saved: "偏好已保存",
  savedNotDelivered:
    "保存成功只代表服务端记下了这份偏好：它不会让尚未接线的类别开始推送，也不会让未开启的渠道变得可用。",
  unsavedHint: "有未保存的更改。",
  rejectedTitle: "服务端不接受这份偏好（未保存）",
  rejectedHint:
    "这通常意味着页面上的可选值已经过期（服务端改过渠道/类别清单）。请刷新后重新选择——面板不会替你丢掉不认识的项。",
  unavailableSaveTitle: "保存失败：偏好存储暂时不可用（未保存）",
  unavailableSaveHint: "服务端没能写入，你的偏好保持原样。可以稍后重试。",
  failedFallback: "保存请求失败",
  unknownCategory: "未知类别",
  unknownChannel: "未知渠道",
  categoryDeliveryTitle: {
    live: "今天会投递",
    pending_wiring: "尚未接线",
    no_derivation: "尚未实现",
    unknown: "状态未知",
  },
  categoryDeliveryNote: {
    live: "服务端已有这类通知的投递接线（公告发布后按这里的偏好过滤推送）；能不能真的送达还取决于渠道是否开启。",
    pending_wiring: "服务端已有这类通知的派生，但投递触发器尚未接线：现在保存偏好不会产生推送。",
    no_derivation: "服务端还没有这类通知的派生：现在保存偏好不会产生推送。",
    unknown: "本页不认识服务端给出的这个类别（可能是新版本新增的）：不做任何保证，也无法说明它是否会推送。",
  },
  channelRoleTitle: {
    user_channel: "面向你",
    machine_only: "机器通道",
    unknown: "状态未知",
  },
  channelRoleNote: {
    user_channel: "这类渠道是发给人的；是否可用取决于平台侧的渠道配置。",
    machine_only: "这类渠道是给机器消费的端点，不参与面向你的推送（公告只走邮件与 Telegram）。",
    unknown: "本页不认识服务端给出的这个渠道（可能是新版本新增的）：无法说明它会不会投递。",
  },
  channelExtraNote: {
    email: "邮件渠道是否可用取决于平台侧的 SMTP 配置。",
    telegram:
      "Telegram 是否真的能送达，取决于你在个人资料里填写的 tg_id（该字段是自由填写、**未经校验**）以及平台是否开启 Telegram 渠道；本页不会因为你填了 tg_id 就把它当作已验证的绑定。",
    webhook: "后端有意未把 webhook 接入投递注册表（今天没有消费者）。",
  },
  categoryLabel: {
    node: "节点",
    forward: "转发",
    reconcile_finding: "对账发现",
    workspace_event: "工作空间事件",
    federation_event: "联邦事件",
    announcement: "公告",
  },
  channelLabel: {
    email: "邮件",
    telegram: "Telegram",
    webhook: "Webhook",
  },
  errors: {
    unknown_channel_kind: "服务端不认识其中的渠道（页面可能已过期），整个请求被拒绝。",
    unknown_category: "服务端不认识其中的类别（页面可能已过期），整个请求被拒绝。",
    not_an_array: "请求形状不合法（偏好必须是一个清单），整个请求被拒绝。",
    storage_error: "偏好存储暂时不可用，这次没有写入。",
  },
};

const en: NotificationText = {
  cardTitle: "Notification preferences",
  cardSubtitle: "Decide, per category and channel, which pushes should not reach you.",
  scopeNote: "These are your personal preferences and apply across every workspace (they are not a per-workspace setting).",
  notSubscription:
    "This page only expresses “do not disturb me”: muted means that category is not pushed to you on that channel; unmuted does not mean you will receive anything (channel availability and delivery depend on the platform configuration and your profile).",
  loading: "Loading notification preferences…",
  unavailableTitle: "Could not load notification preferences",
  unavailableHint:
    "This does not mean “nothing is muted”, and it is not an all-clear: the panel could not read your preferences, so no switch state is shown. Please retry.",
  retry: "Retry",
  closedSetHint: "The channels and categories below are exactly what the server advertises (no drifting hard-coded copy here).",
  emptyClosedSet:
    "The server returned no selectable channels or categories: that does not mean “nothing is muted”, and it does not mean notifications are unavailable — refresh or ask the platform admin.",
  unrepresentableHint:
    "The server returned a preference this page cannot show ({items}): saving keeps it as-is, but no switch is drawn for it (the page's selectable values may be stale).",
  muted: "Muted",
  unmuted: "Not muted",
  toggleLabel: "{channel}: mute “{category}”",
  save: "Save preferences",
  saving: "Saving…",
  saved: "Preferences saved",
  savedNotDelivered:
    "Saving only records the preference on the server: it does not start pushing categories that are not wired yet, and it does not enable a channel that is off.",
  unsavedHint: "You have unsaved changes.",
  rejectedTitle: "The server rejected these preferences (nothing was saved)",
  rejectedHint:
    "This usually means the page's selectable values are stale (the server changed its channel/category list). Refresh and choose again — the panel will not silently drop values it does not recognise.",
  unavailableSaveTitle: "Save failed: the preference store is temporarily unavailable (nothing was saved)",
  unavailableSaveHint: "The server could not write; your preferences are unchanged. You can retry later.",
  failedFallback: "The save request failed",
  unknownCategory: "Unknown category",
  unknownChannel: "Unknown channel",
  categoryDeliveryTitle: {
    live: "Delivered today",
    pending_wiring: "Not wired yet",
    no_derivation: "Not implemented",
    unknown: "Unknown state",
  },
  categoryDeliveryNote: {
    live: "The server has the delivery wiring for this category (announcements are filtered by these preferences); actual delivery still depends on the channel being enabled.",
    pending_wiring: "The server derives this kind of notification, but the delivery trigger is not wired yet: saving a preference produces no push today.",
    no_derivation: "The server does not derive this kind of notification yet: saving a preference produces no push today.",
    unknown: "This page does not know the category the server returned (possibly added by a newer version): no guarantees, and it cannot say whether it will be pushed.",
  },
  channelRoleTitle: {
    user_channel: "For people",
    machine_only: "Machine channel",
    unknown: "Unknown state",
  },
  channelRoleNote: {
    user_channel: "This kind of channel is for people; availability depends on the platform-level channel configuration.",
    machine_only: "This kind of channel is consumed by machines and is not part of what is pushed to you (announcements go to email and Telegram only).",
    unknown: "This page does not know the channel the server returned (possibly added by a newer version): it cannot say whether it will deliver.",
  },
  channelExtraNote: {
    email: "Whether the email channel works depends on the SMTP configuration on the platform side.",
    telegram:
      "Whether Telegram really delivers depends on the tg_id in your profile (a free-form, unverified field) and on whether the platform enabled the Telegram channel; filling in tg_id does not make this page treat it as a verified binding.",
    webhook: "The backend deliberately keeps webhook out of the delivery registry (it has no consumer today).",
  },
  categoryLabel: {
    node: "Nodes",
    forward: "Forwards",
    reconcile_finding: "Reconcile findings",
    workspace_event: "Workspace events",
    federation_event: "Federation events",
    announcement: "Announcements",
  },
  channelLabel: {
    email: "Email",
    telegram: "Telegram",
    webhook: "Webhook",
  },
  errors: {
    unknown_channel_kind: "The server does not recognise one of the channels (the page may be stale); the whole request was rejected.",
    unknown_category: "The server does not recognise one of the categories (the page may be stale); the whole request was rejected.",
    not_an_array: "Malformed request (preferences must be a list); the whole request was rejected.",
    storage_error: "The preference store is temporarily unavailable; nothing was written.",
  },
};

/** 供测试断言两端键集一致。 */
export const NOTIFICATION_DICTS = { zh, en } as const;

export function notificationText(locale: Locale): NotificationText {
  return locale === "en" ? en : zh;
}

/** 已知错误码全集（服务端 `code` 字段）。 */
export const NOTIFICATION_KNOWN_ERRORS = Object.keys(zh.errors);

/**
 * 错误码 → 人话。未知码/无码时**原样回落**（`fallback` 通常是服务端 message），
 * 绝不编造更具体的理由，也绝不显示成成功。
 */
export function notificationErrorText(locale: Locale, code: string | null | undefined, fallback: string): string {
  const table = notificationText(locale).errors;
  if (code && Object.prototype.hasOwnProperty.call(table, code)) return table[code];
  return fallback;
}

/** 类别的展示名（未知类别回落到原始值 —— 不隐藏、也不假装认识）。 */
export function categoryLabel(locale: Locale, category: string): string {
  const table = notificationText(locale).categoryLabel;
  return Object.prototype.hasOwnProperty.call(table, category) ? table[category] : category;
}

/** 渠道的展示名（未知渠道同上）。 */
export function channelLabel(locale: Locale, channel: string): string {
  const table = notificationText(locale).channelLabel;
  return Object.prototype.hasOwnProperty.call(table, channel) ? table[channel] : channel;
}

/** 类别的投递状态 + 标注（标题 + 为什么）。 */
export function categoryDeliveryCopy(
  locale: Locale,
  category: string,
): { state: NotificationCategoryDelivery; title: string; note: string } {
  const text = notificationText(locale);
  const state = categoryDelivery(category);
  return { state, title: text.categoryDeliveryTitle[state], note: text.categoryDeliveryNote[state] };
}

/** 渠道的角色 + 标注（已知渠道再补一句渠道特有的说明）。 */
export function channelDeliveryCopy(
  locale: Locale,
  channel: string,
): { role: NotificationChannelRole; title: string; note: string } {
  const text = notificationText(locale);
  const role = channelRole(channel);
  const extra = Object.prototype.hasOwnProperty.call(text.channelExtraNote, channel)
    ? text.channelExtraNote[channel]
    : null;
  const base = text.channelRoleNote[role];
  return { role, title: text.channelRoleTitle[role], note: extra ? `${base} ${extra}` : base };
}

/** 开关的无障碍标签（`{channel}` × `{category}`）。 */
export function muteToggleLabel(locale: Locale, channel: string, category: string): string {
  return interpolate(notificationText(locale).toggleLabel, {
    channel: channelLabel(locale, channel),
    category: categoryLabel(locale, category),
  });
}
