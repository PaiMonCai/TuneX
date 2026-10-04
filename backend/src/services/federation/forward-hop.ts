/**
 * V5.5 WP15 产品级接线 —— Forward 的远端 hop 委托（home 侧编排）。
 *
 * 契约：`docs/v5-wp14-16-federation-contract.md` §3.2 / §3.3 / §3.4 / §9；
 * `DEVELOPMENT.md` §1.4（状态真相链）/ §1.5（端口归属）/ §10。
 *
 * ── 这个文件解决什么问题 ──
 *
 * 在它之前，A 只能通过 M2M API 手工在 B 上租一条腿；**Forward 自己的 desired /
 * revision / rollout 完全不知道这件事**。这里把那一跳接进既有的真相链：
 *
 * ```text
 *   Forward desired（tunnel / forward_revision 的 federated_egress_peer 列）
 *         ↓
 *   本机 rollout 计划里的 egress 步（prepare_egress / cutover_egress）
 *         ↓
 *   本文件：host 侧 reserve → apply（出站唯一走 client.callPeer）
 *         ↓
 *   federation_placement（镜像/证据行）→ 本机入口的 next_hop
 *         ↓
 *   Agent ACK → applied_revision → reconcile
 * ```
 *
 * ── 五条不许违反的规则 ──
 *
 * 1. **不建第二份 desired**。这里的每个请求都由本机 Forward 的 revision 派生，
 *    `intent_id` 是确定性的 `fw-<tunnelId>-<revision>`（契约要求的幂等键）。
 *    远端只汇报"我应用了哪个 revision"，那**不是**它的 desired 真相（§3.4）。
 * 2. **next_hop 只信 host 返回的地址**。`node_address` + `port` 来自 host 自己的
 *    节点事实；本文件**任何地方都不拼 IP**。猜地址在这个项目里已经留下过一次
 *    "每个新连接都连不上"的静默故障（`forward-rollout-exec.ts` 的 `recordNextHop`
 *    注释是同一课）。
 * 3. **失败必须立刻补偿远端腿**。reserve 成功而 apply 失败、或调用方随后回滚，
 *    都必须发 `DELETE /leases/:ref` —— 远端 runtime 与端口的孤儿是 G4 的同族泄漏，
 *    而它比本地泄漏更难被发现（另一台面板上，没人看）。
 * 4. **peer 不可达不回落本地**。降级为 `degraded` + 可解释错误码，绝不改成本机出口。
 * 5. **不写远端资源到本机 ownership**。远端节点在 home 侧只有不透明引用
 *    （`federation_placement.peer_node_ref`），这里不建 node / node_port_lease 行。
 *
 * ── 第一阶段支持边界（§9，必须 fail-closed）──
 *
 *   · 只支持**一个远端 hop**，且只在 **egress** 上：远端 ingress / transit 一律
 *     `unsupported_topology`；
 *   · 只支持两跳路由（中间跳 = 三跳 ⇒ 拒绝）；
 *   · `tls` 协议拒绝：证书是**节点本地文件**，home 不可能知道 host 那台节点上的路径，
 *     而 §3.2 的 apply 形状里没有承载它的字段 —— 猜一个路径等于下发一条永远起不来的
 *     监听（同"不猜地址"的理由）。
 */

import { db } from "../../db.ts";
import { callPeer } from "./client.ts";
import type { FederationErrorCode } from "./errors.ts";
import { isRetryableFederationError } from "./errors.ts";
import { isFederationEnabled } from "./identity.ts";
import {
  recordPlacementResult,
  upsertPlacement,
  type FederationPeerRef,
  type PlacementState,
} from "./placement.ts";

/* ================================================================== */
/* 常量与确定性键                                                       */
/* ================================================================== */

/** 第一阶段唯一支持的远端 hop 角色（契约 §9：远端 ingress / transit 继续关闭）。 */
export const FEDERATED_EGRESS_HOP_ROLE = "egress" as const;

/**
 * 远端腿拒绝的协议：`tls` 需要**节点本地**的证书路径，而 apply 形状里没有它。
 * 其余（tcp / ws）不需要任何节点本地文件，可以原样交给 host。
 */
export const FEDERATED_EGRESS_UNSUPPORTED_PROTOCOLS: readonly string[] = ["tls"];

/**
 * 确定性 intent id：`fw-<tunnelId>-<revision>`。
 *
 * 为什么必须确定性而不是随机：rollout 重试、进程重启后的续跑、断线重连对账都要用
 * **同一个键**去重（host 侧 `federation_intent` 有唯一索引）。换一个 id 就把"重试"
 * 变成了"新申请"，结果是第二份租约与第二个端口 —— 这正是幂等要防的事（契约 §3.2）。
 */
export function federatedEgressIntentId(tunnelId: number, revision: number): string {
  return `fw-${tunnelId}-${revision}`;
}

/**
 * 本机 Forward 的 `forward_ref`：跨面板只传这个不透明引用，用来归因用量与审计。
 * 它**不是** host 的资源标识（host 的权威标识是 `lease_ref`，只由 host 决定）。
 */
export function federatedEgressForwardRef(tunnelId: number): string {
  return `fw-${tunnelId}`;
}

/** 从 desired / applied 快照里读声明；空串 / 非字符串一律按"未声明"处理（= 今天的行为）。 */
export function federatedEgressPeerOf(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const raw = (snapshot as { federated_egress_peer?: unknown }).federated_egress_peer;
  if (typeof raw !== "string") return null;
  const peer = raw.trim();
  return peer.length === 0 ? null : peer;
}

/* ================================================================== */
/* 出站接缝（默认走 client.callPeer —— 签名/超时/重试的唯一实现）          */
/* ================================================================== */

export type ForwardHopSendOutcome =
  | { ok: true; status: number; body: unknown; messageId: string }
  | {
      ok: false;
      code: FederationErrorCode;
      status: number;
      message: string;
      retryable: boolean;
      messageId: string;
    };

export type ForwardHopSender = (input: {
  peer: FederationPeerRef;
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  /** 额外重试次数（默认 2）。跨面板写接口是幂等的，所以重试是安全的。 */
  retries?: number;
}) => Promise<ForwardHopSendOutcome>;

/** 默认出站实现：**唯一**的签名/超时/错误分类实现，不在这里再写一份。 */
export const defaultForwardHopSender: ForwardHopSender = (input) => callPeer(input);

/* ================================================================== */
/* DB 接缝（测试替身只需要这几个方法）                                    */
/* ================================================================== */

export interface ForwardHopDb {
  federationPeer: {
    findUnique(args: unknown): Promise<unknown>;
    findMany?(args: unknown): Promise<unknown>;
  };
  federationPlacement: {
    findUnique(args: unknown): Promise<unknown>;
    findFirst?(args: unknown): Promise<unknown>;
    findMany(args: unknown): Promise<unknown>;
    create?(args: unknown): Promise<unknown>;
    updateMany(args: unknown): Promise<unknown>;
  };
  tunnel?: {
    findUnique(args: unknown): Promise<unknown>;
  };
  egressPool?: {
    findUnique(args: unknown): Promise<unknown>;
  };
}

export interface ForwardHopDeps {
  db?: ForwardHopDb;
  sender?: ForwardHopSender;
  /** 联邦开关检查的注入点（测试里不想要一次 setting 读取时给 `() => true`）。 */
  federationEnabled?: () => Promise<boolean>;
  now?: () => Date;
}

interface ResolvedForwardHopDeps {
  db: ForwardHopDb;
  sender: ForwardHopSender;
  federationEnabled: () => Promise<boolean>;
  now: () => Date;
}

const defaultForwardHopDb = db as unknown as ForwardHopDb;

function resolveDeps(over?: ForwardHopDeps): ResolvedForwardHopDeps {
  return {
    db: over?.db ?? defaultForwardHopDb,
    sender: over?.sender ?? defaultForwardHopSender,
    federationEnabled: over?.federationEnabled ?? isFederationEnabled,
    now: over?.now ?? (() => new Date()),
  };
}

/* ================================================================== */
/* 纯判定：拓扑与请求形状                                                */
/* ================================================================== */

export interface FederatedEgressTopology {
  tunnelId: number;
  revision: number;
  /** `desired` 快照的 mode。 */
  mode: string;
  ingress_node_id: number | null;
  /** 本机出口节点；声明了 peer 时**必须**为 null（本机不再承载那一跳）。 */
  local_egress_node_id: number | null;
  middle_node_id?: number | null;
  /** 该 Forward 的协议（`forward_protocol`）。 */
  protocol?: string | null;
}

export type FederatedEgressCheck = { ok: true; peer_panel_id: string } | { ok: false; code: FederationErrorCode; message: string };

/**
 * 纯函数：这次委托在不在第一阶段的开放范围内（§9）。
 *
 * 放在**任何副作用之前**调用：不支持的形状必须在还没碰到远端之前就被拒掉，
 * 否则我们会先在 B 上建一条腿再发现"其实不该建"。
 */
export function checkFederatedEgressTopology(
  topology: FederatedEgressTopology,
  declaredPeer: string | null,
): FederatedEgressCheck {
  const peer = declaredPeer?.trim() ?? "";
  if (peer.length === 0) {
    return { ok: false, code: "message_malformed", message: "未声明 federated_egress_peer" };
  }
  if (peer.length > 64) {
    return { ok: false, code: "message_malformed", message: `federated_egress_peer 超长（${peer.length} > 64）` };
  }
  if (topology.mode !== "relay") {
    return {
      ok: false,
      code: "unsupported_topology",
      message: `只有 RELAY 转发才有独立的出口跳；当前 mode=${topology.mode}`,
    };
  }
  if (topology.ingress_node_id == null || topology.ingress_node_id <= 0) {
    return {
      ok: false,
      code: "unsupported_topology",
      message: "远端出口要求本机仍有入口跳（第一阶段只允许一个远端 hop，且必须在 egress 上）",
    };
  }
  if (topology.middle_node_id != null) {
    return {
      ok: false,
      code: "unsupported_topology",
      message: "远端出口 + 中间跳 = 跨面板 3+ 跳，第一阶段明确关闭（契约 §9）",
    };
  }
  if (topology.local_egress_node_id != null) {
    return {
      ok: false,
      code: "unsupported_topology",
      message: `同时声明了本机出口节点 ${topology.local_egress_node_id} 与远端 peer ${peer}：出口腿只能在一侧（契约 §1 ownership）`,
    };
  }
  const protocol = (topology.protocol ?? "").trim();
  if (protocol.length > 0 && FEDERATED_EGRESS_UNSUPPORTED_PROTOCOLS.includes(protocol)) {
    return {
      ok: false,
      code: "unsupported_topology",
      message: `协议 ${protocol} 需要节点本地的证书文件路径，apply 形状无法把它交给 host（第一阶段远端出口只支持 tcp / ws）`,
    };
  }
  return { ok: true, peer_panel_id: peer };
}

/**
 * 计划期的远端腿**占位** node id（`rollout` 的计划里会出现它）。
 *
 * 为什么需要一个占位：既有的 rollout 计划器（`forward-rollout.ts`，本轮不改）把
 * "RELAY 必须有出口节点事实"作为准入条件（`validateRolloutAdmission`）与路由模型的
 * 前提（`buildRoutePlan` 要求 egress_node_id > 0）。声明了远端 peer 时本机确实**没有**
 * 出口节点，若让这个事实直接传进去，计划会在 VALIDATE 阶段被拒 —— 症状是"保存成功、
 * 什么都不发生"，比报错更难发现。
 *
 * 因此这里给计划一个**显式的占位**：
 *   · 它只存在于计划/账本里，**永不**发给任何 orchestrator（联邦分支第一件事就是
 *     不看这个 id 而走 `callPeer`）；
 *   · 取一个不可能与真实自增 id 相撞的值（1e9 以上），且节点事实的 `node_id` 写成
 *     `federated:<peer>`，排障时一眼能看出它不是节点；
 *   · 本机端口/绑定/租约的分配与释放都在联邦分支里跳过，所以它不会产生任何本机资源。
 */
export const FEDERATED_EGRESS_PLAN_NODE_ID = 2_000_000_001;

/** 从一份快照（desired / applied）读出拓扑判定所需的字段。 */
export function checkFederatedEgressForSnapshot(input: {
  tunnelId: number;
  revision: number;
  snapshot: unknown;
  protocol?: string | null;
}): FederatedEgressCheck {
  const snap = (input.snapshot ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | null => (v == null ? null : Number(v));
  return checkFederatedEgressTopology(
    {
      tunnelId: input.tunnelId,
      revision: input.revision,
      mode: typeof snap.mode === "string" ? snap.mode : "",
      ingress_node_id: num(snap.ingress_node_id),
      local_egress_node_id: num(snap.egress_node_id),
      middle_node_id: num(snap.middle_node_id),
      protocol: input.protocol ?? null,
    },
    federatedEgressPeerOf(snap),
  );
}

/** 声明了 peer 时，本机出口端口/节点越界都在这里被拦下（不该存在）。 */
export function federatedEgressTargetsOf(
  targets: readonly { host: string; port: number; weight?: number; order_by?: number }[] | null | undefined,
): Array<{ host: string; port: number; weight?: number; order_by?: number }> {
  return (targets ?? []).map((t) => ({
    host: t.host,
    port: t.port,
    ...(t.weight === undefined ? {} : { weight: t.weight }),
    ...(t.order_by === undefined ? {} : { order_by: t.order_by }),
  }));
}

/* ================================================================== */
/* peer 解析                                                           */
/* ================================================================== */

interface PeerRow {
  peer_panel_id: string;
  endpoint_url: string;
  status: string;
}

/**
 * 解析声明的 peer：必须存在、**trusted**、且有可用 endpoint。
 *
 * 三种失败各有各的码（契约 §6）：撤销过的是 `peer_revoked`（重试无用），
 * 未知/未完成握手的是 `peer_unknown`，`pending`/`suspended` 也按 `peer_unknown`
 * 处理（同一件事：现在不能用），endpoint 缺失是配置问题而不是网络问题。
 */
async function resolvePeer(
  peerPanelId: string,
  d: ResolvedForwardHopDeps,
): Promise<{ ok: true; peer: FederationPeerRef } | { ok: false; code: FederationErrorCode; message: string }> {
  const row = (await d.db.federationPeer.findUnique({
    where: { peer_panel_id: peerPanelId },
    select: { peer_panel_id: true, endpoint_url: true, status: true },
  })) as PeerRow | null;
  if (!row) {
    return { ok: false, code: "peer_unknown", message: `本机没有 peer ${peerPanelId} 的信任记录` };
  }
  if (row.status === "revoked") {
    return { ok: false, code: "peer_revoked", message: `peer ${peerPanelId} 的信任已被撤销` };
  }
  if (row.status !== "trusted") {
    return { ok: false, code: "peer_unknown", message: `peer ${peerPanelId} 当前状态为 ${row.status}，尚不可用` };
  }
  if (typeof row.endpoint_url !== "string" || row.endpoint_url.trim().length === 0) {
    return { ok: false, code: "internal_error", message: `peer ${peerPanelId} 没有可用的 endpoint_url` };
  }
  return { ok: true, peer: { peer_panel_id: row.peer_panel_id, endpoint_url: row.endpoint_url } };
}

/* ================================================================== */
/* 远端腿的委托（reserve → apply → 镜像）                                */
/* ================================================================== */

export interface DelegateFederatedEgressRequest {
  tunnelId: number;
  revision: number;
  declaredPeer: string;
  mode: string;
  ingress_node_id: number | null;
  local_egress_node_id: number | null;
  middle_node_id?: number | null;
  protocol?: string | null;
  /** host 侧要拨号的目标池（来自本机该 revision 的 egress targets 快照）。 */
  targets: readonly { host: string; port: number; weight?: number; order_by?: number }[];
  /** 本机出口池的负载均衡策略（原样转述给 host，host 不解释其业务含义）。 */
  lb_strategy?: string | null;
}

export interface FederatedEgressSuccess {
  ok: true;
  peer_panel_id: string;
  intent_id: string;
  lease_ref: string;
  lease_epoch: number;
  applied_revision: number;
  /** host 侧节点的不透明引用（**不得**据此建本地 node 行）。 */
  node_ref: string | null;
  /** host 返回的节点地址；`next_hop` 的可信来源。 */
  node_address: string | null;
  port: number | null;
  /**
   * 本机入口腿的 next_hop。
   * `null` = host 没能给出可寻址地址 ⇒ 调用方**必须** fail-closed（不许猜）。
   */
  next_hop: string | null;
  expires_at: string | null;
  replayed: boolean;
  placement_state: PlacementState;
}

export interface FederatedEgressFailure {
  ok: false;
  code: FederationErrorCode;
  message: string;
  retryable: boolean;
  peer_panel_id: string;
  intent_id: string;
  lease_ref: string | null;
  /** 远端腿是否已确认释放。false + lease_ref != null ⇒ 有残留风险，必须落账并重试。 */
  compensated: boolean;
  compensation_error?: string;
}

export type FederatedEgressOutcome = FederatedEgressSuccess | FederatedEgressFailure;

/** reserve 响应里我们真正依赖的字段（形状不符 ⇒ 结构化失败，不往下走）。 */
interface ReserveResponse {
  lease_ref: string;
  lease_epoch: number;
  state: string | null;
  node_ref: string | null;
  node_address: string | null;
  port: number | null;
  expires_at: string | null;
  applied_revision: number | null;
  replayed: boolean;
}

function parseReserveResponse(body: unknown): { ok: true; value: ReserveResponse } | { ok: false; message: string } {
  if (!body || typeof body !== "object") return { ok: false, message: "reserve 响应不是对象" };
  const rec = body as Record<string, unknown>;
  if (typeof rec.lease_ref !== "string" || rec.lease_ref.length === 0) {
    return { ok: false, message: "reserve 响应缺 lease_ref" };
  }
  const epoch = Number(rec.lease_epoch);
  if (!Number.isInteger(epoch) || epoch < 0) return { ok: false, message: "reserve 响应的 lease_epoch 不合法" };
  const port = rec.port == null ? null : Number(rec.port);
  if (port !== null && (!Number.isInteger(port) || port <= 0 || port > 65535)) {
    return { ok: false, message: "reserve 响应的 port 不合法" };
  }
  return {
    ok: true,
    value: {
      lease_ref: rec.lease_ref,
      lease_epoch: epoch,
      state: typeof rec.state === "string" ? rec.state : null,
      node_ref: typeof rec.node_ref === "string" ? rec.node_ref : null,
      node_address: typeof rec.node_address === "string" && rec.node_address.trim().length > 0
        ? rec.node_address.trim()
        : null,
      port,
      expires_at: typeof rec.expires_at === "string" ? rec.expires_at : null,
      applied_revision: rec.applied_revision == null ? null : Number(rec.applied_revision),
      replayed: rec.replayed === true,
    },
  };
}

function parseApplyResponse(
  body: unknown,
): { ok: true; applied_revision: number; lease_epoch: number | null; node_ref: string | null; port: number | null } | { ok: false; message: string } {
  if (!body || typeof body !== "object") return { ok: false, message: "apply 响应不是对象" };
  const rec = body as Record<string, unknown>;
  const applied = Number(rec.applied_revision);
  if (!Number.isInteger(applied) || applied < 0) return { ok: false, message: "apply 响应缺 applied_revision" };
  return {
    ok: true,
    applied_revision: applied,
    lease_epoch: rec.lease_epoch == null ? null : Number(rec.lease_epoch),
    node_ref: typeof rec.node_ref === "string" ? rec.node_ref : null,
    port: rec.port == null ? null : Number(rec.port),
  };
}

function nextHopOf(address: string | null, port: number | null): string | null {
  if (address == null || address.length === 0) return null;
  if (port == null || port <= 0) return null;
  // IPv6 加方括号，与 forward-revision.targetAddress 同口径。
  const host = address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
  return `${host}:${port}`;
}

function failure(
  code: FederationErrorCode,
  message: string,
  ctx: { peer: string; intentId: string; leaseRef: string | null; compensated: boolean; compensationError?: string },
): FederatedEgressFailure {
  return {
    ok: false,
    code,
    message,
    retryable: isRetryableFederationError(code),
    peer_panel_id: ctx.peer,
    intent_id: ctx.intentId,
    lease_ref: ctx.leaseRef,
    compensated: ctx.compensated,
    ...(ctx.compensationError === undefined ? {} : { compensation_error: ctx.compensationError }),
  };
}

/**
 * 把一条出口腿委托给 peer：**预留 → 应用 → 落镜像**（契约 §3.2 两阶段）。
 *
 * 时序刻意如此：
 *   1. 先写镜像行（`pending`）——崩溃在"远端已建、镜像没写"的窗口里会留下**无人知道**
 *      的远端租约，那是最难发现的泄漏；先记账则最坏只是重发一次幂等 intent；
 *   2. reserve → apply；
 *   3. 任何一步失败都先释放远端腿，再如实返回结构化错误。
 */
export async function delegateFederatedEgress(
  request: DelegateFederatedEgressRequest,
  deps?: ForwardHopDeps,
): Promise<FederatedEgressOutcome> {
  const d = resolveDeps(deps);
  const intentId = federatedEgressIntentId(request.tunnelId, request.revision);
  const forwardRef = federatedEgressForwardRef(request.tunnelId);
  const peerPanelId = request.declaredPeer;

  const topology = checkFederatedEgressTopology(
    {
      tunnelId: request.tunnelId,
      revision: request.revision,
      mode: request.mode,
      ingress_node_id: request.ingress_node_id,
      local_egress_node_id: request.local_egress_node_id,
      middle_node_id: request.middle_node_id ?? null,
      protocol: request.protocol ?? null,
    },
    peerPanelId,
  );
  if (!topology.ok) {
    return failure(topology.code, topology.message, { peer: peerPanelId, intentId, leaseRef: null, compensated: true });
  }

  if (!(await d.federationEnabled())) {
    return failure("federation_disabled", "本机联邦功能未开启", {
      peer: peerPanelId,
      intentId,
      leaseRef: null,
      compensated: true,
    });
  }

  const resolved = await resolvePeer(peerPanelId, d);
  if (!resolved.ok) {
    // 连 peer 都没解析出来 ⇒ 没有任何远端副作用；但**仍然留下可解释的镜像行**，
    // 否则"这条 Forward 声明了远端出口却没接上"在库里看不到（§4.3 的教训：
    // 决策不留痕的机制与从未运行过的机制无法区分）。
    await mirrorFailure(d, { peer: peerPanelId, forwardRef, intentId, tunnelId: request.tunnelId, revision: request.revision, code: resolved.code, message: resolved.message });
    return failure(resolved.code, resolved.message, { peer: peerPanelId, intentId, leaseRef: null, compensated: true });
  }
  const peer = resolved.peer;

  const mirrored = await upsertPlacement(
    {
      peer_panel_id: peer.peer_panel_id,
      forward_ref: forwardRef,
      intent_id: intentId,
      hop_role: FEDERATED_EGRESS_HOP_ROLE,
      desired_revision: request.revision,
      tunnel_id: request.tunnelId,
      // 先落 pending：它的用途是"这次申请存在"，而不是"远端已经建好了"。
      state: "pending",
    },
    { db: d.db as never, sender: d.sender as never, now: d.now },
  );
  if (!mirrored.ok) {
    return failure("internal_error", `无法写入联邦放置镜像：${mirrored.message}`, {
      peer: peerPanelId,
      intentId,
      leaseRef: null,
      compensated: true,
    });
  }

  /* ---------------- 阶段 1：host 侧预留 ---------------- */
  const reserved = await d.sender({
    peer,
    method: "POST",
    path: "/api/federation/v1/leases",
    // host 的路由要求 `intent` 是一个对象（`routes/federation.ts#POST /leases`）。
    // `requested` 只带 lb：节点与端口由 host 在自己的 grant 范围内决定，home 不参与。
    body: {
      intent: {
        intent_id: intentId,
        revision: request.revision,
        hop_role: FEDERATED_EGRESS_HOP_ROLE,
        forward_ref: forwardRef,
        requested: request.lb_strategy ? { lb: request.lb_strategy } : undefined,
      },
    },
    retries: 1,
  });
  if (!reserved.ok) {
    await mirrorFailure(d, {
      peer: peer.peer_panel_id,
      forwardRef,
      intentId,
      tunnelId: request.tunnelId,
      revision: request.revision,
      code: reserved.code,
      message: reserved.message,
    });
    return failure(reserved.code, reserved.message, { peer: peer.peer_panel_id, intentId, leaseRef: null, compensated: true });
  }
  const parsed = parseReserveResponse(reserved.body);
  if (!parsed.ok) {
    // 响应形状不认识 ⇒ 远端可能已经建了腿。**不猜**，标记 degraded 让对账重发同一 intent
    // （同键重投递在 host 侧返回首次结果，不会产生第二条腿）。
    await mirrorFailure(d, {
      peer: peer.peer_panel_id,
      forwardRef,
      intentId,
      tunnelId: request.tunnelId,
      revision: request.revision,
      code: "message_malformed",
      message: `reserve 响应无法解析：${parsed.message}`,
    });
    return failure("message_malformed", `reserve 响应无法解析：${parsed.message}`, {
      peer: peer.peer_panel_id,
      intentId,
      leaseRef: null,
      compensated: false,
    });
  }
  const lease = parsed.value;

  await recordPlacementResult(
    {
      peer_panel_id: peer.peer_panel_id,
      intent_id: intentId,
      ok: true,
      lease_ref: lease.lease_ref,
      lease_epoch: lease.lease_epoch,
      peer_node_ref: lease.node_ref,
      peer_port: lease.port,
      expires_at: lease.expires_at ? new Date(lease.expires_at) : null,
      remote_state: lease.state ?? "reserved",
      applied_revision: lease.applied_revision,
    },
    { db: d.db as never, sender: d.sender as never, now: d.now },
  );

  /* ---------------- 阶段 2：host 侧应用 ---------------- */
  // 远端已把本 revision 应用过（重放/重试）⇒ 不再重复下发，但仍要把 next_hop 交给调用方。
  const alreadyApplied = lease.applied_revision !== null && lease.applied_revision >= request.revision && lease.state === "active";

  let appliedRevision = request.revision;
  let nodeAddress = lease.node_address;
  let port = lease.port;

  if (!alreadyApplied) {
    const applied = await d.sender({
      peer,
      method: "POST",
      path: `/api/federation/v1/leases/${encodeURIComponent(lease.lease_ref)}/apply`,
      body: {
        intent_id: intentId,
        revision: request.revision,
        targets: federatedEgressTargetsOf(request.targets),
        lb_strategy: request.lb_strategy ?? null,
        protocol: request.protocol ?? null,
      },
      retries: 1,
    });

    if (!applied.ok) {
      const compensation = await releaseRemoteLease(d, peer, lease.lease_ref, intentId, request.revision);
      await mirrorFailure(d, {
        peer: peer.peer_panel_id,
        forwardRef,
        intentId,
        tunnelId: request.tunnelId,
        revision: request.revision,
        code: applied.code,
        message: applied.message,
        leaseRef: lease.lease_ref,
      });
      return failure(applied.code, applied.message, {
        peer: peer.peer_panel_id,
        intentId,
        leaseRef: lease.lease_ref,
        compensated: compensation.ok,
        compensationError: compensation.ok ? undefined : compensation.message,
      });
    }

    const applyParsed = parseApplyResponse(applied.body);
    if (!applyParsed.ok) {
      // apply 的**响应**坏了，但命令很可能已经生效。按 §4.2「结果未知不当作失败」处理：
      // 保留租约与镜像（degraded），让对账按同一 (intent_id, revision) 重发；
      // 释放它才是错的 —— 那会把一条可能正在服务的链路拆掉。
      await mirrorFailure(d, {
        peer: peer.peer_panel_id,
        forwardRef,
        intentId,
        tunnelId: request.tunnelId,
        revision: request.revision,
        code: "message_malformed",
        message: `apply 响应无法解析：${applyParsed.message}`,
        leaseRef: lease.lease_ref,
      });
      return failure("message_malformed", `apply 响应无法解析：${applyParsed.message}`, {
        peer: peer.peer_panel_id,
        intentId,
        leaseRef: lease.lease_ref,
        compensated: false,
      });
    }
    appliedRevision = applyParsed.applied_revision;
    nodeAddress = nodeAddress ?? null;
    port = applyParsed.port ?? port;
  }

  await recordPlacementResult(
    {
      peer_panel_id: peer.peer_panel_id,
      intent_id: intentId,
      ok: true,
      lease_ref: lease.lease_ref,
      lease_epoch: lease.lease_epoch,
      remote_state: "active",
      applied_revision: appliedRevision,
      peer_node_ref: lease.node_ref,
      peer_port: port,
      expires_at: lease.expires_at ? new Date(lease.expires_at) : null,
    },
    { db: d.db as never, sender: d.sender as never, now: d.now },
  );

  return {
    ok: true,
    peer_panel_id: peer.peer_panel_id,
    intent_id: intentId,
    lease_ref: lease.lease_ref,
    lease_epoch: lease.lease_epoch,
    applied_revision: appliedRevision,
    node_ref: lease.node_ref,
    node_address: nodeAddress,
    port,
    // host 没给出可寻址地址 ⇒ null，调用方必须 fail-closed（不许猜 IP）。
    next_hop: nextHopOf(nodeAddress, port),
    expires_at: lease.expires_at,
    replayed: lease.replayed,
    placement_state: "active",
  };
}

/** 把一次失败如实写进镜像行（state=degraded/revoked + 可解释错误码）。 */
async function mirrorFailure(
  d: ResolvedForwardHopDeps,
  input: {
    peer: string;
    forwardRef: string;
    intentId: string;
    tunnelId: number;
    revision: number;
    code: FederationErrorCode;
    message: string;
    leaseRef?: string | null;
  },
): Promise<void> {
  await upsertPlacement(
    {
      peer_panel_id: input.peer,
      forward_ref: input.forwardRef,
      intent_id: input.intentId,
      hop_role: FEDERATED_EGRESS_HOP_ROLE,
      desired_revision: input.revision,
      tunnel_id: input.tunnelId,
      ...(input.leaseRef === undefined ? {} : { lease_ref: input.leaseRef }),
      state: "pending",
    },
    { db: d.db as never, sender: d.sender as never, now: d.now },
  ).catch(() => undefined);
  await recordPlacementResult(
    {
      peer_panel_id: input.peer,
      intent_id: input.intentId,
      ok: false,
      code: input.code,
      message: input.message,
    },
    { db: d.db as never, sender: d.sender as never, now: d.now },
  ).catch(() => undefined);
}

/* ================================================================== */
/* 声明的校验（创建/编辑入口用它给出可行动的错误）                          */
/* ================================================================== */

/**
 * 校验一条"我想把出口腿放到 peer X"的声明能不能成立。
 *
 * 这是**唯一**的声明校验实现：路由层与 service 层都调它，所以"能保存但跑不起来"
 * 或"预览放行、保存拒绝"这两种漂移不可能出现。返回的错误码是契约 §6 的闭集，
 * 调用方按它给用户下一步动作（而不是压成 500）。
 */
export async function validateFederatedEgressDeclaration(
  peerPanelId: string | null | undefined,
  deps?: ForwardHopDeps,
): Promise<{ ok: true; peer_panel_id: string | null } | { ok: false; code: FederationErrorCode; message: string }> {
  const peer = federatedEgressPeerOf({ federated_egress_peer: peerPanelId });
  if (peer === null) return { ok: true, peer_panel_id: null };
  if (peer.length > 64) {
    return { ok: false, code: "message_malformed", message: `peer_panel_id 超长（${peer.length} > 64）` };
  }
  const d = resolveDeps(deps);
  if (!(await d.federationEnabled())) {
    return { ok: false, code: "federation_disabled", message: "本机联邦功能未开启，无法把出口腿放到其它面板" };
  }
  const resolved = await resolvePeer(peer, d);
  if (!resolved.ok) return resolved;
  return { ok: true, peer_panel_id: peer };
}

/* ================================================================== */
/* 释放（补偿 / 移除声明 / 删除 Forward）                                */
/* ================================================================== */

export interface ReleaseFederatedEgressResult {
  ok: boolean;
  /** 远端腿是否被确认释放（或本来就没有）。 */
  released: boolean;
  code?: FederationErrorCode;
  message?: string;
}

/**
 * 释放一条**已知租约**的远端腿。
 *
 * `DELETE /leases/:ref` 在 host 侧是幂等的：重复释放返回首次结果，已经是终态的行
 * 直接成功。`lease_not_found` 也按"已经没了"处理 —— 对调用方而言两种都一样：
 * 这条腿现在不在服务，且没有端口被它占着。
 *
 * 注意 `callPeer` 对 DELETE **不发 body**（签名是对空 body 算的），而 host 的路由在
 * 没有 body 时用**租约自己的** intent_id/revision 落幂等键 —— 那条租约本来就是这次
 * intent 建的，所以幂等语义不变。
 */
async function releaseRemoteLease(
  d: ResolvedForwardHopDeps,
  peer: FederationPeerRef,
  leaseRef: string,
  intentId: string,
  revision: number,
): Promise<ReleaseFederatedEgressResult> {
  const res = await d.sender({
    peer,
    method: "DELETE",
    path: `/api/federation/v1/leases/${encodeURIComponent(leaseRef)}`,
    retries: 1,
  });
  if (res.ok) return { ok: true, released: true };
  if (res.code === "lease_not_found") return { ok: true, released: true };
  return { ok: false, released: false, code: res.code, message: res.message };
}

export interface ReleaseFederatedEgressRequest {
  tunnelId: number;
  /** 要释放的那一代 revision（= 建这条远端腿时的 revision，决定 intent_id）。 */
  revision: number;
  /** 未给出时按 tunnel_id + intent_id 去镜像行里找。 */
  peer_panel_id?: string | null;
  lease_ref?: string | null;
}

/**
 * 按 (tunnel, revision) 释放远端出口腿，并把镜像行落到 `expired`。
 *
 * 这是"移除声明 / 改成单跳本地出口 / 删除该 Forward / 补偿"共用的**唯一**释放入口，
 * 因为它的幂等键与建立时完全一致（`fw-<tunnelId>-<revision>`）——释放必须是同一个键，
 * 否则会释错人（另一代 revision 的租约）。
 */
export async function releaseFederatedEgress(
  request: ReleaseFederatedEgressRequest,
  deps?: ForwardHopDeps,
): Promise<ReleaseFederatedEgressResult> {
  const d = resolveDeps(deps);
  const intentId = federatedEgressIntentId(request.tunnelId, request.revision);

  // 先找镜像行：它同时给出 peer 与 lease_ref（前者我们可能不知道，后者只有 host 知道）。
  const placement = (await d.db.federationPlacement
    .findUnique({
      where: {
        peer_panel_id_intent_id: {
          peer_panel_id: request.peer_panel_id ?? "",
          intent_id: intentId,
        },
      },
    })
    .catch(() => null)) as { peer_panel_id: string; lease_ref: string | null; state: string } | null;

  let row = placement;
  if (!row) {
    const rows = (await d.db.federationPlacement
      .findMany({ where: { tunnel_id: request.tunnelId, intent_id: intentId }, take: 1 })
      .catch(() => [])) as Array<{ peer_panel_id: string; lease_ref: string | null; state: string }>;
    row = rows.length > 0 ? rows[0]! : null;
  }

  const peerPanelId = row?.peer_panel_id ?? request.peer_panel_id ?? null;
  const leaseRef = row?.lease_ref ?? request.lease_ref ?? null;

  // 没有镜像行也没有 lease_ref：没有可释放的远端资源（从未建成）。
  if (peerPanelId === null) return { ok: true, released: true };
  if (leaseRef === null) {
    // 行在、但**从来没有建成**远端腿（reserve 阶段就失败了）：没有可释放的东西，
    // 也不该把"为什么失败"抹掉 —— 行保持 `degraded` + 真实错误码，等重连对账按同一
    // intent 收敛（契约 §5：peer 不可达 → degraded，而不是"结束"）。
    return { ok: true, released: true };
  }

  const resolved = await resolvePeer(peerPanelId, d);
  if (!resolved.ok) {
    // peer 已经被撤销：host 侧会因信任撤销而自行停服（契约 §2.4），我们只能如实标注。
    await markPlacementExpired(d, peerPanelId, intentId, resolved.code);
    return { ok: resolved.code === "peer_unknown" || resolved.code === "peer_revoked", released: false, code: resolved.code, message: resolved.message };
  }

  const released = await releaseRemoteLease(d, resolved.peer, leaseRef, intentId, request.revision);
  if (released.ok) {
    await markPlacementExpired(d, peerPanelId, intentId);
    return { ok: true, released: true };
  }
  // 失败要留下事实：镜像行记 degraded + 真实错误码，下一拍/下一轮仍按同一 intent 重试。
  await recordPlacementResult(
    { peer_panel_id: peerPanelId, intent_id: intentId, ok: false, code: released.code ?? "internal_error", message: released.message ?? null },
    { db: d.db as never, sender: d.sender as never, now: d.now },
  ).catch(() => undefined);
  return { ok: false, released: false, code: released.code, message: released.message };
}

async function markPlacementExpired(
  d: ResolvedForwardHopDeps,
  peerPanelId: string,
  intentId: string,
  code?: FederationErrorCode,
): Promise<void> {
  const existing = (await d.db.federationPlacement
    .findUnique({ where: { peer_panel_id_intent_id: { peer_panel_id: peerPanelId, intent_id: intentId } } })
    .catch(() => null)) as { forward_ref: string; desired_revision: number } | null;
  if (!existing) return;
  await upsertPlacement(
    {
      peer_panel_id: peerPanelId,
      forward_ref: existing.forward_ref,
      intent_id: intentId,
      hop_role: FEDERATED_EGRESS_HOP_ROLE,
      desired_revision: existing.desired_revision,
      state: "expired",
    },
    { db: d.db as never, sender: d.sender as never, now: d.now },
  ).catch(() => undefined);
  if (code) {
    await recordPlacementResult(
      { peer_panel_id: peerPanelId, intent_id: intentId, ok: false, code, message: null },
      { db: d.db as never, sender: d.sender as never, now: d.now },
    ).catch(() => undefined);
  }
}

/* ================================================================== */
/* 本机入口腿的 next_hop（注册表）                                        */
/* ================================================================== */

/**
 * 远端腿的可寻址地址（`host:port`），按 (tunnelId, peer) 记在**进程内**。
 *
 * 为什么需要它：入口的 `next_hop` 必须在 `cutover_ingress` 时拿到，而那次执行可能是
 * **另一次续跑**（进程重启后从 rollout 行重放）。与 `forward-rollout-exec.ts` 里
 * `nextHopHosts` 的取向一致：PREPARE 里重放 egress 步会重新拿到 host 的返回值，
 * 因此在 cutover 之前一定会被重新登记。
 *
 * 值只来自 host 的响应，**从不**由本机拼出来（猜地址 = 静默不通）。
 */
const remoteEgressAddresses = new Map<number, Map<string, string>>();

export function recordRemoteEgressAddress(tunnelId: number, peerPanelId: string, nextHop: string): void {
  const byPeer = remoteEgressAddresses.get(tunnelId) ?? new Map<string, string>();
  byPeer.set(peerPanelId, nextHop);
  remoteEgressAddresses.set(tunnelId, byPeer);
}

export function remoteEgressAddressFor(tunnelId: number, peerPanelId: string): string | null {
  return remoteEgressAddresses.get(tunnelId)?.get(peerPanelId) ?? null;
}

/** 测试用：清掉进程内的地址登记（生产路径不需要）。 */
export function resetRemoteEgressAddresses(): void {
  remoteEgressAddresses.clear();
}

export interface ReleaseStaleFederatedEgressResult {
  evaluated: number;
  released: number;
  failed: Array<{ intent_id: string; code: string; message: string }>;
}

/**
 * 释放这条 Forward 上**除 keepRevision 之外**的所有未终态远端腿。
 *
 * 为什么需要它：`intent_id` 里含 revision，所以"换一代 revision 重新委托"在 host
 * 侧是一条**新**租约。创建/重试路径（`reapplyRelayTunnel`）每次都会 bump revision，
 * 若不在委托前把上一代的腿释放掉，每次重试都会在对面留下一份孤儿 runtime + 端口
 * —— 这正是 G4 学到的泄漏形态，只是它发生在另一台面板上、没人看得见。
 *
 * 释放按每一行自己的 revision 对应的 intent 键进行，因此不会误伤新一代。
 */
export async function releaseStaleFederatedEgressForTunnel(
  tunnelId: number,
  keepRevision: number,
  deps?: ForwardHopDeps,
): Promise<ReleaseStaleFederatedEgressResult> {
  const d = resolveDeps(deps);
  const rows = (await d.db.federationPlacement
    .findMany({
      where: {
        tunnel_id: tunnelId,
        hop_role: FEDERATED_EGRESS_HOP_ROLE,
        state: { in: ["pending", "active", "degraded", "failed"] },
      },
      take: 20,
    })
    .catch(() => [])) as Array<{ peer_panel_id: string; intent_id: string; desired_revision: number }>;

  const result: ReleaseStaleFederatedEgressResult = { evaluated: rows.length, released: 0, failed: [] };
  for (const row of rows) {
    if (Number(row.desired_revision) === keepRevision) continue;
    const released = await releaseFederatedEgress(
      { tunnelId, revision: Number(row.desired_revision), peer_panel_id: row.peer_panel_id },
      deps,
    );
    if (released.ok) result.released += 1;
    else result.failed.push({ intent_id: row.intent_id, code: released.code ?? "internal_error", message: released.message ?? "" });
  }
  return result;
}
