/**
 * 故障转移/回切策略的**唯一**数字来源（归属迁移策略契约）。
 *
 * §8.3 开头写着「failover 必须是显式 policy」，并在冻结契约里给出**六条缺一不可**的
 * 条件。这个文件是 `failover-policy.ts` 唯一的数值来源：策略模块里**不出现任何数值
 * 字面量**，有一条测试直接扫描源码证明这一点（去掉注释与字符串后断言没有数字）。
 *
 * ── 三类值必须分开看 ──
 *
 *   · **契约冻结的算式**（`NODE_STALE_AFTER_MS` / `OBSERVATION_STALE_AFTER_MS`）：
 *     §8 只写「超过 stale 阈值」。这里**不新造第二个数**，而是直接取 §7 结论 8 的
 *     stale 线（3 × 上报周期 = 90s）—— 面板上「多久算 stale」只能有一个答案。
 *     测试另外断言它与 `reconciler.DEFAULT_NODE_STALE_AFTER_MS`（V4 节点 stale 窗口）
 *     相等，防止同一台面板出现两个过期口径。
 *   · **实现选值**（`MIGRATION_COOLDOWN_MS` / `FAILBACK_HEALTHY_CHECKS` /
 *     `MIN_*`）：§8 点了名但没给数（`FAILBACK_HEALTHY_CHECKS` 是它自己的字段名）。
 *     每个值的取舍理由写在该字段上，并且可被调用方覆盖（`decideFailover({ thresholds })`）。
 *   · **协议常量与值域守卫**：`PLACEMENT_EPOCH_INCREMENT` 是 §8 一里「epoch + 1」的
 *     那个 1（协议常量，不是可调阈值）；值域守卫回答「这个字段能不能读」，
 *     缺字段/坏形状一律 fail-closed（hold），**绝不补 0 后当成可以迁移**。
 */
import { TARGET_HEALTH_THRESHOLDS, TARGET_HEALTH_VALUE_DOMAIN } from "./target-health-thresholds.ts";

/** 策略模块可覆盖的阈值集合（全部都是「可调的策略线」）。 */
export interface FailoverThresholds {
  /**
   * 条件 1 的 stale 线：owner 最后一次心跳超过多久才算「失联」。
   *
   * 保护「把一次抖动当成节点死亡」：§8 明写「节点不可达**且**超过 stale 阈值」，
   * 两个条件同时成立才可能迁移。这个数直接取 §7 的观测 stale 线（3 × 上报周期），
   * 而不是在这里另写一个 90_000：面板上「多久没有心跳算 stale」必须只有一个答案。
   */
  readonly NODE_STALE_AFTER_MS: number;
  /**
   * 条件 2 的观测新鲜度线（ms）。
   *
   * 保护「拿陈旧观测当迁移依据」：§8 明文「观测新鲜度可用（不能拿陈旧观测当依据）」。
   * 与 §7 结论 8 的 stale 判定同源（同一份 `TARGET_HEALTH_THRESHOLDS.STALE_AFTER_MS`），
   * 所以 WP6 判为 stale 的观测在这里也一定是不可用的 —— 两个模块不会对「新鲜」有分歧。
   */
  readonly OBSERVATION_STALE_AFTER_MS: number;
  /**
   * 条件 5 的迁移冷却（同一个 Forward 的两次归属迁移之间的最小间隔）。
   *
   * 保护「不无限抖动」（§8.3 通过标准之一）：自动迁移的代价是重新绑定端口、重建
   * 运行态与打断业务连接，比一次探测失败贵几个数量级。冷却必须明显长于条件 1 的
   * 检测窗口（90s），否则「刚 failover 完、下一个周期又 failback」会变成一个
   * 每 30s 抖一次的环路。取 300_000（5 分钟）的理由：给运维留出「看一眼发生了什么」
   * 的时间，同时一次真实故障恢复（首选节点回来 + 连续健康检查）通常仍在分钟级。
   */
  readonly MIGRATION_COOLDOWN_MS: number;
  /**
   * §8 回切规则点名的 `FAILBACK_HEALTHY_CHECKS`：首选节点连续多少次判定健康才允许回切。
   *
   * 保护「首选节点刚一闪通就把流量搬回去」：回切是**正常迁移**，但它的触发证据比
   * failover 弱（failover 有「节点失联 + 超时」这样的硬事实，回切只有「它又好了」），
   * 所以要求比 WP6 的恢复迟滞（连续 2 次）多一拍：3 次 ≈ 3 个上报周期（90s）的稳定
   * 健康。用「连续」而不是「最近 N 次里有 M 次」，是因为只有连续才算稳定。
   */
  readonly FAILBACK_HEALTHY_CHECKS: number;
  /**
   * 条件 2 的最小新鲜观测者数。
   *
   * 保护「凭一条恰好没过期的观测就迁移」：至少要有 1 个非 stale 的观测者给出结论；
   * 0 个就是「没有证据」，此时迁移等于猜。调成 > 1 需要多视角一致，属于部署策略。
   */
  readonly MIN_FRESH_OBSERVERS: number;
  /**
   * 条件 4 的最小可用端口数。
   *
   * 保护「迁到一个绑不上端口的节点」：§1.5 要求端口只能来自 NodePortLease。备用节点
   * 没有可用端口时迁移只会制造一次「新的不可用」。1 是下限（一个 Forward 需要一个
   * 入口端口）；部署方可以调大以留出余量。
   */
  readonly MIN_AVAILABLE_PORTS: number;
}

/**
 * 冻结阈值（§8）。
 *
 * 每项都注明「它保护什么」—— 阈值不是调优参数，每一条都是某类事故的防线。
 */
export const FAILOVER_THRESHOLDS: FailoverThresholds = Object.freeze({
  NODE_STALE_AFTER_MS: TARGET_HEALTH_THRESHOLDS.STALE_AFTER_MS,
  OBSERVATION_STALE_AFTER_MS: TARGET_HEALTH_THRESHOLDS.STALE_AFTER_MS,
  MIGRATION_COOLDOWN_MS: 300_000,
  FAILBACK_HEALTHY_CHECKS: 3,
  MIN_FRESH_OBSERVERS: 1,
  MIN_AVAILABLE_PORTS: 1,
});

/**
 * §8 一：归属变更必须走「epoch + 1」的显式迁移，不能靠覆盖字段。
 *
 * 这不是阈值，是协议常量 —— 放在这里只是为了让策略模块里没有任何数字字面量。
 * 改它等于改 fencing 契约（Agent 侧会拒绝 stale epoch），不允许顺手调。
 */
export const PLACEMENT_EPOCH_INCREMENT = 1;

/**
 * 值域守卫：**不是**策略阈值，而是「这个字段能不能读」的合法下界。
 *
 * 它们不可调，因为把其中一个调大不会让任何决策更好，只会让脏数据被当成可用事实。
 * 缺字段、坏形状、越界一律 fail-closed（不迁移 + 说明缺什么），绝不补 0。
 */
export const FAILOVER_VALUE_DOMAIN = Object.freeze({
  /** 连续健康检查次数的合法下界。 */
  HEALTHY_CHECKS_MIN: 0,
  /** 可用端口数的合法下界。 */
  PORT_COUNT_MIN: 0,
  /** 所有权世代 epoch 的合法下界（0 = 首个世代）。 */
  EPOCH_MIN: 0,
  /** 时间戳的合法下界（0 = 「没有这个事实」，不是 1970-01-01）。 */
  EPOCH_MS_MIN: TARGET_HEALTH_VALUE_DOMAIN.EPOCH_MIN,
  /** unix 秒 → 毫秒换算；复用 WP6 的口径，不另立第二个数。 */
  SECONDS_TO_MS: TARGET_HEALTH_VALUE_DOMAIN.SECONDS_TO_MS,
  /** epoch 时间戳单位判定线（>= 按毫秒解释，否则按秒）；同样复用 WP6。 */
  EPOCH_MILLIS_CUTOFF: TARGET_HEALTH_VALUE_DOMAIN.EPOCH_MILLIS_CUTOFF,
});
