/**
 * Federation lease persistence/dependency seam and intent idempotency.
 *
 * Remote runtime side effects remain in lease.ts; this module owns the DB
 * projection, default dependency wiring and exactly-once intent ledger.
 */

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

/* Pure lease contract lives separately from host-side IO/execution. */
import { DEFAULT_LEASE_TTL_SECONDS, LEASE_INTENT_PENDING_TTL_MS, EXPIRE_BATCH_LIMIT, assertLeaseTransition, validateLeaseIntent, planLeaseApply, evaluateLeaseRenewal } from "./lease-contract.ts";
import type { LeaseIntent, LeaseApplyPlan } from "./lease-contract.ts";
export { DEFAULT_LEASE_TTL_SECONDS, LEASE_RECONCILE_TICK_SECONDS, LEASE_INTENT_PENDING_TTL_MS, EXPIRE_BATCH_LIMIT, LEASE_TRANSITIONS, canTransitionLease, assertLeaseTransition, validateLeaseIntent, DISPATCH_BY_HOP_ROLE, planLeaseApply, evaluateLeaseRenewal } from "./lease-contract.ts";
export type { LeaseRequested, LeaseIntent, NormalizedLeaseIntent, LeaseDispatchAction, LeaseDispatchStep, LeaseApplyPlan, PlanLeaseApplyInput, PlanLeaseApplyOutcome } from "./lease-contract.ts";


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

export interface ResolvedLeaseDeps {
  db: LeaseDb;
  audit: FederationAuditSink;
  now: () => Date;
  dispatch: LeaseDispatchHook;
  allocatePort: PortAllocateHook;
  releasePort: PortReleaseHook;
  teardown: LeaseTeardownHook | null;
  ttlSeconds: number;
}

export const defaultLeaseDb = db as unknown as LeaseDb;

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
export async function defaultReleasePort(input: { node_id: number; port: number }) {
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

export function resolveLeaseDeps(over?: LeaseHostDeps): ResolvedLeaseDeps {
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

export async function audit(d: ResolvedLeaseDeps, input: Parameters<FederationAuditSink>[0]): Promise<void> {
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

