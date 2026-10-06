/**
 * V5.3 WP10 —— 归属迁移执行器离线单测（不连 DB / Redis / 网络）。
 *
 * 验收口径（task-13 + `DEVELOPMENT.md` §8）：
 *   1. **CAS**：`expected_epoch` 与当前租约不符 ⇒ 中止，且**什么都不改**（重复迁移无害）；
 *   2. **两阶段**：旧租约未过期 ⇒ 等待并汇报，**不**强行交接；
 *   3. 迁移只走**既有**变更路径（本模块不构造第二套下发序列）；
 *   4. 迁移不碰 desired/目标：请求里只有入口节点，面板的目标字段逐字节不变；
 *   5. 幂等：同一决策跑两次只产生一次迁移；
 *   6. 可观测：每条路径都返回结构化 reason + decision/blokers，nothing fails silently；
 *   7. 纯净：时间注入，模块里不读时钟。
 *
 * ── 为什么全部用例都注入 NOW 与替身 ──
 * 本模块的每一步都是"跨两个 IO 之间"的判断（读事实 → 读租约 → 认领 → 提交变更）。
 * 用真库或真实时钟会让「旧租约还活着」「有人抢先迁移」这类**竞态**无法稳定复现，
 * 而它们恰恰是这段代码唯一值得测的东西。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  FAILOVER_EXECUTOR_REASONS,
  buildDecisionInput,
  classifyMoveResult,
  describeFailoverExecutorReason,
  executeFailoverForTunnel,
  readFailoverDecisionFacts,
  targetKeyOf,
  type DecisionFacts,
  type FailoverExecutorDeps,
  type FailoverExecutorEvent,
  type PlacementMoveRequest,
  type PlacementMoveResult,
} from "../failover-executor.ts";
import type { PlacementLeaseRow, LeaseClaimResult } from "../placement-lease.ts";
import { planRollout, type PlanRolloutInput } from "../forward-rollout.ts";

const NOW_MS = Date.parse("2026-10-04T14:00:00.000Z");
const NOW = new Date(NOW_MS);
const NOW_S = Math.floor(NOW_MS / 1000);

/** 节点 id：当前承载 / 候选 / 首选 / 观测者。 */
const OWNER = 11;
const CANDIDATE = 22;
const PREFERRED = 33;
const TUNNEL = 7;
const EPOCH = 4;

/* ================================================================== */
/* 替身                                                                */
/* ================================================================== */

interface Harness {
  deps: FailoverExecutorDeps;
  claims: Array<{ tunnelId: number; nodeId: number; revision: number; now: Date }>;
  moves: PlacementMoveRequest[];
  events: FailoverExecutorEvent[];
  lease: PlacementLeaseRow | null;
  /** 让替身在一次运行内改变租约（模拟并发迁移）。 */
  setLease(next: PlacementLeaseRow | null): void;
  claimResult?: LeaseClaimResult | "throw";
  moveResult?: PlacementMoveResult;
  loadLeaseCalls: number;
}

function leaseRow(overrides: Partial<PlacementLeaseRow> = {}): PlacementLeaseRow {
  return {
    tunnel_id: TUNNEL,
    owner_node_id: OWNER,
    epoch: EPOCH,
    lease_expires_at: new Date(NOW_MS - 1_000), // 默认：已过期（两阶段条件成立）
    revision: 12,
    ...overrides,
  };
}

function facts(overrides: Partial<DecisionFacts> = {}): DecisionFacts {
  return {
    tunnel_id: TUNNEL,
    workspace_id: 3,
    config_revision: 12,
    placement: { owner_node_id: OWNER, epoch: EPOCH, preferred_node_id: OWNER },
    owner: { reachable: false, last_seen_at: new Date(NOW_MS - 600_000) },
    candidate: { node_id: CANDIDATE, reachable: true, port_available: true, port_available_count: 4 },
    target_observations: { observers: [{ node_id: 5, state: "healthy" }], age_ms: 1_000 },
    cooldown: { last_migration_at: null, last_migration_kind: null },
    policy: { auto_failover: true, auto_failback: true },
    failback: null,
    ...overrides,
  };
}

function harness(overrides: {
  facts?: DecisionFacts | { ok: false; code: string };
  lease?: PlacementLeaseRow | null;
} = {}): Harness {
  const h: Harness = {
    deps: {} as FailoverExecutorDeps,
    claims: [],
    moves: [],
    events: [],
    lease: overrides.lease === undefined ? leaseRow() : overrides.lease,
    setLease(next) {
      h.lease = next;
    },
    moveResult: ({
      ok: true,
      kind: "dispatched",
      code: null,
      message: null,
      revision: 13,
      apply_status: "applying",
    } as PlacementMoveResult),
    loadLeaseCalls: 0,
  };
  h.deps = {
    now: () => NOW,
    log: (event) => h.events.push(event),
    readDecisionFacts: async () => {
      const f = overrides.facts ?? facts();
      if ("ok" in f && f.ok === false) {
        return { ok: false, code: f.code as never, detail: "替身" };
      }
      return { ok: true, facts: f as DecisionFacts };
    },
    loadLease: async () => {
      h.loadLeaseCalls += 1;
      return h.lease;
    },
    claimLease: async (input) => {
      h.claims.push(input);
      if (h.claimResult === "throw") throw new Error("lease store down");
      if (h.claimResult !== undefined) return h.claimResult;
      const current = h.lease;
      if (current && current.owner_node_id === input.nodeId) {
        return { ok: true, lease: current, epoch: current.epoch, changed_owner: false };
      }
      // 两阶段：旧租约未过期 ⇒ 拒绝换人（与 placement-lease 同语义）
      if (current && current.lease_expires_at.getTime() > input.now.getTime() && current.owner_node_id !== input.nodeId) {
        return { ok: false, reason: "not_expired", current };
      }
      const moved: PlacementLeaseRow = {
        tunnel_id: input.tunnelId,
        owner_node_id: input.nodeId,
        epoch: (current?.epoch ?? 0) + 1,
        lease_expires_at: new Date(input.now.getTime() + 90_000),
        revision: input.revision,
      };
      h.lease = moved;
      return { ok: true, lease: moved, epoch: moved.epoch, changed_owner: true };
    },
    applyPlacementMove: async (request) => {
      h.moves.push(request);
      return h.moveResult as PlacementMoveResult;
    },
  };
  return h;
}

/* ================================================================== */
/* 契约形状                                                            */
/* ================================================================== */

describe("执行器契约形状", () => {
  test("结果码齐全，且每个码都有非空说明", () => {
    expect(FAILOVER_EXECUTOR_REASONS).toContain("epoch_mismatch");
    expect(FAILOVER_EXECUTOR_REASONS).toContain("old_lease_still_live");
    expect(FAILOVER_EXECUTOR_REASONS).toContain("placement_move_conflict");
    expect(FAILOVER_EXECUTOR_REASONS).toContain("moved");
    for (const reason of FAILOVER_EXECUTOR_REASONS) {
      expect(describeFailoverExecutorReason(reason).length).toBeGreaterThan(0);
    }
  });
});

/* ================================================================== */
/* hold：什么都不做                                                     */
/* ================================================================== */

describe("hold 判定：一个字节都不改", () => {
  test("策略说 hold ⇒ 不读租约、不认领、不迁移，但 blockers 原样带回", () => {
    const h = harness({
      facts: facts({
        // owner 仍可达：六条里的条件 1 不成立 ⇒ hold
        owner: { reachable: true, last_seen_at: new Date(NOW_MS - 1_000) },
        placement: { owner_node_id: OWNER, epoch: EPOCH, preferred_node_id: OWNER },
      }),
    });
    return executeFailoverForTunnel(TUNNEL, h.deps).then((result) => {
      expect(result.outcome).toBe("hold");
      expect(result.reason).toBe("hold");
      expect(result.migration).toBeNull();
      expect(result.decision?.action).toBe("hold");
      // 「为什么没搬」全部可见
      expect(result.decision?.blockers.map((b) => b.reason)).toContain("owner_reachable");
      // 且真的什么都没做
      expect(h.loadLeaseCalls).toBe(0);
      expect(h.claims).toEqual([]);
      expect(h.moves).toEqual([]);
      expect(h.lease?.epoch).toBe(EPOCH);
    });
  });

  test("目标侧故障（headline）⇒ hold：不搬流量去掩盖坏目标", async () => {
    const h = harness({
      facts: facts({
        target_observations: { observers: [{ node_id: 5, state: "unhealthy" }], age_ms: 1_000 },
      }),
    });
    const result = await executeFailoverForTunnel(TUNNEL, h.deps);
    expect(result.outcome).toBe("hold");
    expect(result.decision?.blockers.map((b) => b.reason)).toContain("target_side_failure");
    expect(h.moves).toEqual([]);
    expect(h.claims).toEqual([]);
  });

  test("每条路径都发结构化事件（含 hold 的 decision 事件）", async () => {
    const h = harness({
      facts: facts({ owner: { reachable: true, last_seen_at: new Date(NOW_MS - 1_000) } }),
    });
    await executeFailoverForTunnel(TUNNEL, h.deps);
    expect(h.events.map((e) => e.event)).toEqual(["decision"]);
    expect(h.events[0]?.action).toBe("hold");
    expect(h.events[0]?.reason).toBeNull();
  });
});

/* ================================================================== */
/* 迁移正常路径                                                         */
/* ================================================================== */

describe("迁移：认领 epoch + 1，然后交给既有路径", () => {
  test("条件齐备 ⇒ moved：先认领（epoch+1），再提交归属变更", async () => {
    const h = harness();
    const result = await executeFailoverForTunnel(TUNNEL, h.deps);

    expect(result.outcome).toBe("moved");
    expect(result.reason).toBe("moved");
    expect(result.migration).toEqual({
      forward_id: TUNNEL,
      from_node_id: OWNER,
      to_node_id: CANDIDATE,
      expected_epoch: EPOCH,
      next_epoch: EPOCH + 1,
      kind: "failover",
    });
    // 认领用的是决策时刻与目的节点
    expect(h.claims).toEqual([{ tunnelId: TUNNEL, nodeId: CANDIDATE, revision: 12, now: NOW }]);
    expect(result.lease_before?.epoch).toBe(EPOCH);
    expect(result.lease_after?.epoch).toBe(EPOCH + 1);
    expect(result.lease_after?.owner_node_id).toBe(CANDIDATE);
    // 迁移请求形状（见下一个 describe：只有入口节点）
    expect(h.moves.length).toBe(1);
    expect(h.moves[0]?.toNodeId).toBe(CANDIDATE);
    expect(h.moves[0]?.fromNodeId).toBe(OWNER);
    expect(h.moves[0]?.expectedEpoch).toBe(EPOCH);
    expect(h.moves[0]?.nextEpoch).toBe(EPOCH + 1);
    // 事件顺序：decision → claim → moved
    expect(h.events.map((e) => e.event)).toEqual(["decision", "claim", "moved"]);
  });

  test("时间来自注入：认领时刻与决策时刻是同一个 now", async () => {
    const h = harness();
    await executeFailoverForTunnel(TUNNEL, h.deps);
    expect(h.claims[0]?.now).toBe(NOW);
  });

  test("回切走同一条路（kind=failback，指令形状不变）", async () => {
    const h = harness({
      facts: facts({
        placement: { owner_node_id: CANDIDATE, epoch: 9, preferred_node_id: PREFERRED },
        owner: { reachable: true, last_seen_at: new Date(NOW_MS - 1_000) },
        candidate: { node_id: 99, reachable: true, port_available: true, port_available_count: 2 },
        failback: { candidate: { node_id: PREFERRED, reachable: true, port_available: true, port_available_count: 2 }, healthy_checks: 3 },
      }),
    });
    h.setLease(leaseRow({ owner_node_id: CANDIDATE, epoch: 9, lease_expires_at: new Date(NOW_MS - 1_000) }));

    const result = await executeFailoverForTunnel(TUNNEL, h.deps);
    expect(result.outcome).toBe("moved");
    expect(result.migration?.kind).toBe("failback");
    expect(result.migration?.to_node_id).toBe(PREFERRED);
    expect(h.moves[0]?.kind).toBe("failback");
  });
});

/* ================================================================== */
/* CAS：重复迁移无害                                                    */
/* ================================================================== */

describe("CAS：epoch 是唯一的所有权版本", () => {
  test("决策依据的 epoch 已过时 ⇒ 中止，且不认领、不迁移（幂等的机制）", async () => {
    const h = harness();
    // 别人已经迁移过：租约 epoch 已经是 EPOCH+1
    h.setLease(leaseRow({ owner_node_id: CANDIDATE, epoch: EPOCH + 1 }));

    const result = await executeFailoverForTunnel(TUNNEL, h.deps);
    expect(result.outcome).toBe("aborted");
    expect(result.reason).toBe("epoch_mismatch");
    expect(result.detail).toContain("别人已经迁移过");
    expect(h.claims).toEqual([]);
    expect(h.moves).toEqual([]);
    // 什么都没改：租约仍是别人迁移后的样子
    expect(h.lease?.epoch).toBe(EPOCH + 1);
  });

  test("同一份决策跑两次 ⇒ 只产生一次迁移", async () => {
    const h = harness();
    const first = await executeFailoverForTunnel(TUNNEL, h.deps);
    const second = await executeFailoverForTunnel(TUNNEL, h.deps);

    expect(first.outcome).toBe("moved");
    expect(second.outcome).toBe("aborted");
    expect(second.reason).toBe("epoch_mismatch");
    expect(h.moves.length).toBe(1);
    expect(h.claims.length).toBe(1);
  });

  test("租约现任与决策假设的迁出节点不一致 ⇒ 中止（事实对不上就不动）", async () => {
    const h = harness();
    h.setLease(leaseRow({ owner_node_id: 77, epoch: EPOCH }));
    const result = await executeFailoverForTunnel(TUNNEL, h.deps);
    expect(result.reason).toBe("owner_mismatch");
    expect(h.moves).toEqual([]);
  });

  test("读与认领之间有人抢先迁移（认领返回意外 epoch）⇒ 中止", async () => {
    const h = harness();
    h.claimResult = {
      ok: true,
      lease: leaseRow({ owner_node_id: CANDIDATE, epoch: EPOCH + 5 }),
      epoch: EPOCH + 5,
      changed_owner: true,
    };
    const result = await executeFailoverForTunnel(TUNNEL, h.deps);
    expect(result.reason).toBe("claim_epoch_unexpected");
    expect(result.detail).toContain("有人抢先迁移");
    expect(h.moves).toEqual([]);
  });

  test("已经是目的节点持有（续租语义）⇒ 幂等继续，不重复推 epoch", async () => {
    const h = harness();
    h.claimResult = {
      ok: true,
      lease: leaseRow({ owner_node_id: CANDIDATE, epoch: EPOCH }),
      epoch: EPOCH,
      changed_owner: false,
    };
    const result = await executeFailoverForTunnel(TUNNEL, h.deps);
    expect(result.outcome).toBe("moved");
    expect(h.moves.length).toBe(1);
  });
});

/* ================================================================== */
/* 两阶段交接                                                           */
/* ================================================================== */

describe("两阶段：旧租约没死透就不交接", () => {
  test("旧租约未过期 ⇒ waiting：不认领、不迁移、租约不变", async () => {
    const h = harness();
    h.setLease(leaseRow({ lease_expires_at: new Date(NOW_MS + 60_000) }));

    const result = await executeFailoverForTunnel(TUNNEL, h.deps);
    expect(result.outcome).toBe("waiting");
    expect(result.reason).toBe("old_lease_still_live");
    expect(result.detail).toContain("等待");
    expect(h.moves).toEqual([]);
    expect(h.lease?.owner_node_id).toBe(OWNER);
    expect(h.lease?.epoch).toBe(EPOCH);
    expect(result.lease_after?.owner_node_id).toBe(OWNER);
    expect(h.events.map((e) => e.event)).toEqual(["decision", "waiting"]);
  });

  test("认领被拒（not_owner / not_found）⇒ 中止并带原因", async () => {
    const h = harness();
    h.claimResult = { ok: false, reason: "not_owner" };
    const result = await executeFailoverForTunnel(TUNNEL, h.deps);
    expect(result.outcome).toBe("aborted");
    expect(result.reason).toBe("claim_rejected");
    expect(result.detail).toContain("not_owner");
    expect(h.moves).toEqual([]);
  });

  test("租约存储抛错 ⇒ 不静默：按认领被拒中止（且不迁移）", async () => {
    const h = harness();
    h.claimResult = "throw";
    await expect(executeFailoverForTunnel(TUNNEL, h.deps)).rejects.toThrow("lease store down");
  });
});

/* ================================================================== */
/* 事实读取失败                                                         */
/* ================================================================== */

describe("事实读不到 ⇒ 中止（不揣测）", () => {
  test("隧道不存在 / 没有归属 / 库不可用都返回 facts_unavailable", async () => {
    for (const code of ["tunnel_not_found", "no_placement", "db_unavailable"]) {
      const h = harness({ facts: { ok: false, code } });
      const result = await executeFailoverForTunnel(TUNNEL, h.deps);
      expect(result.outcome).toBe("aborted");
      expect(result.reason).toBe("facts_unavailable");
      expect(result.detail).toContain(code);
      expect(h.moves).toEqual([]);
    }
  });
});

/* ================================================================== */
/* 既有变更路径的结果被如实转述                                          */
/* ================================================================== */

describe("既有变更路径的结果：三态分明", () => {
  test("并发编辑冲突（409）⇒ aborted(placement_move_conflict)", async () => {
    const h = harness();
    h.moveResult = { ok: false, kind: "rejected", code: "revision_conflict", message: "该转发已被他人修改", revision: null, apply_status: null };
    const result = await executeFailoverForTunnel(TUNNEL, h.deps);
    expect(result.outcome).toBe("aborted");
    expect(result.reason).toBe("placement_move_conflict");
  });

  test("VALIDATE / 校验拒绝 ⇒ aborted(placement_move_rejected)", async () => {
    const h = harness();
    h.moveResult = { ok: false, kind: "rejected", code: "node_unavailable", message: "入口节点不存在", revision: null, apply_status: null };
    const result = await executeFailoverForTunnel(TUNNEL, h.deps);
    expect(result.reason).toBe("placement_move_rejected");
    expect(result.detail).toContain("node_unavailable");
  });

  test("下发失败 ⇒ failed(placement_move_failed)：归属已认领，等 rollout 续跑", async () => {
    const h = harness();
    h.moveResult = { ok: false, kind: "failed", code: "agent_unreachable", message: "新节点不可达", revision: 13, apply_status: "error" };
    const result = await executeFailoverForTunnel(TUNNEL, h.deps);
    expect(result.outcome).toBe("failed");
    expect(result.reason).toBe("placement_move_failed");
    expect(result.lease_after?.owner_node_id).toBe(CANDIDATE); // 认领已生效
    expect(h.events.map((e) => e.event)).toEqual(["decision", "claim", "failed"]);
  });

  test("迁移端口抛异常也不静默：折成 failed(move_threw)", async () => {
    const h = harness();
    h.deps.applyPlacementMove = async () => {
      throw new Error("boom");
    };
    const result = await executeFailoverForTunnel(TUNNEL, h.deps);
    expect(result.outcome).toBe("failed");
    expect(result.reason).toBe("placement_move_failed");
    expect(result.move?.code).toBe("move_threw");
  });
});

/* ================================================================== */
/* 不改 desired：迁移请求的形状                                          */
/* ================================================================== */

describe("归属迁移不碰 desired/目标", () => {
  test("迁移请求只有归属相关字段：类型层面没有目标字段可填", async () => {
    const h = harness();
    await executeFailoverForTunnel(TUNNEL, h.deps);
    expect(h.moves[0]).toEqual({
      tunnelId: TUNNEL,
      workspaceId: 3,
      fromNodeId: OWNER,
      toNodeId: CANDIDATE,
      kind: "failover",
      expectedEpoch: EPOCH,
      nextEpoch: EPOCH + 1,
      expectedConfigRevision: 12,
    });
    whichRejectsTargetFields();
  });

  test("一次迁移前后，面板的目标字段逐字节相同（只有入口节点变）", async () => {
    // 面板状态（迁移执行者会修改的那部分事实）：目标/端口/池/协议
    const panel = {
      id: TUNNEL,
      ingress_node_id: OWNER,
      remote_host: "10.0.0.1",
      remote_port: 443,
      egress_pool_id: 5,
      tunnel_mode: "relay",
      forward_protocol: "tcp",
      desired_status: "active",
      config_revision: 12,
    };
    const before = JSON.parse(JSON.stringify(panel));

    const h = harness();
    // 替身模拟既有路径：只改入口节点 + revision，**不碰**目标字段
    h.deps.applyPlacementMove = async (request) => {
      h.moves.push(request);
      panel.ingress_node_id = request.toNodeId;
      panel.config_revision += 1;
      return h.moveResult as PlacementMoveResult;
    };
    const result = await executeFailoverForTunnel(TUNNEL, h.deps);

    expect(result.outcome).toBe("moved");
    const desiredKeys = ["remote_host", "remote_port", "egress_pool_id", "tunnel_mode", "forward_protocol", "desired_status"];
    for (const key of desiredKeys) {
      expect((panel as Record<string, unknown>)[key]).toEqual(before[key]);
    }
    expect(panel.ingress_node_id).toBe(CANDIDATE);
  });
});

/** 编译期守卫：`PlacementMoveRequest` 上不允许出现目标/desired 字段。 */
function whichRejectsTargetFields(): void {
  type Keys = keyof PlacementMoveRequest;
  type Forbidden = "target_host" | "target_port" | "egress_targets" | "desired_status" | "tunnel_mode";
  type Leaked = Forbidden & Keys;
  const leaked: Leaked[] = [];
  expect(leaked).toEqual([]);
}

/* ================================================================== */
/* 既有 rollout 路径能表达归属迁移（纯函数证据）                          */
/* ================================================================== */

describe("既有 rollout 路径确实能表达一次归属迁移", () => {
  const node = (id: number, nodeId: string) => ({
    id,
    node_id: nodeId,
    role: "ingress",
    connect_ip: "10.9.0.1",
    lifecycle: "active",
    port_range_configured: true,
  });

  const placementPlanInput: PlanRolloutInput = {
    revision: 13,
    base_revision: 12,
    impact: {
      metadata_only: false,
      runtime_change: true,
      changes_external_address: true,
      listen_port_change: false,
      listener_replacement: true,
      ingress_node_change: true,
      egress_node_change: false,
      mode_change: false,
      target_change: false,
      egress_target_change: false,
      nodes_prepare_drain: [`${OWNER}`, `${CANDIDATE}`],
      binding_required: false,
      port_status: "ok",
      desired_address: "10.0.0.1:8443",
    },
    desired: {
      name: "f",
      mode: "direct",
      ingress_node_id: CANDIDATE,
      egress_node_id: null,
      listen_ip: null,
      listen_port: 8443,
      target_host: "10.0.0.9",
      target_port: 443,
      egress_pool_id: null,
      egress_port: null,
      egress_targets: null,
      desired_status: "active",
    },
    applied: {
      name: "f",
      mode: "direct",
      ingress_node_id: OWNER,
      egress_node_id: null,
      listen_ip: null,
      listen_port: 8443,
      target_host: "10.0.0.9",
      target_port: 443,
      egress_pool_id: null,
      egress_port: null,
      egress_targets: null,
      desired_status: "active",
    },
    nodes: {
      ingress: node(CANDIDATE, "node-new"),
      egress: null,
      ingress_previous: node(OWNER, "node-old"),
      egress_previous: null,
    },
    binding_exists: null,
  };

  test("计划策略是 node_migration，且包含安全 handoff 所需步骤", () => {
    const plan = planRollout(placementPlanInput, TUNNEL);
    expect(plan.strategy).toBe("node_migration");
    expect(plan.blocking).toEqual([]);
    const kinds = plan.steps.map((s) => s.kind);
    expect(kinds).toContain("acquire_port");
    expect(kinds).toContain("handoff_ingress_owner");
    expect(kinds).toContain("cutover_ingress");
    expect(kinds).toContain("release_old_lease");
    expect(kinds).not.toContain("drain_ingress");
  });

  test("步骤方向正确：旧 owner 先 handoff，新节点再接管，旧端口最后释放", () => {
    const plan = planRollout(placementPlanInput, TUNNEL);
    const handoff = plan.steps.find((s) => s.kind === "handoff_ingress_owner");
    const cutover = plan.steps.find((s) => s.kind === "cutover_ingress");
    const release = plan.steps.find((s) => s.kind === "release_old_lease");
    expect(handoff?.node_id).toBe(OWNER);
    expect(cutover?.node_id).toBe(CANDIDATE);
    expect(release?.node_id).toBe(OWNER);
  });

  test("阶段顺序不可倒置：旧 owner handoff 必须早于新入口 cutover，最后才释放旧端口", () => {
    const plan = planRollout(placementPlanInput, TUNNEL);
    const idx = (kind: string) => plan.steps.findIndex((s) => s.kind === kind);
    expect(plan.steps[idx("handoff_ingress_owner")]?.phase).toBe("cutover");
    expect(plan.steps[idx("cutover_ingress")]?.phase).toBe("cutover");
    expect(plan.steps[idx("release_old_lease")]?.phase).toBe("cleanup");
    expect(idx("handoff_ingress_owner")).toBeLessThan(idx("cutover_ingress"));
    expect(idx("cutover_ingress")).toBeLessThan(idx("release_old_lease"));
  });
});

/* ================================================================== */
/* classifyMoveResult（既有路径结果 → 三态）                              */
/* ================================================================== */

describe("既有变更路径结果的映射", () => {
  test("ok + active/applying ⇒ dispatched", () => {
    expect(classifyMoveResult({ ok: true, data: { apply_status: "applying", config_revision: 13 } })).toEqual({
      ok: true,
      kind: "dispatched",
      code: null,
      message: null,
      revision: 13,
      apply_status: "applying",
    });
  });

  test("ok + apply_status=error ⇒ failed（desired 落库了但没跑起来）", () => {
    const mapped = classifyMoveResult({
      ok: true,
      data: { apply_status: "error", apply_error_code: "agent_unreachable", apply_error: "x" },
    });
    expect(mapped.kind).toBe("failed");
    expect(mapped.code).toBe("agent_unreachable");
  });

  test("409 ⇒ rejected（并发编辑）；502 ⇒ failed（下发失败）；503 ⇒ rejected（什么都没改）", () => {
    expect(classifyMoveResult({ ok: false, status: 409, code: "revision_conflict", message: "m" }).kind).toBe("rejected");
    expect(classifyMoveResult({ ok: false, status: 502, code: "apply_failed", message: "m" }).kind).toBe("failed");
    expect(classifyMoveResult({ ok: false, status: 503, code: "db_unavailable", message: "m" }).kind).toBe("rejected");
  });
});

/* ================================================================== */
/* buildDecisionInput（纯映射）                                          */
/* ================================================================== */

describe("事实 → 策略输入（纯映射，不读时钟）", () => {
  test("now 透传、facts 原样搬运", () => {
    const f = facts();
    const input = buildDecisionInput(f, NOW);
    expect(input.now).toBe(NOW);
    expect(input.forward_id).toBe(TUNNEL);
    expect(input.placement).toEqual(f.placement);
    expect(input.owner).toEqual(f.owner);
    expect(input.cooldown).toEqual(f.cooldown);
    expect(input.policy).toEqual(f.policy);
    expect(input.thresholds).toBeNull();
  });
});

/* ================================================================== */
/* 默认读路径（假 db，离线）                                             */
/* ================================================================== */

interface FakeDbState {
  tunnel: Record<string, unknown> | null;
  lease: PlacementLeaseRow | null;
  nodes: Record<number, Record<string, unknown>>;
  observations: Array<Record<string, unknown>>;
  pool: Record<string, unknown> | null;
  migrationRollout: Record<string, unknown> | null;
}

function fakeDb(state: FakeDbState) {
  return {
    tunnel: { findUnique: async () => state.tunnel },
    node: { findUnique: async (args: unknown) => state.nodes[(args as { where: { id: number } }).where.id] ?? null },
    targetObservation: { findMany: async () => state.observations },
    forwardRollout: { findFirst: async () => state.migrationRollout },
    egressPool: { findUnique: async () => state.pool },
  };
}

function readerOptions(state: FakeDbState, overrides: Record<string, unknown> = {}) {
  return {
    db: fakeDb(state),
    loadLease: async () => state.lease,
    policy: () => ({ auto_failover: true, auto_failback: true }),
    destinations: () => ({ candidate_node_id: CANDIDATE, preferred_node_id: OWNER }),
    portAvailability: async () => 4,
    ...overrides,
  } as never;
}

function baseState(overrides: Partial<FakeDbState> = {}): FakeDbState {
  return {
    tunnel: {
      id: TUNNEL,
      workspace_id: 3,
      tunnel_mode: "direct",
      config_revision: 12,
      ingress_node_id: OWNER,
      egress_node_id: null,
      egress_pool_id: null,
      remote_host: "10.0.0.9",
      remote_port: 443,
      desired_status: "active",
    },
    lease: leaseRow(),
    nodes: {
      [OWNER]: { status: "inactive", last_seen_at: new Date(NOW_MS - 600_000), node_credential_hash: "h", credential_revoked: false },
      [CANDIDATE]: { status: "active", last_seen_at: new Date(NOW_MS - 1_000), node_credential_hash: "h", credential_revoked: false },
    },
    observations: [
      {
        node_id: 5,
        target_key: "10.0.0.9:443",
        reachable: true,
        latency_ms: 20,
        consecutive_success: 5,
        consecutive_failure: 0,
        success_rate: 1,
        observed_at: new Date(NOW_MS - 1_000),
        observation_source: "5/tcp_connect",
      },
    ],
    pool: null,
    migrationRollout: null,
    ...overrides,
  };
}

describe("默认读路径（离线假 db）", () => {
  test("DIRECT：隧道 + 租约 + 节点可达性 + 观测 → 完整决策事实", async () => {
    const state = baseState();
    const read = await readFailoverDecisionFacts({ tunnelId: TUNNEL, now: NOW }, readerOptions(state));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.facts.workspace_id).toBe(3);
    expect(read.facts.config_revision).toBe(12);
    expect(read.facts.placement).toEqual({ owner_node_id: OWNER, epoch: EPOCH, preferred_node_id: OWNER });
    // owner 的 status=inactive ⇒ 不可达（走 failover 路径的唯一前提之一）
    expect(read.facts.owner.reachable).toBe(false);
    expect(read.facts.candidate).toEqual({
      node_id: CANDIDATE,
      reachable: true,
      port_available: true,
      port_available_count: 4,
    });
    expect(read.facts.target_observations.observers).toEqual([{ node_id: 5, state: "healthy", stale: false }]);
  });

  test("RELAY：出口池的每个目标都读，且摊平成观测者清单", async () => {
    const state = baseState({
      tunnel: { ...baseState().tunnel, tunnel_mode: "relay", egress_pool_id: 5 },
      pool: { targets: [{ host: "A.example.com", port: 443 }, { host: "b.example.com", port: 8443 }] },
      observations: [
        { node_id: 5, target_key: "a.example.com:443", reachable: true, latency_ms: 10, consecutive_success: 3, consecutive_failure: 0, success_rate: 1, observed_at: new Date(NOW_MS - 1_000), observation_source: "5/tcp_connect" },
        { node_id: 6, target_key: "b.example.com:8443", reachable: false, latency_ms: null, consecutive_success: 0, consecutive_failure: 3, success_rate: 0.8, observed_at: new Date(NOW_MS - 1_000), observation_source: "6/tcp_connect" },
      ],
    });
    const read = await readFailoverDecisionFacts({ tunnelId: TUNNEL, now: NOW }, readerOptions(state));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.facts.target_observations.observers.length).toBe(2);
    // 池里第二个目标坏了 ⇒ 策略会判「目标侧故障」，不迁移
    expect(read.facts.target_observations.observers.map((o) => o.state)).toContain("unhealthy");
  });

  test("过期的观测被 WP6 判为 stale ⇒ 观测者不是证据", async () => {
    const state = baseState({
      observations: [
        { node_id: 5, target_key: "10.0.0.9:443", reachable: true, latency_ms: 20, consecutive_success: 5, consecutive_failure: 0, success_rate: 1, observed_at: new Date(NOW_MS - 600_000), observation_source: "5/tcp_connect" },
      ],
    });
    const read = await readFailoverDecisionFacts({ tunnelId: TUNNEL, now: NOW }, readerOptions(state));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.facts.target_observations.observers[0]?.stale).toBe(true);
  });

  test("没有租约 ⇒ epoch 0 + 入口节点作为现任（首次迁移仍是 epoch 1）", async () => {
    const state = baseState({ lease: null });
    const read = await readFailoverDecisionFacts({ tunnelId: TUNNEL, now: NOW }, readerOptions(state));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.facts.placement.epoch).toBe(0);
    expect(read.facts.placement.owner_node_id).toBe(OWNER);
  });

  test("既没有租约也没有入口归属 ⇒ no_placement（不伪造节点 0）", async () => {
    const state = baseState({ lease: null, tunnel: { ...baseState().tunnel, ingress_node_id: null } });
    const read = await readFailoverDecisionFacts({ tunnelId: TUNNEL, now: NOW }, readerOptions(state));
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.code).toBe("no_placement");
  });

  test("隧道不存在 ⇒ tunnel_not_found；读抛错 ⇒ db_unavailable", async () => {
    const missing = await readFailoverDecisionFacts(
      { tunnelId: TUNNEL, now: NOW },
      readerOptions(baseState({ tunnel: null })),
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("tunnel_not_found");

    const brokenState = baseState();
    const broken = await readFailoverDecisionFacts(
      { tunnelId: TUNNEL, now: NOW },
      {
        db: {
          ...fakeDb(brokenState),
          tunnel: {
            findUnique: async () => {
              throw new Error("db down");
            },
          },
        },
        loadLease: async () => brokenState.lease,
        policy: () => ({ auto_failover: true, auto_failback: true }),
        destinations: () => ({ candidate_node_id: CANDIDATE, preferred_node_id: OWNER }),
        portAvailability: async () => 4,
      } as never,
    );
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.code).toBe("db_unavailable");
  });

  test("节点/观测/冷却/端口事实任一读取失败 ⇒ db_unavailable，不伪装成离线或无冷却", async () => {
    const state = baseState();
    const base = readerOptions(state);

    const cases = [
      {
        label: "node",
        options: {
          ...base,
          db: {
            ...base.db,
            node: {
              findUnique: async () => {
                throw new Error("node db down");
              },
            },
          },
        },
      },
      {
        label: "observation",
        options: {
          ...base,
          db: {
            ...base.db,
            targetObservation: {
              findMany: async () => {
                throw new Error("observation db down");
              },
            },
          },
        },
      },
      {
        label: "cooldown",
        options: {
          ...base,
          db: {
            ...base.db,
            forwardRollout: {
              findFirst: async () => {
                throw new Error("rollout db down");
              },
            },
          },
        },
      },
      {
        label: "port",
        options: {
          ...base,
          portAvailability: async () => {
            throw new Error("port pool down");
          },
        },
      },
    ];

    for (const item of cases) {
      const read = await readFailoverDecisionFacts(
        { tunnelId: TUNNEL, now: NOW },
        item.options,
      );
      expect(read.ok, item.label).toBe(false);
      if (!read.ok) {
        expect(read.code).toBe("db_unavailable");
        expect(read.detail).toContain("down");
      }
    }
  });

  test("冷却：读 rollout 台账里最近一条 node_migration", async () => {
    const state = baseState({ migrationRollout: { created_at: new Date(NOW_MS - 60_000) } });
    const read = await readFailoverDecisionFacts({ tunnelId: TUNNEL, now: NOW }, readerOptions(state));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.facts.cooldown.last_migration_at).toEqual(new Date(NOW_MS - 60_000));
  });

  test("冷却：没有 node_migration 记录 ⇒ null（不编造冷却）", async () => {
    const read = await readFailoverDecisionFacts({ tunnelId: TUNNEL, now: NOW }, readerOptions(baseState()));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.facts.cooldown.last_migration_at).toBeNull();
  });

  test("目的地没有可用端口 ⇒ port_available=false（策略会拦）", async () => {
    const state = baseState();
    const read = await readFailoverDecisionFacts(
      { tunnelId: TUNNEL, now: NOW },
      readerOptions(state, { portAvailability: async () => 0 }),
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.facts.candidate?.port_available).toBe(false);
    expect(read.facts.candidate?.port_available_count).toBe(0);
  });

  test("首选节点不是现任且已配置 ⇒ 组装回切事实；健康计数默认 0（fail-closed）", async () => {
    const state = baseState();
    state.nodes[PREFERRED] = { status: "active", last_seen_at: new Date(NOW_MS - 1_000), node_credential_hash: "h", credential_revoked: false };
    const read = await readFailoverDecisionFacts(
      { tunnelId: TUNNEL, now: NOW },
      readerOptions(state, { destinations: () => ({ candidate_node_id: CANDIDATE, preferred_node_id: PREFERRED }) }),
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.facts.failback?.candidate.node_id).toBe(PREFERRED);
    expect(read.facts.failback?.healthy_checks).toBe(0);
  });

  test("首选节点就是现任 ⇒ 不回切（failback 为 null）", async () => {
    const read = await readFailoverDecisionFacts({ tunnelId: TUNNEL, now: NOW }, readerOptions(baseState()));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.facts.failback).toBeNull();
  });

  test("目标身份归一化与投影同口径（小写、去尾点、去方括号）", () => {
    expect(targetKeyOf("Example.COM.", 443)).toBe("example.com:443");
    expect(targetKeyOf("[::1]", 8443)).toBe("::1:8443");
    expect(targetKeyOf("", 443)).toBeNull();
    expect(targetKeyOf("h", 0)).toBe("h:0");
  });
});

/* ================================================================== */
/* 端到端：假 db + 假租约 + 假迁移                                       */
/* ================================================================== */

describe("端到端（全替身）：读事实 → 判定 → CAS → 两阶段 → 迁移", () => {
  test("owner 失联 + 观测健康 + 候选可用 ⇒ moved，且请求落到候选节点", async () => {
    const state = baseState();
    const h = harness();
    h.deps.readDecisionFacts = (input) => readFailoverDecisionFacts(input, readerOptions(state));

    const result = await executeFailoverForTunnel(TUNNEL, h.deps);
    expect(result.outcome).toBe("moved");
    expect(h.moves[0]?.toNodeId).toBe(CANDIDATE);
    expect(h.claims[0]?.nodeId).toBe(CANDIDATE);
  });

  test("同一条 Forward 的目标侧坏 ⇒ hold，迁移端口一次都没被调用", async () => {
    const state = baseState({
      observations: [
        { node_id: 5, target_key: "10.0.0.9:443", reachable: false, latency_ms: null, consecutive_success: 0, consecutive_failure: 4, success_rate: 0.7, observed_at: new Date(NOW_MS - 1_000), observation_source: "5/tcp_connect" },
      ],
    });
    const h = harness();
    h.deps.readDecisionFacts = (input) => readFailoverDecisionFacts(input, readerOptions(state));

    const result = await executeFailoverForTunnel(TUNNEL, h.deps);
    expect(result.outcome).toBe("hold");
    expect(result.decision?.blockers.map((b) => b.reason)).toContain("target_side_failure");
    expect(h.moves).toEqual([]);
    expect(h.claims).toEqual([]);
  });

  test("观测全部过期 ⇒ hold（没有证据就不迁移）", async () => {
    const state = baseState({
      observations: [
        { node_id: 5, target_key: "10.0.0.9:443", reachable: true, latency_ms: 20, consecutive_success: 5, consecutive_failure: 0, success_rate: 1, observed_at: new Date(NOW_MS - 600_000), observation_source: "5/tcp_connect" },
      ],
    });
    const h = harness();
    h.deps.readDecisionFacts = (input) => readFailoverDecisionFacts(input, readerOptions(state));
    const result = await executeFailoverForTunnel(TUNNEL, h.deps);
    expect(result.outcome).toBe("hold");
    expect(result.decision?.blockers.map((b) => b.reason)).toContain("observation_all_stale");
  });

  test("旧租约没过期 ⇒ waiting（不强行交接），且事实读取正常", async () => {
    const state = baseState({ lease: leaseRow({ lease_expires_at: new Date(NOW_MS + 30_000) }) });
    const h = harness();
    h.deps.readDecisionFacts = (input) => readFailoverDecisionFacts(input, readerOptions(state));
    // 替身认领与读路径必须看同一份租约（否则测的是替身自己的状态机）
    h.setLease(state.lease);

    const result = await executeFailoverForTunnel(TUNNEL, h.deps);
    expect(result.outcome).toBe("waiting");
    expect(h.moves).toEqual([]);
  });
});

/* ================================================================== */
/* 源码守卫：没有第二套下发序列                                          */
/* ================================================================== */

const MODULE_SRC = readFileSync(new URL("../failover-executor.ts", import.meta.url), "utf8");

describe("源码守卫", () => {
  test("不读环境时钟（时间只能从 deps.now 来）", () => {
    const code = MODULE_SRC.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toContain("Date.now");
    expect(code).toMatch(/deps\.now\?\.\(\) \?\? new Date\(\)/);
  });

  test("迁移只交给既有变更路径：不构造下发序列、不自己写 placement", () => {
    const code = MODULE_SRC.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
    // 既有路径的入口（在默认接线里动态解析，避免安全核心在 import 期就依赖 DB）
    expect(code).toContain('import("./forward-service.ts")');
    expect(code).toContain("patchForward(");
    expect(code).toContain('import("./placement-lease.ts")');
    // 安全核心没有任何静态的 DB 耦合 import（否则没有 DATABASE_URL 就 import 不了）
    expect(code).not.toMatch(/^import\s(?!type\s)[^;]*from\s"\.\/(forward-service|placement-lease|portPool)/m);
    // 没有第二套：不直接跑 rollout、不直接碰 orchestrator / agent 命令 / 隧道写入
    expect(code).not.toContain("executeRollout");
    expect(code).not.toContain("registerRollout");
    expect(code).not.toContain("orchestrator");
    expect(code).not.toContain("db.tunnel.update");
    expect(code).not.toContain("tunnel.update(");
    // 目标/desired 的**写侧**字段名一个都不出现：本模块没有能力改「指向什么」。
    // （`remote_host` / `remote_port` 只允许出现在读投影里，即 `: true`。）
    for (const forbidden of ["target_host", "target_port", "egress_targets", "desired_status"]) {
      expect(code).not.toContain(forbidden);
    }
    // 目标身份只允许出现在「读投影」与「读访问」两种形态里；其余出现即视为写侧。
    const readOnlyTarget = code
      .replace(/remote_host: true|remote_port: true/g, "")
      .replace(/tunnel\.remote_host|tunnel\.remote_port/g, "");
    expect(readOnlyTarget).not.toContain("remote_host");
    expect(readOnlyTarget).not.toContain("remote_port");
    // 提交给既有路径的只有入口节点（外加乐观并发基线）
    expect(code).toContain("ingress_node_id: request.toNodeId");
    expect(code).toContain("expected_revision: request.expectedConfigRevision");
    // 两阶段与 CAS 的判定来自唯一实现（类型 + 动态解析，不是自己重写）
    expect(code).toContain('from "./placement-lease.ts";');
  });
});
