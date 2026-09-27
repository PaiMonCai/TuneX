/**
 * V4-WP7 mock 侧的 **node lifecycle 投影**（`/admin/node/:id/lifecycle`、
 * `/admin/node/:id/impact` 的响应）。
 *
 * ── 为什么 mock 要重写一遍 ──
 * 真实判定只有一个真相：`backend/src/services/node-lifecycle.ts`（`canTransition`
 * / `nodeAdmission` / `deleteGates` / `checkRoleChange`）。mock 无法 import 后端
 * 的 `.ts` 模块，而 mock 模式（`NEXT_PUBLIC_API_MOCK=1`）是前端演示与契约测试
 * 唯一的运行环境，所以这里**只镜像形状与关键规则**：
 *   1. 让前端在 mock 模式下走真实的按钮/拒绝码路径（而不是假数据）；
 *   2. 让契约测试能断言 UI 依赖的字段一个都不少。
 *
 * ⚠️ **任何判定改动都以后端为准**。下面的迁移白名单、删除闸门顺序、角色收缩
 * 规则逐条对齐 `services/node-lifecycle.ts` 的 `TRANSITIONS` / `deleteGates` /
 * `checkRoleChange`；两边不一致时改这里，不改前端消费方。
 */
import type {
  ID,
  Node,
  NodeImpact,
  NodeImpactResult,
  NodeLifecycleChangeResult,
  NodeLifecycleConditionCode,
  NodeLifecycleValue,
  NodeLifecycleView,
  NodeRoleCheckResult,
  NodeStateReport,
  Tunnel,
  UserNode,
} from "@/lib/types";

/* ================================================================== */
/* 契约常量                                                            */
/* ================================================================== */

/** 生命周期枚举（schema `enum NodeLifecycle`）。 */
export const MOCK_LIFECYCLES: NodeLifecycleValue[] = ["active", "maintenance", "disabled", "retiring"];

/** 备注长度上限（后端 `LIFECYCLE_NOTE_MAX`）。 */
export const MOCK_LIFECYCLE_NOTE_MAX = 255;

/** 上报陈旧窗口（后端 `CONNECTION_ONLINE_WINDOW_MS`）。 */
const ONLINE_WINDOW_MS = 90_000;

/**
 * 迁移白名单（镜像后端 `TRANSITIONS`）。
 *
 * 三条语义必须一致：
 *   · `retiring` 单向门（只有 retiring → retiring）；
 *   · `disabled → maintenance` 拒绝（两个态对新业务都是拒，重启维护态没有意义）；
 *   · 同值是合法幂等写（UI 的保存按钮不该因为「什么都没改」报错）。
 */
const TRANSITIONS: Record<NodeLifecycleValue, readonly NodeLifecycleValue[]> = {
  active: ["active", "maintenance", "disabled", "retiring"],
  maintenance: ["active", "maintenance", "disabled", "retiring"],
  disabled: ["active", "disabled", "retiring"],
  retiring: ["retiring"],
};

/* ================================================================== */
/* 种子（演示数据：让每种生命周期/连接组合都有可点开的样本）              */
/* ================================================================== */

/** 演示生命周期种子：node_id → { lifecycle, note }。缺省 = active 无备注。 */
export const MOCK_LIFECYCLE_SEED: Record<ID, { lifecycle: NodeLifecycleValue; note: string | null }> = {
  // sg-out-01（both + 在线 + 有上报）：维护中——演示「维护中仍在线」不是故障
  6: { lifecycle: "maintenance", note: "内核升级窗口，预计 30 分钟" },
  // jp-out-02（egress + inactive + 凭据已撤销）：已停用——演示 disabled 的依赖处理
  5: { lifecycle: "disabled", note: "硬件故障，暂停接单" },
};

/**
 * 演示端口租约种子（node_id → 占用端口）。
 *
 * mock 没有 NodePortLease 表；这里给一个最小事实面，让 impact 预览与
 * 「端口区间收缩会悬空租约」这条判定在演示模式下真实可见。
 */
export const MOCK_PORT_LEASE_SEED: Record<ID, number[]> = {
  4: [20001, 20002, 20880],
  6: [24001, 24002],
};

/* ================================================================== */
/* 纯判定（镜像后端，供 mock handler 与测试共用）                        */
/* ================================================================== */

export function mockLifecycleOf(node: Node, stored?: { lifecycle: NodeLifecycleValue } | undefined): NodeLifecycleValue {
  const raw = stored?.lifecycle ?? (node as Node & { lifecycle?: string | null }).lifecycle;
  if (raw === "maintenance" || raw === "disabled" || raw === "retiring") return raw;
  return "active";
}

export function mockConnection(node: Node, now: Date): "waiting" | "online" | "offline" {
  if (!node.has_credential) return "waiting";
  if (node.credential_revoked) return "offline";
  if (node.status !== "active") return "offline";
  if (!node.last_seen_at) return "offline";
  return now.getTime() - new Date(node.last_seen_at).getTime() <= ONLINE_WINDOW_MS ? "online" : "offline";
}

export function mockCanTransition(from: string | null | undefined, to: string): boolean {
  if (!from || !(MOCK_LIFECYCLES as string[]).includes(from)) return false;
  if (!(MOCK_LIFECYCLES as string[]).includes(to)) return false;
  return (TRANSITIONS[from as NodeLifecycleValue] as string[]).includes(to);
}

export function mockAllowedTransitions(from: string | null | undefined): NodeLifecycleValue[] {
  if (!from || !(MOCK_LIFECYCLES as string[]).includes(from)) return [];
  return [...TRANSITIONS[from as NodeLifecycleValue]];
}

export function mockAcceptsBusiness(lifecycle: string | null | undefined): boolean {
  return lifecycle === "active";
}

export function mockBusinessRejectionCode(lifecycle: string | null | undefined): NodeLifecycleConditionCode {
  if (lifecycle === "maintenance") return "node_in_maintenance";
  if (lifecycle === "retiring") return "node_retiring";
  return "node_disabled";
}

/** 生命周期视图（镜像后端 `lifecycleView`；哈希绝不出现在返回里）。 */
export function mockLifecycleView(
  node: Node,
  lifecycle: NodeLifecycleValue,
  now: Date,
): NodeLifecycleView {
  const connection = mockConnection(node, now);
  let rejection: NodeLifecycleView["admission_rejection"] = null;
  if (connection === "waiting") {
    rejection = "node_waiting_install";
  } else if (!mockAcceptsBusiness(lifecycle)) {
    rejection = mockBusinessRejectionCode(lifecycle);
  }
  return {
    id: node.id,
    node_id: node.node_id,
    role: node.role ?? null,
    lifecycle,
    connection,
    accepts_new_business: rejection === null,
    has_credential: Boolean(node.has_credential),
    credential_revoked: Boolean(node.credential_revoked),
    admission_rejection: rejection,
    allowed_transitions: mockAllowedTransitions(lifecycle),
  };
}

/* ================================================================== */
/* impact 统计（镜像后端 getNodeImpact —— 计数来自 store 的真实事实）      */
/* ================================================================== */

export interface MockImpactWorld {
  nodes: Node[];
  tunnels: Tunnel[];
  /** 该节点上的出口池数。 */
  poolsForNode: (nodeId: ID) => number;
  /** 涉及该节点的入口-出口绑定数（mock store 的 nodeBindings）。 */
  bindingsForNode: (nodeId: ID) => number;
  /** 该节点上 active 的端口租约。 */
  leasesForNode: (nodeId: ID) => number[];
  /** Forward 的入口节点解析口径（与转发/健康视图**同一**函数）。 */
  ingressNodeIdFor: (tunnel: Tunnel) => ID | null;
}

/**
 * 某个 Forward 是否把 `nodeId` 当入口。
 *
 * 注意 `Tunnel.ingress_node_id` 在 mock 种子里是 undefined（v3 之前的数据），
 * 真实入口由 `in_node_group_id` + 角色推导——因此必须走调用方注入的
 * `ingressNodeIdFor`，不能只读 `ingress_node_id`，否则 impact 会少算一类
 * （这正是后端 `desiredRuntimesForNode` 的口径来源）。
 */
export function mockImpact(world: MockImpactWorld, nodeId: ID): NodeImpact {
  let ingress = 0;
  let egress = 0;
  for (const t of world.tunnels) {
    if (world.ingressNodeIdFor(t) === nodeId) ingress += 1;
    if (t.egress_node_id === nodeId) egress += 1;
  }
  return {
    ingress_forward_count: ingress,
    egress_forward_count: egress,
    binding_count: world.bindingsForNode(nodeId),
    active_port_lease_count: world.leasesForNode(nodeId).length,
    egress_pool_count: world.poolsForNode(nodeId),
    blockers: [],
  };
}

/** 角色 / 端口区间收缩检查（镜像后端 `checkRoleChange`）。 */
export function mockRoleCheck(input: {
  currentRole: string | null;
  impact: NodeImpact;
  nextRole?: string | null;
  nextPortRange?: { min: number | null; max: number | null } | null;
  activeLeasePorts?: number[];
}): NodeRoleCheckResult {
  const next = input.nextRole ?? input.currentRole;
  if (next !== null && next !== undefined) {
    const hasIngress = next === "ingress" || next === "both";
    const hasEgress = next === "egress" || next === "both";
    if (!hasIngress && input.impact.ingress_forward_count > 0) {
      return {
        ok: false,
        condition: "node_still_used_as_ingress",
        message: `该节点仍被 ${input.impact.ingress_forward_count} 条端口转发作为入口使用，请先迁移这些转发`,
      };
    }
    if (!hasEgress && input.impact.egress_forward_count > 0) {
      return {
        ok: false,
        condition: "node_still_used_as_egress",
        message: `该节点仍被 ${input.impact.egress_forward_count} 条端口转发作为出口使用，请先迁移这些转发`,
      };
    }
  }
  const range = input.nextPortRange;
  if (range && range.min !== null && range.max !== null) {
    const orphaned = (input.activeLeasePorts ?? []).filter((p) => p < range.min! || p > range.max!);
    if (orphaned.length > 0) {
      return {
        ok: false,
        condition: "port_range_would_orphan_leases",
        message: `端口区间收缩会使 ${orphaned.length} 个已占用端口（${orphaned.join(", ")}）落到区间外`,
      };
    }
  }
  return { ok: true };
}

export function mockImpactResult(
  world: MockImpactWorld,
  node: Node,
  check?: { nextRole?: string | null; nextPortRange?: { min: number | null; max: number | null } | null },
): NodeImpactResult {
  const impact = mockImpact(world, node.id);
  return {
    impact,
    role_check: mockRoleCheck({
      currentRole: node.role ?? null,
      impact,
      ...(check?.nextRole !== undefined ? { nextRole: check.nextRole } : {}),
      ...(check?.nextPortRange ? { nextPortRange: check.nextPortRange } : {}),
      activeLeasePorts: world.leasesForNode(node.id),
    }),
  };
}

/* ================================================================== */
/* 删除闸门（镜像后端 deleteGates 的**顺序**）                           */
/* ================================================================== */

export function mockDeleteGates(input: {
  lifecycle: string | null | undefined;
  impact: NodeImpact;
}): { ok: true } | { ok: false; condition: NodeLifecycleConditionCode; message: string } {
  if (input.lifecycle !== "retiring") {
    return { ok: false, condition: "node_not_retiring", message: "删除节点前必须先进入退役（retiring）状态" };
  }
  if (input.impact.ingress_forward_count > 0) {
    return { ok: false, condition: "node_still_used_as_ingress", message: "仍有端口转发以该节点为入口" };
  }
  if (input.impact.egress_forward_count > 0) {
    return { ok: false, condition: "node_still_used_as_egress", message: "仍有端口转发以该节点为出口" };
  }
  if (input.impact.binding_count > 0) {
    return { ok: false, condition: "dependency_blocked", message: "仍存在涉及该节点的入口-出口绑定" };
  }
  if (input.impact.active_port_lease_count > 0) {
    return { ok: false, condition: "dependency_blocked", message: "仍存在未释放的端口租约" };
  }
  if (input.impact.egress_pool_count > 0) {
    return { ok: false, condition: "dependency_blocked", message: "仍存在出口池" };
  }
  return { ok: true };
}

/** 空影响统计（节点不存在或无法统计时的安全占位）。 */
export function emptyImpact(): NodeImpact {
  return {
    ingress_forward_count: 0,
    egress_forward_count: 0,
    binding_count: 0,
    active_port_lease_count: 0,
    egress_pool_count: 0,
    blockers: [],
  };
}

/** 写后响应（镜像后端 PATCH 返回 `{ node, view }`）。 */
export function mockLifecycleChange(
  node: Node,
  lifecycle: NodeLifecycleValue,
  now: Date,
): NodeLifecycleChangeResult {
  return { node: { ...node }, view: mockLifecycleView(node, lifecycle, now) };
}

/** 便捷：从 store 的 Node 行取 UserNode 投影（rejection 判定只用基础字段）。 */
export function mockLifecycleUserNode(node: Node): UserNode {
  return { ...(node as UserNode) };
}

/** 供测试断言 mock 的迁移表与后端一致（后端 TRANSITIONS 的 key 全集）。 */
export const MOCK_TRANSITIONS = TRANSITIONS;

/** 供测试断言：mock 侧状态上报的节点集合（与 health mock 同源）。 */
export type MockNodeStateMap = Map<ID, NodeStateReport>;
