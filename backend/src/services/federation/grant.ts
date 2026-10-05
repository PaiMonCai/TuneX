/**
 * V5.5 WP15 —— Resource Grant（host 侧权威）。契约：`docs/v5-wp14-16-federation-contract.md` §3.1。
 *
 * Grant 只回答一个问题：**host 愿意给这个 peer 多少容量、在什么范围里用**。
 * 它**不是** authorization（§1.6）：每次 intent 仍要过 host 自己的 RBAC / resource scope /
 * quota / runtime admission。本模块只实现「愿意提供多少」这一层，不实现「是谁在要」那一层。
 *
 * ── 本文件为什么还放着 lease 的词表与钩子类型 ──
 * `grant.revoke` 必须级联停掉该 grant 下的所有未释放 lease（§3.1 第 4 条），因此
 * grant.ts 需要 lease 状态词表与停服/还端口钩子。把这两样放进 lease.ts 会让
 * `grant.ts → lease.ts → grant.ts` 形成循环导入（lease 的 `planLeaseApply` 要调
 * `evaluateGrant`）。所以依赖方向被钉成**单向**：
 *
 *     errors.ts / audit.ts（WP14，Lead 维护）
 *          ↓
 *     grant.ts   ← 共享原语（错误闭集再导出、lease 状态词表、钩子类型、epoch 递增）
 *          ↓
 *     lease.ts   ← 状态机 + 两阶段预留下发
 *          ↓
 *     placement.ts（第二阶段，home 侧镜像）
 *
 * 别把这条方向反过来。
 *
 * ── 错误分层（契约 §6）──
 * 闭集来自 `./errors.ts`，**不在这里重新定义第二份**。本模块对「调用方输入非法」与
 * 「库里存量数据损坏」给不同码：前者 `grant_scope_violation` / `message_malformed`
 * （重试无用，4xx），后者 `internal_error`（服务端问题，500）。把两者压成一个码，运维
 * 就分不清「是 API 调用方写错了 scope」还是「有人手工 UPDATE 坏了 grant 行」。
 */
import { randomUUID } from "node:crypto";

import { db } from "../../db.ts";
import { recordFederationAudit, type FederationAuditInput } from "./audit.ts";
import type { FederationErrorCode } from "./errors.ts";

/* ================================================================== */
/* 跨模块共享原语（grant / lease / placement 共用的最小公约数）             */
/* ================================================================== */

/**
 * 审计出口。默认接 WP14 的 `recordFederationAudit`（Lead 维护，metadata 已做标量清洗）。
 * 测试注入替身即可离线断言「该留痕的动作确实留了痕」。
 */
export type FederationAuditSink = (input: FederationAuditInput) => void | Promise<void>;

/** 进程级默认审计出口。永不自建第二套审计（§2.5）。 */
export function defaultFederationAuditSink(input: FederationAuditInput): void | Promise<void> {
  return recordFederationAudit(input);
}

/** hop 角色（契约 §3.1 scope + §9 第一阶段只支持一个远端 hop）。 */
export const HOP_ROLES = ["ingress", "egress", "transit"] as const;
export type HopRole = (typeof HOP_ROLES)[number];

/**
 * 远端租约状态词表（契约 §3.2 + schema `federation_lease.state`）。
 * 状态机本身（允许的迁移矩阵）在 `lease.ts`；这里只放词表，供 grant 级联查询使用。
 */
export const LEASE_STATES = [
  "reserved",
  "active",
  "releasing",
  "released",
  "expired",
  "revoked",
  "failed",
] as const;
export type LeaseState = (typeof LEASE_STATES)[number];

/**
 * 未释放（非终态）状态：`grant.revoke` 的级联对象就是这些行。
 * 终态三兄弟（released / expired / revoked）**不再**被级联改写——历史事实不可重写。
 */
export const LIVE_LEASE_STATES: readonly LeaseState[] = ["reserved", "active", "releasing"];

/** 终态：状态机的吸收态，任何迁移都不得离开它们（lease.ts 的矩阵钉死这一点）。 */
export const TERMINAL_LEASE_STATES: readonly LeaseState[] = ["released", "expired", "revoked"];

export function isLiveLeaseState(state: string): boolean {
  return (LIVE_LEASE_STATES as readonly string[]).includes(state);
}

export function isTerminalLeaseState(state: string): boolean {
  return (TERMINAL_LEASE_STATES as readonly string[]).includes(state);
}

export function isLeaseState(state: string): state is LeaseState {
  return (LEASE_STATES as readonly string[]).includes(state);
}

/**
 * `federation_lease.last_error_code` 里的**账本标记**（不是契约 §6 的错误码）：
 * schema 没有独立的"端口已归还"指示位，于是用一个显式标记把"停服已成功、只剩还端口"
 * 与"停服本身就失败"区分开。靠 state 或靠 last_error 的文案去猜，会在第一次改文案时失效。
 */
export const PORT_RELEASE_PENDING_CODE = "port_release_failed";
/** `trust.ts` 的撤销级联留下的标记：租约已 revoked、停服尚未确认。 */
export const PEER_REVOKE_PENDING_CODE = "peer_revoked";

/** 跨面板动作台账里的动作（`federation_intent.action`，契约 §3.2 幂等键）。 */
export const LEASE_INTENT_ACTIONS = ["create", "apply", "release", "renew"] as const;
export type LeaseIntentAction = (typeof LEASE_INTENT_ACTIONS)[number];

/**
 * 停服钩子（契约 §3.2「host: 用自己的 orchestrator 下发」）。
 *
 * 第一版**不**在这里 import orchestrator：本模块要能离线单测（无 DB/无网络），
 * 且第二阶段才接线 `removeTunnel`。未接线时钩子**显式失败**而不是静默成功——
 * 「以为停了其实还在跑」是这套系统里最贵的 bug。
 */
export interface LeaseTeardownInput {
  lease_ref: string;
  peer_panel_id: string;
  intent_id: string;
  node_id: number | null;
  listen_port: number | null;
  hop_role: HopRole;
  lease_epoch: number;
  reason: "released" | "expired" | "revoked" | "failed";
}

export interface HookOutcome {
  ok: boolean;
  message?: string;
}

export type LeaseTeardownHook = (input: LeaseTeardownInput) => Promise<HookOutcome> | HookOutcome;

/**
 * 端口归还钩子。默认实现走 `portPool.leaseHolder` + `portPool.releaseLease`
 * （端口所有权的唯一真相是 `node_port_lease.@@unique([node_id, port])`，
 * 联邦路径**不得**自己 bind 或自己 mark 端口空闲）。
 */
export type PortReleaseHook = (input: {
  node_id: number;
  port: number;
}) => Promise<HookOutcome> | HookOutcome;

/** 端口分配钩子（默认实现走 `portPool.acquirePort`，见 lease.ts）。 */
export type PortAllocateOutcome =
  | { ok: true; port: number; port_lease_id: number | null }
  | { ok: false; code: string; message?: string };

export type PortAllocateHook = (input: {
  node_id: number;
  requested_port: number | null;
  expires_at: Date;
  peer_panel_id: string;
  intent_id: string;
  hop_role: HopRole;
  /** 该节点上已被占用的端口（legacy DIRECT 等 DB 里没有租约行的端口），透传给 portPool。 */
  reserved_ports?: readonly number[];
}) => Promise<PortAllocateOutcome> | PortAllocateOutcome;

/**
 * 本地 quota 预留钩子（契约 §3.1 第 3 条：`quota_reserved = true` 时签发即扣减、撤销/过期归还）。
 *
 * 为什么是钩子而不是直接写某张表：host 的 quota 事实存在自己的模型里（plan / workspace
 * 额度 / runtime admission），本模块不该再造一份 quota 账本。`quota_reserved = true`
 * 而钩子未接线时**拒绝签发**（fail-closed），因为「以为预留了其实没预留」等于超额签发。
 */
export interface FederationQuotaHooks {
  reserve(input: {
    peer_panel_id: string;
    workspace_id: number | null;
    grant_ref: string;
    capacity: GrantCapacity;
  }): Promise<HookOutcome> | HookOutcome;
  release(input: {
    peer_panel_id: string;
    workspace_id: number | null;
    grant_ref: string;
    capacity: GrantCapacity;
  }): Promise<HookOutcome> | HookOutcome;
}

/* ------------------------------------------------------------------ */
/* 解析结果                                                            */
/* ------------------------------------------------------------------ */

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: FederationErrorCode; message: string };

function fail<T>(code: FederationErrorCode, message: string): ParseResult<T> {
  return { ok: false, code, message };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

/** 非负整数（capacity 用）。`0` 合法且有意义：**允许 0 条 leg = 该维度不许用**。 */
function isNonNegativeInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/* ================================================================== */
/* Grant scope / capacity 的 fail-closed 解析                          */
/* ================================================================== */

/**
 * `scope`（schema `FederationGrant.scope`）：
 *
 *   { node_group_ids: number[], hop_roles: ("ingress"|"egress"|"transit")[], allow_target_policy?: string[] }
 *
 * 语义（Lead 2026-10-05 裁决，三个设计点写入契约）：
 *   · `node_group_ids` 缺省/空 = **什么都不允许**（fail-closed），不是「不限」。
 *     「缺省=不限」会让一行手工插歪的 grant 静默开放全部节点组，那是这套系统最不能接受的
 *     失败方向；而「缺省=拒绝」的最坏后果只是 intent 被拒（可解释、可发现、可修）。
 *   · `hop_roles` 同上：缺省/空 = 拒绝任何 hop 角色。
 *   · `allow_target_policy` 是**允许的策略名白名单**（string[]）；缺省/null = 不做策略名过滤
 *     （仍受 host RBAC / quota / runtime admission 约束）。它不参与「资源放置」判定，
 *     所以这里的缺省语义与前两项不同——这条不对称是刻意的，写进注释以免后人「统一」掉。
 */
export interface GrantScope {
  readonly node_group_ids: readonly number[];
  readonly hop_roles: readonly HopRole[];
  readonly allow_target_policy: readonly string[] | null;
}

const SCOPE_KEYS: ReadonlySet<string> = new Set(["node_group_ids", "hop_roles", "allow_target_policy"]);
const CAPACITY_KEYS: ReadonlySet<string> = new Set(["max_legs", "max_bandwidth_mbps", "max_connections"]);

/** 未知键 / 非法类型一律 fail-closed（§3.5）。错误码 `grant_scope_violation`（Lead 裁决）。 */
export function parseGrantScope(raw: unknown): ParseResult<GrantScope> {
  if (raw === undefined || raw === null) {
    // 完全没有 scope = 没有任何允许项。fail-closed，不是「不限」。
    return { ok: true, value: { node_group_ids: [], hop_roles: [], allow_target_policy: null } };
  }
  if (!isPlainObject(raw)) {
    return fail("grant_scope_violation", "grant scope must be a JSON object");
  }
  for (const key of Object.keys(raw)) {
    if (!SCOPE_KEYS.has(key)) {
      return fail("grant_scope_violation", `grant scope has unknown key "${key}" (fail-closed)`);
    }
  }

  const nodeGroups: number[] = [];
  const rawGroups = raw.node_group_ids;
  if (rawGroups !== undefined && rawGroups !== null) {
    if (!Array.isArray(rawGroups)) {
      return fail("grant_scope_violation", "grant scope.node_group_ids must be an array of positive integers");
    }
    for (const g of rawGroups) {
      if (!Number.isInteger(g) || (g as number) <= 0) {
        return fail("grant_scope_violation", `grant scope.node_group_ids contains a non-positive-integer: ${String(g)}`);
      }
      if (!nodeGroups.includes(g as number)) nodeGroups.push(g as number);
    }
  }

  const hopRoles: HopRole[] = [];
  const rawRoles = raw.hop_roles;
  if (rawRoles !== undefined && rawRoles !== null) {
    if (!Array.isArray(rawRoles)) {
      return fail("grant_scope_violation", "grant scope.hop_roles must be an array of ingress|egress|transit");
    }
    for (const r of rawRoles) {
      if (typeof r !== "string" || !(HOP_ROLES as readonly string[]).includes(r)) {
        return fail("grant_scope_violation", `grant scope.hop_roles contains an unknown hop role: ${String(r)}`);
      }
      if (!hopRoles.includes(r as HopRole)) hopRoles.push(r as HopRole);
    }
  }

  let targetPolicy: string[] | null = null;
  const rawPolicy = raw.allow_target_policy;
  if (rawPolicy !== undefined && rawPolicy !== null) {
    if (!Array.isArray(rawPolicy)) {
      return fail("grant_scope_violation", "grant scope.allow_target_policy must be an array of non-empty strings");
    }
    targetPolicy = [];
    for (const p of rawPolicy) {
      if (typeof p !== "string" || p.trim().length === 0) {
        return fail("grant_scope_violation", "grant scope.allow_target_policy must contain non-empty strings");
      }
      if (!targetPolicy.includes(p)) targetPolicy.push(p);
    }
  }

  return { ok: true, value: { node_group_ids: nodeGroups, hop_roles: hopRoles, allow_target_policy: targetPolicy } };
}

/**
 * `capacity`（schema `FederationGrant.capacity`）：`{ max_legs, max_bandwidth_mbps, max_connections }`。
 * 三项都可空/可为 null = 该维度**不限**（仍受本地 quota 约束），这是 schema 注释的既定口径。
 * 非法（负数 / 非整数 / 未知键）→ fail-closed。`0` 是合法值：允许零条 leg。
 */
export interface GrantCapacity {
  readonly max_legs: number | null;
  readonly max_bandwidth_mbps: number | null;
  readonly max_connections: number | null;
}

export function parseGrantCapacity(raw: unknown): ParseResult<GrantCapacity> {
  const unlimited: GrantCapacity = { max_legs: null, max_bandwidth_mbps: null, max_connections: null };
  if (raw === undefined || raw === null) return { ok: true, value: unlimited };
  if (!isPlainObject(raw)) {
    return fail("message_malformed", "grant capacity must be a JSON object");
  }
  for (const key of Object.keys(raw)) {
    if (!CAPACITY_KEYS.has(key)) {
      return fail("message_malformed", `grant capacity has unknown key "${key}" (fail-closed)`);
    }
  }
  const read = (key: keyof GrantCapacity): number | null | ParseResult<never> => {
    const v = raw[key];
    if (v === undefined || v === null) return null;
    if (!isNonNegativeInteger(v)) {
      return fail("message_malformed", `grant capacity.${key} must be a non-negative integer or null`);
    }
    return v;
  };
  const legs = read("max_legs");
  if (typeof legs === "object" && legs !== null) return legs as ParseResult<GrantCapacity>;
  const bw = read("max_bandwidth_mbps");
  if (typeof bw === "object" && bw !== null) return bw as ParseResult<GrantCapacity>;
  const conns = read("max_connections");
  if (typeof conns === "object" && conns !== null) return conns as ParseResult<GrantCapacity>;
  return {
    ok: true,
    value: { max_legs: legs as number | null, max_bandwidth_mbps: bw as number | null, max_connections: conns as number | null },
  };
}

/* ================================================================== */
/* epoch：单调递增，绝不复用、绝不回退                                    */
/* ================================================================== */

/**
 * 下一个 grant_epoch。
 *
 * 读取到的 epoch 不合法（负数 / 非整数）时**抛错**而不是"猜一个"：那意味着库里的行被外部
 * 写坏了，此时继续 +1 会把一个不可信的世代沿用到 fencing 判定里。抛错 = 不写入，
 * 由调用方决定怎么处理（这是「fail-closed」在纯函数里的形态）。
 */
export function nextGrantEpoch(previous: number | null | undefined): number {
  if (previous === null || previous === undefined) return 1;
  if (!Number.isInteger(previous) || previous < 0) {
    throw new Error(`federation: invalid grant_epoch ${String(previous)} (fail-closed, refusing to roll it forward)`);
  }
  return previous + 1;
}

/** lease_epoch 同规则；`null` = 该谱系从未有过占用 → 从 1 起（0 专表示"从未归属"）。 */
export function nextLeaseEpoch(previous: number | null | undefined): number {
  if (previous === null || previous === undefined) return 1;
  if (!Number.isInteger(previous) || previous < 0) {
    throw new Error(`federation: invalid lease_epoch ${String(previous)} (fail-closed, refusing to roll it forward)`);
  }
  return previous + 1;
}

/* ================================================================== */
/* grant 判定                                                          */
/* ================================================================== */

export const GRANT_STATUSES = ["active", "suspended", "revoked", "expired"] as const;
export type GrantStatus = (typeof GRANT_STATUSES)[number];

export function isGrantStatus(s: string): s is GrantStatus {
  return (GRANT_STATUSES as readonly string[]).includes(s);
}

/** 判定用的 grant 投影（DB 行是它的超集）。 */
export interface GrantRowLike {
  grant_ref?: string | null;
  peer_panel_id?: string | null;
  workspace_id?: number | null;
  grant_epoch?: number | null;
  status?: string | null;
  scope: unknown;
  capacity: unknown;
  expires_at: Date;
}

export interface EvaluateGrantInput {
  grant: GrantRowLike;
  /** 本次 intent 想用的 hop 角色。 */
  hopRole: string;
  /** host 侧物理节点所属的 node group（null = 还不知道/未指定）。 */
  nodeGroupId: number | null;
  /** 消费方 workspace（grant.workspace_id 非空时必须一致；null = 调用方没给）。 */
  workspaceId: number | null;
  /** 该 grant 当前**已占用**的 leg 数（host 自己算，本函数不查库）。 */
  activeLegs: number;
  /** 本次要新增的 leg 数（默认 1；续约传 0）。 */
  requestedLegs?: number;
  /** 请求的 target 策略名（可为 null = 用默认策略）。 */
  requestedTargetPolicy?: string | null;
  /** 可选：当前已占用的带宽/连接（给了才做对应维度判定）。 */
  activeBandwidthMbps?: number | null;
  activeConnections?: number | null;
  now: Date;
}

export type GrantDecision =
  | {
      allow: true;
      grant_epoch: number;
      scope: GrantScope;
      capacity: GrantCapacity;
      expires_at: Date;
    }
  | { allow: false; code: FederationErrorCode; message: string };

/**
 * 判定一次 intent 能不能被这个 grant 接住。
 *
 * 判定顺序是**有意的**：先用"最不可能随环境变化"的条件拒（状态/过期/范围），再判容量。
 * 这样同一个越权请求在不同时刻拿到的拒绝理由是稳定的，运维不用对着时钟猜。
 *
 * 注意 `suspended`：它**只**拒新 intent（Lead 裁决 Q2），已有 lease 继续跑；
 * 但续约走 `requestedLegs: 0` 的同一条函数——见 `lease.ts` 的 `evaluateLeaseRenewal`，
 * 那里对 suspended 同样是拒，于是"暂停"不会退化成"无限期继续服务"。
 */
export function evaluateGrant(input: EvaluateGrantInput): GrantDecision {
  const { grant } = input;

  const status = grant.status ?? "active";
  if (!isGrantStatus(status)) {
    // 存量数据损坏（不是调用方输入问题）→ 500 语义，但仍然 fail-closed 拒绝。
    return { allow: false, code: "internal_error", message: `grant has unknown status "${String(grant.status)}"` };
  }

  const scopeParsed = parseGrantScope(grant.scope);
  if (!scopeParsed.ok) return { allow: false, code: scopeParsed.code, message: scopeParsed.message };
  const scope = scopeParsed.value;

  const capacityParsed = parseGrantCapacity(grant.capacity);
  if (!capacityParsed.ok) {
    return {
      allow: false,
      code: "internal_error",
      message: `stored grant capacity is malformed: ${capacityParsed.message}`,
    };
  }
  const capacity = capacityParsed.value;

  if (status === "revoked") {
    return { allow: false, code: "grant_not_active", message: `grant ${grant.grant_ref ?? "?"} is revoked` };
  }
  if (status === "suspended") {
    return { allow: false, code: "grant_not_active", message: `grant ${grant.grant_ref ?? "?"} is suspended` };
  }
  if (status === "expired") {
    return { allow: false, code: "grant_expired", message: `grant ${grant.grant_ref ?? "?"} is expired` };
  }

  const expiresAt = grant.expires_at;
  if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime())) {
    return { allow: false, code: "internal_error", message: "grant expires_at is not a valid Date" };
  }
  if (expiresAt.getTime() <= input.now.getTime()) {
    return {
      allow: false,
      code: "grant_expired",
      message: `grant ${grant.grant_ref ?? "?"} expired at ${expiresAt.toISOString()}`,
    };
  }

  // workspace 范围：grant 指定了 workspace 就必须一致；调用方没说是谁 → 拒绝（不能拿不属于
  // 任何 workspace 的请求去消费某个 workspace 专用的 grant）。
  if (grant.workspace_id !== null && grant.workspace_id !== undefined) {
    if (input.workspaceId !== grant.workspace_id) {
      return {
        allow: false,
        code: "grant_scope_violation",
        message: `grant is scoped to workspace ${grant.workspace_id}, request belongs to ${input.workspaceId === null ? "no workspace" : `workspace ${input.workspaceId}`}`,
      };
    }
  }

  if (!(HOP_ROLES as readonly string[]).includes(input.hopRole)) {
    return { allow: false, code: "message_malformed", message: `unknown hop_role "${String(input.hopRole)}"` };
  }
  if (!scope.hop_roles.includes(input.hopRole as HopRole)) {
    return {
      allow: false,
      code: "grant_scope_violation",
      message: `hop_role "${input.hopRole}" is not in the granted hop_roles [${scope.hop_roles.join(", ")}]`,
    };
  }

  if (input.nodeGroupId === null || !scope.node_group_ids.includes(input.nodeGroupId)) {
    return {
      allow: false,
      code: "grant_scope_violation",
      message: `node_group ${input.nodeGroupId === null ? "(unknown)" : input.nodeGroupId} is not in the granted node_group_ids [${scope.node_group_ids.join(", ")}]`,
    };
  }

  if (scope.allow_target_policy !== null && input.requestedTargetPolicy !== null && input.requestedTargetPolicy !== undefined) {
    if (!scope.allow_target_policy.includes(input.requestedTargetPolicy)) {
      return {
        allow: false,
        code: "grant_scope_violation",
        message: `target policy "${input.requestedTargetPolicy}" is not allowed by this grant`,
      };
    }
  }

  const requestedLegs = input.requestedLegs ?? 1;
  if (!Number.isInteger(requestedLegs) || requestedLegs < 0) {
    return { allow: false, code: "message_malformed", message: `requestedLegs must be a non-negative integer` };
  }
  if (!Number.isInteger(input.activeLegs) || input.activeLegs < 0) {
    return { allow: false, code: "internal_error", message: "activeLegs must be a non-negative integer" };
  }

  if (capacity.max_legs !== null && input.activeLegs + requestedLegs > capacity.max_legs) {
    return {
      allow: false,
      code: "quota_exhausted",
      message: `grant leg capacity exhausted: ${input.activeLegs} in use + ${requestedLegs} requested > max_legs ${capacity.max_legs}`,
    };
  }
  if (
    capacity.max_bandwidth_mbps !== null &&
    typeof input.activeBandwidthMbps === "number" &&
    input.activeBandwidthMbps > capacity.max_bandwidth_mbps
  ) {
    return {
      allow: false,
      code: "quota_exhausted",
      message: `grant bandwidth capacity exhausted: ${input.activeBandwidthMbps} > max_bandwidth_mbps ${capacity.max_bandwidth_mbps}`,
    };
  }
  if (
    capacity.max_connections !== null &&
    typeof input.activeConnections === "number" &&
    input.activeConnections > capacity.max_connections
  ) {
    return {
      allow: false,
      code: "quota_exhausted",
      message: `grant connection capacity exhausted: ${input.activeConnections} > max_connections ${capacity.max_connections}`,
    };
  }

  return { allow: true, grant_epoch: grant.grant_epoch ?? 1, scope, capacity, expires_at: expiresAt };
}

/* ================================================================== */
/* DB 接缝                                                             */
/* ================================================================== */

export interface GrantRow {
  id: number;
  grant_ref: string;
  peer_id: number;
  /** 由读取方一并 select（审计与级联需要）；写入路径可以不填。 */
  peer_panel_id?: string | null;
  workspace_id: number | null;
  grant_epoch: number;
  status: string;
  scope: unknown;
  capacity: unknown;
  quota_reserved: boolean;
  expires_at: Date;
  revoked_at: Date | null;
  created_by_id: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface PeerRow {
  id: number;
  peer_panel_id: string;
  status: string;
  display_name?: string | null;
}

export interface LeaseRowForCascade {
  id: number;
  lease_ref: string;
  grant_id: number;
  peer_panel_id: string;
  forward_ref: string;
  intent_id: string;
  state: string;
  lease_epoch: number;
  hop_role: string;
  node_id: number | null;
  listen_port: number | null;
  assigned?: unknown;
}

/** 本模块需要的 Prisma 最小接口（`db` 满足之；测试用内存替身，见 federation-grant.test.ts）。 */
export interface GrantDb {
  federationPeer: {
    findUnique(args: unknown): Promise<unknown>;
  };
  federationGrant: {
    findUnique(args: unknown): Promise<unknown>;
    findFirst(args: unknown): Promise<unknown>;
    findMany(args: unknown): Promise<unknown>;
    create(args: unknown): Promise<unknown>;
    updateMany(args: unknown): Promise<unknown>;
  };
  federationLease: {
    findMany(args: unknown): Promise<unknown>;
    updateMany(args: unknown): Promise<unknown>;
  };
}

export interface GrantDeps {
  db?: GrantDb;
  audit?: FederationAuditSink;
  now?: () => Date;
  quota?: FederationQuotaHooks;
  /**
   * 级联停服钩子（revoke / expire）。**不传** = 用进程级注册的生产实现
   * （由 `lease.ts` 在模块加载时注册 `orchestrator.removeTunnel`，见
   * {@link registerFederationCascadeHooks}）；传 `null` = 显式禁用（测试）。
   * 两者都没有时**显式失败**并记账（reconcile 扫尾会补），绝不静默假装停服成功。
   */
  teardown?: LeaseTeardownHook | null;
  /** 端口归还钩子（级联时在停服成功之后调用）。语义同 {@link GrantDeps.teardown}。 */
  releasePort?: PortReleaseHook | null;
}

/**
 * 进程级级联钩子注册表。
 *
 * 为什么需要这一层：`grant.ts` **不能** import `lease.ts`（lease 的 `planLeaseApply` 要调
 * `evaluateGrant`，反向 import 就是循环依赖），但 `revokeGrant` 的级联又必须能停服 + 还端口。
 * 于是由 `lease.ts` 在模块加载时把**唯一那份**生产实现注册进来，grant 侧只查表——
 * 这样既没有循环依赖，也没有第二份停服实现。
 */
let registeredCascadeHooks: { teardown: LeaseTeardownHook | null; releasePort: PortReleaseHook | null } = {
  teardown: null,
  releasePort: null,
};

export function registerFederationCascadeHooks(hooks: {
  teardown: LeaseTeardownHook;
  releasePort: PortReleaseHook;
}): void {
  registeredCascadeHooks = { teardown: hooks.teardown, releasePort: hooks.releasePort };
}

interface ResolvedGrantDeps {
  db: GrantDb;
  audit: FederationAuditSink;
  now: () => Date;
  quota: FederationQuotaHooks | null;
  teardown: LeaseTeardownHook | null;
  releasePort: PortReleaseHook | null;
}

const defaultGrantDb = db as unknown as GrantDb;

function resolveGrantDeps(over?: GrantDeps): ResolvedGrantDeps {
  return {
    db: over?.db ?? defaultGrantDb,
    audit: over?.audit ?? defaultFederationAuditSink,
    now: over?.now ?? (() => new Date()),
    quota: over?.quota ?? null,
    // `undefined` = 用注册的生产实现；`null` = 显式禁用。
    teardown: over?.teardown === undefined ? registeredCascadeHooks.teardown : over.teardown,
    releasePort: over?.releasePort === undefined ? registeredCascadeHooks.releasePort : over.releasePort,
  };
}

/** Prisma P2002（唯一约束）判定——与 `portPool.isUniqueConflict` 同口径。 */
function isUniqueConflict(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";
}

async function audit(deps: ResolvedGrantDeps, input: FederationAuditInput): Promise<void> {
  try {
    await deps.audit(input);
  } catch (e) {
    // 审计是旁路：写不进去也不能改变业务结果（与 writeAudit 同取向）。
    console.warn("[federation] grant audit failed:", e instanceof Error ? e.message : e);
  }
}

/* ================================================================== */
/* 签发 / 撤销 / 挂起 / 到期                                            */
/* ================================================================== */

export interface CreateGrantInput {
  peerPanelId: string;
  workspaceId?: number | null;
  scope: unknown;
  capacity?: unknown;
  expiresAt: Date;
  quotaReserved?: boolean;
  createdById?: number | null;
}

export type CreateGrantOutcome =
  | { ok: true; grant: GrantRow; scope: GrantScope; capacity: GrantCapacity }
  | { ok: false; code: FederationErrorCode; message: string };

/**
 * 签发 grant。
 *
 * 顺序：解析（fail-closed，不写任何行）→ peer 必须 trusted → quota 预留（若声明）→ 落行 → 审计。
 * `quota_reserved = true` 但没接线 quota 钩子时**拒绝签发**：宁可让管理员看到"配额钩子未接线"，
 * 也不要产生一张"声称预留了额度、实际没预留"的 grant——那是超额的合法化。
 */
export async function createGrant(input: CreateGrantInput, deps?: GrantDeps): Promise<CreateGrantOutcome> {
  const d = resolveGrantDeps(deps);
  const now = d.now();

  const scopeParsed = parseGrantScope(input.scope);
  if (!scopeParsed.ok) return { ok: false, code: scopeParsed.code, message: scopeParsed.message };

  const capacityParsed = parseGrantCapacity(input.capacity ?? null);
  if (!capacityParsed.ok) return { ok: false, code: capacityParsed.code, message: capacityParsed.message };

  if (!(input.expiresAt instanceof Date) || Number.isNaN(input.expiresAt.getTime())) {
    return { ok: false, code: "message_malformed", message: "grant expiresAt must be a valid Date" };
  }
  if (input.expiresAt.getTime() <= now.getTime()) {
    // 不允许签发一张出生即过期的 grant（"续期掩盖过期"的反面：先过期再说就永远读不懂）。
    return { ok: false, code: "grant_expired", message: "grant expiresAt must be in the future" };
  }
  if (typeof input.peerPanelId !== "string" || input.peerPanelId.length === 0) {
    return { ok: false, code: "message_malformed", message: "peerPanelId is required" };
  }

  const peer = (await d.db.federationPeer.findUnique({
    where: { peer_panel_id: input.peerPanelId },
    select: { id: true, peer_panel_id: true, status: true },
  })) as PeerRow | null;
  if (!peer) return { ok: false, code: "peer_unknown", message: `peer ${input.peerPanelId} is not known` };
  if (peer.status === "revoked") {
    return { ok: false, code: "peer_revoked", message: `peer ${input.peerPanelId} trust is revoked` };
  }
  if (peer.status !== "trusted") {
    return {
      ok: false,
      code: "peer_unknown",
      message: `peer ${input.peerPanelId} is not trusted yet (status=${peer.status})`,
    };
  }

  const quotaReserved = input.quotaReserved === true;
  if (quotaReserved && d.quota === null) {
    return {
      ok: false,
      code: "internal_error",
      message: "quota_reserved grant requires a wired quota hook (refusing to claim a reservation that was never made)",
    };
  }

  const grantRef = randomUUID();
  if (quotaReserved && d.quota !== null) {
    const reserved = await d.quota.reserve({
      peer_panel_id: input.peerPanelId,
      workspace_id: input.workspaceId ?? null,
      grant_ref: grantRef,
      capacity: capacityParsed.value,
    });
    if (!reserved.ok) {
      return {
        ok: false,
        code: "quota_exhausted",
        message: reserved.message ?? "local quota does not allow this grant",
      };
    }
  }

  let row: GrantRow;
  try {
    row = (await d.db.federationGrant.create({
      data: {
        peer_id: peer.id,
        grant_ref: grantRef,
        workspace_id: input.workspaceId ?? null,
        grant_epoch: 1,
        status: "active",
        scope: scopeParsed.value as unknown as object,
        capacity: capacityParsed.value as unknown as object,
        quota_reserved: quotaReserved,
        expires_at: input.expiresAt,
        created_by_id: input.createdById ?? null,
      },
    })) as GrantRow;
    row.peer_panel_id = input.peerPanelId;
  } catch (e) {
    // 补偿：行没落成 → 预留必须立刻归还，否则额度会凭空少一块且没有任何 grant 引用它。
    if (quotaReserved && d.quota !== null) {
      const released = await d.quota.release({
        peer_panel_id: input.peerPanelId,
        workspace_id: input.workspaceId ?? null,
        grant_ref: grantRef,
        capacity: capacityParsed.value,
      });
      if (!released.ok) {
        console.error(
          `[federation] grant ${grantRef} create failed AND quota rollback failed: ${released.message ?? "unknown"}`,
        );
      }
    }
    return { ok: false, code: "internal_error", message: e instanceof Error ? e.message : String(e) };
  }

  await audit(d, {
    action: "grant.create",
    direction: "local",
    peer_panel_id: input.peerPanelId,
    status: 201,
    workspace_id: input.workspaceId ?? null,
    detail: {
      grant_ref: row.grant_ref,
      grant_epoch: row.grant_epoch,
      expires_at: row.expires_at.toISOString(),
      quota_reserved: quotaReserved,
      max_legs: capacityParsed.value.max_legs,
      node_group_ids: scopeParsed.value.node_group_ids.length,
      hop_roles: scopeParsed.value.hop_roles.join(","),
    },
  });

  return { ok: true, grant: row, scope: scopeParsed.value, capacity: capacityParsed.value };
}

export interface RevokeGrantResult {
  ok: true;
  already_revoked: boolean;
  grant_epoch: number;
  /** 被级联改写为 revoked 的 lease 数。 */
  leases_revoked: number;
  teardown_ok: number;
  teardown_failed: number;
  ports_released: number;
  /** 停服没成功 → 端口**不还**（顺序铁律），留给 reconcile 重试。 */
  ports_pending: number;
  quota_released: boolean;
  /** 级联里 CAS 输给并发写的 lease 数（重读后由下一拍收敛）。 */
  raced: number;
}

export type RevokeGrantOutcome =
  | RevokeGrantResult
  | { ok: false; code: FederationErrorCode; message: string };

export interface GrantRefInput {
  grantRef?: string | null;
  grantId?: number | null;
}

function grantWhere(input: GrantRefInput): Record<string, unknown> | null {
  if (typeof input.grantRef === "string" && input.grantRef.length > 0) return { grant_ref: input.grantRef };
  if (typeof input.grantId === "number" && Number.isInteger(input.grantId)) return { id: input.grantId };
  return null;
}

async function loadGrant(d: ResolvedGrantDeps, input: GrantRefInput): Promise<GrantRow | null> {
  const where = grantWhere(input);
  if (where === null) return null;
  // `peer_panel_id` 在 peer 关系上（grant 行只有 peer_id），一并 select 后拍平：审计与级联
  // 都需要它，让每个调用方各自再查一次 peer 是没有必要的 N+1。
  const row = (await d.db.federationGrant.findUnique({
    where,
    include: { peer: { select: { peer_panel_id: true } } },
  })) as (GrantRow & { peer?: { peer_panel_id?: string | null } | null }) | null;
  if (row === null || row === undefined) return null;
  return { ...row, peer_panel_id: row.peer_panel_id ?? row.peer?.peer_panel_id ?? null };
}

/**
 * 撤销 grant（契约 §3.1 第 4 条 + §2.4）。
 *
 * 三个不可协商的点：
 *   1. **撤销不可逆**：状态只进不出，重复撤销是幂等成功（不是错误），但绝不"复活"；
 *   2. **级联停服**：该 grant 下所有未释放 lease 立即 → `revoked`，并调用停服钩子；
 *   3. **顺序铁律**：先停服、后还端口。停服没成功的 lease **不还端口**——一个可能还在
 *      listen 的 socket 配上"端口已空闲"的账，就是下一个撞号事故。这些行留 `last_error_code`
 *      给 reconcile 重试。
 *
 * 与"续期"的关系：撤销后重新授予必须走**新的 grant 行**（新 epoch），不允许把同一行改回 active。
 */
export async function revokeGrant(
  input: GrantRefInput & { now?: Date; reason?: string },
  deps?: GrantDeps,
): Promise<RevokeGrantOutcome> {
  const d = resolveGrantDeps(deps);
  const now = input.now ?? d.now();

  const grant = await loadGrant(d, input);
  if (grant === null) return { ok: false, code: "grant_not_found", message: "grant not found" };

  const alreadyRevoked = grant.status === "revoked";
  let newEpoch = grant.grant_epoch;

  if (!alreadyRevoked) {
    newEpoch = nextGrantEpoch(grant.grant_epoch);
    // CAS：撤销是"实质变更"，必须把 epoch 推进一格。读后写会让两个并发撤销各自写出
    // 自己的 epoch；CAS 输的一方拿不到 0 行，于是如实报告竞争而不是假装成功。
    const updated = (await d.db.federationGrant.updateMany({
      where: { id: grant.id, grant_epoch: grant.grant_epoch },
      data: { status: "revoked", grant_epoch: newEpoch, revoked_at: now },
    })) as { count: number };
    if (updated.count === 0) {
      return {
        ok: false,
        code: "internal_error",
        message: "grant revoke lost the grant_epoch CAS race; re-read and retry",
      };
    }
  }

  const cascade = await cascadeRevokeLeases(d, grant, now);

  let quotaReleased = false;
  if (grant.quota_reserved) {
    if (d.quota === null) {
      console.warn(`[federation] grant ${grant.grant_ref} is quota_reserved but no quota hook is wired; reservation NOT returned`);
    } else {
      const capacityParsed = parseGrantCapacity(grant.capacity);
      const released = await d.quota.release({
        peer_panel_id: grant.peer_panel_id ?? "",
        workspace_id: grant.workspace_id,
        grant_ref: grant.grant_ref,
        capacity: capacityParsed.ok
          ? capacityParsed.value
          : { max_legs: null, max_bandwidth_mbps: null, max_connections: null },
      });
      quotaReleased = released.ok;
      if (!released.ok) {
        console.warn(`[federation] grant ${grant.grant_ref} quota release failed: ${released.message ?? "unknown"}`);
      }
    }
  }

  await audit(d, {
    action: "grant.revoke",
    direction: "local",
    peer_panel_id: grant.peer_panel_id ?? "",
    status: 200,
    workspace_id: grant.workspace_id,
    detail: {
      grant_ref: grant.grant_ref,
      grant_epoch: newEpoch,
      already_revoked: alreadyRevoked,
      leases_revoked: cascade.leases_revoked,
      teardown_failed: cascade.teardown_failed,
      reason: input.reason ?? null,
    },
  });

  return {
    ok: true,
    already_revoked: alreadyRevoked,
    grant_epoch: newEpoch,
    ...cascade,
    quota_released: quotaReleased,
  };
}

/**
 * 级联：把该 grant 下未释放的 lease 置 `revoked` 并停服。
 *
 * 状态置位的顺序是刻意的：**先写 `revoked`（权威事实 = 这条链路不许再服务），再尽力停服**。
 * 反过来的话，停服失败就会让行保持 `active`，而 `active` 会被下一拍 reconcile 当作"还在服务"
 * 并可能被续约——fail-closed 的要求是"拿不准时它必须停"，所以状态先落。
 * 停服失败与端口未归还都记进 `last_error_code/last_error`，reconcile 据此重试。
 */
async function cascadeRevokeLeases(
  d: ResolvedGrantDeps,
  grant: GrantRow,
  now: Date,
): Promise<Omit<RevokeGrantResult, "ok" | "already_revoked" | "grant_epoch" | "quota_released">> {
  const leases = (await d.db.federationLease.findMany({
    where: { grant_id: grant.id, state: { in: LIVE_LEASE_STATES as unknown as string[] } },
    select: {
      id: true,
      lease_ref: true,
      grant_id: true,
      peer_panel_id: true,
      forward_ref: true,
      intent_id: true,
      state: true,
      lease_epoch: true,
      hop_role: true,
      node_id: true,
      listen_port: true,
    },
  })) as LeaseRowForCascade[];

  let revoked = 0;
  let teardownOk = 0;
  let teardownFailed = 0;
  let portsReleased = 0;
  let portsPending = 0;
  let raced = 0;

  for (const lease of leases) {
    const hopRole = (HOP_ROLES as readonly string[]).includes(lease.hop_role)
      ? (lease.hop_role as HopRole)
      : "egress";
    let stopped = false;
    let stopError: string | null = null;
    if (d.teardown === null) {
      stopError = "teardown hook is not wired; service may still be running (reconcile must retry)";
    } else {
      const res = await d.teardown({
        lease_ref: lease.lease_ref,
        peer_panel_id: lease.peer_panel_id,
        intent_id: lease.intent_id,
        node_id: lease.node_id,
        listen_port: lease.listen_port,
        hop_role: hopRole,
        lease_epoch: lease.lease_epoch,
        reason: "revoked",
      });
      stopped = res.ok;
      if (!res.ok) stopError = res.message ?? "teardown failed";
    }

    const data: Record<string, unknown> = {
      state: "revoked",
      released_at: now,
      last_error_code: stopped ? null : "internal_error",
      last_error: stopped ? null : stopError,
    };

    // epoch + 旧状态一起做 CAS：并发释放/续约赢了我们就不覆盖它（它已经是更新的世代）。
    const updated = (await d.db.federationLease.updateMany({
      where: { id: lease.id, lease_epoch: lease.lease_epoch, state: lease.state },
      data,
    })) as { count: number };
    if (updated.count === 0) {
      raced++;
      continue;
    }
    revoked++;
    if (stopped) teardownOk++;
    else teardownFailed++;

    // 先停服、后还端口（§3.3）。停服没成功就不还——见本函数头注释。
    if (lease.node_id !== null && lease.listen_port !== null && !stopped) {
      // 停服没成功却在库里"还了端口"会让下一个分配者撞上一个仍在 listen 的 socket。
      portsPending++;
    }
    if (stopped && lease.node_id !== null && lease.listen_port !== null) {
      if (d.releasePort === null) {
        portsPending++;
        await d.db.federationLease.updateMany({
          where: { id: lease.id, lease_epoch: lease.lease_epoch },
          data: {
            last_error_code: PORT_RELEASE_PENDING_CODE,
            last_error: "port release hook is not wired; port lease will be reclaimed by portPool reconcile",
          },
        });
      } else {
        // 钩子**抛**也必须被接住：它是在级联中途调用的，一次抛异常会让"撤销做了一半且没有记录"。
        // 任何异常都退化成"停服成功、端口待还"这个已有状态（扫尾只补还端口，不再拆 runtime）。
        const rel = await Promise.resolve()
          .then(() => d.releasePort!({ node_id: lease.node_id!, port: lease.listen_port! }))
          .catch((e: unknown) => ({ ok: false as const, message: e instanceof Error ? e.message : String(e) }));
        if (rel.ok) portsReleased++;
        else {
          portsPending++;
          // 停服已成功、只剩端口：用**显式标记**记着，扫尾据此只重试还端口而不是再拆一次 runtime。
          await d.db.federationLease.updateMany({
            where: { id: lease.id, lease_epoch: lease.lease_epoch },
            data: {
              last_error_code: PORT_RELEASE_PENDING_CODE,
              last_error: rel.message ?? "port release failed",
            },
          });
        }
      }
    }
  }

  return {
    leases_revoked: revoked,
    teardown_ok: teardownOk,
    teardown_failed: teardownFailed,
    ports_released: portsReleased,
    ports_pending: portsPending,
    raced,
  };
}

export type SuspendGrantOutcome =
  | { ok: true; already_suspended: boolean; grant_epoch: number }
  | { ok: false; code: FederationErrorCode; message: string };

/**
 * 挂起 grant（Lead 2026-10-05 裁决 Q2）。
 *
 * 语义被刻意限死在两点上：
 *   · **只拒新 intent**（`grant_not_active`）：已有 active lease 继续跑、端口继续占、配额不归还；
 *   · **到期不再续**：续约走 `lease.ts` 的 `evaluateLeaseRenewal`，那里同样把 suspended 判为拒。
 *     少了后半句，"暂停"就会变成"无限期继续服务"——比不暂停更糟，因为它给了管理员
 *     一个假的截止承诺。
 *
 * 重复挂起是幂等成功，**不**推进 epoch：epoch 记的是"实质变更"的次数，不是调用次数。
 */
export async function suspendGrant(
  input: GrantRefInput & { now?: Date; reason?: string },
  deps?: GrantDeps,
): Promise<SuspendGrantOutcome> {
  const d = resolveGrantDeps(deps);
  const now = input.now ?? d.now();

  const grant = await loadGrant(d, input);
  if (grant === null) return { ok: false, code: "grant_not_found", message: "grant not found" };
  if (grant.status === "revoked") {
    return { ok: false, code: "grant_not_active", message: "grant is revoked; revocation is irreversible" };
  }
  if (grant.status === "expired") {
    return { ok: false, code: "grant_expired", message: "grant is already expired" };
  }
  if (grant.status === "suspended") {
    return { ok: true, already_suspended: true, grant_epoch: grant.grant_epoch };
  }

  const newEpoch = nextGrantEpoch(grant.grant_epoch);
  const updated = (await d.db.federationGrant.updateMany({
    where: { id: grant.id, grant_epoch: grant.grant_epoch },
    data: { status: "suspended", grant_epoch: newEpoch },
  })) as { count: number };
  if (updated.count === 0) {
    return { ok: false, code: "internal_error", message: "grant suspend lost the grant_epoch CAS race; re-read and retry" };
  }

  await audit(d, {
    action: "grant.suspend",
    direction: "local",
    peer_panel_id: grant.peer_panel_id ?? "",
    status: 200,
    workspace_id: grant.workspace_id,
    detail: { grant_ref: grant.grant_ref, grant_epoch: newEpoch, reason: input.reason ?? null },
  });

  return { ok: true, already_suspended: false, grant_epoch: newEpoch };
}

/**
 * 恢复被挂起的 grant。
 *
 * 不在 task-3 的清单里，但"挂起可逆"是挂起本身的意义（否则它就该叫 revoke）；缺了它，
 * `suspend` 只能在管理员手工改库时才能退出。epoch 推进一格（范围/可服务性变了）。
 */
export async function resumeGrant(
  input: GrantRefInput & { now?: Date },
  deps?: GrantDeps,
): Promise<SuspendGrantOutcome> {
  const d = resolveGrantDeps(deps);
  const grant = await loadGrant(d, input);
  if (grant === null) return { ok: false, code: "grant_not_found", message: "grant not found" };
  if (grant.status === "revoked") {
    return { ok: false, code: "grant_not_active", message: "grant is revoked; revocation is irreversible" };
  }
  if (grant.status === "expired") {
    return { ok: false, code: "grant_expired", message: "grant is expired; issue a new grant instead" };
  }
  if (grant.status === "active") return { ok: true, already_suspended: false, grant_epoch: grant.grant_epoch };
  if (d.now().getTime() >= grant.expires_at.getTime()) {
    // 不许"用恢复绕过过期"：续期必须新开 epoch（§3.1）。这里只拒绝，由 expireGrants 落状态。
    return { ok: false, code: "grant_expired", message: "grant already passed expires_at" };
  }

  const newEpoch = nextGrantEpoch(grant.grant_epoch);
  const updated = (await d.db.federationGrant.updateMany({
    where: { id: grant.id, grant_epoch: grant.grant_epoch, status: "suspended" },
    data: { status: "active", grant_epoch: newEpoch },
  })) as { count: number };
  if (updated.count === 0) {
    return { ok: false, code: "internal_error", message: "grant resume lost the CAS race; re-read and retry" };
  }

  await audit(d, {
    action: "grant.resume",
    direction: "local",
    peer_panel_id: grant.peer_panel_id ?? "",
    status: 200,
    workspace_id: grant.workspace_id,
    detail: { grant_ref: grant.grant_ref, grant_epoch: newEpoch },
  });

  return { ok: true, already_suspended: false, grant_epoch: newEpoch };
}

export interface ExpireGrantsResult {
  /** 扫描到的候选（未过期的不计入）。 */
  evaluated: number;
  expired: number;
  quota_returned: number;
  quota_return_failed: number;
}

/**
 * 到期扫描：把 `expires_at` 已过的 active/suspended grant 落成 `expired` 并归还预留配额。
 *
 * 归 Lead 的 WP16 周期 reconcile 调用（§4.3 的那一拍）。**注意它不停服**：grant 到期后
 * 已有 lease 由 `lease.ts::expireLeases` 按**租约自己的** `expires_at` 收口。两者分开的理由是
 * 它们本来就是两个时钟：grant 到期只意味着"不许再要新的"，lease 到期才意味着"现在必须停"。
 */
export async function expireGrants(
  input: { now?: Date; limit?: number } = {},
  deps?: GrantDeps,
): Promise<ExpireGrantsResult> {
  const d = resolveGrantDeps(deps);
  const now = input.now ?? d.now();

  const candidates = (await d.db.federationGrant.findMany({
    where: { status: { in: ["active", "suspended"] }, expires_at: { lte: now } },
    take: input.limit ?? 200,
  })) as GrantRow[];

  let expired = 0;
  let quotaReturned = 0;
  let quotaReturnFailed = 0;

  for (const grant of candidates) {
    const newEpoch = nextGrantEpoch(grant.grant_epoch);
    const updated = (await d.db.federationGrant.updateMany({
      where: { id: grant.id, grant_epoch: grant.grant_epoch, status: grant.status },
      data: { status: "expired", grant_epoch: newEpoch },
    })) as { count: number };
    if (updated.count === 0) continue; // 并发的 revoke/suspend 赢了：让赢家负责这一行。
    expired++;

    if (grant.quota_reserved && d.quota !== null) {
      const parsed = parseGrantCapacity(grant.capacity);
      const released = await d.quota.release({
        peer_panel_id: grant.peer_panel_id ?? "",
        workspace_id: grant.workspace_id,
        grant_ref: grant.grant_ref,
        capacity: parsed.ok ? parsed.value : { max_legs: null, max_bandwidth_mbps: null, max_connections: null },
      });
      if (released.ok) quotaReturned++;
      else quotaReturnFailed++;
    } else if (grant.quota_reserved) {
      quotaReturnFailed++;
      console.warn(`[federation] grant ${grant.grant_ref} expired with quota_reserved but no quota hook is wired`);
    }

    await audit(d, {
      action: "grant.expire",
      direction: "local",
      peer_panel_id: grant.peer_panel_id ?? "",
      status: 200,
      workspace_id: grant.workspace_id,
      detail: { grant_ref: grant.grant_ref, grant_epoch: newEpoch, expires_at: grant.expires_at.toISOString() },
    });
  }

  return { evaluated: candidates.length, expired, quota_returned: quotaReturned, quota_return_failed: quotaReturnFailed };
}

/** 只读：查一台 host 上某个 peer/grant 的当前用量投影（写路径在 lease.ts/用法上报）。 */
export async function loadGrantRow(input: GrantRefInput, deps?: GrantDeps): Promise<GrantRow | null> {
  return loadGrant(resolveGrantDeps(deps), input);
}

/** 测试辅助：唯一冲突判定（业务代码不要用）。 */
export const __internals = { isUniqueConflict, grantWhere };
