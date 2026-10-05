/**
 * V5-WP18.5 —— 免打扰（契约 §F6.5）：**每用户 × 每渠道 × 每类别**的三元映射。
 *
 * ── 它与"静默期"不是一回事，也不允许变成第二套静默期 ──
 *  · **静默期**（`notification-delivery.ts`，Lead 裁决 O2）回答："**同一条事实**在这段时间里
 *    已经投过一次了，别再投一遍" —— 这是一条**速率**判据，键是
 *    `(scope, source_kind, source_id, reason_code)`，落 Redis，与"用户是谁"无关。
 *  · **免打扰**回答："这个**用户**不想在**这个渠道**收到**这一类**通知" —— 这是一条**偏好**，
 *    键是 `(user_id, channel_kind, category)`，落在 `notification_mute` 表。
 *
 * 两者是**互补**的，不是竞争关系：免打扰把"没有收件人"这件事提前说清楚（收件人解析阶段就
 * 把目标滤掉），静默期继续在投递层管速率。所以本模块**不**实现任何冷却/时间窗常量 ——
 * 那会让"什么时候不该打扰用户"出现第二份判据（正是本 WP 明令禁止的）。
 * 组合方式见 `createMuteAwareTargetResolver()`：它只替换
 * `DeliverNotificationDeps.resolveTargets`，投递层的静默期/账本/重试**一个字都没改**。
 *
 * ── 词表复用，不新造 ──
 * 渠道 = `NOTIFICATION_CHANNEL_KINDS`、类别 = `NOTIFICATION_SOURCE_KINDS`：都是既有闭集
 * （WP18.2 / WP18.1）。类别选"触发源"而不是另发明一套分类，是因为免打扰要回答的
 * 「这类通知」本来就等于通知的触发源；新造词表意味着两处映射迟早不一致。
 *
 * ── 只影响推送 ──
 * 本模块**不被** `announcement.ts` 的读取/已读路径引用（结构上：那些函数的入参里没有 mutes）。
 * 「用户静音了 email 的 announcement」不会让站内公告消失，也不会改变已读状态（F6.5）。
 */
import { NOTIFICATION_CHANNEL_KINDS } from "./notification-delivery.ts";
import type { NotificationChannel, NotificationChannelKind } from "./notification-delivery.ts";
import { NOTIFICATION_SOURCE_KINDS } from "./notification-facts.ts";
import type { NotificationFact, NotificationSourceKind } from "./notification-facts.ts";

/* ================================================================== */
/* 词表与三元映射                                                      */
/* ================================================================== */

/** 可静音的类别 = 通知触发源的封闭白名单（同一份，不做副本）。 */
export const NOTIFICATION_MUTE_CATEGORIES: readonly NotificationSourceKind[] = NOTIFICATION_SOURCE_KINDS;

/** 可静音的渠道 = 渠道封闭白名单（含本期尚未实现的 webhook/telegram：用户可以先表达偏好）。 */
export const NOTIFICATION_MUTE_CHANNELS: readonly NotificationChannelKind[] = NOTIFICATION_CHANNEL_KINDS;

export function isMuteChannelKind(value: unknown): value is NotificationChannelKind {
  return typeof value === "string" && (NOTIFICATION_CHANNEL_KINDS as readonly string[]).includes(value);
}

export function isMuteCategory(value: unknown): value is NotificationSourceKind {
  return typeof value === "string" && (NOTIFICATION_SOURCE_KINDS as readonly string[]).includes(value);
}

/** 一条免打扰偏好（存在 = 静音，不存在 = 不静音）。 */
export interface NotificationMute {
  channel_kind: NotificationChannelKind;
  category: NotificationSourceKind;
}

/** 三元组的规范串（纯函数比较用；落库的唯一索引是它的结构版本）。 */
export function muteKey(userId: number, channelKind: string, category: string): string {
  return `${userId}\u0000${channelKind}\u0000${category}`;
}

/**
 * 解析外部输入（路由的 JSON 边界）。**fail-closed**：
 * 未知渠道 / 未知类别 / 非字符串一律**拒绝整个请求**，不做"丢掉不认识的项就当成功"的降级
 * （C3）。重复项会被折成一条 —— 它表达的是同一个意图，不是错误。
 */
export function parseNotificationMutes(input: unknown):
  | { ok: true; mutes: NotificationMute[] }
  | { ok: false; reason: "not_an_array" | "unknown_channel_kind" | "unknown_category" } {
  if (!Array.isArray(input)) return { ok: false, reason: "not_an_array" };
  const seen = new Set<string>();
  const mutes: NotificationMute[] = [];
  for (const raw of input) {
    if (typeof raw !== "object" || raw === null) return { ok: false, reason: "unknown_channel_kind" };
    const channel = (raw as { channel_kind?: unknown }).channel_kind;
    const category = (raw as { category?: unknown }).category;
    if (!isMuteChannelKind(channel)) return { ok: false, reason: "unknown_channel_kind" };
    if (!isMuteCategory(category)) return { ok: false, reason: "unknown_category" };
    const key = muteKey(0, channel, category);
    if (seen.has(key)) continue;
    seen.add(key);
    mutes.push({ channel_kind: channel, category });
  }
  return { ok: true, mutes };
}

/** 某个用户是否静音了「这个渠道 × 这个类别」。 */
export function isMuted(
  mutes: readonly NotificationMute[],
  input: { channel_kind: string; category: string },
): boolean {
  return mutes.some((m) => m.channel_kind === input.channel_kind && m.category === input.category);
}

/* ================================================================== */
/* 收件人过滤（与 18.2 的组合点）                                       */
/* ================================================================== */

/**
 * 带用户的收件人。投递层的 `resolveTargets` 只返回 `string[]`（它不需要知道"这条地址属于谁"），
 * 而免打扰必须按**用户**判定 —— 于是本模块多要一个 `user_id`，
 * 由调用方在解析收件人时一起给出（谁是收件人本来就只有调用方知道，本层绝不猜）。
 */
export interface MuteRecipient {
  user_id: number;
  target: string;
}

/**
 * 按 `(渠道, 类别)` 过滤收件人。
 *
 * 入参是**按用户索引**的免打扰清单（不是"某一个人的清单"）：收件人带着 `user_id`，
 * 每个人的静音集合各不相同，拿一份清单去套所有人就会把"张三静音"变成"所有人都静音"。
 * 传空 Map = 没人静音 = 原样返回（调用方一次查全，避免逐条 round-trip）。
 */
export function filterRecipientsByMute(
  recipients: readonly MuteRecipient[],
  mutesByUser: ReadonlyMap<number, readonly NotificationMute[]>,
  channelKind: string,
  category: string,
): MuteRecipient[] {
  return recipients.filter(
    (recipient) => !isMuted(mutesForUser(mutesByUser, recipient.user_id), { channel_kind: channelKind, category }),
  );
}

/** 取某个用户的免打扰清单（供收件人解析方使用）。 */
export function mutesForUser(
  all: ReadonlyMap<number, readonly NotificationMute[]>,
  userId: number,
): readonly NotificationMute[] {
  return all.get(userId) ?? [];
}

/**
 * 免打扰感知的收件人解析器 —— **免打扰与投递层唯一的接触点**。
 *
 * 它接收一个"带 user_id 的收件人来源"，按 `(渠道, 类别)` 过滤后返回 `string[]`，
 * 其余一切（静默期、账本抢占、有界重试、失败留痕）完全交给
 * `deliverNotificationFacts()`。类别取 `fact.source_kind`：通知的类别本来就是它的触发源。
 *
 * 全部收件人都不投 ⇒ 返回空数组 ⇒ 投递层按既有语义记一条 `rejected_target` 失败行
 * （F4.6：失败可见）。**不**在这里把"全员静音"改写成"成功"或"静默跳过"：
 * 静默跳过会让账本显示"发过了"，而事实是没人收到。
 */
export function createMuteAwareTargetResolver(options: {
  recipients: (
    fact: NotificationFact,
    channel: NotificationChannel,
  ) => readonly MuteRecipient[] | Promise<readonly MuteRecipient[]>;
  /** 免打扰清单：按 user_id 索引（调用方一次查出，避免逐条 round-trip）。 */
  mutes: ReadonlyMap<number, readonly NotificationMute[]>;
}): (fact: NotificationFact, channel: NotificationChannel) => Promise<readonly string[]> {
  return async (fact, channel) => {
    const recipients = await options.recipients(fact, channel);
    return filterRecipientsByMute(recipients, options.mutes, channel.kind, fact.source_kind).map(
      (recipient) => recipient.target,
    );
  };
}

/* ================================================================== */
/* 持久化（注入的普通对象；不 import 生成的 Prisma client）             */
/* ================================================================== */

/** 落库行（本模块只认这三列）。 */
export interface NotificationMuteRow {
  user_id: number;
  channel_kind: string;
  category: string;
}

export interface NotificationMuteDb {
  notificationMute: {
    findMany(args: Record<string, unknown>): Promise<NotificationMuteRow[]>;
    deleteMany(args: Record<string, unknown>): Promise<unknown>;
    createMany(args: Record<string, unknown>): Promise<unknown>;
  };
}

export type MuteStoreResult<T> = { ok: true; value: T } | { ok: false; reason: "storage_error" };

/**
 * 读取免打扰清单。**库里出现不认识的行**（例如未来删掉某个类别值）时只忽略该行：
 * 它本来也匹配不上任何合法类别（`isMuted` 是逐字段相等比较），当成"没静音"与它的实际
 * 效果一致 —— 不是降级，而是它的真实语义。
 */
export async function loadUserMutes(
  db: NotificationMuteDb,
  userId: number,
): Promise<MuteStoreResult<NotificationMute[]>> {
  try {
    const rows = await db.notificationMute.findMany({
      where: { user_id: userId },
      select: { user_id: true, channel_kind: true, category: true },
      orderBy: { id: "asc" },
    });
    return { ok: true, value: rows.flatMap(toKnownMute) };
  } catch {
    return { ok: false, reason: "storage_error" };
  }
}

/** 批量读取（投递侧一次取全，按 user_id 建索引）。 */
export async function loadMutesByUserIds(
  db: NotificationMuteDb,
  userIds: readonly number[],
): Promise<MuteStoreResult<Map<number, NotificationMute[]>>> {
  const ids = [...new Set(userIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return { ok: true, value: new Map() };
  try {
    const rows = await db.notificationMute.findMany({
      where: { user_id: { in: ids } },
      select: { user_id: true, channel_kind: true, category: true },
    });
    const map = new Map<number, NotificationMute[]>();
    for (const row of rows) {
      const mute = toKnownMute(row)[0];
      if (!mute) continue;
      const list = map.get(row.user_id) ?? [];
      list.push(mute);
      map.set(row.user_id, list);
    }
    return { ok: true, value: map };
  } catch {
    return { ok: false, reason: "storage_error" };
  }
}

function toKnownMute(row: NotificationMuteRow): NotificationMute[] {
  if (!isMuteChannelKind(row.channel_kind) || !isMuteCategory(row.category)) return [];
  return [{ channel_kind: row.channel_kind, category: row.category }];
}

/**
 * 全量替换某个用户的免打扰清单。
 *
 * 顺序是**先删后建**，这是有意的：中途失败时用户会**暂时没有免打扰**（= 多报），
 * 而不是"留着旧的 + 新的"（= 少了该发的推送却以为自己静音着，甚至静音了以为没静音）。
 * 与 Lead 裁决 O2 同一条方向：抑制机制失效时应当**多报**。
 */
export async function replaceUserMutes(
  db: NotificationMuteDb,
  userId: number,
  mutes: readonly NotificationMute[],
): Promise<MuteStoreResult<NotificationMute[]>> {
  try {
    await db.notificationMute.deleteMany({ where: { user_id: userId } });
    if (mutes.length > 0) {
      await db.notificationMute.createMany({
        data: mutes.map((mute) => ({ user_id: userId, channel_kind: mute.channel_kind, category: mute.category })),
        skipDuplicates: true,
      });
    }
    return { ok: true, value: [...mutes] };
  } catch {
    return { ok: false, reason: "storage_error" };
  }
}
