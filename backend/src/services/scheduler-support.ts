/**
 * Scheduler dependency resolution, selection, port and persistence helpers.
 *
 * The create/reapply flows stay in scheduler.ts; this module provides their
 * reusable operational primitives.
 */
/* ================================================================== */
/* 依赖（全部可注入）                                                  */
/* ================================================================== */

import { CONNECTION_ONLINE_WINDOW_MS } from "./node-lifecycle.ts";
import { db } from "../db.ts";
import { decideNodeAuth } from "./node-credential.ts";
import { acquirePort, releaseLease } from "./portPool.ts";
import type { AcquirePortOutcome } from "./portPool.ts";
import {
  countWorkspaceTunnels,
  getEffectivePolicy,
  sumWorkspaceTraffic,
} from "./policy-service.ts";
import { checkTunnelCreation } from "./capability-policy.ts";
import { canUseNodeGroup } from "./node-group-access.ts";
import { Orchestrator, type DispatchFailure, type EgressDispatchOutcome, type RelayDispatchOutcome } from "./orchestrator.ts";
import type { ControlValidator } from "./control-protocol/index.ts";
import type { RuntimeUseChecker } from "./forward-rollout-exec.ts";
import type { RuntimeUseDenied } from "./forward-capability.ts";
import {
  DEFAULT_FORWARD_PROTOCOL,
  admitPersistedProtocol,
  buildForwardRuntimePlan,
  addressPartOfEndpoint,
  datagramHopPeerFor,
  firstConnectIp,
  forwardRuntimePlanViolations,
  normalizeForwardProtocol,
  persistedForwardProtocol,
  type ForwardRuntimePlan,
  type ForwardProtocol,
} from "./forward-contract.ts";
import { admitRuntimeFromStore, admissionFailureDetail, type AdmissionTarget, type CapabilityFactsLoader, type RuntimeAdmissionDenied } from "./runtime-admission.ts";
import { normalizeFederatedEgressPeer } from "./forward-revision.ts";
import {
  checkFederatedEgressTopology,
  delegateFederatedEgress,
  releaseFederatedEgress,
  releaseStaleFederatedEgressForTunnel,
  type ForwardHopSender,
} from "./federation/forward-hop.ts";

import { APPLY_STATUS, DESIRED_STATUS, SCHEDULER_ERROR_CODES } from "./scheduler-contract.ts";
import type { SchedulerErrorCode, SchedulerStep } from "./scheduler-contract.ts";

/* ================================================================== */
/* 依赖注入                                                            */
/* ================================================================== */

/**
 * WP8 编排器需要的最小 DB 投影（`db` 满足之；测试用内存替身）。
 *
 * 为什么不直接 import `db`：`policy-concurrency.test.ts` 已经证明「内存替身 +
 * 注入」比 `mock.module` 稳（不随模块解析路径变化而静默失效）。WP3 的
 * portPool 也用同一模式（`PortPoolDeps`）。
 */
export interface SchedulerDb {
  tunnel: {
    create(args: unknown): Promise<Record<string, unknown>>;
    update(args: unknown): Promise<Record<string, unknown>>;
    findUnique(args: unknown): Promise<Record<string, unknown> | null>;
    findMany(args: unknown): Promise<Record<string, unknown>[]>;
  };
  node: {
    findMany(args: unknown): Promise<Record<string, unknown>[]>;
    findUnique(args: unknown): Promise<Record<string, unknown> | null>;
  };
  nodeGroup: {
    findUnique(args: unknown): Promise<Record<string, unknown> | null>;
  };
  egressPool: {
    findUnique(args: unknown): Promise<Record<string, unknown> | null>;
    findFirst(args: unknown): Promise<Record<string, unknown> | null>;
  };
  egressTarget: {
    findMany(args: unknown): Promise<Record<string, unknown>[]>;
  };
}

export interface SchedulerDeps {
  db?: SchedulerDb;
  /**
   * 控制面校验器（WP6 {@link ControlValidator}）。编排器每下发一条命令都
   * 经过它，因此 stale / duplicate / expired 三条硬规则在编排层同样生效。
   * 未传则**懒构造一个进程级实例**（跨请求共享 revision 闸门）。
   */
  validator?: ControlValidator;
  /** 依赖注入给 portPool 的替身（测试用；未传走 db/redis 单例）。 */
  portPoolDeps?: Parameters<typeof acquirePort>[1];
  /** 策略读取（默认 {@link getEffectivePolicy}）。 */
  loadPolicy?: (
    workspaceId: number,
  ) => Promise<Awaited<ReturnType<typeof getEffectivePolicy>>>;
  /** 节点组授权判定（默认 {@link canUseNodeGroup}）。 */
  authorizeGroup?: typeof canUseNodeGroup;
  /** Existing apply/retry/resume only; does not consume a creation count slot. */
  runtimeUse?: RuntimeUseChecker;
  /**
   * V5.5 WP15：跨面板出站的注入点（默认走 `client.callPeer`）。
   *
   * 只有声明了 `federated_egress_peer` 的 RELAY 编排会用到它；为 NULL 的路径一次
   * 也不碰（既有的 create/retry 行为逐字节不变）。
   */
  federatedSender?: ForwardHopSender;
  /**
   * V5-WP1：读取节点已上报的 v2 协商事实（默认读 `node_state_report`）。
   * 注入点是**测试**用的，生产路径只有一处实现（services/runtime-admission.ts）。
   */
  loadCapabilityFacts?: CapabilityFactsLoader;
  /** 编排时钟（测试注入固定时间，避免 TTL 边界漂移）。 */
  now?: () => Date;
}

export const defaultDeps: Required<
  Pick<SchedulerDeps, "db" | "loadPolicy" | "authorizeGroup" | "now">
> = {
  db: db as unknown as SchedulerDb,
  loadPolicy: (workspaceId: number) => getEffectivePolicy(workspaceId, { noCache: true }),
  authorizeGroup: canUseNodeGroup,
  now: () => new Date(),
};

export function resolveDeps(over?: SchedulerDeps) {
  return {
    db: over?.db ?? defaultDeps.db,
    loadPolicy: over?.loadPolicy ?? defaultDeps.loadPolicy,
    authorizeGroup: over?.authorizeGroup ?? defaultDeps.authorizeGroup,
    runtimeUse: over?.runtimeUse ?? (async (workspaceId: number, resource: Parameters<RuntimeUseChecker>[1]) => {
      const { checkForwardRuntimeUse } = await import("./forward-capability.ts");
      return checkForwardRuntimeUse(workspaceId, resource);
    }),
    now: over?.now ?? defaultDeps.now,
    validator: over?.validator,
    portPoolDeps: over?.portPoolDeps,
    loadCapabilityFacts: over?.loadCapabilityFacts,
    // V5.5 WP15：未注入时 undefined ⇒ forward-hop 用 `client.callPeer`（唯一实现）。
    federatedSender: over?.federatedSender,
  };
}

/**
 * V5-WP1 runtime admission：**下发前**确认每一台参与节点都实现了
 * 「这个动作 + 这个协议 + 这个传输」。
 *
 * 为什么放在编排层而不是只依赖 Agent 侧的拒绝：
 *   · Agent 侧拒绝发生在命令**已经入队、端口租约已经产生**之后。RELAY 场景下
 *     出口可能已经 ACK，于是要跑一遍补偿才回到干净状态——一次本来可以在
 *     "零副作用"阶段拦下的失败，变成了三条写操作加一次撤隧道。
 *   · 「节点离线」和「节点不支持」必须能被区分。前者可以重试，后者重试一万
 *     次也没用，只能升级 Agent 或换节点。
 *
 * 判定规则本身**不在这里**（见 services/runtime-admission.ts）：本函数只负责
 * 取事实、把结构化原因翻译成 scheduler 的错误码空间、并落一条可排障的 detail。
 */
export async function admitBoundRuntime(
  deps: ReturnType<typeof resolveDeps>,
  targets: readonly AdmissionTarget[],
  protocol: ForwardProtocol,
): Promise<RuntimeAdmissionDenied | null> {
  const admitted = await admitRuntimeFromStore(
    targets,
    { action: "apply_tunnel", protocol },
    deps.loadCapabilityFacts,
  );
  return admitted.ok ? null : admitted;
}

/**
 * V5-WP5-A1: the tls front's paths off a persisted row.
 *
 * Only returned for an admitted `tls` fact: handing paths to a tcp/ws tunnel
 * would put fields on the wire that the Agent must then decide to ignore, and
 * "the Agent ignores it" is not a contract.
 */
export function tlsPathsFor(row: Record<string, unknown>, protocol: ForwardProtocol) {
  if (protocol !== "tls") return {};
  const cert = typeof row.tls_cert_path === "string" ? row.tls_cert_path.trim() : "";
  const key = typeof row.tls_key_path === "string" ? row.tls_key_path.trim() : "";
  if (cert === "" || key === "") {
    // A tls row without paths is a broken configuration, not a tcp tunnel: the
    // dispatch refuses (see Orchestrator.tlsFields) rather than downgrading.
    return { tlsCertPath: null, tlsKeyPath: null };
  }
  return { tlsCertPath: cert, tlsKeyPath: key };
}

/** admission 失败 → `Tunnel.apply_error` 上的结构化记录（不删业务行，§7.11）。 */
export function admissionFailureText(denied: RuntimeAdmissionDenied): string {
  return admissionFailureDetail(denied);
}

/* ================================================================== */
/* 节点选择                                                            */
/* ================================================================== */

/** 编排器眼里的节点投影（§2.1：Node.role 是能力最终真相源）。 */
export interface SchedulableNode {
  id: number;
  node_id: string;
  role: "ingress" | "egress" | "both" | null;
  connect_ip: string | null;
  /** V5.1b WP5-B2：入口上报的跳端点藏在这里（`tunnels[].diag.hop_local_addr`）。
   *  取证地址必须优先用它——多宿节点上 `connect_ip` 指的是**另一张网**的地址，
   *  出口会因此把每个跳报文都丢弃（真拓扑实测）。 */
  state_report?: { tunnels?: unknown } | null;
  /** 端口分配区间；NULL 由 portPool 判 `node_range_unset`。 */
  port_range_min: number | null;
  port_range_max: number | null;
  lb_strategy: "round" | "rand" | "weighted_round" | null;
  /** 节点状态（`Node.status`：active / inactive）。 */
  status: "active" | "inactive";
  /** 最近心跳（`Node.last_seen_at`，WP7 之后由 session/state report 更新）。 */
  last_seen_at: Date | null;
  node_group_id: number;
  /**
   * WP7 per-node credential 状态（`Node.node_credential_hash` /
   * `credential_revoked`）。`node_credential_hash` 为 NULL = 该节点从未被
   * 签发凭据，即 §3.3 意义上「还没有可验证身份」；一旦有值就必须过
   * {@link decideNodeAuth} 的三条判定（含 revoked 优先）。
   */
  node_credential_hash?: string | null;
  credential_revoked?: boolean;
}

/** 角色是否覆盖指定方向（`both` 同时覆盖入口与出口，§2.1）。 */
export function roleCovers(role: SchedulableNode["role"], direction: "ingress" | "egress"): boolean {
  if (role === "both") return true;
  return role === direction;
}

/* ================================================================== */
/* 节点身份（WP7 node-credential，§3.3）                                */
/* ================================================================== */

/**
 * {@link SchedulableNode} 的凭据列投影（`Node.node_credential_hash` /
 * `Node.credential_revoked`，WP7 迁移 20260925120000 落地）。
 */
export interface NodeCredentialFields {
  node_credential_hash: string | null;
  credential_revoked: boolean;
}

/**
 * 一个节点当前是否**可被编排**（身份维度）。
 *
 * 直接复用 WP7 的 {@link decideNodeAuth} 而不是在这里重写判定：§3.3 的三条
 * 硬规则（没签过 → 拒、revoked → 拒、哈希不等 → 拒）必须只有一份实现，
 * 否则「撤销后还能下发」这类回归会从第二份实现里长出来。
 *
 * `presentedHash` 传什么：编排器拿不到也不该拿 Agent 的明文凭据（那是
 * Agent→面板方向的事，见 `routes/internal-node.ts`）。这里要回答的是
 * 「这台节点**有没有**一个有效的、控制面签发给它的身份」，所以用**节点行
 * 自己的哈希**去比对：命中 = 凭据在位且未被撤销；NULL = 从没签过。
 * revoked 优先级高于比对，与 WP7 的判定顺序一致。
 *
 * 刻意**不调** `authenticateNode`：那会连 Redis + DB，而编排器的 bind 阶段
 * 每建一条隧道就要跑两次，且单测必须离线。身份解析属于 IO 边界（WP7 的
 * HTTP 层），本模块只做「编排前的前置校验」这一态判定。
 */
export function nodeCredentialUsable(
  node: NodeCredentialFields | { node_credential_hash?: string | null; credential_revoked?: boolean },
): { ok: true } | { ok: false; reason: "invalid_credential" | "revoked" } {
  // 用节点自身哈希自证：decideNodeAuth 的语义是「这把钥匙能不能开这把锁」，
  // 编排视角则是「这把锁还在不在、有没有被吊销」。
  return decideNodeAuth(
    {
      node_credential_hash: node.node_credential_hash ?? null,
      credential_revoked: node.credential_revoked ?? false,
    },
    node.node_credential_hash ?? "",
  );
}

/** 节点是否算在线：`status=active` 且心跳未超时。离线仍可被选中但记 warning（见下）。 */
export function isOnline(node: SchedulableNode, now: Date, timeoutMs: number): boolean {
  if (node.status !== "active") return false;
  if (node.last_seen_at === null) return false;
  return now.getTime() - node.last_seen_at.getTime() <= timeoutMs;
}

/**
 * 心跳超时窗口。**与连接投影同源**（`node-lifecycle.CONNECTION_ONLINE_WINDOW_MS`），
 * 不在这里另写一个 90_000：`isOnline()` 与 `deriveConnection()` 回答的是同一个问题
 * （`status=active` 且最近一次上报在窗口内），两边数值分叉就会出现"面板说在线、
 * 调度说不可调度"——而调度会据此**把新业务放到别处**，比一句显示错误贵得多。
 *
 * 名字保留是因为它描述的是**调度侧的兜底角色**：节点已被判 inactive 时无需重复判断，
 * 仍在 active 但心跳过期时视为不可调度。
 */
export const HEARTBEAT_TIMEOUT_MS = CONNECTION_ONLINE_WINDOW_MS;

/**
 * 在候选组内挑一个可用的方向节点。
 *
 * 选择规则（刻意简单，且**不擅自迁移**——WP9 才有 Reconciler）：
 *   1. `role` 覆盖该方向（§2.1：`Node.role` 是最终真相源，`NodeGroup.node_type`
 *      只是 legacy 兼容，**不参与判定**）；
 *   2. **持有有效 per-node credential**（§3.3：编排器要向它下发真配置，
 *      身份不可验证的节点直接出局——这是 WP7 {@link decideNodeAuth} 的三条
 *      判定，`credential_revoked` 优先于哈希比对）；
 *   3. 优先在线节点（心跳新鲜）；
 *   4. 同组内多候选时取 `id` 最小（确定性，避免同一请求两次选到不同节点）。
 *
 * 全离线时仍返回候选（`online: false`）：节点可能只是心跳抖动，编排照常下发，
 * Agent ACK 超时才是真正的失败信号。真正要求「必须在线」的调用方（WP11 的
 * 立即生效语义）在 ACK 阶段自然失败，不会拿到一个假 active。
 *
 * 与（2）不同，凭据缺失**不**降级放行：心跳抖动是「可能还在跑」，凭据缺失
 * 是「根本无法证明它在跑」。`reason` 让调用方能区分「组里没节点」与「有节点
 * 但都没凭据」两种完全不同的排障路径。
 */
export function pickNode(
  candidates: readonly SchedulableNode[],
  direction: "ingress" | "egress",
  now: Date,
):
  | { ok: true; node: SchedulableNode; online: boolean }
  | { ok: false; reason: "no_role_match" | "no_credential" } {
  const usable = candidates.filter((n) => roleCovers(n.role, direction));
  if (usable.length === 0) return { ok: false, reason: "no_role_match" };
  // 身份闸门： revoked 与未签发都出局（WP7 decideNodeAuth，单一实现）。
  const credentialed = usable.filter((n) => nodeCredentialUsable(n).ok);
  if (credentialed.length === 0) return { ok: false, reason: "no_credential" };
  const sorted = [...credentialed].sort((a, b) => a.id - b.id);
  const online = sorted.find((n) => isOnline(n, now, HEARTBEAT_TIMEOUT_MS));
  if (online) return { ok: true, node: online, online: true };
  return { ok: true, node: sorted[0]!, online: false };
}

/* ================================================================== */
/* 端口预留：legacy DIRECT 交接（§5.2 / §7.6 硬要求）                   */
/* ================================================================== */

/**
 * 收集「同一物理节点上、DB 里没有租约行」的已占用端口。
 *
 * 这是 WP3 交接条款的落地：legacy `socket/port-allocator.ts` 分配的 DIRECT
 * `listen_port` **不写 `node_port_lease`**，那种撞号没有任何 DB 约束兜底，
 * 比 v3 内部撞号危险得多。因此 v3 分配前必须把这些端口灌进 `reservedPorts`。
 */
export function collectReservedPorts(tunnels: readonly { listen_port: number | null }[]): number[] {
  const out = new Set<number>();
  for (const t of tunnels) {
    if (typeof t.listen_port === "number" && Number.isInteger(t.listen_port) && t.listen_port > 0) {
      out.add(t.listen_port);
    }
  }
  return [...out];
}

/* ================================================================== */
/* 失败载体                                                            */
/* ================================================================== */

/** 编排期可预期失败（不抛到调用方面前，统一收进 Tunnel 的 error 字段）。 */
export class SchedulerError extends Error {
  readonly code: SchedulerErrorCode;
  readonly step?: SchedulerStep;
  constructor(code: SchedulerErrorCode, message: string, step?: SchedulerStep) {
    super(message);
    this.name = "SchedulerError";
    this.code = code;
    this.step = step;
  }
}

/* ================================================================== */
/* 端口分配（薄封装，把 AcquirePortOutcome 翻译成调度错误码）            */
/* ================================================================== */

export interface PortAllocationSuccess {
  ok: true;
  port: number;
  leaseId: number;
  /** 端口是否曾是 released 行被 revive（观测用）。 */
  reused: boolean;
}

export type PortAllocationFailure = {
  ok: false;
  code: SchedulerErrorCode;
  detail: string;
  /** user-specified 场景下的具体端口（便于回显）。 */
  port?: number;
};

/** WP3 失败码 → WP8 编排错误码（集中一处，避免散落的 if 链）。 */
export function mapAcquireFailure(outcome: Extract<AcquirePortOutcome, { ok: false }>): PortAllocationFailure {
  const port = outcome.port;
  switch (outcome.code) {
    case "port_taken":
      return { ok: false, code: SCHEDULER_ERROR_CODES.port_allocation_failed, detail: "端口已被占用", port };
    case "no_available_port":
      return { ok: false, code: SCHEDULER_ERROR_CODES.port_allocation_failed, detail: "节点端口区间内无可用端口" };
    case "node_not_found":
      return { ok: false, code: SCHEDULER_ERROR_CODES.node_unavailable, detail: "节点不存在", port };
    case "node_range_unset":
      return { ok: false, code: SCHEDULER_ERROR_CODES.port_allocation_failed, detail: "节点未配置端口区间（port_range_min/max）" };
    case "node_range_invalid":
      return { ok: false, code: SCHEDULER_ERROR_CODES.port_allocation_failed, detail: "节点端口区间不合法（min>max 或越界）" };
    case "port_out_of_range":
    case "port_blacklisted":
    case "port_outside_node_range":
      return { ok: false, code: SCHEDULER_ERROR_CODES.port_invalid, detail: `端口 ${port ?? "?"} 不合法（${outcome.code}）`, port };
    default:
      return { ok: false, code: SCHEDULER_ERROR_CODES.port_allocation_failed, detail: `端口分配失败（${outcome.code}）`, port };
  }
}

/**
 * 申请一个端口租约。
 *
 * 纯粹的 portPool 适配层：**不 try/catch 之外的逻辑**。保留独立函数是为了
 * 测试可以单独钉死「user-specified 与 auto 走同一规则」这条 §7.6 要求
 * （cheap path：不需要整条编排流程）。
 */
export async function allocateTunnelPort(
  args: {
    nodeId: number;
    direction: "ingress" | "egress";
    preferred?: number | null;
    tunnelId?: number | null;
    reservedPorts?: readonly number[];
  },
  inject?: SchedulerDeps["portPoolDeps"],
): Promise<PortAllocationSuccess | PortAllocationFailure> {
  // 本隧道自己的 runtime 占着某个端口 ≠ 别人占用：把 listen_port 改成它当前正在用的值、
  // 或失败后重试同一端口，都必须成功（否则会 502 port_taken，而端口本就是这条隧道在听）。
  const ownRuntimeIds =
    args.tunnelId === null || args.tunnelId === undefined
      ? []
      : Orchestrator.localRuntimeIdsForTunnel(Number(args.tunnelId));
  const outcome = await acquirePort(
    {
      nodeId: args.nodeId,
      leaseType: args.direction,
      preferredPort: args.preferred ?? null,
      tunnelId: args.tunnelId ?? null,
      reservedPorts: args.reservedPorts ?? [],
      ownRuntimeIds,
      deps: inject,
    },
    inject,
  );
  if (!outcome.ok) return mapAcquireFailure(outcome);
  return { ok: true, port: outcome.result.port, leaseId: outcome.result.leaseId, reused: outcome.result.reused };
}

/* ================================================================== */
/* 目标解析                                                            */
/* ================================================================== */

export const HOST_PORT = /^\[([0-9a-fA-F:.]+)\]:(\d{1,5})$/;
export const HOST_PORT_V4 = /^([^:\s]+):(\d{1,5})$/;

/**
 * 解析 `host:port`（IPv4 / 域名 / `[IPv6]` 三种形态）。
 *
 * 与 `routes/tunnels.ts` 的 `FORWARD_RE` 口径一致（DIRECT 与 RELAY 的用户
 * 输入不应有两套校验标准）。
 */
export function parseHostPort(value: string): { host: string; port: number } | null {
  const raw = value.trim();
  if (raw === "") return null;
  const v6 = HOST_PORT.exec(raw);
  if (v6) {
    const port = Number(v6[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host: v6[1]!, port };
  }
  const m = HOST_PORT_V4.exec(raw);
  if (!m) return null;
  const host = m[1]!;
  if (host === "" || host.includes("[")) return null;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

/* ================================================================== */
/* 编排结果落库                                                        */
/* ================================================================== */

/**
 * 把 orchestrator 的 dispatch 失败码翻译成编排错误码。
 *
 * 为什么要翻译而不是直接复用：`agent_unreachable` / `agent_rejected` 只说明
 * 「这次下发没成」，不说明「发生在哪一端」。`apply_error_code` 是给前端和
 * 排障看的，必须能直接回答「该看入口还是出口」——同一个网络抖动，在入口
 * 失败意味着**用户已经连不上**，在出口失败则对外无感，处理优先级不同。
 */
export function mapDispatchCode(
  side: "ingress" | "egress",
  failure: DispatchFailure,
): SchedulerErrorCode {
  switch (failure.error_code) {
    case "agent_unreachable":
    case "ack_timeout":
    case "node_unaddressable":
      return side === "egress"
        ? SCHEDULER_ERROR_CODES.egress_apply_rejected
        : SCHEDULER_ERROR_CODES.ingress_apply_rejected;
    case "revision_mismatch":
    case "ack_invalid":
      return side === "egress"
        ? SCHEDULER_ERROR_CODES.egress_apply_rejected
        : SCHEDULER_ERROR_CODES.ingress_apply_rejected;
    case "ack_failed":
    case "agent_rejected":
    default:
      return side === "egress"
        ? SCHEDULER_ERROR_CODES.egress_apply_rejected
        : SCHEDULER_ERROR_CODES.ingress_apply_rejected;
  }
}

/** 构造写进 `apply_error` 的人读文案（`code` 已单独落列）。 */
export function errorText(code: SchedulerErrorCode, detail: string): string {
  return `[${code}] ${detail}`;
}

/**
 * 把一次失败写进 Tunnel 行。
 *
 * **这是 §7.11「任何失败」四条要求的唯一落点**，因此它只做 update、绝不 delete：
 *   · `apply_status = "error"`；
 *   · `apply_error_code` / `apply_error` 结构化错误；
 *   · `desired_status` 回 `inactive`（控制面不认为这条隧道应该在跑）；
 *   · `last_applied_at` 不动（这段编排从未成功过）。
 */
export async function persistFailure(
  store: SchedulerDb,
  tunnelId: number,
  args: { code: SchedulerErrorCode; detail: string; revision?: number | null },
): Promise<void> {
  await store.tunnel.update({
    where: { id: tunnelId },
    data: {
      apply_status: APPLY_STATUS.error,
      apply_error_code: args.code,
      apply_error: errorText(args.code, args.detail).slice(0, 500),
      desired_status: DESIRED_STATUS.inactive,
      ...(args.revision != null ? { config_revision: args.revision } : {}),
    },
  });
}

/** 成功落库：两端 ACK 之后 `apply_status=active`、`last_applied_at=now`。 */
export async function persistSuccess(
  store: SchedulerDb,
  tunnelId: number,
  args: { revision: number; at: Date },
): Promise<void> {
  await store.tunnel.update({
    where: { id: tunnelId },
    data: {
      apply_status: APPLY_STATUS.active,
      desired_status: DESIRED_STATUS.active,
      applied_revision: args.revision,
      config_revision: args.revision,
      last_applied_at: args.at,
      apply_error_code: null,
      apply_error: null,
    },
  });
}


export type CompensationRemoval = Parameters<Orchestrator["removeTunnel"]>[0];

/**
 * Fail-closed compensation: runtime removal is the safety barrier before a
 * NodePortLease may be released. If any runtime cannot be confirmed removed,
 * keep every lease owned by the tunnel so the allocator cannot hand a possibly
 * still-listening port to another runtime. Reconcile can retry cleanup later.
 */
export async function compensateRuntimesThenRelease(input: {
  tunnelId: number;
  orchestrator: Orchestrator;
  removals: readonly CompensationRemoval[];
  portPoolDeps: SchedulerDeps["portPoolDeps"];
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const failures: string[] = [];
  for (const removal of input.removals) {
    try {
      const result = await input.orchestrator.removeTunnel(removal);
      if (!result.ok) failures.push(`${removal.direction ?? "runtime"}: ${result.error}`);
    } catch (error) {
      failures.push(
        `${removal.direction ?? "runtime"}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (failures.length > 0) {
    return {
      ok: false,
      error: `runtime teardown 未确认完成，保留端口租约等待 reconcile：${failures.join("; ")}`,
    };
  }

  try {
    await releaseLease({ tunnelId: input.tunnelId }, input.portPoolDeps);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: `runtime 已撤除，但端口租约释放失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

