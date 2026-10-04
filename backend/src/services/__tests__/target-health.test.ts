/**
 * V5-WP6 — 目标健康合成离线单测（不连 DB / Redis / 网络）。
 *
 * 验收口径（`DEVELOPMENT.md` §7「V5.2」冻结块 + §7.2）：
 *   1. 五态语义与跃迁逐条落地：**每一条跃迁都有用例**，包括
 *      `healthy → unhealthy → recovering → healthy`（Gate V5-G2 的最小路径）；
 *   2. 迟滞两个方向：进 `unhealthy` 要连续失败 N 次，出要连续成功 M 次；
 *      单次失败 / 单次成功都不能跨过这两条线；
 *   3. warm-up：新 target 一次成功只到 `recovering`，连续 W 次才到 `healthy`；
 *   4. stale ≡ 没有证据：包括**面板重启**不能把旧观测当新鲜（结论 8/9）；
 *   5. partial visibility：多观测者取最坏，同时保留逐观测者明细；
 *   6. flap：窗口内翻转超限即标记并压制为不超过 `degraded`；
 *   7. synthesis **不改 desired**：一个 `unhealthy` 目标必须仍然出现在输出里；
 *   8. 纯函数：同样的输入 + 同样的 `now` ⇒ 同样的输出；阈值集中在阈值文件。
 *
 * ── 为什么全部用例都注入 NOW ──
 * 判定涉及 stale 窗口与 flap 窗口。读真实时钟会让用例在写完之后失效，所以事实一律
 * 按相对 NOW 的偏移构造（与 `node-health.test.ts` 同一条纪律）。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  TARGET_HEALTH_REASONS,
  TARGET_HEALTH_SEVERITY_ORDER,
  TARGET_HEALTH_STATES,
  describeTargetHealthReason,
  evaluateTargetObservation,
  isTargetHealthState,
  synthesiseTargetHealth,
  synthesiseTargetPool,
  worstTargetHealth,
  type PreviousTargetHealth,
  type TargetHealthReason,
  type TargetHealthValue,
  type TargetObservation,
} from "../target-health.ts";
import {
  TARGET_HEALTH_THRESHOLDS,
  TARGET_HEALTH_VALUE_DOMAIN,
  type TargetHealthThresholds,
} from "../target-health-thresholds.ts";

const NOW_MS = Date.parse("2026-10-04T00:00:00.000Z");
const NOW = new Date(NOW_MS);
const FRESH_AT = new Date(NOW_MS - 1_000);

const T = TARGET_HEALTH_THRESHOLDS;

/** §7 结论 6 的一个「正常」观测：可达、零连败、连成 5 次、成功率 100%、延迟 20ms。 */
function obs(overrides: Partial<TargetObservation> = {}): TargetObservation {
  return {
    observation_source: { node_id: 1, probe: "tcp" },
    reachable: true,
    latency_ms: 20,
    consecutive_success: 5,
    consecutive_failure: 0,
    success_rate: 1,
    last_observed_at: FRESH_AT,
    ...overrides,
  };
}

/** 连续失败 n 次（因此不可达、延迟为 null）。 */
function failing(n: number, overrides: Partial<TargetObservation> = {}): TargetObservation {
  return obs({
    reachable: false,
    latency_ms: null,
    consecutive_success: 0,
    consecutive_failure: n,
    success_rate: Math.max(0, (T.SUCCESS_RATE_WINDOW - n) / T.SUCCESS_RATE_WINDOW),
    ...overrides,
  });
}

/** 连续成功 n 次（成功率默认 0.95，即「已经回升」）。 */
function succeeding(n: number, overrides: Partial<TargetObservation> = {}): TargetObservation {
  return obs({
    consecutive_success: n,
    consecutive_failure: 0,
    success_rate: 0.95,
    ...overrides,
  });
}

function prev(state: TargetHealthValue, recent_flips: number[] = []): PreviousTargetHealth {
  return { state, recent_flips };
}

interface SynthOptions {
  target?: string;
  now?: Date;
  thresholds?: Partial<TargetHealthThresholds> | null;
}

function synth(
  previous: PreviousTargetHealth | null,
  observations: TargetObservation[],
  options: SynthOptions = {},
) {
  return synthesiseTargetHealth({
    target: options.target ?? "10.0.0.1:443",
    observations,
    previous,
    now: options.now ?? NOW,
    thresholds: options.thresholds ?? null,
  });
}

/* ================================================================== */
/* 契约形状：五态、阈值、严重度全序                                      */
/* ================================================================== */

describe("V5-WP6 契约形状", () => {
  test("五态与 §7 状态表同序（顺序本身是被评审过的动作）", () => {
    expect(TARGET_HEALTH_STATES).toEqual(["unknown", "healthy", "degraded", "unhealthy", "recovering"]);
    expect(isTargetHealthState("recovering")).toBe(true);
    expect(isTargetHealthState("healthy ")).toBe(false);
    expect(isTargetHealthState(undefined)).toBe(false);
  });

  test("严重度全序是五态的一个排列，且 unhealthy 最坏", () => {
    expect([...TARGET_HEALTH_SEVERITY_ORDER].sort()).toEqual([...TARGET_HEALTH_STATES].sort());
    expect(TARGET_HEALTH_SEVERITY_ORDER[0]).toBe("unknown");
    expect(TARGET_HEALTH_SEVERITY_ORDER[TARGET_HEALTH_SEVERITY_ORDER.length - 1]).toBe("unhealthy");
    // unknown 不是「好」：取最坏时它绝不覆盖任何真实结论。
    expect(worstTargetHealth("unknown", "healthy")).toBe("healthy");
    expect(worstTargetHealth("healthy", "recovering")).toBe("recovering");
    expect(worstTargetHealth("recovering", "degraded")).toBe("degraded");
    expect(worstTargetHealth("degraded", "unhealthy")).toBe("unhealthy");
    expect(worstTargetHealth("unhealthy", "healthy")).toBe("unhealthy");
  });

  test("阈值集中：§7 冻结值、3× stale 算式、对象冻结", () => {
    expect(Object.isFrozen(TARGET_HEALTH_THRESHOLDS)).toBe(true);
    expect(T.FAILURE_THRESHOLD).toBe(3);
    expect(T.RECOVERY_SUCCESSES).toBe(2);
    expect(T.WARMUP_SUCCESSES).toBe(2);
    expect(T.SUCCESS_RATE_WINDOW).toBe(20);
    // §7 结论 8：STALE_AFTER = 3 × 上报周期，且与 V4 节点 stale 窗口同源。
    expect(T.STALE_AFTER_MS).toBe(T.REPORT_INTERVAL_MS * T.STALE_AFTER_MULTIPLIER);
    expect(T.STALE_AFTER_MS).toBe(90_000);
    expect(T.STALE_AFTER_MS).toBe(3 * T.REPORT_INTERVAL_MS);
    expect(TARGET_HEALTH_VALUE_DOMAIN.SUCCESS_RATE_MAX).toBe(1);
  });

  test("每个理由码都有非空说明（UI 不能拿到空气泡）", () => {
    expect(TARGET_HEALTH_REASONS.length).toBeGreaterThan(0);
    for (const reason of TARGET_HEALTH_REASONS) {
      expect(describeTargetHealthReason(reason).length).toBeGreaterThan(0);
    }
  });
});

/* ================================================================== */
/* 无证据 ⇒ unknown（never assume healthy）                              */
/* ================================================================== */

describe("无证据 ⇒ unknown", () => {
  test("从未观测：unknown，且 facts 明确说「没有证据」", () => {
    const view = synth(null, []);
    expect(view.state).toBe("unknown");
    expect(view.reasons).toEqual(["no_observation"]);
    expect(view.facts.evidence).toBe(false);
    expect(view.facts.observers).toBe(0);
    expect(view.facts.worst_observer).toBeNull();
    expect(view.facts.success_rate).toBeNull();
  });

  test("记录不可读：缺观测方 / 缺 reachable 都不是证据", () => {
    const missingSource = synth(null, [obs({ observation_source: null })]);
    expect(missingSource.state).toBe("unknown");
    expect(missingSource.reasons).toEqual(["observation_unusable"]);
    expect(missingSource.observers[0].usable).toBe(false);

    const missingReachable = synth(null, [obs({ reachable: null })]);
    expect(missingReachable.state).toBe("unknown");
    expect(missingReachable.reasons).toEqual(["observation_unusable"]);
  });

  test("证据全部过期：stale 等同于没有证据，而不是沿用最后一次结果", () => {
    // 事实内容说「健康」，但已经过期 —— 结论必须是 unknown。
    const stale = obs({ last_observed_at: new Date(NOW_MS - T.STALE_AFTER_MS - 1) });
    const view = synth(prev("healthy"), [stale]);
    expect(view.state).toBe("unknown");
    expect(view.reasons).toEqual(["observation_stale"]);
    expect(view.observers[0].stale).toBe(true);
    expect(view.observers[0].evidence).toBe(false);
    // 原始事实仍然透出（stale 必须**可识别**，§7 结论 8），只是不参与结论。
    expect(view.observers[0].reachable).toBe(true);
    expect(view.observers[0].age_ms).toBe(T.STALE_AFTER_MS + 1);
  });

  test("stale 边界：age 恰好等于阈值仍然新鲜，超过一点点即 stale", () => {
    const atEdge = synth(null, [obs({ last_observed_at: new Date(NOW_MS - T.STALE_AFTER_MS) })]);
    expect(atEdge.observers[0].stale).toBe(false);
    expect(atEdge.state).toBe("healthy");

    const overEdge = synth(null, [obs({ last_observed_at: new Date(NOW_MS - T.STALE_AFTER_MS - 1) })]);
    expect(overEdge.observers[0].stale).toBe(true);
    expect(overEdge.state).toBe("unknown");
  });

  test("全部观测者都 stale 时结论是 unknown —— 即使内容说 unhealthy", () => {
    const staleUnhealthy = failing(9, { last_observed_at: new Date(NOW_MS - T.STALE_AFTER_MS * 2) });
    const view = synth(prev("unhealthy"), [staleUnhealthy]);
    expect(view.state).toBe("unknown");
    expect(view.facts.evidence).toBe(false);
    expect(view.facts.stale_observers).toBe(1);
    expect(view.facts.fresh_observers).toBe(0);
  });

  test("面板重启：库里的旧观测不会被当成新鲜（结论 9）", () => {
    // 重启前的最后一条观测是 40 分钟前写的 —— 重启后 `now` 已经走了很远，
    // age 自然超过阈值；模块不引入「重启后信任缓存」的特例。
    const beforeRestart = obs({
      last_observed_at: new Date(NOW_MS - 40 * 60_000),
      consecutive_success: 99,
    });
    const view = synth(prev("healthy"), [beforeRestart], { now: NOW });
    expect(view.state).toBe("unknown");
    expect(view.observers[0].stale).toBe(true);
    expect(view.reasons).toContain("observation_stale");
  });

  test("面板重启：一个与时间戳矛盾的 observation_age 不能把旧观测洗成新鲜", () => {
    // 有人把「读取时算出来的 age」缓存下来了（§7 结论 7 明确禁止），甚至存成 0：
    // 时间戳在时必须由 `now - last_observed_at` 说话。
    const resurrected = obs({
      last_observed_at: new Date(NOW_MS - 40 * 60_000),
      observation_age_ms: 0,
      observation_age: 0,
    });
    const view = synth(prev("healthy"), [resurrected]);
    expect(view.state).toBe("unknown");
    expect(view.observers[0].age_ms).toBe(40 * 60_000);
  });

  test("调用方直接给 age（没有时间戳）时按 age 判 stale", () => {
    const fresh = obs({ last_observed_at: null, observation_age_ms: 1_000 });
    expect(synth(null, [fresh]).state).toBe("healthy");
    const stale = obs({ last_observed_at: null, observation_age: T.STALE_AFTER_MS + 1 });
    expect(synth(null, [stale]).state).toBe("unknown");
  });
});

/* ================================================================== */
/* warm-up                                                             */
/* ================================================================== */

describe("warm-up：新 target 从 unknown 起步", () => {
  test("一次成功只到 recovering（§7 明文）", () => {
    const view = synth(null, [succeeding(1)]);
    expect(view.state).toBe("recovering");
    expect(view.reasons).toEqual(["warmup_hysteresis"]);
  });

  test("连续 WARMUP_SUCCESSES 次成功才到 healthy", () => {
    expect(synth(null, [succeeding(1)]).state).toBe("recovering");
    expect(synth(null, [succeeding(2)]).state).toBe("healthy");
    expect(synth(null, [succeeding(2)]).reasons).toEqual(["warmup_complete"]);
  });

  test("一次失败是 degraded，不是 unhealthy（禁止 single timeout → 摘除）", () => {
    const view = synth(null, [failing(1)]);
    expect(view.state).toBe("degraded");
    expect(view.reasons).toEqual(["failure_subthreshold"]);
  });

  test("连续失败逐级：1/2 次是 degraded，第 FAILURE_THRESHOLD 次才是 unhealthy", () => {
    expect(synth(null, [failing(1)]).state).toBe("degraded");
    expect(synth(null, [failing(2)]).state).toBe("degraded");
    expect(synth(null, [failing(3)]).state).toBe("unhealthy");
    expect(synth(null, [failing(3)]).reasons).toEqual(["failure_threshold"]);
  });
});

/* ================================================================== */
/* 迟滞（两个方向）                                                     */
/* ================================================================== */

describe("迟滞：进 unhealthy 要 N 次连败，出要 M 次连胜", () => {
  test("healthy + 单次失败 ⇒ degraded（事实可见，但不判死）", () => {
    const view = synth(prev("healthy"), [failing(1)]);
    expect(view.state).toBe("degraded");
    expect(view.state).not.toBe("unhealthy");
  });

  test("healthy + 连续 N 次失败 ⇒ unhealthy", () => {
    expect(synth(prev("healthy"), [failing(2)]).state).toBe("degraded");
    expect(synth(prev("healthy"), [failing(3)]).state).toBe("unhealthy");
  });

  test("unhealthy + 单次成功 ⇒ 仍然 unhealthy（迟滞出不成立）", () => {
    const view = synth(prev("unhealthy"), [succeeding(1)]);
    expect(view.state).toBe("unhealthy");
    expect(view.reasons).toEqual(["recovery_hysteresis"]);
  });

  test("unhealthy + 连续 M 次成功 ⇒ recovering（唯一出口）", () => {
    const view = synth(prev("unhealthy"), [succeeding(2)]);
    expect(view.state).toBe("recovering");
    expect(view.reasons).toEqual(["left_unhealthy"]);
  });

  test("离开 unhealthy 还要求证据完整自洽：缺计数 / 仍不可达都不放行", () => {
    // 连续成功 2 次但连败计数不可读：不能用「不知道」证明「已经好了」。
    const missingCounters = synth(prev("unhealthy"), [succeeding(2, { consecutive_failure: null })]);
    expect(missingCounters.state).toBe("unhealthy");
    expect(missingCounters.reasons).toEqual(["recovery_hysteresis"]);

    // 自相矛盾的记录（说不可达，却报连续成功 2 次）：按不可达处理。
    const contradictory = synth(prev("unhealthy"), [
      succeeding(2, { reachable: false, latency_ms: null, consecutive_failure: 0 }),
    ]);
    expect(contradictory.state).toBe("unhealthy");
  });

  test("unhealthy 永远不会直接回到 healthy —— 即使成功率已经回升", () => {
    // cs 远超 M、成功率 1.0，仍然只能走到 recovering：取消这次断言就等于取消
    // 「recovering 是 unhealthy 唯一出口」。
    const view = synth(prev("unhealthy"), [succeeding(7, { success_rate: 1 })]);
    expect(view.state).toBe("recovering");
  });

  test("recovering + 成功率没回升 ⇒ 留在 recovering；回升后 ⇒ healthy", () => {
    const stillBelow = synth(prev("recovering"), [succeeding(2, { success_rate: 0.8 })]);
    expect(stillBelow.state).toBe("degraded");

    const notEnoughStreak = synth(prev("recovering"), [succeeding(1, { success_rate: 0.95 })]);
    expect(notEnoughStreak.state).toBe("recovering");
    expect(notEnoughStreak.reasons).toEqual(["recovery_hysteresis"]);

    const recovered = synth(prev("recovering"), [succeeding(2, { success_rate: 0.95 })]);
    expect(recovered.state).toBe("healthy");
    expect(recovered.reasons).toEqual(["recovered"]);
  });

  test("recovering + 单次失败 ⇒ degraded（证据变坏，取悲观）", () => {
    const view = synth(prev("recovering"), [failing(1)]);
    expect(view.state).toBe("degraded");
  });

  test("recovering + 连续 N 次失败 ⇒ unhealthy", () => {
    expect(synth(prev("recovering"), [failing(3)]).state).toBe("unhealthy");
  });

  test("degraded + 单次成功 ⇒ recovering（单次成功不返回 healthy）", () => {
    const view = synth(prev("degraded"), [succeeding(1)]);
    expect(view.state).toBe("recovering");
    expect(view.reasons).toEqual(["warmup_hysteresis"]);
  });

  test("degraded + 连续 W 次成功 ⇒ healthy", () => {
    expect(synth(prev("degraded"), [succeeding(2)]).state).toBe("healthy");
  });

  test("healthy + 单次成功 ⇒ 保持 healthy（噪声不推动健康列）", () => {
    const view = synth(prev("healthy"), [succeeding(1)]);
    expect(view.state).toBe("healthy");
    expect(view.reasons).toEqual(["healthy_retained"]);
  });

  test("§7.3 Gate V5-G2 最小路径：healthy → unhealthy → recovering → healthy", () => {
    const first = synth(prev("healthy"), [failing(3)]);
    expect(first.state).toBe("unhealthy");

    const second = synth(first, [succeeding(2, { success_rate: 0.9 })]);
    expect(second.state).toBe("recovering");

    const third = synth(second, [succeeding(3, { success_rate: 0.95 })]);
    expect(third.state).toBe("healthy");
  });

  test("unhealthy 状态下证据过期 ⇒ unknown，且证据回来时要重新走 warm-up（不信任缓存）", () => {
    const stale = synth(prev("unhealthy"), [failing(3, { last_observed_at: new Date(NOW_MS - T.STALE_AFTER_MS - 1) })]);
    expect(stale.state).toBe("unknown");
    // 证据回来后必须从**新证据**重新推导：一次成功只到 recovering，
    // 而不是「恢复成重启前那个 unhealthy / healthy」。
    const back = synth(stale, [succeeding(1, { success_rate: 0.95 })]);
    expect(back.state).toBe("recovering");
    // 连续成功够多时，新证据本身就足以判 healthy（这不是缓存，是事实）。
    expect(synth(stale, [succeeding(2, { success_rate: 0.95 })]).state).toBe("healthy");
  });
});

/* ================================================================== */
/* 状态表逐条跃迁矩阵                                                   */
/* ================================================================== */

describe("§7 状态表逐条跃迁（矩阵，每条一行）", () => {
  interface MatrixCase {
    name: string;
    previous: TargetHealthValue | null;
    observation: TargetObservation | null;
    expect: TargetHealthValue;
    reason: TargetHealthReason;
  }

  const cases: MatrixCase[] = [
    // unknown 出发
    { name: "unknown → unknown（无观测）", previous: null, observation: null, expect: "unknown", reason: "no_observation" },
    { name: "unknown → degraded（1 次失败）", previous: "unknown", observation: failing(1), expect: "degraded", reason: "failure_subthreshold" },
    { name: "unknown → recovering（1 次成功）", previous: null, observation: succeeding(1), expect: "recovering", reason: "warmup_hysteresis" },
    { name: "unknown → healthy（W 次连续成功）", previous: null, observation: succeeding(2), expect: "healthy", reason: "warmup_complete" },
    { name: "unknown → unhealthy（N 次连续失败）", previous: null, observation: failing(3), expect: "unhealthy", reason: "failure_threshold" },
    { name: "unknown → degraded（成功率不达标）", previous: null, observation: obs({ success_rate: 0.5 }), expect: "degraded", reason: "success_rate_below_healthy" },
    { name: "unknown → degraded（延迟超标）", previous: null, observation: obs({ latency_ms: T.LATENCY_DEGRADED_MS + 1 }), expect: "degraded", reason: "latency_degraded" },
    // healthy 出发
    { name: "healthy → healthy（保持）", previous: "healthy", observation: succeeding(1), expect: "healthy", reason: "healthy_retained" },
    { name: "healthy → degraded（单次失败）", previous: "healthy", observation: failing(1), expect: "degraded", reason: "failure_subthreshold" },
    { name: "healthy → unhealthy（N 次连续失败）", previous: "healthy", observation: failing(3), expect: "unhealthy", reason: "failure_threshold" },
    // degraded 出发
    { name: "degraded → degraded（继续失败未达 N）", previous: "degraded", observation: failing(2), expect: "degraded", reason: "failure_subthreshold" },
    { name: "degraded → unhealthy（第 N 次连续失败）", previous: "degraded", observation: failing(3), expect: "unhealthy", reason: "failure_threshold" },
    { name: "degraded → recovering（1 次成功）", previous: "degraded", observation: succeeding(1), expect: "recovering", reason: "warmup_hysteresis" },
    { name: "degraded → healthy（W 次连续成功）", previous: "degraded", observation: succeeding(2), expect: "healthy", reason: "warmup_complete" },
    // recovering 出发
    { name: "recovering → recovering（连续成功不够）", previous: "recovering", observation: succeeding(1, { success_rate: 0.95 }), expect: "recovering", reason: "recovery_hysteresis" },
    { name: "recovering → healthy（成功率回升）", previous: "recovering", observation: succeeding(2, { success_rate: 0.95 }), expect: "healthy", reason: "recovered" },
    { name: "recovering → degraded（单次失败）", previous: "recovering", observation: failing(1), expect: "degraded", reason: "failure_subthreshold" },
    { name: "recovering → unhealthy（N 次连续失败）", previous: "recovering", observation: failing(3), expect: "unhealthy", reason: "failure_threshold" },
    // unhealthy 出发
    { name: "unhealthy → unhealthy（单次成功）", previous: "unhealthy", observation: succeeding(1), expect: "unhealthy", reason: "recovery_hysteresis" },
    { name: "unhealthy → recovering（M 次连续成功）", previous: "unhealthy", observation: succeeding(2), expect: "recovering", reason: "left_unhealthy" },
    { name: "unhealthy → unhealthy（继续失败）", previous: "unhealthy", observation: failing(4), expect: "unhealthy", reason: "failure_threshold" },
    // 任意 → unknown（证据过期）
    { name: "任意 → unknown（stale）", previous: "unhealthy", observation: failing(3, { last_observed_at: new Date(NOW_MS - T.STALE_AFTER_MS - 1) }), expect: "unknown", reason: "observation_stale" },
  ];

  for (const item of cases) {
    test(item.name, () => {
      const observations = item.observation === null ? [] : [item.observation];
      const view = synth(item.previous === null ? null : prev(item.previous), observations);
      expect(view.state).toBe(item.expect);
      expect(view.reasons).toContain(item.reason);
    });
  }

  test("矩阵覆盖了全部五个状态作为出发状态", () => {
    const from = new Set(cases.map((c) => c.previous));
    for (const state of TARGET_HEALTH_STATES) expect(from.has(state)).toBe(true);
  });
});

/* ================================================================== */
/* degraded 的其余触发面：成功率、延迟、不可读字段                        */
/* ================================================================== */

describe("degraded 的其余触发面", () => {
  test("成功率低于健康线 ⇒ degraded；恰好等于健康线 ⇒ healthy（契约用 >=）", () => {
    const below = synth(null, [obs({ success_rate: T.HEALTHY_RATE - 0.01 })]);
    expect(below.state).toBe("degraded");
    expect(below.reasons).toEqual(["success_rate_below_healthy"]);

    const atLine = synth(null, [obs({ success_rate: T.HEALTHY_RATE })]);
    expect(atLine.state).toBe("healthy");
  });

  test("延迟恰好等于劣化线不降级，超过即降级（契约用 >）", () => {
    expect(synth(null, [obs({ latency_ms: T.LATENCY_DEGRADED_MS })]).state).toBe("healthy");
    const over = synth(null, [obs({ latency_ms: T.LATENCY_DEGRADED_MS + 1 })]);
    expect(over.state).toBe("degraded");
    expect(over.reasons).toEqual(["latency_degraded"]);
  });

  test("成功率缺失或越界 ⇒ degraded（缺字段 ≠ 0，绝不补成达标）", () => {
    expect(synth(null, [obs({ success_rate: null })]).reasons).toEqual(["success_rate_unknown"]);
    expect(synth(null, [obs({ success_rate: undefined })]).state).toBe("degraded");
    // 百分数（150 = 150%）与负数是越界，不是「全对」。
    expect(synth(null, [obs({ success_rate: 150 })]).state).toBe("degraded");
    expect(synth(null, [obs({ success_rate: -1 })]).state).toBe("degraded");
    expect(synth(null, [obs({ success_rate: Number.NaN })]).state).toBe("degraded");
  });

  test("计数缺失或为负 ⇒ degraded（不可读的字段不能升级成 healthy）", () => {
    const noFailureCount = synth(null, [obs({ consecutive_failure: null })]);
    expect(noFailureCount.state).toBe("degraded");
    expect(noFailureCount.reasons).toEqual(["counters_unknown"]);

    expect(synth(null, [obs({ consecutive_success: null })]).reasons).toEqual(["counters_unknown"]);
    expect(synth(null, [obs({ consecutive_failure: -1 })]).state).toBe("degraded");
    expect(synth(null, [obs({ consecutive_success: 1.5 })]).state).toBe("degraded");
  });

  test("延迟字段坏形状 ⇒ degraded（不是「没有延迟事实」）", () => {
    const bogus = synth(null, [obs({ latency_ms: "20" as unknown as number })]);
    expect(bogus.state).toBe("degraded");
    expect(bogus.reasons).toEqual(["latency_unknown"]);
    expect(synth(null, [obs({ latency_ms: -5 })]).state).toBe("degraded");
  });

  test("不可达但计数为 0 的矛盾记录 ⇒ degraded（乐观字段赢不了悲观事实）", () => {
    const contradictory = synth(null, [obs({ reachable: false, consecutive_failure: 0, latency_ms: null })]);
    expect(contradictory.state).toBe("degraded");
    expect(contradictory.reasons).toEqual(["unreachable_subthreshold"]);
  });

  test("可达但计数说失败 ⇒ 按计数判 degraded（悲观的一侧赢）", () => {
    const contradictory = synth(null, [obs({ reachable: true, consecutive_failure: 1, consecutive_success: 0, latency_ms: null })]);
    expect(contradictory.state).toBe("degraded");
    expect(contradictory.reasons).toEqual(["failure_subthreshold"]);
  });

  test("单观测者入口也能直接用（evaluateTargetObservation）", () => {
    const single = evaluateTargetObservation({ observation: obs(), now: NOW });
    expect(single.state).toBe("healthy");
    expect(single.evidence).toBe(true);
    expect(single.observer_label).toBe("1:tcp");
  });
});

/* ================================================================== */
/* flap                                                                */
/* ================================================================== */

describe("flap：抖动是事实，不能被平均掉", () => {
  const A = obs();
  const B = failing(3);
  const C = succeeding(2, { success_rate: 0.9 });

  test("窗口内 4 次翻转不标 flapping，第 5 次才标（契约写「超过」）", () => {
    let view = synth(null, [A]);
    expect(view.state).toBe("healthy");
    expect(view.flapping).toBe(false);

    view = synth(view, [B]);
    expect(view.state).toBe("unhealthy");
    view = synth(view, [C]);
    expect(view.state).toBe("recovering");
    view = synth(view, [C]);
    expect(view.state).toBe("healthy");
    view = synth(view, [B]);
    expect(view.state).toBe("unhealthy");
    expect(view.recent_flips.length).toBe(4);
    expect(view.flapping).toBe(false);

    view = synth(view, [C]);
    expect(view.recent_flips.length).toBe(5);
    expect(view.flapping).toBe(true);
    // recovering 被压制为不超过 degraded。
    expect(view.state).toBe("degraded");
    expect(view.reasons).toContain("flapping_capped");
  });

  test("flapping 压制 healthy / recovering，但绝不把 unhealthy 放宽成 degraded", () => {
    const fiveFlips = [NOW_MS, NOW_MS, NOW_MS, NOW_MS, NOW_MS];

    // healthy 被压到 degraded。
    const capped = synth({ state: "healthy", recent_flips: fiveFlips }, [A]);
    expect(capped.flapping).toBe(true);
    expect(capped.state).toBe("degraded");
    expect(capped.reasons).toContain("flapping_capped");

    // 同一份抖动历史 + 真实故障：结论仍然是 unhealthy，不被「压制」。
    const stillUnhealthy = synth({ state: "degraded", recent_flips: fiveFlips }, [failing(3)]);
    expect(stillUnhealthy.flapping).toBe(true);
    expect(stillUnhealthy.state).toBe("unhealthy");
    expect(stillUnhealthy.reasons).not.toContain("flapping_capped");
  });

  test("窗口外的旧翻转被丢弃；恰好落在窗口边界的那一次仍在窗口内", () => {
    const oldFlips = [NOW_MS - T.FLAP_WINDOW_MS - 1, NOW_MS - T.FLAP_WINDOW_MS - 2];
    const view = synth({ state: "healthy", recent_flips: oldFlips }, [A]);
    expect(view.recent_flips).toEqual([]);
    expect(view.flapping).toBe(false);

    const boundary = [NOW_MS - T.FLAP_WINDOW_MS, NOW_MS - T.FLAP_WINDOW_MS + 1];
    expect(synth({ state: "healthy", recent_flips: boundary }, [A]).recent_flips).toEqual(boundary);
  });

  test("unknown 之间的迁移不算翻转（失去证据不是抖动），但历史不会被清零", () => {
    const stale = failing(3, { last_observed_at: new Date(NOW_MS - T.STALE_AFTER_MS - 1) });
    const flips = [NOW_MS, NOW_MS];
    const toUnknown = synth({ state: "healthy", recent_flips: flips }, [stale]);
    expect(toUnknown.state).toBe("unknown");
    expect(toUnknown.recent_flips).toEqual(flips);
    expect(toUnknown.flapping).toBe(false);

    const back = synth(toUnknown, [A]);
    expect(back.state).toBe("healthy");
    expect(back.recent_flips).toEqual(flips);
  });

  test("flapping 不会把 unknown 伪造成 degraded（没有证据就是没有证据）", () => {
    const flips = [NOW_MS, NOW_MS, NOW_MS, NOW_MS, NOW_MS];
    const view = synth({ state: "healthy", recent_flips: flips }, []);
    expect(view.state).toBe("unknown");
    expect(view.flapping).toBe(true); // 窗口内确实抖过：这是事实，照报
    expect(view.reasons).not.toContain("flapping_capped");
  });

  test("FLAP_FLIPS 可注入：调小后同一历史被判 flapping", () => {
    const view = synth(
      { state: "healthy", recent_flips: [NOW_MS, NOW_MS, NOW_MS] },
      [A],
      { thresholds: { FLAP_FLIPS: 2 } },
    );
    expect(view.flapping).toBe(true);
    expect(view.state).toBe("degraded");
    expect(view.reasons).toContain("flapping_capped");
  });
});

/* ================================================================== */
/* partial visibility                                                  */
/* ================================================================== */

describe("partial visibility：多观测者取最坏，明细保留", () => {
  const healthyFrom = (nodeId: number) => obs({ observation_source: { node_id: nodeId, probe: "tcp" } });

  test("一个节点说通、另一个说断 ⇒ 取最坏 + 保留两侧明细", () => {
    const view = synth(null, [healthyFrom(1), failing(3, { observation_source: { node_id: 2, probe: "tcp" } })]);
    expect(view.state).toBe("unhealthy");
    expect(view.facts.disagreement).toBe(true);
    expect(view.reasons).toContain("observers_disagree");
    expect(view.observers.map((o) => o.state)).toEqual(["healthy", "unhealthy"]);
    expect(view.observers.map((o) => o.observer_label)).toEqual(["1:tcp", "2:tcp"]);
    expect(view.facts.worst_observer).toEqual({ node_id: 2, probe: "tcp" });
    expect(view.facts.fresh_observers).toBe(2);
  });

  test("stale 观测者不参与取最坏（stale ≡ 没有证据）", () => {
    const staleUnhealthy = failing(9, {
      observation_source: { node_id: 1, probe: "tcp" },
      last_observed_at: new Date(NOW_MS - T.STALE_AFTER_MS - 1),
    });
    const view = synth(null, [staleUnhealthy, healthyFrom(2)]);
    expect(view.state).toBe("healthy");
    expect(view.facts.fresh_observers).toBe(1);
    expect(view.facts.stale_observers).toBe(1);
    expect(view.observers[0].state).toBe("unknown");
    expect(view.observers[0].reachable).toBe(false); // 事实仍然可见
  });

  test("观测者一致时不报 disagreement", () => {
    const view = synth(null, [healthyFrom(1), healthyFrom(2)]);
    expect(view.state).toBe("healthy");
    expect(view.facts.disagreement).toBe(false);
    expect(view.reasons).not.toContain("observers_disagree");
  });

  test("同严重度时按输入顺序取第一个作为 worst_observer（确定性）", () => {
    const view = synth(null, [
      failing(3, { observation_source: { node_id: 7, probe: "tcp" } }),
      failing(4, { observation_source: { node_id: 8, probe: "tcp" } }),
    ]);
    expect(view.state).toBe("unhealthy");
    expect(view.facts.worst_observer).toEqual({ node_id: 7, probe: "tcp" });
  });

  test("三种观测者混在一起时，fresh/unusable/stale 计数正确", () => {
    const view = synth(null, [
      healthyFrom(1),
      obs({ observation_source: null }), // 不可读
      failing(3, { observation_source: { node_id: 3, probe: "tcp" }, last_observed_at: new Date(NOW_MS - T.STALE_AFTER_MS - 1) }),
    ]);
    expect(view.facts.observers).toBe(3);
    expect(view.facts.fresh_observers).toBe(1);
    expect(view.facts.stale_observers).toBe(1);
    expect(view.facts.unusable_observers).toBe(1);
    expect(view.state).toBe("healthy");
  });
});

/* ================================================================== */
/* view：不改 desired、不做过滤                                          */
/* ================================================================== */

describe("view：合成永远不改 desired", () => {
  test("批量入口：顺序、条数、重复项原样保留，unhealthy 目标仍在输出里", () => {
    const targets = [
      { target: "10.0.0.1:443", observations: [obs()] },
      { target: "10.0.0.2:443", observations: [failing(3)] },
      { target: "10.0.0.1:443", observations: [obs()] },
      { target: "10.0.0.4:443", observations: [] },
    ];
    const views = synthesiseTargetPool({ targets, now: NOW });
    expect(views.length).toBe(targets.length);
    expect(views.map((v) => v.target)).toEqual([
      "10.0.0.1:443",
      "10.0.0.2:443",
      "10.0.0.1:443",
      "10.0.0.4:443",
    ]);
    // telemetry 没有删除权：不健康的目标必须仍然出现。
    expect(views[1].state).toBe("unhealthy");
    expect(views[3].state).toBe("unknown");
  });

  test("输入不被改写（深比较 + 冻结输入不抛错）", () => {
    const observations: TargetObservation[] = [failing(3)];
    const targets = [{ target: "10.0.0.2:443", observations }];
    const memory: Record<string, PreviousTargetHealth> = {
      "10.0.0.2:443": { state: "healthy", recent_flips: [NOW_MS - 1_000] },
    };
    const before = JSON.parse(JSON.stringify({ targets, memory }));

    Object.freeze(observations);
    Object.freeze(targets[0]);
    Object.freeze(targets);
    Object.freeze(memory["10.0.0.2:443"].recent_flips);
    Object.freeze(memory);

    const views = synthesiseTargetPool({ targets, previous: memory, now: NOW });
    expect(views[0].state).toBe("unhealthy");
    expect(JSON.parse(JSON.stringify({ targets, memory }))).toEqual(before);
  });

  test("Map 形态的 previous 与对象形态等价", () => {
    const asMap = new Map<string, PreviousTargetHealth>([
      ["10.0.0.2:443", { state: "unhealthy", recent_flips: [] }],
    ]);
    const viewMap = synthesiseTargetPool({
      targets: [{ target: "10.0.0.2:443", observations: [succeeding(1)] }],
      previous: asMap,
      now: NOW,
    });
    expect(viewMap[0].state).toBe("unhealthy"); // 单次成功仍不足以离开 unhealthy
    const viewRecord = synthesiseTargetPool({
      targets: [{ target: "10.0.0.2:443", observations: [succeeding(1)] }],
      previous: { "10.0.0.2:443": { state: "unhealthy", recent_flips: [] } },
      now: NOW,
    });
    expect(viewRecord).toEqual(viewMap);
  });

  test("原型键不能被当成历史状态", () => {
    const view = synthesiseTargetPool({
      targets: [{ target: "constructor", observations: [succeeding(1)] }],
      previous: {} as Record<string, PreviousTargetHealth>,
      now: NOW,
    });
    expect(view[0].state).toBe("recovering");
  });

  test("纯函数：相同输入 + 相同 now ⇒ 相同输出（且不是同一个对象）", () => {
    const input = {
      target: "10.0.0.1:443",
      observations: [obs(), failing(3, { observation_source: { node_id: 2, probe: "tcp" } })],
      previous: prev("healthy"),
      now: NOW,
    };
    const first = synthesiseTargetHealth(input);
    const second = synthesiseTargetHealth(input);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.observers).not.toBe(second.observers);
  });
});

/* ================================================================== */
/* 对齐上游/下游形状（agent targetobs + 面板 target_observation 投影）    */
/* ================================================================== */

describe("对齐 V5.2 WP5 线上形状", () => {
  test("observation_source 是字符串 <node>/<probe_kind>（agent 形态）", () => {
    const view = synth(null, [obs({ observation_source: "node-7/tcp_connect" })]);
    expect(view.state).toBe("healthy");
    expect(view.observers[0].observer).toEqual({ node_id: "node-7", probe: "tcp_connect" });
    expect(view.observers[0].observer_label).toBe("node-7:tcp_connect");
  });

  test("只有探测种类、没有观测节点的字符串不是证据（无法归属视角）", () => {
    const view = synth(null, [obs({ observation_source: "tcp_connect" })]);
    expect(view.state).toBe("unknown");
    expect(view.reasons).toEqual(["observation_unusable"]);
  });

  test("字符串形状与对象形状完全等价", () => {
    const viaString = synth(null, [obs({ observation_source: "node-7/tcp_connect" })]);
    const viaObject = synth(null, [obs({ observation_source: { node_id: "node-7", probe: "tcp_connect" } })]);
    expect(viaString).toEqual(viaObject);
  });

  test("last_observed_at 是 unix 秒时按秒解释（线上形状）", () => {
    const fresh = Math.floor((NOW_MS - 1_000) / 1_000);
    expect(synth(null, [obs({ last_observed_at: fresh })]).state).toBe("healthy");
    const stale = Math.floor((NOW_MS - T.STALE_AFTER_MS - 1_000) / 1_000);
    expect(synth(null, [obs({ last_observed_at: stale })]).state).toBe("unknown");
  });

  test("last_observed_at 是毫秒时按毫秒解释（Prisma DateTime / Date.now 形状）", () => {
    expect(synth(null, [obs({ last_observed_at: NOW_MS - 1_000 })]).state).toBe("healthy");
    expect(synth(null, [obs({ last_observed_at: NOW_MS - T.STALE_AFTER_MS - 1_000 })]).state).toBe("unknown");
  });

  test("DB 列别名 observed_at 与 last_observed_at 等价", () => {
    const viaAlias = synth(null, [obs({ last_observed_at: null, observed_at: new Date(NOW_MS - 1_000) })]);
    expect(viaAlias.state).toBe("healthy");
    expect(viaAlias.facts.age_ms).toBe(1_000);
  });

  test("0 / 负数时间戳是「没有这个事实」，不是 1970 年的观测", () => {
    expect(synth(null, [obs({ last_observed_at: 0 })]).state).toBe("unknown");
    expect(synth(null, [obs({ last_observed_at: -1 })]).state).toBe("unknown");
    expect(synth(null, [obs({ last_observed_at: 0 })]).reasons).toEqual(["observation_unusable"]);
  });
});

/* ================================================================== */
/* 阈值集中与纯度（源码守卫）                                            */
/* ================================================================== */

const MODULE_PATH = new URL("../target-health.ts", import.meta.url);
const MODULE_SRC = readFileSync(MODULE_PATH, "utf8");

/** 去掉注释与字符串，避免注释里提到的数字让守卫自己放行。 */
function stripCommentsAndStrings(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/`(?:[^`\\]|\\.)*`/g, '""')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, '""')
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("阈值集中与纯度（源码守卫）", () => {
  const code = stripCommentsAndStrings(MODULE_SRC);

  test("模块里没有数值字面量：阈值全部来自阈值文件", () => {
    expect(code).not.toMatch(/[0-9]/);
  });

  test("模块只 import 阈值文件，且用的是导出常量而不是自己定义", () => {
    const imports = MODULE_SRC.match(/^import[\s\S]*?;$/gm) ?? [];
    expect(imports.length).toBe(1);
    expect(imports[0]).toContain('from "./target-health-thresholds.ts"');
    expect(imports[0]).toContain("TARGET_HEALTH_THRESHOLDS");
    expect(imports[0]).toContain("TARGET_HEALTH_VALUE_DOMAIN");
    expect(code).not.toContain("TARGET_HEALTH_THRESHOLDS =");
    expect(code).not.toContain("Object.freeze(");
  });

  test("没有环境时钟 / 随机 / 网络 / Prisma（纯函数）", () => {
    expect(code).not.toContain("Date.now");
    expect(code).not.toMatch(/new Date\s*\(\s*\)/);
    expect(code).not.toContain("Math.random");
    expect(code).not.toContain("fetch(");
    expect(code).not.toContain("require(");
    expect(code).not.toContain("prisma");
    expect(code).not.toContain("Prisma");
  });

  test("阈值注入真的生效（不是把数值硬编码后仍读常量）", () => {
    const threeFailures = failing(3);
    expect(synth(prev("healthy"), [threeFailures]).state).toBe("unhealthy");

    const looser = synth(prev("healthy"), [threeFailures], { thresholds: { FAILURE_THRESHOLD: 5 } });
    expect(looser.state).toBe("degraded");

    const staleTight = synth(null, [obs({ last_observed_at: new Date(NOW_MS - 2_000) })], {
      thresholds: { STALE_AFTER_MS: 1_000 },
    });
    expect(staleTight.state).toBe("unknown");

    const warmupFour = synth(null, [succeeding(3)], { thresholds: { WARMUP_SUCCESSES: 4 } });
    expect(warmupFour.state).toBe("recovering");
  });

  test("阈值的默认值来自冻结常量本身（调用方不传时不应有第三份数字）", () => {
    const injected = synth(null, [obs({ success_rate: T.HEALTHY_RATE - 0.01 })], {
      thresholds: { HEALTHY_RATE: 0.5 },
    });
    expect(injected.state).toBe("healthy");
  });
});
