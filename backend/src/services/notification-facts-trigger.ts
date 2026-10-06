/**
 * Notification fact selection and delivery orchestration.
 *
 * The pure selection step turns persisted attention facts into deliverable facts
 * without loading data, sending messages, writing the ledger or reading cooldown
 * state. Source timestamps, not scan time, drive dedupe identity so a continuing
 * fault does not become a new notification on every reconcile pass. Delivery is
 * injected and remains on the shared notification path.
 */
import type { AttentionItem } from "./attention.ts";
import {
  buildNotificationFact,
  workspaceNotificationScope,
  type NotificationFactSeed,
  type NotificationScope,
} from "./notification-facts.ts";
import {
  deliverNotificationFacts,
  type DeliverableNotification,
  type NotificationChannel,
  type NotificationChannelKind,
  type NotificationTargetResolver,
} from "./notification-delivery.ts";
// 受众解析与免打扰都**复用公告那一套**：同一件事不做第二份实现（"谁在这个空间里"、
// "这个人静音了什么"各只有一个答案）。
import {
  ANNOUNCEMENT_CHANNEL_KINDS,
  platformAnnouncementAudience,
  workspaceAnnouncementAudience,
} from "./announcement-delivery.ts";
import { isMuted, loadMutesByUserIds, type NotificationMute } from "./announcement-mute.ts";
import type { NotificationChannelConfigDb } from "./notification-channel-config.ts";

/**
 * E 类的理由码（取自既有词表 `AttentionReasonCode`，不是新造的字符串）。
 *
 * 用常量而不是散落的字面量：这个值同时决定"哪些 attention 条目会变成通知"，
 * 而"通知范围悄悄变大"是这类系统里最难在事后发现的问题之一。
 */
export const FORWARD_DENIAL_REASON = "forward_apply_error" as const;

/** 被跳过的事实 + 原因（跳过必须**可解释**，否则等于静默丢弃）。 */
export interface SkippedDenialFact {
  readonly forward_id: number;
  readonly reason: "occurred_at_unavailable";
}

export interface SelectResult {
  readonly seeds: NotificationFactSeed[];
  readonly skipped: SkippedDenialFact[];
}

/**
 * 从既有 attention 条目里选出 E 类事实。
 *
 * `occurredAtOf` 由调用方从**来源表**提供（`tunnel.updated_at`）。为什么不让本函数自己取
 * "现在"：`NotificationFactSeed.occurred_at` 参与幂等键，而**用扫描时刻会让时间窗每扫一次
 * 前进一格** —— 一条持续存在的故障就会变成每拍一条新通知，静默期形同虚设（契约 DoD3 的反例，
 * 原文写在 `notification-facts.ts` 的类型注释里）。
 *
 * 取不到来源时刻时**跳过并记录原因**，而不是回落到"现在"：回落正是上面那个反例的实现方式。
 */
export function selectForwardDenialFacts(input: {
  readonly items: readonly AttentionItem[];
  readonly occurredAtOf: (forwardId: number) => Date | null;
}): SelectResult {
  const seeds: NotificationFactSeed[] = [];
  const skipped: SkippedDenialFact[] = [];
  const seen = new Set<number>();

  for (const item of input.items) {
    // 只认 E 类：kind 必须是 forward，且理由码精确等于既有词表里的那一个。
    if (item.kind !== "forward") continue;
    if (item.reason_code !== FORWARD_DENIAL_REASON) continue;
    // attention 理论上不会重复给同一 id；这里去重是**防御性**的：重复的事实会变成重复的通知。
    if (seen.has(item.id)) continue;
    seen.add(item.id);

    const occurredAt = input.occurredAtOf(item.id);
    if (!occurredAt) {
      skipped.push({ forward_id: item.id, reason: "occurred_at_unavailable" });
      continue;
    }
    seeds.push({
      item,
      occurred_at: occurredAt,
      // 细码取既有的结构化错误码，**不**新增字段：前端/账本用它给出"重试 / 联系管理员"的下一步。
      detail_code: item.apply_error_code ?? null,
    });
  }

  return { seeds, skipped };
}

/* ================================================================== */
/* 第二步：编排（可注入、可测）                                          */
/* ================================================================== */

/** 一条 E 类事实在**来源表**里的两个必要字段（都在隧道行上，不需要新查询面）。 */
export interface ForwardDenialRow {
  /** 来源时刻：`tunnel.updated_at`（**必须**来自这里，理由见本文件顶部）。 */
  readonly updated_at: Date;
  /** 隧道所属 workspace —— 事实的 scope。 */
  readonly workspace_id: number;
}

export interface DiscoveryBacklogSource {
  /** 载入本拍的候选条目（生产实现复用 `collectAttention()`）。 */
  readonly items: readonly AttentionItem[];
  /**
   * 账本里**尚未配对恢复**的拒绝 episode（由注入的读取提供）。
   *
   * 为什么这一项也来自"载入"而不是另开一条注入：它和 `items` 属于**同一拍**的输入快照 ✓ ——
   * 分两次注入会出现"拿到的是两个时刻的世界"，那正是配对语义最容易出错的地方。
   */
  readonly openDenials: readonly OpenDenialEpisode[];
  /** 按转发 id 取来源行；缺行 = 该转发在扫描后已消失（不猜、跳过）。 */
  readonly rowOf: (forwardId: number) => ForwardDenialRow | null;
}

export interface DeliveryBacklogDeps {
  readonly load: () => Promise<DiscoveryBacklogSource>;
  /**
   * 投递核心。**注入**而不是 import：本模块不得自带第二条投递路径
   * （发信/账本/重试/静默期/免打扰全部属于 `deliverNotificationFacts`）。
   */
  readonly deliver: (
    facts: readonly DeliverableNotification[],
    channels: readonly NotificationChannel[],
  ) => Promise<unknown>;
  /** 本安装真正打开的渠道。缺省由调用方给出 —— 一个都没打开时**不投递**、零账本行。 */
  readonly channels: () => readonly NotificationChannel[];
  /**
   * 告警出口（默认 `console.warn`）。**为什么需要它**：`considered>0 && 零渠道` 这条路径
   * 既没有账本行、也（在修好之前）没有任何日志 —— 运维问"通知为什么没发"时，
   * "这台安装到底看到了什么"必须**有地方能回答**。测试通过注入把它变成可断言的事实。
   */
  readonly onWarn?: (message: string, err?: unknown) => void;
}

/**
 * "有事实但零渠道"的**告警判定**（纯函数，刻意单独导出）。
 *
 * 条件是 `facts_derived > 0 && channels_open === 0`，**不是** `considered > 0`：
 * `considered` 在真实安装里长期 >0（只要库里有一条 error 的转发、或任一工作空间有待办），
 * 按它告警就等于把静默换成**每 30 秒一行的永久刷屏**——本专项明令禁止用噪音稀释失败可见性。
 * 单独成函数是为了让这条判定可以被直接断言（而不是藏在 `if` 里只能靠读码确认）。
 */
export function shouldWarnNoChannels(input: { facts_derived: number; channels_open: number }): boolean {
  return input.facts_derived > 0 && input.channels_open === 0;
}

export interface ForwardDenialRunSummary {
  /** 本拍**看到的**待办条目数（attention 派生结果，与"有没有渠道"无关）。 */
  readonly considered: number;
  /**
   * 本拍**派生出来的事实数**（渠道过滤**之前**）。
   *
   * 与 `built` 分开是刻意的：`built/delivered` 描述"投出去了多少"，
   * `facts_derived` 描述"这台安装看到了多少"。把两者合成一个数，就会让
   * **"零渠道"看起来像"零事实"** —— 那是两个完全不同、且运维必须能分辨的状态。
   */
  readonly facts_derived: number;
  /** 派生出的**恢复**事实数（渠道过滤之前）。 */
  readonly recovered_derived: number;
  /** 本安装这一拍真正打开的渠道数（0 = 有事实也不投递，零账本行）。 */
  readonly channels_open: number;
  /** 真正交给投递层的事实数（零渠道时为 0）。 */
  readonly built: number;
  /** 取了来源行但被派生层拒绝（scope/字段不合法）—— 同样要可见，不能静默丢。 */
  readonly rejected: number;
  readonly skipped: number;
  /** 本拍投出去的**恢复**事实数（与拒绝分开计数：混成一个数就看不出"在坏"还是"在好"）。 */
  readonly recovered: number;
  /** 是否真的调用了投递（一个渠道都没打开时为 false，且此时不应产生任何账本行）。 */
  readonly delivered: boolean;
}

/**
 * 本拍的事实投递。
 *
 * 幂等由**投递层**保证（账本幂等键 + 静默期，键**带渠道**）—— 所以本函数可以每拍被调用，
 * 而"要不要说话"这件事只有一份真相。
 */
export async function runForwardDenialNotifications(
  deps: DeliveryBacklogDeps,
): Promise<ForwardDenialRunSummary> {
  const source = await deps.load();
  const { seeds, skipped } = selectForwardDenialFacts({
    items: source.items,
    occurredAtOf: (id) => source.rowOf(id)?.updated_at ?? null,
  });

  const facts: DeliverableNotification[] = [];
  let rejected = 0;
  for (const seed of seeds) {
    // 注意这里**没有**"行不见了就跳过"的分支：`selectForwardDenialFacts` 已经用同一个
    // `rowOf` 判过并计入 `skipped`，再判一次就是同一判据的第二份实现（本分支上我写过这段，
    // 被自己的测试证明不可达 —— 那正是"同一个判断写两遍"的味道，删掉）。
    // 所以 `row` 在这一步一定存在；`rejected` 只统计**派生层**的拒绝。
    const row = source.rowOf(seed.item.id)!;
    const built = buildNotificationFact(workspaceNotificationScope(row.workspace_id), seed);
    if (!built.ok) {
      rejected += 1;
      continue;
    }
    facts.push(built.fact);
  }

  // 恢复：同一拍、同一批依赖、**同一次投递调用**（不建第二条投递路径）。
  const stillDenied = new Set(
    source.items
      .filter((i) => i.kind === "forward" && i.reason_code === FORWARD_DENIAL_REASON)
      .map((i) => i.id),
  );
  const recovery = selectForwardRecoveryFacts({
    openDenials: source.openDenials,
    stillDeniedIds: stillDenied,
    occurredAtOf: (id) => source.rowOf(id)?.updated_at ?? null,
  });
  for (const seed of recovery.seeds) {
    const row = source.rowOf(seed.item.id);
    if (!row) {
      rejected += 1;
      continue;
    }
    const built = buildNotificationFact(workspaceNotificationScope(row.workspace_id), seed);
    if (!built.ok) {
      rejected += 1;
      continue;
    }
    facts.push(built.fact);
  }

  const channels = deps.channels();
  const warn = deps.onWarn ?? ((message: string, err?: unknown) => console.warn(`[notification-facts] ${message}`, err ?? ""));
  // 派生结果先记下来：下面的两个 return 分支都带上它（"看到多少"与"投出多少"是两个问题）。
  const derived = facts.length;
  const derivedRecovered = recovery.seeds.length;
  const skippedTotal = skipped.length + recovery.skipped.length;

  if (derived === 0 || channels.length === 0) {
    // 没有事实、或**一个渠道都没打开**：不投递、不产生账本行（避免用 `not_configured`
    // 把"失败可见"稀释成噪音）。**但"零渠道"绝不等于"零事实"**，所以：
    //   · summary 里 `facts_derived` 仍然如实上报（与 `built` 分开）；
    //   · 并且打一行**明确告警** —— 否则运维无法区分"这台安装什么都没看到"与
    //     "看到了事实但没有可用渠道"（这两者的下一步动作完全不同）。
    if (shouldWarnNoChannels({ facts_derived: derived, channels_open: channels.length })) {
      warn(
        `本拍派生 ${derived} 条事实（其中恢复 ${derivedRecovered} 条），但当前**没有任何已配置渠道** ⇒ 不投递、也不留账本行。` +
          "请检查渠道配置（管理端「通知渠道」）与各渠道的部署开关。",
      );
    }
    return {
      considered: source.items.length,
      facts_derived: derived,
      recovered_derived: derivedRecovered,
      channels_open: channels.length,
      built: 0,
      recovered: 0,
      rejected,
      skipped: skippedTotal,
      delivered: false,
    };
  }

  await deps.deliver(facts, channels);
  return {
    considered: source.items.length,
    facts_derived: derived,
    recovered_derived: derivedRecovered,
    channels_open: channels.length,
    built: derived,
    recovered: derivedRecovered,
    rejected,
    skipped: skippedTotal,
    delivered: true,
  };
}

/* ================================================================== */
/* 恢复事实：与拒绝**配对**的那一半                                      */
/* ================================================================== */

/**
 * 一条**尚未配对恢复**的拒绝（由注入的账本读取提供）。
 *
 * 为什么是"账本读取"而不是"再查一次隧道状态"：一条拒绝是否已经说过、以及是否已经配过恢复，
 * 是**投递事实**，只有账本知道。用隧道当前状态去反推"上次说过没有"会让同一件事有两个判断
 * 入口，而本仓已经为"同一个判断写两遍"付过学费。
 */
export interface OpenDenialEpisode {
  readonly forward_id: number;
  /** 展示名来自来源行（账本不存名字）；不允许从别处猜一个出来。 */
  readonly name: string;
}

/**
 * 从"未配对的拒绝"里选出**已经不再被拒**的那些，作为恢复事实的种子。
 *
 * 只在这里合成 `AttentionItem`：attention 派生的是**当前**状态，而"曾经被拒、现在好了"是
 * 一条**时间上的**事实，只能由配对得到。合成时**只**填四个可确定字段（kind/id/severity/reason_code），
 * 名字由调用方从来源行给出，其余（错误码、可重试性）一律 `null` —— 恢复事实不该带故障期的字段。
 */
export function selectForwardRecoveryFacts(input: {
  readonly openDenials: readonly OpenDenialEpisode[];
  /** 本拍仍在拒绝中的转发 id（来自 attention 派生，不另算一遍）。 */
  readonly stillDeniedIds: ReadonlySet<number>;
  readonly occurredAtOf: (forwardId: number) => Date | null;
}): SelectResult {
  const seeds: NotificationFactSeed[] = [];
  const skipped: SkippedDenialFact[] = [];
  const seen = new Set<number>();

  for (const episode of input.openDenials) {
    if (seen.has(episode.forward_id)) continue;
    seen.add(episode.forward_id);
    // 仍在拒绝中 ⇒ 还没有恢复，这一拍不说。
    if (input.stillDeniedIds.has(episode.forward_id)) continue;

    const occurredAt = input.occurredAtOf(episode.forward_id);
    if (!occurredAt) {
      skipped.push({ forward_id: episode.forward_id, reason: "occurred_at_unavailable" });
      continue;
    }
    seeds.push({
      item: {
        kind: "forward",
        id: episode.forward_id,
        name: episode.name,
        // 好消息与故障分档：混档会污染"需要人处理"的筛选。
        severity: "info",
        reason_code: "forward_apply_recovered",
        // 恢复事实不带故障期的字段 —— 写 `null` 是"我不知道"，不是"它没有"。
        apply_error_code: null,
        retryable: null,
      },
      occurred_at: occurredAt,
      detail_code: null,
    });
  }

  return { seeds, skipped };
}

/* ================================================================== */
/* 账本读取 seam：哪些拒绝**还没配对恢复**                                */
/* ================================================================== */

/** 一条"开着的"拒绝 episode（按渠道）：`(source_id, channel_kind)` 上最新一条是拒绝。 */
export interface OpenDenialRow {
  readonly source_id: string;
  readonly channel_kind: string;
}

/**
 * 取"最新一条仍是拒绝"的 `(转发, 渠道)` 组合。
 *
 * ── 为什么按 `(source_id, channel_kind)` 而不是只按 `source_id` ──
 * 与"静默期键必须带渠道"是同一条口径（WP18.6 那处缺陷）：**投递是每渠道一件事**。只按 source_id
 * 分组时，email 已经恢复、telegram 还没恢复的中间状态会被算成"已恢复"，于是 telegram 的恢复
 * 永远发不出去。
 *
 * ── 为什么用窗口函数而不是 Prisma 的 `distinct` ──
 * MySQL 上 Prisma 的 `distinct` 配 `orderBy` 的"每组取哪一条"语义不直观（它在内存里去重），
 * 而这里的正确性完全依赖"每组取 id 最大的一条" ⇒ 用**显式** SQL 写出来，并且这条 SQL
 * **在真库上验过**（一次性 scratch 库：拒绝→恢复、两个渠道、两个转发四种组合）。
 *
 * `id` 是自增主键，等价于"投递先后" ⇒ 用 `ORDER BY id DESC` 而不是 `occurred_at`：
 * `occurred_at` 来自来源表（可能早于投递），排序它会得出与实际投递顺序不同的结论。
 */
export async function listOpenForwardDenials(deps: {
  readonly queryRows: () => Promise<readonly OpenDenialRow[]>;
}): Promise<OpenDenialRow[]> {
  return [...(await deps.queryRows())];
}

/** 生产实现：平台库上的窗口函数查询（惰性 import `db`）。 */
export function defaultOpenDenialsDeps(): { queryRows: () => Promise<OpenDenialRow[]> } {
  return {
    queryRows: async () => {
      const { db } = await import("../db.ts");
      const rows = await db.$queryRaw<Array<{ source_id: string; channel_kind: string }>>`
        WITH ranked AS (
          SELECT source_id,
                 channel_kind,
                 reason_code,
                 ROW_NUMBER() OVER (PARTITION BY source_id, channel_kind ORDER BY id DESC) AS rn
          FROM notification_delivery
          WHERE source_kind = 'forward'
        )
        SELECT source_id, channel_kind
        FROM ranked
        WHERE rn = 1 AND reason_code = 'forward_apply_error'
      `;
      return rows.map((r) => ({ source_id: String(r.source_id), channel_kind: String(r.channel_kind) }));
    },
  };
}

/* ================================================================== */
/* N3：生产接线（谁去调用 runForwardDenialNotifications）                */
/* ================================================================== */

/**
 * 事实类通知**只走"给人"的渠道**（email / telegram）—— 本切片显式裁定的结果，理由三条：
 *
 *  ① 免打扰的语义只在这两个渠道上成立：偏好是 `(用户 × 渠道 × 类别)`，而这两个渠道的目标
 *     来自**用户自己**（邮箱 / `tg_id`）；webhook 的 URL 属于运维，不属于任何用户
 *     （与 `ANNOUNCEMENT_CHANNEL_KINDS` 同一取舍，**同一份常量，不是副本**）。
 *  ② 事实类的受众是"这个 workspace 的人"（见 {@link FactRecipient}）：一条转发下发被拒，
 *     该知道的是这个空间的人。webhook 没有"哪条事实送哪个端点"的概念，硬塞进来等于替运维
 *     决定了一次未论证的订阅。
 *  ③ `buildPlatformNotificationChannels()` 目前**有意排除** webhook（"没有消费者"）。
 *     把"构造出来就被丢掉"的渠道塞回去，就是 Lead 点名的"未接线出口"。
 *
 * 因此：本条**不改** `notification-channel-config.ts`。将来要给 webhook 发事实，
 * 应当连同"哪些事实送 webhook、端点如何订阅"一起立一个切片 —— 那是新契约，不是顺手开的口子。
 */
export const FACT_NOTIFICATION_CHANNEL_KINDS: readonly NotificationChannelKind[] = ANNOUNCEMENT_CHANNEL_KINDS;

/** 本安装真正打开的渠道 ∩ 参与事实通知的渠道。 */
export function factNotificationChannels(
  channels: readonly NotificationChannel[],
): NotificationChannel[] {
  return channels.filter((channel) => FACT_NOTIFICATION_CHANNEL_KINDS.includes(channel.kind));
}

/** 事实类受众里的一个收件人：目标按渠道从这个用户自己身上取（本层不拼、不猜）。 */
export interface FactRecipient {
  readonly user_id: number;
  readonly email: string | null;
  readonly tg_id: string | null;
}

export type FactAudienceResult =
  | { readonly ok: true; readonly recipients: readonly FactRecipient[] }
  | { readonly ok: false; readonly reason: string };

export interface FactTargetResolverDeps {
  /** 按事实的 scope 解析受众（生产：workspace = 该空间活跃成员；platform = 全体活跃用户）。 */
  readonly audienceOf: (scope: NotificationScope) => Promise<FactAudienceResult>;
  /** 批量取免打扰（生产：`loadMutesByUserIds`）。 */
  readonly loadMutes: (
    userIds: readonly number[],
  ) => Promise<{ readonly ok: true; readonly mutes: ReadonlyMap<number, readonly NotificationMute[]> } | { readonly ok: false; readonly reason: string }>;
  readonly warn: (message: string, err?: unknown) => void;
}

/**
 * 事实类的 `resolveTargets`（本切片补的那块）。
 *
 * ── 五条纪律 ──
 *  1. **目标只能来自用户自己**：email → 用户邮箱；telegram → 该用户的 `tg_id`。
 *     类型上就没有"用 user id 当 chat id"的入口（`tg_id` 缺失 = 这个人没有目标 = 不投递）。
 *  2. **解析不出来就返回空数组**：投递层对空目标留一条 `rejected_target` 失败行 ——
 *     **可见**，而不是静默跳过（"没发出去"必须是账本能回答的问题）。
 *  3. **免打扰按 `(渠道, 类别=source_kind)` 过滤**：与公告走同一套 `isMuted` 判据
 *     （category 词表就是 `NOTIFICATION_SOURCE_KINDS`，本层不新造分类）。
 *  4. **免打扰读不到 = 当成"没人静音"**（O2 的方向：抑制机制失效时**多报**），并留告警。
 *  5. **同一拍内按 scope 缓存受众/免打扰**：一次 tick 里事实可能很多，但受众是同一份快照；
 *     缓存只在本次调用内有效（每次 `createFactTargetResolver()` 一份），所以不会跨拍变旧。
 */
export function createFactTargetResolver(deps: FactTargetResolverDeps): NotificationTargetResolver {
  const audiences = new Map<string, FactAudienceResult>();
  const mutes = new Map<number, readonly NotificationMute[]>();
  const mutesLoaded = new Set<number>();

  async function audience(scope: NotificationScope): Promise<FactAudienceResult> {
    const key = scope.kind === "platform" ? "platform" : `workspace:${scope.workspace_id}`;
    const cached = audiences.get(key);
    if (cached) return cached;
    let resolved: FactAudienceResult;
    try {
      resolved = await deps.audienceOf(scope);
    } catch (err) {
      // 抛错与"解析不出来"是同一件事的两种表现：都**不能**让异常冒泡到投递层的兜底分支
      // （那条分支只会记 transport_error 且**不落账本行** —— 等于一次静默丢弃）。
      deps.warn("事实类受众解析抛错：本次投递将留 rejected_target，不静默跳过", err);
      return { ok: false, reason: "audience_unavailable" };
    }
    if (!resolved.ok) {
      // 不缓存失败：一次读取抖动不该让本拍剩下的同类事实也"没有受众"。
      deps.warn(`事实类受众解析失败（${resolved.reason}）：本次投递将留 rejected_target，不静默跳过`);
      return resolved;
    }
    audiences.set(key, resolved);
    return resolved;
  }

  async function ensureMutes(userIds: readonly number[]): Promise<void> {
    const missing = [...new Set(userIds)].filter((id) => !mutesLoaded.has(id));
    if (missing.length === 0) return;
    let loaded: Awaited<ReturnType<FactTargetResolverDeps["loadMutes"]>>;
    try {
      loaded = await deps.loadMutes(missing);
    } catch (err) {
      // 与"读失败"同一方向（O2：抑制机制失效时宁可多报）：留告警，本拍按"没人静音"继续。
      deps.warn("免打扰清单读取抛错：按「没人静音」继续（O2 的方向：宁可多报）", err);
      for (const id of missing) {
        mutes.set(id, []);
        mutesLoaded.add(id);
      }
      return;
    }
    if (!loaded.ok) {
      deps.warn(`免打扰清单读取失败（${loaded.reason}）：按「没人静音」继续（O2 的方向：宁可多报）`);
      return;
    }
    for (const id of missing) {
      mutes.set(id, loaded.mutes.get(id) ?? []);
      mutesLoaded.add(id);
    }
  }

  return async (fact, channel) => {
    const resolved = await audience(fact.scope);
    if (!resolved.ok) return [];
    await ensureMutes(resolved.recipients.map((recipient) => recipient.user_id));
    const targets: string[] = [];
    for (const recipient of resolved.recipients) {
      if (isMuted(mutes.get(recipient.user_id) ?? [], { channel_kind: channel.kind, category: fact.source_kind })) {
        continue;
      }
      const target = channel.kind === "telegram" ? recipient.tg_id : recipient.email;
      if (typeof target === "string" && target.trim() !== "") targets.push(target.trim());
    }
    return targets;
  };
}

/** 生产 `resolveTargets` 依赖：受众复用公告的读侧受众解析，免打扰复用同一套读取。 */
export function defaultFactTargetResolverDeps(): FactTargetResolverDeps {
  return {
    audienceOf: async (scope) => {
      const { db } = await import("../db.ts");
      const audience =
        scope.kind === "platform"
          ? await platformAnnouncementAudience(db as never)
          : await workspaceAnnouncementAudience(db as never, scope.workspace_id);
      if (!audience.ok) return { ok: false, reason: audience.reason };
      return { ok: true, recipients: audience.recipients };
    },
    loadMutes: async (userIds) => {
      const { db } = await import("../db.ts");
      const loaded = await loadMutesByUserIds(db as never, userIds);
      return loaded.ok ? { ok: true, mutes: loaded.value } : { ok: false, reason: loaded.reason };
    },
    warn: (message, err) => console.warn(`[notification-facts] ${message}`, errSummary(err)),
  };
}

function errSummary(err: unknown): string {
  return err instanceof Error ? err.message : err === undefined || err === null ? "" : String(err);
}

/** 生产接线依赖（全部可注入 ⇒ 这条路径可以在不连数据库的前提下被行为测试驱动）。 */
export interface ForwardDenialWiringDeps {
  /** 平台库的只读面 + 账本。 */
  readonly db: ForwardDenialWiringDb;
  /** 账本里"开着的拒绝"（`defaultOpenDenialsDeps()`；注入以便测试）。 */
  readonly loadOpenDenials: () => Promise<readonly OpenDenialRow[]>;
  /** 每 workspace 的当拍条目（生产：`collectAttention(ws, undefined, {nodes:false, forwards:true})`）。 */
  readonly collectItems: (workspaceId: number) => Promise<readonly AttentionItem[]>;
  /** 本安装**真正打开**的渠道（生产：F5 配置 → 注册表 → 部署闸门）。 */
  readonly loadChannels: () => Promise<readonly NotificationChannel[]>;
  /** 投递核心 + 目标解析（生产：`deliverNotificationFacts` 与 `createFactTargetResolver`）。 */
  readonly deliverFacts: (
    facts: readonly DeliverableNotification[],
    channels: readonly NotificationChannel[],
    resolveTargets: NotificationTargetResolver,
  ) => Promise<unknown>;
  readonly resolveTargetsDeps: FactTargetResolverDeps;
  readonly warn?: (message: string, err?: unknown) => void;
}

export interface ForwardDenialWiringDb {
  readonly tunnel: {
    findMany(args: Record<string, unknown>): Promise<
      Array<{ id: number; workspace_id: number; name?: string | null; apply_status?: string | null; updated_at: Date }>
    >;
  };
}

function uniqPositiveInts(values: readonly number[]): number[] {
  return [...new Set(values.filter((value) => Number.isInteger(value) && value > 0))];
}

/**
 * 把生产依赖装配成 {@link DeliveryBacklogDeps}。**这里是唯一一次装配**：
 * 触发器只认 `load`/`deliver`/`channels` 三个注入点，本函数负责把它们接到真实世界。
 *
 * ── 本拍只扫"可能有事实"的 workspace，而不是全库 ──
 * `collectAttention()` 是**按 workspace** 的，逐库调用全表扫描会随租户数线性增长。
 * 候选集由**来源事实**推出，而不是另一套判据：
 *   · `tunnel.apply_status='error'` ⇒ 可能产生 `forward_apply_error`（attention 的派生只有一个入口：
 *     `attention.ts:291` 的 `status === "error"` 分支 —— 这个等价关系有测试钉住）；
 *   · 账本里"开着的拒绝"所指向的转发 ⇒ 可能产生**恢复**事实（它此刻已经不 error 了，
 *     所以不在这条判据里，必须显式并进来，否则"好了"这件事永远说不出口）。
 * 也就是说：候选集**只做收窄**，判定仍然完全在 `collectAttention()` 里。
 */
export function createForwardDenialDeps(deps: ForwardDenialWiringDeps): DeliveryBacklogDeps {
  const warn = deps.warn ?? ((message: string, err?: unknown) => console.warn(`[notification-facts] ${message}`, errSummary(err)));
  let tickChannels: readonly NotificationChannel[] = [];

  return {
    // 告警通道**同一个** `warn`：装配层的加载告警与编排层的"零渠道"告警走同一条出口
    // （不新开第二条日志面 —— 那只会让"这台安装看到了什么"散在多个地方）。
    ...(deps.warn ? { onWarn: deps.warn } : {}),
    load: async () => {
      const openDenials = await deps.loadOpenDenials();
      const openForwardIds = uniqPositiveInts(openDenials.map((row) => Number(row.source_id)));

      const candidates = await deps.db.tunnel.findMany({
        where: {
          category: "port_forward",
          OR: [{ apply_status: "error" }, { id: { in: openForwardIds } }],
        },
        select: { id: true, workspace_id: true },
      });
      const workspaceIds = uniqPositiveInts(candidates.map((row) => Number(row.workspace_id)));

      const items: AttentionItem[] = [];
      for (const workspaceId of workspaceIds) {
        try {
          items.push(...(await deps.collectItems(workspaceId)));
        } catch (err) {
          // 单个 workspace 取不到 ⇒ 本拍跳过它并留痕：不许把一次读取失败当成"这个空间没有事实"。
          warn(`workspace ${workspaceId} 的待办聚合失败，本拍跳过（下一拍重试）`, err);
        }
      }

      // 行快照：`occurred_at` 与 scope 都只能来自来源表。范围限定在候选 workspace 内（事实只可能来自它们）。
      const rows =
        workspaceIds.length === 0
          ? []
          : await deps.db.tunnel.findMany({
              where: { category: "port_forward", workspace_id: { in: workspaceIds } },
              select: { id: true, workspace_id: true, name: true, updated_at: true },
            });
      const byId = new Map(rows.map((row) => [Number(row.id), row]));

      // 渠道快照：同一拍只读一次配置（一次抖动不该让同一拍的两个事实走不同渠道集合）。
      // 读不到时本拍**不投递**（不猜），但留一句告警：下一次节拍会重试，而不是把失败静默成"没渠道"。
      try {
        tickChannels = await deps.loadChannels();
      } catch (err) {
        warn("渠道配置读取失败（抛错）：本拍不投递，下一拍重试", err);
        tickChannels = [];
      }

      return {
        items,
        openDenials: openDenials.map((row) => {
          const forwardId = Number(row.source_id);
          // 名字只能来自来源行。行不见了（已删除）⇒ 留空串；这一条也会因为取不到 `updated_at`
          // 被选择层计成 `occurred_at_unavailable`（可见），所以空串不会出现在任何通知里。
          return { forward_id: forwardId, name: String(byId.get(forwardId)?.name ?? "") };
        }),
        rowOf: (forwardId) => {
          const row = byId.get(forwardId);
          if (!row) return null;
          return { updated_at: new Date(row.updated_at), workspace_id: Number(row.workspace_id) };
        },
      };
    },

    channels: () => tickChannels,

    deliver: async (facts, channels) => {
      const resolveTargets = createFactTargetResolver(deps.resolveTargetsDeps);
      return await deps.deliverFacts(facts, channels, resolveTargets);
    },
  };
}

/** 生产依赖：真实库 + 真实账本 + 真实渠道配置。worker 只调用这一个入口。 */
export function defaultForwardDenialDeps(): DeliveryBacklogDeps {
  const warn = (message: string, err?: unknown): void =>
    console.warn(`[notification-facts] ${message}`, errSummary(err));
  return createForwardDenialDeps({
    warn,
    db: {
      tunnel: {
        findMany: async (args) => {
          const { db } = await import("../db.ts");
          return (await db.tunnel.findMany(args as never)) as never;
        },
      },
    },
    loadOpenDenials: () => defaultOpenDenialsDeps().queryRows(),
    collectItems: async (workspaceId) => {
      const { collectAttention } = await import("./attention.ts");
      // 触发器今天**只选 forward 类事实**（选择层第一行就是 `item.kind !== "forward"` ⇒ continue），
      // 因此这里也只取 forward 可见性：取的条目范围与选择范围一致，不为了"以后可能"多扫一遍节点。
      // 将来若要接 node 事实，必须**同时**放宽这两处（选择层 + 这里），否则会静默漏掉节点类事实。
      const payload = await collectAttention(workspaceId, undefined, { nodes: false, forwards: true });
      return payload.items;
    },
    loadChannels: async () => {
      const [{ buildPlatformNotificationChannels, loadPlatformChannelConfig }, { enabledNotificationChannels }, { db }] =
        await Promise.all([
          import("./notification-channel-config.ts"),
          import("./notification-delivery.ts"),
          import("../db.ts"),
        ]);
      const config = await loadPlatformChannelConfig(db as unknown as NotificationChannelConfigDb);
      if (!config.ok) {
        // 读不到配置 ≠ 没有渠道（与公告投递同一取向）：回落到"只有部署级闸门能判定的渠道"，
        // 并留一句告警 —— 把读取失败说成"这台安装没配渠道"同样是一次谎。
        warn("渠道配置读取失败，按「只有部署级闸门能判定的渠道」继续（telegram 因此可能被判为未配置）");
        return factNotificationChannels(enabledNotificationChannels());
      }
      return factNotificationChannels(enabledNotificationChannels(buildPlatformNotificationChannels(config.value)));
    },
    deliverFacts: async (facts, channels, resolveTargets) => {
      const { createPrismaLedgerStore } = await import("./notification-delivery.ts");
      return await deliverNotificationFacts(facts, {
        channels,
        resolveTargets,
        ledger: createPrismaLedgerStore(),
      });
    },
    resolveTargetsDeps: defaultFactTargetResolverDeps(),
  });
}

