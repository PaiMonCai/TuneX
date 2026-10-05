/**
 * V5-WP18 —— **事实类通知的投递触发器：事实选择**（第一步，纯函数）。
 *
 * 作用域由契约里 Lead 的三条裁定定死（`docs/v5-wp18-announcements-notifications-contract.md`）：
 *
 *   1. **本期只投 E 类事实**（Forward 下发被拒，reason_code = `forward_apply_error`）与其恢复。
 *      它是既有事实清单里**唯一已经有持久化真相**的一类（`tunnel.apply_status="error"` +
 *      `apply_error_code`，由 `markBlocked()` 写）；G 类（对账 findings / 联邦汇总）今天**只打日志**，
 *      而 N3 已写明"若要通知必须先把 finding 落成持久行" ⇒ 属另一个 WP。
 *   2. 骑既有 reconcile 节拍（不在本文件；本文件只管"这一拍该说哪些事实"）。
 *   3. 受众与渠道在投递层解决（本文件不碰）。
 *
 * ── 本文件刻意**不**做的事 ──
 * 不加载数据、不发信、不写账本、不读静默期。它只把"既有的 attention 条目"翻译成"可投递的事实
 * 种子"，因此可以在一张纯函数测试里被穷尽断言。派生本身复用 `collectAttention()` —— **不新建
 * 事实真相**（这是契约 D1「观测不得成为第二份真相」对通知的同一要求）。
 */
import type { AttentionItem } from "./attention.ts";
import { buildNotificationFact, workspaceNotificationScope, type NotificationFactSeed } from "./notification-facts.ts";
import type { DeliverableNotification, NotificationChannel } from "./notification-delivery.ts";

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
}

export interface ForwardDenialRunSummary {
  readonly considered: number;
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
  if (facts.length === 0 || channels.length === 0) {
    // 没有事实、或**一个渠道都没打开**：不投递、不产生账本行（避免用 `not_configured`
    // 把"失败可见"稀释成噪音）。
    return {
      considered: source.items.length,
      built: 0,
      recovered: 0,
      rejected,
      skipped: skipped.length + recovery.skipped.length,
      delivered: false,
    };
  }

  await deps.deliver(facts, channels);
  return {
    considered: source.items.length,
    built: facts.length,
    recovered: recovery.seeds.length,
    rejected,
    skipped: skipped.length + recovery.skipped.length,
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
