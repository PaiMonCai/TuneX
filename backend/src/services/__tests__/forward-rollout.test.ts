/**
 * V4-WP3 — `forward-rollout.ts` 纯函数矩阵测试。
 *
 * 跑法（与 CI 的 `bun test` 一致）：
 *   cd backend && bun test src/services/__tests__/forward-rollout.test.ts
 *
 * 断言的是报告 §13.3.4/§13.3.5 写在正文里的**不变量**，不是实现细节：
 *   1. RELAY 的 prepare_egress 严格早于 cutover_ingress（CONP 铁律）；
 *   2. 纯 metadata / 无 runtime 变化 ⇒ 零步骤（§13.3.2）；
 *   3. VALIDATE 阻断 ⇒ 零步骤（§13.3.5 失败规则一）；
 *   4. 四类 runtime 改动各自产生 §13.3.4 判定表要求的步骤集合；
 *   5. 每个步骤都有幂等键，且同 plan 内唯一；
 *   6. 跨 phase 严格有序、同 phase 保持生成序；
 *   7. lifecycle 非 active ⇒ fail-closed（R7 与 WP5 口径一致）；
 *   8. DIRECT 热换不重建 listener（旧连接保持）；
 *   9. CLEANUP 的 release_old_lease 一定晚于同节点的 drain（避免双绑窗口）。
 */

import { describe, expect, it } from "bun:test";

import type { ForwardImpact } from "../forward-revision.ts";
import {
  classifyRolloutStrategy,
  lifecycleBlocksForward,
  planRollout,
  rolloutStepKey,
  validateRolloutAdmission,
  type PlanRolloutInput,
  type RolloutSnapshot,
} from "../forward-rollout.ts";

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const NODE_INGRESS = {
  id: 11,
  node_id: "ing-a",
  role: "ingress",
  connect_ip: "10.0.0.11",
  lifecycle: "active",
};

const NODE_INGRESS_B = { id: 12, node_id: "ing-b", role: "both", connect_ip: "10.0.0.12", lifecycle: "active" };
const NODE_EGRESS = { id: 21, node_id: "egr-a", role: "egress", connect_ip: "10.0.1.21", lifecycle: "active" };
const NODE_EGRESS_B = { id: 22, node_id: "egr-b", role: "egress", connect_ip: "10.0.1.22", lifecycle: "active" };

const NONE_NODES = { ingress: null, egress: null, ingress_previous: null, egress_previous: null };

/** §13.3.4 表格里 runtime 变化的默认形态：每字段都由各用例覆盖。 */
function impact(overrides: Partial<ForwardImpact> = {}): ForwardImpact {
  const base: ForwardImpact = {
    metadata_only: false,
    runtime_change: true,
    changes_external_address: false,
    listen_port_change: false,
    listener_replacement: false,
    ingress_node_change: false,
    egress_node_change: false,
    mode_change: false,
    target_change: false,
    egress_target_change: false,
    nodes_prepare_drain: [],
    binding_required: false,
    port_status: "ok",
    desired_address: null,
  };
  return { ...base, ...overrides };
}

function snapshot(overrides: Partial<RolloutSnapshot> = {}): RolloutSnapshot {
  const base: RolloutSnapshot = {
    name: "fixture",
    mode: "direct",
    ingress_node_id: NODE_INGRESS.id,
    egress_node_id: null,
    listen_ip: null,
    listen_port: 10001,
    target_host: "10.9.9.9",
    target_port: 8080,
    egress_pool_id: null,
    egress_port: null,
    egress_targets: null,
    desired_status: "active",
  };
  return { ...base, ...overrides };
}

function planInput(overrides: Partial<PlanRolloutInput> = {}): PlanRolloutInput {
  const desired = snapshot();
  return {
    revision: 7,
    base_revision: 6,
    impact: impact(),
    desired,
    applied: snapshot(),
    nodes: {
      ingress: NODE_INGRESS,
      egress: null,
      ingress_previous: null,
      egress_previous: null,
    },
    ...overrides,
  };
}

/** `phase:kind` 序列，便于对整张判定表做可读断言。 */
function shape(input: PlanRolloutInput): string[] {
  return planRollout(input, 42).steps.map((s) => `${s.phase}:${s.kind}`);
}

/* ------------------------------------------------------------------ */
/* 1. RELAY CONP 铁律：prepare_egress 早于 cutover_ingress             */
/* ------------------------------------------------------------------ */

describe("RELAY ordering（§13.3.5 / orchestrator 铁律）", () => {
  it("prepare_egress 严格早于 cutover_ingress", () => {
    const input = planInput({
      desired: snapshot({ mode: "relay", target_host: null, target_port: null, egress_node_id: NODE_EGRESS.id }),
      impact: impact({ mode_change: true, egress_node_change: true, binding_required: false }),
      nodes: {
        ingress: NODE_INGRESS,
        egress: NODE_EGRESS,
        ingress_previous: null,
        egress_previous: null,
      },
    });
    const steps = shape(input);
    const idxPrepare = steps.indexOf("prepare:prepare_egress");
    const idxCutover = steps.indexOf("cutover:cutover_ingress");
    expect(steps).toContain("prepare:acquire_port");
    expect(idxPrepare).toBeGreaterThan(-1);
    expect(idxCutover).toBeGreaterThan(-1);
    expect(idxPrepare).toBeLessThan(idxCutover);
  });

  it("cutover_egress 早于 cutover_ingress（入口指向的 next_hop 先就位）", () => {
    const input = planInput({
      desired: snapshot({ mode: "relay", target_host: null, target_port: null, egress_node_id: NODE_EGRESS.id }),
      impact: impact({ mode_change: true, egress_node_change: true }),
      nodes: {
        ingress: NODE_INGRESS,
        egress: NODE_EGRESS,
        ingress_previous: null,
        egress_previous: null,
      },
    });
    const steps = shape(input);
    expect(steps.indexOf("cutover:cutover_egress")).toBeLessThan(steps.indexOf("cutover:cutover_ingress"));
  });

  it("binding 缺失时 PREPARE 先 ensure_binding 再 prepare_egress", () => {
    const input = planInput({
      desired: snapshot({ mode: "relay", target_host: null, target_port: null, egress_node_id: NODE_EGRESS.id }),
      impact: impact({ mode_change: true, egress_node_change: true, binding_required: true }),
      nodes: {
        ingress: NODE_INGRESS,
        egress: NODE_EGRESS,
        ingress_previous: null,
        egress_previous: null,
      },
      binding_exists: false,
    });
    const steps = shape(input);
    const idxBind = steps.indexOf("prepare:ensure_binding");
    const idxEgress = steps.indexOf("prepare:prepare_egress");
    expect(idxBind).toBeGreaterThan(-1);
    expect(idxEgress).toBeGreaterThan(-1);
    expect(idxBind).toBeLessThan(idxEgress);
  });
});

/* ------------------------------------------------------------------ */
/* 2. 空操作：不进 orchestrator                                        */
/* ------------------------------------------------------------------ */

describe("空操作不进入口（§13.3.2）", () => {
  it("纯 metadata 改动 ⇒ 零步骤", () => {
    const input = planInput({ impact: impact({ metadata_only: true, runtime_change: false }) });
    expect(shape(input)).toEqual([]);
  });

  it("runtime_change=false ⇒ 零步骤", () => {
    const input = planInput({ impact: impact({ runtime_change: false }) });
    expect(shape(input)).toEqual([]);
  });

  it("strategy 分类为 metadata_only / noop", () => {
    expect(classifyRolloutStrategy({ impact: impact({ metadata_only: true }), desiredMode: "direct" })).toBe("metadata_only");
    expect(classifyRolloutStrategy({ impact: impact({ runtime_change: false }), desiredMode: "direct" })).toBe("noop");
  });
});

/* ------------------------------------------------------------------ */
/* 3. VALIDATE 失败 ⇒ 零步骤（失败规则一）                             */
/* ------------------------------------------------------------------ */

describe("VALIDATE 失败 ⇒ 零步骤（§13.3.5 失败规则一）", () => {
  it("入口节点缺失 ⇒ blocking 非空且零步骤", () => {
    const input = planInput({
      impact: impact({ listen_port_change: true, listener_replacement: true }),
      nodes: NONE_NODES,
    });
    const plan = planRollout(input, 42);
    expect(plan.blocking.length).toBeGreaterThan(0);
    expect(plan.blocking[0]!.code).toBe("node_unavailable");
    expect(plan.steps).toEqual([]);
  });

  it("入口节点 maintenance ⇒ node_in_maintenance 且零步骤", () => {
    const input = planInput({
      impact: impact({ listen_port_change: true, listener_replacement: true }),
      nodes: {
        ingress: { ...NODE_INGRESS, lifecycle: "maintenance" },
        egress: null,
        ingress_previous: null,
        egress_previous: null,
      },
    });
    const plan = planRollout(input, 42);
    expect(plan.blocking.map((b) => b.code)).toContain("node_in_maintenance");
    expect(plan.steps).toEqual([]);
  });

  it("RELAY 出口 retiring ⇒ node_retiring", () => {
    const input = planInput({
      desired: snapshot({ mode: "relay", target_host: null, target_port: null, egress_node_id: NODE_EGRESS.id }),
      impact: impact({ mode_change: true, egress_node_change: true }),
      nodes: {
        ingress: NODE_INGRESS,
        egress: { ...NODE_EGRESS, lifecycle: "retiring" },
        ingress_previous: null,
        egress_previous: null,
      },
    });
    const plan = planRollout(input, 42);
    expect(plan.blocking.map((b) => b.code)).toContain("node_retiring");
    expect(plan.steps).toEqual([]);
  });

  it("DIRECT 目标不完整 ⇒ invalid_target", () => {
    const input = planInput({
      impact: impact({ listener_replacement: true, listen_port_change: true }),
      desired: snapshot({ target_host: null, target_port: null }),
    });
    const plan = planRollout(input, 42);
    expect(plan.blocking.map((b) => b.code)).toContain("invalid_target");
    expect(plan.steps).toEqual([]);
  });

  it("指名端口命中黑名单 ⇒ port_invalid", () => {
    const input = planInput({
      impact: impact({ listen_port_change: true, listener_replacement: true }),
      desired: snapshot({ listen_port: 3306 }),
    });
    const plan = planRollout(input, 42);
    expect(plan.blocking.map((b) => b.code)).toContain("port_invalid");
    expect(plan.steps).toEqual([]);
  });

  it("binding 缺失不阻断：由 PREPARE 的 ensure_binding 解决（§3.2 判定表）", () => {
    const input = planInput({
      desired: snapshot({ mode: "relay", target_host: null, target_port: null, egress_node_id: NODE_EGRESS.id }),
      impact: impact({ mode_change: true, egress_node_change: true }),
      nodes: {
        ingress: NODE_INGRESS,
        egress: NODE_EGRESS,
        ingress_previous: null,
        egress_previous: null,
      },
      binding_exists: false,
    });
    const plan = planRollout(input, 42);
    expect(plan.blocking).toEqual([]);
    expect(plan.steps.map((s) => `${s.phase}:${s.kind}`)).toContain("prepare:ensure_binding");
  });

  it("空操作不跑准入判定（metadata_only 不因其他原因被阻断）", () => {
    const input = planInput({
      impact: impact({ metadata_only: true, runtime_change: false }),
      nodes: NONE_NODES,
    });
    expect(planRollout(input, 42).blocking).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 4. §13.3.4 四类判定的步骤集合                                        */
/* ------------------------------------------------------------------ */

describe("策略分类与步骤集合（§13.3.4 判定表）", () => {
  it("换监听端口 ⇒ listener_replace + acquire_port + drain/cleanup 旧 lease", () => {
    const input = planInput({
      desired: snapshot({ listen_port: 20002 }),
      applied: snapshot(),
      impact: impact({ listen_port_change: true, listener_replacement: true, changes_external_address: true }),
    });
    expect(classifyRolloutStrategy({ impact: input.impact, desiredMode: "direct" })).toBe("listener_replace");
    expect(shape(input)).toEqual([
      "validate:validate",
      "prepare:acquire_port",
      "cutover:cutover_ingress",
      "drain:drain_ingress",
      "cleanup:release_old_lease",
    ]);
  });

  it("换入口节点 ⇒ node_migration，drain/cleanup 指向旧节点", () => {
    const input = planInput({
      desired: snapshot({ ingress_node_id: NODE_INGRESS_B.id }),
      applied: snapshot(),
      impact: impact({ ingress_node_change: true, listener_replacement: true, changes_external_address: true }),
      nodes: {
        ingress: NODE_INGRESS_B,
        egress: null,
        ingress_previous: NODE_INGRESS,
        egress_previous: null,
      },
    });
    const steps = planRollout(input, 42).steps;
    expect(steps.map((s) => `${s.phase}:${s.kind}`)).toEqual([
      "validate:validate",
      "prepare:acquire_port",
      "cutover:cutover_ingress",
      "drain:drain_ingress",
      "cleanup:release_old_lease",
    ]);
    expect(steps.find((s) => s.phase === "drain")!.node_id).toBe(NODE_INGRESS.id);
    expect(steps.find((s) => s.phase === "cleanup")!.node_id).toBe(NODE_INGRESS.id);
    expect(steps.find((s) => s.phase === "prepare")!.node_id).toBe(NODE_INGRESS_B.id);
  });

  it("DIRECT 换 target ⇒ target_hot_swap，不重建 listener、不 drain", () => {
    const input = planInput({
      desired: snapshot({ target_host: "10.8.8.8", target_port: 9090 }),
      applied: snapshot(),
      impact: impact({ target_change: true }),
    });
    expect(classifyRolloutStrategy({ impact: input.impact, desiredMode: "direct" })).toBe("target_hot_swap");
    const steps = shape(input);
    expect(steps).toEqual(["validate:validate", "cutover:cutover_ingress"]);
    // 旧连接保持：没有 listener 重建序列。
    expect(steps).not.toContain("prepare:acquire_port");
    expect(steps).not.toContain("drain:drain_ingress");
    const cutover = planRollout(input, 42).steps.find((s) => s.phase === "cutover")!;
    expect(cutover.meta).toEqual({ same_listener: true });
  });

  it("DIRECT→RELAY ⇒ mode_switch，出口先 prepare 再入口切", () => {
    const input = planInput({
      desired: snapshot({ mode: "relay", target_host: null, target_port: null, egress_node_id: NODE_EGRESS.id, egress_port: 31000 }),
      applied: snapshot(),
      impact: impact({ mode_change: true, egress_node_change: true, binding_required: true }),
      nodes: {
        ingress: NODE_INGRESS,
        egress: NODE_EGRESS,
        ingress_previous: null,
        egress_previous: null,
      },
      binding_exists: true,
    });
    const steps = shape(input);
    expect(steps.indexOf("prepare:prepare_egress")).toBeLessThan(steps.indexOf("cutover:cutover_ingress"));
    // DIRECT 没有旧出口 ⇒ 无 drain_egress / drop_old_egress。
    expect(steps).not.toContain("drain:drain_egress");
    expect(steps).not.toContain("cleanup:drop_old_egress");
  });

  it("RELAY→DIRECT ⇒ 旧 EGRESS 必须 drain + drop + release", () => {
    const appliedRelay = snapshot({
      mode: "relay",
      target_host: null,
      target_port: null,
      egress_node_id: NODE_EGRESS.id,
      egress_port: 31000,
    });
    const input = planInput({
      desired: snapshot(),
      applied: appliedRelay,
      impact: impact({ mode_change: true, egress_node_change: true }),
      nodes: {
        ingress: NODE_INGRESS,
        egress: null,
        ingress_previous: null,
        egress_previous: NODE_EGRESS,
      },
    });
    const steps = shape(input);
    expect(steps).toContain("drain:drain_egress");
    expect(steps).toContain("cleanup:drop_old_egress");
    expect(steps).toContain("cleanup:release_old_lease");
    const idxDrain = steps.indexOf("drain:drain_egress");
    const idxDrop = steps.indexOf("cleanup:drop_old_egress");
    const idxRelease = steps.indexOf("cleanup:release_old_lease");
    expect(idxDrop).toBeGreaterThan(idxDrain);
    expect(idxRelease).toBeGreaterThan(idxDrop);
  });

  it("RELAY 换出口节点 ⇒ 新出口 prepare，旧出口 drain/drop/release", () => {
    const appliedRelay = snapshot({
      mode: "relay",
      target_host: null,
      target_port: null,
      egress_node_id: NODE_EGRESS.id,
      egress_port: 31000,
    });
    const input = planInput({
      desired: snapshot({ mode: "relay", target_host: null, target_port: null, egress_node_id: NODE_EGRESS_B.id, egress_port: 31001 }),
      applied: appliedRelay,
      impact: impact({ egress_node_change: true, changes_external_address: true }),
      nodes: {
        ingress: NODE_INGRESS,
        egress: NODE_EGRESS_B,
        ingress_previous: null,
        egress_previous: NODE_EGRESS,
      },
    });
    const steps = shape(input);
    expect(steps.indexOf("prepare:prepare_egress")).toBeLessThan(steps.indexOf("cutover:cutover_ingress"));
    expect(steps.indexOf("cutover:cutover_egress")).toBeLessThan(steps.indexOf("cutover:cutover_ingress"));
    const plan = planRollout(input, 42).steps;
    expect(plan.find((s) => s.kind === "drain_egress")!.node_id).toBe(NODE_EGRESS.id);
    expect(plan.find((s) => s.kind === "prepare_egress")!.node_id).toBe(NODE_EGRESS_B.id);
  });

  it("RELAY 同节点只换池内目标 ⇒ 入口不重下发（listener 与 next_hop 都不变）", () => {
    const appliedRelay = snapshot({
      mode: "relay",
      target_host: null,
      target_port: null,
      egress_node_id: NODE_EGRESS.id,
      egress_port: 31000,
    });
    const input = planInput({
      desired: appliedRelay,
      applied: appliedRelay,
      impact: impact({ egress_target_change: true }),
      nodes: {
        ingress: NODE_INGRESS,
        egress: NODE_EGRESS,
        ingress_previous: null,
        egress_previous: null,
      },
    });
    const steps = shape(input);
    expect(steps).toEqual(["validate:validate", "cutover:cutover_egress"]);
  });

  it("多字段同时改 ⇒ 报最重档 node_migration（§13.3.4 合并规则）", () => {
    const input = planInput({
      desired: snapshot({ ingress_node_id: NODE_INGRESS_B.id, listen_port: 20002 }),
      applied: snapshot(),
      impact: impact({
        ingress_node_change: true,
        listen_port_change: true,
        listener_replacement: true,
        target_change: true,
        changes_external_address: true,
      }),
      nodes: {
        ingress: NODE_INGRESS_B,
        egress: null,
        ingress_previous: NODE_INGRESS,
        egress_previous: null,
      },
    });
    expect(classifyRolloutStrategy({ impact: input.impact, desiredMode: "direct" })).toBe("node_migration");
  });
});

/* ------------------------------------------------------------------ */
/* 5/6. 幂等键与排序                                                   */
/* ------------------------------------------------------------------ */

describe("幂等键（CLEANUP 幂等与续跑去重的唯一依据）", () => {
  it("同 (tunnel, revision, phase, kind, node, port) ⇒ 同 key", () => {
    const a = rolloutStepKey({ tunnelId: 42, revision: 7, phase: "cleanup", kind: "release_old_lease", nodeId: 11, port: 10001 });
    const b = rolloutStepKey({ tunnelId: 42, revision: 7, phase: "cleanup", kind: "release_old_lease", nodeId: 11, port: 10001 });
    expect(a).toBe(b);
  });

  it("tunnelId / revision / phase / kind / node / port 任一不同 ⇒ 不同 key", () => {
    const base = { tunnelId: 42, revision: 7, phase: "cleanup", kind: "release_old_lease", nodeId: 11, port: 10001 } as const;
    const variants = [
      { ...base, tunnelId: 43 },
      { ...base, revision: 8 },
      { ...base, phase: "drain" as const },
      { ...base, kind: "drop_old_egress" as const },
      { ...base, nodeId: 12 },
      { ...base, port: 10002 },
    ];
    const keys = new Set(variants.map((v) => rolloutStepKey(v)));
    expect(keys.size).toBe(variants.length);
    expect(keys.has(rolloutStepKey(base))).toBe(false);
  });

  it("nodeId/port 为 null 与 0 不混淆", () => {
    expect(rolloutStepKey({ tunnelId: 1, revision: 1, phase: "prepare", kind: "acquire_port", nodeId: null })).not.toBe(
      rolloutStepKey({ tunnelId: 1, revision: 1, phase: "prepare", kind: "acquire_port", nodeId: 0 }),
    );
  });

  it("plan 内 key 唯一", () => {
    const appliedRelay = snapshot({
      mode: "relay",
      target_host: null,
      target_port: null,
      egress_node_id: NODE_EGRESS.id,
      egress_port: 31000,
    });
    const input = planInput({
      desired: snapshot({ mode: "relay", target_host: null, target_port: null, egress_node_id: NODE_EGRESS_B.id, egress_port: 31001 }),
      applied: appliedRelay,
      impact: impact({ egress_node_change: true }),
      nodes: {
        ingress: NODE_INGRESS,
        egress: NODE_EGRESS_B,
        ingress_previous: null,
        egress_previous: NODE_EGRESS,
      },
    });
    const keys = planRollout(input, 42).steps.map((s) => s.idempotency_key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("跨 phase 严格有序", () => {
    const appliedRelay = snapshot({
      mode: "relay",
      target_host: null,
      target_port: null,
      egress_node_id: NODE_EGRESS.id,
      egress_port: 31000,
    });
    const input = planInput({
      desired: snapshot({ mode: "relay", target_host: null, target_port: null, egress_node_id: NODE_EGRESS_B.id, egress_port: 31001 }),
      applied: appliedRelay,
      impact: impact({ egress_node_change: true }),
      nodes: {
        ingress: NODE_INGRESS,
        egress: NODE_EGRESS_B,
        ingress_previous: null,
        egress_previous: NODE_EGRESS,
      },
    });
    const order = ["validate", "prepare", "cutover", "drain", "cleanup"];
    const steps = planRollout(input, 42).steps.map((s) => order.indexOf(s.phase));
    const sorted = [...steps].sort((a, b) => a - b);
    expect(steps).toEqual(sorted);
  });
});

/* ------------------------------------------------------------------ */
/* 7. lifecycle fail-closed                                             */
/* ------------------------------------------------------------------ */

describe("节点 lifecycle fail-closed（R7 / WP5 口径）", () => {
  it("active ⇒ null（放行）", () => {
    expect(lifecycleBlocksForward("active")).toBeNull();
  });

  it("null / undefined ⇒ 不阻断（存量库没有该列）", () => {
    expect(lifecycleBlocksForward(null)).toBeNull();
    expect(lifecycleBlocksForward(undefined)).toBeNull();
  });

  it("已知非 active ⇒ 对应阻断码", () => {
    expect(lifecycleBlocksForward("maintenance")).toBe("node_in_maintenance");
    expect(lifecycleBlocksForward("retiring")).toBe("node_retiring");
    expect(lifecycleBlocksForward("disabled")).toBe("node_disabled");
  });

  it("未知值 ⇒ node_disabled（fail-closed）", () => {
    expect(lifecycleBlocksForward("some_future_state")).toBe("node_disabled");
  });

  it("validateRolloutAdmission 只查新旧拓扑涉及到的节点", () => {
    const input = planInput({
      impact: impact({ listener_replacement: true, listen_port_change: true }),
    });
    // 默认 fixture 入口是活跃 ⇒ 无阻断。
    expect(validateRolloutAdmission(input)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 8/9. 旧路径处理与清理顺序                                           */
/* ------------------------------------------------------------------ */

describe("旧路径退场顺序（避免双绑/暴露窗口）", () => {
  it("applied=null（首次部署）⇒ 无旧步骤", () => {
    const input = planInput({
      applied: null,
      impact: impact({ listener_replacement: true, listen_port_change: true }),
    });
    const steps = shape(input);
    expect(steps).toEqual(["validate:validate", "prepare:acquire_port", "cutover:cutover_ingress"]);
  });

  it("端口变化但节点不变 ⇒ 同样 drain/cleanup 旧端口", () => {
    const input = planInput({
      desired: snapshot({ listen_port: 20003 }),
      applied: snapshot(),
      impact: impact({ listen_port_change: true, listener_replacement: true }),
      nodes: {
        ingress: NODE_INGRESS,
        egress: null,
        ingress_previous: NODE_INGRESS,
        egress_previous: null,
      },
    });
    const plan = planRollout(input, 42).steps;
    expect(plan.find((s) => s.kind === "drain_ingress")!.port).toBe(10001);
    expect(plan.find((s) => s.kind === "release_old_lease")!.port).toBe(10001);
  });

  it("applied=null 且 mode_change 时仍走完整流程", () => {
    const input = planInput({
      applied: null,
      desired: snapshot({ mode: "relay", target_host: null, target_port: null, egress_node_id: NODE_EGRESS.id }),
      impact: impact({ mode_change: true, egress_node_change: true }),
      nodes: {
        ingress: NODE_INGRESS,
        egress: NODE_EGRESS,
        ingress_previous: null,
        egress_previous: null,
      },
    });
    const steps = shape(input);
    expect(steps).toContain("validate:validate");
    expect(steps).toContain("prepare:prepare_egress");
    expect(steps).toContain("cutover:cutover_ingress");
    expect(steps).not.toContain("drain:drain_ingress");
  });
});
