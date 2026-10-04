/**
 * V5.5 WP15/WP16 —— home 侧镜像与重连对账。契约：`docs/v5-wp14-16-federation-contract.md` §3.4 / §4.2 / §5。
 *
 * 这个文件只做一件事：**把"我想要什么"与"远端说它做成了什么"对齐**。
 * 它**不是**第二套 desired state —— Forward 的期望真相仍是本机 Forward desired，
 * `federation_placement` 只是账本里的**证据行**（§3.4）。三条硬规则：
 *
 *   1. **`(peer_panel_id, intent_id)` 唯一**：一个意图在一个 peer 上只有一行镜像，
 *      重放/重试只更新这一行，不产生第二份；
 *   2. **按 `(intent_id, revision)` 重发未确认的 intent**：只在 `applied_revision < desired_revision`
 *      或从未确认时重发；`applied_revision` 是远端汇报的**事实**，不是我们的期望；
 *   3. **peer 不可达 → `degraded(unreachable)`，绝不回落本地节点**（§5 / §7）。
 *      回落到本地是一次未经用户同意的重放置，比"暂时不可用"严重得多——本模块里
 *      对应的代码就是"只改这一行的状态"，不碰任何 tunnel/runtime。
 *
 * 出站只走 `client.callPeer`（签名 / 超时 / 重试 / 错误分类的唯一实现），
 * 这里通过注入的 `FederationIntentSender` 使用它，于是对账逻辑可以离线断言。
 */
import { db } from "../../db.ts";
import { callPeer } from "./client.ts";
import type { FederationErrorCode } from "./errors.ts";
import { HOP_ROLES, type FederationAuditSink, type HopRole } from "./grant.ts";

/* ================================================================== */
/* 状态词表（应用层字符串；schema 明确不用 DB enum）                      */
/* ================================================================== */

export const PLACEMENT_STATES = ["pending", "active", "degraded", "expired", "revoked", "failed"] as const;
export type PlacementState = (typeof PLACEMENT_STATES)[number];

export const PLACEMENT_TERMINAL_STATES: readonly PlacementState[] = ["expired", "revoked"];

/**
 * 每拍**探活上限**。
 *
 * 探活是对 peer 的一次真实 `GET /leases/:ref`：它必须"有界"，否则一台挂掉的 host + 上千条
 * 远端腿会让 worker 那一拍卡在超时里（每条几秒 × N）。20 条的取值理由：worker 节拍是 30s，
 * 单条探活超时 8s（callPeer 默认），即使 20 条全部串行超时也仍在两拍之内；
 * 超过上限的行**按原状态留到下一拍**（不降级、不假装成功），并计进 `deferred` 让日志看得见。
 */
export const MAX_PLACEMENT_PROBES_PER_TICK = 20;

export function isTerminalPlacementState(state: string): boolean {
  return (PLACEMENT_TERMINAL_STATES as readonly string[]).includes(state);
}

/**
 * 远端租约状态 → 本机镜像状态。
 *
 * 注意 `released` 映射成 `expired`：对 home 侧而言"这条远端腿已经没了"，
 * 而 `expired` 才是账本里表达"结束但非撤销"的状态；`revoked` 专留给"被权威撤销"。
 */
export function mapRemoteLeaseStateToPlacement(remoteState: string): { state: PlacementState; note: string } | null {
  switch (remoteState) {
    case "reserved":
      return { state: "pending", note: "remote reserved" };
    case "active":
      return { state: "active", note: "remote applied" };
    case "releasing":
      return { state: "degraded", note: "remote is releasing" };
    case "released":
      return { state: "expired", note: "remote released" };
    case "expired":
      return { state: "expired", note: "remote expired" };
    case "revoked":
      return { state: "revoked", note: "remote revoked" };
    case "failed":
      return { state: "failed", note: "remote failed" };
    default:
      return null;
  }
}

/* ================================================================== */
/* 纯计划：谁需要重发                                                    */
/* ================================================================== */

export interface FederationPlacementRow {
  id: number;
  peer_panel_id: string;
  forward_ref: string;
  tunnel_id: number | null;
  intent_id: string;
  lease_ref: string | null;
  lease_epoch: number;
  hop_role: string;
  desired_revision: number;
  applied_revision: number | null;
  state: string;
  peer_node_ref: string | null;
  peer_port: number | null;
  last_error_code: string | null;
  last_error: string | null;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface PlacementSyncPlan {
  /** 本地可判定到期（`expires_at <= now`）的行：不需要网络就能收口成 `expired`。 */
  expired: FederationPlacementRow[];
  /** 已收敛（`applied_revision >= desired_revision`）且需要探活确认的行。 */
  probes: FederationPlacementRow[];
  /** 需要按 (intent_id, desired_revision) 重发的行。 */
  resends: FederationPlacementRow[];
  /** 已收敛、但这一拍**没轮到探活**（预算用尽）的行：保持原状，下一拍再说。 */
  converged: FederationPlacementRow[];
  /** peer 不可达 → 只能标 degraded，**不重发、不回落本地**。 */
  degraded: FederationPlacementRow[];
  /** 终态行，不参与对账。 */
  skipped: FederationPlacementRow[];
}

/**
 * 纯函数：给定镜像行与 peer 可达性，算出这一拍该做什么。
 *
 * 分类顺序（**有意的**，每一步都在缩小"我们真的知道什么"）：
 *   1. 终态 → 跳过（历史事实不可重写）；
 *   2. `expires_at <= now` → `expired`：到期是**两侧都知道的事实**，不需要问对端，
 *      也不需要网络。放它在最前面，是为了让"host 挂了"这种最坏情况下本地照样能收口；
 *   3. peer 不可达 → `degraded`（不重发、不猜，也不回落本地）；
 *   4. 已收敛（`applied_revision >= desired_revision`）→ **探活**（有界）；
 *      这一条正是此前的缺口：以前"已收敛"就 `continue`，于是 host 停机后 active 的行永远
 *      不会变 degraded、远端已 expired 的行也不会被镜像；
 *   5. 其余 → 走既有重发路径。
 */
export function planPlacementSync(
  placements: readonly FederationPlacementRow[],
  opts: { peerReachable: boolean; now: Date; probeBudget?: number },
): PlacementSyncPlan {
  const plan: PlacementSyncPlan = { expired: [], probes: [], resends: [], converged: [], degraded: [], skipped: [] };
  let budget = Math.max(0, opts.probeBudget ?? MAX_PLACEMENT_PROBES_PER_TICK);

  for (const row of placements) {
    if (isTerminalPlacementState(row.state)) {
      plan.skipped.push(row);
      continue;
    }
    const expiresAt = row.expires_at === null ? null : new Date(row.expires_at).getTime();
    if (expiresAt !== null && Number.isFinite(expiresAt) && expiresAt <= opts.now.getTime()) {
      plan.expired.push(row);
      continue;
    }
    if (!opts.peerReachable) {
      plan.degraded.push(row);
      continue;
    }
    const converged = row.applied_revision !== null && row.applied_revision >= row.desired_revision;
    if (converged && budget > 0) {
      // 没有 lease_ref 就无从探活（例如只预留过、从未拿到引用）：退回重发路径，
      // 重发本身会带回 lease_ref，比"跳过它"更接近收敛。
      if (row.lease_ref !== null && row.lease_ref !== "") {
        plan.probes.push(row);
        budget--;
        continue;
      }
      plan.resends.push(row);
      continue;
    }
    if (converged) {
      plan.converged.push(row);
      continue;
    }
    plan.resends.push(row);
  }

  return plan;
}

/* ================================================================== */
/* 探活：远端租约事实的读取（GET /leases/:ref）                            */
/* ================================================================== */

/** host 侧租约的探活投影（`GET /leases/:ref` 的响应形状）。 */
export interface RemoteLeaseFact {
  state: string;
  applied_revision: number | null;
  lease_epoch: number | null;
  expires_at: Date | null;
}

/** 从探活响应里读事实。读不出 `state` 返回 null —— 由调用方标 degraded，绝不猜。 */
export function parseRemoteLeaseFact(body: unknown): RemoteLeaseFact | null {
  if (typeof body !== "object" || body === null) return null;
  const raw = body as Record<string, unknown>;
  // 兼容 `{lease:{...}}` 包装（路由今天返回扁平结构，包装是给未来留的读取口）。
  const obj = (typeof raw.lease === "object" && raw.lease !== null ? (raw.lease as Record<string, unknown>) : raw);
  if (typeof obj.state !== "string" || obj.state.length === 0) return null;
  const applied = obj.applied_revision;
  const epoch = obj.lease_epoch;
  const expires = obj.expires_at;
  return {
    state: obj.state,
    applied_revision: typeof applied === "number" && Number.isInteger(applied) ? applied : null,
    lease_epoch: typeof epoch === "number" && Number.isInteger(epoch) ? epoch : null,
    expires_at:
      typeof expires === "string" && !Number.isNaN(new Date(expires).getTime())
        ? new Date(expires)
        : expires instanceof Date
          ? expires
          : null,
  };
}

/**
 * 探活失败的错误码 → 镜像终态（能定终态的就不该停在 degraded）。
 * 其余码（网络类、5xx）由调用方标 `degraded`，保持"可解释的降级"而不是猜终态。
 */
export function terminalPlacementForProbeError(code: string): PlacementState | null {
  if (code === "lease_not_found" || code === "lease_expired") return "expired";
  if (code === "lease_revoked" || code === "peer_revoked") return "revoked";
  return null;
}

/* ================================================================== */
/* 出站接缝（默认走 client.callPeer）                                    */
/* ================================================================== */

export interface FederationPeerRef {
  peer_panel_id: string;
  endpoint_url: string;
}

export type IntentSendOutcome =
  | { ok: true; status: number; body: unknown; messageId: string }
  | { ok: false; code: FederationErrorCode; status: number; message: string; retryable: boolean; messageId: string };

export type FederationIntentSender = (input: {
  peer: FederationPeerRef;
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  retries?: number;
}) => Promise<IntentSendOutcome>;

/** 默认出站实现：唯一的 HTTP/签名/重试实现（别在别处再写一份）。 */
export const defaultIntentSender: FederationIntentSender = (input) => callPeer(input);

/* ================================================================== */
/* DB 接缝                                                             */
/* ================================================================== */

export interface PlacementDb {
  federationPlacement: {
    findUnique(args: unknown): Promise<unknown>;
    findFirst(args: unknown): Promise<unknown>;
    findMany(args: unknown): Promise<unknown>;
    create(args: unknown): Promise<unknown>;
    updateMany(args: unknown): Promise<unknown>;
  };
  federationPeer: {
    findUnique(args: unknown): Promise<unknown>;
    findMany(args: unknown): Promise<unknown>;
  };
}

export interface PlacementDeps {
  db?: PlacementDb;
  audit?: FederationAuditSink;
  sender?: FederationIntentSender;
  now?: () => Date;
}

interface ResolvedPlacementDeps {
  db: PlacementDb;
  audit: FederationAuditSink | null;
  sender: FederationIntentSender;
  now: () => Date;
}

const defaultPlacementDb = db as unknown as PlacementDb;

function resolvePlacementDeps(over?: PlacementDeps): ResolvedPlacementDeps {
  return {
    db: over?.db ?? defaultPlacementDb,
    audit: over?.audit ?? null,
    sender: over?.sender ?? defaultIntentSender,
    now: over?.now ?? (() => new Date()),
  };
}

/* ================================================================== */
/* 镜像写入                                                            */
/* ================================================================== */

export interface UpsertPlacementInput {
  peer_panel_id: string;
  forward_ref: string;
  intent_id: string;
  hop_role: string;
  desired_revision: number;
  tunnel_id?: number | null;
  lease_ref?: string | null;
  lease_epoch?: number | null;
  /**
   * 远端**已经确认**的 revision。写镜像时显式给出（例如重连对账前先从 `GET /leases/:ref`
   * 读回事实，或从一次成功回复里带回来）；不给则保持原值。
   * 注意这里不做单调保护——单调保护在 {@link recordPlacementResult} 里（那是"收到远端回答"的路径）；
   * 这里是"我明确知道这个事实"的路径。
   */
  applied_revision?: number | null;
  peer_node_ref?: string | null;
  peer_port?: number | null;
  expires_at?: Date | null;
  state?: PlacementState;
}

export type UpsertPlacementOutcome =
  | { ok: true; placement: FederationPlacementRow; created: boolean }
  | { ok: false; code: FederationErrorCode; message: string };

/**
 * 写一行镜像。唯一键 `(peer_panel_id, intent_id)` 是真相：先查后写会并发出两行，
 * 所以这里也是"撞唯一键就更新"的 upsert（与 `node_port_lease` 的 revive-or-create 同取向）。
 */
export async function upsertPlacement(
  input: UpsertPlacementInput,
  deps?: PlacementDeps,
): Promise<UpsertPlacementOutcome> {
  const d = resolvePlacementDeps(deps);
  if (!input.peer_panel_id || !input.intent_id || !input.forward_ref) {
    return { ok: false, code: "message_malformed", message: "peer_panel_id, forward_ref and intent_id are required" };
  }
  if (!Number.isInteger(input.desired_revision) || input.desired_revision < 0) {
    return { ok: false, code: "message_malformed", message: "desired_revision must be a non-negative integer" };
  }
  if (!(HOP_ROLES as readonly string[]).includes(input.hop_role)) {
    return { ok: false, code: "message_malformed", message: `unknown hop_role "${input.hop_role}"` };
  }

  const data = {
    forward_ref: input.forward_ref,
    hop_role: input.hop_role,
    desired_revision: input.desired_revision,
    ...(input.tunnel_id === undefined ? {} : { tunnel_id: input.tunnel_id }),
    ...(input.lease_ref === undefined ? {} : { lease_ref: input.lease_ref }),
    ...(input.lease_epoch === undefined || input.lease_epoch === null ? {} : { lease_epoch: input.lease_epoch }),
    ...(input.applied_revision === undefined ? {} : { applied_revision: input.applied_revision }),
    ...(input.peer_node_ref === undefined ? {} : { peer_node_ref: input.peer_node_ref }),
    ...(input.peer_port === undefined ? {} : { peer_port: input.peer_port }),
    ...(input.expires_at === undefined ? {} : { expires_at: input.expires_at }),
    ...(input.state === undefined ? {} : { state: input.state }),
  };

  const existing = (await d.db.federationPlacement.findUnique({
    where: { peer_panel_id_intent_id: { peer_panel_id: input.peer_panel_id, intent_id: input.intent_id } },
  })) as FederationPlacementRow | null;

  if (existing === null || existing === undefined) {
    try {
      const created = (await d.db.federationPlacement.create({
        data: {
          peer_panel_id: input.peer_panel_id,
          intent_id: input.intent_id,
          state: input.state ?? "pending",
          ...data,
        },
      })) as FederationPlacementRow;
      return { ok: true, placement: created, created: true };
    } catch (e) {
      return { ok: false, code: "internal_error", message: e instanceof Error ? e.message : String(e) };
    }
  }

  // 已终态的行不因一次迟到的重发被"复活"（§4.2：旧消息只记事实不改状态）。
  if (isTerminalPlacementState(existing.state) && (input.state === undefined || input.state === "pending")) {
    return { ok: true, placement: existing, created: false };
  }

  const updated = (await d.db.federationPlacement.updateMany({
    where: { id: existing.id },
    data,
  })) as { count: number };
  if (updated.count === 0) {
    return { ok: false, code: "internal_error", message: "placement update matched no row" };
  }
  return { ok: true, placement: { ...existing, ...data } as FederationPlacementRow, created: false };
}

/** 记录远端对一次 intent 的回复（成功/失败）。终态不回退。 */
export async function recordPlacementResult(
  input: {
    peer_panel_id: string;
    intent_id: string;
    ok: boolean;
    code?: FederationErrorCode | null;
    message?: string | null;
    lease_ref?: string | null;
    lease_epoch?: number | null;
    applied_revision?: number | null;
    remote_state?: string | null;
    peer_node_ref?: string | null;
    peer_port?: number | null;
    expires_at?: Date | null;
  },
  deps?: PlacementDeps,
): Promise<void> {
  const d = resolvePlacementDeps(deps);
  const existing = (await d.db.federationPlacement.findUnique({
    where: { peer_panel_id_intent_id: { peer_panel_id: input.peer_panel_id, intent_id: input.intent_id } },
  })) as FederationPlacementRow | null;
  if (existing === null || existing === undefined) return;
  if (isTerminalPlacementState(existing.state)) return;

  const data: Record<string, unknown> = {};
  if (input.lease_ref !== undefined) data.lease_ref = input.lease_ref;
  if (input.lease_epoch !== undefined && input.lease_epoch !== null) data.lease_epoch = input.lease_epoch;
  if (input.peer_node_ref !== undefined) data.peer_node_ref = input.peer_node_ref;
  if (input.peer_port !== undefined) data.peer_port = input.peer_port;
  if (input.expires_at !== undefined) data.expires_at = input.expires_at;

  if (input.ok) {
    const mapped = input.remote_state ? mapRemoteLeaseStateToPlacement(input.remote_state) : { state: "active" as PlacementState, note: "ok" };
    if (mapped === null) {
      data.state = "failed";
      data.last_error_code = "internal_error";
      data.last_error = `unknown remote lease state "${String(input.remote_state)}"`;
    } else {
      // applied_revision 只在**前进**时写：远端的旧回复不得把已确认的 revision 拉回去。
      if (input.applied_revision !== undefined && input.applied_revision !== null) {
        const currentApplied = existing.applied_revision ?? -1;
        if (input.applied_revision >= currentApplied) data.applied_revision = input.applied_revision;
      }
      data.state = mapped.state;
      data.last_error_code = null;
      data.last_error = null;
    }
  } else {
    // 不可达 = degraded（可解释），其余错误按原码记录；**都不触发本地回落**。
    data.state = input.code === "lease_revoked" || input.code === "peer_revoked" ? "revoked" : "degraded";
    data.last_error_code = input.code ?? "internal_error";
    data.last_error = input.message ?? null;
  }

  await d.db.federationPlacement.updateMany({ where: { id: existing.id }, data });
}

/* ================================================================== */
/* 对账（重连后按 (intent_id, revision) 重发未确认的 intent）              */
/* ================================================================== */

export interface PlacementReconcileResult {
  evaluated: number;
  /** 本地判定到期、直接收口成 `expired` 的条数（**不发任何请求**）。 */
  expired: number;
  /** 实际发出的探活次数（受 `MAX_PLACEMENT_PROBES_PER_TICK` 约束）。 */
  probed: number;
  /** 探活/重发后发现远端已收敛、且本行从非 active 回到 `active` 的条数（恢复）。 */
  recovered: number;
  /** 重发并拿到远端确认的条数。 */
  resent: number;
  /** 已确认到 desired_revision（探活确认）的条数。 */
  converged: number;
  /** 降级为 `degraded` 的条数（不可达/无法解释的远端回答）。 */
  degraded: number;
  /** 远端已撤销、镜像成 `revoked` 的条数。 */
  revoked: number;
  /** 重发失败（远端明确拒绝或错误）的条数。 */
  failed: number;
  /** 终态，跳过。 */
  skipped: number;
  /** 因为探活预算用尽而留到下一拍的行数（**保持原状**，不降级）。 */
  deferred: number;
}

/** 探活/重发共用的发送封装：只描述"发了什么"，不解释结果。 */
function resendPlacement(
  d: ResolvedPlacementDeps,
  peer: FederationPeerRef,
  row: FederationPlacementRow,
  deps: PlacementDeps | undefined,
): Promise<IntentSendOutcome> {
  void d;
  void deps;
  return Promise.resolve(
    (d.sender as FederationIntentSender)({
      peer,
      method: "POST",
      // 重连后重发的是**同一次申请**：同 intent、同 revision（幂等键两端一致）。
      path: "/api/federation/v1/leases",
      // 形状对齐 host 的 handler：`{ grant_ref?, intent: {...} }`。
      // **不传 grant_ref**：placement 行里没有这一列（重连后 home 也不该"记得"额度），
      // host 侧的解析顺序②（同 (peer,intent_id) 已有非终态 lease 的 grant）会把它找回来。
      body: {
        intent: {
          intent_id: row.intent_id,
          revision: row.desired_revision,
          hop_role: row.hop_role,
          forward_ref: row.forward_ref,
          requested: row.peer_node_ref === null ? {} : { node_ref: row.peer_node_ref },
        },
      },
      retries: 1,
    }),
  );
}

/** 从 host 的预留/探活响应里读出可回填的远端事实（缺字段就保持原值，不猜）。 */
function remoteFactsFromBody(body: unknown): {
  lease_ref: string | null;
  lease_epoch: number | null;
  applied_revision: number | null;
  peer_node_ref: string | null;
  peer_port: number | null;
  expires_at: Date | null;
} {
  const empty = {
    lease_ref: null,
    lease_epoch: null,
    applied_revision: null,
    peer_node_ref: null,
    peer_port: null,
    expires_at: null,
  };
  if (typeof body !== "object" || body === null) return empty;
  const raw = body as Record<string, unknown>;
  const obj = (typeof raw.lease === "object" && raw.lease !== null ? (raw.lease as Record<string, unknown>) : raw);
  const num = (v: unknown) => (typeof v === "number" && Number.isInteger(v) ? v : null);
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
  const expiresRaw = raw.expires_at ?? obj.expires_at;
  const expires =
    typeof expiresRaw === "string" && !Number.isNaN(new Date(expiresRaw).getTime()) ? new Date(expiresRaw) : null;
  return {
    lease_ref: str(raw.lease_ref) ?? str(obj.lease_ref),
    lease_epoch: num(raw.lease_epoch) ?? num(obj.lease_epoch),
    applied_revision: num(raw.applied_revision) ?? num(obj.applied_revision),
    peer_node_ref: typeof raw.node_ref === "string" ? raw.node_ref : typeof obj.node_ref === "string" ? obj.node_ref : null,
    peer_port: num(raw.port) ?? num(obj.port) ?? (typeof raw.port === "number" ? raw.port : null),
    expires_at: expires,
  };
}

/** 本地到期收口：**终态吸收**，不发任何请求（到期是两侧都知道的事实）。 */
async function markPlacementExpired(
  d: ResolvedPlacementDeps,
  row: FederationPlacementRow,
  now: Date,
): Promise<void> {
  await d.db.federationPlacement.updateMany({
    where: { id: row.id },
    data: {
      state: "expired",
      last_error_code: "lease_expired",
      last_error: `placement expired locally at ${now.toISOString()} (lease expires_at passed)`,
    },
  });
}

/** 降级：只改这一行，**绝不**碰任何本地 tunnel/runtime（不回落本地节点）。 */
async function markPlacementDegraded(
  d: ResolvedPlacementDeps,
  row: FederationPlacementRow,
  code: string,
  message: string | null,
): Promise<void> {
  await d.db.federationPlacement.updateMany({
    where: { id: row.id },
    data: { state: "degraded", last_error_code: code, last_error: message },
  });
}

/**
 * 重连对账 + **探活**。每拍做三件事，顺序固定：
 *
 *   1. **本地到期**：`expires_at <= now` → `expired`（不发请求；host 挂了也要能收口）；
 *   2. **探活**已收敛但有 lease_ref 的行（`GET /leases/:ref`，有界）：远端已终态 → 镜像；
 *      远端仍 live 且未落后 → 保持/回到 `active`（恢复）；远端落后 → 走重发；
 *      不可达/5xx/读不懂 → `degraded` + 可解释码，且同一 peer 本拍不再逐行重试；
 *   3. **重发**未确认的 intent（既有路径，`(intent_id, revision)` 幂等）。
 *
 * 每一步只改 `federation_placement` 这一行；**任何分支都不去动本地节点或本地 runtime** ——
 * "网络不可达就改用本地节点"是被契约 §7 明确禁止的隐式重放置。
 */
export async function reconcilePlacements(
  options: { now?: Date; limit?: number; peer_panel_id?: string | null; deps?: PlacementDeps } = {},
): Promise<PlacementReconcileResult> {
  const d = resolvePlacementDeps(options.deps);
  const now = options.now ?? d.now();
  const result: PlacementReconcileResult = {
    evaluated: 0,
    expired: 0,
    probed: 0,
    recovered: 0,
    resent: 0,
    converged: 0,
    degraded: 0,
    revoked: 0,
    failed: 0,
    skipped: 0,
    deferred: 0,
  };

  const rows = (await d.db.federationPlacement.findMany({
    where: {
      state: { in: ["pending", "active", "degraded", "failed"] },
      ...(options.peer_panel_id ? { peer_panel_id: options.peer_panel_id } : {}),
    },
    take: options.limit ?? 100,
  })) as FederationPlacementRow[];
  result.evaluated = rows.length;
  if (rows.length === 0) return result;

  const peerIds = [...new Set(rows.map((r) => r.peer_panel_id))];
  const peers = new Map<string, FederationPeerRef>();
  for (const id of peerIds) {
    const peer = (await d.db.federationPeer.findUnique({
      where: { peer_panel_id: id },
      select: { peer_panel_id: true, endpoint_url: true, status: true },
    })) as (FederationPeerRef & { status?: string }) | null;
    if (peer && peer.status !== "revoked" && typeof peer.endpoint_url === "string" && peer.endpoint_url.length > 0) {
      peers.set(peer.peer_panel_id, { peer_panel_id: peer.peer_panel_id, endpoint_url: peer.endpoint_url });
    }
  }

  let probeBudget = MAX_PLACEMENT_PROBES_PER_TICK;

  for (const [peerId, peer] of peers) {
    const mine = rows.filter((r) => r.peer_panel_id === peerId);
    let reachable = true;
    const plan = planPlacementSync(mine, { peerReachable: true, now, probeBudget });
    probeBudget -= plan.probes.length;

    // 1) 本地到期：不发请求
    for (const row of plan.expired) {
      await markPlacementExpired(d, row, now);
      result.expired++;
    }

    // 2) 探活
    for (const row of plan.probes) {
      if (!reachable) {
        await markPlacementDegraded(d, row, "peer_unreachable", "peer already judged unreachable in this tick");
        result.degraded++;
        continue;
      }
      result.probed++;
      const leaseRef = row.lease_ref ?? "";
      const probe = await d.sender({
        peer,
        method: "GET",
        path: `/api/federation/v1/leases/${encodeURIComponent(leaseRef)}`,
        retries: 0,
      });

      if (!probe.ok) {
        if (probe.code === "peer_unreachable") reachable = false;
        const terminal = terminalPlacementForProbeError(probe.code);
        if (terminal !== null) {
          await recordPlacementResult(
            { peer_panel_id: peerId, intent_id: row.intent_id, ok: true, remote_state: terminal === "expired" ? "expired" : "revoked" },
            options.deps,
          );
          if (terminal === "expired") result.expired++;
          else result.revoked++;
          continue;
        }
        if (probe.status >= 500 || probe.code === "internal_error") {
          await markPlacementDegraded(d, row, probe.code, probe.message);
          result.degraded++;
          continue;
        }
        await markPlacementDegraded(d, row, probe.code, probe.message);
        result.degraded++;
        continue;
      }

      const fact = parseRemoteLeaseFact(probe.body);
      if (fact === null) {
        await markPlacementDegraded(d, row, "internal_error", "probe response is unreadable (no lease state)");
        result.degraded++;
        continue;
      }
      const mapped = mapRemoteLeaseStateToPlacement(fact.state);
      if (mapped === null) {
        await markPlacementDegraded(d, row, "internal_error", `unknown remote lease state "${fact.state}"`);
        result.degraded++;
        continue;
      }
      if (mapped.state === "expired" || mapped.state === "revoked") {
        await recordPlacementResult(
          {
            peer_panel_id: peerId,
            intent_id: row.intent_id,
            ok: true,
            remote_state: fact.state,
            lease_epoch: fact.lease_epoch,
            expires_at: fact.expires_at,
          },
          options.deps,
        );
        if (mapped.state === "expired") result.expired++;
        else result.revoked++;
        continue;
      }
      if (fact.applied_revision !== null && fact.applied_revision >= row.desired_revision) {
        await recordPlacementResult(
          {
            peer_panel_id: peerId,
            intent_id: row.intent_id,
            ok: true,
            remote_state: fact.state,
            applied_revision: fact.applied_revision,
            lease_epoch: fact.lease_epoch,
            expires_at: fact.expires_at,
          },
          options.deps,
        );
        result.converged++;
        if (row.state !== "active") result.recovered++;
        continue;
      }

      // 远端还落后 → 走既有重发路径（不新写一条链路）。
      const sent = await resendPlacement(d, peer, row, options.deps);
      if (sent.ok) {
        result.resent++;
        const facts = remoteFactsFromBody(sent.body);
        await recordPlacementResult(
          {
            peer_panel_id: peerId,
            intent_id: row.intent_id,
            ok: true,
            applied_revision: facts.applied_revision ?? row.applied_revision,
            lease_ref: facts.lease_ref,
            lease_epoch: facts.lease_epoch,
            peer_node_ref: facts.peer_node_ref,
            peer_port: facts.peer_port,
            expires_at: facts.expires_at,
          },
          options.deps,
        );
        continue;
      }
      if (sent.code === "peer_unreachable") {
        reachable = false;
        result.degraded++;
        await markPlacementDegraded(d, row, sent.code, sent.message);
        continue;
      }
      result.failed++;
      await recordPlacementResult(
        { peer_panel_id: peerId, intent_id: row.intent_id, ok: false, code: sent.code, message: sent.message },
        options.deps,
      );
    }

    // 3) 重发未确认的 intent
    for (const row of plan.resends) {
      if (!reachable) {
        await markPlacementDegraded(d, row, "peer_unreachable", "peer is unreachable in this tick");
        result.degraded++;
        continue;
      }
      const sent = await resendPlacement(d, peer, row, options.deps);
      if (sent.ok) {
        result.resent++;
        const facts = remoteFactsFromBody(sent.body);
        await recordPlacementResult(
          {
            peer_panel_id: peerId,
            intent_id: row.intent_id,
            ok: true,
            applied_revision: facts.applied_revision ?? row.applied_revision,
            lease_ref: facts.lease_ref,
            lease_epoch: facts.lease_epoch,
            peer_node_ref: facts.peer_node_ref,
            peer_port: facts.peer_port,
            expires_at: facts.expires_at,
          },
          options.deps,
        );
        continue;
      }
      if (sent.code === "peer_unreachable") {
        reachable = false;
        result.degraded++;
        await markPlacementDegraded(d, row, sent.code, sent.message);
        continue;
      }
      result.failed++;
      await recordPlacementResult(
        { peer_panel_id: peerId, intent_id: row.intent_id, ok: false, code: sent.code, message: sent.message },
        options.deps,
      );
    }

    // 4) 预算用尽而没探到的行：保持原状，下一拍再说（**不**降级 —— 我们并不知道它坏了）。
    for (const row of plan.degraded) {
      await markPlacementDegraded(d, row, "peer_unreachable", "peer is not usable in this tick");
      result.degraded++;
    }
    result.converged += plan.converged.length;
    result.deferred += plan.converged.length;
    result.skipped += plan.skipped.length;
  }

  // 没有 peer 行（被删/被撤销）的镜像行：先按本地到期收口，其余标 degraded，同样不回落本地。
  for (const row of rows) {
    if (peers.has(row.peer_panel_id)) continue;
    const expiresAt = row.expires_at === null ? null : new Date(row.expires_at).getTime();
    if (!isTerminalPlacementState(row.state) && expiresAt !== null && Number.isFinite(expiresAt) && expiresAt <= now.getTime()) {
      await markPlacementExpired(d, row, now);
      result.expired++;
      continue;
    }
    if (isTerminalPlacementState(row.state)) {
      result.skipped++;
      continue;
    }
    await markPlacementDegraded(d, row, "peer_unreachable", "peer is not usable (missing or revoked)");
    result.degraded++;
  }

  return result;
}

/** hop 角色的合法值（供路由/对账共用，避免两处各写一遍）。 */
export function isFederationHopRole(value: string): value is HopRole {
  return (HOP_ROLES as readonly string[]).includes(value);
}
