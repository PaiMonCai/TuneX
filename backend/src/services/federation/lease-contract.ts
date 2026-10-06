/**
 * Pure Federation lease contract and planning rules.
 *
 * This module deliberately contains no DB, orchestrator, trust wiring or network hooks.
 * Keep state transitions and intent validation testable without production side effects.
 */
import {
  HOP_ROLES,
  LEASE_STATES,
  evaluateGrant,
  nextLeaseEpoch,
  type EvaluateGrantInput,
  type GrantDecision,
  type GrantRowLike,
  type HopRole,
  type LeaseState,
  type ParseResult,
} from "./grant.ts";
import type { FederationErrorCode } from "./errors.ts";
import { isValidPort } from "../portPool.ts";

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

