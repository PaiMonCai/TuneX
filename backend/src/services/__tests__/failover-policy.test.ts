/**
 * V5.3 WP10 — 故障转移/回切策略离线单测（不连 DB / Redis / 网络）。
 *
 * 验收口径（`DEVELOPMENT.md` §8 冻结契约二 + §8.3）：
 *   1. 六条条件**每条单独成立**才允许迁移；每条单独不成立都必须拦住，并说明是哪一条；
 *   2. 「heartbeat 超时单独出现不足以迁移」：心跳超时 + 观测不可用 / 目标侧故障 → 不动；
 *   3. 回切 = 连续 N 次健康 + 冷却期已过；且它是一次**正常的归属迁移**（epoch + 1），
 *      调用方只有一条执行路径；
 *   4. 冷却与方向无关：failover 紧接 failback 也要拦（同一 Forward 两次迁移不许过近）；
 *   5. 决策不依赖、不改写、不重排任何目标列表（它决定「谁承载」，不是「指向什么」）；
 *   6. 纯函数：同输入 + 同 now ⇒ 同输出；阈值集中在阈值文件，模块里没有数值字面量。
 *
 * ── 为什么全部用例都注入 NOW ──
 * 条件 1（stale 阈值）与条件 5（冷却窗口）都是时间窗口。读真实时钟会让用例在写完之后
 * 失效，所以事实一律按相对 NOW 的偏移构造（与 `target-health.test.ts` 同一纪律）。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  FAILOVER_ACTIONS,
  FAILOVER_CONDITIONS,
  FAILOVER_POLICY_CONDITIONS,
  FAILOVER_REASONS,
  PLACEMENT_PRECONDITIONS,
  decideFailover,
  describeFailoverReason,
  placementMigration,
  type FailoverCandidateFacts,
  type FailoverCondition,
  type FailoverDecision,
  type FailoverInput,
  type FailoverObservedTarget,
  type FailoverReason,
  type PlacementPrecondition,
} from "../failover-policy.ts";
import { FAILOVER_THRESHOLDS, PLACEMENT_EPOCH_INCREMENT } from "../failover-thresholds.ts";
import { TARGET_HEALTH_THRESHOLDS } from "../target-health-thresholds.ts";
import { DEFAULT_NODE_STALE_AFTER_MS } from "../reconciler.ts";

const NOW_MS = Date.parse("2026-10-04T12:00:00.000Z");
const NOW = new Date(NOW_MS);
const T = FAILOVER_THRESHOLDS;

/** 节点 id：当前承载 / failover 候选 / 首选（回切目标）/ 纯观测者 / 另一个备选。 */
const OWNER = 11;
const STANDBY = 22;
const PREFERRED = 33;
const OBSERVER = 9;
const OTHER_STANDBY = 44;

function observer(nodeId: number | string, state: string, stale = false): FailoverObservedTarget {
  return { node_id: nodeId, state: state as FailoverObservedTarget["state"], stale };
}

/** 失联的 owner：不可达 + 超过 stale 阈值（条件 1 成立）。 */
function downOwner(overrides: Partial<FailoverInput["owner"]> = {}): FailoverInput["owner"] {
  return {
    reachable: false,
    last_seen_at: new Date(NOW_MS - T.NODE_STALE_AFTER_MS - 1_000),
    ...overrides,
  };
}

function upOwner(overrides: Partial<FailoverInput["owner"]> = {}): FailoverInput["owner"] {
  return { reachable: true, last_seen_at: new Date(NOW_MS - 1_000), ...overrides };
}

function candidate(nodeId = STANDBY, overrides: Partial<FailoverCandidateFacts> = {}): FailoverCandidateFacts {
  return { node_id: nodeId, reachable: true, port_available: true, port_available_count: 3, ...overrides };
}

/** failover 基线：六条条件全部成立，期望得到 `move`。 */
function baseInput(overrides: Partial<FailoverInput> = {}): FailoverInput {
  return {
    forward_id: 7,
    now: NOW,
    placement: { owner_node_id: OWNER, epoch: 4, preferred_node_id: OWNER },
    owner: downOwner(),
    candidate: candidate(),
    target_observations: { observers: [observer(OBSERVER, "healthy")], age_ms: 1_000 },
    cooldown: { last_migration_at: null, last_migration_kind: null },
    policy: { auto_failover: true, auto_failback: true },
    failback: null,
    ...overrides,
  };
}

/** 回切基线：owner 正常但不是首选节点，首选节点连续健康且冷却已过，期望得到 `failback`。 */
function failbackInput(overrides: Partial<FailoverInput> = {}): FailoverInput {
  return baseInput({
    placement: { owner_node_id: STANDBY, epoch: 9, preferred_node_id: PREFERRED },
    owner: upOwner(),
    candidate: candidate(OTHER_STANDBY),
    failback: { candidate: candidate(PREFERRED), healthy_checks: T.FAILBACK_HEALTHY_CHECKS },
    ...overrides,
  });
}

function blockerConditions(decision: FailoverDecision): string[] {
  return decision.blockers.map((blocker) => blocker.condition);
}

function blockerReasons(decision: FailoverDecision): FailoverReason[] {
  return decision.blockers.map((blocker) => blocker.reason);
}

/* ================================================================== */
/* 契约形状                                                            */
/* ================================================================== */

describe("V5.3 WP10 契约形状", () => {
  test("六条条件与 §8 冻结契约同序（顺序本身是被评审过的动作）", () => {
    expect(FAILOVER_POLICY_CONDITIONS).toEqual([
      "owner_unreachable_beyond_stale",
      "observation_fresh",
      "target_not_side_failure",
      "standby_port_available",
      "cooldown_elapsed",
      "policy_allows",
    ]);
    expect(FAILOVER_POLICY_CONDITIONS.length).toBe(6);
    // 「全部条件」必须以六条为前缀，否则「六条」会悄悄变成「七条」。
    expect(FAILOVER_CONDITIONS.slice(0, FAILOVER_POLICY_CONDITIONS.length)).toEqual([
      ...FAILOVER_POLICY_CONDITIONS,
    ]);
    expect(FAILOVER_CONDITIONS).toContain("failback_healthy_checks");
    expect(PLACEMENT_PRECONDITIONS).toEqual([
      "standby_candidate",
      "standby_online",
      "placement_epoch",
      "failback_configured",
    ]);
  });

  test("动作词表是 move / hold / failback 三个，没有第四个", () => {
    expect(FAILOVER_ACTIONS).toEqual(["move", "hold", "failback"]);
  });

  test("阈值集中：冻结值、与 §7 stale 同源、与 V4 节点 stale 窗口同值", () => {
    expect(Object.isFrozen(FAILOVER_THRESHOLDS)).toBe(true);
    // 条件 1/2 的线不新造数字：直接取 §7 结论 8 的 stale 线。
    expect(T.NODE_STALE_AFTER_MS).toBe(TARGET_HEALTH_THRESHOLDS.STALE_AFTER_MS);
    expect(T.OBSERVATION_STALE_AFTER_MS).toBe(TARGET_HEALTH_THRESHOLDS.STALE_AFTER_MS);
    // 同一台面板上「多久没有心跳算 stale」只能有一个答案。
    expect(T.NODE_STALE_AFTER_MS).toBe(DEFAULT_NODE_STALE_AFTER_MS);
    expect(T.MIGRATION_COOLDOWN_MS).toBeGreaterThan(T.NODE_STALE_AFTER_MS);
    expect(T.FAILBACK_HEALTHY_CHECKS).toBeGreaterThan(TARGET_HEALTH_THRESHOLDS.RECOVERY_SUCCESSES);
    expect(T.MIN_FRESH_OBSERVERS).toBe(1);
    expect(T.MIN_AVAILABLE_PORTS).toBe(1);
    expect(PLACEMENT_EPOCH_INCREMENT).toBe(1);
  });

  test("每个理由码都有非空说明（UI 不能拿到空气泡）", () => {
    expect(FAILOVER_REASONS.length).toBeGreaterThan(0);
    for (const reason of FAILOVER_REASONS) {
      expect(describeFailoverReason(reason).length).toBeGreaterThan(0);
    }
  });
});

/* ================================================================== */
/* move：六条同时成立                                                   */
/* ================================================================== */

describe("move：六条同时成立才迁移", () => {
  test("六条全成立 ⇒ move，且指令是一个可 CAS 的归属迁移", () => {
    const decision = decideFailover(baseInput());
    expect(decision.action).toBe("move");
    expect(decision.blockers).toEqual([]);
    expect(decision.conditions).toEqual({
      owner_unreachable_beyond_stale: true,
      observation_fresh: true,
      target_not_side_failure: true,
      standby_port_available: true,
      cooldown_elapsed: true,
      policy_allows: true,
      failback_healthy_checks: null,
    });
    expect(decision.preconditions).toEqual({
      standby_candidate: true,
      standby_online: true,
      placement_epoch: true,
      failback_configured: null,
    });
    expect(decision.migration).toEqual({
      forward_id: 7,
      from_node_id: OWNER,
      to_node_id: STANDBY,
      expected_epoch: 4,
      next_epoch: 5,
      kind: "failover",
    });
    // 指令里必须带 epoch 对：调用方用它做 CAS（防 duplicate failover）。
    expect(decision.migration?.next_epoch).toBe((decision.migration?.expected_epoch ?? 0) + PLACEMENT_EPOCH_INCREMENT);
  });

  test("理由清单以「成立条件」为依据，能解释为什么迁移（不是只有 blocker）", () => {
    const decision = decideFailover(baseInput());
    expect(decision.reasons).toContain("owner_unreachable_beyond_stale" as FailoverReason);
    expect(decision.reasons).toContain("observation_fresh" as FailoverReason);
    expect(decision.reasons).toContain("target_not_side_failure" as FailoverReason);
    expect(decision.reasons).toContain("standby_port_available" as FailoverReason);
    expect(decision.reasons).toContain("cooldown_elapsed" as FailoverReason);
    expect(decision.reasons).toContain("policy_allows_failover" as FailoverReason);
  });

  test("目的地身份来自候选节点（模块不挑选候选，只判「能不能迁到这一个」）", () => {
    const decision = decideFailover(baseInput({ candidate: candidate(777) }));
    expect(decision.migration?.to_node_id).toBe(777);
  });

  test("心龄时间戳用秒或毫秒都能读（线上 unix 秒 / DB DateTime）", () => {
    const seconds = Math.floor((NOW_MS - T.NODE_STALE_AFTER_MS - 1_000) / 1_000);
    const decision = decideFailover(baseInput({ owner: { reachable: false, last_seen_at: seconds } }));
    expect(decision.action).toBe("move");
    const byAge = decideFailover(
      baseInput({ owner: { reachable: false, last_seen_age_ms: T.NODE_STALE_AFTER_MS + 1_000 } }),
    );
    expect(byAge.action).toBe("move");
  });
});

/* ================================================================== */
/* 每条条件单独不成立都会阻止迁移                                        */
/* ================================================================== */

describe("条件 1：节点不可达且超过 stale 阈值", () => {
  test("heartbeat 超时单独出现（连接仍在）⇒ hold，没有迁移的理由", () => {
    const decision = decideFailover(
      baseInput({ owner: { reachable: true, last_seen_at: new Date(NOW_MS - T.NODE_STALE_AFTER_MS * 5) } }),
    );
    expect(decision.action).toBe("hold");
    expect(decision.migration).toBeNull();
    expect(blockerReasons(decision)).toEqual(["owner_reachable"]);
    expect(decision.conditions.owner_unreachable_beyond_stale).toBe(false);
  });

  test("hard disconnect 但还没超过 stale 阈值 ⇒ 继续等", () => {
    const decision = decideFailover(
      baseInput({ owner: { reachable: false, last_seen_at: new Date(NOW_MS - 1_000) } }),
    );
    expect(decision.action).toBe("hold");
    expect(blockerReasons(decision)).toEqual(["owner_unreachable_within_stale"]);
  });

  test("不可达但心跳年龄不可知 ⇒ hold（无法证明「超过 stale」）", () => {
    const decision = decideFailover(baseInput({ owner: { reachable: false } }));
    expect(decision.action).toBe("hold");
    expect(blockerReasons(decision)).toEqual(["owner_stale_age_unknown"]);
  });

  test("边界：年龄恰好等于 stale 阈值不算「超过」，多 1ms 才算", () => {
    const atLine = decideFailover(
      baseInput({ owner: { reachable: false, last_seen_at: new Date(NOW_MS - T.NODE_STALE_AFTER_MS) } }),
    );
    expect(atLine.action).toBe("hold");
    expect(blockerReasons(atLine)).toEqual(["owner_unreachable_within_stale"]);

    const overLine = decideFailover(
      baseInput({ owner: { reachable: false, last_seen_at: new Date(NOW_MS - T.NODE_STALE_AFTER_MS - 1) } }),
    );
    expect(overLine.action).toBe("move");
  });
});

describe("条件 2：观测新鲜度可用", () => {
  test("没有任何观测者 ⇒ hold（没有证据就是没有证据）", () => {
    const decision = decideFailover(baseInput({ target_observations: { observers: [] } }));
    expect(decision.action).toBe("hold");
    expect(blockerReasons(decision)).toEqual(["observation_missing"]);
  });

  test("全部观测已过期 ⇒ hold（不能拿陈旧观测当迁移依据）", () => {
    const decision = decideFailover(
      baseInput({ target_observations: { observers: [observer(OBSERVER, "healthy", true)] } }),
    );
    expect(decision.action).toBe("hold");
    expect(blockerReasons(decision)).toEqual(["observation_all_stale"]);
  });

  test("新鲜证据年龄超过新鲜度线 ⇒ hold", () => {
    const decision = decideFailover(
      baseInput({
        target_observations: { observers: [observer(OBSERVER, "healthy")], age_ms: T.OBSERVATION_STALE_AFTER_MS + 1 },
      }),
    );
    expect(decision.action).toBe("hold");
    expect(blockerReasons(decision)).toEqual(["observation_too_old"]);
    // 边界：恰好等于新鲜度线仍然可用（§7 用「超过」这个词）。
    const atLine = decideFailover(
      baseInput({
        target_observations: { observers: [observer(OBSERVER, "healthy")], age_ms: T.OBSERVATION_STALE_AFTER_MS },
      }),
    );
    expect(atLine.action).toBe("move");
  });

  test("观测年龄不可读 ⇒ hold（fail-closed）", () => {
    const decision = decideFailover(
      baseInput({
        target_observations: {
          observers: [observer(OBSERVER, "healthy")],
          age_ms: Number.NaN,
        },
      }),
    );
    expect(decision.action).toBe("hold");
    expect(blockerReasons(decision)).toEqual(["observation_age_unusable"]);
  });

  test("新鲜观测者数量不足 ⇒ hold（门槛可注入）", () => {
    const decision = decideFailover(
      baseInput({ thresholds: { MIN_FRESH_OBSERVERS: 2 } }),
    );
    expect(decision.action).toBe("hold");
    expect(blockerReasons(decision)).toEqual(["observation_insufficient"]);
    // 两个新鲜观测者就够了。
    const enough = decideFailover(
      baseInput({
        thresholds: { MIN_FRESH_OBSERVERS: 2 },
        target_observations: { observers: [observer(OBSERVER, "healthy"), observer(5, "healthy")] },
      }),
    );
    expect(enough.action).toBe("move");
  });

  test("结论为 unknown 的观测者不构成证据", () => {
    const decision = decideFailover(
      baseInput({ target_observations: { observers: [observer(OBSERVER, "unknown")] } }),
    );
    expect(decision.action).toBe("hold");
    expect(blockerReasons(decision)).toEqual(["observation_all_stale"]);
  });
});

describe("条件 3：健康问题不是「目标本身坏了」", () => {
  test("新鲜证据说目标 unhealthy ⇒ hold：换承载节点只会掩盖故障", () => {
    const decision = decideFailover(
      baseInput({ target_observations: { observers: [observer(OBSERVER, "unhealthy")] } }),
    );
    expect(decision.action).toBe("hold");
    expect(blockerReasons(decision)).toEqual(["target_side_failure"]);
    expect(decision.blockers[0].detail).toContain(String(OBSERVER));
  });

  test("degraded 同样算目标侧故障 ⇒ hold", () => {
    const decision = decideFailover(
      baseInput({ target_observations: { observers: [observer(OBSERVER, "degraded")] } }),
    );
    expect(decision.action).toBe("hold");
    expect(blockerReasons(decision)).toEqual(["target_side_failure"]);
  });

  test("healthy / recovering 不阻止迁移（当前证据没有指向目标故障）", () => {
    expect(
      decideFailover(baseInput({ target_observations: { observers: [observer(OBSERVER, "healthy")] } })).action,
    ).toBe("move");
    expect(
      decideFailover(baseInput({ target_observations: { observers: [observer(OBSERVER, "recovering")] } })).action,
    ).toBe("move");
  });

  test("一个观测者说好、另一个说坏 ⇒ 取坏（fail-closed）", () => {
    const decision = decideFailover(
      baseInput({
        target_observations: { observers: [observer(OBSERVER, "healthy"), observer(5, "unhealthy")] },
      }),
    );
    expect(decision.action).toBe("hold");
    expect(blockerReasons(decision)).toEqual(["target_side_failure"]);
  });

  test("过期的坏消息不算证据：stale 的 unhealthy 观测不阻止迁移", () => {
    const decision = decideFailover(
      baseInput({
        target_observations: { observers: [observer(OBSERVER, "unhealthy", true), observer(5, "healthy")] },
      }),
    );
    expect(decision.action).toBe("move");
  });

  test("说「目标坏了」的只有 owner 自己时，额外给出可解释理由", () => {
    const decision = decideFailover(
      baseInput({
        target_observations: { observers: [observer(OWNER, "unhealthy")] },
      }),
    );
    expect(decision.action).toBe("hold");
    expect(decision.reasons).toContain("target_side_evidence_owner_only" as FailoverReason);
  });
});

describe("条件 4 与结构前提：目的地", () => {
  test("候选节点没有可用端口 ⇒ hold", () => {
    const decision = decideFailover(baseInput({ candidate: candidate(STANDBY, { port_available: false }) }));
    expect(decision.action).toBe("hold");
    expect(blockerReasons(decision)).toEqual(["standby_port_unavailable"]);
  });

  test("布尔说可用但计数为 0 ⇒ 按更严格的一方（hold）", () => {
    const decision = decideFailover(baseInput({ candidate: candidate(STANDBY, { port_available_count: 0 }) }));
    expect(decision.action).toBe("hold");
    expect(blockerReasons(decision)).toEqual(["standby_port_unavailable"]);
  });

  test("可用端口数不可读 ⇒ hold", () => {
    const decision = decideFailover(
      baseInput({ candidate: candidate(STANDBY, { port_available_count: "3" as unknown as number }) }),
    );
    expect(decision.action).toBe("hold");
    expect(blockerReasons(decision)).toEqual(["standby_port_unavailable"]);
  });

  test("没有候选节点 ⇒ hold（结构前提：迁到哪里）", () => {
    const decision = decideFailover(baseInput({ candidate: null }));
    expect(decision.action).toBe("hold");
    expect(decision.preconditions.standby_candidate).toBe(false);
    // 没有目的地时「它在线吗 / 它有端口吗」没有答案：报 null，而不是把同一个根因写成三条。
    expect(decision.preconditions.standby_online).toBeNull();
    expect(decision.conditions.standby_port_available).toBeNull();
    expect(blockerReasons(decision)).toEqual(["no_standby_candidate"]);
  });

  test("候选节点离线 ⇒ hold（端口可能是空的，但离线节点不能承载）", () => {
    const decision = decideFailover(baseInput({ candidate: candidate(STANDBY, { reachable: false }) }));
    expect(decision.action).toBe("hold");
    expect(blockerReasons(decision)).toEqual(["standby_not_reachable"]);
    // 端口条件本身仍然是成立的：事实要分开看。
    expect(decision.conditions.standby_port_available).toBe(true);
    expect(decision.preconditions.standby_online).toBe(false);
  });

  test("租约 epoch 不可读 ⇒ hold（迁移指令必须是 epoch + 1）", () => {
    const decision = decideFailover(
      baseInput({ placement: { owner_node_id: OWNER, epoch: Number.NaN, preferred_node_id: OWNER } }),
    );
    expect(decision.action).toBe("hold");
    expect(blockerReasons(decision)).toEqual(["placement_epoch_unusable"]);
    expect(decision.preconditions.placement_epoch).toBe(false);
  });
});

describe("条件 5 与条件 6：冷却与策略", () => {
  test("冷却期内 ⇒ hold，并给出还要等多久", () => {
    const decision = decideFailover(
      baseInput({
        cooldown: { last_migration_at: new Date(NOW_MS - 60_000), last_migration_kind: "failover" },
      }),
    );
    expect(decision.action).toBe("hold");
    expect(blockerReasons(decision)).toEqual(["cooldown_active"]);
    expect(decision.cooldown.active).toBe(true);
    expect(decision.cooldown.remaining_ms).toBe(T.MIGRATION_COOLDOWN_MS - 60_000);
    expect(decision.cooldown.last_migration_kind).toBe("failover");
  });

  test("从未迁移过 ⇒ 冷却不适用", () => {
    const decision = decideFailover(baseInput({ cooldown: null }));
    expect(decision.action).toBe("move");
    expect(decision.cooldown).toEqual({
      active: false,
      remaining_ms: null,
      last_migration_at: null,
      last_migration_kind: null,
    });
  });

  test("运维策略不允许自动故障转移 ⇒ hold（六条里最后一条）", () => {
    const decision = decideFailover(baseInput({ policy: { auto_failover: false, auto_failback: true } }));
    expect(decision.action).toBe("hold");
    expect(blockerReasons(decision)).toEqual(["policy_auto_failover_disabled"]);
    expect(decision.conditions.policy_allows).toBe(false);
  });
});

describe("「未满足的条件全部列出」", () => {
  test("只有冷却坏掉时，唯一 blocker 就是冷却那一条", () => {
    const decision = decideFailover(
      baseInput({ cooldown: { last_migration_at: new Date(NOW_MS - 1_000), last_migration_kind: "failover" } }),
    );
    expect(decision.action).toBe("hold");
    expect(decision.blockers).toEqual([
      {
        condition: "cooldown_elapsed",
        reason: "cooldown_active",
        detail: expect.stringContaining("冷却") as unknown as string,
      },
    ]);
    expect(decision.reasons[0]).toBe("cooldown_active");
  });

  test("六条同时不成立时，blockers 覆盖全部六条（顺序与 §8 一致，不是只报第一条）", () => {
    const decision = decideFailover(
      baseInput({
        owner: upOwner({ last_seen_at: new Date(NOW_MS - T.NODE_STALE_AFTER_MS * 10) }), // 条件 1
        // 条件 2（新鲜观测者不够）与条件 3（新鲜证据说目标坏）在**同一份事实**上同时不成立：
        // 唯一一条新鲜证据说目标 unhealthy，但门槛要求 2 条新鲜观测者。
        target_observations: { observers: [observer(OBSERVER, "unhealthy")] },
        thresholds: { MIN_FRESH_OBSERVERS: 2 },
        candidate: candidate(STANDBY, { port_available: false }), // 条件 4
        cooldown: { last_migration_at: new Date(NOW_MS - 1_000), last_migration_kind: "failback" }, // 条件 5
        policy: { auto_failover: false, auto_failback: false }, // 条件 6
      }),
    );
    expect(decision.action).toBe("hold");
    const blockedConditions = blockerConditions(decision).filter((condition) =>
      (FAILOVER_POLICY_CONDITIONS as readonly string[]).includes(condition),
    );
    expect(blockedConditions).toEqual([...FAILOVER_POLICY_CONDITIONS]);
    expect(decision.reasons.slice(0, blockedConditions.length)).toEqual([
      "owner_reachable",
      "observation_insufficient",
      "target_side_failure",
      "standby_port_unavailable",
      "cooldown_active",
      "policy_auto_failover_disabled",
    ]);
  });

  test("条件 2 与条件 3 是同一份证据的两面：没有任何新鲜证据时，条件 3 只能是「没有反证」", () => {
    // 全部观测过期 → 条件 2 不成立（没有证据），条件 3 成立（没有证据说目标坏）。
    const decision = decideFailover(
      baseInput({ target_observations: { observers: [observer(OBSERVER, "unhealthy", true)] } }),
    );
    expect(decision.conditions.observation_fresh).toBe(false);
    expect(decision.conditions.target_not_side_failure).toBe(true);
    expect(blockerReasons(decision)).toContain("observation_all_stale");
    expect(blockerReasons(decision)).not.toContain("target_side_failure");
  });

  test("不变量：每个 blocker 都对应一个 false 的事实条目", () => {
    const decisions: FailoverDecision[] = [
      decideFailover(baseInput()),
      decideFailover(baseInput({ candidate: null, cooldown: { last_migration_at: NOW } })),
      decideFailover(failbackInput()),
      decideFailover(failbackInput({ failback: { candidate: candidate(PREFERRED), healthy_checks: 0 } })),
      decideFailover(baseInput({ owner: upOwner() })),
    ];
    for (const decision of decisions) {
      for (const blocker of decision.blockers) {
        const isCondition = (FAILOVER_CONDITIONS as readonly string[]).includes(blocker.condition);
        const value = isCondition
          ? decision.conditions[blocker.condition as FailoverCondition]
          : decision.preconditions[blocker.condition as PlacementPrecondition];
        expect(value).toBe(false);
      }
    }
  });
});

/* ================================================================== */
/* 头条用例：心跳超时单独不足以迁移                                       */
/* ================================================================== */

describe("heartbeat 超时单独出现不足以迁移", () => {
  test("心跳超时 + 观测新鲜度不可用 ⇒ 原地不动", () => {
    const decision = decideFailover(
      baseInput({ target_observations: { observers: [observer(OBSERVER, "healthy", true)] } }),
    );
    expect(decision.action).not.toBe("move");
    expect(decision.action).toBe("hold");
    expect(decision.migration).toBeNull();
    expect(blockerReasons(decision)).toContain("observation_all_stale");
  });

  test("心跳超时 + 问题在目标侧 ⇒ 原地不动（不搬流量掩盖坏目标）", () => {
    const decision = decideFailover(
      baseInput({ target_observations: { observers: [observer(OBSERVER, "unhealthy")] } }),
    );
    expect(decision.action).not.toBe("move");
    expect(decision.migration).toBeNull();
    expect(blockerReasons(decision)).toContain("target_side_failure");
  });

  test("除目标侧以外六条全成立，仍然不动 —— 这就是「故障转移系统」与「搬流量掩盖故障」的分界", () => {
    const decision = decideFailover(
      baseInput({
        // 其他一切都对：失联超时、观测新鲜、候选在线有端口、冷却已过、策略允许。
        target_observations: { observers: [observer(OBSERVER, "unhealthy")], age_ms: 1_000 },
        candidate: candidate(STANDBY, { port_available_count: 10 }),
      }),
    );
    expect(decision.action).toBe("hold");
    expect(decision.conditions).toEqual({
      owner_unreachable_beyond_stale: true,
      observation_fresh: true,
      target_not_side_failure: false,
      standby_port_available: true,
      cooldown_elapsed: true,
      policy_allows: true,
      failback_healthy_checks: null,
    });
    expect(blockerConditions(decision)).toEqual(["target_not_side_failure"]);
  });

  test("观测全部过期时也不会因为「心跳超时很久」而迁移", () => {
    const decision = decideFailover(
      baseInput({
        owner: { reachable: false, last_seen_at: new Date(NOW_MS - T.NODE_STALE_AFTER_MS * 100) },
        target_observations: { observers: [] },
      }),
    );
    expect(decision.action).toBe("hold");
    expect(blockerReasons(decision)).toEqual(["observation_missing"]);
  });
});

/* ================================================================== */
/* 回切                                                                */
/* ================================================================== */

describe("failback：连续健康 + 冷却，且是一次正常的归属迁移", () => {
  test("条件齐备 ⇒ failback，指令与 failover 同形状（epoch + 1）", () => {
    const decision = decideFailover(failbackInput());
    expect(decision.action).toBe("failback");
    expect(decision.blockers).toEqual([]);
    expect(decision.migration).toEqual({
      forward_id: 7,
      from_node_id: STANDBY,
      to_node_id: PREFERRED,
      expected_epoch: 9,
      next_epoch: 10,
      kind: "failback",
    });
    expect(decision.reasons).toContain("failback_checks_met" as FailoverReason);
  });

  test("回切路径上条件 1 不适用（null），不会被要求 owner 失联", () => {
    const decision = decideFailover(failbackInput());
    expect(decision.conditions.owner_unreachable_beyond_stale).toBeNull();
    expect(blockerConditions(decision)).not.toContain("owner_unreachable_beyond_stale");
  });

  test("连续健康次数：少一次就拦，达到就放行", () => {
    const pending = decideFailover(
      failbackInput({
        failback: { candidate: candidate(PREFERRED), healthy_checks: T.FAILBACK_HEALTHY_CHECKS - 1 },
      }),
    );
    expect(pending.action).toBe("hold");
    expect(blockerReasons(pending)).toEqual(["failback_checks_pending"]);
    expect(pending.conditions.failback_healthy_checks).toBe(false);

    const met = decideFailover(
      failbackInput({
        failback: { candidate: candidate(PREFERRED), healthy_checks: T.FAILBACK_HEALTHY_CHECKS },
      }),
    );
    expect(met.action).toBe("failback");
    expect(met.conditions.failback_healthy_checks).toBe(true);
  });

  test("没有上报回切事实 ⇒ 按「没有回切目的地 + 0 次健康」处理（两条事实都列出来）", () => {
    const decision = decideFailover(failbackInput({ failback: null }));
    expect(decision.action).toBe("hold");
    expect(blockerReasons(decision)).toEqual(["failback_not_configured", "failback_checks_pending"]);
    expect(decision.conditions.failback_healthy_checks).toBe(false); // 0 次 < 要求
    expect(decision.preconditions.standby_candidate).toBe(false);
    expect(decision.conditions.standby_port_available).toBeNull(); // 没有目的地 ⇒ 没有这个事实
  });

  test("冷却期内的回切 ⇒ 拦（与方向无关）", () => {
    const decision = decideFailover(
      failbackInput({ cooldown: { last_migration_at: new Date(NOW_MS - 1_000), last_migration_kind: "failover" } }),
    );
    expect(decision.action).toBe("hold");
    expect(blockerReasons(decision)).toEqual(["cooldown_active"]);
  });

  test("运维策略不允许自动回切 ⇒ 拦", () => {
    const decision = decideFailover(failbackInput({ policy: { auto_failover: true, auto_failback: false } }));
    expect(decision.action).toBe("hold");
    expect(blockerReasons(decision)).toEqual(["policy_auto_failback_disabled"]);
  });

  test("首选节点离线 / 没有端口 ⇒ 拦", () => {
    const offline = decideFailover(
      failbackInput({ failback: { candidate: candidate(PREFERRED, { reachable: false }), healthy_checks: 3 } }),
    );
    expect(blockerReasons(offline)).toEqual(["failback_target_not_reachable"]);

    const noPort = decideFailover(
      failbackInput({ failback: { candidate: candidate(PREFERRED, { port_available: false }), healthy_checks: 3 } }),
    );
    expect(blockerReasons(noPort)).toEqual(["failback_port_unavailable"]);
  });

  test("回切同样要求观测新鲜、目标不坏（不因为方向不同就放宽）", () => {
    const stale = decideFailover(
      failbackInput({ target_observations: { observers: [observer(OBSERVER, "healthy", true)] } }),
    );
    expect(stale.action).toBe("hold");
    expect(blockerReasons(stale)).toContain("observation_all_stale");

    const brokenTarget = decideFailover(
      failbackInput({ target_observations: { observers: [observer(OBSERVER, "unhealthy")] } }),
    );
    expect(brokenTarget.action).toBe("hold");
    expect(blockerReasons(brokenTarget)).toContain("target_side_failure");
  });

  test("回切不使用 failover 候选：换一个备选节点结果不变", () => {
    const a = decideFailover(failbackInput({ candidate: candidate(OTHER_STANDBY) }));
    const b = decideFailover(failbackInput({ candidate: candidate(999), thresholds: null }));
    expect(a.migration).toEqual(b.migration);
  });

  test("已经承载在首选节点上 ⇒ 没有要搬的东西（hold + 说明）", () => {
    const decision = decideFailover(
      baseInput({ owner: upOwner(), placement: { owner_node_id: OWNER, epoch: 4, preferred_node_id: OWNER } }),
    );
    expect(decision.action).toBe("hold");
    expect(decision.migration).toBeNull();
    expect(decision.reasons).toContain("failback_already_preferred" as FailoverReason);
    expect(decision.preconditions.failback_configured).toBe(false);
  });

  test("未配置首选节点 ⇒ 不自动回切（hold，且不把它当成故障原因）", () => {
    const decision = decideFailover(
      baseInput({ owner: upOwner(), placement: { owner_node_id: OWNER, epoch: 4, preferred_node_id: null } }),
    );
    expect(decision.action).toBe("hold");
    expect(decision.preconditions.failback_configured).toBe(false);
    expect(blockerConditions(decision)).toEqual(["owner_unreachable_beyond_stale"]);
  });

  test("move 与 failback 共用一条执行路径（同一段调用代码两种决策都能跑）", () => {
    const applied: string[] = [];
    const apply = (decision: FailoverDecision): void => {
      const migration = placementMigration(decision);
      if (migration) applied.push(`${migration.kind}:${migration.from_node_id}->${migration.to_node_id}@${migration.next_epoch}`);
    };
    apply(decideFailover(baseInput()));
    apply(decideFailover(failbackInput()));
    apply(decideFailover(baseInput({ policy: { auto_failover: false, auto_failback: false } })));
    expect(applied).toEqual([`failover:${OWNER}->${STANDBY}@5`, `failback:${STANDBY}->${PREFERRED}@10`]);
  });

  test("owner 状态含混（不可达但未超 stale）时既不迁移也不回切", () => {
    const decision = decideFailover(
      failbackInput({ owner: { reachable: false, last_seen_at: new Date(NOW_MS - 1_000) } }),
    );
    expect(decision.action).toBe("hold");
    expect(decision.migration).toBeNull();
    expect(blockerReasons(decision)).toEqual(["owner_unreachable_within_stale"]);
  });

  test("回切目标不兼任 failover 候选：owner 失联时模块不会自己去挑目的地", () => {
    // 「谁是对的目的地」是调用方的池策略，不是本模块的职责：owner 失联时只看 candidate，
    // 没有 candidate 就 hold —— 即使首选节点此刻健康可用，模块也不会替调用方改选。
    const decision = decideFailover(
      failbackInput({
        owner: downOwner(),
        candidate: null,
        target_observations: { observers: [observer(OBSERVER, "healthy")] },
      }),
    );
    expect(decision.action).toBe("hold");
    expect(blockerReasons(decision)).toContain("no_standby_candidate");
    expect(decision.migration).toBeNull();
  });
});

/* ================================================================== */
/* 冷却                                                                */
/* ================================================================== */

describe("冷却：同一 Forward 两次迁移不许过近", () => {
  test("恰好走到冷却边界 ⇒ 放行；差 1ms ⇒ 拦", () => {
    const atLine = decideFailover(
      baseInput({ cooldown: { last_migration_at: new Date(NOW_MS - T.MIGRATION_COOLDOWN_MS) } }),
    );
    expect(atLine.action).toBe("move");

    const inside = decideFailover(
      baseInput({ cooldown: { last_migration_at: new Date(NOW_MS - T.MIGRATION_COOLDOWN_MS + 1) } }),
    );
    expect(inside.action).toBe("hold");
    expect(inside.cooldown.remaining_ms).toBe(1);
  });

  test("failover 紧接着 failback：第二次迁移被冷却拦住（不无限抖动）", () => {
    const first = decideFailover(baseInput());
    expect(first.action).toBe("move");

    const second = decideFailover(
      failbackInput({
        now: new Date(NOW_MS + 60_000),
        cooldown: { last_migration_at: NOW, last_migration_kind: "failover" },
      }),
    );
    expect(second.action).toBe("hold");
    expect(blockerReasons(second)).toEqual(["cooldown_active"]);
    expect(second.cooldown.last_migration_kind).toBe("failover");
  });

  test("上一次是 failback 也会拦住 failover（冷却与方向无关）", () => {
    const decision = decideFailover(
      baseInput({ cooldown: { last_migration_at: new Date(NOW_MS - 1_000), last_migration_kind: "failback" } }),
    );
    expect(decision.action).toBe("hold");
    expect(decision.cooldown.last_migration_kind).toBe("failback");
    expect(blockerReasons(decision)).toEqual(["cooldown_active"]);
  });

  test("时钟偏斜（上次迁移时间戳在未来）⇒ 仍然算冷却期内（fail-closed）", () => {
    const decision = decideFailover(
      baseInput({ cooldown: { last_migration_at: new Date(NOW_MS + 60_000) } }),
    );
    expect(decision.action).toBe("hold");
    expect(blockerReasons(decision)).toEqual(["cooldown_active"]);
    expect(decision.cooldown.remaining_ms).toBe(T.MIGRATION_COOLDOWN_MS + 60_000);
  });

  test("冷却阈值可注入", () => {
    const decision = decideFailover(
      baseInput({
        cooldown: { last_migration_at: new Date(NOW_MS - 1_000) },
        thresholds: { MIGRATION_COOLDOWN_MS: 1_000 },
      }),
    );
    expect(decision.action).toBe("move");
  });
});

/* ================================================================== */
/* 纯函数与「不改 desired」                                             */
/* ================================================================== */

describe("纯函数与确定性", () => {
  test("相同输入 + 相同 now ⇒ 相同输出（且不是同一个对象）", () => {
    const input = baseInput();
    const first = decideFailover(input);
    const second = decideFailover(input);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.conditions).not.toBe(second.conditions);
    expect(first.blockers).not.toBe(second.blockers);
  });

  test("输入不被改写（深冻结输入不抛错 + JSON 前后一致）", () => {
    const input = failbackInput();
    const before = JSON.parse(JSON.stringify(input));
    Object.freeze(input.placement);
    Object.freeze(input.owner);
    Object.freeze(input.target_observations);
    Object.freeze(input.target_observations.observers);
    Object.freeze(input.cooldown);
    Object.freeze(input.policy);
    Object.freeze(input.failback);
    Object.freeze(input);

    const decision = decideFailover(input);
    expect(decision.action).toBe("failback");
    expect(JSON.parse(JSON.stringify(input))).toEqual(before);
  });

  test("决策对象是新的：改坏一次结果不影响下一次调用", () => {
    const first = decideFailover(baseInput());
    const stolen = first.conditions as Record<string, boolean | null>;
    stolen.observation_fresh = false;
    const second = decideFailover(baseInput());
    expect(second.conditions.observation_fresh).toBe(true);
  });

  test("阈值注入生效：stale 线调大后同一条心跳事实不再算失联", () => {
    const decision = decideFailover(baseInput({ thresholds: { NODE_STALE_AFTER_MS: T.NODE_STALE_AFTER_MS * 10 } }));
    expect(decision.action).toBe("hold");
    expect(blockerReasons(decision)).toEqual(["owner_unreachable_within_stale"]);
  });

  test("阈值注入生效：回切健康计数要求可调", () => {
    const decision = decideFailover(
      failbackInput({
        failback: { candidate: candidate(PREFERRED), healthy_checks: 1 },
        thresholds: { FAILBACK_HEALTHY_CHECKS: 1 },
      }),
    );
    expect(decision.action).toBe("failback");
  });
});

describe("决策不改写、也不依赖目标列表", () => {
  test("类型级：FailoverInput 里没有 desired_targets / targets 字段", () => {
    type InputKeys = keyof FailoverInput;
    type HasDesiredTargets = "desired_targets" extends InputKeys ? true : false;
    type HasTargets = "targets" extends InputKeys ? true : false;
    const noDesiredTargets: HasDesiredTargets = false;
    const noTargets: HasTargets = false;
    expect(noDesiredTargets).toBe(false);
    expect(noTargets).toBe(false);
  });

  test("运行时：多传一个期望目标列表既不改决策、也不出现在决策里", () => {
    const desiredTargets = [
      { host: "10.0.0.1", port: 443 },
      { host: "10.0.0.2", port: 5432 },
    ];
    const clean = decideFailover(baseInput());
    const withList = decideFailover({ ...baseInput(), desired_targets: desiredTargets } as FailoverInput);
    expect(withList).toEqual(clean);
    const serialised = JSON.stringify(withList);
    expect(serialised).not.toContain("10.0.0.1");
    expect(serialised).not.toContain("10.0.0.2");
  });
});

/* ================================================================== */
/* 阈值集中与纯度（源码守卫）                                            */
/* ================================================================== */

const MODULE_SRC = readFileSync(new URL("../failover-policy.ts", import.meta.url), "utf8");

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

  test("模块只 import 阈值文件与 WP6 的词表，且不自己定义阈值", () => {
    const imports = MODULE_SRC.match(/^import[\s\S]*?;$/gm) ?? [];
    expect(imports.length).toBe(2);
    expect(imports[0]).toContain('from "./target-health.ts"');
    expect(imports[1]).toContain('from "./failover-thresholds.ts"');
    expect(imports[1]).toContain("FAILOVER_THRESHOLDS");
    expect(code).not.toContain("FAILOVER_THRESHOLDS =");
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

  test("模块不读 desired 目标列表（它决定谁承载，不决定指向什么）", () => {
    expect(code).not.toContain("desired_targets");
    expect(code).not.toContain("upstream");
    expect(code).not.toMatch(/\.targets\b/);
  });
});
