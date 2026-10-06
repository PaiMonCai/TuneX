/**
 * V5.5 WP15 —— 远端租约（host 侧权威）。契约：`docs/v5-wp14-16-federation-contract.md` §3.2 / §3.3。
 *
 * 这个文件是所有「跨面板资源正在被使用」的判定现场，规则写死在这里，调用方不许各写一套：
 *
 *   1. **host 独占写权**（§1）。只有 host 能写 `node_port_lease` / `federation_lease`；
 *      本模块因此只出现在 host 侧代码里，home 侧要发的是 intent 而不是状态。
 *   2. **epoch 单调**。新的占用才 +1（撤销/过期后重新占用 = 新 epoch），同一条 lease 的
 *      revision 更新**不** bump epoch，但每次写入都以 epoch 作 CAS 前提。
 *      与 `placement-lease.ts`「续约同 epoch、换人才 +1」同源。
 *   3. **顺序铁律**（§3.3）：先远端（lease + apply + ACK）→ 再本地入口；拆除时反过来。
 *      任何一步失败都要补偿，**已建成的远端租约不得泄漏**。
 *   4. **幂等**。`(intent_id, revision, action)` 是幂等键，落在 `federation_intent` 的唯一索引上。
 *      幂等不是"再检查一遍"，而是**先占位后执行**（与 `receipts.ts` 的 message 去重同构）：
 *      占位冲突 = 有人正在做/已经做完，于是重投递绝不可能分配第二个端口。
 *
 * ── 纯逻辑 / IO 分离 ──
 * `planLeaseApply` / `canTransitionLease` / `evaluateLeaseRenewal` / `mapPortAllocationFailure`
 * 是纯函数（无 DB、无 IO，可离线断言）；`reserveRemoteLease` / `releaseRemoteLease` /
 * `expireLeases` 走注入的 DB 与钩子。第二阶段把 `deps.teardown` 接到 `orchestrator.removeTunnel`、
 * 把 allocator/releaser 接到 `portPool`（后者已经是默认实现）。
 */
import { randomUUID } from "node:crypto";

import {
  HOP_ROLES,
  LEASE_INTENT_ACTIONS,
  LEASE_STATES,
  LIVE_LEASE_STATES,
  defaultFederationAuditSink,
  evaluateGrant,
  isLiveLeaseState,
  expireGrants,
  isTerminalLeaseState,
  nextLeaseEpoch,
  PORT_RELEASE_PENDING_CODE,
  PEER_REVOKE_PENDING_CODE,
  registerFederationCascadeHooks,
  type EvaluateGrantInput,
  type FederationAuditSink,
  type GrantDecision,
  type GrantDeps,
  type GrantRowLike,
  type HopRole,
  type HookOutcome,
  type LeaseIntentAction,
  type LeaseState,
  type LeaseTeardownHook,
  type LeaseTeardownInput,
  type ParseResult,
  type PortAllocateHook,
  type PortReleaseHook,
} from "./grant.ts";
import type { FederationErrorCode } from "./errors.ts";
import { setFederationRevokedHook } from "./trust.ts";
import { reconcilePlacements, type PlacementDeps } from "./placement.ts";
import { Orchestrator, splitNextHop, type AgentTunnelConfig, type OrchestratorNode } from "../orchestrator.ts";
import { getOrchestrator } from "../relay-wiring.ts";
import { FORWARD_PROTOCOLS, type ForwardProtocol } from "../forward-contract.ts";
import { db } from "../../db.ts";
import {
  acquirePort,
  isUniqueConflict,
  isValidPort,
  leaseHolder,
  releaseLease as portPoolReleaseLease,
} from "../portPool.ts";

/* ================================================================== */
/* 常量                                                               */
/* ================================================================== */

/**
 * 远端租约默认 TTL（秒）。
 *
 * 取值理由与 `placement-lease.LEASE_TTL_SECONDS` 同源但**必须更长**：本地租约的续约靠
 * Agent 30s 一次的上报，联邦租约的续约要靠**跨面板**往返 + home 侧 reconcile 那一拍
 * （`worker.ts` 的周期任务是 30s 层）。300s = 10 拍：一次网络抖动、一次 worker 卡顿、
 * 一次 home 重启都不该把在服务的远端链路判死；而 partition 真发生时，最坏 5 分钟停服，
 * 这对"未经用户同意的重放置"来说仍是可接受的上界。
 *
 * 契约要求"到期即停"（§1 问题 8），所以 TTL 就是**分区容忍窗口**本身——调大它是拿
 * 安全性换可用性，别在没想清楚前动它。
 */
export const DEFAULT_LEASE_TTL_SECONDS = 300;

/** 上位机周期任务的最小节拍（worker.ts `cron_reconcile_v3` = 30s）。TTL 必须是它的整数倍量级。 */
export const LEASE_RECONCILE_TICK_SECONDS = 30;

/**
 * `pending` 认领的有效期（毫秒）。占位行落库后进程崩了，不能让这条 (intent_id, revision, action)
 * 永远锁死；超过这个窗口的 pending 视为**已放弃**，下一个重投递可以接管。
 */
export const LEASE_INTENT_PENDING_TTL_MS = 60_000;

/** 单次 expire 扫描的上限（避免一次扫全表把 worker 那一拍拖长）。 */
export const EXPIRE_BATCH_LIMIT = 200;

/* ================================================================== */
/* 状态机（纯）                                                        */
/* ================================================================== */

/**
 * 允许的迁移矩阵。列出的每一条边都有理由，没列出的边一律**返回错误而不是静默写入**
 * （"非法迁移静默落库"会让状态机变成注释，之后没人能靠状态判断现实）。
 *
 *   reserved  → active      两阶段应用成功（apply + ACK）
 *   reserved  → releasing   预留后放弃 / 超时清理（还没服务过，直接走释放）
 *   reserved  → failed      预留阶段的错误（补偿由调用方执行）
 *   active    → releasing   显式释放 / 撤销 / 到期（先停服）
 *   active    → failed      应用后失联且未能确认停止（保守记录，等待重试）
 *   releasing → released    停服 + 端口归还完成
 *   releasing → failed      停服或归还失败 → 下一拍重试（**不**回 active：它已经不该服务了）
 *   failed    → releasing   补偿重试
 *   failed    → released    补偿最终收敛
 *   *         → expired     到期收口
 *   *         → revoked     撤销级联（权威"不许再服务"）
 *   released/expired/revoked → （空）终态吸收态：epoch 不复用，重新占用必须新行 + 新 epoch
 */
export const LEASE_TRANSITIONS: Readonly<Record<LeaseState, readonly LeaseState[]>> = {
  reserved: ["active", "releasing", "failed", "expired", "revoked"],
  active: ["releasing", "failed", "expired", "revoked"],
  releasing: ["released", "failed", "expired", "revoked"],
  failed: ["releasing", "released", "expired", "revoked"],
  released: [],
  expired: [],
  revoked: [],
};

export function canTransitionLease(from: string, to: string): boolean {
  if (!(LEASE_STATES as readonly string[]).includes(from)) return false;
  if (!(LEASE_STATES as readonly string[]).includes(to)) return false;
  return LEASE_TRANSITIONS[from as LeaseState].includes(to as LeaseState);
}

/**
 * 迁移断言。非法迁移 → `internal_error`（契约 §6 的兜底码，因为"状态机被绕过"是代码问题
 * 而不是调用方输入问题），并带上 from/to 让日志能定位。
 */
export function assertLeaseTransition(from: string, to: string): ParseResult<true> {
  if (!(LEASE_STATES as readonly string[]).includes(from)) {
    return { ok: false, code: "internal_error", message: `unknown lease state "${String(from)}" in stored row` };
  }
  if (!(LEASE_STATES as readonly string[]).includes(to)) {
    return { ok: false, code: "internal_error", message: `unknown target lease state "${String(to)}"` };
  }
  if (!canTransitionLease(from, to)) {
    return { ok: false, code: "internal_error", message: `illegal lease transition ${from} -> ${to}` };
  }
  return { ok: true, value: true };
}

/* ================================================================== */
/* intent 形状与纯计划                                                  */
/* ================================================================== */

/**
 * intent 里的资源请求（契约 §3.2 的 `requested`）。
 *
 * `target_policy` 是**追加的可选字段**（§3.5 additive/可选）：grant 的
 * `scope.allow_target_policy` 需要一个可被请求的策略名才能被判，而 §3.2 的原始形状里
 * 没有它。不填 = 不请求特定策略（仍受 host 自己的策略解析约束）。
 */
export interface LeaseRequested {
  node_ref?: string | null;
  node_group_id?: number | null;
  port?: number | null;
  lb?: string | null;
  target_policy?: string | null;
}

export interface LeaseIntent {
  intent_id: string;
  revision: number;
  hop_role: string;
  forward_ref: string;
  requested?: LeaseRequested | null;
}

export interface NormalizedLeaseIntent {
  intent_id: string;
  revision: number;
  hop_role: HopRole;
  forward_ref: string;
  requested: {
    node_ref: string | null;
    node_group_id: number | null;
    port: number | null;
    lb: string | null;
    target_policy: string | null;
  };
}

export function validateLeaseIntent(intent: LeaseIntent): ParseResult<NormalizedLeaseIntent> {
  const bad = (message: string): ParseResult<NormalizedLeaseIntent> => ({ ok: false, code: "message_malformed", message });
  if (typeof intent.intent_id !== "string" || intent.intent_id.length === 0 || intent.intent_id.length > 64) {
    return bad("intent_id must be a non-empty string of at most 64 chars");
  }
  if (typeof intent.forward_ref !== "string" || intent.forward_ref.length === 0 || intent.forward_ref.length > 191) {
    return bad("forward_ref must be a non-empty string of at most 191 chars");
  }
  if (!Number.isInteger(intent.revision) || intent.revision < 0) {
    return bad("revision must be a non-negative integer");
  }
  if (typeof intent.hop_role !== "string" || !(HOP_ROLES as readonly string[]).includes(intent.hop_role)) {
    return bad(`unknown hop_role "${String(intent.hop_role)}"`);
  }
  const req = intent.requested ?? {};
  if (req.node_ref !== undefined && req.node_ref !== null) {
    if (typeof req.node_ref !== "string" || req.node_ref.length === 0 || req.node_ref.length > 64) {
      return bad("requested.node_ref must be a non-empty string of at most 64 chars");
    }
  }
  if (req.node_group_id !== undefined && req.node_group_id !== null) {
    if (!Number.isInteger(req.node_group_id) || req.node_group_id <= 0) {
      return bad("requested.node_group_id must be a positive integer");
    }
  }
  if (req.port !== undefined && req.port !== null && !isValidPort(req.port)) {
    return bad(`requested.port ${String(req.port)} is not a valid port`);
  }
  if (req.lb !== undefined && req.lb !== null && typeof req.lb !== "string") {
    return bad("requested.lb must be a string");
  }
  if (req.target_policy !== undefined && req.target_policy !== null && typeof req.target_policy !== "string") {
    return bad("requested.target_policy must be a string");
  }
  return {
    ok: true,
    value: {
      intent_id: intent.intent_id,
      revision: intent.revision,
      hop_role: intent.hop_role as HopRole,
      forward_ref: intent.forward_ref,
      requested: {
        node_ref: req.node_ref ?? null,
        node_group_id: req.node_group_id ?? null,
        port: req.port ?? null,
        lb: req.lb ?? null,
        target_policy: req.target_policy ?? null,
      },
    },
  };
}

/**
 * 下发动作（**闭集**）。第一版只支持"一个远端 hop"（§9），因此一个 intent 恰好产出一条
 * dispatch 步骤；将来要多跳，也是扩这个枚举并同时改 §9，而不是在这里悄悄塞第二个步骤。
 */
export type LeaseDispatchAction = "dispatch_ingress" | "dispatch_egress" | "dispatch_transit";

export interface LeaseDispatchStep {
  action: LeaseDispatchAction;
  /** 远端链路的建立必须等 ACK 才算 placed（§3.3「先远端 … + ACK」）。 */
  await_ack: true;
}

export const DISPATCH_BY_HOP_ROLE: Readonly<Record<HopRole, LeaseDispatchAction>> = {
  ingress: "dispatch_ingress",
  egress: "dispatch_egress",
  transit: "dispatch_transit",
};

export interface LeaseApplyPlan {
  intent_id: string;
  revision: number;
  hop_role: HopRole;
  forward_ref: string;
  /** 要分配的资源。`node_id` 为 null 表示 host 还必须先按 node group 选一台节点。 */
  allocate: {
    node_id: number | null;
    node_group_id: number | null;
    requested_port: number | null;
    needs_node: boolean;
  };
  lb: string | null;
  expires_at: Date;
  ttl_seconds: number;
  /** 本次占用应当写入的 epoch（新占用 = 上一个 +1；revision 更新 = 沿用既有 epoch）。 */
  lease_epoch: number;
  /** true = 这是一次**新的占用**（新 lease 行 / 撤销·过期后重新占用）；false = 同一占用的 revision 更新。 */
  new_occupancy: boolean;
  dispatch: readonly LeaseDispatchStep[];
}

export interface PlanLeaseApplyInput {
  intent: LeaseIntent;
  grant: GrantRowLike;
  workspaceId: number | null;
  /** 该 grant 当前已占用的 leg 数（host 自己算；纯函数不查库）。 */
  activeLegs: number;
  /** 该 intent 已经应用过的 revision（null = 从未应用）。 */
  appliedRevision: number | null;
  /** host 解析 `requested.node_ref` 得到的本地节点（纯函数不查库；null = 解析不到）。 */
  resolvedNodeId: number | null;
  resolvedNodeGroupId: number | null;
  /** 该 (peer, forward_ref, hop_role) 谱系的上一个 epoch（null = 从未占用）。 */
  previousEpoch: number | null;
  /**
   * 不是新占用时（同一 intent 的 revision 更新）要沿用的 epoch。
   * 给了它就不推 epoch —— 契约 §3.2「同一 intent_id 的新 revision 是**更新**」，
   * 而 schema 注释只允许「撤销/过期后**重新**占用」才 +1。
   */
  reuseEpoch?: number | null;
  now: Date;
  ttlSeconds?: number;
}

export type PlanLeaseApplyOutcome =
  | { ok: true; plan: LeaseApplyPlan }
  | { ok: false; code: FederationErrorCode; message: string };

/**
 * 纯计划：给定 intent + grant 事实，产出"要分配什么、要下发什么、epoch 是多少"。
 *
 * 它**不做 IO**：不选节点、不分配端口、不查 grant 用量。这些事实由调用方作为入参喂进来，
 * 于是所有边界（越权、容量、revision 新旧、非法端口）都能离线断言。
 *
 * revision 语义（契约 §3.2 幂等 + §4.2 "旧消息只记事实不改状态"）：
 *   · `revision < appliedRevision` → `intent_revision_stale`（拒绝，不改状态）
 *   · `revision === appliedRevision` → `duplicate_message`（调用方应返回首次结果）
 */
export function planLeaseApply(input: PlanLeaseApplyInput): PlanLeaseApplyOutcome {
  const validated = validateLeaseIntent(input.intent);
  if (!validated.ok) return validated;
  const intent = validated.value;

  if (input.appliedRevision !== null) {
    if (!Number.isInteger(input.appliedRevision) || input.appliedRevision < 0) {
      return { ok: false, code: "internal_error", message: "applied_revision in stored row is not a non-negative integer" };
    }
    if (intent.revision < input.appliedRevision) {
      return {
        ok: false,
        code: "intent_revision_stale",
        message: `revision ${intent.revision} is older than applied revision ${input.appliedRevision}`,
      };
    }
    if (intent.revision === input.appliedRevision) {
      return {
        ok: false,
        code: "duplicate_message",
        message: `revision ${intent.revision} was already applied; return the first result`,
      };
    }
  }

  // node_ref 是 home 侧的不透明引用；host 解不出来就不能装作能放（不许"就近落一台"）。
  if (intent.requested.node_ref !== null && input.resolvedNodeId === null) {
    return {
      ok: false,
      code: "grant_scope_violation",
      message: `requested node_ref "${intent.requested.node_ref}" cannot be resolved to a node on this host`,
    };
  }

  const decision: GrantDecision = evaluateGrant({
    grant: input.grant,
    hopRole: intent.hop_role,
    nodeGroupId: input.resolvedNodeGroupId,
    workspaceId: input.workspaceId,
    activeLegs: input.activeLegs,
    requestedLegs: 1,
    requestedTargetPolicy: intent.requested.target_policy,
    now: input.now,
  });
  if (!decision.allow) return { ok: false, code: decision.code, message: decision.message };

  const ttlSeconds = input.ttlSeconds ?? DEFAULT_LEASE_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    return { ok: false, code: "internal_error", message: "ttlSeconds must be a positive integer" };
  }
  // 租约**不得**活得比它依赖的 grant 更久：否则会留下一段"授权已死、链路还在"的窗口，
  // 而那种窗口只能靠人发现。取两者较小值就是全部实现。
  const ttlExpiry = new Date(input.now.getTime() + ttlSeconds * 1000);
  const expiresAt = decision.expires_at.getTime() < ttlExpiry.getTime() ? decision.expires_at : ttlExpiry;

  return {
    ok: true,
    plan: {
      intent_id: intent.intent_id,
      revision: intent.revision,
      hop_role: intent.hop_role,
      forward_ref: intent.forward_ref,
      allocate: {
        node_id: input.resolvedNodeId,
        node_group_id: input.resolvedNodeGroupId,
        requested_port: intent.requested.port,
        needs_node: input.resolvedNodeId === null,
      },
      lb: intent.requested.lb,
      expires_at: expiresAt,
      ttl_seconds: ttlSeconds,
      lease_epoch: input.reuseEpoch ?? nextLeaseEpoch(input.previousEpoch),
      new_occupancy: input.reuseEpoch === null || input.reuseEpoch === undefined,
      dispatch: [{ action: DISPATCH_BY_HOP_ROLE[intent.hop_role], await_ack: true }],
    },
  };
}

/**
 * 续约判定 = 用 `requestedLegs: 0` 走一遍 grant 判定。
 *
 * 用同一个函数而不是另写一套，是为了让"挂起/撤销/过期"的语义**不可能**在续约路径上被漏掉：
 * Lead 2026-10-05 的补充要求——suspend 期间已有 lease **到期不再续**——就落在
 * `evaluateGrant` 对 `status !== "active"` 的那两个分支上。若为续约单写一份判定，
 * 迟早会出现"暂停了但续约照过"的洞。
 *
 * `requestedLegs: 0` 的另一个作用是：容量刚好用满（activeLegs === max_legs）时，
 * **续约仍被允许**（它不新增 leg），只有新增 intent 才被 `quota_exhausted` 拒。
 */
export function evaluateLeaseRenewal(input: Omit<EvaluateGrantInput, "requestedLegs">): GrantDecision {
  return evaluateGrant({ ...input, requestedLegs: 0 });
}

/* ================================================================== */
/* DB 接缝                                                             */
/* ================================================================== */

export interface FederationLeaseRow {
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
  requested_revision: number;
  applied_revision: number | null;
  last_error_code: string | null;
  last_error: string | null;
  expires_at: Date;
  applied_at: Date | null;
  released_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface LeaseIntentRow {
  id: number;
  intent_id: string;
  peer_panel_id: string;
  lease_id: number | null;
  revision: number;
  action: string;
  status: string;
  error_code: string | null;
  created_at: Date;
}

export interface LeaseDb {
  federationLease: {
    findFirst(args: unknown): Promise<unknown>;
    findUnique(args: unknown): Promise<unknown>;
    findMany(args: unknown): Promise<unknown>;
    create(args: unknown): Promise<unknown>;
    updateMany(args: unknown): Promise<unknown>;
    count(args: unknown): Promise<number>;
  };
  federationIntent: {
    findUnique(args: unknown): Promise<unknown>;
    create(args: unknown): Promise<unknown>;
    update(args: unknown): Promise<unknown>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  /** apply / teardown 需要节点的编排投影（id / node_id / connect_ip / role）。 */
  node: {
    findUnique(args: unknown): Promise<unknown>;
  };
  /** 续约要过 grant 的活性判定（挂起/撤销/过期一律不许续），所以需要读 grant 行。 */
  federationGrant: {
    findUnique(args: unknown): Promise<unknown>;
  };
}

export interface LeaseHostDeps {
  db?: LeaseDb;
  audit?: FederationAuditSink;
  now?: () => Date;
  allocatePort?: PortAllocateHook;
  releasePort?: PortReleaseHook;
  /**
   * 下发钩子。**不传** = 默认走 `getOrchestrator()`（生产语义）；
   * 传 `null` = 显式禁用（离线测试 / 特殊路径），此时 apply 会以 internal_error 明确失败。
   */
  dispatch?: LeaseDispatchHook | null;
  /**
   * 停服钩子。**不传** = 默认走 `orchestrator.removeTunnel`（生产语义）；
   * 传 `null` = 显式禁用（测试用），此时撤销/释放会显式失败并留痕，**不会**假装停服成功。
   */
  teardown?: LeaseTeardownHook | null;
  ttlSeconds?: number;
}

interface ResolvedLeaseDeps {
  db: LeaseDb;
  audit: FederationAuditSink;
  now: () => Date;
  dispatch: LeaseDispatchHook;
  allocatePort: PortAllocateHook;
  releasePort: PortReleaseHook;
  teardown: LeaseTeardownHook | null;
  ttlSeconds: number;
}

const defaultLeaseDb = db as unknown as LeaseDb;

/**
 * 默认端口分配：走 `portPool.acquirePort`，**永远不自己 bind**。
 *
 * `tunnelId: null` = 预分配语义（远端资源在 host 上没有本地 Forward 行）；`expiresAt` 与
 * 租约到期一致，于是即使联邦这边彻底失联，`portPool.reconcileLeases` 也会把端口当
 * "过期预分配"回收——这是端口泄漏的最后一道网。
 */
async function defaultAllocatePort(input: Parameters<PortAllocateHook>[0]) {
  if (!portPoolSeamAvailable()) {
    return { ok: false as const, code: "internal_error", message: "port pool db seam is unavailable (no nodePortLease)" };
  }
  const out = await acquirePort({
    nodeId: input.node_id,
    // `lease_type` 只是审计元数据，不构成隔离（见 portPool 文件头）；transit 在物理上
    // 更接近出口侧（它连的是下一跳的内部监听地址），因此归到 egress。
    leaseType: input.hop_role === "ingress" ? "ingress" : "egress",
    preferredPort: input.requested_port,
    tunnelId: null,
    expiresAt: input.expires_at,
    reservedPorts: input.reserved_ports ?? [],
  });
  if (!out.ok) return { ok: false as const, code: out.code, message: out.port === undefined ? undefined : `port ${out.port}` };
  return { ok: true as const, port: out.result.port, port_lease_id: out.result.leaseId };
}

/**
 * 端口池的 db 接缝是否可用。
 *
 * 为什么需要这个判断：`portPool` 用的是**模块级** db，而联邦的调用方常常注入自己的替身
 * （单测的接缝）或处在进程级模块被替换的环境里（`bun test` 的 `mock.module` 是进程级注册表）。
 * 此时 `nodePortLease` 根本不存在，`leaseHolder()` 会抛 `TypeError: undefined is not an object`，
 * 而它是在**撤销级联的中途**抛的 —— 结果是"撤销做了一半 + 没有任何记录"。
 *
 * 缺模型 = 这个环境无法归还端口，那就**结构化失败**：调用方会把租约标成
 * `port_release_failed` 交给 reconcile 重试（task-7 已有的兜底路径）。生产里同一个判断
 * 也成立：db 暂时不可用时，级联应当降级为"待重试"，而不是崩掉。
 */
function portPoolSeamAvailable(): boolean {
  const candidate = defaultLeaseDb as unknown as { nodePortLease?: unknown };
  return typeof candidate?.nodePortLease === "object" && candidate.nodePortLease !== null;
}

/** 默认端口归还：先查 holder（DB 是唯一真相），再软删除。幂等；接缝不可用时结构化失败。 */
async function defaultReleasePort(input: { node_id: number; port: number }) {
  if (!portPoolSeamAvailable()) {
    return { ok: false as const, message: "port pool db seam is unavailable (no nodePortLease)" };
  }
  try {
    const holder = await leaseHolder(input.node_id, input.port);
    if (holder === null) return { ok: true, message: "no port lease row" };
    if (holder.status === "released") return { ok: true, message: "port lease already released" };
    const released = await portPoolReleaseLease({ leaseId: holder.leaseId });
    return released ? { ok: true as const } : { ok: false as const, message: "port lease was not active" };
  } catch (e) {
    // 归还失败绝不抛：让租约带上标记等下一拍补还（"停服成功、只剩端口"是本项目已有的状态）。
    return { ok: false as const, message: e instanceof Error ? e.message : String(e) };
  }
}

/*
 * 把自己这一份生产停服/还端口实现注册给 grant 侧的级联（revokeGrant）。
 * 注册而不是让 grant.ts import lease.ts：避免 `grant ↔ lease` 循环依赖，
 * 同时保证**只有一份**停服实现（别在这里再写第二份）。
 */
registerFederationCascadeHooks({
  teardown: (input) => defaultTeardown(input, defaultLeaseDb),
  releasePort: defaultReleasePort,
});

function resolveLeaseDeps(over?: LeaseHostDeps): ResolvedLeaseDeps {
  const db = over?.db ?? defaultLeaseDb;
  return {
    db,
    audit: over?.audit ?? defaultFederationAuditSink,
    now: over?.now ?? (() => new Date()),
    dispatch: over?.dispatch === undefined ? (input) => defaultDispatch(input) : (over.dispatch ?? disabledDispatch),
    allocatePort: over?.allocatePort ?? defaultAllocatePort,
    releasePort: over?.releasePort ?? defaultReleasePort,
    // `undefined` = 用生产默认（orchestrator + 本调用的 db 接缝）；`null` = 显式禁用（测试）。
    teardown: over?.teardown === undefined ? (input) => defaultTeardown(input, db) : over.teardown,
    ttlSeconds: over?.ttlSeconds ?? DEFAULT_LEASE_TTL_SECONDS,
  };
}

/** 显式禁用下发钩子时的替身：明确失败，绝不假装成功。 */
const disabledDispatch: LeaseDispatchHook = () => ({
  ok: false,
  code: "internal_error",
  message: "dispatch hook is explicitly disabled",
});

/**
 * 生产默认依赖：全部走既有通道（portPool 分配端口、orchestrator 下发/停服）。
 * 路由与 worker 用这一份，不要各自拼装钩子。
 */
export function defaultLeaseHostDeps(): LeaseHostDeps {
  return {
    allocatePort: defaultAllocatePort,
    releasePort: defaultReleasePort,
  };
}

async function audit(d: ResolvedLeaseDeps, input: Parameters<FederationAuditSink>[0]): Promise<void> {
  try {
    await d.audit(input);
  } catch (e) {
    console.warn("[federation] lease audit failed:", e instanceof Error ? e.message : e);
  }
}

/* ================================================================== */
/* 端口失败 → 错误码映射（纯）                                           */
/* ================================================================== */

/**
 * 把 `portPool` 的失败原因翻译成契约 §6 的闭集。
 *
 * 翻译而不是透传的理由：`port_taken` / `no_available_port` 都不是联邦协议的词汇，
 * 而调用方（home 面板）需要的是"重试有没有用"。映射规则：
 *   · 容量型（没有可用端口）→ `quota_exhausted`（429，等别人释放后重试有意义）
 *   · 请求值非法（端口越界/不在节点区间）→ `message_malformed` / `grant_scope_violation`（4xx，重试无用）
 *   · host 自身配置问题（节点没了、区间没配）→ `internal_error`（500，是 host 的问题）
 */
export function mapPortAllocationFailure(code: string): FederationErrorCode {
  switch (code) {
    case "no_available_port":
    case "port_taken":
    case "port_blacklisted":
      return "quota_exhausted";
    case "port_out_of_range":
      return "message_malformed";
    case "port_outside_node_range":
      return "grant_scope_violation";
    case "node_not_found":
    case "node_range_unset":
    case "node_range_invalid":
      return "internal_error";
    default:
      return "internal_error";
  }
}

/* ================================================================== */
/* 幂等：先占位、后执行（(intent_id, revision, action) 唯一）              */
/* ================================================================== */

export type LeaseIntentClaim =
  | { kind: "claimed" }
  /** 已经成功执行过 → 重投递必须返回首次结果，不得再执行一次。 */
  | { kind: "done"; row: LeaseIntentRow }
  /** 另一次投递正在执行中（或被上一拍放弃前的窗口内）→ duplicate_message（retryable）。 */
  | { kind: "in_flight"; row: LeaseIntentRow };

/**
 * 台账动作键。`renew` 会带**续约窗口**后缀（`renew@<window>`）——
 * 见 {@link renewalWindowIndex}：续约是**周期动作**，不是"同一次申请"。
 */
export type LeaseActionKey = LeaseIntentAction | `renew@${number}`;

export function leaseIntentKey(intentId: string, revision: number, action: LeaseActionKey): string {
  return `${intentId}:${revision}:${action}`;
}

/** `federation_intent.status` 的应用层取值（VARCHAR 列，不用 DB enum，§3.4）。 */
export const INTENT_STATUS = { pending: "pending", ok: "ok", failed: "failed" } as const;

/**
 * 认领一个幂等键。
 *
 * 语义（与 `receipts.ts::claimInboundMessage` 同构）：
 *   · create 成功 = 首次见到 → claimed；
 *   · P2002 且既有行 `status = ok` → done（调用方返回首次结果）；
 *   · P2002 且既有行 `status = pending` 且未超 `LEASE_INTENT_PENDING_TTL_MS` → in_flight；
 *   · P2002 且既有行 `failed`（或 pending 已超时，说明上次执行崩了）→ **接管**：改成
 *     pending 重新执行。失败可以重试的前提是补偿已经做完（见 reserve 的补偿路径）；
 *     "失败不落行"会让决策不留痕，"落行但不许重试"又会把一次瞬时失败永久钉死，
 *     接管式认领是两者的折中。
 */
export async function claimLeaseIntent(
  d: LeaseDb,
  input: { intent_id: string; peer_panel_id: string; revision: number; action: LeaseActionKey; now: Date },
): Promise<LeaseIntentClaim> {
  try {
    await d.federationIntent.create({
      data: {
        intent_id: input.intent_id,
        peer_panel_id: input.peer_panel_id,
        revision: input.revision,
        action: input.action,
        status: INTENT_STATUS.pending,
        error_code: null,
      },
    });
    return { kind: "claimed" };
  } catch (e) {
    if (!isUniqueConflict(e)) throw e;
  }

  const key = { intent_id: input.intent_id, revision: input.revision, action: input.action };
  const existing = (await d.federationIntent.findUnique({
    where: { intent_id_revision_action: key },
  })) as LeaseIntentRow | null;
  if (existing === null || existing === undefined) {
    // 极端竞态（既有行刚被删）：当作 in_flight 让调用方稍后重投，绝不"再执行一次"。
    return { kind: "in_flight", row: { ...key, id: -1, peer_panel_id: input.peer_panel_id, lease_id: null, status: INTENT_STATUS.pending, error_code: null, created_at: input.now } };
  }
  if (existing.status === INTENT_STATUS.ok) return { kind: "done", row: existing };

  const ageMs = input.now.getTime() - new Date(existing.created_at).getTime();
  if (existing.status === INTENT_STATUS.pending && ageMs < LEASE_INTENT_PENDING_TTL_MS) {
    return { kind: "in_flight", row: existing };
  }

  // CAS 接管：普通 update 会让两个并发请求都成功把同一行写成 pending，
  // 从而都拿到 claimed 并重复执行。把“我刚刚读到的状态 + created_at”一起放进
  // updateMany 的 where；赢家同时把 created_at 刷到本次认领时刻，既能区分 stale
  // pending，也会重新开始 in-flight TTL。只有真正改到 1 行的请求才拥有执行权。
  try {
    const takeover = await d.federationIntent.updateMany({
      where: {
        id: existing.id,
        status: existing.status,
        created_at: existing.created_at,
      },
      data: {
        status: INTENT_STATUS.pending,
        error_code: null,
        created_at: input.now,
      },
    });
    if (takeover.count === 1) return { kind: "claimed" };
    return { kind: "in_flight", row: existing };
  } catch {
    // 接管失败（别人抢先 / DB 瞬时失败）→ 让调用方稍后重投，仍然不重复执行。
    return { kind: "in_flight", row: existing };
  }
}

/** 完成/失败回写占位行。写不回只 warn：占位行的用途是去重，丢一次回写不该改变业务结果。 */
export async function settleLeaseIntent(
  d: LeaseDb,
  input: {
    intent_id: string;
    revision: number;
    action: LeaseActionKey;
    status: typeof INTENT_STATUS.ok | typeof INTENT_STATUS.failed;
    lease_id?: number | null;
    error_code?: FederationErrorCode | null;
  },
): Promise<void> {
  try {
    await d.federationIntent.update({
      where: { intent_id_revision_action: { intent_id: input.intent_id, revision: input.revision, action: input.action } },
      data: {
        status: input.status,
        error_code: input.error_code ?? null,
        ...(input.lease_id === undefined ? {} : { lease_id: input.lease_id }),
      },
    });
  } catch (e) {
    console.warn("[federation] failed to settle federation_intent:", e instanceof Error ? e.message : e);
  }
}

/* ================================================================== */
/* 阶段 1：预留（host 侧分配节点端口 + 落 reserved 行）                    */
/* ================================================================== */

export interface ReserveLeaseInput {
  intent: LeaseIntent;
  grant: GrantRowLike & { id: number; grant_ref: string; peer_panel_id: string };
  workspaceId: number | null;
  resolvedNodeId: number | null;
  resolvedNodeGroupId: number | null;
  /** 该 intent 已应用的 revision（调用方查好；通常来自既有 lease 行）。 */
  appliedRevision: number | null;
  /** 该谱系上一个 epoch（同 (peer_panel_id, forward_ref, hop_role)）。 */
  previousEpoch: number | null;
  reservedPorts?: readonly number[];
  auditDirection?: "inbound" | "outbound" | "local";
  messageId?: string | null;
}

export type ReserveLeaseOutcome =
  | {
      ok: true;
      lease: FederationLeaseRow;
      port: number | null;
      lease_epoch: number;
      expires_at: Date;
      /** 重投递返回首次结果时为 null（不重新计划）。 */
      plan: LeaseApplyPlan | null;
      replayed: boolean;
      /** true = 复用既有租约（同一 intent 的 revision 更新），没有再次分配端口。 */
      reused?: boolean;
    }
  | { ok: false; code: FederationErrorCode; message: string };

/**
 * 阶段 1（host 侧预留）：校验 → 分配节点端口 → 落 `reserved` 行。
 *
 * 补偿规则（G4 的教训，§3.3）：**任何一步失败都不许留下已分配的资源**。
 *   · 端口分配成功但 lease 行没落成 → 立刻归还端口；
 *   · 端口分配失败 → 没有任何副作用，直接返回结构化错误码。
 *
 * ── revision 更新走"复用"，绝不第二次分配端口 ──
 * 契约 §3.2：「同一 intent_id 的新 revision 是**更新**」。于是本函数先看这个 intent 是否
 * 已经有**非终态** lease：
 *   · 有 → 沿用它的节点/端口/epoch（`reuseEpoch`），只把 `requested_revision` 推新，
 *     真正的重新下发交给 apply 路径。**不再调 allocator** —— 否则一次 revision 更新就会
 *     多占一个端口，而那个端口没有任何 lease 行引用它（G4 同款泄漏）；
 *   · 没有（首次 / 上一代已 released·expired·revoked）→ 才是新占用：epoch = 谱系最大值 + 1。
 *
 * epoch 的取法刻意不信任调用方：取 `max(调用方给的 previousEpoch, 谱系最大值, 该 intent 既有 lease 的 epoch)`。
 * 调用方（home 侧）不可能知道 host 的谱系，而 epoch 一旦回退，fencing 就失去意义。
 */
export async function reserveRemoteLease(input: ReserveLeaseInput, deps?: LeaseHostDeps): Promise<ReserveLeaseOutcome> {
  const d = resolveLeaseDeps(deps);
  const now = d.now();
  const validated = validateLeaseIntent(input.intent);
  if (!validated.ok) return validated;
  const intent = validated.value;
  const direction = input.auditDirection ?? "local";

  const claim = await claimLeaseIntent(d.db, {
    intent_id: intent.intent_id,
    peer_panel_id: input.grant.peer_panel_id,
    revision: intent.revision,
    action: "create",
    now,
  });
  if (claim.kind === "in_flight") {
    return {
      ok: false,
      code: "duplicate_message",
      message: `intent ${intent.intent_id} revision ${intent.revision} is already being processed; retry later`,
    };
  }
  if (claim.kind === "done") {
    const lease = await loadLeaseByIdOrIntent(d.db, claim.row.lease_id, intent.intent_id);
    if (lease === null) {
      // 记了成功却没有 lease 行 = 账本损坏。返回 internal_error 而不是重新分配，
      // 因为"重新分配"正是幂等要防的那件事。
      return { ok: false, code: "internal_error", message: "intent is recorded as ok but its lease row is missing" };
    }
    return {
      ok: true,
      lease,
      port: lease.listen_port,
      lease_epoch: lease.lease_epoch,
      expires_at: lease.expires_at,
      plan: null,
      replayed: true,
    };
  }

  const existing = await loadLeaseByIdOrIntent(d.db, null, intent.intent_id);
  const activeLegs = await d.db.federationLease.count({
    where: { grant_id: input.grant.id, state: { in: LIVE_LEASE_STATES as unknown as string[] } },
  });

  // --- revision 更新：复用既有占用（同一节点、同一端口、同一 epoch）---
  // 「已过期但还没被收口」的行**不**复用：对它做 revision 更新，紧接着的 apply 必然
  // 以 lease_expired 拒绝，home 侧会看到 ok→error 的跳变。过期即按新占用处理（epoch+1）。
  if (existing !== null && !isTerminalLeaseState(existing.state) && existing.expires_at.getTime() > now.getTime()) {
    const planned = planLeaseApply({
      intent,
      grant: input.grant,
      workspaceId: input.workspaceId,
      activeLegs,
      appliedRevision: existing.applied_revision,
      resolvedNodeId: existing.node_id,
      resolvedNodeGroupId: input.resolvedNodeGroupId,
      previousEpoch: existing.lease_epoch,
      reuseEpoch: existing.lease_epoch,
      now,
      ttlSeconds: d.ttlSeconds,
    });
    if (!planned.ok) {
      await settleLeaseIntent(d.db, {
        intent_id: intent.intent_id,
        revision: intent.revision,
        action: "create",
        status: INTENT_STATUS.failed,
        error_code: planned.code,
      });
      return planned;
    }

    const moved = (await d.db.federationLease.updateMany({
      where: { id: existing.id, lease_epoch: existing.lease_epoch, state: existing.state },
      data: { requested_revision: intent.revision },
    })) as { count: number };
    if (moved.count === 0) {
      await settleLeaseIntent(d.db, {
        intent_id: intent.intent_id,
        revision: intent.revision,
        action: "create",
        status: INTENT_STATUS.failed,
        error_code: "internal_error",
      });
      return { ok: false, code: "internal_error", message: "lease revision update lost the epoch CAS race; re-read and retry" };
    }

    await settleLeaseIntent(d.db, {
      intent_id: intent.intent_id,
      revision: intent.revision,
      action: "create",
      status: INTENT_STATUS.ok,
      lease_id: existing.id,
    });
    await audit(d, {
      action: "lease.revise",
      direction,
      peer_panel_id: input.grant.peer_panel_id,
      message_id: input.messageId ?? null,
      status: 200,
      workspace_id: input.workspaceId,
      detail: {
        intent_id: intent.intent_id,
        lease_ref: existing.lease_ref,
        lease_epoch: existing.lease_epoch,
        revision: intent.revision,
        reused_node_id: existing.node_id,
        reused_port: existing.listen_port,
      },
    });
    return {
      ok: true,
      lease: { ...existing, requested_revision: intent.revision },
      port: existing.listen_port,
      lease_epoch: existing.lease_epoch,
      expires_at: existing.expires_at,
      plan: planned.plan,
      replayed: false,
      reused: true,
    };
  }

  const lineageMax = await maxLineageEpoch(d.db, input.grant.peer_panel_id, intent.forward_ref, intent.hop_role);
  const previousEpoch = Math.max(input.previousEpoch ?? 0, lineageMax, existing?.lease_epoch ?? 0);

  const planned = planLeaseApply({
    intent,
    grant: input.grant,
    workspaceId: input.workspaceId,
    activeLegs,
    appliedRevision: input.appliedRevision,
    resolvedNodeId: input.resolvedNodeId,
    resolvedNodeGroupId: input.resolvedNodeGroupId,
    previousEpoch,
    now,
    ttlSeconds: d.ttlSeconds,
  });
  if (!planned.ok) {
    await settleLeaseIntent(d.db, {
      intent_id: intent.intent_id,
      revision: intent.revision,
      action: "create",
      status: INTENT_STATUS.failed,
      error_code: planned.code,
    });
    return planned;
  }
  const plan = planned.plan;

  // 节点必须先能定下来，否则连端口分配都没有落点（needs_node 的 plan 由调用方补全后再来）。
  if (plan.allocate.node_id === null) {
    const code: FederationErrorCode = "grant_scope_violation";
    await settleLeaseIntent(d.db, {
      intent_id: intent.intent_id,
      revision: intent.revision,
      action: "create",
      status: INTENT_STATUS.failed,
      error_code: code,
    });
    return { ok: false, code, message: "no concrete node selected for this lease (host must resolve one within the grant scope)" };
  }

  const allocated = await d.allocatePort({
    node_id: plan.allocate.node_id,
    requested_port: plan.allocate.requested_port,
    expires_at: plan.expires_at,
    peer_panel_id: input.grant.peer_panel_id,
    intent_id: intent.intent_id,
    hop_role: plan.hop_role,
    reserved_ports: input.reservedPorts,
  });
  if (!allocated.ok) {
    const code = mapPortAllocationFailure(allocated.code);
    await settleLeaseIntent(d.db, {
      intent_id: intent.intent_id,
      revision: intent.revision,
      action: "create",
      status: INTENT_STATUS.failed,
      error_code: code,
    });
    return { ok: false, code, message: `port allocation failed (${allocated.code})${allocated.message ? `: ${allocated.message}` : ""}` };
  }

  let lease: FederationLeaseRow;
  try {
    lease = (await d.db.federationLease.create({
      data: {
        lease_ref: randomUUID(),
        grant_id: input.grant.id,
        peer_panel_id: input.grant.peer_panel_id,
        forward_ref: intent.forward_ref,
        intent_id: intent.intent_id,
        state: "reserved",
        lease_epoch: plan.lease_epoch,
        hop_role: plan.hop_role,
        node_id: plan.allocate.node_id,
        listen_port: allocated.port,
        requested_revision: intent.revision,
        applied_revision: null,
        expires_at: plan.expires_at,
      },
    })) as FederationLeaseRow;
  } catch (e) {
    // 补偿：行没落成 → 端口必须立刻还回去。失败也不能吞（端口池 reconcile 有到期回收兜底）。
    const rel = await d.releasePort({ node_id: plan.allocate.node_id, port: allocated.port });
    if (!rel.ok) {
      console.error(
        `[federation] reserve compensation FAILED for intent ${intent.intent_id}: port ${allocated.port} on node ${plan.allocate.node_id} not released: ${rel.message ?? "unknown"}`,
      );
    }
    await settleLeaseIntent(d.db, {
      intent_id: intent.intent_id,
      revision: intent.revision,
      action: "create",
      status: INTENT_STATUS.failed,
      error_code: "internal_error",
    });
    return { ok: false, code: "internal_error", message: e instanceof Error ? e.message : String(e) };
  }

  await settleLeaseIntent(d.db, {
    intent_id: intent.intent_id,
    revision: intent.revision,
    action: "create",
    status: INTENT_STATUS.ok,
    lease_id: lease.id,
  });

  await audit(d, {
    action: "lease.reserve",
    direction,
    peer_panel_id: input.grant.peer_panel_id,
    message_id: input.messageId ?? null,
    status: 201,
    workspace_id: input.workspaceId,
    detail: {
      intent_id: intent.intent_id,
      lease_ref: lease.lease_ref,
      lease_epoch: lease.lease_epoch,
      grant_ref: input.grant.grant_ref,
      revision: intent.revision,
      hop_role: plan.hop_role,
      node_id: plan.allocate.node_id,
      port: allocated.port,
      expires_at: plan.expires_at.toISOString(),
    },
  });

  return {
    ok: true,
    lease,
    port: allocated.port,
    lease_epoch: lease.lease_epoch,
    expires_at: plan.expires_at,
    plan,
    replayed: false,
  };
}

async function loadLeaseByIdOrIntent(
  d: LeaseDb,
  leaseId: number | null,
  intentId: string,
): Promise<FederationLeaseRow | null> {
  if (typeof leaseId === "number" && Number.isInteger(leaseId) && leaseId > 0) {
    const row = (await d.federationLease.findUnique({ where: { id: leaseId } })) as FederationLeaseRow | null;
    if (row) return row;
  }
  const row = (await d.federationLease.findFirst({
    where: { intent_id: intentId },
    orderBy: { lease_epoch: "desc" },
  })) as FederationLeaseRow | null;
  return row ?? null;
}

/**
 * 该 (peer, forward_ref, hop_role) 谱系上出现过的最大 epoch（没有则 0）。
 *
 * 这是"epoch 绝不复用"的真相来源：即使是**不同的 intent_id** 在同一谱系上重新占用
 * （home 重连后换了一个 intent_id 重发同一条 hop），也必须比上一次大。
 * 不信任调用方给的 `previousEpoch` —— home 侧不可能知道 host 的历史。
 */
async function maxLineageEpoch(d: LeaseDb, peerPanelId: string, forwardRef: string, hopRole: string): Promise<number> {
  const row = (await d.federationLease.findFirst({
    where: { peer_panel_id: peerPanelId, forward_ref: forwardRef, hop_role: hopRole },
    orderBy: { lease_epoch: "desc" },
  })) as FederationLeaseRow | null;
  if (row === null || row === undefined) return 0;
  const epoch = Number(row.lease_epoch);
  return Number.isInteger(epoch) && epoch > 0 ? epoch : 0;
}

/* ================================================================== */
/* 释放（显式释放 / 撤销 / 到期共用一条路径）                              */
/* ================================================================== */

export interface ReleaseLeaseInput {
  intent_id: string;
  revision: number;
  lease_ref?: string | null;
  lease_id?: number | null;
  reason?: "released" | "expired" | "revoked";
  now?: Date;
  auditDirection?: "inbound" | "outbound" | "local";
  messageId?: string | null;
}

export type ReleaseLeaseOutcome =
  | {
      ok: true;
      state: "released";
      already_released: boolean;
      lease_epoch: number;
      /** 停服是否确认（false = 钩子未接线/失败，但从调用方视角链路已不再被授权）。 */
      stopped: boolean;
      port_released: boolean;
      replayed: boolean;
    }
  | { ok: false; code: FederationErrorCode; message: string };

/**
 * 释放一条远端租约。**幂等**：同 `(intent_id, revision, release)` 重投递返回首次结果；
 * 对已经是终态的行直接成功返回（撤两次不该报错，也不该产生第二份副作用）。
 *
 * 状态路径刻意走 `releasing` 中转而不是直接写 `released`：
 * 中间态才是"停服做了一半、下一拍必须重试"的载体。停服失败 → `failed` + last_error，
 * 由 `expireLeases` / reconcile 重试；**失败绝不静默变成 released**。
 */
export async function releaseRemoteLease(input: ReleaseLeaseInput, deps?: LeaseHostDeps): Promise<ReleaseLeaseOutcome> {
  const d = resolveLeaseDeps(deps);
  const now = input.now ?? d.now();
  const reason = input.reason ?? "released";
  const direction = input.auditDirection ?? "local";

  if (typeof input.intent_id !== "string" || input.intent_id.length === 0) {
    return { ok: false, code: "message_malformed", message: "intent_id is required" };
  }
  if (!Number.isInteger(input.revision) || input.revision < 0) {
    return { ok: false, code: "message_malformed", message: "revision must be a non-negative integer" };
  }

  // 先解析 lease：释放的幂等行需要 `peer_panel_id`（审计/账本都要它），而它只存在于
  // lease 行上。这是一次**只读**，不会产生副作用，因此可以放在"占位"之前。
  const lease = input.lease_id
    ? ((await d.db.federationLease.findUnique({ where: { id: input.lease_id } })) as FederationLeaseRow | null)
    : typeof input.lease_ref === "string" && input.lease_ref.length > 0
      ? ((await d.db.federationLease.findUnique({ where: { lease_ref: input.lease_ref } })) as FederationLeaseRow | null)
      : ((await d.db.federationLease.findFirst({
          where: { intent_id: input.intent_id },
          orderBy: { lease_epoch: "desc" },
        })) as FederationLeaseRow | null);
  if (lease === null || lease === undefined) {
    // 没有 lease 就没有副作用可补偿，也没有 peer 可记账：直接如实返回。
    return { ok: false, code: "lease_not_found", message: "lease not found" };
  }

  const claim = await claimLeaseIntent(d.db, {
    intent_id: input.intent_id,
    peer_panel_id: lease.peer_panel_id,
    revision: input.revision,
    action: "release",
    now,
  });
  if (claim.kind === "in_flight") {
    return {
      ok: false,
      code: "duplicate_message",
      message: `release for intent ${input.intent_id} revision ${input.revision} is already being processed; retry later`,
    };
  }
  if (claim.kind === "done") {
    const done = await loadLeaseByIdOrIntent(d.db, claim.row.lease_id, input.intent_id);
    return {
      ok: true,
      state: "released",
      already_released: true,
      lease_epoch: done?.lease_epoch ?? lease.lease_epoch,
      stopped: true,
      port_released: true,
      replayed: true,
    };
  }

  if (isTerminalLeaseState(lease.state)) {
    // 已经是终态：释放的语义已经达成（幂等成功）。不重写历史行。
    await settleLeaseIntent(d.db, {
      intent_id: input.intent_id,
      revision: input.revision,
      action: "release",
      status: INTENT_STATUS.ok,
      lease_id: lease.id,
    });
    await audit(d, {
      action: "lease.release",
      direction,
      peer_panel_id: lease.peer_panel_id,
      message_id: input.messageId ?? null,
      status: 200,
      detail: { intent_id: input.intent_id, lease_ref: lease.lease_ref, state: lease.state, already_terminal: true },
    });
    return {
      ok: true,
      state: "released",
      already_released: true,
      lease_epoch: lease.lease_epoch,
      stopped: true,
      port_released: true,
      replayed: false,
    };
  }

  const from = lease.state;
  const toReleasing = assertLeaseTransition(from, "releasing");
  if (!toReleasing.ok) return toReleasing;

  // 已经是 releasing 的行不要再"转一次"（矩阵不允许 releasing→releasing），直接继续下半程。
  if (from !== "releasing") {
    const moved = (await d.db.federationLease.updateMany({
      where: { id: lease.id, lease_epoch: lease.lease_epoch, state: from },
      data: { state: "releasing" },
    })) as { count: number };
    if (moved.count === 0) {
      return { ok: false, code: "internal_error", message: "lease release lost the epoch CAS race; re-read and retry" };
    }
  }

  const hopRole: HopRole = (HOP_ROLES as readonly string[]).includes(lease.hop_role)
    ? (lease.hop_role as HopRole)
    : "egress";

  let stopped = false;
  let stopMessage: string | null = null;
  if (d.teardown === null) {
    stopMessage = "teardown hook is not wired; refusing to mark the lease released while the runtime may still be up";
  } else {
    const res = await d.teardown({
      lease_ref: lease.lease_ref,
      peer_panel_id: lease.peer_panel_id,
      intent_id: lease.intent_id,
      node_id: lease.node_id,
      listen_port: lease.listen_port,
      hop_role: hopRole,
      lease_epoch: lease.lease_epoch,
      reason,
    });
    stopped = res.ok;
    if (!res.ok) stopMessage = res.message ?? "teardown failed";
  }

  if (!stopped) {
    // 先停服、后还端口（§3.3）：停不下来就**不还**端口。留 failed + last_error 让下一拍重试。
    await d.db.federationLease.updateMany({
      where: { id: lease.id, lease_epoch: lease.lease_epoch },
      data: { state: "failed", last_error_code: "internal_error", last_error: stopMessage },
    });
    await settleLeaseIntent(d.db, {
      intent_id: input.intent_id,
      revision: input.revision,
      action: "release",
      status: INTENT_STATUS.failed,
      error_code: "internal_error",
    });
    return { ok: false, code: "internal_error", message: stopMessage ?? "teardown failed" };
  }

  let portReleased = true;
  if (lease.node_id !== null && lease.listen_port !== null) {
    const rel = await d.releasePort({ node_id: lease.node_id, port: lease.listen_port });
    portReleased = rel.ok;
  }

  const done = (await d.db.federationLease.updateMany({
    where: { id: lease.id, lease_epoch: lease.lease_epoch },
    data: {
      state: "released",
      released_at: now,
      // 端口没还上不代表"还在服务"，但它确实是一笔待办：留痕给 reconcile，不静默。
      last_error_code: portReleased ? null : PORT_RELEASE_PENDING_CODE,
      last_error: portReleased ? null : "port release failed; the sweeper will retry, and portPool reconcile reclaims it as a backstop",
    },
  })) as { count: number };
  if (done.count === 0) {
    return { ok: false, code: "internal_error", message: "lease release lost the epoch CAS race during finalize; re-read and retry" };
  }

  await settleLeaseIntent(d.db, {
    intent_id: input.intent_id,
    revision: input.revision,
    action: "release",
    status: INTENT_STATUS.ok,
    lease_id: lease.id,
  });

  await audit(d, {
    action: "lease.release",
    direction,
    peer_panel_id: lease.peer_panel_id,
    message_id: input.messageId ?? null,
    status: 200,
    detail: {
      intent_id: input.intent_id,
      lease_ref: lease.lease_ref,
      lease_epoch: lease.lease_epoch,
      port_released: portReleased,
      reason,
    },
  });

  return {
    ok: true,
    state: "released",
    already_released: false,
    lease_epoch: lease.lease_epoch,
    stopped: true,
    port_released: portReleased,
    replayed: false,
  };
}

/* ================================================================== */
/* 阶段 2：apply（host 侧真实下发）                                      */
/* ================================================================== */

/**
 * 下发给 host 自己 orchestrator 的钩子。默认实现见 {@link defaultDispatch}：
 * 走 `getOrchestrator()` + `Orchestrator.federatedTunnelId()`，**不新建第二条下发通道**。
 */
export interface LeaseDispatchInput {
  lease: FederationLeaseRow;
  node: OrchestratorNode;
  revision: number;
  /** `tunex-fed-<lease_ref>-<direction>`：联邦腿的运行时身份。 */
  runtime_id: string;
  link: FederatedLegLink;
}

export type LeaseDispatchOutcome =
  | {
      ok: true;
      /**
       * **我们实际发出去的那份 Agent 运行时配置原文**（见 {@link buildFederatedRuntimeConfig}）。
       * `applyRemoteLease` 会把它写进 `federation_lease.applied_config`，快照再原样发布给 Agent——
       * 只有这一份事实，快照不重新拼装。
       */
      applied_config?: AgentTunnelConfig | null;
    }
  | { ok: false; code?: FederationErrorCode; message: string };

export type LeaseDispatchHook = (input: LeaseDispatchInput) => Promise<LeaseDispatchOutcome> | LeaseDispatchOutcome;

/**
 * 远端腿的期望形状（契约 §3.2 阶段 2 的 `link`）。
 *
 * 字段尽量与 host 本地 leg 的期望同形，host 才能用**同一个** orchestrator 下发：
 * 出口跳要目标池/目标表，入口与中间跳要下一跳地址。未知键由 `validateLegLink` fail-closed 拒绝。
 */
export interface FederatedLegLink {
  protocol?: string | null;
  targets?: readonly { host: string; port: number; weight?: number; order_by?: number }[] | null;
  pool_id?: number | null;
  lb_strategy?: string | null;
  /** `<host>:<port>`：ingress / transit 必填，来自上一跳的 dispatch 结果。 */
  next_hop?: string | null;
  tls_cert_path?: string | null;
  tls_key_path?: string | null;
}

const LEG_LINK_KEYS: ReadonlySet<string> = new Set([
  "protocol",
  "targets",
  "pool_id",
  "lb_strategy",
  "next_hop",
  "tls_cert_path",
  "tls_key_path",
]);

/**
 * 校验 `link`。**fail-closed**：未知键、缺必填项、非法目标一律拒绝，
 * 绝不用"取能认的字段凑合下发"——那会让 host 上跑起一条与 home 期望不同的链路，
 * 而两边都以为自己是对的。
 */
export function validateLegLink(hopRole: string, raw: unknown): ParseResult<FederatedLegLink> {
  const bad = (message: string): ParseResult<FederatedLegLink> => ({ ok: false, code: "message_malformed", message });
  if (raw === undefined || raw === null) {
    return bad("link is required for apply");
  }
  if (typeof raw !== "object" || Array.isArray(raw)) return bad("link must be a JSON object");
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!LEG_LINK_KEYS.has(key)) return bad(`link has unknown key "${key}" (fail-closed)`);
  }

  let protocol: string | null = null;
  if (obj.protocol !== undefined && obj.protocol !== null) {
    if (typeof obj.protocol !== "string" || !(FORWARD_PROTOCOLS as readonly string[]).includes(obj.protocol)) {
      return bad(`link.protocol "${String(obj.protocol)}" is not a supported forward protocol`);
    }
    protocol = obj.protocol;
  }

  let poolId: number | null = null;
  if (obj.pool_id !== undefined && obj.pool_id !== null) {
    if (!Number.isInteger(obj.pool_id) || (obj.pool_id as number) <= 0) return bad("link.pool_id must be a positive integer or null");
    poolId = obj.pool_id as number;
  }

  let lbStrategy: string | null = null;
  if (obj.lb_strategy !== undefined && obj.lb_strategy !== null) {
    if (typeof obj.lb_strategy !== "string") return bad("link.lb_strategy must be a string");
    lbStrategy = obj.lb_strategy;
  }

  let nextHop: string | null = null;
  if (obj.next_hop !== undefined && obj.next_hop !== null) {
    if (typeof obj.next_hop !== "string" || splitNextHop(obj.next_hop) === null) {
      return bad(`link.next_hop "${String(obj.next_hop)}" is not a valid host:port`);
    }
    nextHop = obj.next_hop;
  }

  const targets: { host: string; port: number; weight?: number; order_by?: number }[] = [];
  if (obj.targets !== undefined && obj.targets !== null) {
    if (!Array.isArray(obj.targets)) return bad("link.targets must be an array");
    for (const t of obj.targets) {
      if (typeof t !== "object" || t === null) return bad("link.targets entries must be objects");
      const entry = t as Record<string, unknown>;
      if (typeof entry.host !== "string" || entry.host.length === 0) return bad("link.targets[].host must be a non-empty string");
      if (!isValidPort(entry.port)) return bad(`link.targets[].port ${String(entry.port)} is not a valid port`);
      // 非数字的 weight/order_by **拒绝**而不是丢弃：其余字段都是一票否决，
      // 这里静默丢弃会让调用方以为给了权重而实际没有（"配置生效了，但不是你要的"）。
      if (entry.weight !== undefined && entry.weight !== null && typeof entry.weight !== "number") {
        return bad("link.targets[].weight must be a number");
      }
      if (entry.order_by !== undefined && entry.order_by !== null && typeof entry.order_by !== "number") {
        return bad("link.targets[].order_by must be a number");
      }
      targets.push({
        host: entry.host,
        port: entry.port as number,
        ...(typeof entry.weight === "number" ? { weight: entry.weight } : {}),
        ...(typeof entry.order_by === "number" ? { order_by: entry.order_by } : {}),
      });
    }
  }

  let tlsCertPath: string | null = null;
  let tlsKeyPath: string | null = null;
  if (obj.tls_cert_path !== undefined && obj.tls_cert_path !== null) {
    if (typeof obj.tls_cert_path !== "string") return bad("link.tls_cert_path must be a string");
    tlsCertPath = obj.tls_cert_path;
  }
  if (obj.tls_key_path !== undefined && obj.tls_key_path !== null) {
    if (typeof obj.tls_key_path !== "string") return bad("link.tls_key_path must be a string");
    tlsKeyPath = obj.tls_key_path;
  }

  if (hopRole === "egress" && targets.length === 0) {
    return bad("a remote egress hop needs at least one target");
  }
  if ((hopRole === "ingress" || hopRole === "transit") && nextHop === null) {
    return bad(`a remote ${hopRole} hop needs link.next_hop`);
  }

  return { ok: true, value: { protocol, targets, pool_id: poolId, lb_strategy: lbStrategy, next_hop: nextHop, tls_cert_path: tlsCertPath, tls_key_path: tlsKeyPath } };
}

/**
 * 联邦腿的**运行时配置构造器（唯一那一份下发布料）**。
 *
 * 字段的推导规则与 `Orchestrator.dispatchEgress / dispatchIngress` 内部完全一致（EGRESS：
 * `ingress_port=0`、`remote_*` 空、目标带 `weight/order`；RELAY：`egress_port/next_hop` 指向下一跳）。
 * 之所以在这里构造而不是从 orchestrator 里取回：orchestrator 的入参是"更高层的意图"，
 * 不返回它内部拼出的配置；而这份配置必须**与下发同源**，否则快照与下发迟早各说各话。
 * 因此调用方（defaultDispatch）由这份配置**推导** orchestrator 入参，而不是反过来。
 */
export function buildFederatedRuntimeConfig(input: {
  lease_ref: string;
  hop_role: HopRole;
  runtime_id: string;
  revision: number;
  listen_port: number;
  link: FederatedLegLink;
  /** 节点自己的可寻址地址（诊断/展示用；Agent 的 EGRESS 配置不使用它）。 */
  node_address?: string | null;
}): AgentTunnelConfig {
  const protocol = (input.link.protocol ?? "tcp") as ForwardProtocol;
  const targets = (input.link.targets ?? []).map((t, i) => ({
    host: t.host,
    port: t.port,
    weight: t.weight ?? 1,
    order: t.order_by ?? (i + 1) * 10,
  }));

  if (input.hop_role === "ingress") {
    const hop = splitNextHop(input.link.next_hop ?? "") ?? { host: "", port: 0 };
    return {
      id: input.runtime_id,
      mode: "RELAY",
      ingress_port: input.listen_port,
      egress_port: hop.port,
      remote_host: hop.host,
      remote_port: hop.port,
      next_hop: input.link.next_hop ?? "",
      // RELAY 侧不持有目标知识（目标在出口节点上）——与 dispatchIngress 完全一致。
      targets: [],
      lb_strategy: "ROUND_ROBIN",
      protocol,
      speed_limit: 0,
      revision: input.revision,
      ...(input.link.tls_cert_path && input.link.tls_key_path
        ? { tls_cert_path: input.link.tls_cert_path, tls_key_path: input.link.tls_key_path }
        : {}),
    };
  }

  // EGRESS（远端出口腿）：本机节点只服务入口节点转发来的流量。
  return {
    id: input.runtime_id,
    mode: "EGRESS",
    egress_port: input.listen_port,
    ingress_port: 0,
    remote_host: "",
    remote_port: 0,
    next_hop: "",
    targets,
    lb_strategy: (input.link.lb_strategy ?? "ROUND_ROBIN") as AgentTunnelConfig["lb_strategy"],
    protocol,
    speed_limit: 0,
    revision: input.revision,
    ...(input.link.tls_cert_path && input.link.tls_key_path
      ? { tls_cert_path: input.link.tls_cert_path, tls_key_path: input.link.tls_key_path }
      : {}),
  };
}

/** hop 角色 → 运行时 id 的方向段（与本地腿的分段一致，Agent 不需要认识"联邦"）。 */
export const HOP_ROLE_RUNTIME_DIRECTION: Readonly<Record<HopRole, "direct" | "relay" | "egress">> = {
  ingress: "relay",
  egress: "egress",
  transit: "egress",
};

/** 联邦腿的运行时 id。**唯一入口**，别在调用点拼字符串。 */
export function federatedRuntimeId(leaseRef: string, hopRole: string): string {
  const dir = HOP_ROLE_RUNTIME_DIRECTION[(hopRole as HopRole) ?? "egress"] ?? "egress";
  return Orchestrator.federatedTunnelId(leaseRef, dir);
}

/**
 * 默认下发实现：复用既有 orchestrator（契约 §7「不新建下发通道」）。
 *
 * 远端 ingress 与 egress 都走**同一个** orchestrator，只是运行时 id 的方向段不同
 * （`tunex-fed-<ref>-relay` / `-egress`）；`runtimeId` 同时让 `dispatchIngress` 跳过
 * placement 归属认领（联邦腿的归属由 `federation_lease.lease_epoch` 表达，不需要第二份）。
 * 拆除时方向必须与建立时一致（relay ↔ ingress），见 {@link defaultTeardown}。
 */
async function defaultDispatch(input: LeaseDispatchInput): Promise<LeaseDispatchOutcome> {
  const orchestrator = getOrchestrator();
  if (orchestrator === null) return { ok: false, message: "orchestrator is not wired" };
  const port = input.lease.listen_port;
  if (port === null) return { ok: false, message: "lease has no listen_port" };

  const protocol = (input.link.protocol ?? undefined) as ForwardProtocol | undefined;
  const runtimeId = input.runtime_id;
  // **唯一那一份下发布料**：orchestrator 的入参由它推导，落库的也是它。
  const config = buildFederatedRuntimeConfig({
    lease_ref: input.lease.lease_ref,
    hop_role: (HOP_ROLES as readonly string[]).includes(input.lease.hop_role) ? (input.lease.hop_role as HopRole) : "egress",
    runtime_id: runtimeId,
    revision: input.revision,
    listen_port: port,
    link: input.link,
    node_address: input.node.connect_ip,
  });
  // `tunnelId` 只作为本地记账/命令 id 的一部分；**运行时身份由 runtimeId 决定**，
  // 所以这里用联邦 lease 的主键不会与本地 tunnel id 冲突（见 orchestrator 注释）。
  const tunnelId = input.lease.id;

  switch (input.lease.hop_role) {
    case "egress": {
      const outcome = await orchestrator.dispatchEgress({
        tunnelId,
        runtimeId,
        revision: input.revision,
        egressNode: input.node,
        egressPort: config.egress_port,
        poolId: input.link.pool_id ?? null,
        targets: config.targets.map((t) => ({ host: t.host, port: t.port, weight: t.weight, order_by: t.order })),
        lbStrategy: config.lb_strategy,
        protocol,
        tlsCertPath: input.link.tls_cert_path ?? null,
        tlsKeyPath: input.link.tls_key_path ?? null,
      });
      return outcome.ok
        ? { ok: true, applied_config: config }
        : { ok: false, code: "internal_error", message: `${outcome.error_code}: ${outcome.error}` };
    }
    case "ingress": {
      // 入参 `runtimeId` 非空时 dispatchIngress 会**跳过 placement 归属认领**：
      // 联邦腿在 host 上没有本地 tunnel 行，认领会写出一条指向不存在隧道的归属行（第二份真相）。
      const outcome = await orchestrator.dispatchIngress({
        tunnelId,
        runtimeId,
        revision: input.revision,
        ingressNode: input.node,
        ingressPort: config.ingress_port,
        nextHop: config.next_hop,
        protocol,
        tlsCertPath: input.link.tls_cert_path ?? null,
        tlsKeyPath: input.link.tls_key_path ?? null,
      });
      return outcome.ok
        ? { ok: true, applied_config: config }
        : { ok: false, code: "internal_error", message: `${outcome.error_code}: ${outcome.error}` };
    }
    case "transit": {
      const outcome = await orchestrator.dispatchTransit({
        tunnelId,
        runtimeId,
        revision: input.revision,
        node: input.node,
        port,
        nextHop: input.link.next_hop ?? "",
        protocol,
      });
      return outcome.ok ? { ok: true } : { ok: false, code: "internal_error", message: `${outcome.error_code}: ${outcome.error}` };
    }
    default:
      return {
        ok: false,
        code: "unsupported_topology",
        message: "remote ingress hop needs runtimeId support in dispatchIngress (orchestrator change pending)",
      };
  }
}

/**
 * 默认停服实现：`removeTunnel` + 联邦运行时 id。
 *
 * 用 `revision + 1`（与本地补偿同源）：Agent 的闸门是「applied_revision ≥ incoming → stale」，
 * 用失败那次的 revision 撤可能被拒 → 补偿静默失效 → 端口继续被占。
 * Agent 对未知 id 的 remove 是 no-op，因此这个补偿天然幂等。
 */
async function defaultTeardown(input: LeaseTeardownInput, leaseDb: LeaseDb): Promise<HookOutcome> {
  const orchestrator = getOrchestrator();
  if (orchestrator === null) return { ok: false, message: "orchestrator is not wired" };
  if (input.node_id === null) return { ok: true, message: "lease has no node; nothing to stop" };
  const node = await loadOrchestratorNode(leaseDb, input.node_id);
  if (node === null) return { ok: false, message: `node ${input.node_id} no longer exists` };

  const direction = HOP_ROLE_RUNTIME_DIRECTION[input.hop_role] ?? "egress";
  const outcome = await orchestrator.removeTunnel({
    tunnelId: 0,
    runtimeId: federatedRuntimeId(input.lease_ref, input.hop_role),
    node,
    direction: direction === "relay" ? "ingress" : "egress",
    revision: input.lease_epoch + 1,
    reason: `federation_${input.reason}`,
  });
  return outcome.ok ? { ok: true } : { ok: false, message: `${outcome.error_code}: ${outcome.error}` };
}

/** 读一台 host 节点的编排投影（apply/teardown 都需要它）。 */
async function loadOrchestratorNode(d: LeaseDb, nodeId: number): Promise<OrchestratorNode | null> {
  const row = (await d.node.findUnique({
    where: { id: nodeId },
    select: { id: true, node_id: true, connect_ip: true, role: true },
  })) as OrchestratorNode | null;
  return row ?? null;
}

/**
 * host 侧应用请求（Lead 2026-10-05 冻结的接口形状）。
 *
 * `targets` / `lb_strategy` / `protocol` 是 home 给出的**远端腿事实**：host 不解释它的业务含义，
 * 只把它翻译成本机 orchestrator 的下发参数。第一版只支持**远端 egress**（契约 §9 的
 * "一个远端 hop"），因此这里没有 `next_hop` 字段：远端 ingress/transit 需要 orchestrator
 * 给 `dispatchIngress` 加 `runtimeId`（并在给了它时跳过 placement 归属 claim）——
 * 在那之前这两种 hop 一律 `unsupported_topology` fail-closed，而不是冒险撞运行时 id。
 */
export interface ApplyRemoteLeaseInput {
  lease_ref: string;
  intent_id: string;
  /** home 侧本次要应用的 revision。 */
  revision: number;
  targets: readonly { host: string; port: number; weight?: number; order_by?: number }[];
  /**
   * 远端 **ingress** 腿必填：上一跳（或目标）的 `<host>:<port>`。
   * 缺它 → `message_malformed`（**不猜地址**：猜出来的下一跳就是一条永远不通的链路）。
   * egress 腿忽略该字段。
   */
  next_hop?: string | null;
  lb_strategy?: string | null;
  /** 缺省 tcp。 */
  protocol?: string | null;
  auditDirection?: "inbound" | "outbound" | "local";
  messageId?: string | null;
}

export type ApplyRemoteLeaseOutcome =
  | {
      ok: true;
      state: "active";
      applied_revision: number;
      lease_epoch: number;
      replayed: boolean;
      /** host 侧节点的不透明引用（home 侧只用于显示与诊断，**不得**据此建本地 node 行）。 */
      node_ref: string | null;
      port: number | null;
    }
  | { ok: false; code: FederationErrorCode; message: string };

/** 向后兼容别名（内部/测试用旧名字时不至于两边各有一份类型）。 */
export type ApplyLeaseInput = ApplyRemoteLeaseInput;

export async function applyRemoteLease(input: ApplyRemoteLeaseInput, deps?: LeaseHostDeps): Promise<ApplyRemoteLeaseOutcome> {
  const d = resolveLeaseDeps(deps);
  const now = d.now();

  if (typeof input.intent_id !== "string" || input.intent_id.length === 0) {
    return { ok: false, code: "message_malformed", message: "intent_id is required" };
  }
  if (typeof input.lease_ref !== "string" || input.lease_ref.length === 0) {
    return { ok: false, code: "message_malformed", message: "lease_ref is required" };
  }
  if (!Number.isInteger(input.revision) || input.revision < 0) {
    return { ok: false, code: "message_malformed", message: "revision must be a non-negative integer" };
  }

  const lease = (await d.db.federationLease.findUnique({ where: { lease_ref: input.lease_ref } })) as FederationLeaseRow | null;
  if (lease === null || lease === undefined) {
    return { ok: false, code: "lease_not_found", message: "lease not found" };
  }
  if (lease.intent_id !== input.intent_id) {
    // 租约与 intent 对不上：这不是"重投递"，是两件事被混在一起了。
    return { ok: false, code: "message_malformed", message: `lease ${input.lease_ref} belongs to a different intent` };
  }

  const runtimeId = federatedRuntimeId(lease.lease_ref, lease.hop_role);

  // 幂等：重复投递同一 (intent_id, revision, apply) 返回首次结果。
  const claim = await claimLeaseIntent(d.db, {
    intent_id: input.intent_id,
    peer_panel_id: lease.peer_panel_id,
    revision: input.revision,
    action: "apply",
    now,
  });
  if (claim.kind === "in_flight") {
    return {
      ok: false,
      code: "duplicate_message",
      message: `apply for intent ${input.intent_id} revision ${input.revision} is already being processed; retry later`,
    };
  }
  if (claim.kind === "done") {
    if (lease.applied_revision === null) {
      return { ok: false, code: "internal_error", message: "apply is recorded as ok but applied_revision is null" };
    }
    const replayNode = lease.node_id === null ? null : await loadOrchestratorNode(d.db, lease.node_id);
    return {
      ok: true,
      state: "active",
      applied_revision: lease.applied_revision,
      lease_epoch: lease.lease_epoch,
      replayed: true,
      node_ref: replayNode?.node_id ?? null,
      port: lease.listen_port,
    };
  }

  if (lease.state === "revoked") return { ok: false, code: "lease_revoked", message: "lease is revoked" };
  if (lease.state === "expired") return { ok: false, code: "lease_expired", message: "lease is expired" };
  if (lease.state === "released") return { ok: false, code: "lease_not_found", message: "lease is already released" };
  if (lease.state === "releasing") {
    return { ok: false, code: "duplicate_message", message: "lease is being released; apply refuses to race it" };
  }
  if (lease.state === "failed" && lease.applied_revision !== null) {
    // 已服务过又落到 failed：那是停服/释放侧的补偿没完成，重新 apply 会把它"复活"。
    return { ok: false, code: "internal_error", message: "lease is in failed state after being applied; release or re-reserve first" };
  }
  if (lease.expires_at.getTime() <= now.getTime()) {
    return { ok: false, code: "lease_expired", message: `lease expired at ${lease.expires_at.toISOString()}` };
  }
  if (lease.applied_revision !== null && input.revision < lease.applied_revision) {
    return {
      ok: false,
      code: "intent_revision_stale",
      message: `revision ${input.revision} is older than applied revision ${lease.applied_revision}`,
    };
  }
  if (lease.applied_revision !== null && input.revision === lease.applied_revision) {
    return {
      ok: false,
      code: "duplicate_message",
      message: `revision ${input.revision} was already applied; return the first result`,
    };
  }

  // 契约 §9：第一版只支持**一个远端 hop**（远端 ingress **或** 远端 egress）。
  // 跨面板 transit 是 §9.4.4 明确的关闭项，必须 fail-closed 拒绝而不是"顺手支持"。
  if (lease.hop_role === "transit") {
    await settleLeaseIntent(d.db, {
      intent_id: input.intent_id,
      revision: input.revision,
      action: "apply",
      status: INTENT_STATUS.failed,
      error_code: "unsupported_topology",
    });
    return {
      ok: false,
      code: "unsupported_topology",
      message: "cross-panel transit hops are closed in the first version (contract §9); only one remote hop is supported",
    };
  }
  if (lease.hop_role !== "egress" && lease.hop_role !== "ingress") {
    await settleLeaseIntent(d.db, {
      intent_id: input.intent_id,
      revision: input.revision,
      action: "apply",
      status: INTENT_STATUS.failed,
      error_code: "message_malformed",
    });
    return { ok: false, code: "message_malformed", message: `unknown hop_role "${lease.hop_role}" in lease row` };
  }

  const linkParsed = validateLegLink(lease.hop_role, {
    protocol: input.protocol ?? null,
    targets: input.targets,
    lb_strategy: input.lb_strategy ?? null,
    pool_id: null,
    next_hop: input.next_hop ?? null,
    tls_cert_path: null,
    tls_key_path: null,
  });
  if (!linkParsed.ok) {
    await settleLeaseIntent(d.db, {
      intent_id: input.intent_id,
      revision: input.revision,
      action: "apply",
      status: INTENT_STATUS.failed,
      error_code: linkParsed.code,
    });
    return linkParsed;
  }

  if (lease.node_id === null) {
    await settleLeaseIntent(d.db, {
      intent_id: input.intent_id,
      revision: input.revision,
      action: "apply",
      status: INTENT_STATUS.failed,
      error_code: "internal_error",
    });
    return { ok: false, code: "internal_error", message: "lease has no node to dispatch to" };
  }
  const node = await loadOrchestratorNode(d.db, lease.node_id);
  if (node === null) {
    await settleLeaseIntent(d.db, {
      intent_id: input.intent_id,
      revision: input.revision,
      action: "apply",
      status: INTENT_STATUS.failed,
      error_code: "internal_error",
    });
    return { ok: false, code: "internal_error", message: `node ${lease.node_id} no longer exists` };
  }

  const dispatched = await d.dispatch({
    lease,
    node,
    revision: input.revision,
    runtime_id: runtimeId,
    link: linkParsed.value,
  });

  if (!dispatched.ok) {
    // 失败补偿：把可能已经建起来的 runtime 撤掉、把端口还回去，再如实报告失败。
    // 例外：如果我们这次 revision 已经被更**新**的 revision 超越，runtime 归新的那次，
    // 拆它等于把健康链路干掉（旧 revision 在 Agent 闸门上被判 stale 时正是这条路径）。
    const outcome = await compensateFailedApply(d, lease, input.revision, dispatched.message);
    const code = outcome.superseded ? "intent_revision_stale" : (dispatched.code ?? "internal_error");
    await settleLeaseIntent(d.db, {
      intent_id: input.intent_id,
      revision: input.revision,
      action: "apply",
      status: INTENT_STATUS.failed,
      error_code: code,
    });
    return {
      ok: false,
      code,
      message: outcome.superseded
        ? `${dispatched.message} (revision ${input.revision} was superseded by a newer one; its runtime was left untouched)`
        : outcome.compensated
          ? dispatched.message
          : `${dispatched.message} (compensation incomplete; reconcile will retry)`,
    };
  }

  const updated = (await d.db.federationLease.updateMany({
    where: {
      id: lease.id,
      lease_epoch: lease.lease_epoch,
      state: lease.state,
      // `applied_revision` 也是 CAS 前提：并发里**被超越的 revision 不能把状态往回写**
      // （只带 epoch+state 时，rev8 与 rev9 会双双命中，后写的那次可能是旧的）。
      applied_revision: lease.applied_revision ?? null,
    },
    data: {
      state: "active",
      applied_revision: input.revision,
      applied_at: now,
      last_error_code: null,
      last_error: null,
      // 下发钩子报了配置就写它；没报（注入替身/特殊路径）则保留既有值 —— 不清空，
      // 否则一次"没带配置的成功 apply"会把快照的发布依据抹掉，Agent 下一拍就会剪掉这条腿。
      ...(dispatched.applied_config ? { applied_config: dispatched.applied_config as unknown as object } : {}),
    },
  })) as { count: number };
  if (updated.count === 0) {
    const fresh = (await d.db.federationLease.findUnique({ where: { id: lease.id } })) as FederationLeaseRow | null;

    // (1) 被更新的 revision 超越：runtime 归它，我们**只记账、不拆**。
    if (fresh !== null && fresh.applied_revision !== null && fresh.applied_revision > input.revision) {
      await settleLeaseIntent(d.db, {
        intent_id: input.intent_id,
        revision: input.revision,
        action: "apply",
        status: INTENT_STATUS.failed,
        error_code: "intent_revision_stale",
      });
      await audit(d, {
        action: "lease.apply.superseded",
        direction: input.auditDirection ?? "local",
        peer_panel_id: lease.peer_panel_id,
        message_id: input.messageId ?? null,
        status: 409,
        detail: {
          intent_id: input.intent_id,
          lease_ref: lease.lease_ref,
          revision: input.revision,
          applied_revision: fresh.applied_revision,
        },
      });
      return {
        ok: false,
        code: "intent_revision_stale",
        message: `revision ${input.revision} was superseded by ${fresh.applied_revision} during apply; the newer runtime was left untouched`,
      };
    }

    // (2) 同一 revision 已被另一次投递落库：这就是重投递，返回首次结果（同样不拆）。
    if (fresh !== null && fresh.applied_revision === input.revision) {
      await settleLeaseIntent(d.db, {
        intent_id: input.intent_id,
        revision: input.revision,
        action: "apply",
        status: INTENT_STATUS.ok,
        lease_id: lease.id,
      });
      return {
        ok: true,
        state: "active",
        applied_revision: input.revision,
        lease_epoch: fresh.lease_epoch,
        replayed: true,
        node_ref: node.node_id,
        port: fresh.listen_port ?? lease.listen_port,
      };
    }

    // (3) 世代/状态真的变了（revoke / release / expire / epoch 前进）：刚建起来的 runtime 必须撤掉。
    const outcome = await compensateFailedApply(d, lease, input.revision, "lease state changed concurrently during apply");
    return {
      ok: false,
      code: outcome.compensated ? "duplicate_message" : outcome.superseded ? "intent_revision_stale" : "internal_error",
      message: outcome.superseded
        ? `revision ${input.revision} was superseded while applying; the newer runtime was left untouched`
        : outcome.compensated
          ? "lease state changed concurrently during apply; the freshly dispatched runtime was rolled back"
          : "lease state changed concurrently during apply and the rollback failed; reconcile will retry",
    };
  }

  await settleLeaseIntent(d.db, {
    intent_id: input.intent_id,
    revision: input.revision,
    action: "apply",
    status: INTENT_STATUS.ok,
    lease_id: lease.id,
  });

  await audit(d, {
    action: "lease.apply",
    direction: input.auditDirection ?? "local",
    peer_panel_id: lease.peer_panel_id,
    message_id: input.messageId ?? null,
    status: 200,
    detail: {
      intent_id: input.intent_id,
      lease_ref: lease.lease_ref,
      lease_epoch: lease.lease_epoch,
      revision: input.revision,
      runtime_id: runtimeId,
      node_id: lease.node_id,
      port: lease.listen_port,
    },
  });

  return {
    ok: true,
    state: "active",
    applied_revision: input.revision,
    lease_epoch: lease.lease_epoch,
    replayed: false,
    node_ref: node.node_id,
    port: lease.listen_port,
  };
}

/**
 * apply 失败/被抢的补偿：先撤 runtime（可能没建起来，Agent 对未知 id 是 no-op），
 * 再还端口，最后把行记 `failed` + 可解释原因。
 *
 * ── 被超越时**只记账不拆** ──
 * 补偿前先重读：若这一行已经被**更晚**的 revision 应用（`applied_revision > failedRevision`），
 * 那么 `tunex-fed-<ref>-<dir>` 这个 runtime 现在属于新的 revision。补偿用的 remove 是
 * `revision = lease_epoch + 1`（必然通过 Agent 闸门），拆下去会把刚建好的健康链路干掉，
 * 而库里还留着 `active@N` —— 静默的数据面中断。所以这种情况只写审计台账、**不调 teardown**、
 * 也不把行改成 `failed`。
 */
async function compensateFailedApply(
  d: ResolvedLeaseDeps,
  lease: FederationLeaseRow,
  failedRevision: number,
  message: string,
): Promise<{ compensated: boolean; superseded: boolean }> {
  const fresh = (await d.db.federationLease.findUnique({ where: { id: lease.id } })) as FederationLeaseRow | null;
  if (fresh !== null && fresh !== undefined && fresh.applied_revision !== null && fresh.applied_revision > failedRevision) {
    await audit(d, {
      action: "lease.apply.superseded",
      direction: "local",
      peer_panel_id: lease.peer_panel_id,
      status: 409,
      detail: {
        intent_id: lease.intent_id,
        lease_ref: lease.lease_ref,
        failed_revision: failedRevision,
        applied_revision: fresh.applied_revision,
        superseded_by: fresh.applied_revision,
      },
    });
    return { compensated: false, superseded: true };
  }

  const hopRole = (HOP_ROLES as readonly string[]).includes(lease.hop_role) ? (lease.hop_role as HopRole) : "egress";
  let stopped = true;
  let stopNote: string | null = null;
  if (d.teardown === null) {
    stopped = false;
    stopNote = "teardown hook is not wired";
  } else {
    const res = await d.teardown({
      lease_ref: lease.lease_ref,
      peer_panel_id: lease.peer_panel_id,
      intent_id: lease.intent_id,
      node_id: lease.node_id,
      listen_port: lease.listen_port,
      hop_role: hopRole,
      lease_epoch: lease.lease_epoch,
      reason: "failed",
    });
    stopped = res.ok;
    if (!res.ok) stopNote = res.message ?? "teardown failed";
  }

  let portReleased = true;
  if (stopped && lease.node_id !== null && lease.listen_port !== null) {
    const rel = await d.releasePort({ node_id: lease.node_id, port: lease.listen_port });
    portReleased = rel.ok;
    if (!rel.ok) stopNote = rel.message ?? "port release failed";
  }

  const ok = stopped && portReleased;
  // 这里的写入同样带 CAS 前提（含 applied_revision）：若在我们补偿期间又有新 revision 落库，
  // 这次写入应当**失败**（0 行）而不是把新状态覆盖成 failed。
  const marked = (await d.db.federationLease.updateMany({
    where: {
      id: lease.id,
      lease_epoch: lease.lease_epoch,
      state: lease.state,
      applied_revision: lease.applied_revision ?? null,
    },
    data: {
      state: "failed",
      last_error_code: ok ? null : stopped ? PORT_RELEASE_PENDING_CODE : "internal_error",
      last_error: ok ? `apply failed and was compensated: ${message}` : `apply failed; compensation pending: ${stopNote}`,
    },
  })) as { count: number };
  if (marked.count === 0) {
    // 补偿期间状态又变了：不覆盖（新状态的所有者会负责自己的收尾），如实报告未完成。
    return { compensated: false, superseded: false };
  }
  return { compensated: ok, superseded: false };
}

/* ================================================================== */
/* 续约（host 侧）                                                      */
/* ================================================================== */

/**
 * 续约窗口序号：`floor(now / ttl)`。
 *
 * 为什么续约的幂等键需要它：契约的 `(intent_id, revision, action)` 对 create/apply/release 都对
 * ——那些是"同一次申请"。但续约是**周期动作**，而 home 侧的 revision 在 Forward 没改版时**不会变**，
 * 于是同一 `(intent_id, revision, "renew")` 会一直命中"重投递返回首次结果"，到期时间永远停在
 * 第一次续约那一刻：一条一直在正常续约的腿会被自己的幂等机制判死。
 *
 * 窗口 = 以 TTL 为格的时钟，同一窗口内的网络重试仍然只推一次期（保留幂等的收益），
 * 跨窗口就是新的一次续约（周期性续约的正常路径）。
 */
export function renewalWindowIndex(now: Date, ttlSeconds: number): number {
  return Math.floor(now.getTime() / (ttlSeconds * 1000));
}

export interface RenewRemoteLeaseInput {
  lease_ref: string;
  intent_id: string;
  /** 幂等键里的 revision（续约不改 applied_revision，只用它做去重）。 */
  revision: number;
  ttlSeconds?: number;
  auditDirection?: "inbound" | "outbound" | "local";
  messageId?: string | null;
}

export type RenewRemoteLeaseOutcome =
  | { ok: true; lease_epoch: number; expires_at: Date }
  | { ok: false; code: FederationErrorCode; message: string };

/**
 * 续约：**同 epoch** 只把到期时间往后推（与 `placement-lease` 的"续约同 epoch"同源）。
 *
 * 续约必须过 `evaluateLeaseRenewal` 而不是无脑推时间，原因是 Lead 2026-10-05 的硬要求：
 * **suspend 期间已有 lease 到期不再续**。少了这一步，"挂起"就退化成"无限期继续服务"——
 * 它比不挂起更糟，因为它给了管理员一个假的截止承诺。
 * 续约也不允许越过 grant 的 `expires_at`（租约不得活得比授权久）。
 */
export async function renewRemoteLease(
  input: RenewRemoteLeaseInput,
  deps?: LeaseHostDeps,
): Promise<RenewRemoteLeaseOutcome> {
  const d = resolveLeaseDeps(deps);
  const now = d.now();

  if (typeof input.lease_ref !== "string" || input.lease_ref.length === 0) {
    return { ok: false, code: "message_malformed", message: "lease_ref is required" };
  }
  if (typeof input.intent_id !== "string" || input.intent_id.length === 0) {
    return { ok: false, code: "message_malformed", message: "intent_id is required" };
  }
  if (!Number.isInteger(input.revision) || input.revision < 0) {
    return { ok: false, code: "message_malformed", message: "revision must be a non-negative integer" };
  }

  const lease = (await d.db.federationLease.findUnique({ where: { lease_ref: input.lease_ref } })) as FederationLeaseRow | null;
  if (lease === null || lease === undefined) return { ok: false, code: "lease_not_found", message: "lease not found" };
  if (lease.intent_id !== input.intent_id) {
    return { ok: false, code: "message_malformed", message: `lease ${input.lease_ref} belongs to a different intent` };
  }
  if (lease.state === "revoked") return { ok: false, code: "lease_revoked", message: "lease is revoked" };
  if (lease.state === "expired") return { ok: false, code: "lease_expired", message: "lease is expired" };
  if (lease.state === "released") return { ok: false, code: "lease_not_found", message: "lease is already released" };
  if (lease.state === "releasing") {
    return { ok: false, code: "duplicate_message", message: "lease is being released; renewal refuses to race it" };
  }

  const ttlSeconds = input.ttlSeconds ?? d.ttlSeconds;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    return { ok: false, code: "message_malformed", message: "ttlSeconds must be a positive integer" };
  }
  // 续约的幂等键带**窗口**：同一窗口内的重试只推一次期，跨窗口是新的一次续约。
  const action: LeaseActionKey = `renew@${renewalWindowIndex(now, ttlSeconds)}`;

  const claim = await claimLeaseIntent(d.db, {
    intent_id: input.intent_id,
    peer_panel_id: lease.peer_panel_id,
    revision: input.revision,
    action,
    now,
  });
  if (claim.kind === "in_flight") {
    return {
      ok: false,
      code: "duplicate_message",
      message: `renewal for intent ${input.intent_id} revision ${input.revision} is already being processed; retry later`,
    };
  }
  if (claim.kind === "done") {
    // 同一窗口的重投递：返回首次结果（到期时间就是那一次推到的值，不会变）。
    return { ok: true, lease_epoch: lease.lease_epoch, expires_at: lease.expires_at };
  }

  const grant = (await d.db.federationGrant.findUnique({ where: { id: lease.grant_id } })) as GrantRowLike | null;
  if (grant === null || grant === undefined) {
    await settleLeaseIntent(d.db, {
      intent_id: input.intent_id,
      revision: input.revision,
      action,
      status: INTENT_STATUS.failed,
      error_code: "grant_not_found",
    });
    return { ok: false, code: "grant_not_found", message: `grant ${lease.grant_id} no longer exists` };
  }

  const nodeRow = lease.node_id === null
    ? null
    : ((await d.db.node.findUnique({
        where: { id: lease.node_id },
        select: { node_group_id: true },
      })) as { node_group_id: number | null } | null);

  const decision = evaluateLeaseRenewal({
    grant,
    hopRole: lease.hop_role,
    nodeGroupId: nodeRow?.node_group_id ?? null,
    workspaceId: grant.workspace_id ?? null,
    activeLegs: 0,
    now,
  });
  if (!decision.allow) {
    // 不推时间 = 让它按原到期时刻被 expireLeases 收口。这就是"挂起期间到期不再续"的落点，
    // 换了窗口化幂等键之后这一步仍然在**任何写入之前**。
    await settleLeaseIntent(d.db, {
      intent_id: input.intent_id,
      revision: input.revision,
      action,
      status: INTENT_STATUS.failed,
      error_code: decision.code,
    });
    return { ok: false, code: decision.code, message: decision.message };
  }

  const ttlExpiry = new Date(now.getTime() + ttlSeconds * 1000);
  const candidate = decision.expires_at.getTime() < ttlExpiry.getTime() ? decision.expires_at : ttlExpiry;
  // **到期时间只许前进**：一次带更小 ttl 的续约（或时钟回拨）不得把到期时间改小，
  // 否则"续约"会变成"提前断线"。
  const expiresAt = new Date(Math.max(lease.expires_at.getTime(), candidate.getTime()));

  // 续约是**同 epoch** 的更新：CAS 带 epoch + 原状态 + 原到期时间，既防和释放/撤销互相覆盖，
  // 也防两个并发续约互相覆盖（后写的不能把先写的更晚的到期时间改回来）。
  const updated = (await d.db.federationLease.updateMany({
    where: { id: lease.id, lease_epoch: lease.lease_epoch, state: lease.state, expires_at: lease.expires_at },
    data: { expires_at: expiresAt },
  })) as { count: number };
  if (updated.count === 0) {
    const fresh = (await d.db.federationLease.findUnique({ where: { id: lease.id } })) as FederationLeaseRow | null;
    if (fresh !== null && fresh !== undefined && !isTerminalLeaseState(fresh.state) && fresh.expires_at.getTime() >= expiresAt.getTime()) {
      // 并发续约已经把到期时间推得比我们打算写的更晚（或一样）：收敛，不重试。
      await settleLeaseIntent(d.db, {
        intent_id: input.intent_id,
        revision: input.revision,
        action,
        status: INTENT_STATUS.ok,
        lease_id: lease.id,
      });
      return { ok: true, lease_epoch: fresh.lease_epoch, expires_at: fresh.expires_at };
    }
    return { ok: false, code: "internal_error", message: "lease renewal lost the CAS race; re-read and retry" };
  }

  await settleLeaseIntent(d.db, {
    intent_id: input.intent_id,
    revision: input.revision,
    action,
    status: INTENT_STATUS.ok,
    lease_id: lease.id,
  });
  await audit(d, {
    action: "lease.renew",
    direction: input.auditDirection ?? "local",
    peer_panel_id: lease.peer_panel_id,
    message_id: input.messageId ?? null,
    status: 200,
    detail: {
      intent_id: input.intent_id,
      lease_ref: lease.lease_ref,
      lease_epoch: lease.lease_epoch,
      revision: input.revision,
      expires_at: expiresAt.toISOString(),
      grant_epoch: decision.grant_epoch,
      renew_window: action,
    },
  });

  return { ok: true, lease_epoch: lease.lease_epoch, expires_at: expiresAt };
}

/* ================================================================== */
/* peer 撤销 / 已撤销租约的清理扫尾                                       */
/* ================================================================== */

export interface SweepRevokedResult {
  evaluated: number;
  /** 本轮确认停服成功的条数（只统计真正调过 teardown 的行）。 */
  stopped: number;
  teardown_failed: number;
  ports_released: number;
  ports_pending: number;
  /** 只补还端口、不需要再停服的行数（`expired`/`released`，或已带端口待还标记的 revoked 行）。 */
  port_only_retried: number;
  skipped: number;
}

/**
 * 扫尾"终态但收尾未确认"的租约。两类：
 *   1. `revoked` 且停服未确认（`peer_revoked` / `internal_error`）→ 补停服 + 还端口；
 *   2. 只剩端口没还（`port_release_failed`），无论 state 是 `revoked` / `expired` / `released` → **只补还端口**。
 *
 * 为什么必须有它：撤销/到期路径**先落状态再尽力收尾**（fail-closed：拿不准时它必须停），
 * 于是"状态已终态、runtime 可能还在 / 端口还没还"是正常存在的中间态。没有扫尾，这种行会
 * 永远留在库里、端口也永远不还——"机制不存在"与"机制运行过但不生效"的区别就在这里。
 *
 * 判据用的是**显式标记**（`PORT_RELEASE_PENDING_CODE` / `PEER_REVOKE_PENDING_CODE` /
 * `internal_error`），不是"靠 state 猜"：schema 没有独立的"端口已归还"列，那就用一个
 * 明确的码表达它，而不是第二个隐式约定。幂等：确认完成后标记被清空（不再是候选）；
 * Agent 对未知 id 的 remove 也是 no-op，重复撤不会炸。
 */
export async function sweepRevokedLeaseCleanup(
  options: { peer_panel_id?: string | null; now?: Date; limit?: number; deps?: LeaseHostDeps } = {},
): Promise<SweepRevokedResult> {
  const d = resolveLeaseDeps(options.deps);
  const now = options.now ?? d.now();

  const candidates = (await d.db.federationLease.findMany({
    where: {
      last_error_code: { in: [PEER_REVOKE_PENDING_CODE, PORT_RELEASE_PENDING_CODE, "internal_error"] },
      state: { in: ["revoked", "expired", "released"] },
      ...(options.peer_panel_id ? { peer_panel_id: options.peer_panel_id } : {}),
    },
    take: options.limit ?? EXPIRE_BATCH_LIMIT,
  })) as FederationLeaseRow[];

  const result: SweepRevokedResult = {
    evaluated: candidates.length,
    stopped: 0,
    teardown_failed: 0,
    ports_released: 0,
    ports_pending: 0,
    port_only_retried: 0,
    skipped: 0,
  };

  for (const lease of candidates) {
    const hasPort = lease.node_id !== null && lease.listen_port !== null;
    // `revoked` + 端口待还标记 = 停服早就成功过，只剩端口；终态 expired/released 同理，不可能还需要拆。
    const needsTeardown = lease.state === "revoked" && lease.last_error_code !== PORT_RELEASE_PENDING_CODE;

    if (!needsTeardown && !hasPort) {
      // 既没有要拆的 runtime 也没有要还的端口：直接确认收口。
      await d.db.federationLease.updateMany({
        where: { id: lease.id, lease_epoch: lease.lease_epoch, state: lease.state },
        data: { last_error_code: null, last_error: `cleanup confirmed (nothing to stop or release) at ${now.toISOString()}` },
      });
      result.skipped++;
      continue;
    }

    if (!needsTeardown) result.port_only_retried++;

    if (needsTeardown) {
      const hopRole = (HOP_ROLES as readonly string[]).includes(lease.hop_role) ? (lease.hop_role as HopRole) : "egress";
      let stopped = false;
      let note: string | null = null;
      if (d.teardown === null) {
        note = "teardown hook is not wired";
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
        if (!res.ok) note = res.message ?? "teardown failed";
      }
      if (!stopped) {
        result.teardown_failed++;
        await d.db.federationLease.updateMany({
          where: { id: lease.id, lease_epoch: lease.lease_epoch, state: lease.state },
          data: { last_error_code: "internal_error", last_error: note },
        });
        continue;
      }
      result.stopped++;
    }

    let portReleased = true;
    let note: string | null = null;
    if (hasPort) {
      const rel = await d.releasePort({ node_id: lease.node_id as number, port: lease.listen_port as number });
      portReleased = rel.ok;
      if (rel.ok) result.ports_released++;
      else {
        result.ports_pending++;
        note = rel.message ?? "port release failed";
      }
    }

    await d.db.federationLease.updateMany({
      where: { id: lease.id, lease_epoch: lease.lease_epoch, state: lease.state },
      data: {
        last_error_code: portReleased ? null : PORT_RELEASE_PENDING_CODE,
        last_error: portReleased
          ? `settled: runtime stopped and port released (confirmed at ${now.toISOString()})`
          : note,
      },
    });
  }

  return result;
}

/**
 * 注册"peer 信任被撤销 → 立刻停服该 peer 的所有腿并还端口"的钩子（契约 §2.4）。
 *
 * `trust.ts` 的撤销级联已经把 lease 状态置 `revoked` 并留 `last_error_code = "peer_revoked"`，
 * 但它**不能**替我们撤 runtime（那是本模块的下发通道）。这个钩子补的正是那一步。
 *
 * 调用点：启动时一次（与 relay-wiring 的初始化同层）。Lead 会在 app 启动/路由初始化里加一行。
 */
export function installFederationRevocationHook(deps?: LeaseHostDeps): void {
  setFederationRevokedHook(async (peerPanelId: string) => {
    const result = await sweepRevokedLeaseCleanup({ peer_panel_id: peerPanelId, deps });
    console.log(`[federation] peer ${peerPanelId} revoked: ${JSON.stringify(result)}`);
  });
}

/** 测试辅助：解除注册。 */
export function uninstallFederationRevocationHook(): void {
  setFederationRevokedHook(null);
}

/* ================================================================== */
/* 到期扫描                                                            */
/* ================================================================== */

/**
 * 一拍到期收口的汇总（§4.3：决策必须留痕，没留痕的机制与从未运行过的机制无法区分）。
 * 调用方把这一行原样打进日志。
 */
export interface ExpireLeasesResult {
  /** 本轮扫到的到期候选。 */
  evaluated: number;
  /** 收口成 expired 的条数。 */
  expired: number;
  /** 停服成功的条数。 */
  tore_down: number;
  /** 停服失败的条数（下一拍重试）。 */
  teardown_failed: number;
  /** 因竞争/状态变化本轮未处理的条数（交给下一拍）。 */
  skipped: number;
  ports_released: number;
  /** 停服未成功而不还端口的条数（这是**对的**：可能还在 listen）。 */
  ports_pending: number;
}

/**
 * 到期 → 停服 → 还端口 → `expired`（契约 §3.2 释放 + §5 矩阵）。
 *
 * 与撤销的区别只在"为什么停"：撤销是权威取消（立刻，不等到期），到期是时间到了。
 * 两者共用同一条"先停服后还端口"的顺序。
 *
 * 也在这一拍里重试 `failed` 的行：上一拍停服失败会留下 `failed`，它必须被反复重试，
 * 否则一次网络抖动就会把一条"还占着端口、可能还在跑"的链路永久留在库里。
 */
export async function expireLeases(
  options: { now?: Date; limit?: number; deps?: LeaseHostDeps } = {},
): Promise<ExpireLeasesResult> {
  const d = resolveLeaseDeps(options.deps);
  const now = options.now ?? d.now();
  const limit = options.limit ?? EXPIRE_BATCH_LIMIT;

  const due = (await d.db.federationLease.findMany({
    where: {
      state: { in: ["reserved", "active", "releasing", "failed"] },
      expires_at: { lte: now },
    },
    take: limit,
    orderBy: { expires_at: "asc" },
  })) as FederationLeaseRow[];

  const result: ExpireLeasesResult = {
    evaluated: due.length,
    expired: 0,
    tore_down: 0,
    teardown_failed: 0,
    skipped: 0,
    ports_released: 0,
    ports_pending: 0,
  };

  for (const lease of due) {
    if (!isLiveLeaseState(lease.state) && lease.state !== "failed") {
      result.skipped++;
      continue;
    }

    // 1) 先进入 releasing（CAS）。failed 的行也允许回到 releasing —— 那是补偿重试的正路。
    if (lease.state !== "releasing") {
      const okTransition = assertLeaseTransition(lease.state, "releasing");
      if (!okTransition.ok) {
        result.skipped++;
        continue;
      }
      const moved = (await d.db.federationLease.updateMany({
        where: { id: lease.id, lease_epoch: lease.lease_epoch, state: lease.state },
        data: { state: "releasing" },
      })) as { count: number };
      if (moved.count === 0) {
        result.skipped++;
        continue;
      }
    }

    // 2) 停服。
    const hopRole: HopRole = (HOP_ROLES as readonly string[]).includes(lease.hop_role)
      ? (lease.hop_role as HopRole)
      : "egress";
    let stopped = false;
    let stopMessage: string | null = null;
    if (d.teardown === null) {
      stopMessage = "teardown hook is not wired";
    } else {
      const res = await d.teardown({
        lease_ref: lease.lease_ref,
        peer_panel_id: lease.peer_panel_id,
        intent_id: lease.intent_id,
        node_id: lease.node_id,
        listen_port: lease.listen_port,
        hop_role: hopRole,
        lease_epoch: lease.lease_epoch,
        reason: "expired",
      });
      stopped = res.ok;
      if (!res.ok) stopMessage = res.message ?? "teardown failed";
    }

    if (!stopped) {
      result.teardown_failed++;
      if (lease.node_id !== null && lease.listen_port !== null) result.ports_pending++;
      await d.db.federationLease.updateMany({
        where: { id: lease.id, lease_epoch: lease.lease_epoch },
        data: { state: "failed", last_error_code: "internal_error", last_error: stopMessage },
      });
      continue;
    }
    result.tore_down++;

    // 3) 停服成功 → 还端口（顺序铁律）。
    let portReleased = true;
    let portMessage: string | null = null;
    if (lease.node_id !== null && lease.listen_port !== null) {
      const rel = await d.releasePort({ node_id: lease.node_id, port: lease.listen_port });
      portReleased = rel.ok;
      if (!rel.ok) {
        portMessage = rel.message ?? "port release failed";
        result.ports_pending++;
      } else {
        result.ports_released++;
      }
    }

    // 4) 收口成 expired。端口没还上也要收口：链路状态是"已停止服务"这个事实，
    //    端口那笔账由 last_error + portPool reconcile 兜底，不改变状态真相。
    const finished = (await d.db.federationLease.updateMany({
      where: { id: lease.id, lease_epoch: lease.lease_epoch, state: "releasing" },
      data: {
        state: "expired",
        released_at: now,
        last_error_code: portReleased ? null : PORT_RELEASE_PENDING_CODE,
        last_error: portReleased ? null : `port release pending: ${portMessage}`,
      },
    })) as { count: number };
    if (finished.count === 0) {
      result.skipped++;
      continue;
    }
    result.expired++;

    await audit(d, {
      action: "lease.expire",
      direction: "local",
      peer_panel_id: lease.peer_panel_id,
      status: 200,
      detail: {
        intent_id: lease.intent_id,
        lease_ref: lease.lease_ref,
        lease_epoch: lease.lease_epoch,
        port_released: portReleased,
      },
    });
  }

  return result;
}

/* ================================================================== */
/* 单例接线（幂等）                                                      */
/* ================================================================== */

let federationWired = false;

/**
 * 幂等接线：注册"peer 信任被撤销 → 立刻停服该 peer 的所有腿并还端口" + 把生产停服/还端口
 * 实现交给 grant 级联使用。启动/worker 初始化时调一次即可（重复调用是 no-op）。
 *
 * 为什么是"注册"而不是"各处自己 new"：停服与还端口各只能有一份实现，
 * 而 grant.ts 因为循环依赖不能直接 import 本文件。
 */
export function ensureFederationWiring(deps?: LeaseHostDeps): void {
  if (federationWired && deps === undefined) return;
  registerFederationCascadeHooks({
  teardown: (input) => defaultTeardown(input, defaultLeaseDb),
  releasePort: defaultReleasePort,
});
  setFederationRevokedHook(async (peerPanelId: string) => {
    const cleanup = await sweepRevokedLeaseCleanup({ peer_panel_id: peerPanelId, deps });
    console.log(`[federation] peer ${peerPanelId} revoked: ${JSON.stringify(cleanup)}`);
  });
  federationWired = true;
}

/** 测试辅助：复位接线标记（钩子本身用 uninstall 清）。 */
export function resetFederationWiringForTests(): void {
  federationWired = false;
}

/* ================================================================== */
/* 周期 reconcile（worker 每一拍）                                       */
/* ================================================================== */

export interface FederationReconcileSummary {
  /** expireLeases 扫到的到期候选。 */
  evaluated: number;
  expired: number;
  tore_down: number;
  teardown_failed: number;
  ports_released: number;
  ports_pending: number;
  /** 本轮被收口的 grant 数。 */
  grants_expired: number;
  /** 本轮参与对账的 placement 数（worker 打印用；= 重发 + 降级 + 失败 + 已收敛）。 */
  placements_reconciled: number;
  /** 本轮扫尾确认停服成功的已撤销租约数（worker 打印用）。 */
  revoked_leases: number;
  /** placement 对上账（重发成功）的条数。 */
  resent: number;
  /** peer 不可达而降级的 placement 条数（**没有**本地回落）。 */
  placement_degraded: number;
  /** 本轮实际发出的探活次数（task-10：已收敛行也要复核远端）。 */
  placements_probed: number;
  /** 探活后发现远端仍 live 且未落后、本行从非 active 回到 active 的条数。 */
  placements_recovered: number;
  /** 本地判定到期（或探活发现远端已终态）而收口成 expired 的条数。 */
  placements_expired: number;
  /** 已撤销但停服未确认、本轮补停成功的租约条数（扫尾）。 */
  revoked_cleaned: number;
  /** 扫尾里仍然停不下来的条数（下一拍继续）。 */
  revoked_teardown_failed: number;
}

/**
 * 联邦周期 reconcile。顺序**固定**（契约 §4.3：先本地 reconcile 之后，再联邦这一节拍）：
 *
 *     expireGrants → expireLeases → sweepRevokedLeaseCleanup → placement 对账
 *
 * 为什么 grant 到期排在 lease 到期之前：grant 到期只意味着"不许再要新的"，
 * 而已有 lease 必须按**自己的** `expires_at` 收口（两个时钟本来就不是一个）。
 * 先扫 grant 只是让"新 intent 被拒"这件事尽早成立，不会影响已有链路的存活时长。
 *
 * 每一拍都返回可打印的汇总（§8 教训：决策不留痕的机制与从未运行过的机制无法区分）。
 */
export interface FederationReconcileDeps {
  lease?: LeaseHostDeps;
  /** grant 侧要自己的 DB 接缝（两张表的 Prisma 投影形状不同，不能互相顶替）。 */
  grant?: GrantDeps;
  placement?: PlacementDeps;
}

export async function runFederationReconcile(
  now?: Date,
  deps?: FederationReconcileDeps,
): Promise<FederationReconcileSummary> {
  const at = now ?? new Date();

  const grants = await expireGrants({ now: at }, { ...(deps?.grant ?? {}), now: () => at });
  const leases = await expireLeases({ now: at, deps: { ...(deps?.lease ?? {}), now: () => at } });
  const revoked = await sweepRevokedLeaseCleanup({ now: at, deps: { ...(deps?.lease ?? {}), now: () => at } });
  const placement = await reconcilePlacements({ now: at, deps: { ...(deps?.placement ?? {}), now: () => at } });

  // V5.5 WP15：placement 对账**之后立刻**做 Forward 健康收口。
  //
  // 为什么必须在这里（而不是留给本机 reconcile 的上一拍）：本机 reconcile 跑在联邦这一拍**之前**，
  // 它读到的永远是上一拍的 placement 状态 ⇒ "远端腿已恢复"要等下一拍（≈30s）才被本机的
  // 入口腿重建看到。用户看到的症状是"链路明明回来了、还要再等半分钟"。
  // 动态 import 是为了不引入静态环（forward-hop 是联邦的下游消费者）。
  try {
    const hop = await import("./forward-hop.ts");
    await hop.reconcileFederatedForwardHealth({ now: at });
  } catch (e) {
    // 健康收口失败绝不阻断联邦对账（它只是"把事实写进可见状态 + 触发恢复"）。
    console.warn("[federation] forward health reconcile failed:", e instanceof Error ? e.message : e);
  }

  return {
    evaluated: leases.evaluated,
    expired: leases.expired,
    tore_down: leases.tore_down,
    teardown_failed: leases.teardown_failed,
    ports_released: leases.ports_released,
    ports_pending: leases.ports_pending,
    grants_expired: grants.expired,
    placements_reconciled: placement.evaluated,
    revoked_leases: revoked.stopped,
    resent: placement.resent,
    placement_degraded: placement.degraded,
    placements_probed: placement.probed,
    placements_recovered: placement.recovered,
    placements_expired: placement.expired,
    revoked_cleaned: revoked.stopped,
    revoked_teardown_failed: revoked.teardown_failed,
  };
}

/* ================================================================== */
/* grant 撤销级联用得到的公共查询（供 grant.ts 复用同一把尺子）              */
/* ================================================================== */

/** 某 grant 下当前**活跃** leg 数（容量判定的输入）。 */
export async function countActiveLegs(grantId: number, deps?: LeaseHostDeps): Promise<number> {
  const d = resolveLeaseDeps(deps);
  return d.db.federationLease.count({
    where: { grant_id: grantId, state: { in: LIVE_LEASE_STATES as unknown as string[] } },
  });
}

/** 只读：按 intent 载入当前 lease（reconcile / 路由用它，不另写查询形状）。 */
export async function loadLeaseByIntent(intentId: string, deps?: LeaseHostDeps): Promise<FederationLeaseRow | null> {
  const d = resolveLeaseDeps(deps);
  return loadLeaseByIdOrIntent(d.db, null, intentId);
}

export const __internals = { loadLeaseByIdOrIntent, leaseIntentKey, LEASE_INTENT_ACTIONS };
