/**
 * V5-WP19-B —— 目标观测的**延迟历史档案**（原始 24h + 小时桶 30d）。
 *
 * 契约：`docs/v5-wp19-latency-observability-contract.md` §3 D3/D4、§4.0 Lead 裁决（O1+O4）、
 * §6 DoD、§7 G19.8。
 *
 * ── 这份档案回答什么、不回答什么 ──
 *   投影（`target_observation`）回答「**现在**怎么样」：每 (节点, 目标) 一行、upsert、
 *   还会被 `deleteMany(notIn: seen)` 收窄。它**注定**回答不了「过去 24h 抖不抖」。
 *   本模块回答「**过去**怎么样」：只追加的原始样本（24h）+ 由原始样本聚合的小时桶（30d）。
 *
 *   三条硬约束（D3/D4，违反任何一条都比没有历史更坏）：
 *     1. **永不写入投影**：本模块只 INSERT 到自己的两张表，绝不 touch `target_observation`；
 *     2. **永不作为判定输入**：健康/准入/归属一律读投影，没有任何判定路径 import 本模块的读函数；
 *     3. **永不猜**：测不到延迟的样本 `latency_ms = NULL`（不是 0），小时桶里
 *        `latency_samples = 0` 时平均值是 `NULL`（不是 0）——「没测到」与「0ms」不是同一件事。
 *
 * ── 为什么小时桶由「已结束的整点小时」重算得到（而不是写入时累加）──
 *   写入时累加需要读-改-写才能维护 min/max，而 Agent 上报是**并发**到达的（一个节点的多次
 *   上报可以重叠），读-改-写会在并发下丢掉 min/max；重算则完全幂等：小时结束后该小时的
 *   样本集不再增长（`ROLLUP_GRACE_HOURS` 的 1 小时缓冲就是为此），同一小时重算多少次
 *   结果都一样。桶表因此是**只追加**：`create` + 唯一冲突跳过，不 upsert、不 update。
 *
 * ── 时钟口径 ──
 *   横轴是 **Agent 的 `observed_at`**（这是"观测发生在什么时候"的唯一真相，跨节点可比），
 *   整点分桶按 **UTC**（与 `traffic-retention` 的日界同一取向：本地时区会让 UTC+8 下的
 *   桶边界整体偏移 8 小时，同一个小时被切成两半）。`reported_at` 只作"面板什么时候收到"的
 *   旁证，不参与分桶。
 *
 * ── 幂等 ──
 *   清理 `deleteMany(where: age < cutoff)`、聚合 `groupBy(hour)`、建桶 `create`+冲突跳过
 *   三者重复执行结果相同；cron 重试不会把桶算错，也不会删多（G19.8 的验收形态）。
 */
import { Prisma } from "@prisma/client";

/* ================================================================== */
/* 保留期（契约 §4.0：「配置默认（可调）」）                              */
/* ================================================================== */

/**
 * 原始样本保留期缺省 24h（契约 §4.0 裁决）。
 *
 * 「可调」走 `SystemConfig`，键名见 {@link LATENCY_RETENTION_CONFIG_KEYS}。
 * **刻意不新增 `SystemConfigName` 枚举成员**：`system_config.name` 是 MySQL enum 列，
 * 加值要 `ALTER TABLE ... MODIFY COLUMN` 重写整张枚举（共享 schema 下是个高风险动作，
 * 且当场的另一个 WP 正需要"零枚举变更"）。`services/config.ts:getConfig` 本来就接受
 * 任意字符串键，读得到；若将来要进管理端下拉，再补枚举成员（纯 additive）。
 */
export const DEFAULT_RAW_RETENTION_HOURS = 24;
/** 桶保留期缺省 30d（契约 §4.0 裁决）。 */
export const DEFAULT_BUCKET_RETENTION_DAYS = 30;

/** 保留期上限：连"10 年"都够任何合规场景；更大的需求应先改这个常量并补测试。 */
export const MAX_RAW_RETENTION_HOURS = 24 * 366;
export const MAX_BUCKET_RETENTION_DAYS = 3660;

/** `system_config` 里的保留期键（string 键，见上面"刻意不新增枚举"）。 */
export const LATENCY_RETENTION_CONFIG_KEYS = {
  raw_hours: "LATENCY_RAW_RETENTION_HOURS",
  bucket_days: "LATENCY_BUCKET_RETENTION_DAYS",
} as const;

/**
 * 桶只由**已结束**的小时生成：`hour_start + 1h + grace <= now`。
 *
 * 1 小时 grace 而不是 0：Agent 时钟可能与面板有偏斜（契约 §1.2 的 age 口径就是这么来的），
 * 一个"看起来刚结束"的小时可能还有样本在路上；多等一小时比写下一个偏少的桶便宜
 * （桶是只追加的，写错不再改写）。
 */
export const ROLLUP_GRACE_HOURS = 1;

/** 单轮 rollup 的回看小时数：比原始保留期长 2 小时，容忍漏跑一轮（worker 重启等）。 */
export const ROLLUP_LOOKBACK_HOURS = DEFAULT_RAW_RETENTION_HOURS + 2;

/** 保留期解析结果（缺省/非法都要能说清，调用方据此决定是否告警）。 */
export interface RetentionValue {
  value: number;
  missing: boolean;
  invalid: boolean;
}

/**
 * 把配置字符串解析成保留期数值（小时或天）。
 *
 * 与 `traffic-retention.ts:resolveRetentionDays` 同一条纪律：**任何脏值都回落默认**，
 * 绝不出现"配错了 → 一条都不删"（无限增长压垮磁盘）或"配错了 → 全删"（历史当场清空）。
 */
export function resolveRetentionValue(
  raw: string | null | undefined,
  fallback: number,
  max: number,
): RetentionValue {
  if (raw === null || raw === undefined || String(raw).trim() === "") {
    return { value: fallback, missing: true, invalid: false };
  }
  const n = Number(raw);
  const valid = Number.isFinite(n) && Number.isInteger(n) && n >= 1 && n <= max;
  return valid ? { value: n, missing: false, invalid: false } : { value: fallback, missing: false, invalid: true };
}

/** `observed_at` 的 UTC 整点（序列分桶的唯一横轴口径）。 */
export function hourStartUtc(at: Date): Date {
  const d = new Date(at.getTime());
  d.setUTCMinutes(0, 0, 0);
  return d;
}

/** 原始样本删除边界：`observed_at < now - hours`。 */
export function rawRetentionCutoff(hours: number, now: Date): Date {
  const safe = Number.isFinite(hours) && hours >= 1 ? Math.floor(hours) : DEFAULT_RAW_RETENTION_HOURS;
  return new Date(now.getTime() - safe * 3_600_000);
}

/**
 * 桶删除边界：`hour_start < cutoff`，按 **UTC 日界**往前推 `days` 天。
 *
 * 与 `traffic-retention.ts:retentionCutoff` 同一口径（那边删 `date < cutoff`，
 * 日界也是 UTC 午夜）：桶的横轴是 UTC 整点，用本地日界会把 UTC+8 的边界算错一天。
 */
export function bucketRetentionCutoff(days: number, now: Date): Date {
  const safe = Number.isFinite(days) && days >= 1 ? Math.floor(days) : DEFAULT_BUCKET_RETENTION_DAYS;
  const cutoff = new Date(now.getTime());
  cutoff.setUTCHours(0, 0, 0, 0);
  cutoff.setUTCDate(cutoff.getUTCDate() - safe);
  return cutoff;
}

/* ================================================================== */
/* 形状                                                                */
/* ================================================================== */

/** 一条待落库的原始样本（身份由调用方用 `node-state.ts:targetKeyOf` 归一化，禁止第二份）。 */
export interface LatencySampleRow {
  target_key: string;
  host: string;
  port: number;
  reachable: boolean;
  /** 测到的延迟（毫秒）。`null` = 这次没测到（不可达）——**不是 0**。 */
  latency_ms: number | null;
  success_rate: number;
  /** Agent 观测时刻（分桶与序列横轴）。 */
  observed_at: Date;
  observation_source: string;
}

/** 一个小时间隔内按 (节点, 目标, 口径) 聚合出的样本统计（`_count`/`_sum`/`_min`/`_max`）。 */
export interface SampleAggregate {
  node_id: number;
  target_key: string;
  observation_source: string;
  samples: number;
  latency_sum_ms: number | null;
  latency_samples: number;
  latency_min_ms: number | null;
  latency_max_ms: number | null;
  last_observed_at: Date;
}

/** 同一个小时间隔内「可达」样本数（与 {@link SampleAggregate} 分开查的原因见 merge 注释）。 */
export interface ReachableAggregate {
  node_id: number;
  target_key: string;
  observation_source: string;
  reachable: number;
}

/** 一条小时桶（档案的只追加行）。 */
export interface HourlyBucket {
  node_id: number;
  target_key: string;
  hour_start: Date;
  observation_source: string;
  sample_count: number;
  success_count: number;
  failure_count: number;
  latency_samples: number;
  latency_sum_ms: number;
  latency_min_ms: number | null;
  latency_max_ms: number | null;
  last_observed_at: Date;
}

/* ================================================================== */
/* 纯函数：聚合                                                     */
/* ================================================================== */

function aggregateKey(nodeId: number, targetKey: string, source: string): string {
  return `${nodeId}\u0000${targetKey}\u0000${source}`;
}

/**
 * 两组聚合 → 小时桶（纯函数，可离线穷举）。
 *
 * 「可达样本数」为什么要**单独一次** groupBy：Prisma 的 `_count` 数的是"非 NULL 的列"，
 * 而 `reachable` 是 NOT NULL 布尔，`_count.reachable` 会等于总数（没有信息量），
 * `_sum` 也不能条件求和。所以可达数用 `where: { reachable: true }` 的第二次 groupBy 得到。
 *
 * 代价是两次查询之间**理论上**可能插入新样本（本轮只处理 ≥1h 前的小时，正常不会发生；
 * Agent 时钟偏斜 >1h 时可能）：那时 `reachable > samples`，`success + failure == sample_count`
 * 这条不变量会被破坏。**不 clamp、不猜**：这类键整条跳过，进 `inconsistent_keys`，
 * 下一轮重算（小时仍然在回看窗口内）。写一个自相矛盾的桶比暂时没有桶坏得多。
 */
export function mergeHourBuckets(
  samples: readonly SampleAggregate[],
  reachable: readonly ReachableAggregate[],
  hourStart: Date,
): { buckets: HourlyBucket[]; inconsistent_keys: string[] } {
  const reachableByKey = new Map<string, number>();
  for (const row of reachable) {
    reachableByKey.set(aggregateKey(row.node_id, row.target_key, row.observation_source), Math.max(0, row.reachable));
  }
  const buckets: HourlyBucket[] = [];
  const inconsistent: string[] = [];
  for (const row of samples) {
    const key = aggregateKey(row.node_id, row.target_key, row.observation_source);
    const success = reachableByKey.get(key) ?? 0;
    if (success > row.samples) {
      inconsistent.push(key);
      continue;
    }
    buckets.push({
      node_id: row.node_id,
      target_key: row.target_key,
      hour_start: hourStart,
      observation_source: row.observation_source,
      sample_count: row.samples,
      success_count: success,
      failure_count: row.samples - success,
      latency_samples: row.latency_samples,
      latency_sum_ms: row.latency_sum_ms ?? 0,
      latency_min_ms: row.latency_min_ms,
      latency_max_ms: row.latency_max_ms,
      last_observed_at: row.last_observed_at,
    });
  }
  return { buckets, inconsistent_keys: inconsistent };
}

/** 平均延迟：没有参与统计的样本时是 `NULL`（不是 0）。显示精度 0.1ms，原始值可重算。 */
export function averageLatencyMs(sum: number, samples: number): number | null {
  if (!Number.isFinite(samples) || samples <= 0 || !Number.isFinite(sum)) return null;
  return Math.round((sum / samples) * 10) / 10;
}

/**
 * 本轮该聚合哪些小时（纯函数）：只取**已结束且过了 grace** 的整点，即满足
 * `hour_start + 1h + grace <= now`，下界为 `now - lookbackHours`。
 *
 * 返回升序、去重的 `hour_start` 列表。空列表 = 回看窗口内没有合格的小时
 * （`lookback <= grace + 1`，或调用方给了不合法的 now）。
 */
export function rollupHours(now: Date, lookbackHours = ROLLUP_LOOKBACK_HOURS, graceHours = ROLLUP_GRACE_HOURS): Date[] {
  const last = hourStartUtc(new Date(now.getTime() - (graceHours + 1) * 3_600_000));
  const first = hourStartUtc(new Date(now.getTime() - lookbackHours * 3_600_000));
  const out: Date[] = [];
  for (let t = first.getTime(); t <= last.getTime(); t += 3_600_000) out.push(new Date(t));
  return out;
}

/* ================================================================== */
/* 依赖（DB 面可注入，便于单测；默认实现懒加载 db 避免测试被迫连库）        */
/* ================================================================== */

export interface LatencyHistoryDeps {
  /** 读 `system_config` 的值（不存在 → null）。B 本模块只用它读保留期。 */
  readConfig(name: string): Promise<string | null>;
  /** 追加原始样本（只 INSERT） */
  insertSamples(nodeId: number, rows: readonly LatencySampleRow[]): Promise<number>;
  /** 一个小时间隔内按 (节点, 目标, 口径) 聚合；在开始做维护前调用者已调过 `deps.observe`。 */
  aggregateSamples(hourStart: Date, hourEnd: Date): Promise<SampleAggregate[]>;
  /** 同一个小时间隔内**可达**样本数（见 mergeHourBuckets 的注释）。 */
  aggregateReachable(hourStart: Date, hourEnd: Date): Promise<ReachableAggregate[]>;
  /** 写入一条小时桶；已存在（同 (节点, 目标, 小时, 口径)）→ 返回 false（只追加语义）。 */
  insertBucketIfAbsent(bucket: HourlyBucket): Promise<boolean>;
  /** 删除 `observed_at < cutoff` 的原始样本，返回删除行数。 */
  deleteSamplesBefore(cutoff: Date): Promise<number>;
  /** 删除 `hour_start < cutoff` 的桶，返回删除行数。 */
  deleteBucketsBefore(cutoff: Date): Promise<number>;
  /** 读原始样本序列（按 `observed_at` 升序）。 */
  readRawSamples(query: {
    node_id: number;
    target_key: string;
    from: Date;
    to: Date;
    observation_source: string | null;
    limit: number;
  }): Promise<RawSamplePoint[]>;
  /** 读小时桶序列（按 `hour_start` 升序）。 */
  readHourBuckets(query: {
    node_id: number;
    target_key: string;
    from: Date;
    to: Date;
    observation_source: string | null;
    limit: number;
  }): Promise<HourlyBucket[]>;
}

export interface RawSamplePoint {
  observed_at: Date;
  reachable: boolean;
  latency_ms: number | null;
  observation_source: string;
}

/* ================================================================== */
/* 写入：原始样本                                                      */
/* ================================================================== */

/**
 * 追加一次上报里的观测样本。**只 INSERT**，不去重、不 upsert。
 *
 * 为什么不去重：同一个 (节点, 目标) 在不同上报里出现两次就是**两次观测**（相隔一个节拍），
 * 这正是序列的分辨率。"和上一条一样就跳过"会把抖动抹平成一条直线，而那恰好是这份档案
 * 存在的理由（契约 O1 的候选 C 被否掉就是这个原因）。
 */
export async function appendLatencySamples(
  deps: LatencyHistoryDeps,
  nodeId: number,
  rows: readonly LatencySampleRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  return deps.insertSamples(nodeId, rows);
}

/* ================================================================== */
/* 聚合：小时桶                                                        */
/* ================================================================== */

export interface RollupResult {
  /** 本轮实际考虑的小时数（已结束的整点）。 */
  hours: number;
  /** 写入的桶数。 */
  inserted: number;
  /** 已存在而跳过的桶数（只追加语义）。 */
  skipped: number;
  /** 两次聚合之间数据不自洽而被跳过、留给下一轮重算的键数。 */
  inconsistent: number;
}

/**
 * 把已结束的小时聚合进桶表（幂等；见文件头"为什么重算"）。
 *
 * 失败语义：DB 错误向上抛（由 worker 记录 + BullMQ 重试）。**不吞错** —— 静默失败会让
 * 「档案在跑」这个假设长期不成立，而原始样本 24h 后就被清掉，桶没建出来就是永久丢失。
 */
export async function rollUpLatencyBuckets(
  deps: LatencyHistoryDeps,
  now: Date,
): Promise<RollupResult> {
  const hours = rollupHours(now);
  const result: RollupResult = { hours: hours.length, inserted: 0, skipped: 0, inconsistent: 0 };
  for (const hourStart of hours) {
    const hourEnd = new Date(hourStart.getTime() + 3_600_000);
    const samples = await deps.aggregateSamples(hourStart, hourEnd);
    if (samples.length === 0) continue;
    const reachable = await deps.aggregateReachable(hourStart, hourEnd);
    const { buckets, inconsistent_keys } = mergeHourBuckets(samples, reachable, hourStart);
    result.inconsistent += inconsistent_keys.length;
    for (const bucket of buckets) {
      const written = await deps.insertBucketIfAbsent(bucket);
      if (written) result.inserted += 1;
      else result.skipped += 1;
    }
  }
  return result;
}

/* ================================================================== */
/* 清理（保留期）                                                      */
/* ================================================================== */

export interface PruneResult {
  raw_hours: number;
  bucket_days: number;
  raw_cutoff: string;
  bucket_cutoff: string;
  deleted_samples: number;
  deleted_buckets: number;
  config_missing: boolean;
  config_invalid: boolean;
}

/**
 * 读保留期配置（缺失/非法回落默认，见 {@link resolveRetentionValue}）。
 *
 * 两个键分开读：一个配错了不该把另一个也带回默认值 —— 那会把"管理员只想延长桶保留期"
 * 变成"原始样本保留期也被重置"。
 */
export async function resolveRetention(
  deps: LatencyHistoryDeps,
): Promise<{
  raw_hours: RetentionValue;
  bucket_days: RetentionValue;
}> {
  const [rawRaw, bucketRaw] = await Promise.all([
    deps.readConfig(LATENCY_RETENTION_CONFIG_KEYS.raw_hours),
    deps.readConfig(LATENCY_RETENTION_CONFIG_KEYS.bucket_days),
  ]);
  return {
    raw_hours: resolveRetentionValue(rawRaw, DEFAULT_RAW_RETENTION_HOURS, MAX_RAW_RETENTION_HOURS),
    bucket_days: resolveRetentionValue(bucketRaw, DEFAULT_BUCKET_RETENTION_DAYS, MAX_BUCKET_RETENTION_DAYS),
  };
}

/** 按保留期清理两张档案表（幂等；G19.8 的"按索引清理"）。 */
export async function pruneLatencyHistory(
  deps: LatencyHistoryDeps,
  now: Date = new Date(),
): Promise<PruneResult> {
  const { raw_hours, bucket_days } = await resolveRetention(deps);
  const rawCutoff = rawRetentionCutoff(raw_hours.value, now);
  const bucketCutoff = bucketRetentionCutoff(bucket_days.value, now);
  // 先聚合再清理由调用方保证（runLatencyHistoryMaintenance）：顺序反了会在
  // 「桶还没建、原始行已删」的窗口里永久丢一段历史。
  const deletedSamples = await deps.deleteSamplesBefore(rawCutoff);
  const deletedBuckets = await deps.deleteBucketsBefore(bucketCutoff);
  return {
    raw_hours: raw_hours.value,
    bucket_days: bucket_days.value,
    raw_cutoff: rawCutoff.toISOString(),
    bucket_cutoff: bucketCutoff.toISOString(),
    deleted_samples: deletedSamples,
    deleted_buckets: deletedBuckets,
    config_missing: raw_hours.missing || bucket_days.missing,
    config_invalid: raw_hours.invalid || bucket_days.invalid,
  };
}

/**
 * 一轮维护：**先 rollup 再 prune**。
 *
 * 顺序是硬约束：反过来会在"原始行已删、桶还没建"的窗口里永久丢一段历史
 * （原始样本 24h 后不可恢复）。
 */
export async function runLatencyHistoryMaintenance(
  deps: LatencyHistoryDeps,
  now: Date = new Date(),
): Promise<{ rollup: RollupResult; prune: PruneResult }> {
  const rollup = await rollUpLatencyBuckets(deps, now);
  const prune = await pruneLatencyHistory(deps, now);
  return { rollup, prune };
}

/* ================================================================== */
/* 读路径                                                              */
/* ================================================================== */

export type LatencyGranularity = "sample" | "hour";

/** 单次读取的硬上限（防止一个窗口把面板/DB 拖垮）。超出时**不截断谎报**，见 {@link readLatencySeries}。 */
export const MAX_SERIES_POINTS = 2000;

export interface LatencySeriesQuery {
  node_id: number;
  target_key: string;
  from: Date;
  to: Date;
  granularity: LatencyGranularity;
  /** 只读某一口径（不给 = 该目标的所有口径，**但不会把不同口径平均在一起**，见下）。 */
  observation_source?: string | null;
}

export interface LatencySeriesPoint {
  /** 横轴：`sample` = 观测时刻，`hour` = 桶起点（UTC 整点）。ISO 串。 */
  at: string;
  /** 原始样本 = 该次测得的延迟；小时桶 = 平均延迟。**没测到就是 null**（不是 0）。 */
  latency_ms: number | null;
  samples: number;
  successes: number;
  failures: number;
  latency_min_ms: number | null;
  latency_max_ms: number | null;
  observation_source: string;
}

export type LatencySeriesFailure = "bad_window" | "raw_window_expired";

export interface LatencySeriesOk {
  ok: true;
  granularity: LatencyGranularity;
  points: LatencySeriesPoint[];
  /** 命中上限而被截掉（显式标注，不静默给一条"看起来完整"的线）。 */
  truncated: boolean;
}

/**
 * 读一条序列。
 *
 * ── 两个必须区分的"空" ──
 *   · 窗口内有历史、此刻没有数据 → `ok: true, points: []`（"过去这段时间没有观测"）；
 *   · 窗口根本不在档案范围内（`granularity: "sample"` 却要读 25 小时前）→ **拒绝**。
 *     否则返回空数组会被读成"那段时间没有观测"，而真相是"原始样本已按保留期清理"——
 *     把人骗到"当时一切正常"是最坏的方向（契约 D12「stale = 没有证据，不沿用最后结果」同源）。
 *
 * `granularity: "sample"` 的窗口下界必须落在原始保留期内（用**配置值**判，不是常量）。
 */
export async function readLatencySeries(
  deps: LatencyHistoryDeps,
  query: LatencySeriesQuery,
  now: Date = new Date(),
): Promise<LatencySeriesOk | { ok: false; reason: LatencySeriesFailure }> {
  const fromMs = query.from.getTime();
  const toMs = query.to.getTime();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
    return { ok: false, reason: "bad_window" };
  }
  if (query.granularity === "sample") {
    const { raw_hours } = await resolveRetention(deps);
    if (fromMs < rawRetentionCutoff(raw_hours.value, now).getTime()) {
      return { ok: false, reason: "raw_window_expired" };
    }
  }
  const limit = MAX_SERIES_POINTS + 1; // 多取一条用于判断"被截断"
  const common = {
    node_id: query.node_id,
    target_key: query.target_key,
    from: query.from,
    to: query.to,
    observation_source: query.observation_source ?? null,
    limit,
  };
  if (query.granularity === "sample") {
    const rows = await deps.readRawSamples(common);
    const truncated = rows.length > MAX_SERIES_POINTS;
    return {
      ok: true,
      granularity: "sample",
      truncated,
      points: rows.slice(0, MAX_SERIES_POINTS).map((row) => ({
        at: row.observed_at.toISOString(),
        latency_ms: row.latency_ms,
        samples: 1,
        successes: row.reachable ? 1 : 0,
        failures: row.reachable ? 0 : 1,
        latency_min_ms: row.latency_ms,
        latency_max_ms: row.latency_ms,
        observation_source: row.observation_source,
      })),
    };
  }
  const rows = await deps.readHourBuckets(common);
  const truncated = rows.length > MAX_SERIES_POINTS;
  return {
    ok: true,
    granularity: "hour",
    truncated,
    points: rows.slice(0, MAX_SERIES_POINTS).map((bucket) => ({
      at: bucket.hour_start.toISOString(),
      latency_ms: averageLatencyMs(bucket.latency_sum_ms, bucket.latency_samples),
      samples: bucket.sample_count,
      successes: bucket.success_count,
      failures: bucket.failure_count,
      latency_min_ms: bucket.latency_min_ms,
      latency_max_ms: bucket.latency_max_ms,
      observation_source: bucket.observation_source,
    })),
  };
}

/* ================================================================== */
/* 默认实现（懒加载 db：让纯函数与替身测试不必拉起 PrismaClient）           */
/* ================================================================== */

/** Prisma 唯一约束冲突（"这个桶已经写过了"）。 */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export function defaultLatencyHistoryDeps(): LatencyHistoryDeps {
  return {
    async readConfig(name) {
      const { db } = await import("../db.ts");
      const row = await db.systemConfig.findUnique({
        where: { name: name as never },
        select: { value: true },
      });
      return row?.value ?? null;
    },
    async insertSamples(nodeId, rows) {
      const { db } = await import("../db.ts");
      const res = await db.targetLatencySample.createMany({
        data: rows.map((row) => ({
          node_id: nodeId,
          target_key: row.target_key,
          host: row.host,
          port: row.port,
          reachable: row.reachable,
          latency_ms: row.latency_ms,
          success_rate: row.success_rate,
          observation_source: row.observation_source,
          observed_at: row.observed_at,
        })),
      });
      return res.count;
    },
    async aggregateSamples(hourStart, hourEnd) {
      const { db } = await import("../db.ts");
      const rows = await db.targetLatencySample.groupBy({
        by: ["node_id", "target_key", "observation_source"],
        where: { observed_at: { gte: hourStart, lt: hourEnd } },
        _count: { _all: true, latency_ms: true },
        _sum: { latency_ms: true },
        _min: { latency_ms: true },
        _max: { latency_ms: true, observed_at: true },
      });
      return rows.map((row) => ({
        node_id: row.node_id,
        target_key: row.target_key,
        observation_source: row.observation_source,
        samples: row._count._all,
        latency_sum_ms: row._sum.latency_ms ?? null,
        // `_count.latency_ms` 数的是非 NULL 的 latency_ms = 真的测到延迟的样本数
        // （不可达样本的 latency_ms 是 NULL）。平均的分母用它，绝不用样本总数。
        latency_samples: row._count.latency_ms,
        latency_min_ms: row._min.latency_ms ?? null,
        latency_max_ms: row._max.latency_ms ?? null,
        last_observed_at: row._max.observed_at ?? hourEnd,
      }));
    },
    async aggregateReachable(hourStart, hourEnd) {
      const { db } = await import("../db.ts");
      const rows = await db.targetLatencySample.groupBy({
        by: ["node_id", "target_key", "observation_source"],
        where: { observed_at: { gte: hourStart, lt: hourEnd }, reachable: true },
        _count: { _all: true },
      });
      return rows.map((row) => ({
        node_id: row.node_id,
        target_key: row.target_key,
        observation_source: row.observation_source,
        reachable: row._count._all,
      }));
    },
    async insertBucketIfAbsent(bucket) {
      const { db } = await import("../db.ts");
      try {
        await db.targetLatencyHourly.create({ data: bucket });
        return true;
      } catch (error) {
        // 只追加：同一个小时已经写过了 → 不是错误，也不是新事实（与 ACK 账本 SET NX 同一取向）。
        if (isUniqueViolation(error)) return false;
        throw error;
      }
    },
    async deleteSamplesBefore(cutoff) {
      const { db } = await import("../db.ts");
      const res = await db.targetLatencySample.deleteMany({ where: { observed_at: { lt: cutoff } } });
      return res.count;
    },
    async deleteBucketsBefore(cutoff) {
      const { db } = await import("../db.ts");
      const res = await db.targetLatencyHourly.deleteMany({ where: { hour_start: { lt: cutoff } } });
      return res.count;
    },
    async readRawSamples(query) {
      const { db } = await import("../db.ts");
      return db.targetLatencySample.findMany({
        where: {
          node_id: query.node_id,
          target_key: query.target_key,
          observed_at: { gte: query.from, lt: query.to },
          ...(query.observation_source === null ? {} : { observation_source: query.observation_source }),
        },
        orderBy: { observed_at: "asc" },
        take: query.limit,
        select: { observed_at: true, reachable: true, latency_ms: true, observation_source: true },
      });
    },
    async readHourBuckets(query) {
      const { db } = await import("../db.ts");
      return db.targetLatencyHourly.findMany({
        where: {
          node_id: query.node_id,
          target_key: query.target_key,
          hour_start: { gte: query.from, lt: query.to },
          ...(query.observation_source === null ? {} : { observation_source: query.observation_source }),
        },
        orderBy: { hour_start: "asc" },
        take: query.limit,
      });
    },
  };
}
