/**
 * V5-WP6 — 目标健康合成的**唯一**阈值来源（`DEVELOPMENT.md` §7 冻结块最后一条）。
 *
 * §7 明文：「所有阈值放在**一处**导出常量里（`TARGET_HEALTH_THRESHOLDS`），每项注明
 * 它保护什么。禁止散落 magic number」。所以这个文件是 `target-health.ts` 唯一的数字
 * 来源：合成模块里**不出现任何数值字面量**，有一条测试直接扫描源码证明这一点
 * （去掉注释与字符串后断言没有数字）。想调参的人只需要看这一个文件。
 *
 * ── 两类值必须分开看 ──
 *
 *   · **契约冻结值**（FAILURE_THRESHOLD / RECOVERY_SUCCESSES / WARMUP_SUCCESSES /
 *     SUCCESS_RATE_WINDOW / STALE_AFTER_MULTIPLIER）：§7 明文给了默认值或算式。
 *     改它们等于改契约，必须走 DEVELOPMENT.md 评审，不能顺手调。
 *   · **实现选值**（HEALTHY_RATE / LATENCY_DEGRADED_MS / REPORT_INTERVAL_MS /
 *     FLAP_*）：§7 只说「要有这条线」，没给数。每个值的取舍理由写在该字段上，
 *     并且 §7「开放产品决策」把它们列为待定 —— 因此它们可被调用方按部署覆盖
 *     （`synthesiseTargetHealth({ thresholds })`），而冻结值同样可覆盖，只是为了
 *     测试能注入边界（生产调用方没有理由动它们）。
 *
 * ── 边界口径（§7 用词已经区分，不能统一改成同一种）──
 *
 *   · stale：`age > STALE_AFTER_MS`（严格大于，§7 结论 8 写的就是 `>`）；
 *   · 进 unhealthy：`cf >= FAILURE_THRESHOLD`（§7 写 `>=`）；
 *   · 成功率达标：`rate >= HEALTHY_RATE`（§7 写 `>=`）；
 *   · 出 unhealthy：`cs >= RECOVERY_SUCCESSES`（§7 写 `>=`）；
 *   · flap：窗口内翻转次数 `> FLAP_FLIPS`（§7 写「超过」）。
 *   这些边界各自有用例钉住 —— 「刚好越线」和「刚好没越线」是两种不同的运维事实。
 */

/** 合成模块可覆盖的阈值集合（全部字段都是「可调的策略线」）。 */
export interface TargetHealthThresholds {
  /** 进 `unhealthy` 需要的连续失败次数（迟滞进）。 */
  readonly FAILURE_THRESHOLD: number;
  /** 出 `unhealthy` 需要的连续成功次数（迟滞出）。 */
  readonly RECOVERY_SUCCESSES: number;
  /** 新 target 从 `unknown` 走到 `healthy` 需要的连续成功次数（warm-up）。 */
  readonly WARMUP_SUCCESSES: number;
  /** `healthy` 要求的最低成功率。 */
  readonly HEALTHY_RATE: number;
  /** 成功率窗口长度（**观测方**按它计算并上报，面板不重算，§7 结论 6）。 */
  readonly SUCCESS_RATE_WINDOW: number;
  /** 延迟劣化线（ms）：超过即 `degraded`。 */
  readonly LATENCY_DEGRADED_MS: number;
  /** 观测上报周期（ms）。 */
  readonly REPORT_INTERVAL_MS: number;
  /** §7 结论 8 的「3× 上报周期」。 */
  readonly STALE_AFTER_MULTIPLIER: number;
  /** stale 阈值（ms）：`age > 此值` 的观测等同于「没有证据」。 */
  readonly STALE_AFTER_MS: number;
  /** flap 统计窗口（ms）。 */
  readonly FLAP_WINDOW_MS: number;
  /** 窗口内允许的状态翻转次数：**超过**即 `flapping`。 */
  readonly FLAP_FLIPS: number;
}

/**
 * 冻结阈值（§7）。
 *
 * 每项都注明「它保护什么」——阈值不是调优参数，每一条都是某类事故的防线。
 */
export const TARGET_HEALTH_THRESHOLDS: TargetHealthThresholds = Object.freeze({
  /**
   * 保护「single timeout → automatic failover」这条被明令禁止的链（§7 开头与
   * 迟滞条目）：3 是 §7 给出的默认值。它同时是 WP7 熔断的唯一入口条件，所以
   * 调小它等于让一次抖动触发摘除 —— 不允许。
   */
  FAILURE_THRESHOLD: 3,
  /**
   * 保护「刚从故障里出来就被重新当作完全健康」：§7 默认 2。要求**连续** M 次
   * 成功（而不是「最近 × 次里有 M 次成功」），因为只有连续的证据才能证明抖动停止。
   */
  RECOVERY_SUCCESSES: 2,
  /**
   * 保护 warm-up：新 target（或重启后重新出现的 target）一次成功不能直接
   * 记成 `healthy`，§7 默认 2。它与 RECOVERY_SUCCESSES 同为 2，但语义不同：
   * 这里防的是「从未被验证过就当健康」，那里防的是「刚故障过就回到健康」。
   */
  WARMUP_SUCCESSES: 2,
  /**
   * 保护「可用性不是二元的」：最近 `SUCCESS_RATE_WINDOW` 次里有 10% 失败就不再
   * 算 healthy。取值 0.9 的理由是它与窗口长度 20 一起读：0.95 会把「20 次里
   * 掉 1 次」（正常噪声）判成 degraded，而 degraded 会进 LB 权重；0.9 只覆盖
   * 「20 次里至少掉 2 次」这种**成片**的失败。散点失败由这条线接住，成串失败
   * 由连败计数接住 —— 两条线防的是不同的形态，不重复。
   */
  HEALTHY_RATE: 0.9,
  /**
   * 契约冻结（§7 结论 6）：窗口由观测方计算，面板不重算。放这里是为了让
   * 「为什么是 20」只有一个答案，并让测试能断言阈值表与契约同源。
   */
  SUCCESS_RATE_WINDOW: 20,
  /**
   * 保护「连接得上但已经不能用」：有界 TCP 连接耗时超过 3s，用户的业务连接
   * 基本也会超时。选 3s 而不是 ~500ms，是因为跨国/跨境链路的正常 RTT 可以到
   * 几百毫秒，把正常的慢链路报成 degraded 会教会运维忽略这一列（§7 要求
   * 「抖动是事实，不能被平均掉」，同理，噪声也不能被当成事实）。
   */
  LATENCY_DEGRADED_MS: 3_000,
  /**
   * 与 Agent 的心跳/上报节奏同源（`agent/internal/reporter/heartbeat.go`
   * `Interval = 30s`）：观测事实搭现有上报周期回传，不新增第二条时间真相。
   */
  REPORT_INTERVAL_MS: 30_000,
  /** §7 结论 8 冻结的算式：STALE_AFTER = 3 × 上报周期。 */
  STALE_AFTER_MULTIPLIER: 3,
  /**
   * 保护「面板重启后把旧观测当新鲜」（§7 结论 8/9）：90s = 3 × 30s。
   *
   * **与连接窗口数值相同、概念不同**（见 `node-lifecycle.REPORT_PERIOD_MS` 的清单）：
   * 这里的对象是**一条探测结果**（`target_observation`），不是"节点还活着吗"。
   * 今天相等是因为观测节拍 = 上报节拍 = 30s，不是同一个判定；**不得**把本常量与
   * `CONNECTION_ONLINE_WINDOW_MS` 互相绑定（那会让"改一个窗口"顺带改掉另一个概念的
   * 语义）。数值相等由 `services/__tests__/freshness-windows.test.ts` 显式钉住。
   * 或一个周期抖动不会让全部证据过期；连续三个周期没有新证据，就必须按
   * 「没有证据」处理，而不是继续沿用最后一次结果。数值与 V4 节点 stale 窗口
   * （`reconciler.DEFAULT_NODE_STALE_AFTER_MS = 90_000`）一致，避免同一面板上
   * 出现两个「多久算过期」的口径。
   */
  STALE_AFTER_MS: 90_000,
  /**
   * 保护「抖动被平均掉」：10 分钟的窗口。取 10 分钟是因为一次**真实**的
   * 故障-恢复至少要走完 N 次失败 + M 次成功（5 个周期 ≈ 2.5 分钟），窗口必须
   * 明显长于一次真实翻转，否则正常的故障恢复会被误标成 flapping。
   */
  FLAP_WINDOW_MS: 600_000,
  /**
   * 保护「提前摘除一个正在恢复的 target」：窗口内允许 4 次翻转，第 5 次才标记
   * flapping。留 4 次而不是 1 次，是因为真实链路会「掉一下、好一下」两三次才
   * 稳定；只有在 10 分钟内反复跨过健康线 5 次以上，才说明这条线本身对它有抖动，
   * 此时把结论压到 degraded（不 healthy、也不 unhealthy）是唯一诚实的表达。
   */
  FLAP_FLIPS: 4,
});

/**
 * 值域守卫：**不是**策略阈值，而是「这个字段能不能读」的合法区间。
 *
 * 它们与阈值分开，是因为它们不可调、也不该被部署覆盖：把 `SUCCESS_RATE_MAX`
 * 调大不会让任何决策更好，只会让「1.5 = 150% 成功率」这种脏数据被当成达标。
 * 缺字段、坏形状、越界一律 fail-closed（degraded 或 unknown），**绝不补 0**
 * 后当成 healthy —— 这是 §7「不能假设健康」在字段层的落地。
 */
export const TARGET_HEALTH_VALUE_DOMAIN = Object.freeze({
  /** 连续计数的合法下界：计数是「自上次状态翻转起的连续次数」，负数没有意义。 */
  COUNTER_MIN: 0,
  /** 连接耗时（ms）的合法下界。 */
  LATENCY_MIN: 0,
  /** 成功率是**比例**（不是百分数）的合法区间。 */
  SUCCESS_RATE_MIN: 0,
  SUCCESS_RATE_MAX: 1,
  /**
   * epoch 时间戳的合法下界。0 的语义是「Agent 没有这个事实」（旧 Agent 不上报），
   * 不是 1970-01-01 —— 与 `node-state.unixOrNull` 同一条口径。
   */
  EPOCH_MIN: 0,
  /** unix 秒 → 毫秒的换算（线上是秒，DB 读回来是毫秒）。 */
  SECONDS_TO_MS: 1_000,
  /**
   * epoch 时间戳的**单位**判定线：`>= 此值` 按毫秒解释，否则按秒。
   *
   * 为什么需要它：观测事实在线上是 unix **秒**（`ReportedTargetObservation`
   * `last_observed_at`，agent 侧 `targetobs.Observation.LastObservedAt`），而从
   * `target_observation.observed_at`（Prisma `DateTime`）读回来是毫秒。两种形状都
   * 会流进同一个纯函数，所以单位必须由量级判定，而不是靠调用方自觉。
   * 1e12 把两者分得很干净（今天的秒是 ~1.7e9，毫秒是 ~1.7e12），而判错的两种
   * 后果都只会让时间戳显得**更旧**（→ stale → unknown），不会让旧观测显得新鲜。
   */
  EPOCH_MILLIS_CUTOFF: 1_000_000_000_000,
});
