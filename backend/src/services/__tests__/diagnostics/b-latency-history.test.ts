/**
 * V5-WP19-B —— 延迟历史档案（原始 24h + 小时桶 30d）的行为断言。
 *
 * 三组：
 *   ① 纯函数：保留期解析 / UTC 分桶 / 聚合 merge —— 可离线穷举，失败信息直指边界；
 *   ② 清理与聚合（G19.8 的形状）：用一个内存替身跑完整条 rollup → prune 流水线，
 *      「超期行消失、未超期完好、桶照建」三者一起断言；
 *   ③ 读路径：把「没有数据」与「数据已被保留期清掉」**分开**（前者空数组，后者显式拒绝）。
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_BUCKET_RETENTION_DAYS,
  DEFAULT_RAW_RETENTION_HOURS,
  MAX_SERIES_POINTS,
  appendLatencySamples,
  averageLatencyMs,
  bucketRetentionCutoff,
  hourStartUtc,
  LATENCY_RETENTION_CONFIG_KEYS,
  mergeHourBuckets,
  pruneLatencyHistory,
  rawRetentionCutoff,
  readLatencySeries,
  resolveRetention,
  resolveRetentionValue,
  rollUpLatencyBuckets,
  rollupHours,
  runLatencyHistoryMaintenance,
  type HourlyBucket,
  type LatencyHistoryDeps,
  type LatencySampleRow,
  type SampleAggregate,
} from "../../latency-history.ts";

const NOW = new Date("2026-10-05T12:34:56.000Z");

/* ================================================================== */
/* ① 纯函数                                                            */
/* ================================================================== */

describe("V5-WP19-B 保留期：脏值一律回落，绝不「一条不删」或「全删」", () => {
  test("缺省 24h / 30d（契约 §4.0 的裁决值）", () => {
    expect(resolveRetentionValue(null, DEFAULT_RAW_RETENTION_HOURS, 100)).toEqual({
      value: 24,
      missing: true,
      invalid: false,
    });
    expect(DEFAULT_RAW_RETENTION_HOURS).toBe(24);
    expect(DEFAULT_BUCKET_RETENTION_DAYS).toBe(30);
  });

  test("合法值原样，非法值回落并标记（配置脏了要能被发现，不是静默）", () => {
    expect(resolveRetentionValue("48", 24, 100)).toEqual({ value: 48, missing: false, invalid: false });
    for (const bad of ["0", "-3", "1.5", "abc", "9999"]) {
      const got = resolveRetentionValue(bad, 24, 100);
      expect(got).toEqual({ value: 24, missing: false, invalid: true });
    }
  });

  test("两个键分开读：一个脏了不带偏另一个", async () => {
    const deps = fakeStore({
      [LATENCY_RETENTION_CONFIG_KEYS.raw_hours]: "not-a-number",
      [LATENCY_RETENTION_CONFIG_KEYS.bucket_days]: "90",
    });
    const r = await resolveRetention(deps.deps);
    expect(r.raw_hours).toEqual({ value: 24, missing: false, invalid: true });
    expect(r.bucket_days).toEqual({ value: 90, missing: false, invalid: false });
  });
});

describe("V5-WP19-B 时间口径：UTC 整点 + 按索引可删的边界", () => {
  test("hourStartUtc 抹掉分秒毫秒（横轴只有小时）", () => {
    expect(hourStartUtc(new Date("2026-10-05T12:34:56.789Z")).toISOString()).toBe("2026-10-05T12:00:00.000Z");
  });

  test("原始边界 = now - hours（不是日界：24h 是滑动窗口）", () => {
    expect(rawRetentionCutoff(24, NOW).toISOString()).toBe("2026-10-04T12:34:56.000Z");
  });

  test("桶边界 = UTC 日界往前 days 天（与 traffic-retention 同一口径）", () => {
    expect(bucketRetentionCutoff(30, NOW).toISOString()).toBe("2026-09-05T00:00:00.000Z");
  });

  test("rollupHours：只取已结束的整点（含 1h grace），升序", () => {
    const hours = rollupHours(new Date("2026-10-05T12:34:56.000Z"), 4, 1);
    expect(hours.map((h) => h.toISOString())).toEqual([
      "2026-10-05T08:00:00.000Z",
      "2026-10-05T09:00:00.000Z",
      "2026-10-05T10:00:00.000Z",
    ]);
  });
});

describe("V5-WP19-B 聚合 merge：不能让「没测到」变成 0ms", () => {
  const agg = (over: Partial<SampleAggregate> = {}): SampleAggregate => ({
    node_id: 1,
    target_key: "t:80",
    observation_source: "ingress|tcp_connect",
    samples: 4,
    latency_sum_ms: 120,
    latency_samples: 3,
    latency_min_ms: 30,
    latency_max_ms: 50,
    last_observed_at: new Date("2026-10-05T10:59:00.000Z"),
    ...over,
  });

  test("success + failure == sample_count；延迟统计分母是「真的测到」的样本数", () => {
    const { buckets, inconsistent_keys } = mergeHourBuckets(
      [agg()],
      [{ node_id: 1, target_key: "t:80", observation_source: "ingress|tcp_connect", reachable: 3 }],
      new Date("2026-10-05T10:00:00.000Z"),
    );
    expect(inconsistent_keys).toEqual([]);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.sample_count).toBe(4);
    expect(buckets[0]!.success_count).toBe(3);
    expect(buckets[0]!.failure_count).toBe(1);
    expect(buckets[0]!.latency_samples).toBe(3);
    expect(averageLatencyMs(buckets[0]!.latency_sum_ms, buckets[0]!.latency_samples)).toBe(40);
  });

  test("全部不可达：平均值是 NULL（不是 0），但失败计数照记", () => {
    const { buckets } = mergeHourBuckets(
      [agg({ samples: 2, latency_sum_ms: null, latency_samples: 0, latency_min_ms: null, latency_max_ms: null })],
      [],
      new Date("2026-10-05T10:00:00.000Z"),
    );
    expect(averageLatencyMs(buckets[0]!.latency_sum_ms, buckets[0]!.latency_samples)).toBeNull();
    expect(buckets[0]!.failure_count).toBe(2);
  });

  test("两次聚合之间数据不自洽 → 整条跳过（不 clamp、不写自相矛盾的桶）", () => {
    const { buckets, inconsistent_keys } = mergeHourBuckets(
      [agg({ samples: 2 })],
      [{ node_id: 1, target_key: "t:80", observation_source: "ingress|tcp_connect", reachable: 5 }],
      new Date("2026-10-05T10:00:00.000Z"),
    );
    expect(buckets).toEqual([]);
    expect(inconsistent_keys).toHaveLength(1);
  });

  test("不同口径各自成桶：不同 source 的延迟永远不平均在一起", () => {
    const { buckets } = mergeHourBuckets(
      [agg(), agg({ observation_source: "egress|tcp_connect", latency_sum_ms: 900, latency_samples: 3 })],
      [],
      new Date("2026-10-05T10:00:00.000Z"),
    );
    expect(buckets.map((b) => b.observation_source).sort()).toEqual(["egress|tcp_connect", "ingress|tcp_connect"]);
    for (const b of buckets) expect(b.sample_count).toBe(4);
  });
});

/* ================================================================== */
/* 内存替身：把两张档案表 + 配置读实现成数组，用于流水线断言              */
/* ================================================================== */

interface FakeStore {
  deps: LatencyHistoryDeps;
  samples: Array<LatencySampleRow & { node_id: number }>;
  buckets: HourlyBucket[];
  calls: string[];
}

function fakeStore(config: Record<string, string> = {}): FakeStore {
  const samples: Array<LatencySampleRow & { node_id: number }> = [];
  const buckets: HourlyBucket[] = [];
  const calls: string[] = [];
  const rowKey = (b: { node_id: number; target_key: string; hour_start: Date; observation_source: string }) =>
    `${b.node_id}\u0000${b.target_key}\u0000${b.hour_start.toISOString()}\u0000${b.observation_source}`;

  const deps: LatencyHistoryDeps = {
    async readConfig(name) {
      calls.push(`config:${name}`);
      return config[name] ?? null;
    },
    async insertSamples(nodeId, rows) {
      calls.push("insert_samples");
      for (const row of rows) samples.push({ ...row, node_id: nodeId });
      return rows.length;
    },
    async aggregateSamples(hourStart, hourEnd) {
      // 镜像 Prisma groupBy：_count._all / _count.latency_ms（非 NULL）+ _sum/_min/_max + _max(observed_at)
      const groups = new Map<string, SampleAggregate>();
      for (const s of samples) {
        if (s.observed_at < hourStart || s.observed_at >= hourEnd) continue;
        const key = `${s.node_id}\u0000${s.target_key}\u0000${s.observation_source}`;
        const g = groups.get(key) ?? {
          node_id: s.node_id,
          target_key: s.target_key,
          observation_source: s.observation_source,
          samples: 0,
          latency_sum_ms: null,
          latency_samples: 0,
          latency_min_ms: null,
          latency_max_ms: null,
          last_observed_at: hourStart,
        };
        g.samples += 1;
        if (s.latency_ms !== null) {
          g.latency_samples += 1;
          g.latency_sum_ms = (g.latency_sum_ms ?? 0) + s.latency_ms;
          g.latency_min_ms = g.latency_min_ms === null ? s.latency_ms : Math.min(g.latency_min_ms, s.latency_ms);
          g.latency_max_ms = g.latency_max_ms === null ? s.latency_ms : Math.max(g.latency_max_ms, s.latency_ms);
        }
        if (s.observed_at > g.last_observed_at) g.last_observed_at = s.observed_at;
        groups.set(key, g);
      }
      return [...groups.values()];
    },
    async aggregateReachable(hourStart, hourEnd) {
      const groups = new Map<string, number>();
      for (const s of samples) {
        if (s.observed_at < hourStart || s.observed_at >= hourEnd || !s.reachable) continue;
        const key = `${s.node_id}\u0000${s.target_key}\u0000${s.observation_source}`;
        groups.set(key, (groups.get(key) ?? 0) + 1);
      }
      return [...groups.entries()].map(([key, reachable]) => {
        const [node_id, target_key, observation_source] = key.split("\u0000");
        return { node_id: Number(node_id), target_key: target_key!, observation_source: observation_source!, reachable };
      });
    },
    async insertBucketIfAbsent(bucket) {
      calls.push("insert_bucket");
      if (buckets.some((b) => rowKey(b) === rowKey(bucket))) return false;
      buckets.push(bucket);
      return true;
    },
    async deleteSamplesBefore(cutoff) {
      calls.push("prune_samples");
      const keep = samples.filter((s) => s.observed_at >= cutoff);
      const removed = samples.length - keep.length;
      samples.length = 0;
      samples.push(...keep);
      return removed;
    },
    async deleteBucketsBefore(cutoff) {
      calls.push("prune_buckets");
      const keep = buckets.filter((b) => b.hour_start >= cutoff);
      const removed = buckets.length - keep.length;
      buckets.length = 0;
      buckets.push(...keep);
      return removed;
    },
    async readRawSamples(q) {
      return samples
        .filter(
          (s) =>
            s.node_id === q.node_id &&
            s.target_key === q.target_key &&
            s.observed_at >= q.from &&
            s.observed_at < q.to &&
            (q.observation_source === null || s.observation_source === q.observation_source),
        )
        .sort((a, b) => a.observed_at.getTime() - b.observed_at.getTime())
        .slice(0, q.limit)
        .map((s) => ({
          observed_at: s.observed_at,
          reachable: s.reachable,
          latency_ms: s.latency_ms,
          observation_source: s.observation_source,
        }));
    },
    async readHourBuckets(q) {
      return buckets
        .filter(
          (b) =>
            b.node_id === q.node_id &&
            b.target_key === q.target_key &&
            b.hour_start >= q.from &&
            b.hour_start < q.to &&
            (q.observation_source === null || b.observation_source === q.observation_source),
        )
        .sort((a, b) => a.hour_start.getTime() - b.hour_start.getTime())
        .slice(0, q.limit);
    },
  };
  return { deps, samples, buckets, calls };
}

const sample = (over: Partial<LatencySampleRow> = {}): LatencySampleRow => ({
  target_key: "t:80",
  host: "t",
  port: 80,
  reachable: true,
  latency_ms: 40,
  success_rate: 1,
  observed_at: new Date("2026-10-05T10:10:00.000Z"),
  observation_source: "ingress|tcp_connect",
  ...over,
});

/* ================================================================== */
/* ② 流水线：聚合 + 清理（G19.8 形状）                                  */
/* ================================================================== */

describe("V5-WP19-B 档案流水线", () => {
  test("appendLatencySamples 空数组不动 DB（不是「空写一次」）", async () => {
    const store = fakeStore();
    expect(await appendLatencySamples(store.deps, 1, [])).toBe(0);
    expect(store.samples).toHaveLength(0);
  });

  test("rollup 只处理已结束的小时，且重复跑幂等（第二遍全部跳过）", async () => {
    const store = fakeStore();
    await appendLatencySamples(store.deps, 1, [
      sample({ observed_at: new Date("2026-10-05T10:10:00.000Z"), latency_ms: 40 }),
      sample({ observed_at: new Date("2026-10-05T10:20:00.000Z"), latency_ms: 60 }),
      // 未结束的小时（11:00 那一小时，NOW=12:34 时 grace=1h 仍然「太新」）
      sample({ observed_at: new Date("2026-10-05T11:10:00.000Z"), latency_ms: 999 }),
    ]);
    const first = await rollUpLatencyBuckets(store.deps, NOW);
    expect(first.inserted).toBe(1);
    expect(store.buckets).toHaveLength(1);
    const bucket = store.buckets[0]!;
    expect(bucket.hour_start.toISOString()).toBe("2026-10-05T10:00:00.000Z");
    expect(bucket.sample_count).toBe(2);
    expect(averageLatencyMs(bucket.latency_sum_ms, bucket.latency_samples)).toBe(50);
    expect(bucket.latency_min_ms).toBe(40);
    expect(bucket.latency_max_ms).toBe(60);

    const second = await rollUpLatencyBuckets(store.deps, NOW);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(1);
    expect(store.buckets).toHaveLength(1);
    expect(store.buckets[0]!.sample_count).toBe(2);
  });

  test("G19.8：超期样本按边界消失、未超期完好、**桶在原始行被删前先建好**；再跑一遍不误删", async () => {
    const store = fakeStore();
    await appendLatencySamples(store.deps, 1, [
      // 25h 前：超过原始保留期（但仍在 26h 回看窗口内 ⇒ 必须先聚合再删）
      sample({ observed_at: new Date("2026-10-04T11:00:00.000Z"), latency_ms: 10 }),
      // 3h 前：未超期
      sample({ observed_at: new Date("2026-10-05T09:30:00.000Z"), latency_ms: 30 }),
    ]);
    const run = await runLatencyHistoryMaintenance(store.deps, NOW);
    // 两个小时各建一个桶：这正是"先聚合后清理"的意义 —— 10-04T11:00 那一行马上要被删掉，
    // 但它的桶已经留下，档案因此仍然能回答"过去那小时抖不抖"。
    expect(run.rollup.inserted).toBe(2);
    expect(store.buckets.map((b) => b.hour_start.toISOString())).toEqual([
      "2026-10-04T11:00:00.000Z",
      "2026-10-05T09:00:00.000Z",
    ]);
    expect(run.prune.raw_hours).toBe(24);
    expect(run.prune.bucket_days).toBe(30);
    expect(run.prune.raw_cutoff).toBe("2026-10-04T12:34:56.000Z");
    expect(run.prune.deleted_samples).toBe(1);
    expect(store.samples.map((s) => s.latency_ms)).toEqual([30]);

    const again = await runLatencyHistoryMaintenance(store.deps, NOW);
    expect(again.prune.deleted_samples).toBe(0);
    expect(again.prune.deleted_buckets).toBe(0);
    expect(again.rollup.inserted).toBe(0);
    // 只剩 09:00 那一小时还有原始行（10-04T11:00 的已被清理）→ 它的桶已存在 → 跳过。
    // 被清理那一小时**不会再被重算**，而它已经写下的桶不受影响：这正是"桶比原始样本活得久"。
    expect(again.rollup.skipped).toBe(1);
    expect(store.samples).toHaveLength(1);
    expect(store.buckets).toHaveLength(2);
  });

  test("先聚合后清理：调用顺序是硬约束（反过来会永久丢一段历史）", async () => {
    const store = fakeStore();
    await appendLatencySamples(store.deps, 1, [sample({ observed_at: new Date("2026-10-05T09:30:00.000Z") })]);
    store.calls.length = 0;
    await runLatencyHistoryMaintenance(store.deps, NOW);
    const firstBucket = store.calls.indexOf("insert_bucket");
    const firstPrune = store.calls.indexOf("prune_samples");
    expect(firstBucket).toBeGreaterThanOrEqual(0);
    expect(firstPrune).toBeGreaterThan(firstBucket);
  });

  test("超期桶按 hour_start 边界删掉（30d 之外）", async () => {
    const store = fakeStore();
    store.buckets.push({
      node_id: 1,
      target_key: "t:80",
      hour_start: new Date("2026-08-01T00:00:00.000Z"),
      observation_source: "ingress|tcp_connect",
      sample_count: 1,
      success_count: 1,
      failure_count: 0,
      latency_samples: 1,
      latency_sum_ms: 10,
      latency_min_ms: 10,
      latency_max_ms: 10,
      last_observed_at: new Date("2026-08-01T00:30:00.000Z"),
    });
    const prune = await pruneLatencyHistory(store.deps, NOW);
    expect(prune.deleted_buckets).toBe(1);
    expect(store.buckets).toHaveLength(0);
  });
});

/* ================================================================== */
/* ③ 读路径                                                            */
/* ================================================================== */

describe("V5-WP19-B 读路径：空 ≠ 被清理掉了", () => {
  test("坏窗口显式拒绝（不返回空序列冒充「没有观测」）", async () => {
    const store = fakeStore();
    const base = { node_id: 1, target_key: "t:80", granularity: "hour" as const };
    expect(await readLatencySeries(store.deps, { ...base, from: NOW, to: NOW }, NOW)).toEqual({
      ok: false,
      reason: "bad_window",
    });
    expect(await readLatencySeries(store.deps, { ...base, from: NOW, to: new Date(NOW.getTime() - 1000) }, NOW)).toEqual(
      { ok: false, reason: "bad_window" },
    );
  });

  test("原始样本窗口超出保留期 → 拒绝（真相是「被清理了」，不是「没有观测」）", async () => {
    const store = fakeStore();
    const result = await readLatencySeries(
      store.deps,
      {
        node_id: 1,
        target_key: "t:80",
        from: new Date(NOW.getTime() - 25 * 3_600_000),
        to: NOW,
        granularity: "sample",
      },
      NOW,
    );
    expect(result).toEqual({ ok: false, reason: "raw_window_expired" });
    // 拒绝发生在查询之前：没有对原始表发起任何读取。
    expect(store.calls).not.toContain("read_raw");
  });

  test("窗口中确实没有数据 → ok + 空数组（这是「没有观测」）", async () => {
    const store = fakeStore();
    const result = await readLatencySeries(
      store.deps,
      { node_id: 1, target_key: "t:80", from: new Date(NOW.getTime() - 3_600_000), to: NOW, granularity: "sample" },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.points).toEqual([]);
  });

  test("原始序列：没测到的点是 null，不是 0；不可达计入 failures", async () => {
    const store = fakeStore();
    await appendLatencySamples(store.deps, 1, [
      sample({ observed_at: new Date("2026-10-05T12:00:00.000Z"), latency_ms: 42 }),
      sample({ observed_at: new Date("2026-10-05T12:01:00.000Z"), reachable: false, latency_ms: null }),
    ]);
    const result = await readLatencySeries(
      store.deps,
      { node_id: 1, target_key: "t:80", from: new Date(NOW.getTime() - 3_600_000), to: NOW, granularity: "sample" },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.granularity).toBe("sample");
    expect(result.points.map((p) => p.latency_ms)).toEqual([42, null]);
    expect(result.points[1]!.failures).toBe(1);
    expect(result.points[1]!.successes).toBe(0);
  });

  test("小时序列：平均由 sum/samples 派生；没有测到延迟时是 null；口径不混", async () => {
    const store = fakeStore();
    await appendLatencySamples(store.deps, 1, [
      sample({ observed_at: new Date("2026-10-05T10:05:00.000Z"), latency_ms: 40 }),
      sample({ observed_at: new Date("2026-10-05T10:15:00.000Z"), latency_ms: 60 }),
      sample({
        observed_at: new Date("2026-10-05T10:25:00.000Z"),
        observation_source: "egress|tcp_connect",
        reachable: false,
        latency_ms: null,
      }),
    ]);
    await rollUpLatencyBuckets(store.deps, NOW);
    const result = await readLatencySeries(
      store.deps,
      {
        node_id: 1,
        target_key: "t:80",
        from: new Date("2026-10-05T00:00:00.000Z"),
        to: new Date("2026-10-06T00:00:00.000Z"),
        granularity: "hour",
      },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.points).toHaveLength(2);
    const bySource = new Map(result.points.map((p) => [p.observation_source, p]));
    expect(bySource.get("ingress|tcp_connect")!.latency_ms).toBe(50);
    expect(bySource.get("ingress|tcp_connect")!.samples).toBe(2);
    // 另一口径只有不可达样本 → 平均值 null（不是 0），失败计数照记。
    expect(bySource.get("egress|tcp_connect")!.latency_ms).toBeNull();
    expect(bySource.get("egress|tcp_connect")!.failures).toBe(1);
  });

  test("超上限显式 truncated（不静默给一条「看起来完整」的线）", async () => {
    const store = fakeStore();
    const rows: LatencySampleRow[] = [];
    for (let i = 0; i < MAX_SERIES_POINTS + 5; i += 1) {
      rows.push(sample({ observed_at: new Date(NOW.getTime() - (MAX_SERIES_POINTS + 10 - i) * 1000), latency_ms: i }));
    }
    await appendLatencySamples(store.deps, 1, rows);
    const result = await readLatencySeries(
      store.deps,
      { node_id: 1, target_key: "t:80", from: new Date(NOW.getTime() - 3_600_000), to: NOW, granularity: "sample" },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.truncated).toBe(true);
    expect(result.points).toHaveLength(MAX_SERIES_POINTS);
  });
});
