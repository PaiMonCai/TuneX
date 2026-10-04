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
  /** 需要按 (intent_id, desired_revision) 重发的行。 */
  resends: FederationPlacementRow[];
  /** 远端已确认到 desired_revision 的行。 */
  converged: FederationPlacementRow[];
  /** peer 不可达 → 只能标 degraded，**不重发、不回落本地**。 */
  degraded: FederationPlacementRow[];
  /** 终态行，不参与对账。 */
  skipped: FederationPlacementRow[];
}

/**
 * 纯函数：给定镜像行与 peer 可达性，算出这一拍该做什么。
 *
 * `peerReachable = false` 时**一条都不重发**：往一个已经不可达的 peer 上打请求只会
 * 制造超时与噪声，而且掩盖真实状态（"重试中"与"已知不可达"是两件事）。
 */
export function planPlacementSync(
  placements: readonly FederationPlacementRow[],
  opts: { peerReachable: boolean },
): PlacementSyncPlan {
  const plan: PlacementSyncPlan = { resends: [], converged: [], degraded: [], skipped: [] };
  for (const row of placements) {
    if (isTerminalPlacementState(row.state)) {
      plan.skipped.push(row);
      continue;
    }
    if (!opts.peerReachable) {
      plan.degraded.push(row);
      continue;
    }
    if (row.applied_revision !== null && row.applied_revision >= row.desired_revision) {
      plan.converged.push(row);
      continue;
    }
    plan.resends.push(row);
  }
  return plan;
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
  /** 重发并拿到远端确认的条数。 */
  resent: number;
  /** 已确认到 desired_revision 的条数。 */
  converged: number;
  /** peer 不可达 → degraded(unreachable) 的条数（**没有**本地回落）。 */
  degraded: number;
  /** 重发失败（远端明确拒绝或错误）的条数。 */
  failed: number;
  /** 终态，跳过。 */
  skipped: number;
}

/**
 * 重连对账：把 `desired_revision` 尚未被远端确认的 placement 按 `(intent_id, revision)` 重发。
 *
 * 每拍只做**幂等**的重发：host 侧按 `(intent_id, revision)` 去重（`federation_intent` 唯一键），
 * 所以重复投递返回首次结果而不是再建一条腿 —— 这正是两条幂等机制互相咬合的地方。
 */
export async function reconcilePlacements(
  options: { now?: Date; limit?: number; peer_panel_id?: string | null; deps?: PlacementDeps } = {},
): Promise<PlacementReconcileResult> {
  const d = resolvePlacementDeps(options.deps);
  const result: PlacementReconcileResult = { evaluated: 0, resent: 0, converged: 0, degraded: 0, failed: 0, skipped: 0 };

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
  const peers: FederationPeerRef[] = [];
  for (const id of peerIds) {
    const peer = (await d.db.federationPeer.findUnique({
      where: { peer_panel_id: id },
      select: { peer_panel_id: true, endpoint_url: true, status: true },
    })) as (FederationPeerRef & { status?: string }) | null;
    if (peer && peer.status !== "revoked" && typeof peer.endpoint_url === "string" && peer.endpoint_url.length > 0) {
      peers.push({ peer_panel_id: peer.peer_panel_id, endpoint_url: peer.endpoint_url });
    }
  }

  for (const peer of peers) {
    const mine = rows.filter((r) => r.peer_panel_id === peer.peer_panel_id);
    let reachable = true;
    for (const row of mine) {
      if (isTerminalPlacementState(row.state)) {
        result.skipped++;
        continue;
      }
      if (row.applied_revision !== null && row.applied_revision >= row.desired_revision) {
        result.converged++;
        continue;
      }
      if (!reachable) {
        // 已知这个 peer 不可达：剩下的行不再逐个打请求，但**每一行都要留下可解释的事实**，
        // 否则"降级"只存在于这一拍的返回值里，库里看不到原因。
        result.degraded++;
        await recordPlacementResult(
          { peer_panel_id: peer.peer_panel_id, intent_id: row.intent_id, ok: false, code: "peer_unreachable", message: "peer is unreachable in this tick" },
          options.deps,
        );
        continue;
      }

      const sent = await d.sender({
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
      });

      if (sent.ok) {
        result.resent++;
        await recordPlacementResult(
          { peer_panel_id: peer.peer_panel_id, intent_id: row.intent_id, ok: true, applied_revision: row.applied_revision },
          options.deps,
        );
        continue;
      }

      if (sent.code === "peer_unreachable") {
        // 一个 peer 不可达 → 它剩下的行这一拍不再逐个重试（省掉一串必然的超时）。
        reachable = false;
        result.degraded++;
        await recordPlacementResult(
          { peer_panel_id: peer.peer_panel_id, intent_id: row.intent_id, ok: false, code: sent.code, message: sent.message },
          options.deps,
        );
        continue;
      }

      result.failed++;
      await recordPlacementResult(
        { peer_panel_id: peer.peer_panel_id, intent_id: row.intent_id, ok: false, code: sent.code, message: sent.message },
        options.deps,
      );
    }
  }

  // 没有 peer 行（被删/被撤销）的镜像行：标 degraded，同样不回落本地。
  for (const row of rows) {
    if (!peers.some((p) => p.peer_panel_id === row.peer_panel_id)) {
      result.degraded++;
      await recordPlacementResult(
        { peer_panel_id: row.peer_panel_id, intent_id: row.intent_id, ok: false, code: "peer_unreachable", message: "peer is not usable (missing or revoked)" },
        options.deps,
      );
    }
  }

  return result;
}

/** hop 角色的合法值（供路由/对账共用，避免两处各写一遍）。 */
export function isFederationHopRole(value: string): value is HopRole {
  return (HOP_ROLES as readonly string[]).includes(value);
}
