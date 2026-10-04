/**
 * V5.3 WP10 — 故障转移/回切策略（纯函数：无 IO、无 DB、无环境时钟）。
 *
 * §8 冻结契约二写着「故障转移必须是显式 policy」：自动迁移**必须同时**满足六条条件，
 * 缺一不可。这个模块就是那六条条件的唯一实现 —— 输入是已经读出来的事实（节点存活、
 * 观测新鲜度、目标健康、端口可用性、冷却、策略），输出是 `move` / `hold` / `failback`
 * **以及每一条未满足条件的具体原因**。
 *
 * ── 为什么这一层必须存在（§8.3 的真实危险）──
 *
 * 「节点心跳超时 → 自动迁移」是错的，而且是**危险**的错：
 *
 *   · heartbeat 超时单独出现**不足以**迁移（§8.3 明文）：连接还在、只是心跳卡住的
 *     节点仍然在服务，此时搬走流量会制造双主窗口（§8.2 的 split brain）；
 *   · 如果问题是**目标本身坏了**，换谁承载都毫无帮助，只会把故障藏起来 ——
 *     这正是「一个故障转移系统」和「一个靠搬流量掩盖坏目标的系统」的分界；
 *   · 没有新鲜观测时迁移等于猜；
 *   · 备用节点没有端口时迁移只是把「不可用」从一个节点搬到另一个节点；
 *   · 冷却期内的第二次迁移会把一次抖动放大成环路。
 *
 * 所以本模块**只输出结论，不输出动作**：它不删除、不改写、不重排任何目标列表，
 * 也不接受目标列表作为输入 —— 它决定的是「**谁**承载这条 Forward」，不是「它指向
 * 什么」（§7.3 与 §8.3 的禁止项）。
 *
 * ── 六条条件（§8 冻结，顺序与 §8 一致）──
 *
 *   1. `owner_unreachable_beyond_stale`：节点不可达**且**超过 stale 阈值
 *      （heartbeat 超时单独出现不足；两个子条件必须同时成立）
 *   2. `observation_fresh`：观测新鲜度可用
 *   3. `target_not_side_failure`：健康问题不是「目标本身坏了」
 *   4. `standby_port_available`：备用节点有可用端口（§1.5 的端口租约）
 *   5. `cooldown_elapsed`：同一 Forward 的迁移冷却已过
 *   6. `policy_allows`：运维策略允许自动迁移
 *
 * 另有四条**结构前提**（不是策略条件，而是「这条决策能不能表达出来」）：
 * 目的地在、目的地在线、租约 epoch 可读（迁移指令必须是 epoch + 1）、回切目标已配置。
 *
 * ── 回切（failback）不是特例路径 ──
 *
 * §8：「首选节点连续 `FAILBACK_HEALTHY_CHECKS` 次判定健康、且冷却期已过，才允许回切；
 * 回切是一次**正常的归属迁移**（epoch + 1），不是特例路径。」因此：
 *
 *   · 回切走同一个 `PlacementMigration` 形状、同一个 `epoch + 1` 指令，调用方只需要
 *     一条执行路径：`const m = placementMigration(decision); if (m) apply(m);`
 *   · 回切路径上**条件 1 不适用**（`null`）：回切恰恰发生在当前 owner 正常的时候，
 *     要求它失联是自相矛盾的；
 *   · 但条件 2/3/4/5/6 对回切**同样成立**：不能拿陈旧观测回切、不能为了掩盖目标故障
 *     而回切、首选节点要有端口、冷却期内不许回切、策略要允许自动回切。
 *
 * ── 决策对象：未满足的条件**全部**列出 ──
 *
 * `conditions` / `preconditions` 是事实快照：`true` / `false` = 已评估的事实，
 * `null` = 本次决策路径**没有这个事实**（回切路径上不要求 owner 失联；failover 路径上
 * 不存在「连续健康计数」；没有目的地时就没有「它在线吗 / 它有端口吗」这两个答案）。
 * `blockers` 则是「这次为什么没有迁移」的全部原因，一条未满足条件一个条目
 * （**不是只报第一条**）。不变量（有用例钉住）：每个 blocker 都对应一个 `false` 的
 * 事实条目，且 `reasons` 一定以 blocker 的原因开头。
 *
 * ── 与 WP6 的关系 ──
 *
 * 五态词表与 `isTargetHealthState` 从 `target-health.ts` 取，不在这里复制：
 * 「healthy / recovering / degraded / unhealthy / unknown」只有一个定义。
 * 判定「目标本身坏了」用的是 WP6 的结论：`unhealthy` 或 `degraded` 就是目标侧在报坏，
 * 此时迁移只会掩盖故障。
 */
import { isTargetHealthState, type TargetHealthValue } from "./target-health.ts";
import {
  FAILOVER_THRESHOLDS,
  FAILOVER_VALUE_DOMAIN,
  PLACEMENT_EPOCH_INCREMENT,
  type FailoverThresholds,
} from "./failover-thresholds.ts";

/* ================================================================== */
/* 条件与前提的词表                                                     */
/* ================================================================== */

/** §8 冻结的六条条件（顺序即 §8 的顺序；测试会钉住）。 */
export const FAILOVER_POLICY_CONDITIONS = [
  "owner_unreachable_beyond_stale",
  "observation_fresh",
  "target_not_side_failure",
  "standby_port_available",
  "cooldown_elapsed",
  "policy_allows",
] as const;

/**
 * 决策会评估的全部条件 = 六条 + 回切独有的健康计数条件。
 *
 * 六条必须是这个数组的**前缀**（有用例断言），这样「六条」与「全部」不会各写一份。
 */
export const FAILOVER_CONDITIONS = [
  "owner_unreachable_beyond_stale",
  "observation_fresh",
  "target_not_side_failure",
  "standby_port_available",
  "cooldown_elapsed",
  "policy_allows",
  "failback_healthy_checks",
] as const;

export type FailoverCondition = (typeof FAILOVER_CONDITIONS)[number];

/**
 * 结构前提：与六条不同，它们不是「运维策略」，而是「这条迁移能不能表达出来」。
 *
 *   · `standby_candidate`：存在一个可迁移过去的目的地（failover 的候选，或回切的首选）；
 *   · `standby_online`：那个目的地节点在线 —— 迁到一台离线节点不是策略选项，是 bug；
 *   · `placement_epoch`：租约 epoch 可读（迁移指令必须是 epoch + 1，读不到就不能写）；
 *   · `failback_configured`：配置了首选节点且它不是当前 owner（否则没有「回」的地方）。
 */
export const PLACEMENT_PRECONDITIONS = [
  "standby_candidate",
  "standby_online",
  "placement_epoch",
  "failback_configured",
] as const;

export type PlacementPrecondition = (typeof PLACEMENT_PRECONDITIONS)[number];

/** 一个 blocker 指的是哪一条（条件或前提）。 */
export type PlacementRequirement = FailoverCondition | PlacementPrecondition;

/* ================================================================== */
/* 机器可读理由                                                         */
/* ================================================================== */

export const FAILOVER_REASONS = [
  // 条件 1：owner 的存活事实
  "owner_reachable",
  "owner_unreachable_within_stale",
  "owner_stale_age_unknown",
  "owner_unreachable_beyond_stale",
  // 条件 2：观测新鲜度
  "observation_missing",
  "observation_all_stale",
  "observation_too_old",
  "observation_age_unusable",
  "observation_insufficient",
  "observation_fresh",
  // 条件 3：目标侧归因
  "target_side_failure",
  "target_side_evidence_owner_only",
  "target_not_side_failure",
  // 条件 4 与结构前提
  "no_standby_candidate",
  "standby_candidate_available",
  "standby_not_reachable",
  "standby_online",
  "standby_port_unavailable",
  "standby_port_available",
  "placement_epoch_unusable",
  "placement_epoch_ok",
  "failback_not_configured",
  "failback_already_preferred",
  "failback_target_not_reachable",
  "failback_port_unavailable",
  // 条件 5：冷却
  "cooldown_active",
  "cooldown_elapsed",
  // 条件 6：策略
  "policy_auto_failover_disabled",
  "policy_auto_failback_disabled",
  "policy_allows_failover",
  "policy_allows_failback",
  // 回切独有
  "failback_checks_pending",
  "failback_checks_met",
] as const;

export type FailoverReason = (typeof FAILOVER_REASONS)[number];

/** 理由码 → 一句话。`Record` 而不是 `switch`：漏一个码编译期就会红。 */
const FAILOVER_REASON_TEXT: Record<FailoverReason, string> = {
  owner_reachable: "当前承载节点仍可达：没有迁移的理由",
  owner_unreachable_within_stale: "节点不可达但未超过 stale 阈值：继续观察，不迁移",
  owner_stale_age_unknown: "节点不可达，但心跳年龄不可知：无法证明「超过 stale 阈值」",
  owner_unreachable_beyond_stale: "节点不可达且已超过 stale 阈值",
  observation_missing: "没有任何观测者：没有可用的健康事实",
  observation_all_stale: "全部观测已过期：不能拿陈旧观测当迁移依据",
  observation_too_old: "观测年龄超过新鲜度线：不能拿陈旧观测当迁移依据",
  observation_age_unusable: "观测年龄不可读：无法确认新鲜度",
  observation_insufficient: "新鲜观测者数量不足：迁移缺少足够的证据",
  observation_fresh: "观测新鲜度可用",
  target_side_failure: "健康问题是目标本身坏了：换承载节点只会掩盖故障",
  target_side_evidence_owner_only: "说「目标坏了」的观测全部来自当前承载节点，其视角本身可疑",
  target_not_side_failure: "当前证据没有指向「目标本身坏了」",
  no_standby_candidate: "没有可迁移到的候选节点",
  standby_candidate_available: "存在可迁移的候选节点",
  standby_not_reachable: "候选节点不在线：迁过去也不能承载",
  standby_online: "候选节点在线",
  standby_port_unavailable: "候选节点没有可用端口（端口租约）",
  standby_port_available: "候选节点有可用端口",
  placement_epoch_unusable: "租约 epoch 不可读：无法表达 epoch + 1 的迁移",
  placement_epoch_ok: "租约 epoch 可读",
  failback_not_configured: "没有配置首选节点，或首选节点就是当前承载节点",
  failback_already_preferred: "当前承载节点已经是首选节点：无需回切",
  failback_target_not_reachable: "首选节点不在线：回切过去也不能承载",
  failback_port_unavailable: "首选节点没有可用端口",
  cooldown_active: "迁移冷却期内：不允许第二次归属变更",
  cooldown_elapsed: "迁移冷却已过",
  policy_auto_failover_disabled: "运维策略未允许自动故障转移",
  policy_auto_failback_disabled: "运维策略未允许自动回切",
  policy_allows_failover: "运维策略允许自动故障转移",
  policy_allows_failback: "运维策略允许自动回切",
  failback_checks_pending: "首选节点的连续健康判定次数还不够",
  failback_checks_met: "首选节点已连续判定健康",
};

export function describeFailoverReason(reason: FailoverReason): string {
  return FAILOVER_REASON_TEXT[reason] ?? "归属决策理由未知";
}

/* ================================================================== */
/* 输入（全部是已读出的纯事实）                                          */
/* ================================================================== */

/**
 * 归属事实（`placement_lease` 一行的投影，§8 一）。
 *
 * `epoch` 单调递增：迁移指令写的是 `epoch + 1`，绝不覆盖字段。本模块**不判断租约
 * 是否仍然有效** —— 两阶段交接（新 owner 只能在旧租约过期或被显式吊销后激活）是
 * WP9 的职责；这里只保证输出一个可 CAS 的 `(expected_epoch, next_epoch)` 对。
 */
export interface PlacementFacts {
  /** 当前承载者（租约所有者）。 */
  readonly owner_node_id: number;
  /** 所有权世代。 */
  readonly epoch: number;
  /** 运维配置的首选节点；null / 缺省 = 未配置（不自动回切）。 */
  readonly preferred_node_id?: number | null;
}

/**
 * 节点存活事实。
 *
 * `reachable` 是**连接层**事实（V4 的 online/offline），`last_seen_at` 是最后一次心跳。
 * 两者分开是因为 §8 的条件 1 要求**同时**成立：只有「不可达」+「超过 stale」才算失联。
 * 时间戳在时以它为准（现算年龄），`last_seen_age_ms` 是调用方已算好年龄的别名。
 */
export interface OwnerLivenessFacts {
  readonly reachable: boolean;
  readonly last_seen_at?: Date | string | number | null;
  readonly last_seen_age_ms?: number | null;
}

/** 一个观测者对目标的结论（WP6 `TargetHealthView.observers` 的投影）。 */
export interface FailoverObservedTarget {
  /** 观测者节点 id：数字（DB）或线上字符串（agent 的 `node-7`）。 */
  readonly node_id: number | string;
  /** 该观测者的合成结论（WP6 五态）。 */
  readonly state: TargetHealthValue;
  /** 该观测是否已过期（WP6 `observer.stale`）；缺省 = 未标记过期。 */
  readonly stale?: boolean;
}

/**
 * 目标的观测事实（只取「谁说了什么」，**不取目标列表本身**）。
 *
 * 逐观测者明细而不是一个聚合结论，是为了把**归因**留在本模块里：条件 3 问的是
 * 「说目标坏了的是谁」—— 如果只有当前承载节点说目标坏了，它的视角本身就可疑
 * （它可能只是自己的网络断了）。这一点必须是模块能看见的事实，而不是调用方的结论。
 */
export interface FailoverTargetFacts {
  readonly observers: readonly FailoverObservedTarget[];
  /** 新鲜证据的年龄（ms）；可选。给了就必须落在新鲜度线内，否则 fail-closed。 */
  readonly age_ms?: number | null;
}

/** 目的地节点的承载事实。 */
export interface FailoverCandidateFacts {
  readonly node_id: number;
  /** 该节点自身在线。 */
  readonly reachable: boolean;
  /** 该节点上端口租约是否可用（§1.5）。 */
  readonly port_available: boolean;
  /** 可用端口数；可选。给了就必须 >= 最小值（与布尔矛盾时以更严格的一方为准）。 */
  readonly port_available_count?: number | null;
}

/** 冷却与上一次归属变更。冷却**与方向无关**：failover 紧接 failback 同样被拦。 */
export interface FailoverCooldownFacts {
  readonly last_migration_at?: Date | string | number | null;
  readonly last_migration_kind?: MigrationKind | null;
}

/** 运维策略（条件 6）。 */
export interface FailoverPolicyFacts {
  /** 允许自动故障转移。 */
  readonly auto_failover: boolean;
  /** 允许自动回切。 */
  readonly auto_failback: boolean;
}

/** 回切事实：首选节点作为目的地的承载事实 + 连续健康判定次数。 */
export interface FailbackFacts {
  readonly candidate: FailoverCandidateFacts;
  /** 首选节点连续判定健康的次数（由调用方按调用节奏累计）。 */
  readonly healthy_checks: number;
}

export interface FailoverInput {
  readonly forward_id: number;
  /** 判定时刻：注入，不读环境时钟。 */
  readonly now: Date;
  readonly placement: PlacementFacts;
  readonly owner: OwnerLivenessFacts;
  /** failover 的候选节点（调用方从备用池里挑的那一个）；null = 没有候选。 */
  readonly candidate?: FailoverCandidateFacts | null;
  readonly target_observations: FailoverTargetFacts;
  readonly cooldown?: FailoverCooldownFacts | null;
  readonly policy: FailoverPolicyFacts;
  /** 回切事实；缺省 = 没有报告连续健康次数（按 0 次处理，fail-closed）。 */
  readonly failback?: FailbackFacts | null;
  readonly thresholds?: Partial<FailoverThresholds> | null;
}

/* ================================================================== */
/* 输出                                                                 */
/* ================================================================== */

export const FAILOVER_ACTIONS = ["move", "hold", "failback"] as const;
export type FailoverAction = (typeof FAILOVER_ACTIONS)[number];

export type MigrationKind = "failover" | "failback";

/**
 * 归属迁移指令。**failover 与 failback 共用同一个形状**（§8：回切是正常的归属迁移，
 * 不是特例路径），所以调用方只有一条执行路径；`kind` 只用于展示与审计。
 */
export interface PlacementMigration {
  readonly forward_id: number;
  readonly from_node_id: number;
  readonly to_node_id: number;
  /** 迁移指令所依据的 epoch：调用方必须以它做 CAS（防 duplicate failover）。 */
  readonly expected_epoch: number;
  /** 新世代 = expected_epoch + 1（§8 一：绝不覆盖字段，绝不回退）。 */
  readonly next_epoch: number;
  readonly kind: MigrationKind;
}

/** 一条未满足的条件（或前提）及其具体原因。 */
export interface FailoverBlocker {
  readonly condition: PlacementRequirement;
  readonly reason: FailoverReason;
  /** 面向运维的一句话（含关键数值）；没有额外信息时为 null。 */
  readonly detail: string | null;
}

export interface FailoverCooldownReport {
  readonly active: boolean;
  /** 还要等多久（ms）；不在冷却期时 null。 */
  readonly remaining_ms: number | null;
  readonly last_migration_at: string | null;
  readonly last_migration_kind: MigrationKind | null;
}

export interface FailoverDecision {
  readonly forward_id: number;
  readonly action: FailoverAction;
  /**
   * 迁移指令：`move` / `failback` 时非 null，`hold` 时为 null。
   * 两种 action 的指令形状完全相同 —— 调用方不需要为回切写第二条路径。
   */
  readonly migration: PlacementMigration | null;
  /**
   * 六条条件 + 回切条件的事实快照：`true` / `false` = 已评估的事实，
   * `null` = 本次决策路径没有评估这一条。
   */
  readonly conditions: Readonly<Record<FailoverCondition, boolean | null>>;
  /** 结构前提的事实快照；`null` 语义同上。 */
  readonly preconditions: Readonly<Record<PlacementPrecondition, boolean | null>>;
  /** **全部**未满足的条件与前提（不是只报第一条）。 */
  readonly blockers: FailoverBlocker[];
  /** 扁平理由清单：以 blockers 的原因为开头，后接成立条件的依据与解释性理由。 */
  readonly reasons: FailoverReason[];
  readonly cooldown: FailoverCooldownReport;
}

/* ================================================================== */
/* 读取助手（坏形状一律 fail-closed）                                     */
/* ================================================================== */

interface Requirement {
  readonly met: boolean;
  readonly reason: FailoverReason;
  readonly detail: string | null;
}

function met(reason: FailoverReason, detail: string | null = null): Requirement {
  return { met: true, reason, detail };
}

function unmet(reason: FailoverReason, detail: string | null = null): Requirement {
  return { met: false, reason, detail };
}

function resolveThresholds(override?: Partial<FailoverThresholds> | null): FailoverThresholds {
  if (!override) return FAILOVER_THRESHOLDS;
  return { ...FAILOVER_THRESHOLDS, ...override };
}

/** `Date` / ISO 字符串 / 数字（线上 unix 秒或毫秒，按量级判定）→ epoch ms。 */
function asEpochMs(value: Date | string | number | null | undefined): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) && ms > FAILOVER_VALUE_DOMAIN.EPOCH_MS_MIN ? ms : null;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= FAILOVER_VALUE_DOMAIN.EPOCH_MS_MIN) return null;
    return value >= FAILOVER_VALUE_DOMAIN.EPOCH_MILLIS_CUTOFF
      ? value
      : value * FAILOVER_VALUE_DOMAIN.SECONDS_TO_MS;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) && ms > FAILOVER_VALUE_DOMAIN.EPOCH_MS_MIN ? ms : null;
  }
  return null;
}

function asCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return value >= FAILOVER_VALUE_DOMAIN.HEALTHY_CHECKS_MIN ? value : null;
}

function sameNode(a: number | string | null | undefined, b: number | string | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return String(a) === String(b);
}

function isBroken(state: TargetHealthValue): boolean {
  return state === "unhealthy" || state === "degraded";
}

/* ================================================================== */
/* 条件 1：owner 是否「不可达且超过 stale 阈值」                          */
/* ================================================================== */

function evaluateOwner(
  owner: OwnerLivenessFacts | null | undefined,
  now: Date,
  thresholds: FailoverThresholds,
): Requirement {
  // 连接还在 = 没有失联。心跳陈旧（soft timeout）单独出现**不足以**迁移（§8.3 明文）：
  // 一个只是心跳卡住、连接仍在的节点还在服务，搬走流量会制造双主窗口。
  if (owner?.reachable === true) {
    return unmet("owner_reachable", "连接仍在线：心跳陈旧单独不足以迁移");
  }
  const lastSeen = asEpochMs(owner?.last_seen_at ?? null);
  const explicitAge =
    typeof owner?.last_seen_age_ms === "number" && Number.isFinite(owner.last_seen_age_ms)
      ? owner.last_seen_age_ms
      : null;
  const age = lastSeen === null ? explicitAge : now.getTime() - lastSeen;
  if (age === null) {
    return unmet("owner_stale_age_unknown", "既没有心跳时间戳也没有年龄：无法证明超过 stale 阈值");
  }
  // §8 写的是「超过 stale 阈值」：严格大于（恰好等于还不算超）。
  if (age <= thresholds.NODE_STALE_AFTER_MS) {
    return unmet(
      "owner_unreachable_within_stale",
      `不可达 ${age}ms ≤ stale 阈值 ${thresholds.NODE_STALE_AFTER_MS}ms`,
    );
  }
  return met("owner_unreachable_beyond_stale", `不可达 ${age}ms > ${thresholds.NODE_STALE_AFTER_MS}ms`);
}

/* ================================================================== */
/* 条件 2 与条件 3：观测新鲜度、目标侧归因                                */
/* ================================================================== */

interface ObservationEvaluation {
  readonly requirement: Requirement;
  /** 非 stale 且结论可读的观测者（条件 3 只看这些人）。 */
  readonly fresh: readonly FailoverObservedTarget[];
  /** 这些新鲜观测者里报告目标本身坏了的（unhealthy / degraded）。 */
  readonly broken: readonly FailoverObservedTarget[];
}

function evaluateObservations(
  facts: FailoverTargetFacts | null | undefined,
  thresholds: FailoverThresholds,
): ObservationEvaluation {
  const observers = Array.isArray(facts?.observers) ? facts.observers : [];
  if (!observers.length) {
    return { requirement: unmet("observation_missing"), fresh: [], broken: [] };
  }
  // 过期观测不是证据（§7 结论 8）；`unknown` 结论也不构成证据（它什么都没说）。
  const fresh = observers.filter(
    (observer) =>
      observer?.stale !== true && isTargetHealthState(observer?.state) && observer.state !== "unknown",
  );
  if (!fresh.length) {
    return { requirement: unmet("observation_all_stale"), fresh: [], broken: [] };
  }
  const age = facts?.age_ms;
  if (age !== undefined && age !== null) {
    if (typeof age !== "number" || !Number.isFinite(age) || age < FAILOVER_VALUE_DOMAIN.EPOCH_MS_MIN) {
      return { requirement: unmet("observation_age_unusable"), fresh, broken: [] };
    }
    if (age > thresholds.OBSERVATION_STALE_AFTER_MS) {
      return {
        requirement: unmet(
          "observation_too_old",
          `新鲜证据年龄 ${age}ms > ${thresholds.OBSERVATION_STALE_AFTER_MS}ms`,
        ),
        fresh,
        broken: [],
      };
    }
  }
  const broken = fresh.filter((observer) => isBroken(observer.state));
  if (fresh.length < thresholds.MIN_FRESH_OBSERVERS) {
    return {
      requirement: unmet(
        "observation_insufficient",
        `新鲜观测者 ${fresh.length} < 要求 ${thresholds.MIN_FRESH_OBSERVERS}`,
      ),
      fresh,
      broken,
    };
  }
  return { requirement: met("observation_fresh", `新鲜观测者 ${fresh.length}`), fresh, broken };
}

/** 条件 3：这些坏消息是谁说的。 */
function evaluateTargetSide(
  evaluation: ObservationEvaluation,
  ownerNodeId: number | undefined,
): { requirement: Requirement; ownerOnly: boolean } {
  if (!evaluation.broken.length) {
    return { requirement: met("target_not_side_failure"), ownerOnly: false };
  }
  // 「目标自己坏了 → 换入口节点毫无帮助，只会掩盖故障」（§8）。所以只要**有**新鲜证据
  // 说目标坏，就不迁移；说它坏的是谁记在 detail 里（例如全部来自一个自身网络可疑的
  // 节点），供运维判断 —— 这里刻意不做「自动排除 owner 视角」的聪明处理：那等于用
  // 一个可疑的视角去推翻另一个可疑的视角，而 hold 是可逆的一侧。
  const ownerOnly = evaluation.broken.every((observer) => sameNode(observer.node_id, ownerNodeId));
  const who = evaluation.broken.map((observer) => `${String(observer.node_id)}:${observer.state}`).join(", ");
  return {
    requirement: unmet("target_side_failure", `新鲜证据里有目标侧故障（${who}）`),
    ownerOnly,
  };
}

/* ================================================================== */
/* 条件 4 与结构前提：目的地                                               */
/* ================================================================== */

interface DestinationEvaluation {
  /** 前提：存在可迁移的目的地。 */
  readonly exists: Requirement;
  /** 前提：目的地节点在线；**null = 没有目的地，因此没有这个事实**。 */
  readonly online: Requirement | null;
  /** 条件 4：目的地有可用端口；**null = 没有目的地，因此没有这个事实**。 */
  readonly port: Requirement | null;
}

function evaluateDestination(
  candidate: FailoverCandidateFacts | null | undefined,
  thresholds: FailoverThresholds,
  path: MigrationKind,
): DestinationEvaluation {
  const missingReason: FailoverReason = path === "failback" ? "failback_not_configured" : "no_standby_candidate";
  const offlineReason: FailoverReason =
    path === "failback" ? "failback_target_not_reachable" : "standby_not_reachable";
  const portReason: FailoverReason = path === "failback" ? "failback_port_unavailable" : "standby_port_unavailable";

  if (!candidate) {
    // 没有目的地时，「它在线吗 / 它有端口吗」这两个问题**没有答案**：报 null（未评估），
    // 而不是把同一个根因写成三条 blocker ——「没有候选」本身就是完整的原因。
    return { exists: unmet(missingReason), online: null, port: null };
  }

  const online = candidate.reachable === true
    ? met("standby_online", `节点 ${candidate.node_id} 在线`)
    : unmet(offlineReason, `节点 ${candidate.node_id} 不在线`);
  const exists = met("standby_candidate_available", `目的地节点 ${candidate.node_id}`);

  if (candidate.port_available !== true) {
    return { exists, online, port: unmet(portReason, "端口租约不可用（§1.5：端口只能来自租约）") };
  }
  const count = candidate.port_available_count;
  if (count !== undefined && count !== null) {
    const readable =
      typeof count === "number" && Number.isInteger(count) && count >= FAILOVER_VALUE_DOMAIN.PORT_COUNT_MIN;
    if (!readable) {
      return { exists, online, port: unmet(portReason, "可用端口数不可读") };
    }
    if (count < thresholds.MIN_AVAILABLE_PORTS) {
      return {
        exists,
        online,
        port: unmet(portReason, `可用端口 ${count} < 要求 ${thresholds.MIN_AVAILABLE_PORTS}`),
      };
    }
    return { exists, online, port: met("standby_port_available", `可用端口 ${count}`) };
  }
  return { exists, online, port: met("standby_port_available", "端口租约可用") };
}

/* ================================================================== */
/* 条件 5：冷却                                                         */
/* ================================================================== */

interface CooldownEvaluation {
  readonly requirement: Requirement;
  readonly report: FailoverCooldownReport;
}

function evaluateCooldown(
  cooldown: FailoverCooldownFacts | null | undefined,
  now: Date,
  thresholds: FailoverThresholds,
): CooldownEvaluation {
  const at = asEpochMs(cooldown?.last_migration_at ?? null);
  const kind =
    cooldown?.last_migration_kind === "failover" || cooldown?.last_migration_kind === "failback"
      ? cooldown.last_migration_kind
      : null;
  if (at === null) {
    return {
      requirement: met("cooldown_elapsed"),
      report: { active: false, remaining_ms: null, last_migration_at: null, last_migration_kind: kind },
    };
  }
  const elapsed = now.getTime() - at;
  const lastIso = new Date(at).toISOString();
  // 冷却与方向无关：failover 之后的 failback 同样被拦（§8.3「不无限抖动」）。
  if (elapsed >= thresholds.MIGRATION_COOLDOWN_MS) {
    return {
      requirement: met("cooldown_elapsed"),
      report: { active: false, remaining_ms: null, last_migration_at: lastIso, last_migration_kind: kind },
    };
  }
  // 时间戳在未来（时钟偏斜）→ elapsed 为负 → 必定还在冷却期内：fail-closed。
  const remaining = thresholds.MIGRATION_COOLDOWN_MS - elapsed;
  return {
    requirement: unmet(
      "cooldown_active",
      `距上次迁移 ${elapsed}ms < 冷却 ${thresholds.MIGRATION_COOLDOWN_MS}ms，还需 ${remaining}ms`,
    ),
    report: { active: true, remaining_ms: remaining, last_migration_at: lastIso, last_migration_kind: kind },
  };
}

/* ================================================================== */
/* 主决策                                                              */
/* ================================================================== */

function policyRequirement(allowed: boolean, path: MigrationKind): Requirement {
  if (allowed) return met(path === "failback" ? "policy_allows_failback" : "policy_allows_failover");
  return unmet(path === "failback" ? "policy_auto_failback_disabled" : "policy_auto_failover_disabled");
}

function buildMigration(
  forwardId: number,
  fromNodeId: number,
  toNodeId: number,
  epoch: number,
  kind: MigrationKind,
): PlacementMigration {
  return {
    forward_id: forwardId,
    from_node_id: fromNodeId,
    to_node_id: toNodeId,
    expected_epoch: epoch,
    next_epoch: epoch + PLACEMENT_EPOCH_INCREMENT,
    kind,
  };
}

/**
 * 判断「现在应该继续由谁承载这条 Forward」。
 *
 * 决策路径由 **owner 的存活事实**决定，不由目的地决定：
 *   · owner 失联（不可达 **且** 超过 stale）→ failover 路径（目的地在候选节点上）；
 *   · owner 可达且当前不是首选节点 → failback 路径（目的地在首选节点上）；
 *   · 其余 → hold（没有迁移的理由；仍然把六条条件的事实摆出来）。
 *
 * 纯函数：同样的输入 + 同样的 `now` ⇒ 同样的输出；不读时钟、不碰 DB、不改任何列表。
 */
export function decideFailover(input: FailoverInput): FailoverDecision {
  const thresholds = resolveThresholds(input.thresholds);
  const now = input.now;
  const placement = input.placement;
  const ownerNodeId = placement?.owner_node_id;
  const epoch = placement?.epoch;
  const preferred = placement?.preferred_node_id ?? null;

  const ownerRequirement = evaluateOwner(input.owner, now, thresholds);
  const observations = evaluateObservations(input.target_observations, thresholds);
  const targetSide = evaluateTargetSide(observations, ownerNodeId);
  const cooldown = evaluateCooldown(input.cooldown, now, thresholds);

  const epochOk = Number.isInteger(epoch) && (epoch as number) >= FAILOVER_VALUE_DOMAIN.EPOCH_MIN;
  const epochRequirement: Requirement = epochOk
    ? met("placement_epoch_ok", `epoch ${String(epoch)}`)
    : unmet("placement_epoch_unusable", `epoch ${String(epoch)} 不是合法的非负整数`);

  const ownerIsDown = ownerRequirement.reason === "owner_unreachable_beyond_stale";
  const ownerIsUp = ownerRequirement.reason === "owner_reachable";
  const failbackConfigured = preferred !== null && !sameNode(preferred, ownerNodeId);
  const failbackPath = !ownerIsDown && ownerIsUp && failbackConfigured;
  const path: MigrationKind = failbackPath ? "failback" : "failover";

  const destinationFacts = failbackPath ? (input.failback?.candidate ?? null) : (input.candidate ?? null);
  const destination = evaluateDestination(destinationFacts, thresholds, path);

  const policy = policyRequirement(
    failbackPath ? input.policy?.auto_failback === true : input.policy?.auto_failover === true,
    path,
  );

  // 回切独有条件：首选节点连续 N 次判定健康（§8 回切规则）。
  let checksRequirement: Requirement | null = null;
  if (failbackPath) {
    const reported = input.failback?.healthy_checks;
    const healthyChecks = asCount(reported ?? FAILOVER_VALUE_DOMAIN.HEALTHY_CHECKS_MIN);
    checksRequirement =
      healthyChecks !== null && healthyChecks >= thresholds.FAILBACK_HEALTHY_CHECKS
        ? met("failback_checks_met", `连续健康 ${healthyChecks} 次`)
        : unmet(
            "failback_checks_pending",
            `连续健康 ${healthyChecks ?? "不可读"} 次 < 要求 ${thresholds.FAILBACK_HEALTHY_CHECKS} 次`,
          );
  }

  const conditions: Record<FailoverCondition, boolean | null> = {
    // 回切路径不要求 owner 失联（回切恰恰发生在它正常时）；其余路径上这条就是事实。
    owner_unreachable_beyond_stale: failbackPath ? null : ownerIsDown,
    observation_fresh: observations.requirement.met,
    target_not_side_failure: targetSide.requirement.met,
    // 没有目的地时端口事实不存在 → null（未评估），不是 false。
    standby_port_available: destination.port === null ? null : destination.port.met,
    cooldown_elapsed: cooldown.requirement.met,
    policy_allows: policy.met,
    // failover/hold 路径上不存在「连续健康计数」这个事实，所以是 null 而不是 false。
    failback_healthy_checks: checksRequirement === null ? null : checksRequirement.met,
  };
  const preconditions: Record<PlacementPrecondition, boolean | null> = {
    standby_candidate: destination.exists.met,
    standby_online: destination.online === null ? null : destination.online.met,
    placement_epoch: epochOk,
    // failover 路径上没有评估「回切目标」，所以是 null；hold/failback 路径上是事实。
    failback_configured: failbackPath ? true : ownerIsDown ? null : failbackConfigured,
  };

  // 本次路径上「要求成立」的条目，顺序即 §8 的顺序（回切路径去掉条件 1、加上回切条件）。
  // `require` 会跳过 null（没有这个事实的条目既不是成立、也不是不成立）。
  const required: Array<{ condition: PlacementRequirement; requirement: Requirement }> = [];
  const need = (condition: PlacementRequirement, requirement: Requirement | null): void => {
    if (requirement !== null) required.push({ condition, requirement });
  };

  // hold 路径上唯一「应该成立却没成立」的迁移条件就是条件 1 ——「仍可达」「还在 stale
  // 窗口内」「年龄不可知」是三种不同的运维事实，必须精确区分。
  if (!failbackPath && !ownerIsDown) {
    need("owner_unreachable_beyond_stale", ownerRequirement);
  }
  need("observation_fresh", observations.requirement);
  need("target_not_side_failure", targetSide.requirement);
  need("standby_candidate", destination.exists);
  need("standby_online", destination.online);
  need("placement_epoch", epochRequirement);
  need("standby_port_available", destination.port);
  need("cooldown_elapsed", cooldown.requirement);
  need("policy_allows", policy);
  need("failback_healthy_checks", checksRequirement);

  const blockers: FailoverBlocker[] = [];
  for (const entry of required) {
    if (entry.requirement.met) continue;
    blockers.push({
      condition: entry.condition,
      reason: entry.requirement.reason,
      detail: entry.requirement.detail,
    });
  }

  // 理由清单：blockers 的原因在前（运维先要知道为什么没搬），然后是成立条目的依据。
  const reasons: FailoverReason[] = [];
  const remember = (reason: FailoverReason): void => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  for (const blocker of blockers) remember(blocker.reason);
  if (ownerIsDown) remember(ownerRequirement.reason);
  for (const entry of required) {
    if (entry.requirement.met) remember(entry.requirement.reason);
  }
  if (targetSide.ownerOnly) remember("target_side_evidence_owner_only");
  if (!ownerIsDown && ownerIsUp && preferred !== null && !failbackConfigured) {
    // 已经承载在首选节点上：没有要搬的东西。这是事实，不是故障。
    remember("failback_already_preferred");
  }

  let action: FailoverAction = "hold";
  let migration: PlacementMigration | null = null;
  if (!blockers.length) {
    if (ownerIsDown && input.candidate) {
      action = "move";
      migration = buildMigration(input.forward_id, ownerNodeId, input.candidate.node_id, epoch, "failover");
    } else if (failbackPath && input.failback?.candidate) {
      action = "failback";
      migration = buildMigration(
        input.forward_id,
        ownerNodeId,
        input.failback.candidate.node_id,
        epoch,
        "failback",
      );
    }
  }

  return {
    forward_id: input.forward_id,
    action,
    migration,
    conditions,
    preconditions,
    blockers,
    reasons,
    cooldown: cooldown.report,
  };
}

/**
 * 唯一的执行入口：把决策折算成归属迁移指令，`move` 与 `failback` 走同一条路。
 *
 * 调用方只需要：
 * ```ts
 * const migration = placementMigration(decideFailover(input));
 * if (migration) await applyPlacementMigration(migration); // 内部以 expected_epoch 做 CAS
 * ```
 * 回切不需要第二条代码路径 —— 这正是 §8「回切是一次正常的归属迁移」的落地。
 */
export function placementMigration(decision: FailoverDecision): PlacementMigration | null {
  return decision.migration;
}
