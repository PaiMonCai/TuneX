/**
 * V5-WP6 — 目标健康合成（纯函数：无 IO、无 DB、无环境时钟）。
 *
 * 固定链（§7 开头）是 `Observation → Health Synthesis → Decision`，本模块只做**中间
 * 那一段**：把已经读出来的观测事实，合成成 operator 与 Decision 层都能用的**结论**。
 * 它不读取 DB、不发请求、不写日志、不读时钟（`now` 是参数），所有 IO 由调用方完成，
 * 因此规则可以离线穷举单测 —— 与 `capability-policy.ts` 同一条纪律。
 *
 * ── 三条不允许走捷径的边界（§7 冻结块）──
 *
 *   1. **stale 等价于没有证据**（结论 8）。旧观测不会被「延续使用」，也不会被
 *      「重启后信任缓存」（结论 9）复活：age 由 `now - last_observed_at` 现算，
 *      读的那一刻才算，所以重启后它自然过期 → `unknown`。
 *   2. **单次观测不改变判定**（迟滞）。进 `unhealthy` 要连续 N 次失败，出
 *      `unhealthy` 要连续 M 次成功：一次超时永远不会让目标变 `unhealthy`，一次
 *      成功也永远不会让它回到 `healthy`。
 *   3. **多观测者取最坏**（partial visibility）。fail-closed：一个节点说通、另一个
 *      节点说断，结论就是最坏的那个，同时**保留逐观测者明细**（「视角不同」本身
 *      就是运维要看的事实，§7 结论 5：两条观测是两条不同的事实，不能合并）。
 *
 * ── 五态与跃迁（§7 状态表 + 三条规则，逐条落地）──
 *
 *   unknown     没有非 stale 可用证据（从未观测 / 记录不可读 / 证据全部过期）
 *   healthy     reachable ∧ rate ≥ HEALTHY_RATE ∧ 延迟达标 ∧ cf == 0 ∧ cs ≥ WARMUP_SUCCESSES
 *   degraded    0 < cf < FAILURE_THRESHOLD，或可达但成功率/延迟不达标，或字段不可读
 *   unhealthy   cf ≥ FAILURE_THRESHOLD（唯一入口）
 *   recovering  刚从 unhealthy 出来（cs ≥ RECOVERY_SUCCESSES）；或成功一次但连续成功不足
 *
 *   逐条跃迁（每条都有对应用例，见 `__tests__/target-health.test.ts`）：
 *
 *     unknown    → degraded    一次失败 / 成功率不达标 / 延迟超标 / 字段缺失
 *     unknown    → recovering  一次成功（warm-up：一次成功只到 recovering）
 *     unknown    → healthy     WARMUP_SUCCESSES 次连续成功
 *     unknown    → unhealthy   FAILURE_THRESHOLD 次连续失败
 *     healthy    → degraded    单次失败（事实可见，但不判死）
 *     healthy    → unhealthy   连续 N 次失败
 *     degraded   → degraded    继续失败但未达 N
 *     degraded   → unhealthy   第 N 次连续失败
 *     degraded   → recovering  一次成功（不足以直接回 healthy）
 *     degraded   → healthy     WARMUP_SUCCESSES 次连续成功
 *     recovering → healthy     cs ≥ RECOVERY_SUCCESSES 且成功率回升
 *     recovering → degraded    单次失败（证据变坏，取悲观）
 *     recovering → unhealthy   连续 N 次失败
 *     unhealthy  → unhealthy   单次成功不改变状态（迟滞出）
 *     unhealthy  → recovering  cs ≥ RECOVERY_SUCCESSES（**唯一**出口）
 *     任意        → unknown     证据全部 stale
 *
 *   契约状态表里 `recovering` 的定义是「刚从 `unhealthy` 出来」，warm-up 又写了
 *   「一次成功只到 `recovering`」；两处都指向同一条不变量：**成功不足以立刻回到
 *   `healthy`**。所以 `recovering` 在本模块里是「有成功证据、但成功连续数还不够」
 *   的统一落点，`unhealthy` 的出口也只有它一条（`unhealthy → recovering → healthy`
 *   与 Gate V5-G2 要求的路径一致）。这一点在交付说明里作为契约歧义单独报告。
 *
 * ── 不改 desired ──
 *
 * 本模块的批量入口 `synthesiseTargetPool` **原样**返回输入里每一个 target（同样的
 * 顺序、同样的条数），只附加一份 view：合成既不删目标、也不改写目标、更不排序。
 * §7.3 明令「observation 直接 delete target」「用 Agent 本地状态覆盖 Panel desired」
 * 都是禁止项 —— 一个 `unhealthy` 的 target 必须仍然出现在输出里，只是带着它的状态。
 */
import {
  TARGET_HEALTH_THRESHOLDS,
  TARGET_HEALTH_VALUE_DOMAIN,
  type TargetHealthThresholds,
} from "./target-health-thresholds.ts";

/* ================================================================== */
/* 五态与严重度全序                                                     */
/* ================================================================== */

/** 契约状态表里的五个状态（顺序与 §7 状态表一致，测试会钉住）。 */
export const TARGET_HEALTH_STATES = [
  "unknown",
  "healthy",
  "degraded",
  "unhealthy",
  "recovering",
] as const;

export type TargetHealthValue = (typeof TARGET_HEALTH_STATES)[number];

/**
 * 严重度全序（越靠后越坏）：多观测者「取最坏」与 flap 压制都读它。
 *
 * 为什么 `recovering` 比 `healthy` 坏、比 `degraded` 好：`recovering` 的明确定义是
 * 「刚从 `unhealthy` 出来、成功率还没回升」，它比 `healthy` 少了「已经稳定」这件事；
 * 而它比 `degraded` 好，是因为它最新的证据是「可达且连续成功」，`degraded` 里的
 * 失败/劣化证据是更新的。§7 没有给这条全序，本模块把它显式写在一处并说明理由，
 * 而不是让每个消费者各排一次。
 *
 * `unknown` 排最前（最轻）只用于「合并时不会被选中」：它表示**没有证据**，不是
 * 「好」。所以任何「取最坏」的实现都不能让 `unknown` 赢过一个真实的坏结论 —— 而
 * 在只有 `unknown` 时，结果必须是 `unknown`（不是 healthy）。
 */
export const TARGET_HEALTH_SEVERITY_ORDER = [
  "unknown",
  "healthy",
  "recovering",
  "degraded",
  "unhealthy",
] as const;

function severityOf(state: TargetHealthValue): number {
  return TARGET_HEALTH_SEVERITY_ORDER.indexOf(state);
}

/** `unknown` 只表示「没有证据」，不参与严重度比较与抖动统计。 */
function isHealthBearing(state: TargetHealthValue): boolean {
  return state !== "unknown";
}

export function isTargetHealthState(value: unknown): value is TargetHealthValue {
  return typeof value === "string" && (TARGET_HEALTH_STATES as readonly string[]).includes(value);
}

/** 两个结论取最坏（可用性上的 fail-closed）。 */
export function worstTargetHealth(a: TargetHealthValue, b: TargetHealthValue): TargetHealthValue {
  return severityOf(a) >= severityOf(b) ? a : b;
}

/* ================================================================== */
/* 机器可读理由                                                         */
/* ================================================================== */

/** 理由码：让 UI / Decision 层能对「为什么是这个状态」下判断，而不是解析文案。 */
export const TARGET_HEALTH_REASONS = [
  "no_observation",
  "observation_stale",
  "observation_unusable",
  "failure_threshold",
  "failure_subthreshold",
  "recovery_hysteresis",
  "left_unhealthy",
  "recovered",
  "unreachable_subthreshold",
  "counters_unknown",
  "latency_unknown",
  "success_rate_unknown",
  "success_rate_below_healthy",
  "latency_degraded",
  "warmup_hysteresis",
  "warmup_complete",
  "healthy_retained",
  "observers_disagree",
  "flapping_capped",
] as const;

export type TargetHealthReason = (typeof TARGET_HEALTH_REASONS)[number];

/**
 * 理由码 → 一句话。`Record` 而不是 `switch`：漏一个码编译期就会红。
 *
 * 文案面向运维（「下一步能做什么」），不暴露内部阈值名字；具体数值由 UI 从
 * `TARGET_HEALTH_THRESHOLDS` 取，避免两处各写一份而漂移。
 */
const TARGET_HEALTH_REASON_TEXT: Record<TargetHealthReason, string> = {
  no_observation: "该目标从未被观测过",
  observation_stale: "观测已过期，等同于没有证据",
  observation_unusable: "观测记录不可读（缺少观测方或可达事实）",
  failure_threshold: "连续失败次数已达阈值",
  failure_subthreshold: "出现失败但未达阈值：降级观察，不判死",
  recovery_hysteresis: "刚从故障中出来，连续成功次数还不够",
  left_unhealthy: "已离开不健康状态，正在恢复观察期",
  recovered: "恢复观察期结束：连续成功且成功率已回升",
  unreachable_subthreshold: "最近一次探测不可达，但连续失败未达阈值",
  counters_unknown: "缺少连续成功/失败计数，无法确认健康",
  latency_unknown: "连接耗时不可读，无法确认健康",
  success_rate_unknown: "成功率缺失或越界，无法确认健康",
  success_rate_below_healthy: "成功率低于健康线",
  latency_degraded: "连接耗时超过劣化线",
  warmup_hysteresis: "首次/再次出现：一次成功不足以判定健康",
  warmup_complete: "连续成功次数已满足 warm-up",
  healthy_retained: "已是健康状态，单次成功不改变结论",
  observers_disagree: "多个观测者对同一目标的结论不一致",
  flapping_capped: "窗口内状态反复翻转，结论被压制为不超过 degraded",
};

export function describeTargetHealthReason(reason: TargetHealthReason): string {
  return TARGET_HEALTH_REASON_TEXT[reason] ?? "目标健康状态未知";
}

/* ================================================================== */
/* 输入（全部是已读出的纯事实）                                          */
/* ================================================================== */

/**
 * 观测来源（§7 结论 1/5/6）：谁说的 —— 节点标识 + 探测种类。
 *
 * RELAY 的目标由**出口节点**观测（它是真正拨号的一方），所以同一个 host:port 被
 * 两个节点观测是**两条不同的事实**，不能让它们互相覆盖。字段刻意保留 `probe`：
 * 同一节点上的「有界 TCP 连接」与将来的其它口径也是两条不同的事实。
 *
 * `node_id` 允许字符串，是因为线上的来源是一个字符串
 * （agent `targetobs.ObservationSource` = `<node>/<probe_kind>`，例如
 * `"node-7/tcp_connect"`）；`{ node_id, probe }` 对象形态同样接收，两种形状
 * 归一化后完全等价。
 */
export interface TargetObservationSource {
  readonly node_id: string | number;
  readonly probe: string;
}

/**
 * §7 结论 6 的 8 个事实。
 *
 * 字段可缺，是因为这里描述的是「从 DB 投影 / 从线上收到的那条记录」：旧 Agent、
 * 半写入的行、被截断的 JSON 都可能缺字段。缺字段 = **不可读 ≠ 0**（这是 §7
 * 「缺字段不得被当成健康」的落地）：不可读的记录永远不能合成出 `healthy`。
 *
 * `observation_age` 按结论 7 **不落库**，读取时算；这里两种来源都收：
 *   · `last_observed_at` —— 权威（age = now - last_observed_at，现算）；
 *   · `observation_age_ms` / `observation_age` —— 调用方已经算好的 age。
 * 两者同时给出时**以 `last_observed_at` 为准**：一个与时间戳矛盾的 age 不得把旧
 * 观测「洗」成新鲜（测试里有一条专门证明这点）。
 *
 * 时间戳三种形状都收：`Date`（Prisma 读回来的行）、字符串（ISO）、数字
 * （线上 unix **秒**，或 `Date.getTime()` 的毫秒 —— 单位由量级判定）。
 * `observed_at` 是 `target_observation.observed_at` 的别名（DB 列名）。
 */
export interface TargetObservation {
  /**
   * 线上形状是字符串 `<node>/<probe_kind>`（agent `targetobs`），
   * 也接受 `{ node_id, probe }` 对象。**无法归属观测方**的记录不是证据。
   */
  readonly observation_source?: string | TargetObservationSource | null;
  /** 上一次探测是否连上（§7 结论 3）。 */
  readonly reachable?: boolean | null;
  /** 连接耗时（ms）；不可达为 null（「没有这个事实」，不是 0）。 */
  readonly latency_ms?: number | null;
  /** 自上次状态翻转起的连续成功计数。 */
  readonly consecutive_success?: number | null;
  /** 自上次状态翻转起的连续失败计数。 */
  readonly consecutive_failure?: number | null;
  /** 最近 `SUCCESS_RATE_WINDOW` 次探测的成功比例，由**观测方**计算（面板不重算）。 */
  readonly success_rate?: number | null;
  readonly last_observed_at?: Date | string | number | null;
  /** `target_observation.observed_at` 列的别名（DB 读路径直接透传时用）。 */
  readonly observed_at?: Date | string | number | null;
  readonly observation_age_ms?: number | null;
  /** 契约字段名的别名，便于直接回传 DB/JSON 里的 `observation_age`。 */
  readonly observation_age?: number | null;
}

/** 上一次的合成结果（调用方回传即可，`TargetHealthView` 结构上满足它）。 */
export interface PreviousTargetHealth {
  readonly state: TargetHealthValue;
  /** 上次结果里回传的翻转时刻（epoch ms）。 */
  readonly recent_flips?: readonly number[];
}

/** 上一次的合成结果集合：按 target（host:port）索引，`Map` 或普通对象都收。 */
export type TargetHealthMemory =
  | ReadonlyMap<string, PreviousTargetHealth>
  | Readonly<Record<string, PreviousTargetHealth>>;

/* ================================================================== */
/* 输出（view：面板要显示的事实 + 结论）                                 */
/* ================================================================== */

/** 单个观测者的结论与它自己的事实（「一个节点说通、另一个说断」的展示面）。 */
export interface TargetObserverHealth {
  observer: TargetObservationSource | null;
  /** 展示用标签（`node_id:probe`）。 */
  observer_label: string;
  /** 该观测者的结论；它不构成证据时是 `unknown`。 */
  state: TargetHealthValue;
  /** 这条记录是否构成「非 stale 的可用证据」。 */
  evidence: boolean;
  /** 记录形状是否可读。 */
  usable: boolean;
  /** `age > STALE_AFTER_MS`。 */
  stale: boolean;
  age_ms: number | null;
  reasons: TargetHealthReason[];
  reachable: boolean | null;
  latency_ms: number | null;
  consecutive_success: number | null;
  consecutive_failure: number | null;
  success_rate: number | null;
  last_observed_at: string | null;
}

/** 合成后的 operator 事实（从「决定结论的那个观测者」取，绝不跨观测者拼凑）。 */
export interface TargetHealthFacts {
  /** 是否存在非 stale 的可用证据（false ⇒ 结论必然是 `unknown`）。 */
  evidence: boolean;
  observers: number;
  fresh_observers: number;
  stale_observers: number;
  unusable_observers: number;
  /** 决定结论的那个观测者（同严重度时按输入顺序取第一个）。 */
  worst_observer: TargetObservationSource | null;
  reachable: boolean | null;
  latency_ms: number | null;
  consecutive_success: number | null;
  consecutive_failure: number | null;
  success_rate: number | null;
  last_observed_at: string | null;
  age_ms: number | null;
  /** 新鲜观测者之间的结论不一致（「一个节点说通、另一个说断」）。 */
  disagreement: boolean;
}

/** 一个 target 的合成结果。**这是 view，不是 desired**：它不携带任何写路径。 */
export interface TargetHealthView {
  /** 目标身份 `host:port`，原样回显（合成不改写 identity）。 */
  target: string;
  state: TargetHealthValue;
  reasons: TargetHealthReason[];
  /** 窗口内状态反复翻转（§7 flap）。 */
  flapping: boolean;
  observers: TargetObserverHealth[];
  facts: TargetHealthFacts;
  /** 供下次调用回传：窗口内的翻转时刻（epoch ms）。 */
  recent_flips: number[];
}

export interface TargetHealthInput {
  target: string;
  observations: readonly TargetObservation[];
  previous?: PreviousTargetHealth | null;
  /** 判定时刻：注入，不读环境时钟。 */
  now: Date;
  thresholds?: Partial<TargetHealthThresholds> | null;
}

/** 一个 target 的期望身份 + 它的观测（按 (观测节点, target) 二维）。 */
export interface TargetObservationGroup {
  readonly target: string;
  readonly observations: readonly TargetObservation[];
}

export interface TargetHealthPoolInput {
  /**
   * 期望目标清单。**原样进、原样出**：同样的顺序、同样的条数、同样的重复项。
   * 合成没有删除权（§7.3 禁止 observation 直接 delete target）。
   */
  readonly targets: readonly TargetObservationGroup[];
  readonly previous?: TargetHealthMemory | null;
  readonly now: Date;
  readonly thresholds?: Partial<TargetHealthThresholds> | null;
}

/* ================================================================== */
/* 事实读取（坏形状一律 fail-closed，绝不补默认值）                       */
/* ================================================================== */

interface ReadObservation {
  usable: boolean;
  stale: boolean;
  age_ms: number | null;
  last_observed_at_ms: number | null;
  /** null = 记录里没有这个事实；undefined = 有但不可读。 */
  reachable: boolean | null;
  latency_ms: number | null | undefined;
  consecutive_success: number | null;
  consecutive_failure: number | null;
  success_rate: number | null;
  observer: TargetObservationSource | null;
  observer_label: string;
}

function resolveThresholds(override?: Partial<TargetHealthThresholds> | null): TargetHealthThresholds {
  if (!override) return TARGET_HEALTH_THRESHOLDS;
  return { ...TARGET_HEALTH_THRESHOLDS, ...override };
}

function asCount(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isInteger(value)) return null;
  if (value < TARGET_HEALTH_VALUE_DOMAIN.COUNTER_MIN) return null;
  return value;
}

/** 延迟：`null` = 没有这个事实（不可达），数字 = 有事实。坏形状给 `undefined`。 */
function asLatency(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number") return undefined;
  if (!Number.isFinite(value)) return undefined;
  if (value < TARGET_HEALTH_VALUE_DOMAIN.LATENCY_MIN) return undefined;
  return value;
}

/** 成功率：越界/非数一律「不可读」，不 clamp（clamp 会把 1.5 洗成健康）。 */
function asRate(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value)) return null;
  if (value < TARGET_HEALTH_VALUE_DOMAIN.SUCCESS_RATE_MIN) return null;
  if (value > TARGET_HEALTH_VALUE_DOMAIN.SUCCESS_RATE_MAX) return null;
  return value;
}

function asEpochMs(value: Date | string | number | null | undefined): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return ms > TARGET_HEALTH_VALUE_DOMAIN.EPOCH_MIN ? ms : null;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= TARGET_HEALTH_VALUE_DOMAIN.EPOCH_MIN) return null;
    // 线上是 unix 秒（§7 结论 6 的 `last_observed_at`），DB 读回来是毫秒；
    // 单位由量级判定，见 `TARGET_HEALTH_VALUE_DOMAIN.EPOCH_MILLIS_CUTOFF`。
    return value >= TARGET_HEALTH_VALUE_DOMAIN.EPOCH_MILLIS_CUTOFF
      ? value
      : value * TARGET_HEALTH_VALUE_DOMAIN.SECONDS_TO_MS;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const ms = Date.parse(value);
    return ms > TARGET_HEALTH_VALUE_DOMAIN.EPOCH_MIN ? ms : null;
  }
  return null;
}

/**
 * 观测方归一化。两种线上/投影形状都收：
 *   · 字符串 `<node>/<probe_kind>`（agent `targetobs.ObservationSource`）；
 *   · 对象 `{ node_id, probe }`（DB 投影用 `node_id` 列 + `observation_source` 列拼）。
 * 分不开「谁说的」的记录不是证据（§7 结论 5：证据是按 (观测节点, target) 二维的）。
 */
function asSource(value: unknown): TargetObservationSource | null {
  if (typeof value === "string") {
    const [node, ...rest] = value.trim().split("/");
    const probe = rest.join("/");
    if (!node || !probe) return null;
    return { node_id: node, probe };
  }
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const node = raw.node_id;
  if (typeof node === "number") {
    if (!Number.isFinite(node)) return null;
  } else if (typeof node !== "string" || node.trim() === "") {
    return null;
  }
  if (typeof raw.probe !== "string" || raw.probe.trim() === "") return null;
  return { node_id: node, probe: raw.probe };
}

function observerLabel(source: TargetObservationSource | null): string {
  return source === null ? "unknown" : `${source.node_id}:${source.probe}`;
}

function readObservation(observation: TargetObservation, now: Date, thresholds: TargetHealthThresholds): ReadObservation {
  const observer = asSource(observation.observation_source);
  const lastObservedAt = asEpochMs(
    observation.last_observed_at ?? observation.observed_at ?? null,
  );
  const explicitAge =
    typeof observation.observation_age_ms === "number" && Number.isFinite(observation.observation_age_ms)
      ? observation.observation_age_ms
      : typeof observation.observation_age === "number" && Number.isFinite(observation.observation_age)
        ? observation.observation_age
        : null;
  // §7 结论 7：age 是 `now - last_observed_at`，读取时算。时间戳在时它权威。
  const age = lastObservedAt === null ? explicitAge : now.getTime() - lastObservedAt;
  const reachable = typeof observation.reachable === "boolean" ? observation.reachable : null;
  const usable = observer !== null && reachable !== null && age !== null;
  return {
    usable,
    // stale 只看 age：一条不可读但过期的记录，两个事实都要让面板看到。
    stale: age !== null && age > thresholds.STALE_AFTER_MS,
    age_ms: age,
    last_observed_at_ms: lastObservedAt,
    reachable,
    latency_ms: asLatency(observation.latency_ms),
    consecutive_success: asCount(observation.consecutive_success),
    consecutive_failure: asCount(observation.consecutive_failure),
    success_rate: asRate(observation.success_rate),
    observer,
    observer_label: observerLabel(observer),
  };
}

/* ================================================================== */
/* 状态机（单观测者；迟滞在这里落地）                                    */
/* ================================================================== */

interface ObserverDecision {
  state: TargetHealthValue;
  reasons: TargetHealthReason[];
}

/**
 * 单观测者的状态机。
 *
 * `previous` 是**上一轮合成出来的目标状态**（多观测者取最坏之后的那一个），不是
 * 「上一个观测者的状态」：迟滞属于 target，不属于视角 —— 一个新增的观测者不能让
 * 整条恢复路径重来（但它自己会走 warm-up，见下面的 6/7 分支）。
 */
function decideObserverState(
  previous: TargetHealthValue | null,
  facts: ReadObservation,
  thresholds: TargetHealthThresholds,
): ObserverDecision {
  const failure = facts.consecutive_failure;
  const success = facts.consecutive_success;
  const rate = facts.success_rate;
  const latency = facts.latency_ms;
  const prior = previous ?? "unknown";

  // 1. 迟滞进：连续失败达到 N 才是 unhealthy。单次失败永远到不了这里。
  if (failure !== null && failure >= thresholds.FAILURE_THRESHOLD) {
    return { state: "unhealthy", reasons: ["failure_threshold"] };
  }

  // 2. 迟滞出：离开 unhealthy 只有「连续成功 M 次」一条路，且只落在 recovering。
  //    成功率是否回升是 recovering → healthy 的条件，不是离开 unhealthy 的条件
  //    （§7 状态表：recovering 明确要求「成功率尚未回到 HEALTHY_RATE」）。
  //    这条出口还要求证据**完整且自洽**（可达、零连败、连续计数可读）：用缺字段的
  //    记录把目标从 unhealthy 里放出来，等于用「不知道」证明「已经好了」。
  if (prior === "unhealthy") {
    const proven =
      facts.reachable === true &&
      failure === TARGET_HEALTH_VALUE_DOMAIN.COUNTER_MIN &&
      success !== null &&
      success >= thresholds.RECOVERY_SUCCESSES;
    if (!proven) {
      return { state: "unhealthy", reasons: ["recovery_hysteresis"] };
    }
    return { state: "recovering", reasons: ["left_unhealthy"] };
  }

  // 3. 0 < cf < N：§7 状态表的 degraded 行。
  if (failure !== null && failure > TARGET_HEALTH_VALUE_DOMAIN.COUNTER_MIN) {
    return { state: "degraded", reasons: ["failure_subthreshold"] };
  }

  // 4. 不可达（即使计数缺失也按可达性这一条最硬的事实判）。
  if (facts.reachable !== true) {
    return { state: "degraded", reasons: ["unreachable_subthreshold"] };
  }

  // 5. 缺字段不是 0：不可读的字段一律不能升级为 healthy。
  if (failure === null || success === null) {
    return { state: "degraded", reasons: ["counters_unknown"] };
  }
  if (latency === undefined) {
    return { state: "degraded", reasons: ["latency_unknown"] };
  }
  if (rate === null) {
    return { state: "degraded", reasons: ["success_rate_unknown"] };
  }
  if (rate < thresholds.HEALTHY_RATE) {
    return { state: "degraded", reasons: ["success_rate_below_healthy"] };
  }
  if (latency !== null && latency > thresholds.LATENCY_DEGRADED_MS) {
    return { state: "degraded", reasons: ["latency_degraded"] };
  }

  // 到这里：可达、cf == 0、成功率达标、延迟达标 —— 事实层已经「好」，剩下的只有迟滞。
  // 6. 恢复观察期：连续成功够了、成功率也回升了，才结束 recovering。
  if (prior === "recovering") {
    if (success >= thresholds.RECOVERY_SUCCESSES) {
      return { state: "healthy", reasons: ["recovered"] };
    }
    return { state: "recovering", reasons: ["recovery_hysteresis"] };
  }

  // 7. warm-up：一次成功只到 recovering（§7 明文），连续 W 次才到 healthy。
  if (success >= thresholds.WARMUP_SUCCESSES) {
    return { state: "healthy", reasons: ["warmup_complete"] };
  }
  // 已经 healthy 的 target：单次成功不改变结论（否则健康列会被噪声推着走）。
  if (prior === "healthy") {
    return { state: "healthy", reasons: ["healthy_retained"] };
  }
  return { state: "recovering", reasons: ["warmup_hysteresis"] };
}

/* ================================================================== */
/* 单观测者：读事实 → 判状态                                            */
/* ================================================================== */

export interface ObserverEvaluationInput {
  observation: TargetObservation;
  /** 上一轮合成的目标状态；null = 没有历史。 */
  previous_state?: TargetHealthValue | null;
  now: Date;
  thresholds?: Partial<TargetHealthThresholds> | null;
}

/** 单个观测者的结论（导出供测试与诊断直接使用）。 */
export function evaluateTargetObservation(input: ObserverEvaluationInput): TargetObserverHealth {
  return evaluate(input.observation, input.previous_state ?? null, input.now, resolveThresholds(input.thresholds));
}

function evaluate(
  observation: TargetObservation,
  previousState: TargetHealthValue | null,
  now: Date,
  thresholds: TargetHealthThresholds,
): TargetObserverHealth {
  const facts = readObservation(observation, now, thresholds);
  const base = {
    observer: facts.observer,
    observer_label: facts.observer_label,
    usable: facts.usable,
    stale: facts.stale,
    age_ms: facts.age_ms,
    reachable: facts.reachable,
    latency_ms: typeof facts.latency_ms === "number" ? facts.latency_ms : null,
    consecutive_success: facts.consecutive_success,
    consecutive_failure: facts.consecutive_failure,
    success_rate: facts.success_rate,
    last_observed_at: facts.last_observed_at_ms === null ? null : new Date(facts.last_observed_at_ms).toISOString(),
  };

  if (!facts.usable) {
    const reasons: TargetHealthReason[] = ["observation_unusable"];
    if (facts.stale) reasons.push("observation_stale");
    return { ...base, state: "unknown", evidence: false, reasons };
  }
  if (facts.stale) {
    // §7 结论 8：stale 的观测等同于「没有证据」——不是「继续沿用最后一次结果」。
    return { ...base, state: "unknown", evidence: false, reasons: ["observation_stale"] };
  }
  const decision = decideObserverState(previousState, facts, thresholds);
  return { ...base, state: decision.state, evidence: true, reasons: decision.reasons };
}

/* ================================================================== */
/* 单 target 合成                                                      */
/* ================================================================== */

/** 合成一个 target 的 view（纯函数：同样的 `now` + 同样的输入 ⇒ 同样的输出）。 */
export function synthesiseTargetHealth(input: TargetHealthInput): TargetHealthView {
  const thresholds = resolveThresholds(input.thresholds);
  const previousState = isTargetHealthState(input.previous?.state) ? input.previous.state : null;
  const observations = input.observations ?? [];

  const observers = observations.map((observation) =>
    evaluate(observation, previousState, input.now, thresholds),
  );

  // ── partial visibility：只在**非 stale 的可用证据**里取最坏 ──
  let worst: TargetObserverHealth | null = null;
  for (const observer of observers) {
    if (!observer.evidence) continue;
    if (worst === null || severityOf(observer.state) > severityOf(worst.state)) worst = observer;
  }

  const reasons: TargetHealthReason[] = [];
  if (!observers.length) reasons.push("no_observation");
  for (const observer of observers) {
    for (const reason of observer.reasons) {
      if (!reasons.includes(reason)) reasons.push(reason);
    }
  }

  // 「一个节点说通、另一个说断」：只看**新鲜**观测者之间是否出现不同结论。
  // 用一个显式的比较循环而不是 `new Set(...).size > 1`，是为了让「不一致」这件事
  // 不依赖任何数值字面量（见本文件顶部的「阈值集中」纪律）。
  let firstFreshState: TargetHealthValue | null = null;
  let disagreement = false;
  for (const observer of observers) {
    if (!observer.evidence) continue;
    if (firstFreshState === null) {
      firstFreshState = observer.state;
      continue;
    }
    if (observer.state !== firstFreshState) disagreement = true;
  }
  if (disagreement) reasons.push("observers_disagree");

  const evidenceState: TargetHealthValue = worst === null ? "unknown" : worst.state;

  // ── flap：窗口内的翻转次数（unknown 之间的迁移不算翻转）──
  const windowStart = input.now.getTime() - thresholds.FLAP_WINDOW_MS;
  const carriedFlips = input.previous?.recent_flips;
  const recentFlips = (Array.isArray(carriedFlips) ? carriedFlips : []).filter(
    (at) => Number.isFinite(at) && at >= windowStart,
  );
  recentFlips.sort((a, b) => a - b);
  const flipped =
    previousState !== null &&
    isHealthBearing(previousState) &&
    isHealthBearing(evidenceState) &&
    previousState !== evidenceState;
  if (flipped) recentFlips.push(input.now.getTime());
  const flapping = recentFlips.length > thresholds.FLAP_FLIPS;

  let state = evidenceState;
  if (flapping && isHealthBearing(state) && severityOf(state) < severityOf("degraded")) {
    // 「压制为不超过 degraded」：只压 healthy / recovering。unhealthy 绝不被压制 ——
    // 那会把真实故障换成「只是降级」，是往危险方向放宽。
    state = "degraded";
    reasons.push("flapping_capped");
  }

  return {
    target: input.target,
    state,
    reasons,
    flapping,
    observers,
    facts: {
      evidence: worst !== null,
      observers: observers.length,
      fresh_observers: observers.filter((observer) => observer.evidence).length,
      stale_observers: observers.filter((observer) => observer.stale).length,
      unusable_observers: observers.filter((observer) => !observer.usable).length,
      worst_observer: worst === null ? null : worst.observer,
      reachable: worst === null ? null : worst.reachable,
      latency_ms: worst === null ? null : worst.latency_ms,
      consecutive_success: worst === null ? null : worst.consecutive_success,
      consecutive_failure: worst === null ? null : worst.consecutive_failure,
      success_rate: worst === null ? null : worst.success_rate,
      last_observed_at: worst === null ? null : worst.last_observed_at,
      age_ms: worst === null ? null : worst.age_ms,
      disagreement,
    },
    recent_flips: recentFlips,
  };
}

/* ================================================================== */
/* 批量：期望清单进 → view 清单出（同样顺序、同样条数）                  */
/* ================================================================== */

function lookupPrevious(
  memory: TargetHealthMemory | null | undefined,
  target: string,
): PreviousTargetHealth | null {
  if (!memory) return null;
  if (typeof (memory as ReadonlyMap<string, PreviousTargetHealth>).get === "function") {
    return (memory as ReadonlyMap<string, PreviousTargetHealth>).get(target) ?? null;
  }
  const record = memory as Readonly<Record<string, PreviousTargetHealth>>;
  // `Object.hasOwn`：避免 `constructor` / `toString` 这类原型键被当成历史状态。
  return Object.hasOwn(record, target) ? (record[target] ?? null) : null;
}

/**
 * 合成一份期望目标清单的 view。
 *
 * 返回值与 `input.targets` **一一对应**：顺序相同、条数相同（包括重复项），
 * 一个 `unknown` 或 `unhealthy` 的 target 依然在结果里。这不是「方便」，而是
 * §7.3 的禁止项：telemetry 不得改写 / 删除 desired 目标，哪怕是「没用了」的目标。
 * 想过滤是调用方的事，而且过滤器不该在这里。
 */
export function synthesiseTargetPool(input: TargetHealthPoolInput): TargetHealthView[] {
  const thresholds = resolveThresholds(input.thresholds);
  return input.targets.map((group) =>
    synthesiseTargetHealth({
      target: group.target,
      observations: group.observations ?? [],
      previous: lookupPrevious(input.previous, group.target),
      now: input.now,
      thresholds,
    }),
  );
}
