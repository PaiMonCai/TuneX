/**
 * V5.2 §7 —— 目标健康的**前端镜像**（纯逻辑：无 React、无 IO、不保存任何派生的时间事实）。
 *
 * ── 为什么只有一个模块 ──
 * 五个状态、19 个理由码、以及「缺字段不是 0」「stale 等于没有证据」这几条，都是**契约**
 * 而不是界面口味。后端已经把它们放在一处（`backend/src/services/target-health.ts` 与
 * `target-health-thresholds.ts`），前端如果各处各写一份 switch，就会出现「列表说健康、
 * 详情说降级」。这里因此只留一份实现，并由
 * `components/admin/__tests__/target-health-surface.test.ts` **直接读后端源码**做集合
 * 断言：后端加一个状态/理由码而前端没跟上，测试立刻红。
 *
 * ── 三条不允许走捷径的边界（§7 冻结块逐条落地）──
 *
 *   1. **`unknown` 是「没有证据」，不是「好」**。它在契约全序里比 `healthy` 更差，
 *      在界面上必须与 `healthy` 长得完全不一样，文案里必须出现「没有证据」。
 *   2. **多观测者取最坏，且逐观测者明细必须保留**。「一个节点说通、另一个说断」本身
 *      就是运维要看的信号，所以本模块**不提供**任何「把多个观测者合成一个数字」的
 *      函数 —— 要展示就把两条都展示出来。
 *   3. **age 现算、不落库**（§7 结论 7）。视图里的 `facts.age_ms` 是后端在
 *      `observed_at` 那一刻算出来的；页面挂久了它就不再新鲜。所以这里提供
 *      `evidenceAgeMs()`：以 `observed_at` 为锚，用**本地时钟**把 age 推到此刻，
 *      超过 stale 线就标记为过期 —— 而**绝不**把它写回任何状态里。
 *
 * ── 本模块**不做**的事 ──
 * 不合成状态（那是后端的 `synthesiseTargetHealth`）、不取最坏（后端已经取过）、
 * 不重算成功率（§7 结论 6：成功率由观测方计算，面板不重算）、不改 desired。
 * 界面只负责把后端给的事实摆出来，并让「不知道」与「知道」在视觉上分得开。
 */
import type { Locale } from "./i18n";

/* ================================================================== */
/* 1. 状态（closed set：逐字镜像后端 `TARGET_HEALTH_STATES`）            */
/* ================================================================== */

/** 契约状态表里的五个状态（顺序与 §7 状态表一致，测试钉住）。 */
export const TARGET_HEALTH_STATES = [
  "unknown",
  "healthy",
  "degraded",
  "unhealthy",
  "recovering",
] as const;

export type TargetHealthState = (typeof TARGET_HEALTH_STATES)[number];

/**
 * 严重度全序（§7 冻结块）：`unknown < healthy < recovering < degraded < unhealthy`。
 *
 * 界面**不**用它来合成结论（后端已经取过最坏），只用它做展示层的排序/分组提示。
 * 之所以仍然镜像：任何按「更差」排序的界面都必须与后端同一个方向，否则同一份数据
 * 在两个页面上顺序不同。
 */
export const TARGET_HEALTH_SEVERITY_ORDER = [
  "unknown",
  "healthy",
  "recovering",
  "degraded",
  "unhealthy",
] as const;

export function isTargetHealthState(value: unknown): value is TargetHealthState {
  return (
    typeof value === "string" &&
    (TARGET_HEALTH_STATES as readonly string[]).includes(value)
  );
}

/* ================================================================== */
/* 2. 理由码（closed set：逐字镜像后端 `TARGET_HEALTH_REASONS`）         */
/* ================================================================== */

/** 「为什么是这个状态」的机器可读码（后端 `TARGET_HEALTH_REASONS`）。 */
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

export function isTargetHealthReason(value: unknown): value is TargetHealthReason {
  return (
    typeof value === "string" &&
    (TARGET_HEALTH_REASONS as readonly string[]).includes(value)
  );
}

/**
 * 理由码 → 运维能读的一句话（两种语言）。
 *
 * 用 `Record<TargetHealthReason, …>` 而不是 `switch`：后端加一个码而这里没跟上，
 * **编译期**就红（与后端 `TARGET_HEALTH_REASON_TEXT` 同一手法）。文案面向「下一步
 * 能做什么」，不暴露内部阈值名字。
 */
export const TARGET_HEALTH_REASON_TEXT: Record<
  TargetHealthReason,
  { readonly zh: string; readonly en: string }
> = {
  no_observation: { zh: "该目标从未被观测过", en: "This target has never been observed" },
  observation_stale: {
    zh: "观测已过期，等同于没有证据",
    en: "The observation is stale — equivalent to having no evidence",
  },
  observation_unusable: {
    zh: "观测记录不可读（缺少观测方或可达事实）",
    en: "The observation row is unreadable (no observer or no reachability fact)",
  },
  failure_threshold: {
    zh: "连续失败次数已达阈值",
    en: "Consecutive failures reached the threshold",
  },
  failure_subthreshold: {
    zh: "出现失败但未达阈值：降级观察，不判死",
    en: "Failures below the threshold: degraded, not condemned",
  },
  recovery_hysteresis: {
    zh: "刚从故障中出来，连续成功次数还不够",
    en: "Just left a failure: consecutive successes are not enough yet",
  },
  left_unhealthy: {
    zh: "已离开不健康状态，正在恢复观察期",
    en: "Left the unhealthy state; the recovery window is running",
  },
  recovered: {
    zh: "恢复观察期结束：连续成功且成功率已回升",
    en: "Recovery window finished: consecutive successes and the success rate recovered",
  },
  unreachable_subthreshold: {
    zh: "最近一次探测不可达，但连续失败未达阈值",
    en: "The last probe was unreachable, but consecutive failures are below the threshold",
  },
  counters_unknown: {
    zh: "缺少连续成功/失败计数，无法确认健康",
    en: "Consecutive success/failure counters are missing; health cannot be confirmed",
  },
  latency_unknown: {
    zh: "连接耗时不可读，无法确认健康",
    en: "Connect latency is unreadable; health cannot be confirmed",
  },
  success_rate_unknown: {
    zh: "成功率缺失或越界，无法确认健康",
    en: "The success rate is missing or out of range; health cannot be confirmed",
  },
  success_rate_below_healthy: {
    zh: "成功率低于健康线",
    en: "The success rate is below the healthy line",
  },
  latency_degraded: {
    zh: "连接耗时超过劣化线",
    en: "Connect latency is above the degraded line",
  },
  warmup_hysteresis: {
    zh: "首次/再次出现：一次成功不足以判定健康",
    en: "First (or renewed) appearance: one success is not enough to call it healthy",
  },
  warmup_complete: {
    zh: "连续成功次数已满足 warm-up",
    en: "Consecutive successes satisfied the warm-up",
  },
  healthy_retained: {
    zh: "已是健康状态，单次成功不改变结论",
    en: "Already healthy; a single success does not change the verdict",
  },
  observers_disagree: {
    zh: "多个观测者对同一目标的结论不一致",
    en: "Multiple observers disagree about this target",
  },
  flapping_capped: {
    zh: "窗口内状态反复翻转，结论被压制为不超过 degraded",
    en: "The state flipped repeatedly inside the window; the verdict is capped at degraded",
  },
};

export function targetHealthReasonText(
  reason: TargetHealthReason,
  locale: Locale | string,
): string {
  const text = TARGET_HEALTH_REASON_TEXT[reason];
  if (!text) return locale !== "en" ? "目标健康状态未知" : "Target health is unknown";
  return locale === "en" ? text.en : text.zh;
}

/**
 * 状态 → 界面文案。
 *
 * `label` 出现在徽标里，`hint` 出现在 title / 说明处。`unknown` 的两处都**必须**
 * 表达「没有证据」：写「未知」会被读成「还没算完」，写「正常」则是直接撒谎。
 */
export const TARGET_HEALTH_STATE_TEXT: Record<
  TargetHealthState,
  { readonly label: { zh: string; en: string }; readonly hint: { zh: string; en: string } }
> = {
  unknown: {
    label: { zh: "无观测证据", en: "No evidence" },
    hint: {
      zh: "没有可用的非过期观测：它既不是健康，也不是故障。观测恢复后会自动得到结论。",
      en: "No usable, non-stale observation: this is neither healthy nor failing. A verdict returns once observation resumes.",
    },
  },
  healthy: {
    label: { zh: "健康", en: "Healthy" },
    hint: {
      zh: "可达、成功率达标、延迟达标，且没有连续失败。",
      en: "Reachable, success rate and latency within the healthy lines, no consecutive failures.",
    },
  },
  degraded: {
    label: { zh: "降级", en: "Degraded" },
    hint: {
      zh: "有失败或劣化证据但未达判死阈值：可见，仍在服务。",
      en: "Failure or degradation evidence below the condemning threshold: visible, still serving.",
    },
  },
  unhealthy: {
    label: { zh: "不健康", en: "Unhealthy" },
    hint: {
      zh: "连续失败已达阈值。目标仍然在期望配置里，摘不摘由决策层与运维决定，观测没有删除权。",
      en: "Consecutive failures reached the threshold. The target stays in the desired configuration; observation has no authority to remove it.",
    },
  },
  recovering: {
    label: { zh: "恢复中", en: "Recovering" },
    hint: {
      zh: "已有成功证据，但连续成功/成功率还不足以确认恢复。",
      en: "Success evidence exists, but consecutive successes / success rate are not yet enough to confirm recovery.",
    },
  },
};

export function targetHealthStateLabel(
  state: TargetHealthState,
  locale: Locale | string,
): string {
  const text = TARGET_HEALTH_STATE_TEXT[state];
  return locale === "en" ? text.label.en : text.label.zh;
}

export function targetHealthStateHint(
  state: TargetHealthState,
  locale: Locale | string,
): string {
  const text = TARGET_HEALTH_STATE_TEXT[state];
  return locale === "en" ? text.hint.en : text.hint.zh;
}

/* ================================================================== */
/* 3. 展示归类：**穷尽 switch，没有 default**                            */
/* ================================================================== */

export type TargetHealthBadgeVariant =
  | "success"
  | "secondary"
  | "outline"
  | "destructive"
  | "muted";

/**
 * 状态 → 徽标变体。
 *
 * 这里刻意写成 `switch` 且**不写 default**：将来契约加第六个状态时，这个函数
 * 会因为没有返回值而**编译失败**，而不是悄悄落进某个默认分支、把新状态画成健康。
 * 五个分支的视觉差异是有意的：
 *   success     健康（唯一一个「好」的样子）
 *   secondary   恢复中（在推进，但还没好）
 *   outline+警示 降级（可见的劣化）
 *   destructive 不健康（判死）
 *   outline+虚线 无观测证据（灰、虚，明确区别于「健康」与「故障」）
 */
export function targetHealthBadgeVariant(
  state: TargetHealthState,
): TargetHealthBadgeVariant {
  switch (state) {
    case "healthy":
      return "success";
    case "recovering":
      return "secondary";
    case "degraded":
      return "outline";
    case "unhealthy":
      return "destructive";
    case "unknown":
      return "outline";
  }
}

/** 徽标的附加 class（区分 degraded 与 unknown 这两种都走 outline 的状态）。 */
export function targetHealthBadgeClass(state: TargetHealthState): string {
  switch (state) {
    case "degraded":
      return "border-[var(--warning,var(--border))] text-[var(--warning,currentColor)]";
    case "unknown":
      return "border-dashed text-[var(--muted-foreground)]";
    case "healthy":
    case "recovering":
    case "unhealthy":
      return "";
  }
}

/**
 * 结论的三种「性质」：好 / 需要注意 / 没有证据。
 *
 * 同样穷尽且无 default。把 `unknown` 单独一类（而不是塞进 attention）是有意的：
 * 「需要处理」暗示着存在一个坏事实，而 `unknown` 的全部含义是**没有事实**。
 */
export function targetHealthVerdict(
  state: TargetHealthState,
): "ok" | "attention" | "no-evidence" {
  switch (state) {
    case "healthy":
      return "ok";
    case "recovering":
    case "degraded":
    case "unhealthy":
      return "attention";
    case "unknown":
      return "no-evidence";
  }
}

/* ================================================================== */
/* 4. 视图形状（镜像后端 `TargetHealthView` 的投影）                      */
/* ================================================================== */

/** 单个观测者的结论与它自己的事实（「一个节点说通、另一个说断」的展示面）。 */
export interface TargetHealthObserverView {
  observer: { node_id: string | number; probe: string } | null;
  observer_label: string;
  state: TargetHealthState;
  /** 这条记录是否构成「非 stale 的可用证据」。 */
  evidence: boolean;
  usable: boolean;
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

/** 合成后的 operator 事实（取自决定结论的那个观测者，绝不跨观测者拼凑）。 */
export interface TargetHealthFacts {
  evidence: boolean;
  observers: number;
  fresh_observers: number;
  stale_observers: number;
  unusable_observers: number;
  worst_observer: { node_id: string | number; probe: string } | null;
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

/** 一个目标的合成结果。**这是 view，不是 desired**：它不携带任何写路径。 */
export interface TargetHealthTargetView {
  /** 目标身份 `host:port`（已归一化），原样回显。 */
  target: string;
  state: TargetHealthState;
  reasons: TargetHealthReason[];
  /** 窗口内状态反复翻转（§7 flap）。 */
  flapping: boolean;
  observers: TargetHealthObserverView[];
  facts: TargetHealthFacts;
  recent_flips: number[];
}

/** `GET /api/admin/node/pools/:poolId/health` 的响应体（api.ts 已剥掉 `{ data }`）。 */
export interface TargetPoolHealth {
  targets: TargetHealthTargetView[];
  /** 参与合成的观测节点 id（升序去重）。空数组 = 没有任何节点观测过。 */
  observers: number[];
  /** 本次合成时刻（ISO 字符串）：age 的换算锚点。 */
  observed_at: string;
}

/* ================================================================== */
/* 5. 目标身份：把「期望目标」与「健康视图」连起来                         */
/* ================================================================== */

/**
 * `host:port` 归一化 —— 镜像后端 `services/node-state.ts` 的 `targetKeyOf`。
 *
 * 为什么必须镜像：健康视图用**归一化后的** `host:port` 作为目标身份，而期望目标行
 * 带的是原始 `host` 文本。两边直接字符串比较会把 `10.0.0.1:80` 与 `10.0.0.1.:80`
 * 判成两个目标，于是「有观测的目标」在界面上显示成「无证据」——这正是本文件存在的
 * 那类静默错位。规则只有这一份，测试直接读后端源码比对。
 */
export function targetKeyOf(host: string, port: number): string | null {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^\[|\]$/g, "");
  if (!normalized || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return `${normalized}:${port}`;
}

/** 期望目标（`EgressTarget`）→ 健康视图里的 target 键。 */
export function poolTargetKey(target: { host: string; port: number }): string | null {
  return targetKeyOf(target.host, target.port);
}

/** 健康视图按 target 键建索引（一个键一条，后端不会重复）。 */
export function targetHealthIndex(
  health: Pick<TargetPoolHealth, "targets"> | null | undefined,
): Map<string, TargetHealthTargetView> {
  const map = new Map<string, TargetHealthTargetView>();
  for (const row of health?.targets ?? []) map.set(row.target, row);
  return map;
}

/**
 * 一个池的渲染行：**期望清单说了算**。
 *
 *   reported    期望里有、观测视图里也有 → 用合成结果渲染；
 *   missing     期望里有、视图里没有（响应比期望旧，或本该有的行没回来）→ 按
 *               「没有证据」渲染，**留在表里**：§7 禁止观测隐藏/删除一个期望目标，
 *               而界面把缺行静默丢掉正是那种删除；
 *   unexpected  视图里有、期望清单里没有（期望列表刚刚变化）→ 也渲染出来，
 *               并标出它不在期望清单里。收到的**事实**不静默丢弃。
 *
 * 顺序 = 期望顺序（`unhealthy` 不会被排到后面，也不会被过滤），这是「状态不改变
 * 目标的存在与位置」这条契约在界面上的落点。
 */
export type TargetHealthRow<T extends { host: string; port: number }> =
  | { kind: "reported"; key: string; desired: T; view: TargetHealthTargetView }
  | { kind: "missing"; key: string; desired: T; view: null }
  | { kind: "unexpected"; key: string; desired: null; view: TargetHealthTargetView };

export function buildTargetHealthRows<T extends { host: string; port: number }>(
  desired: readonly T[],
  health: Pick<TargetPoolHealth, "targets"> | null | undefined,
): TargetHealthRow<T>[] {
  const index = targetHealthIndex(health);
  const rows: TargetHealthRow<T>[] = [];
  const matched = new Set<string>();
  for (const target of desired) {
    const key = poolTargetKey(target);
    const view = key === null ? undefined : index.get(key);
    if (key !== null && view) {
      matched.add(key);
      rows.push({ kind: "reported", key, desired: target, view });
    } else {
      rows.push({ kind: "missing", key: key ?? `${target.host}:${target.port}`, desired: target, view: null });
    }
  }
  for (const view of health?.targets ?? []) {
    if (!matched.has(view.target)) {
      rows.push({ kind: "unexpected", key: view.target, desired: null, view });
    }
  }
  return rows;
}

/* ================================================================== */
/* 6. 证据新鲜度：客户端现算（§7 结论 7/8）                              */
/* ================================================================== */

/**
 * stale 阈值（ms）的**展示镜像**。
 *
 * 权威判定始终是后端在 `observed_at` 那一刻给出的 `facts.evidence` / `stale`；
 * 这里只是为了回答「页面挂到现在，这份证据过期了吗」。后端把阈值放在唯一一处
 * （`target-health-thresholds.ts` 的 `STALE_AFTER_MS = 3 × REPORT_INTERVAL_MS`），
 * 因此这个镜像由测试直接读后端源码钉住；改后端不改这里，测试会红。
 */
export const TARGET_HEALTH_STALE_AFTER_MS = 90_000;

export type TargetHealthFreshness = "fresh" | "stale" | "unknown";

/**
 * 把 age 推到**此刻**：`facts.age_ms`（后端算于 `observed_at`）+ 本地时钟走过的时间。
 *
 * 两个边界都要 fail-closed：
 *   · age 缺失 → `null`（「不知道多久没观测了」不得被当成新鲜）；
 *   · `observed_at` 不可解析 / 本地时钟早于它（时钟回拨）→ **不缩小** age，
 *     只按已给出的 age 显示（宁可显得旧，也不让旧证据显得新鲜）。
 */
export function evidenceAgeMs(
  factsAgeMs: number | null | undefined,
  observedAtIso: string | null | undefined,
  nowMs: number,
): number | null {
  if (factsAgeMs === null || factsAgeMs === undefined || !Number.isFinite(factsAgeMs)) {
    return null;
  }
  const observedAt = observedAtIso ? Date.parse(observedAtIso) : Number.NaN;
  if (!Number.isFinite(observedAt)) return factsAgeMs;
  const elapsed = nowMs - observedAt;
  if (!Number.isFinite(elapsed) || elapsed <= 0) return factsAgeMs;
  return factsAgeMs + elapsed;
}

/** age → 新鲜度。`null` 一律 `unknown`（没有这个事实，不是「新鲜」）。 */
export function targetHealthFreshness(
  ageMs: number | null,
  staleAfterMs: number = TARGET_HEALTH_STALE_AFTER_MS,
): TargetHealthFreshness {
  if (ageMs === null || !Number.isFinite(ageMs)) return "unknown";
  // 与 §7 结论 8 同一口径：`age > STALE_AFTER` 才算过期（严格大于）。
  return ageMs > staleAfterMs ? "stale" : "fresh";
}

/** age → 人读的持续时间（`null` = 没有这个事实，显示为「未知」而不是 0）。 */
export function formatObservationAge(
  ageMs: number | null,
  locale: Locale | string,
): string {
  if (ageMs === null || !Number.isFinite(ageMs) || ageMs < 0) {
    return locale === "en" ? "unknown" : "未知";
  }
  if (ageMs < 1000) return locale === "en" ? "<1s" : "不足 1 秒";
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return locale === "en" ? `${seconds}s ago` : `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return locale === "en" ? `${minutes}m ago` : `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  return locale === "en" ? `${hours}h ago` : `${hours} 小时前`;
}

/* ================================================================== */
/* 7. 观测者：展示两条，而不是合成一条                                    */
/* ================================================================== */

/**
 * 是否应该把逐观测者明细摊开展示。
 *
 * 规则刻意是「**多于一个**观测者就展开」，而不只是 `facts.disagreement === true`：
 * 两条观测是两条不同的事实（§7 结论 5），即使它们结论一致，运维也可能需要看到
 * 「是哪两个节点在观测」。`disagreement` 只决定是否额外给出「结论不一致」的提示。
 */
export function shouldShowObserverBreakdown(
  view: Pick<TargetHealthTargetView, "observers" | "facts">,
): boolean {
  return view.observers.length > 1 || view.facts.disagreement === true;
}

/** 后端已经判定的「观测者结论不一致」（只读，不重算）。 */
export function hasObserverDisagreement(
  view: Pick<TargetHealthTargetView, "facts">,
): boolean {
  return view.facts.disagreement === true;
}

/** 观测者展示标签；后端给的是 `node:probe`，缺失时回退到可辨认的占位。 */
export function observerDisplayLabel(observer: TargetHealthObserverView): string {
  const label = (observer.observer_label ?? "").trim();
  if (label !== "") return label;
  const source = observer.observer;
  if (source) return `${String(source.node_id)}:${source.probe}`;
  return "unknown";
}

/**
 * 观测参与方（响应级 `observers`）→ 展示文本。
 *
 * 后端为空数组时的含义是「没有任何节点观测过」，不是「观测者是 0 号节点」——
 * 这两种必须在文案上分开，所以这里返回 null 让调用方给专门的说明。
 */
export function observerNodesText(
  observers: readonly number[],
  locale: Locale | string,
): string | null {
  if (observers.length === 0) return null;
  const joined = observers.map((id) => String(id)).join(", ");
  return locale === "en" ? `Observed by node ${joined}` : `观测方：节点 ${joined}`;
}
