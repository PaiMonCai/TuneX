/**
 * V4-WP5 — Node 托管生命周期（`DEVELOPMENT.md` §13.4）
 *
 * ── 三层状态里的 Lifecycle 层 ──
 * §13.4.1 把 Node 状态拆成 Connection（事实，由上报/凭据推导）、Lifecycle
 * （**本模块**，用户/管理员的期望管理状态）、Health（Backend 计算，WP6）。
 * 硬约束：不得复用 legacy `Node.status` 同时表示连接与生命周期，因此 schema
 * 新增独立列 `node.lifecycle`（见迁移 20260927000000）。
 *
 * ── 本模块的职责边界 ──
 *   ✅ 生命周期状态机（迁移白名单）、准入谓词、impact 统计、删除闸门
 *   ✅ 把上述判定以**纯函数**导出，供 WP1/WP3/WP8 复用（Forward 创建、
 *      rollout 编排、reconciler 都要回答「这个节点现在能不能接新业务」）
 *   ❌ 不做 Health 合成（WP6）、不做 telemetry（WP6）、不做 UI（WP7）、
 *      不做 rollout 延后重试队列（WP3）
 *   ❌ 不 import socket/* / control-protocol/* / portPool / redis：
 *      生命周期的判定只依赖 DB 里的 desired state，与 runtime transport 无关
 *      （沿用 node-admin.ts 的边界纪律，测试因此可完全离线跑）
 *
 * ── 依赖注入 ──
 * 与 node-admin.ts / portPool.ts 同一取向：默认走进程级 `db` 单例，每个公开
 * 函数都接受 {@link LifecycleDb} 覆盖，测试直接传内存替身，**不需要**
 * `mock.module`（那会随 worktree/CI 路径静默打歪）。
 */
import { db } from "../db.ts";

/* ================================================================== */
/* 常量                                                               */
/* ================================================================== */

/** 生命周期枚举（schema.prisma `enum NodeLifecycle` 的服务层镜像）。 */
export const NODE_LIFECYCLES = ["active", "maintenance", "disabled", "retiring"] as const;
export type NodeLifecycleValue = (typeof NODE_LIFECYCLES)[number];

/**
 * 连接态枚举（§13.4.1 Connection 层）。
 *
 * WP5 **不新推导**：连接态由 routes/nodes.ts 的 `nodeView()` 用
 * `status + last_seen_at + credential` 推导。这里只把既有事实收拢成命名，
 * 让「这个节点现在能不能接新业务」成为单一谓词，而不是每个调用方各判一遍。
 */
export const NODE_CONNECTIONS = ["waiting", "online", "offline"] as const;
export type NodeConnectionValue = (typeof NODE_CONNECTIONS)[number];

/** 进入 maintenance / retiring 时用户可填的原因长度上限（与 schema VarChar 对齐）。 */
export const LIFECYCLE_NOTE_MAX = 255;

/** 上报陈旧阈值（毫秒）：与 routes/nodes.ts 的 `nodeView` 保持一致（90s）。 */
export const CONNECTION_ONLINE_WINDOW_MS = 90_000;

/* ================================================================== */
/* 错误模型                                                           */
/* ================================================================== */

/**
 * WP5 错误码（§13.5「权限拒绝、能力拒绝、额度拒绝、运行条件拒绝必须使用
 * 可区分的错误码」—— 这几条全是**运行条件**拒绝）。
 */
export type LifecycleErrorCode =
  /** 入参校验失败（400） */
  | "invalid_input"
  /** 节点不存在（404） */
  | "not_found"
  /** 节点当前处于某种不允许该操作的生命周期（409） */
  | "invalid_state"
  /** 删除/收缩前存在未清空的依赖（409），依赖清单在 `data.dependencies` */
  | "dependency_blocked";

/** 错误码 → HTTP 状态码（路由层只查这张表，不自己判）。 */
export const LIFECYCLE_ERROR_STATUS: Record<LifecycleErrorCode, 400 | 404 | 409> = {
  invalid_input: 400,
  not_found: 404,
  invalid_state: 409,
  dependency_blocked: 409,
};

/**
 * 具体运行条件拒绝码。路由把它原样透传给前端（§13.5：Web 才能给用户正确
 * 下一步动作），前端**不得**把不同 code 渲染成同一句「操作失败」。
 */
export type LifecycleConditionCode =
  /** 非法的生命周期迁移（含 retiring → 任意） */
  | "invalid_transition"
  /** 维护中，不接受新业务 */
  | "node_in_maintenance"
  /** 已停用，不接受新业务 */
  | "node_disabled"
  /** 退役中，不接受新业务 */
  | "node_retiring"
  /** 删除前必须先进入 retiring */
  | "node_not_retiring"
  /** 仍有 Forward 以该节点为入口 */
  | "node_still_used_as_ingress"
  /** 仍有 Forward 以该节点为出口 */
  | "node_still_used_as_egress"
  /** 仍有入口-出口绑定 / 端口租约 / 出口池未清（未细分，具体见 dependencies 计数） */
  | "dependency_blocked"
  /** 收缩端口区间会让 active 租约落到区间外 */
  | "port_range_would_orphan_leases";

export interface LifecycleError {
  ok: false;
  code: LifecycleErrorCode;
  /** 运行条件的具体拒绝码（`code === "invalid_state" | "dependency_blocked"` 时必有）。 */
  condition?: LifecycleConditionCode;
  message: string;
  /** 未清空的依赖清单（仅 `dependency_blocked`），让 UI 直接列出要处理什么。 */
  dependencies?: NodeImpact;
}

function err(
  code: LifecycleErrorCode,
  message: string,
  extra: { condition?: LifecycleConditionCode; dependencies?: NodeImpact } = {},
): LifecycleError {
  return { ok: false, code, message, ...extra };
}

/* ================================================================== */
/* 纯判定（无 IO，可离线单测）                                         */
/* ================================================================== */

export type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

/** lifecycle 入参解析。`undefined`/`null`/空串 = 未指定（调用方按「本次不动」处理）。 */
export function parseLifecycle(input: unknown): ParseResult<NodeLifecycleValue | null> {
  if (input === undefined || input === null || input === "") return { ok: true, value: null };
  if (typeof input !== "string") return { ok: false, message: "生命周期状态必须是 active / maintenance / disabled / retiring" };
  const v = input.trim().toLowerCase();
  if (v === "") return { ok: true, value: null };
  if ((NODE_LIFECYCLES as readonly string[]).includes(v)) {
    return { ok: true, value: v as NodeLifecycleValue };
  }
  return { ok: false, message: "生命周期状态必须是 active / maintenance / disabled / retiring" };
}

/** 备注解析（可选，纯展示，不参与任何判定）。 */
export function parseLifecycleNote(input: unknown): ParseResult<string | null> {
  if (input === undefined || input === null) return { ok: true, value: null };
  if (typeof input !== "string") return { ok: false, message: "备注必须是字符串" };
  const note = input.trim();
  if (note.length > LIFECYCLE_NOTE_MAX) {
    return { ok: false, message: `备注长度不能超过 ${LIFECYCLE_NOTE_MAX}` };
  }
  return { ok: true, value: note.length === 0 ? null : note };
}

/**
 * 生命周期迁移白名单（§13.4.2 + §2.3 冻结表）。
 *
 * 三条设计取向：
 *   1. **retiring 是单向门**。它承诺「依赖清单已锁定、删除是唯一出口」；
 *      允许回退会让这个承诺失效。要回头只能先物理删除（或未来 WP7 显式
 *      cancel，本期契约不开这个口）。
 *   2. **disabled → maintenance 拒绝**：disabled 的语义是「不再接受新业务」，
 *      再进入「暂停接受新业务」没有意义（maint/disabled 对新业务都是拒），
 *      只会让用户在两个名字相同的行为之间困惑。
 *   3. **maintenance ↔ active 双向**：进维护/退出维护是最高频操作，多一道
 *      中间态纯属添堵。disable 则不要求先退出维护（管理员想直接停用就停用）。
 *
 * 同值迁移（active → active）视为合法幂等写（更新 note / 更新时间戳），
 * 不报错：UI 的保存按钮不该因为「什么都没改」而弹错误。
 */
const TRANSITIONS: Record<NodeLifecycleValue, readonly NodeLifecycleValue[]> = {
  active: ["active", "maintenance", "disabled", "retiring"],
  maintenance: ["active", "maintenance", "disabled", "retiring"],
  disabled: ["active", "disabled", "retiring"],
  retiring: ["retiring"],
};

/**
 * 从 `from` 迁移到 `to` 是否合法（纯函数）。
 *
 * 未知值一律 false（fail-closed）：schema 加新状态而忘了更新本表时，
 * 结果是拒绝而不是静默放行。
 */
export function canTransition(from: string | null | undefined, to: string): boolean {
  if (!from || !(NODE_LIFECYCLES as readonly string[]).includes(from)) return false;
  if (!(NODE_LIFECYCLES as readonly string[]).includes(to)) return false;
  return (TRANSITIONS[from as NodeLifecycleValue] as readonly string[]).includes(to);
}

/** 某状态下所有合法目标（供 UI 渲染可用按钮，也供错误信息罗列）。 */
export function allowedTransitions(from: string | null | undefined): NodeLifecycleValue[] {
  if (!from || !(NODE_LIFECYCLES as readonly string[]).includes(from)) return [];
  return [...TRANSITIONS[from as NodeLifecycleValue]];
}

/**
 * 该生命周期是否接受新业务（新 Forward / 新 Binding / 迁移目标候选）。
 *
 * 这是 §13.4.2 的**唯一代码落点**。WP1 的 Forward 创建、WP8 的节点选择
 * 都必须调它，不得各自 `lifecycle !== "maintenance"` 再判一遍——两处判据
 * 漂移是这类准入最常见的故障形态。
 */
export function lifecycleAcceptsBusiness(lifecycle: string | null | undefined): boolean {
  return lifecycle === "active";
}

/**
 * 生命周期 → 拒绝码（`acceptsBusiness` 为 false 时给前端的具体原因）。
 *
 * 未知/NULL 值按 `node_disabled` 处理（fail-closed）：schema 补了新状态而
 * 本函数没跟上时，行为是拒绝而不是放行。
 */
export function businessRejectionCode(lifecycle: string | null | undefined): LifecycleConditionCode {
  if (lifecycle === "maintenance") return "node_in_maintenance";
  if (lifecycle === "retiring") return "node_retiring";
  return "node_disabled";
}

/**
 * 连接态推导（**复用** routes/nodes.ts `nodeView` 的口径，不重发明）。
 *
 *   waiting —— 已创建但从未绑定凭据（尚未完成 enrollment）
 *   online  —— 有有效凭据、未撤销、status=active 且 last_seen 在窗口内
 *   offline —— 其余（含：有凭据但掉线、有凭据但已撤销）
 *
 * 为什么 revoked 归 offline 而不是 waiting：revoke 是**主动**断开机器身份，
 * 节点确实已不在服务；waiting 的语义是「还没装好」，给 revoked 用会让运维
 * 以为还在等安装。
 */
export function deriveConnection(input: {
  status?: string | null;
  last_seen_at?: Date | null;
  has_credential?: boolean;
  credential_revoked?: boolean;
  now?: Date;
}): NodeConnectionValue {
  if (!input.has_credential) return "waiting";
  if (input.credential_revoked) return "offline";
  if (input.status !== "active") return "offline";
  const seen = input.last_seen_at ?? null;
  if (!seen) return "offline";
  const now = input.now ?? new Date();
  return now.getTime() - new Date(seen).getTime() <= CONNECTION_ONLINE_WINDOW_MS
    ? "online"
    : "offline";
}

/**
 * 综合准入谓词：**这一行能不能被选为新业务的候选**。
 *
 * lifecycle 与 connection 是两个正交维度（§13.4.1）：连接是事实、生命周期是
 * 期望。`waiting` 的节点（还没装好）当然不能接新业务，但它的拒绝语义与
 * `maintenance` 不同——前者要提示「去安装」，后者要提示「去退出维护」。
 * 所以这里返回三态而不是布尔，让调用方能给对错误码。
 */
export function nodeAdmission(input: {
  lifecycle: string | null | undefined;
  status?: string | null;
  last_seen_at?: Date | null;
  has_credential?: boolean;
  credential_revoked?: boolean;
  now?: Date;
}):
  | { ok: true }
  | { ok: false; condition: "node_waiting_install" | LifecycleConditionCode; message: string } {
  const connection = deriveConnection(input);
  if (connection === "waiting") {
    return { ok: false, condition: "node_waiting_install", message: "该节点尚未完成安装，请先部署 Agent" };
  }
  if (!lifecycleAcceptsBusiness(input.lifecycle)) {
    const condition = businessRejectionCode(input.lifecycle);
    const message =
      condition === "node_in_maintenance"
        ? "该节点维护中，不接受新业务"
        : condition === "node_retiring"
          ? "该节点退役中，不接受新业务"
          : "该节点已停用，不接受新业务";
    return { ok: false, condition, message };
  }
  return { ok: true };
}

/** `accepts_new_business` 布尔投影（给列表页快速渲染，不看具体拒绝原因）。 */
export function acceptsNewBusiness(input: Parameters<typeof nodeAdmission>[0]): boolean {
  return nodeAdmission(input).ok;
}

/**
 * 端口区间收缩是否会让现有 active 租约悬空（§13.4.3 impact check）。
 *
 * `leases` 是 active 租约的端口列表（调用方负责只取 active；released 行不占位，
 * 与 portPool 的 `LEASE_STATUS.active` 语义一致）。
 */
export function portRangeWouldOrphan(
  next: { min: number | null; max: number | null } | null | undefined,
  leases: number[],
): number[] {
  if (!next || next.min === null || next.max === null) return [];
  return leases.filter((p) => p < next.min! || p > next.max!);
}

/**
 * 物理删除闸门（§13.4.3「Node 删除永远不隐式级联删除 Forward」）。
 *
 * 六道门全部满足才允许删；任一不满足 → `dependency_blocked` + 依赖清单。
 * 顺序即错误优先级：先要求「进入了 retiring」，再看各类依赖——
 * 没退役就删说明用户跳过了流程，给 `node_not_retiring` 比给一串依赖更有指导意义。
 *
 * 纯函数：impact 由调用方统计后整体传入，本函数只判定。
 */
export function deleteGates(input: {
  lifecycle: string | null | undefined;
  impact: NodeImpact;
}): { ok: true } | { ok: false; condition: LifecycleConditionCode; message: string; dependencies: NodeImpact } {
  if (input.lifecycle !== "retiring") {
    return {
      ok: false,
      condition: "node_not_retiring",
      message: "删除节点前必须先进入退役（retiring）状态",
      dependencies: input.impact,
    };
  }
  const blockers: Array<[number, LifecycleConditionCode, string]> = [
    [input.impact.ingress_forward_count, "node_still_used_as_ingress", "仍有端口转发以该节点为入口"],
    [input.impact.egress_forward_count, "node_still_used_as_egress", "仍有端口转发以该节点为出口"],
  ];
  for (const [count, condition, message] of blockers) {
    if (count > 0) return { ok: false, condition, message, dependencies: input.impact };
  }
  const emptyGate: Array<[number, LifecycleConditionCode, string]> = [
    [input.impact.binding_count, "dependency_blocked", "仍存在涉及该节点的入口-出口绑定"],
    [input.impact.active_port_lease_count, "dependency_blocked", "仍存在未释放的端口租约"],
    [input.impact.egress_pool_count, "dependency_blocked", "仍存在出口池"],
  ];
  for (const [count, condition, message] of emptyGate) {
    if (count > 0) {
      return { ok: false, condition, message, dependencies: input.impact };
    }
  }
  return { ok: true };
}

/* ================================================================== */
/* 类型（DB 行投影）                                                   */
/* ================================================================== */

/** 生命周期判定需要的节点行字段（比 NodeRow 小：select 越少越不易踩 schema 漂移）。 */
export interface LifecycleNodeRow {
  id: number;
  node_id: string;
  role: string | null;
  status: string;
  lifecycle: string;
  last_seen_at: Date | null;
  port_range_min: number | null;
  port_range_max: number | null;
  node_credential_hash: string | null;
  credential_revoked: boolean;
  /** 进入当前 lifecycle 的原因（用户填写，可空）。 */
  lifecycle_note: string | null;
  /** 最近一次 lifecycle 变更时刻（审计）。 */
  lifecycle_updated_at: Date | null;
}

/** 依赖影响统计（impact check 与 delete gates 的公共输出形状）。 */
export interface NodeImpact {
  /** 以该节点为入口的 Forward 数（`tunnel.ingress_node_id`）。 */
  ingress_forward_count: number;
  /** 以该节点为出口的 Forward 数（`tunnel.egress_node_id`）。 */
  egress_forward_count: number;
  /** 涉及该节点的 NodeBinding 数（ingress 或 egress 任一指向它）。 */
  binding_count: number;
  /** 未释放的端口租约数（`node_port_lease.status = "active"`）。 */
  active_port_lease_count: number;
  /** 该节点上的出口池数。 */
  egress_pool_count: number;
  /** 阻塞当前操作的具体原因（空数组 = 无阻塞）。 */
  blockers: string[];
}

/** 空 impact（新节点 / 从未被引用的节点）。 */
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

/* ================================================================== */
/* DB 投影（可注入替身）                                                */
/* ================================================================== */

/** 本模块需要的 DB 调用面（prisma `db` 满足之；测试用内存替身）。 */
export interface LifecycleDb {
  node: {
    findUnique(args: unknown): Promise<unknown>;
    findFirst(args: unknown): Promise<unknown>;
    findMany(args: unknown): Promise<unknown>;
    update(args: unknown): Promise<unknown>;
    delete(args: unknown): Promise<unknown>;
  };
  tunnel: {
    count(args: unknown): Promise<unknown>;
    findMany(args: unknown): Promise<unknown>;
  };
  nodeBinding: {
    count(args: unknown): Promise<unknown>;
    findMany(args: unknown): Promise<unknown>;
  };
  nodePortLease: {
    count(args: unknown): Promise<unknown>;
    findMany(args: unknown): Promise<unknown>;
  };
  egressPool: {
    count(args: unknown): Promise<unknown>;
  };
}

export interface LifecycleDeps {
  db?: LifecycleDb;
  /** 覆盖「报表陈旧」判定用的当前时间（测试注入）。 */
  now?: () => Date;
}

function deps(over: LifecycleDeps | undefined): { db: LifecycleDb; now: () => Date } {
  return { db: over?.db ?? defaultDb, now: over?.now ?? (() => new Date()) };
}

const defaultDb = db as unknown as LifecycleDb;

function asRow<T>(row: unknown): T | null {
  return row ? (row as T) : null;
}

function asRows<T>(rows: unknown): T[] {
  return Array.isArray(rows) ? (rows as T[]) : [];
}

function asCount(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

/** Prisma 已知错误 → 管理面错误（P2025 行不存在）。 */
function toLifecycleError(e: unknown, fallback: string): LifecycleError {
  const code = (e as { code?: string } | null)?.code;
  if (code === "P2025") return err("not_found", "节点不存在");
  return err("invalid_state", fallback);
}

/* ================================================================== */
/* 读取                                                               */
/* ================================================================== */

const NODE_SELECT = {
  id: true,
  node_id: true,
  role: true,
  status: true,
  lifecycle: true,
  last_seen_at: true,
  port_range_min: true,
  port_range_max: true,
  node_credential_hash: true,
  credential_revoked: true,
  lifecycle_note: true,
  lifecycle_updated_at: true,
} as const;

/**
 * 读取节点行（含 lifecycle 与凭据存在性）。
 *
 * `select` 显式点到 `node_credential_hash`：判定 connection 的 `waiting` 需要
 * 「有没有凭据」。**哈希绝不外泄**——调用方（路由）必须用
 * {@link lifecycleView} 投影，它会把哈希换成布尔。
 */
async function loadNode(
  pd: LifecycleDb,
  nodeId: number,
): Promise<LifecycleNodeRow | null> {
  return asRow<LifecycleNodeRow>(await pd.node.findUnique({ where: { id: nodeId }, select: NODE_SELECT }));
}

/**
 * 统计节点的依赖影响（impact check 的唯一实现）。
 *
 * 五条计数各查一次 count，不做 join/N+1：单节点详情页一次查询五条 COUNT
 * 在 Node 表规模（百级到千级）下没有可感知差异，而 join 会让替身测试复杂一倍。
 *
 * `blockers` 只填**与角色收缩相关**的通用阻塞描述；生命周期/删除的具体拒绝码
 * 由各自的守卫函数决定，不在这里混。
 */
export async function getNodeImpact(
  nodeId: number,
  inject?: LifecycleDeps,
): Promise<{ ok: true; impact: NodeImpact } | LifecycleError> {
  const { db: pd } = deps(inject);

  const node = await loadNode(pd, nodeId);
  if (!node) return err("not_found", "节点不存在");

  const [ingressForward, egressForward, binding, lease, pool] = await Promise.all([
    pd.tunnel.count({ where: { ingress_node_id: nodeId } }),
    pd.tunnel.count({ where: { egress_node_id: nodeId } }),
    pd.nodeBinding.count({ where: { OR: [{ ingress_node_id: nodeId }, { egress_node_id: nodeId }] } }),
    pd.nodePortLease.count({ where: { node_id: nodeId, status: "active" } }),
    pd.egressPool.count({ where: { node_id: nodeId } }),
  ]);

  return {
    ok: true,
    impact: {
      ingress_forward_count: asCount(ingressForward),
      egress_forward_count: asCount(egressForward),
      binding_count: asCount(binding),
      active_port_lease_count: asCount(lease),
      egress_pool_count: asCount(pool),
      blockers: [],
    },
  };
}

/* ================================================================== */
/* 投影（哈希绝不外泄）                                                 */
/* ================================================================== */

/** 节点行的对外投影：凭据状态只给三态字符串，哈希换成布尔。 */
export interface NodeLifecycleView {
  id: number;
  node_id: string;
  role: string | null;
  lifecycle: string;
  connection: NodeConnectionValue;
  accepts_new_business: boolean;
  has_credential: boolean;
  credential_revoked: boolean;
  /** 拒绝新业务时的具体原因码（`accepts_new_business=true` 时为 null）。 */
  admission_rejection: "node_waiting_install" | LifecycleConditionCode | null;
  /** 当前生命周期下所有合法迁移目标（UI 渲染可用按钮）。 */
  allowed_transitions: NodeLifecycleValue[];
}

export function lifecycleView(node: LifecycleNodeRow, now?: Date): NodeLifecycleView {
  const has_credential = typeof node.node_credential_hash === "string" && node.node_credential_hash.length > 0;
  const admission = nodeAdmission({
    lifecycle: node.lifecycle,
    status: node.status,
    last_seen_at: node.last_seen_at,
    has_credential,
    credential_revoked: node.credential_revoked,
    ...(now ? { now } : {}),
  });
  return {
    id: node.id,
    node_id: node.node_id,
    role: node.role,
    lifecycle: node.lifecycle,
    connection: deriveConnection({
      status: node.status,
      last_seen_at: node.last_seen_at,
      has_credential,
      credential_revoked: node.credential_revoked,
      ...(now ? { now } : {}),
    }),
    accepts_new_business: admission.ok,
    has_credential,
    credential_revoked: node.credential_revoked,
    admission_rejection: admission.ok ? null : admission.condition,
    allowed_transitions: allowedTransitions(node.lifecycle),
  };
}

/* ================================================================== */
/* 写：生命周期变更                                                    */
/* ================================================================== */

export interface ChangeLifecycleInput {
  lifecycle?: unknown;
  note?: unknown;
}

/**
 * 变更节点生命周期。
 *
 * 守卫顺序（不可换）：
 *   1. 入参解析（400）——先把坏形状挡掉，别让它走到 DB；
 *   2. 节点存在性（404）；
 *   3. 迁移白名单（409 `invalid_transition`，附合法目标清单）；
 *   4. 写入（lifecycle / lifecycle_updated_at / lifecycle_note）。
 *
 * `note` 的两种语义必须可区分：键缺失/undefined = 不动备注；`null`/空串 =
 * 显式清空。与 parseLifecycle 的同一约定（node-admin.ts 的 role 讨论）。
 */
export async function changeLifecycle(
  nodeId: number,
  input: ChangeLifecycleInput,
  inject?: LifecycleDeps,
): Promise<{ ok: true; node: LifecycleNodeRow; view: NodeLifecycleView } | LifecycleError> {
  const { db: pd, now } = deps(inject);

  const lifecycleParsed = parseLifecycle(input.lifecycle);
  if (!lifecycleParsed.ok) return err("invalid_input", lifecycleParsed.message);
  const noteParsed = parseLifecycleNote(input.note);
  if (!noteParsed.ok) return err("invalid_input", noteParsed.message);

  const node = await loadNode(pd, nodeId);
  if (!node) return err("not_found", "节点不存在");

  const next = lifecycleParsed.value;
  // `lifecycle` 未指定 = 本次不改生命周期。此时**仍要处理 note**：
  // 用户可能只想去掉一条过期备注。若没有 note 键，才真的什么都不做。
  if (next === null && input.note === undefined) {
    return { ok: true, node, view: lifecycleView(node, now()) };
  }

  if (next !== null && !canTransition(node.lifecycle, next)) {
    return err(
      "invalid_state",
      `不能从 ${node.lifecycle} 迁移到 ${next}；可用目标：${allowedTransitions(node.lifecycle).join(" / ") || "无"}`,
      { condition: "invalid_transition" },
    );
  }

  const data: Record<string, unknown> = {};
  if (next !== null) {
    data.lifecycle = next;
    data.lifecycle_updated_at = now();
  }
  // 键缺失 = 不动，null/空串 = 清空（见函数注释）。
  if (input.note !== undefined) data.lifecycle_note = noteParsed.value;

  let updated: LifecycleNodeRow;
  try {
    updated = asRow<LifecycleNodeRow>(await pd.node.update({ where: { id: nodeId }, data })) ?? node;
  } catch (e) {
    return toLifecycleError(e, "节点生命周期更新失败");
  }
  return { ok: true, node: updated, view: lifecycleView(updated, now()) };
}

/* ================================================================== */
/* 写：物理删除                                                        */
/* ================================================================== */

/**
 * 物理删除节点（§13.4.3：永不隐式级联删除 Forward）。
 *
 * 六道闸门全部走 {@link deleteGates}（纯函数，单独可测）；DB 层的
 * `ON DELETE CASCADE/SET NULL`（enrollment / state_report / port_lease /
 * tunnel 指针 / binding）负责清**附属**行，但**用户的 Forward 一行都不许
 * 静默消失**——tunnel 的 ingress_node_id/egress_node_id 是 `SET NULL`，
 * 这正是 schema 用 SET NULL 而非 Cascade 的原因（node-admin.ts 删池处的
 * 同一纪律）。
 */
export async function deleteNode(
  nodeId: number,
  inject?: LifecycleDeps,
): Promise<{ ok: true; id: number } | LifecycleError> {
  const { db: pd } = deps(inject);

  const node = await loadNode(pd, nodeId);
  if (!node) return err("not_found", "节点不存在");

  const impactResult = await getNodeImpact(nodeId, inject);
  if (!impactResult.ok) return impactResult;

  const gate = deleteGates({ lifecycle: node.lifecycle, impact: impactResult.impact });
  if (!gate.ok) {
    // 闸门只给 condition + message + dependencies；error code 由 condition 映射：
    // 「还没退役」是流程跳过（invalid_state），其余是依赖未清（dependency_blocked）。
    const code: LifecycleErrorCode =
      gate.condition === "node_not_retiring" ? "invalid_state" : "dependency_blocked";
    return err(code, gate.message, { condition: gate.condition, dependencies: gate.dependencies });
  }

  try {
    await pd.node.delete({ where: { id: nodeId } });
  } catch (e) {
    return toLifecycleError(e, "节点删除失败");
  }
  return { ok: true, id: nodeId };
}

/* ================================================================== */
/* 写：角色 / 端口区间的 impact 前置检查（§13.4.3）                     */
/* ================================================================== */

export interface RoleChangeCheckInput {
  /** 目标角色；`null`/undefined = 本次不改角色（只改端口区间/策略）。 */
  nextRole?: string | null;
  /** 目标端口区间；`null`/任一端点为 null = 不配置（不判悬空）。 */
  nextPortRange?: { min: number | null; max: number | null } | null;
  /** 当前 active 租约的端口列表（调用方取；`[]` = 无）。 */
  activeLeasePorts?: number[];
}

/**
 * 角色 / 端口区间变更的前置影响检查（纯函数，供 routes/node-admin.ts 的
 * PATCH role 在真正写入前调用）。
 *
 * §13.4.3 硬要求：「BOTH → EGRESS 时如果它仍作为 Ingress 承载 Forward，
 * Backend 必须阻止或要求先迁移，不得修改后再让业务随机报错。」
 *
 * 为什么在服务层而不是 DB 层：这些是**跨表业务语义**（Forward 引用 + 租约
 * 占用），放进 CHECK 约束会让 schema 背上前端规则，且 MySQL 的多表 CHECK
 * 根本不支持。
 */
export function checkRoleChange(input: {
  node: { id: number; role: string | null };
  impact: NodeImpact;
  check: RoleChangeCheckInput;
}): { ok: true } | { ok: false; condition: LifecycleConditionCode; message: string } {
  // 角色收缩检查（`nextRole` 缺失时沿用当前 role：both 保持 both 不阻塞，
  // 而 role=null 表示未声明角色 → 不判收缩）。
  const next = input.check.nextRole ?? input.node.role;
  if (next !== null && next !== undefined) {
    const hasIngress = next === "ingress" || next === "both";
    const hasEgress = next === "egress" || next === "both";

    // 丢掉入口能力，却仍有 Forward 以它为入口 → 阻止。
    if (!hasIngress && input.impact.ingress_forward_count > 0) {
      return {
        ok: false,
        condition: "node_still_used_as_ingress",
        message: `该节点仍被 ${input.impact.ingress_forward_count} 条端口转发作为入口使用，请先迁移这些转发`,
      };
    }
    // 丢掉出口能力，却仍有 Forward 以它为出口 → 阻止。
    if (!hasEgress && input.impact.egress_forward_count > 0) {
      return {
        ok: false,
        condition: "node_still_used_as_egress",
        message: `该节点仍被 ${input.impact.egress_forward_count} 条端口转发作为出口使用，请先迁移这些转发`,
      };
    }
  }

  // 端口区间检查与角色**独立**：只收端口区间也可能让租约悬空
  // （用户在 WP10 的 PATCH role 里只改了 port_range_min/max）。
  const orphaned = portRangeWouldOrphan(input.check.nextPortRange, input.check.activeLeasePorts ?? []);
  if (orphaned.length > 0) {
    return {
      ok: false,
      condition: "port_range_would_orphan_leases",
      message: `端口区间收缩会使 ${orphaned.length} 个已占用端口（${orphaned.join(", ")}）落到区间外`,
    };
  }
  return { ok: true };
}

/* ================================================================== */
/* 便捷查询（列表 / 单行投影）                                          */
/* ================================================================== */

/**
 * 取节点的 lifecycle 视图（供 GET 端点与管理端巡检）。
 *
 * 找不到 → `not_found`（与 node-admin.ts 的 `resolveNodeId` 语义一致）。
 */
export async function getNodeLifecycle(
  nodeId: number,
  inject?: LifecycleDeps,
): Promise<{ ok: true; node: LifecycleNodeRow; view: NodeLifecycleView } | LifecycleError> {
  const { db: pd, now } = deps(inject);
  const node = await loadNode(pd, nodeId);
  if (!node) return err("not_found", "节点不存在");
  return { ok: true, node, view: lifecycleView(node, now()) };
}

/** 批量取 active 租约端口（`checkRoleChange` 的输入来源，路由层调用）。 */
export async function listActiveLeasePorts(
  nodeId: number,
  inject?: LifecycleDeps,
): Promise<number[]> {
  const { db: pd } = deps(inject);
  const rows = asRows<{ port: number }>(
    await pd.nodePortLease.findMany({ where: { node_id: nodeId, status: "active" }, select: { port: true } }),
  );
  return rows.map((r) => r.port);
}
