/**
 * Scheduler + RELAY Orchestrator（Track C，集成型工作包）。
 *
 * RELAY 编排遵循期望状态与单一编排路径原则。
 *
 * ── 本模块负责什么 ──
 *  把「用户要一条 RELAY 隧道」这个意图，按 §7.11 冻结的**固定顺序**编排到底：
 *
 *    auth/quota
 *    → desired Tunnel=pending
 *    → bind ingress/egress Node
 *    → acquire ports
 *    → revision++
 *    → apply Egress
 *    → Egress ACK
 *    → apply Ingress
 *    → Ingress ACK
 *    → active
 *
 * ── 本模块不负责什么 ──
 *  · 不碰 HTTP 路由（WP11 才挂端�点；本模块只交付服务层，与 WP6 contract
 *    测试同一模式——零 hono 依赖，可在无 DB 环境下离线单测）。
 *  · 不做 Reconciler 的周期对账（WP9）。这里只在**一次**创建流程内做补偿。
 *  · 不物理删除 Tunnel：任何失败都保留行（§4.1「失败时保留 Tunnel，
 *    前端展示原因并允许 Retry」）。
 *  · 不接最终 transport：下发走 {@link AgentGateway} 接口（见 orchestrator.ts），
 *    默认实现经 WP6 命令信封 / {@link ControlValidator}，Agent 侧 HTTP 通道
 *    由 WP7 的 node session 落地后接入。WP8 只冻结「谁先谁后、失败怎么补偿」。
 *
 * ── 失败补偿（§7.11「任何失败」四条硬要求）──
 *   1. 保留 Tunnel —— 一律 `db.tunnel.update`，没有任何 `delete` 调用；
 *   2. `apply_status = "error"`；
 *   3. 写结构化错误 —— `apply_error_code`（机器码）+ `apply_error`（人读原文），
 *      错误码是 §7.11 之后各 WP 共用的稳定标识，不是临时字符串；
 *   4. 执行补偿 —— 按「已经走到哪一步」回滚**已产生的副作用**：已 ACK 的
 *      Egress 必须先 remove 掉（否则它会继续占着出口端口收流量），已占的
 *      端口租约释放掉，`desired_status` 归位。
 *
 * 补偿的顺序与下发**相反**（Egress 后进先出）：这是「先出口后入口」（§1.1）的
 * 镜像——撤的时候也必须先撤出口，否则入口还在往一个已经拆掉的出口灌流量。
 */

/* 依赖（全部可注入）                                                  */
/* ================================================================== */

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

/* Scheduler contract and support primitives are split from orchestration flows. */
import { APPLY_STATUS, DESIRED_STATUS, SCHEDULER_ERROR_CODES, isRetryable } from "./scheduler-contract.ts";
import type { SchedulerErrorCode, SchedulerStep, StepRecord, CreateRelayTunnelInput, CreateRelayFailure, CreateRelayTunnelResult } from "./scheduler-contract.ts";
import { resolveDeps, admitBoundRuntime, tlsPathsFor, admissionFailureText, errorText, persistFailure, persistSuccess, compensateRuntimesThenRelease, pickNode, collectReservedPorts, allocateTunnelPort, mapDispatchCode } from "./scheduler-support.ts";
import type { SchedulerDb, SchedulerDeps, SchedulableNode, CompensationRemoval } from "./scheduler-support.ts";
export { APPLY_STATUS, DESIRED_STATUS, SCHEDULER_ERROR_CODES, isRetryable, SCHEDULER_STEPS } from "./scheduler-contract.ts";
export type { ApplyStatus, DesiredStatus, SchedulerErrorCode, SchedulerStep, StepRecord, RelayTargetInput, CreateRelayTunnelInput, CreateRelayFailure, CreateRelaySuccess, CreateRelayTunnelResult } from "./scheduler-contract.ts";
export { nodeCredentialUsable, pickNode, collectReservedPorts, SchedulerError, allocateTunnelPort, parseHostPort, mapDispatchCode } from "./scheduler-support.ts";
export type { SchedulerDb, SchedulerDeps, SchedulableNode, NodeCredentialFields, PortAllocationSuccess, PortAllocationFailure } from "./scheduler-support.ts";

/* ================================================================== */
/* 主入口                                                              */
/* ================================================================== */

/**
 * 创建一条 RELAY 隧道并编排它到 `active`。
 *
 * 顺序**严格**遵循 §7.11 的十条；任何一步失败立即进入补偿路径，
 * 已执行的后续步骤不再执行（这也是为什么步骤记录对测试重要）。
 *
 * @param input  见 {@link CreateRelayTunnelInput}
 * @param orchestrator 下发通道（WP4 Agent API / WP7 node session）。
 *        默认构造一个基于 WP6 ControlValidator 的进程级 orchestrator。
 * @param deps   见 {@link SchedulerDeps}
 */
/**
 * V5.1b WP5-B2（契约 §12.5 第 9 条）：用入口 ACK 回报的跳端点**纠正**出口腿的取证地址。
 *
 * 为什么必须做：出口腿**先于**入口腿下发（铁律一），那一刻入口连 runtime 都还没有，面板只能按
 * `connect_ip` 取证；多宿节点上那是**另一张网**的地址，出口会把每个跳报文都丢掉（实测
 * ingress packets_in=1 / egress drops=1，而控制面全绿）。这条 ACK 是唯一**当场**给出真实端点
 * 的时刻——此后所有下发都会从入口的周期上报里读到同一地址，所以纠正只在编排里做一次。
 *
 * 为什么是**一处实现、两处调用**：`createRelayTunnel`（隧道 API）与 `reapplyRelayTunnel`
 *（前向 API 的创建/重入）**都会**下发入口腿。第一版只接了一条，于是真拓扑上的纠正一次都没触发
 *（出口腿只被应用过 rev1）——"同一份事实有两条投递路径"这条教训，这次落在编排层。
 */
async function correctDatagramHopPeerAfterIngressAck(args: {
  tunnelId: number;
  revision: number;
  protocol: ForwardProtocol;
  ingressAckHopLocalAddr: unknown;
  connectIp: string | null;
  egressNode: SchedulableNode;
  egressPort: number;
  poolId: number | null;
  egressTargets: readonly { host: string; port: number; weight?: number; order_by?: number }[];
  ingressNode: SchedulableNode;
  ingressPort: number;
  nextHop: string;
  tlsPaths: Record<string, unknown>;
  orchestrator: Orchestrator;
  /** `resolveDeps()` 之后的 store（它必有值；`SchedulerDeps.db` 本身是可选的）。 */
  store: SchedulerDb;
  deps: SchedulerDeps;
}): Promise<
  | { ok: true; revision: number; corrected: boolean; hopPeer: string | null }
  | { ok: false; revision: number; error: string; hopPeer: string | null }
> {
  const learned = addressPartOfEndpoint(args.ingressAckHopLocalAddr);
  if (args.protocol !== "udp" || !learned || learned === firstConnectIp(args.connectIp)) {
    // 没有纠正要做：不是 datagram、agent 没报（老 Agent）、或报的就是首次下发用的那个地址。
    return { ok: true, revision: args.revision, corrected: false, hopPeer: learned ?? null };
  }
  const correctedRevision = args.revision + 1;
  // 抬 revision 并落库：Agent 的闸门把「同 revision 的第二次下发」当重复——那是它该做的，
  // 配置变了就必须是新 revision。
  await args.store.tunnel.update({
    where: { id: args.tunnelId },
    data: { config_revision: correctedRevision, apply_status: APPLY_STATUS.applying },
  });
  const egress = await args.orchestrator.dispatchEgress({
    tunnelId: args.tunnelId,
    revision: correctedRevision,
    egressNode: args.egressNode,
    egressPort: args.egressPort,
    poolId: args.poolId,
    targets: args.egressTargets as { host: string; port: number; weight?: number; order_by?: number }[],
    protocol: args.protocol,
    hopPeer: learned,
  });
  const ingress = egress.ok
    ? await args.orchestrator.dispatchIngress({
        tunnelId: args.tunnelId,
        revision: correctedRevision,
        ingressNode: args.ingressNode,
        ingressPort: args.ingressPort,
        nextHop: args.nextHop,
        protocol: args.protocol,
        ...(args.tlsPaths as Record<string, string>),
      })
    : null;
  if (!egress.ok || ingress === null || !ingress.ok) {
    // 纠正失败 ⇒ 出口此刻对**错的**地址取证（数据面不通），而两条腿的 revision 已不一致。
    // 按既有口径补偿到"两侧都没有 runtime"，并把这次编排报成失败——不做半成功。
    const reason = "hop peer correction failed";
    const compensation = await compensateRuntimesThenRelease({
      tunnelId: args.tunnelId,
      orchestrator: args.orchestrator,
      // Reverse of activation order: near side first, then far side.
      removals: [
        { tunnelId: args.tunnelId, node: args.ingressNode, direction: "ingress", revision: correctedRevision + 1, reason },
        { tunnelId: args.tunnelId, node: args.egressNode, direction: "egress", revision: correctedRevision + 1, reason },
      ],
      portPoolDeps: args.deps.portPoolDeps,
    });
    let error = "unknown";
    if (!egress.ok) error = egress.error;
    else if (ingress !== null && !ingress.ok) error = ingress.error;
    if (!compensation.ok) error += `；${compensation.error}`;
    return { ok: false, revision: correctedRevision, error: `datagram 跳取证的纠正下发失败：${error}`, hopPeer: learned };
  }
  // 「两条腿共用同一个 config_revision」是不变量（§3.2）：纠正把两者一起抬到新 revision。
  return { ok: true, revision: correctedRevision, corrected: true, hopPeer: learned };
}

export async function createRelayTunnel(
  input: CreateRelayTunnelInput,
  orchestrator: Orchestrator,
  over?: SchedulerDeps,
): Promise<CreateRelayTunnelResult> {
  const deps = resolveDeps(over);
  const store = deps.db;
  const now = deps.now();
  const steps: StepRecord[] = [];

  const fail = async (
    step: SchedulerStep,
    code: SchedulerErrorCode,
    detail: string,
    ctx: { tunnelId?: number; revision?: number | null; meta?: Record<string, unknown> },
  ): Promise<CreateRelayFailure> => {
    steps.push({ step, ok: false, error_code: code, detail, meta: ctx.meta });
    if (ctx.tunnelId !== undefined) {
      // The response may only claim a durable failure after the ledger write
      // completes. If the DB write itself fails, propagate that storage error:
      // returning a neat apply error while the row is still pending/applying is
      // a false terminal state and makes Retry/reconcile reason from stale facts.
      await persistFailure(store, ctx.tunnelId, { code, detail, revision: ctx.revision });
    }
    return {
      ok: false,
      tunnelId: ctx.tunnelId ?? -1,
      steps,
      failedStep: step,
      error_code: code,
      error: errorText(code, detail),
      retryable: isRetryable(code),
    };
  };

  /* ---------------- V5-WP0 protocol admission ---------------- */
  const protocol = normalizeForwardProtocol(input.tunnelType);
  if (protocol === null) {
    return fail(
      "auth_quota",
      SCHEDULER_ERROR_CODES.unsupported_protocol,
      `协议 ${String(input.tunnelType)} 尚未通过当前 runtime Gate`,
      {},
    );
  }

  /* ---------------- ① auth / quota ---------------- */
  const policy = await deps.loadPolicy(input.workspaceId);
  const decision = checkTunnelCreation(policy, {
    // 编排在落库前先按当前计数判定；真正防超发的行锁由调用方（WP11 路由）
    // 在同事务里包住「判定 + 落库」。这里不重复实现 SOFT-01 的锁。
    tunnelCount: await countWorkspaceTunnels(input.workspaceId, store as never),
    trafficUsed: await sumWorkspaceTraffic(
      input.workspaceId,
      policy.limits.traffic_period,
      now,
      store as never,
    ),
    protocol,
    inGroupOwned: true, // 由下方授权判定取代：组授权未过根本走不到这里
    inGroupId: input.inNodeGroupId,
    outGroupId: input.outNodeGroupId,
    outGroupOwned: true,
  });
  if (!decision.allowed) {
    const code: SchedulerErrorCode =
      decision.reason === "tunnel_limit"
        ? SCHEDULER_ERROR_CODES.tunnel_limit
        : decision.reason === "traffic_exhausted"
          ? SCHEDULER_ERROR_CODES.traffic_exhausted
          : SCHEDULER_ERROR_CODES.policy_denied;
    return fail("auth_quota", code, decision.message ?? "策略拒绝", {});
  }
  steps.push({ step: "auth_quota", ok: true, meta: { reason: decision.reason ?? "allowed" } });

  /* 节点组授权：入口必授，出口必须显式指定且授权（RELAY 不能只用入口组）。 */
  const inGroup = await store.nodeGroup.findUnique({ where: { id: input.inNodeGroupId } });
  if (!inGroup) {
    return fail("auth_quota", SCHEDULER_ERROR_CODES.node_group_not_allowed, `入口节点组 ${input.inNodeGroupId} 不存在`, {});
  }
  const inGroupAllowed = await deps.authorizeGroup(
    input.userId,
    inGroup as never,
    "in",
    input.workspaceId,
    input.personalWorkspaceId,
  );
  if (!inGroupAllowed) {
    return fail(
      "auth_quota",
      SCHEDULER_ERROR_CODES.node_group_not_allowed,
      `无权使用入口节点组 ${input.inNodeGroupId}`,
      {},
    );
  }
  if (input.outNodeGroupId === null) {
    return fail(
      "auth_quota",
      SCHEDULER_ERROR_CODES.mode_topology_mismatch,
      "RELAY 模式必须指定出口节点组",
      {},
    );
  }
  const outGroup = await store.nodeGroup.findUnique({ where: { id: input.outNodeGroupId } });
  if (!outGroup) {
    return fail(
      "auth_quota",
      SCHEDULER_ERROR_CODES.node_group_not_allowed,
      `出口节点组 ${input.outNodeGroupId} 不存在`,
      {},
    );
  }
  const outGroupAllowed = await deps.authorizeGroup(
    input.userId,
    outGroup as never,
    "out",
    input.workspaceId,
    input.personalWorkspaceId,
  );
  if (!outGroupAllowed) {
    return fail(
      "auth_quota",
      SCHEDULER_ERROR_CODES.node_group_not_allowed,
      `无权使用出口节点组 ${input.outNodeGroupId}`,
      {},
    );
  }

  /* ---------------- ② desired Tunnel = pending ---------------- */
  const created = await store.tunnel.create({
    data: {
      name: input.name,
      tunnel_type: protocol,
      // The compatibility create service admits product protocols before this
      // point. Keep legacy-only values uncanonicalized rather than relabeling them.
      forward_protocol: protocol,
      category: "port_forward",
      listen_ip: input.listenIp ?? null,
      listen_port: input.listenPort ?? null,
      listen_protocol: [protocol],
      status: "active",
      forward_addresses: [],
      load_balance_type: "round",
      ip_type: "ipv4",
      in_node_group_id: input.inNodeGroupId,
      out_node_group_id: input.outNodeGroupId,
      user_id: input.userId,
      workspace_id: input.workspaceId,
      tunnel_mode: "relay",
      desired_status: DESIRED_STATUS.inactive,
      apply_status: APPLY_STATUS.pending,
      config_revision: 0,
      applied_revision: null,
    },
  });
  const tunnelId = Number(created.id);
  steps.push({ step: "create_pending", ok: true, meta: { tunnel_id: tunnelId } });

  /* 从这里开始 Tunnel 行已存在：所有失败都要 persistFailure + 补偿。 */

  /* ---------------- ③ bind ingress / egress Node ---------------- */
  const [inCandidates, outCandidates] = await Promise.all([
    store.node.findMany({
      where: { node_group_id: input.inNodeGroupId },
      orderBy: { id: "asc" },
      // 取证地址要看入口**上报**的跳端点，所以候选查询必须带出上报。
      include: { state_report: { select: { tunnels: true } } },
    }),
    store.node.findMany({
      where: { node_group_id: input.outNodeGroupId },
      orderBy: { id: "asc" },
    }),
  ]);

  const ingressPick = pickNode(inCandidates as unknown as SchedulableNode[], "ingress", now);
  if (!ingressPick.ok) {
    return fail(
      "bind_nodes",
      ingressPick.reason === "no_credential"
        ? SCHEDULER_ERROR_CODES.node_credential_missing
        : SCHEDULER_ERROR_CODES.node_unavailable,
      ingressPick.reason === "no_credential"
        ? `入口节点组 ${input.inNodeGroupId} 内没有持有有效 per-node credential 的 ingress 节点（§3.3：身份不可验证的节点不可编排，请到 WP10 端点补签/轮换）`
        : `入口节点组 ${input.inNodeGroupId} 内没有 role 覆盖 ingress 的节点`,
      { tunnelId },
    );
  }
  const egressPick = pickNode(outCandidates as unknown as SchedulableNode[], "egress", now);
  if (!egressPick.ok) {
    return fail(
      "bind_nodes",
      egressPick.reason === "no_credential"
        ? SCHEDULER_ERROR_CODES.node_credential_missing
        : SCHEDULER_ERROR_CODES.node_unavailable,
      egressPick.reason === "no_credential"
        ? `出口节点组 ${input.outNodeGroupId} 内没有持有有效 per-node credential 的 egress 节点（§3.3：身份不可验证的节点不可编排，请到 WP10 端点补签/轮换）`
        : `出口节点组 ${input.outNodeGroupId} 内没有 role 覆盖 egress 的节点`,
      { tunnelId },
    );
  }
  if (ingressPick.node.id === egressPick.node.id) {
    // 同一物理节点不能同时当事例的两端：出口端口与入口端口会落在同一
    // (node_id, port) 唯一键上（§5.1），RELAY 的双跳也就退化成单跳。
    return fail(
      "bind_nodes",
      SCHEDULER_ERROR_CODES.mode_topology_mismatch,
      `入口与出口绑定到同一节点 ${ingressPick.node.id}（RELAY 必须跨节点）`,
      { tunnelId },
    );
  }

  /* 出口池：显式指定 → 必须存在且属于该出口节点；未指定 → 取 default。 */
  let poolId: number | null = input.egressPoolId ?? null;
  let pool: Record<string, unknown> | null = null;
  if (poolId !== null) {
    pool = await store.egressPool.findUnique({ where: { id: poolId } });
    if (!pool || Number(pool.node_id) !== egressPick.node.id) {
      return fail(
        "bind_nodes",
        SCHEDULER_ERROR_CODES.node_unavailable,
        `出口池 ${poolId} 不存在或不属于出口节点 ${egressPick.node.id}`,
        { tunnelId },
      );
    }
  } else {
    pool = await store.egressPool.findFirst({
      where: { node_id: egressPick.node.id, name: "default" },
    });
    if (pool) poolId = Number(pool.id);
  }

  if (!ingressPick.online || !egressPick.online) {
    // 只记 warning 不中断：心跳抖动不应阻断创建，ACK 超时才是硬失败。
    steps.push({
      step: "bind_nodes",
      ok: true,
      detail: "入口或出口节点心跳超时，仍按候选绑定",
      meta: {
        ingress_online: ingressPick.online,
        egress_online: egressPick.online,
      },
    });
  } else {
    steps.push({ step: "bind_nodes", ok: true });
  }

  /* ---------------- V5-WP1 runtime admission（下发前，零副作用） ---------------- */
  //
  // 位置是有意的：在端口租约产生**之前**、在 placements 落库**之前**。到这里
  // 两端节点已经确定，因此可以一次判完 ingress + egress；任何一端不满足就直接
  // 失败，不产生租约、不产生 runtime、不需要补偿。
  const admissionDenied = await admitBoundRuntime(
    deps,
    [
      { nodeId: ingressPick.node.id, role: "ingress" },
      { nodeId: egressPick.node.id, role: "egress" },
    ],
    protocol,
  );
  if (admissionDenied) {
    return fail("bind_nodes", SCHEDULER_ERROR_CODES.runtime_capability_denied, admissionFailureText(admissionDenied), {
      tunnelId,
      meta: {
        runtime_admission: {
          node_id: admissionDenied.node_id,
          node_role: admissionDenied.node_role,
          layer: admissionDenied.layer,
          reason: admissionDenied.reason,
        },
      },
    });
  }

  await store.tunnel.update({
    where: { id: tunnelId },
    data: {
      ingress_node_id: ingressPick.node.id,
      egress_node_id: egressPick.node.id,
      egress_pool_id: poolId,
      apply_status: APPLY_STATUS.applying,
    },
  });

  /* ---------------- ④ acquire ports ---------------- */
  // WP3 交接：同节点存量 DIRECT 的 listen_port 必须灌进 reservedPorts。
  // 只按 in/out 组取本组隧道的 listen_port 是**近似**防护：真正的 per-node
  // DIRECT 端口应按 bind 出来的 node_id 查。这里取组级是因为 legacy
  // port-allocator 就在组内分配（§7.6「LEGACY 交接」：两组作用域不同），
  // 而 Node 上的 v3 租约已由 acquirePort 的 DB 查询覆盖，不需要重复灌。
  const [inReserved, outReserved] = await Promise.all([
    store.tunnel.findMany({
      where: { in_node_group_id: input.inNodeGroupId },
      select: { id: true, listen_port: true },
    }),
    store.tunnel.findMany({
      where: { out_node_group_id: input.outNodeGroupId },
      select: { id: true, listen_port: true },
    }),
  ]);
  const ingressReserved = collectReservedPorts(
    (inReserved as { id: number; listen_port: number | null }[]).filter((t) => t.id !== tunnelId),
  );
  const egressReserved = collectReservedPorts(
    (outReserved as { id: number; listen_port: number | null }[]).filter((t) => t.id !== tunnelId),
  );

  const ingressAlloc = await allocateTunnelPort(
    {
      nodeId: ingressPick.node.id,
      direction: "ingress",
      preferred: input.listenPort ?? null,
      tunnelId,
      reservedPorts: ingressReserved,
    },
    deps.portPoolDeps,
  );
  if (!ingressAlloc.ok) {
    return fail("acquire_ports", ingressAlloc.code, ingressAlloc.detail, {
      tunnelId,
      meta: { direction: "ingress", port: ingressAlloc.port ?? null },
    });
  }

  const egressAlloc = await allocateTunnelPort(
    {
      nodeId: egressPick.node.id,
      direction: "egress",
      preferred: null, // 出口端口是节点间内部端口，永不接受用户指定
      tunnelId,
      reservedPorts: egressReserved,
    },
    deps.portPoolDeps,
  );
  if (!egressAlloc.ok) {
    // New Tunnel: no runtime exists yet, so releasing the single acquired lease
    // is safe. If that release cannot be confirmed, surface compensation_failed
    // instead of pretending the allocator is clean.
    const compensation = await compensateRuntimesThenRelease({
      tunnelId,
      orchestrator,
      removals: [],
      portPoolDeps: deps.portPoolDeps,
    });
    return fail(
      "acquire_ports",
      compensation.ok ? egressAlloc.code : SCHEDULER_ERROR_CODES.compensation_failed,
      compensation.ok
        ? `出口端口分配失败：${egressAlloc.detail}`
        : `出口端口分配失败：${egressAlloc.detail}；${compensation.error}`,
      {
        tunnelId,
        meta: { direction: "egress", ingress_port: ingressAlloc.port },
      },
    );
  }

  await store.tunnel.update({
    where: { id: tunnelId },
    data: {
      listen_port: ingressAlloc.port,
      egress_port: egressAlloc.port,
    },
  });
  steps.push({
    step: "acquire_ports",
    ok: true,
    meta: {
      ingress_port: ingressAlloc.port,
      ingress_lease_id: ingressAlloc.leaseId,
      egress_port: egressAlloc.port,
      egress_lease_id: egressAlloc.leaseId,
    },
  });

  /* ---------------- ⑤ revision++ ---------------- */
  // 从库里读当前 revision 再 +1：createRelayTunnel 可能被重入
  // （WP9 的重试 / WP11 的 re-apply），那时 revision 必须继续前进，
  // 否则 Agent 侧会把命令当 stale 拒掉（§3.2 硬规则 1）。
  const current = await store.tunnel.findUnique({
    where: { id: tunnelId },
    select: { config_revision: true },
  });
  // `let`：datagram 的取证纠正会把它抬一格（见下面的 correct_hop_peer）。
  let revision = (Number(current?.config_revision ?? 0) || 0) + 1;
  await store.tunnel.update({
    where: { id: tunnelId },
    data: { config_revision: revision, apply_status: APPLY_STATUS.applying },
  });
  steps.push({ step: "bump_revision", ok: true, meta: { revision } });

  /* ---------------- ⑥⑦ apply Egress → ACK ---------------- */
  const egressTargets =
    poolId !== null
      ? await store.egressTarget.findMany({
          where: { pool_id: poolId, status: "active" },
          orderBy: { order_by: "asc" },
        })
      : [];

  // 出口池里没有 active 目标 → 不能下发。WP6 的 validatePayload 会把
  // `targets: []` 当坏 payload 抛 TypeError；那是编码器错误，但在这里它的
  // 直接诱因是**数据问题**（池被停用/目标全下线）。编排器的契约是
  // 「只返回结构化的 CreateRelayFailure」，所以数据问题要在这里先拦下并
  // 落成 apply_egress 失败 —— 否则调用方收到的是一个 TypeError 而不是
  // Tunnel 记录上的 apply_status=error，排障时对不上号。
  if (poolId !== null && egressTargets.length === 0) {
    const compensation = await compensateRuntimesThenRelease({
      tunnelId,
      orchestrator,
      removals: [],
      portPoolDeps: deps.portPoolDeps,
    });
    const detail = `出口池 ${poolId} 下没有 active 目标（EgressTarget 全部下线或未配置）`;
    return fail(
      "apply_egress",
      compensation.ok
        ? SCHEDULER_ERROR_CODES.egress_apply_rejected
        : SCHEDULER_ERROR_CODES.compensation_failed,
      compensation.ok ? detail : `${detail}；${compensation.error}`,
      { tunnelId, revision },
    );
  }

  const egressDispatch = await orchestrator.dispatchEgress({
    tunnelId,
    revision,
    egressNode: egressPick.node,
    egressPort: egressAlloc.port,
    poolId,
    targets: egressTargets as { host: string; port: number; weight?: number; order_by?: number }[],
    // Pool policy overrides the node default; NULL inherits the node. This is
    // the same precedence startup restore uses in desiredTunnelConfigFor().
    lbStrategy: typeof pool?.lb_strategy === "string" ? pool.lb_strategy : egressPick.node.lb_strategy,
    protocol,
    // V5.1b WP5-B2: a datagram exit must be told who may feed it. This is the
    // same `connect_ip` the ingress leg uses for its `next_hop` — one hop, one
    // address, picked by the same helper.
    hopPeer: datagramHopPeerFor({
      // 入口**上报**的跳端点优先；没有上报（还没跑过一拍）才回落 connect_ip。
      ingressRuntimeId: Orchestrator.relayTunnelId(tunnelId),
      ingressConnectIp: ingressPick.node.connect_ip,
      ingressReportedTunnels: ingressPick.node.state_report?.tunnels,
    }),
  });
  if (!egressDispatch.ok) {
    // A failed/unknown dispatch may still have created the listener. Confirm a
    // higher-revision remove before releasing either port lease.
    const compensation = await compensateRuntimesThenRelease({
      tunnelId,
      orchestrator,
      removals: [
        {
          tunnelId,
          node: egressPick.node,
          direction: "egress",
          revision: revision + 1,
          reason: "egress apply failed",
        },
      ],
      portPoolDeps: deps.portPoolDeps,
    });
    return fail(
      "apply_egress",
      compensation.ok
        ? mapDispatchCode("egress", egressDispatch)
        : SCHEDULER_ERROR_CODES.compensation_failed,
      compensation.ok
        ? egressDispatch.error
        : `${egressDispatch.error}；${compensation.error}`,
      {
        tunnelId,
        revision,
        meta: { command_id: egressDispatch.commandId ?? null },
      },
    );
  }
  steps.push({
    step: "apply_egress",
    ok: true,
    meta: { command_id: egressDispatch.result.commandId, revision },
  });
  steps.push({
    step: "egress_ack",
    ok: true,
    meta: { applied_revision: egressDispatch.result.revision },
  });

  /* ---------------- V5-WP2 RuntimePlan（事实齐了之后的自检） ---------------- */
  //
  // 位置就是重点：RELAY 的 next_hop 只有出口 ACK 之后才存在（§1.3 铁律一），
  // 所以计划只能在这里成型。在此之前用 `protocol` 原值下发，从这里开始一律走
  // 计划——协议、传输、placement、listener、upstream 全部来自同一份纯计划，
  // 不再由各调用点各自拼一遍。
  //
  // 自检失败 = 我们即将下发一份自相矛盾的配置（例如 RELAY 却没有 next_hop）。
  // 那时出口已经 ACK，所以必须先补偿再失败，绝不让入口带着坏 hop 启动。
  const plan = buildForwardRuntimePlan("relay", protocol, {
    revision,
    placement: {
      ingress_node_id: ingressPick.node.id,
      egress_node_id: egressPick.node.id,
      egress_pool_id: poolId,
    },
    listener: { host: input.listenIp ?? null, port: ingressAlloc.port },
    upstream: {
      targets: (egressTargets as { host: string; port: number }[]).map((t) => ({
        host: t.host,
        port: t.port,
      })),
      next_hop: `${egressDispatch.egress_host}:${egressAlloc.port}`,
    },
  });
  const planViolations = forwardRuntimePlanViolations(plan);
  if (planViolations.length > 0) {
    // 注意：这是 `createRelayTunnel`（另一条编排），**不认识中间跳** —— 见 §9 里
    // "两条编排里只有一条认识中间跳"的记录。这里保留它原来的内联拆除，不做半套改动：
    // 把中间跳支持搬过来需要与 `reapplyRelayTunnel` 同等的一套（端口分配 + 中转腿 + 逆序拆除），
    // 而那属于"先确认它是否可达"之后的事。
    const compensation = await compensateRuntimesThenRelease({
      tunnelId,
      orchestrator,
      removals: [
        { tunnelId, node: egressPick.node, direction: "egress", revision: revision + 1, reason: "runtime plan invalid" },
      ],
      portPoolDeps: deps.portPoolDeps,
    });
    const compensationDetail = compensation.ok ? "" : `；${compensation.error}`;
    return fail(
      "apply_ingress",
      compensation.ok
        ? SCHEDULER_ERROR_CODES.invariant_violated
        : SCHEDULER_ERROR_CODES.compensation_failed,
      `RuntimePlan 自检未通过：${planViolations.join("; ")}${compensationDetail}`,
      { tunnelId, revision, meta: { runtime_plan_violations: planViolations } },
    );
  }

  /* ---------------- ⑧⑨ apply Ingress → ACK ---------------- */
  const ingressDispatch = await orchestrator.dispatchIngress({
    tunnelId,
    revision,
    ingressNode: ingressPick.node,
    ingressPort: ingressAlloc.port,
    nextHop: plan.upstream.next_hop as string,
    protocol: plan.protocol.name,
    ...tlsPathsFor(asRow<Record<string, unknown>>(created) as Record<string, unknown>, plan.protocol.name),
  });
  if (!ingressDispatch.ok) {
    // The ingress command was sent; timeout/invalid ACK is an UNKNOWN outcome,
    // not proof that no listener exists. Remove near→far, then release ports.
    const compensation = await compensateRuntimesThenRelease({
      tunnelId,
      orchestrator,
      removals: [
        { tunnelId, node: ingressPick.node, direction: "ingress", revision: revision + 1, reason: "ingress apply failed" },
        { tunnelId, node: egressPick.node, direction: "egress", revision: revision + 1, reason: "ingress apply failed" },
      ],
      portPoolDeps: deps.portPoolDeps,
    });
    const detail = compensation.ok
      ? ingressDispatch.error
      : `${ingressDispatch.error}；${compensation.error}`;
    return fail(
      "apply_ingress",
      compensation.ok
        ? mapDispatchCode("ingress", ingressDispatch)
        : SCHEDULER_ERROR_CODES.compensation_failed,
      detail,
      {
        tunnelId,
        revision,
        meta: { command_id: ingressDispatch.commandId ?? null },
      },
    );
  }
  steps.push({
    step: "apply_ingress",
    ok: true,
    meta: { command_id: ingressDispatch.result.commandId, revision },
  });
  steps.push({
    step: "ingress_ack",
    ok: true,
    meta: { applied_revision: ingressDispatch.result.revision },
  });

  const ingressAckHop = await correctDatagramHopPeerAfterIngressAck({
    tunnelId,
    revision,
    protocol,
    ingressAckHopLocalAddr: ingressDispatch.result.ack.hop_local_addr,
    connectIp: ingressPick.node.connect_ip,
    egressNode: egressPick.node,
    egressPort: egressAlloc.port,
    poolId,
    egressTargets: egressTargets as { host: string; port: number; weight?: number; order_by?: number }[],
    ingressNode: ingressPick.node,
    ingressPort: ingressAlloc.port,
    nextHop: plan.upstream.next_hop as string,
    tlsPaths: tlsPathsFor(asRow<Record<string, unknown>>(created) as Record<string, unknown>, plan.protocol.name) as Record<string, unknown>,
    orchestrator,
    store,
    deps,
  });
  if (!ingressAckHop.ok) {
    return fail("apply_ingress", SCHEDULER_ERROR_CODES.invariant_violated, ingressAckHop.error, {
      tunnelId,
      revision: ingressAckHop.revision,
      meta: { hop_peer: ingressAckHop.hopPeer },
    });
  }
  if (ingressAckHop.corrected) {
    revision = ingressAckHop.revision;
    steps.push({ step: "correct_hop_peer", ok: true, meta: { revision, hop_peer: ingressAckHop.hopPeer } });
  }

  /* ---------------- ⑩ active ---------------- */
  await persistSuccess(store, tunnelId, { revision, at: deps.now() });
  steps.push({ step: "activate", ok: true, meta: { revision } });

  return {
    ok: true,
    tunnelId,
    revision,
    ingressNodeId: ingressPick.node.id,
    egressNodeId: egressPick.node.id,
    ingressPort: ingressAlloc.port,
    egressPort: egressAlloc.port,
    runtimePlan: plan,
    steps,
  };
}

/* ================================================================== */
/* 重入：对已存在的 RELAY 隧道重新编排（WP11 retry / resume 用）        */
/* ================================================================== */

/**
 * 对一条**已存在**的 RELAY 隧道重新走一遍 §7.11 的 ③–⑩ 步。
 *
 * 为什么不是 `createRelayTunnel`：那条入口的 ② 是 `tunnel.create`——
 * 对已有行调用会产生第二条记录，而 retry 的语义（§4.1「失败时保留
 * Tunnel 并允许 Retry」）明确要求**同一条行**重新编排。因此这里从
 * 「行已在」开始：bind → ports → revision++ → 下发 → active。
 *
 * 为什么不在 WP11 自己写下发：§7.13「所有运行操作统一走 orchestrator，
 * 禁止 route 自己写第二套下发逻辑」。retry 与创建走的是同两个
 * `dispatchEgress` / `dispatchIngress` 调用（本函数内的代码与
 * `createRelayTunnel` 的 ⑥–⑨ 逐行同源），铁律一（先出口后入口）
 * 依然只有一处实现。
 *
 * revision 语义：从库里当前 `config_revision` +1。**不能复用旧值**——
 * Agent 的闸门是「applied_revision ≥ incoming 即拒 stale」，上一次失败
 * 已经推进过 applied_revision 的话，同 revision 重发会被直接拒掉，
 * retry 就静默失效了（这与 {@link Orchestrator.removeTunnel} 用
 * revision+1 是同一条理由）。
 *
 * 端口语义：`listen_port` / `egress_port` 已有值则**原样复用**（重试不
 * 换端口：§7.12 把 `change_port` 列为默认禁止的自动动作，用户手动
 * retry 更不该偷偷换端口）；为空才分配。
 *
 * @param tunnelId 已存在的 RELAY 隧道 id。
 * @param orchestrator 下发通道（与创建共用同一个实例：revision 闸门
 *        是进程级的，重建实例会让两端看到不同的账本）。
 * @param over 见 {@link SchedulerDeps}。
 */
/* `admittedPersistedProtocol` moved to forward-contract.ts (WP4/G0): every
   dispatch path needs the same answer, and two copies is how one path admits a
   fact another refuses. */
const admittedPersistedProtocol = admitPersistedProtocol;

async function checkExistingRuntime(
  row: Record<string, unknown>,
  deps: ReturnType<typeof resolveDeps>,
  selected?: { ingress: SchedulableNode; egress?: SchedulableNode },
  opts?: { federatedEgress?: boolean },
): Promise<RuntimeUseDenied | null> {
  // Concrete placements outrank the historical candidate-group columns. If a
  // Node has moved groups, retry must re-check its *new* scope before any write.
  const [ingress, egress] = selected
    ? [selected.ingress, selected.egress ?? null]
    : await Promise.all([
        row.ingress_node_id == null ? null : deps.db.node.findUnique({ where: { id: Number(row.ingress_node_id) } }),
        row.tunnel_mode !== "relay" || row.egress_node_id == null
          ? null : deps.db.node.findUnique({ where: { id: Number(row.egress_node_id) } }),
      ]);
  const validId = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
  const inGroup = ingress?.node_group_id ?? (row.ingress_node_id == null ? row.in_node_group_id : null);
  const outGroup = row.tunnel_mode === "relay"
    ? egress?.node_group_id ?? (row.egress_node_id == null ? row.out_node_group_id : null)
    : null;
  // V5.5 WP15：出口腿在远端时，本机没有出口节点组可判 —— 那一跳的容量与配额权威在
  // host（契约 §1 的 Quota authority 答案）。这里仍严格校验归属与入口侧，不是
  // "跳过授权"：入口缺失一样被拒。
  const egressScopeRequired = opts?.federatedEgress !== true;
  if (!validId(row.workspace_id) || !validId(row.user_id) || !validId(inGroup) ||
      (row.tunnel_mode === "relay" && egressScopeRequired && !validId(outGroup))) {
    return { code: "forbidden", reason: "scope_revoked", error_layer: "resource_scope", message: "转发归属或实际节点组已失效" };
  }
  const protocol = admittedPersistedProtocol(row);
  if (protocol === null) {
    return {
      code: "policy_denied",
      reason: "protocol_not_supported",
      error_layer: "capability",
      message: "该转发使用的历史协议尚未进入 V5 runtime 白名单",
    };
  }
  return deps.runtimeUse(row.workspace_id, {
    user_id: row.user_id, in_node_group_id: inGroup,
    out_node_group_id: egressScopeRequired && row.tunnel_mode === "relay" ? (outGroup as number | null) : null,
    protocol,
  });
}

async function recordRuntimeBlock(store: SchedulerDb, tunnelId: number, denied: RuntimeUseDenied) {
  const code = denied.code === "forbidden" ? SCHEDULER_ERROR_CODES.scope_revoked
    : denied.reason === "traffic_exhausted" ? SCHEDULER_ERROR_CODES.traffic_exhausted
      : SCHEDULER_ERROR_CODES.policy_denied;
  const detail = `[${denied.reason}:${denied.error_layer}] ${denied.message}`;
  // No desired/applied/revision mutation or release: blocking is not suspend.
  await store.tunnel.update({ where: { id: tunnelId }, data: {
    apply_status: APPLY_STATUS.error, apply_error_code: code, apply_error: detail.slice(0, 2000),
  } });
  return { code, detail };
}

export async function reapplyRelayTunnel(
  tunnelId: number,
  orchestrator: Orchestrator,
  over?: SchedulerDeps,
): Promise<CreateRelayTunnelResult> {
  const deps = resolveDeps(over);
  const store = deps.db;
  const now = deps.now();
  const steps: StepRecord[] = [];

  const fail = async (
    step: SchedulerStep,
    code: SchedulerErrorCode,
    detail: string,
    ctx: { revision?: number | null; meta?: Record<string, unknown> } = {},
  ): Promise<CreateRelayFailure> => {
    steps.push({ step, ok: false, error_code: code, detail, meta: ctx.meta });
    await persistFailure(store, tunnelId, { code, detail, revision: ctx.revision });
    return {
      ok: false,
      tunnelId,
      steps,
      failedStep: step,
      error_code: code,
      error: errorText(code, detail),
      retryable: isRetryable(code),
    };
  };

  const row = asRow<Record<string, unknown>>(
    await store.tunnel.findUnique({ where: { id: tunnelId } }),
  );
  if (!row) {
    return fail(
      "create_pending",
      SCHEDULER_ERROR_CODES.invariant_violated,
      `隧道 ${tunnelId} 不存在（重推前必须已落库）`,
    );
  }
  if (row.tunnel_mode !== "relay") {
    return fail(
      "bind_nodes",
      SCHEDULER_ERROR_CODES.mode_topology_mismatch,
      `隧道 ${tunnelId} 不是 RELAY 模式（${String(row.tunnel_mode)}）`,
    );
  }
  if (admittedPersistedProtocol(row) === null) {
    return fail(
      "auth_quota",
      SCHEDULER_ERROR_CODES.unsupported_protocol,
      `隧道 ${tunnelId} 的协议未通过当前 runtime Gate`,
    );
  }
  const inNodeGroupId = Number(row.in_node_group_id);
  const outNodeGroupId = row.out_node_group_id === null ? null : Number(row.out_node_group_id);

  // ── V5.5 WP15：出口腿在**远端** ⇒ 走联邦分支 ──
  //
  // 本机没有出口节点，因此**没有**出口节点组（声明了 peer 的行 out_node_group_id 为
  // NULL 是正确状态，不是"缺出口"）。这一跳不选点、不分配出口端口、不发
  // dispatchEgress；入口仍在本机，它的 next_hop 是 host 返回的地址（**不猜 IP**）。
  // 声明为 NULL 时一行都不进这里 —— 既有路径逐字节不变。
  const federatedPeer = normalizeFederatedEgressPeer((row as { federated_egress_peer?: unknown }).federated_egress_peer);
  if (federatedPeer !== null) {
    return applyFederatedRelayTunnel(tunnelId, orchestrator, deps, row, federatedPeer);
  }

  if (outNodeGroupId === null) {
    return fail(
      "bind_nodes",
      SCHEDULER_ERROR_CODES.mode_topology_mismatch,
      `RELAY 隧道 ${tunnelId} 没有出口节点组，无法重推`,
    );
  }


  const blockRuntimeUse = async (denied: RuntimeUseDenied): Promise<CreateRelayFailure> => {
    const { code, detail } = await recordRuntimeBlock(store, tunnelId, denied);
    steps.push({ step: "auth_quota", ok: false, error_code: code, detail });
    return { ok: false, tunnelId, steps, failedStep: "auth_quota", error_code: code, error: detail, retryable: false };
  };
  const denied = await checkExistingRuntime(row, deps);
  if (denied) return blockRuntimeUse(denied);
  steps.push({ step: "auth_quota", ok: true });
  steps.push({ step: "create_pending", ok: true, meta: { tunnel_id: tunnelId, reapply: true } });

  // Resolved once, used for admission, dispatch and the canonical fact written
  // back below: three places that must agree on which protocol this is.
  const reapplyProtocol = admittedPersistedProtocol(row) ?? DEFAULT_FORWARD_PROTOCOL;

  /* ---------------- ③ bind nodes ---------------- */
  const [inCandidatesRaw, outCandidatesRaw] = await Promise.all([
    store.node.findMany({
      where: { node_group_id: inNodeGroupId },
      orderBy: { id: "asc" },
      include: { state_report: { select: { tunnels: true } } },
    }),
    store.node.findMany({ where: { node_group_id: outNodeGroupId }, orderBy: { id: "asc" } }),
  ]);
  // Initial apply may schedule from the group. Once concrete placement exists,
  // retry/resume must stay on those exact Nodes: no silent migration on a
  // transient failure. Explicit topology changes are a separate user action.
  const boundIngressId = row.ingress_node_id == null ? null : Number(row.ingress_node_id);
  const boundEgressId = row.egress_node_id == null ? null : Number(row.egress_node_id);
  const inCandidates = (inCandidatesRaw as unknown as SchedulableNode[]).filter(
    (node) => boundIngressId === null || node.id === boundIngressId,
  );
  const outCandidates = (outCandidatesRaw as unknown as SchedulableNode[]).filter(
    (node) => boundEgressId === null || node.id === boundEgressId,
  );
  const ingressPick = pickNode(inCandidates, "ingress", now);
  if (!ingressPick.ok) {
    return fail(
      "bind_nodes",
      ingressPick.reason === "no_credential"
        ? SCHEDULER_ERROR_CODES.node_credential_missing
        : SCHEDULER_ERROR_CODES.node_unavailable,
      ingressPick.reason === "no_credential"
        ? `入口节点组 ${inNodeGroupId} 内没有持有有效 per-node credential 的 ingress 节点`
        : `入口节点组 ${inNodeGroupId} 内没有 role 覆盖 ingress 的节点`,
    );
  }
  const egressPick = pickNode(outCandidates as unknown as SchedulableNode[], "egress", now);
  if (!egressPick.ok) {
    return fail(
      "bind_nodes",
      egressPick.reason === "no_credential"
        ? SCHEDULER_ERROR_CODES.node_credential_missing
        : SCHEDULER_ERROR_CODES.node_unavailable,
      egressPick.reason === "no_credential"
        ? `出口节点组 ${outNodeGroupId} 内没有持有有效 per-node credential 的 egress 节点`
        : `出口节点组 ${outNodeGroupId} 内没有 role 覆盖 egress 的节点`,
    );
  }
  if (ingressPick.node.id === egressPick.node.id) {
    return fail(
      "bind_nodes",
      SCHEDULER_ERROR_CODES.mode_topology_mismatch,
      `入口与出口绑定到同一节点 ${ingressPick.node.id}（RELAY 必须跨节点）`,
    );
  }

  // 出口池：沿用行上的值；为空则取该出口节点的 default 池（§2.2）。
  let poolId = row.egress_pool_id === null ? null : Number(row.egress_pool_id);
  let pool: Record<string, unknown> | null = null;
  if (poolId !== null) {
    pool = await store.egressPool.findUnique({ where: { id: poolId } });
    if (!pool || Number((pool as { node_id: number }).node_id) !== egressPick.node.id) {
      return fail(
        "bind_nodes",
        SCHEDULER_ERROR_CODES.node_unavailable,
        `出口池 ${poolId} 不存在或不属于出口节点 ${egressPick.node.id}`,
      );
    }
  } else {
    pool = await store.egressPool.findFirst({
      where: { node_id: egressPick.node.id, name: "default" },
    });
    if (pool) poolId = Number((pool as { id: number }).id);
  }
  if (!ingressPick.online || !egressPick.online) {
    steps.push({
      step: "bind_nodes",
      ok: true,
      detail: "入口或出口节点心跳超时，仍按候选绑定",
      meta: { ingress_online: ingressPick.online, egress_online: egressPick.online },
    });
  } else {
    steps.push({ step: "bind_nodes", ok: true });
  }
  /* V5-WP1：重推走的是同一条 admission——重推不换节点，所以节点换过镜像
     （升级 / 回退）之后必须重新判一次，而不是沿用上一次的结论。 */
  const reapplyAdmissionDenied = await admitBoundRuntime(
    deps,
    [
      { nodeId: ingressPick.node.id, role: "ingress" },
      { nodeId: egressPick.node.id, role: "egress" },
    ],
    admittedPersistedProtocol(row) ?? DEFAULT_FORWARD_PROTOCOL,
  );
  if (reapplyAdmissionDenied) {
    return fail(
      "bind_nodes",
      SCHEDULER_ERROR_CODES.runtime_capability_denied,
      admissionFailureText(reapplyAdmissionDenied),
      {
      meta: {
        runtime_admission: {
          node_id: reapplyAdmissionDenied.node_id,
          node_role: reapplyAdmissionDenied.node_role,
          layer: reapplyAdmissionDenied.layer,
          reason: reapplyAdmissionDenied.reason,
        },
      },
    });
  }
  const targetDenied = await checkExistingRuntime(row, deps, { ingress: ingressPick.node, egress: egressPick.node });
  if (targetDenied) return blockRuntimeUse(targetDenied);
  await store.tunnel.update({
    where: { id: tunnelId },
    data: {
      ingress_node_id: ingressPick.node.id, egress_node_id: egressPick.node.id, egress_pool_id: poolId,
      apply_status: APPLY_STATUS.applying, desired_status: DESIRED_STATUS.inactive,
      // V5-WP1/G0: a Forward created before the protocol column existed carries
      // its fact only in `tunnel_type`. Re-orchestrating it is the moment the
      // canonical fact can be materialised, and leaving it NULL means every
      // later reader keeps falling back to the legacy column forever. The value
      // is the admitted protocol (admission already ran above), never a default.
      forward_protocol: reapplyProtocol,
    },
  });

  /* ---------------- ④ ports（已有值复用，空才分配）---------------- */
  const ingressReserved = collectReservedPorts(
    (
      await store.tunnel.findMany({
        where: { in_node_group_id: inNodeGroupId },
        select: { id: true, listen_port: true },
      })
    )
      .map((t) => t as { id: number; listen_port: number | null })
      .filter((t) => t.id !== tunnelId),
  );
  const egressReserved = collectReservedPorts(
    (
      await store.tunnel.findMany({
        where: { out_node_group_id: outNodeGroupId },
        select: { id: true, listen_port: true },
      })
    )
      .map((t) => t as { id: number; listen_port: number | null })
      .filter((t) => t.id !== tunnelId),
  );

  // Even when the Tunnel row already contains a port, the durable
  // NodePortLease may not exist yet (notably the create -> reapply path where
  // the user-specified ingress port is persisted before orchestration). Always
  // acquire with the existing port as `preferred`: acquirePort is idempotent
  // for an already-held same tunnel/direction lease and creates the missing
  // canonical ownership row otherwise.
  const existingIngressPort = row.listen_port === null ? null : Number(row.listen_port);
  const ingressAlloc = await allocateTunnelPort(
    {
      nodeId: ingressPick.node.id,
      direction: "ingress",
      preferred: existingIngressPort,
      tunnelId,
      reservedPorts: ingressReserved,
    },
    deps.portPoolDeps,
  );
  if (!ingressAlloc.ok) {
    return fail("acquire_ports", ingressAlloc.code, ingressAlloc.detail, {
      meta: { direction: "ingress", port: existingIngressPort },
    });
  }

  const existingEgressPort = row.egress_port === null ? null : Number(row.egress_port);
  const egressAlloc = await allocateTunnelPort(
    {
      nodeId: egressPick.node.id,
      direction: "egress",
      preferred: existingEgressPort,
      tunnelId,
      reservedPorts: egressReserved,
    },
    deps.portPoolDeps,
  );
  if (!egressAlloc.ok) {
    // Existing Tunnel: even a newly materialised lease may protect an old
    // listener on the persisted port. Keep ownership until a runtime teardown
    // is explicitly confirmed.
    return fail("acquire_ports", egressAlloc.code, `出口端口分配失败：${egressAlloc.detail}`, {
      meta: { direction: "egress", ingress_port: ingressAlloc.port, leases_retained: true },
    });
  }

  const ingressPort = ingressAlloc.port;
  const egressPort = egressAlloc.port;

  // ── V5.4：三跳路由的中间跳端口（唯一新增的分配）──
  //
  // 创建路径此前完全不认识 `middle_node_id`：它只发入口与出口两腿，中间跳没有任何 runtime，
  // 于是流量**绕过中间跳**走单跳路径 —— 客户端照样通，所以只看"通不通"永远发现不了
  // （实测：中间节点上报里 has_any=0 而客户端有数据）。创建路径是"知道中间跳"的第二条路。
  const middleNodeId = (row as { middle_node_id?: number | null }).middle_node_id ?? null;
  let middlePort: number | null = null;
  /** 中间跳的节点事实（发出去之后供 teardownDispatched 逆序拆除）。 */
  let transitNode: { id: number; node_id: string; connect_ip: string | null; role: "both" | "egress" | "ingress" | null } | null = null;
  if (middleNodeId != null) {
    const middleAlloc = await allocateTunnelPort(
      { nodeId: middleNodeId, direction: "egress", preferred: null, tunnelId, reservedPorts: [] },
      deps.portPoolDeps,
    );
    if (!middleAlloc.ok) {
      return fail("acquire_ports", middleAlloc.code, `中间跳端口分配失败：${middleAlloc.detail}`, {
        meta: { direction: "transit", middle_node_id: middleNodeId, leases_retained: true },
      });
    }
    middlePort = middleAlloc.port;
  }

  await store.tunnel.update({ where: { id: tunnelId }, data: { listen_port: ingressPort, egress_port: egressPort } });
  steps.push({
    step: "acquire_ports",
    ok: true,
    meta: {
      ingress_port: ingressPort,
      ingress_lease_id: ingressAlloc.leaseId,
      ingress_reused: ingressAlloc.reused,
      egress_port: egressPort,
      egress_lease_id: egressAlloc.leaseId,
      egress_reused: egressAlloc.reused,
    },
  });

  /* ---------------- ⑤ revision++ ---------------- */
  // 从库里读当前 revision 再 +1：上一次失败可能已推进 applied_revision，
  // 复用同值会被 Agent 的 stale 闸门拒掉，retry 就静默失效。
  const current = await store.tunnel.findUnique({ where: { id: tunnelId }, select: { config_revision: true } });
  // `let`：datagram 的取证纠正会把它抬一格（见 correctDatagramHopPeerAfterIngressAck）。
  let revision = (Number(current?.config_revision ?? 0) || 0) + 1;
  await store.tunnel.update({
    where: { id: tunnelId },
    data: { config_revision: revision, apply_status: APPLY_STATUS.applying },
  });
  steps.push({ step: "bump_revision", ok: true, meta: { revision } });

  /* ---------------- ⑥⑦ apply Egress → ACK ---------------- */
  const egressTargets =
    poolId !== null
      ? await store.egressTarget.findMany({ where: { pool_id: poolId, status: "active" }, orderBy: { order_by: "asc" } })
      : [];
  if (poolId !== null && egressTargets.length === 0) {
    return fail(
      "apply_egress",
      SCHEDULER_ERROR_CODES.egress_apply_rejected,
      `出口池 ${poolId} 下没有 active 目标（EgressTarget 全部下线或未配置）；现有端口租约保留给可能仍在运行的旧 runtime`,
      { revision, meta: { leases_retained: true } },
    );
  }

  const egressDispatch = await orchestrator.dispatchEgress({
    tunnelId,
    revision,
    egressNode: egressPick.node,
    egressPort,
    poolId,
    targets: egressTargets as { host: string; port: number; weight?: number; order_by?: number }[],
    // retry/resume must not reset a weighted/random pool to round-robin.
    lbStrategy: typeof pool?.lb_strategy === "string" ? pool.lb_strategy : egressPick.node.lb_strategy,
    protocol: reapplyProtocol,
    // V5.1b WP5-B2: the SAME fact the create path passes (a datagram exit attests its
    // ingress, and the hop has no handshake to imply it). This site was missed on the
    // first pass — Gate V5-G1B caught it as `egress_apply_rejected … hop_peer`, which is
    // exactly what the orchestrator's fail-closed check is for. `reapplyRelayTunnel` is
    // the SECOND delivery path for an egress leg; a fact that only one of them carries
    // is a fact that works until the day the other one runs.
    hopPeer: datagramHopPeerFor({
      // 入口**上报**的跳端点优先；没有上报（还没跑过一拍）才回落 connect_ip。
      ingressRuntimeId: Orchestrator.relayTunnelId(tunnelId),
      ingressConnectIp: ingressPick.node.connect_ip,
      ingressReportedTunnels: ingressPick.node.state_report?.tunnels,
    }),
  });
  if (!egressDispatch.ok) {
    // Unknown dispatch outcome: do not free ports under a possibly-live old/new
    // runtime. Reconciler sees desired=inactive + apply=error and owns the later
    // runtime cleanup; the lease remains the collision barrier until then.
    return fail(
      "apply_egress",
      mapDispatchCode("egress", egressDispatch),
      `${egressDispatch.error}；端口租约保留，等待 runtime 对账确认后回收`,
      {
        revision,
        meta: { command_id: egressDispatch.commandId ?? null, leases_retained: true },
      },
    );
  }
  steps.push({ step: "apply_egress", ok: true, meta: { command_id: egressDispatch.result.commandId, revision } });
  steps.push({ step: "egress_ack", ok: true, meta: { applied_revision: egressDispatch.result.revision } });

  /**
   * 撤掉本次**已经发出去**的腿，逆序（先中间、后出口），并释放端口租约。
   *
   * 为什么要收敛成一个函数：这条路径原先在每个失败分支里各写一次 `removeTunnel(egress)`，
   * 而 V5.4 新增了"中间跳"这条腿之后，**没有任何一个分支记得撤它** —— 实测症状是
   * Agent 侧留下端口守卫（`port 22001 is already used by another tunnel`），DB 租约却已释放，
   * 于是下一次分配又选中同一个端口、被 Agent 正确地拒绝，看起来像"端口分配有 bug"。
   *
   * 一个失败分支漏撤一条腿 = 一次永久性资源泄漏，而泄漏只在**下一次**创建时才显形。
   * 所以它必须是一处、且必须逆序（正向先远后近 ⇒ 拆除先近后远）。
   */
  const teardownDispatched = async (reason: string): Promise<string | null> => {
    const removals: CompensationRemoval[] = [
      {
        tunnelId,
        node: ingressPick.node,
        direction: "ingress",
        revision: revision + 1,
        reason: `${reason} (ingress)`,
      },
    ];
    if (transitNode != null) {
      removals.push({
        tunnelId,
        node: transitNode,
        direction: "egress",
        revision: revision + 1,
        reason: `${reason} (transit)`,
      });
    }
    removals.push({
      tunnelId,
      node: egressPick.node,
      direction: "egress",
      revision: revision + 1,
      reason,
    });
    const compensation = await compensateRuntimesThenRelease({
      tunnelId,
      orchestrator,
      removals,
      portPoolDeps: deps.portPoolDeps,
    });
    return compensation.ok ? null : compensation.error;
  };

  // ── V5.4：中间跳（若有）──
  //
  // 与 rollout 路径**共用同一份实现**（`Orchestrator.dispatchTransit`）：编排可以有两处，
  // 但"怎么发一条中间跳"只能有一处 —— 否则两条路径会在某次改动后悄悄分叉。
  //
  // 正向顺序仍是**先远后近**：出口已发 → 现在发中间跳（目标 = 出口）→ 最后才切入口（目标 = 中间跳）。
  let transitHost: string | null = null;
  if (middleNodeId != null && middlePort != null) {
    // 中间跳**不是调度候选**：候选按节点组筛（`inNodeGroupId` / `outNodeGroupId`），而中间跳是
    // 用户显式选定的放置事实，通常属于**第三个**节点组 —— 从候选列表里找它永远找不到。
    // 实测后果：`apply_transit` 报 `invariant_violated`（"中间跳节点不存在"），而出口腿已经发出去了。
    // 所以直接按 id 读它，和"绑定后的入出口必须落在指定节点"是同一口径：**已确定的放置事实不参与重新调度**。
    const middleNode = (await store.node.findUnique({ where: { id: middleNodeId } })) as
      | SchedulableNode
      | null;
    if (!middleNode) {
      const compensationError = await teardownDispatched("middle node missing");
      const detail = `中间跳节点 ${middleNodeId} 不存在${compensationError ? `；${compensationError}` : ""}`;
      return fail(
        "apply_transit",
        compensationError
          ? SCHEDULER_ERROR_CODES.compensation_failed
          : SCHEDULER_ERROR_CODES.invariant_violated,
        detail,
        { revision },
      );
    }
    const transit = await orchestrator.dispatchTransit({
      tunnelId,
      revision,
      node: {
        id: middleNode.id,
        node_id: String(middleNode.node_id ?? middleNode.id),
        connect_ip: (middleNode.connect_ip as string | null) ?? null,
        role: (middleNode.role as "both" | "egress" | "ingress" | null) ?? null,
      },
      port: middlePort,
      nextHop: `${egressDispatch.egress_host}:${egressPort}`,
      protocol: reapplyProtocol,
    });
    if (!transit.ok) {
      const compensationError = await teardownDispatched("transit apply failed");
      const detail = compensationError ? `${transit.error}；${compensationError}` : transit.error;
      return fail(
        "apply_transit",
        compensationError
          ? SCHEDULER_ERROR_CODES.compensation_failed
          : mapDispatchCode("egress", transit),
        detail,
        { revision },
      );
    }
    transitHost = transit.host;
    transitNode = {
      id: middleNode.id,
      node_id: String(middleNode.node_id ?? middleNode.id),
      connect_ip: (middleNode.connect_ip as string | null) ?? null,
      role: (middleNode.role as "both" | "egress" | "ingress" | null) ?? null,
    };
    steps.push({ step: "apply_transit", ok: true, meta: { middle_node_id: middleNodeId, port: middlePort } });
  }

  /* ---------------- V5-WP2 RuntimePlan 自检（与创建路径同源） ---------------- */
  const plan = buildForwardRuntimePlan("relay", reapplyProtocol, {
    revision,
    placement: {
      ingress_node_id: ingressPick.node.id,
      egress_node_id: egressPick.node.id,
      egress_pool_id: poolId,
    },
    listener: { host: typeof row.listen_ip === "string" ? row.listen_ip : null, port: ingressPort },
    upstream: {
      targets: (egressTargets as { host: string; port: number }[]).map((t) => ({
        host: t.host,
        port: t.port,
      })),
      // 三跳时入口的下一跳是**中间跳**，不是出口 —— 这正是 V5.4 之前这里会错的地方。
      next_hop:
        transitHost != null && middlePort != null
          ? `${transitHost}:${middlePort}`
          : `${egressDispatch.egress_host}:${egressPort}`,
    },
  });
  const planViolations = forwardRuntimePlanViolations(plan);
  if (planViolations.length > 0) {
    const compensationError = await teardownDispatched("runtime plan invalid");
    const detail = `RuntimePlan 自检未通过：${planViolations.join("; ")}${compensationError ? `；${compensationError}` : ""}`;
    return fail(
      "apply_ingress",
      compensationError
        ? SCHEDULER_ERROR_CODES.compensation_failed
        : SCHEDULER_ERROR_CODES.invariant_violated,
      detail,
      { revision, meta: { runtime_plan_violations: planViolations } },
    );
  }

  /* ---------------- ⑧⑨ apply Ingress → ACK ---------------- */
  const ingressDispatch = await orchestrator.dispatchIngress({
    tunnelId,
    revision,
    ingressNode: ingressPick.node,
    ingressPort,
    nextHop: plan.upstream.next_hop as string,
    protocol: plan.protocol.name,
    ...tlsPathsFor(row, plan.protocol.name),
  });
  if (!ingressDispatch.ok) {
    const compensationError = await teardownDispatched("ingress apply failed");
    const detail = compensationError ? `${ingressDispatch.error}；${compensationError}` : ingressDispatch.error;
    return fail(
      "apply_ingress",
      compensationError
        ? SCHEDULER_ERROR_CODES.compensation_failed
        : mapDispatchCode("ingress", ingressDispatch),
      detail,
      {
        revision,
        meta: { command_id: ingressDispatch.commandId ?? null },
      },
    );
  }
  steps.push({ step: "apply_ingress", ok: true, meta: { command_id: ingressDispatch.result.commandId, revision } });
  steps.push({ step: "ingress_ack", ok: true, meta: { applied_revision: ingressDispatch.result.revision } });

  // V5.1b WP5-B2：前向 API 的**创建**走的就是这条路径（`forward-service` → `reapplyRelayTunnel`），
  // 所以纠正必须在这里也接上——第一版只接了 `createRelayTunnel`，真拓扑上一次都没触发。
  const ingressAckHop = await correctDatagramHopPeerAfterIngressAck({
    tunnelId,
    revision,
    protocol: reapplyProtocol,
    ingressAckHopLocalAddr: ingressDispatch.result.ack.hop_local_addr,
    connectIp: ingressPick.node.connect_ip,
    egressNode: egressPick.node,
    egressPort,
    poolId,
    egressTargets: egressTargets as { host: string; port: number; weight?: number; order_by?: number }[],
    ingressNode: ingressPick.node,
    ingressPort,
    nextHop: plan.upstream.next_hop as string,
    tlsPaths: tlsPathsFor(row, plan.protocol.name) as Record<string, unknown>,
    orchestrator,
    store,
    deps,
  });
  if (!ingressAckHop.ok) {
    // correctDatagramHopPeerAfterIngressAck already performed fail-closed
    // compensation at correctedRevision + 1. Repeating teardown here would use
    // this closure's older revision and can itself be rejected as stale.
    // 注意：reapply 的 `fail()` 只收 `{ revision, meta }`（tunnelId 是它的第一个参数所隐含的），
    // 与 create 的那份签名不同 —— 照抄 create 的调用形状会被 tsc 拦住。
    return fail("apply_ingress", SCHEDULER_ERROR_CODES.invariant_violated, ingressAckHop.error, {
      revision: ingressAckHop.revision,
      meta: { hop_peer: ingressAckHop.hopPeer },
    });
  }
  if (ingressAckHop.corrected) {
    revision = ingressAckHop.revision;
    steps.push({ step: "correct_hop_peer", ok: true, meta: { revision, hop_peer: ingressAckHop.hopPeer } });
  }

  /* ---------------- ⑩ active ---------------- */
  await persistSuccess(store, tunnelId, { revision, at: deps.now() });
  steps.push({ step: "activate", ok: true, meta: { revision } });

  return {
    ok: true,
    tunnelId,
    revision,
    ingressNodeId: ingressPick.node.id,
    egressNodeId: egressPick.node.id,
    ingressPort,
    egressPort,
    steps,
  };
}

/**
 * V5.5 WP15 —— 出口腿在**远端**的 RELAY 编排（创建 / 重试用同一入口）。
 *
 * 与 {@link reapplyRelayTunnel} 的关系：**正向顺序、失败补偿、幂等口径完全相同**，
 * 唯一的差别是"出口那一跳由谁建"——
 *   本地：bind 出口节点 → 分配 egress 端口 → `dispatchEgress`；
 *   远端：`delegateFederatedEgress`（reserve → apply → 镜像行），地址取 host 的返回值。
 *
 * 为什么不把它塞进 `reapplyRelayTunnel` 的中间：那条函数 480 行、出口腿的节点 id
 * 出现在十几处分支里，逐处加 `if` 才是真正会把 NULL 路径改坏的做法。这里是一个
 * **独立入口 + 单点分派**，声明为 NULL 的行永远走原函数、一行都不经过这里。
 */
async function applyFederatedRelayTunnel(
  tunnelId: number,
  orchestrator: Orchestrator,
  deps: ReturnType<typeof resolveDeps>,
  row: Record<string, unknown>,
  peerPanelId: string,
): Promise<CreateRelayTunnelResult> {
  const store = deps.db;
  const now = deps.now();
  const steps: StepRecord[] = [];

  const fail = async (
    step: SchedulerStep,
    code: SchedulerErrorCode,
    detail: string,
    ctx: { revision?: number | null; meta?: Record<string, unknown> } = {},
  ): Promise<CreateRelayFailure> => {
    steps.push({ step, ok: false, error_code: code, detail, meta: ctx.meta });
    await persistFailure(store, tunnelId, { code, detail, revision: ctx.revision });
    return { ok: false, tunnelId, steps, failedStep: step, error_code: code, error: errorText(code, detail), retryable: isRetryable(code) };
  };

  const inNodeGroupId = Number(row.in_node_group_id);
  const protocol = admittedPersistedProtocol(row) ?? DEFAULT_FORWARD_PROTOCOL;
  const targetHost = typeof row.remote_host === "string" && row.remote_host.length > 0 ? row.remote_host : null;
  const targetPort = row.remote_port == null ? null : Number(row.remote_port);
  const middleNodeId = (row as { middle_node_id?: number | null }).middle_node_id ?? null;
  const boundIngressId = row.ingress_node_id == null ? null : Number(row.ingress_node_id);

  // ── ① 拓扑自检（与 rollout 注册时**同一份**判定，不在这里重写）──
  //
  // 契约 §9：第一阶段只允许"一个远端 hop，且必须在 egress"。远端 ingress/transit、
  // 3+ 跳、tls（需要节点本地证书）都在这里 fail-closed，而且发生在**任何副作用之前**。
  const topology = checkFederatedEgressTopology(
    {
      tunnelId,
      revision: Number(row.config_revision ?? 0) + 1,
      mode: "relay",
      ingress_node_id: boundIngressId,
      local_egress_node_id: row.egress_node_id == null ? null : Number(row.egress_node_id),
      middle_node_id: middleNodeId,
      protocol,
    },
    peerPanelId,
  );
  if (!topology.ok) {
    return fail("bind_nodes", SCHEDULER_ERROR_CODES.invariant_violated, `远端出口腿不可用：${topology.message}`);
  }
  if (targetHost === null || targetPort === null) {
    return fail("bind_nodes", SCHEDULER_ERROR_CODES.invalid_target, "远端出口腿必须至少有一个目标（host + port）");
  }

  const blockRuntimeUse = async (denied: RuntimeUseDenied): Promise<CreateRelayFailure> => {
    const { code, detail } = await recordRuntimeBlock(store, tunnelId, denied);
    steps.push({ step: "auth_quota", ok: false, error_code: code, detail });
    return { ok: false, tunnelId, steps, failedStep: "auth_quota", error_code: code, error: detail, retryable: false };
  };
  const denied = await checkExistingRuntime(row, deps, undefined, { federatedEgress: true });
  if (denied) return blockRuntimeUse(denied);
  steps.push({ step: "auth_quota", ok: true });
  steps.push({ step: "create_pending", ok: true, meta: { tunnel_id: tunnelId, reapply: true, federated_egress_peer: peerPanelId } });

  // ── ② 入口选点（本机，与既有路径同一条候选过滤）──
  const inCandidates = (await store.node.findMany({
    where: { node_group_id: inNodeGroupId },
    orderBy: { id: "asc" },
  })) as unknown as SchedulableNode[];
  const ingressCandidates = inCandidates.filter((node) => boundIngressId === null || node.id === boundIngressId);
  const ingressPick = pickNode(ingressCandidates, "ingress", now);
  if (!ingressPick.ok) {
    return fail(
      "bind_nodes",
      ingressPick.reason === "no_credential"
        ? SCHEDULER_ERROR_CODES.node_credential_missing
        : SCHEDULER_ERROR_CODES.node_unavailable,
      ingressPick.reason === "no_credential"
        ? `入口节点组 ${inNodeGroupId} 内没有持有有效 per-node credential 的 ingress 节点`
        : `入口节点组 ${inNodeGroupId} 内没有 role 覆盖 ingress 的节点`,
    );
  }
  // 入口的 runtime admission 照旧（出口那一跳的准入在 host 侧，由 grant 决定）。
  const admissionDenied = await admitBoundRuntime(deps, [{ nodeId: ingressPick.node.id, role: "ingress" }], protocol);
  if (admissionDenied) {
    return fail("bind_nodes", SCHEDULER_ERROR_CODES.runtime_capability_denied, admissionFailureText(admissionDenied), {
      meta: {
        runtime_admission: {
          node_id: admissionDenied.node_id,
          node_role: admissionDenied.node_role,
          layer: admissionDenied.layer,
          reason: admissionDenied.reason,
        },
      },
    });
  }
  const targetDenied = await checkExistingRuntime(row, deps, { ingress: ingressPick.node }, { federatedEgress: true });
  if (targetDenied) return blockRuntimeUse(targetDenied);
  steps.push({ step: "bind_nodes", ok: true });

  await store.tunnel.update({
    where: { id: tunnelId },
    data: {
      ingress_node_id: ingressPick.node.id,
      // 出口在本机**不存在**：清掉遗留的本地出口投影，避免任何读取方把它当成一条
      // 本地腿（远端资源只以 federation_placement 的不透明引用存在）。
      egress_node_id: null,
      egress_pool_id: null,
      egress_port: null,
      apply_status: APPLY_STATUS.applying,
      desired_status: DESIRED_STATUS.inactive,
      forward_protocol: protocol,
    },
  });

  // ── ③ 端口：只分配**入口**端口（出口端口归 host 的 portPool，契约 §1.5）──
  const ingressReserved = collectReservedPorts(
    (
      await store.tunnel.findMany({
        where: { in_node_group_id: inNodeGroupId },
        select: { id: true, listen_port: true },
      })
    )
      .map((t) => t as { id: number; listen_port: number | null })
      .filter((t) => t.id !== tunnelId),
  );
  const existingIngressPort = row.listen_port === null ? null : Number(row.listen_port);
  const ingressAlloc = await allocateTunnelPort(
    {
      nodeId: ingressPick.node.id,
      direction: "ingress",
      preferred: existingIngressPort,
      tunnelId,
      reservedPorts: ingressReserved,
    },
    deps.portPoolDeps,
  );
  if (!ingressAlloc.ok) {
    return fail("acquire_ports", ingressAlloc.code, ingressAlloc.detail, {
      meta: { direction: "ingress", port: existingIngressPort },
    });
  }
  const ingressPort = ingressAlloc.port;
  await store.tunnel.update({ where: { id: tunnelId }, data: { listen_port: ingressPort, egress_port: null } });
  steps.push({
    step: "acquire_ports",
    ok: true,
    meta: { ingress_port: ingressPort, ingress_lease_id: ingressAlloc.leaseId, egress_port: null, egress_owner: "peer" },
  });

  // ── ④ revision++ ──
  const current = await store.tunnel.findUnique({ where: { id: tunnelId }, select: { config_revision: true } });
  const revision = (Number(current?.config_revision ?? 0) || 0) + 1;
  await store.tunnel.update({ where: { id: tunnelId }, data: { config_revision: revision, apply_status: APPLY_STATUS.applying } });
  steps.push({ step: "bump_revision", ok: true, meta: { revision } });

  /** 本次委托拿到的远端租约（撤它的时候要用同一个键）。 */
  let remoteLeaseRef: string | null = null;

  /**
   * Fail-closed teardown for the federated reapply path.
   *
   * The local ingress may be an OLD runtime that was still serving when this
   * retry started. Releasing its NodePortLease without first confirming the
   * listener is gone lets the allocator hand a live port to another Forward.
   * Stop the near side first, then release its lease; remote cleanup is tracked
   * independently but any uncertainty is returned to the caller.
   */
  const teardown = async (reason: string): Promise<{ ok: true } | { ok: false; error: string }> => {
    const errors: string[] = [];
    let ingressRemoved = false;
    try {
      const removed = await orchestrator.removeTunnel({
        tunnelId,
        node: ingressPick.node,
        direction: "ingress",
        revision: revision + 1,
        reason,
      });
      if (removed.ok) ingressRemoved = true;
      else errors.push(`ingress runtime: ${removed.error}`);
    } catch (error) {
      errors.push(
        `ingress runtime: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (ingressRemoved) {
      try {
        await releaseLease({ tunnelId }, deps.portPoolDeps);
      } catch (error) {
        errors.push(
          `local port lease: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (remoteLeaseRef !== null) {
      try {
        const released = await releaseFederatedEgress(
          { tunnelId, revision, peer_panel_id: peerPanelId, lease_ref: remoteLeaseRef },
          { sender: deps.federatedSender, now: deps.now },
        );
        if (!released.ok) {
          errors.push(
            `remote egress: ${released.code ?? "internal_error"} ${released.message ?? ""}`.trim(),
          );
        }
      } catch (error) {
        errors.push(
          `remote egress: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return errors.length === 0
      ? { ok: true }
      : { ok: false, error: errors.join("; ") };
  };

  const failAfterTeardown = async (
    step: SchedulerStep,
    originalCode: SchedulerErrorCode,
    detail: string,
    reason: string,
    ctx: { revision?: number | null; meta?: Record<string, unknown> } = {},
  ): Promise<CreateRelayFailure> => {
    const cleanup = await teardown(reason);
    return fail(
      step,
      cleanup.ok ? originalCode : SCHEDULER_ERROR_CODES.compensation_failed,
      cleanup.ok ? detail : `${detail}；补偿未确认：${cleanup.error}`,
      ctx,
    );
  };

  // ── ⑤ 远端出口腿：先把**上一代**的腿收掉，再委托这一代 ──
  //
  // 每次创建/重试都会 bump revision，而 intent_id = fw-<tunnelId>-<revision> ⇒ 在
  // host 侧那是一条**新**租约。不先收掉旧的，每次重试都会在对面的面板上留下一条
  // 继续监听的孤儿 runtime + 一个被占的端口（G4 的同族泄漏，且本机看不见）。
  let stale: Awaited<ReturnType<typeof releaseStaleFederatedEgressForTunnel>>;
  try {
    stale = await releaseStaleFederatedEgressForTunnel(tunnelId, revision, {
      sender: deps.federatedSender,
      now: deps.now,
    });
  } catch (error) {
    return failAfterTeardown(
      "apply_egress",
      SCHEDULER_ERROR_CODES.compensation_failed,
      `无法确认上一代远端腿是否已释放：${error instanceof Error ? error.message : String(error)}`,
      "stale remote egress lookup failed",
      { revision, meta: { stale_release_lookup_failed: true } },
    );
  }
  if (stale.failed.length > 0) {
    // Creating the new generation now would knowingly permit two remote
    // runtimes/ports for the same Forward. Stop the local ingress and keep the
    // failure durable; do not delegate this revision yet.
    return failAfterTeardown(
      "apply_egress",
      SCHEDULER_ERROR_CODES.compensation_failed,
      `上一代远端腿释放未确认：${stale.failed.map((f) => `${f.intent_id}(${f.code})`).join(", ")}`,
      "stale remote egress release unconfirmed",
      { revision, meta: { stale_release_failed: stale.failed.length } },
    );
  }
  const delegated = await delegateFederatedEgress(    {
      tunnelId,
      revision,
      declaredPeer: peerPanelId,
      mode: "relay",
      ingress_node_id: ingressPick.node.id,
      local_egress_node_id: null,
      middle_node_id: null,
      protocol,
      targets: [{ host: targetHost, port: targetPort, weight: 1, order_by: 1000 }],
    },
    { sender: deps.federatedSender, now: deps.now },
  );
  if (!delegated.ok) {
    // A failed delegate may still have created a remote lease before the failure
    // became known. Carry that ref into teardown so we make one more idempotent
    // release attempt instead of relying on the delegate's best effort alone.
    remoteLeaseRef = delegated.lease_ref;
    return failAfterTeardown(
      "apply_egress",
      delegated.code === "peer_unreachable"
        ? SCHEDULER_ERROR_CODES.egress_ack_failed
        : SCHEDULER_ERROR_CODES.egress_apply_rejected,
      `远端出口腿（peer=${peerPanelId}）建立失败：${delegated.message}`,
      "remote egress delegation failed",
      { revision, meta: { federation_code: delegated.code, lease_ref: delegated.lease_ref } },
    );
  }
  remoteLeaseRef = delegated.lease_ref;
  steps.push({
    step: "apply_egress",
    ok: true,
    detail: `远端出口：peer=${peerPanelId} lease=${delegated.lease_ref} epoch=${delegated.lease_epoch}`,
    meta: { command_id: null, revision, peer_panel_id: peerPanelId },
  });
  steps.push({ step: "egress_ack", ok: true, meta: { applied_revision: delegated.applied_revision } });

  // ── ⑥ 入口：next_hop 只能是 host 返回的地址（**不猜 IP**）──
  if (delegated.next_hop === null) {
    return failAfterTeardown(
      "apply_ingress",
      SCHEDULER_ERROR_CODES.invariant_violated,
      `远端出口 ${peerPanelId} 未返回可寻址的 node_address，拒绝用猜测的地址启动入口`,
      "remote egress has no addressable host",
      { revision },
    );
  }
  const ingressDispatch = await orchestrator.dispatchIngress({
    tunnelId,
    revision,
    ingressNode: ingressPick.node,
    ingressPort,
    nextHop: delegated.next_hop,
    protocol,
    ...tlsPathsFor(row, protocol),
  });
  if (!ingressDispatch.ok) {
    return failAfterTeardown(
      "apply_ingress",
      mapDispatchCode("ingress", ingressDispatch),
      ingressDispatch.error,
      "ingress apply failed",
      {
        revision,
        meta: { command_id: ingressDispatch.commandId ?? null },
      },
    );
  }
  steps.push({ step: "apply_ingress", ok: true, meta: { command_id: ingressDispatch.result.commandId, revision } });
  steps.push({ step: "ingress_ack", ok: true, meta: { applied_revision: ingressDispatch.result.revision } });

  // ── ⑦ active ──
  await persistSuccess(store, tunnelId, { revision, at: deps.now() });
  steps.push({ step: "activate", ok: true, meta: { revision } });

  return {
    ok: true,
    tunnelId,
    revision,
    ingressNodeId: ingressPick.node.id,
    // 本机没有出口节点：如实返回 null（不是 0，也不是占位 id —— 占位只存在于
    // 计划里，绝不能流到 API/UI 层被当成一台真节点）。
    egressNodeId: null,
    ingressPort,
    egressPort: null,
    steps,
  };
}

export type ApplyDirectResult =
  | {
      ok: true;
      tunnelId: number;
      revision: number;
      ingressNodeId: number;
      ingressPort: number;
    }
  | {
      ok: false;
      tunnelId: number;
      error_code: SchedulerErrorCode;
      error: string;
      retryable: boolean;
    };

/**
 * Apply/re-apply one existing DIRECT tunnel through the v3 runtime.
 *
 * Placement rule: once ingress_node_id exists, retry sticks to that concrete
 * Node. A retry must not silently migrate a user's tunnel.
 */
export async function reapplyDirectTunnel(
  tunnelId: number,
  orchestrator: Orchestrator,
  over?: SchedulerDeps,
): Promise<ApplyDirectResult> {
  const deps = resolveDeps(over);
  const store = deps.db;
  const now = deps.now();

  const row = asRow<Record<string, unknown>>(await store.tunnel.findUnique({ where: { id: tunnelId } }));
  if (!row) {
    return {
      ok: false,
      tunnelId,
      error_code: SCHEDULER_ERROR_CODES.invariant_violated,
      error: `隧道 ${tunnelId} 不存在`,
      retryable: false,
    };
  }
  if (row.tunnel_mode !== "direct") {
    return {
      ok: false,
      tunnelId,
      error_code: SCHEDULER_ERROR_CODES.mode_topology_mismatch,
      error: `隧道 ${tunnelId} 不是 DIRECT 模式`,
      retryable: false,
    };
  }
  if (admittedPersistedProtocol(row) === null) {
    const code = SCHEDULER_ERROR_CODES.unsupported_protocol;
    await store.tunnel.update({
      where: { id: tunnelId },
      data: {
        apply_status: APPLY_STATUS.error,
        apply_error_code: code,
        apply_error: `[${code}] 协议未通过当前 runtime Gate`,
      },
    });
    return {
      ok: false,
      tunnelId,
      error_code: code,
      error: "协议未通过当前 runtime Gate",
      retryable: false,
    };
  }

  const blockRuntimeUse = async (denied: RuntimeUseDenied): Promise<ApplyDirectResult> => {
    const { code, detail } = await recordRuntimeBlock(store, tunnelId, denied);
    return { ok: false, tunnelId, error_code: code, error: detail, retryable: false };
  };
  const denied = await checkExistingRuntime(row, deps);
  if (denied) return blockRuntimeUse(denied);

  const inNodeGroupId = Number(row.in_node_group_id);
  const candidates = await store.node.findMany({
    where: { node_group_id: inNodeGroupId },
    orderBy: { id: "asc" },
  }) as unknown as SchedulableNode[];

  let pick:
    | { ok: true; node: SchedulableNode; online: boolean }
    | { ok: false; reason: "no_role_match" | "no_credential" };

  const boundId = row.ingress_node_id == null ? null : Number(row.ingress_node_id);
  if (boundId !== null) {
    const bound = candidates.find((n) => n.id === boundId);
    pick = bound
      ? pickNode([bound], "ingress", now)
      : { ok: false, reason: "no_role_match" };
  } else {
    pick = pickNode(candidates, "ingress", now);
  }

  if (!pick.ok) {
    const code = pick.reason === "no_credential"
      ? SCHEDULER_ERROR_CODES.node_credential_missing
      : SCHEDULER_ERROR_CODES.node_unavailable;
    await store.tunnel.update({
      where: { id: tunnelId },
      data: {
        apply_status: APPLY_STATUS.error,
        desired_status: DESIRED_STATUS.inactive,
        apply_error_code: code,
        apply_error: `[${code}] DIRECT 入口节点不可用`,
      },
    });
    return { ok: false, tunnelId, error_code: code, error: "DIRECT 入口节点不可用", retryable: isRetryable(code) };
  }

  const remoteHost = typeof row.remote_host === "string" ? row.remote_host.trim() : "";
  const remotePort = Number(row.remote_port ?? 0);
  if (!remoteHost || !Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
    const code = SCHEDULER_ERROR_CODES.invalid_target;
    await store.tunnel.update({
      where: { id: tunnelId },
      data: {
        apply_status: APPLY_STATUS.error,
        desired_status: DESIRED_STATUS.inactive,
        apply_error_code: code,
        apply_error: `[${code}] DIRECT 目标无效`,
      },
    });
    return { ok: false, tunnelId, error_code: code, error: "DIRECT 目标无效", retryable: false };
  }

  const targetDenied = await checkExistingRuntime(row, deps, { ingress: pick.node });
  if (targetDenied) return blockRuntimeUse(targetDenied);

  // Resolved once: admission, dispatch and the canonical fact written back below
  // must agree on which protocol this is.
  const directProtocol = admittedPersistedProtocol(row) ?? DEFAULT_FORWARD_PROTOCOL;

  /* V5-WP1 runtime admission（DIRECT：只需入口节点满足动作 + 协议 + 传输）。
     与 unsupported_protocol 同一处理：只写 apply_status/apply_error_code，
     不动 desired_status —— admission 拒绝不是用户意图改变，「失败保留业务
     资源」这条铁律在这里体现为不把 desired 改成 inactive。 */
  const directAdmissionDenied = await admitBoundRuntime(
    deps,
    [{ nodeId: pick.node.id, role: "ingress" }],
    admittedPersistedProtocol(row) ?? DEFAULT_FORWARD_PROTOCOL,
  );
  if (directAdmissionDenied) {
    const detail = admissionFailureText(directAdmissionDenied);
    const code = SCHEDULER_ERROR_CODES.runtime_capability_denied;
    await store.tunnel.update({
      where: { id: tunnelId },
      data: {
        apply_status: APPLY_STATUS.error,
        apply_error_code: code,
        apply_error: detail.slice(0, 500),
      },
    });
    return { ok: false, tunnelId, error_code: code, error: detail, retryable: false };
  }

  const reserved = collectReservedPorts(
    (await store.tunnel.findMany({
      where: { in_node_group_id: inNodeGroupId },
      select: { id: true, listen_port: true },
    }) as unknown as { id: number; listen_port: number | null }[])
      .filter((t) => t.id !== tunnelId),
  );

  let ingressPort = row.listen_port == null ? null : Number(row.listen_port);
  const alloc = await allocateTunnelPort({
    nodeId: pick.node.id,
    direction: "ingress",
    preferred: ingressPort,
    tunnelId,
    reservedPorts: reserved,
  }, deps.portPoolDeps);
  if (!alloc.ok) {
    const code = alloc.code;
    await store.tunnel.update({
      where: { id: tunnelId },
      data: {
        apply_status: APPLY_STATUS.error,
        desired_status: DESIRED_STATUS.inactive,
        apply_error_code: code,
        apply_error: `[${code}] ${alloc.detail}`.slice(0, 500),
      },
    });
    return { ok: false, tunnelId, error_code: code, error: alloc.detail, retryable: isRetryable(code) };
  }
  ingressPort = alloc.port;

  const currentRevision = Number(row.config_revision ?? 0) || 0;
  const revision = currentRevision + 1;
  await store.tunnel.update({
    where: { id: tunnelId },
    data: {
      ingress_node_id: pick.node.id,
      listen_port: ingressPort,
      desired_status: DESIRED_STATUS.inactive,
      apply_status: APPLY_STATUS.applying,
      config_revision: revision,
      apply_error_code: null,
      apply_error: null,
      // See reapplyRelayTunnel: a successful re-orchestration materialises the
      // canonical protocol fact instead of leaving history's only evidence in
      // the legacy column.
      forward_protocol: directProtocol,
    },
  });

  /* V5-WP2 RuntimePlan 自检（DIRECT：端口分配后所有事实齐了）。 */
  const directPlan = buildForwardRuntimePlan("direct", directProtocol, {
    revision,
    placement: { ingress_node_id: pick.node.id },
    listener: { host: typeof row.listen_ip === "string" ? row.listen_ip : null, port: ingressPort },
    upstream: { targets: [{ host: remoteHost, port: remotePort }] },
  });
  const directPlanViolations = forwardRuntimePlanViolations(directPlan);
  if (directPlanViolations.length > 0) {
    const compensation = await compensateRuntimesThenRelease({
      tunnelId,
      orchestrator,
      removals: [
        {
          tunnelId,
          node: pick.node,
          direction: "direct",
          revision: revision + 1,
          reason: "direct runtime plan invalid",
        },
      ],
      portPoolDeps: deps.portPoolDeps,
    });
    const code = compensation.ok
      ? SCHEDULER_ERROR_CODES.invariant_violated
      : SCHEDULER_ERROR_CODES.compensation_failed;
    const detail =
      `RuntimePlan 自检未通过：${directPlanViolations.join("; ")}` +
      (compensation.ok ? "" : `；${compensation.error}`);
    await store.tunnel.update({
      where: { id: tunnelId },
      data: {
        apply_status: APPLY_STATUS.error,
        desired_status: DESIRED_STATUS.inactive,
        apply_error_code: code,
        apply_error: detail.slice(0, 500),
      },
    });
    return { ok: false, tunnelId, error_code: code, error: detail, retryable: isRetryable(code) };
  }

  const dispatched = await orchestrator.dispatchDirect({
    tunnelId,
    revision,
    ingressNode: pick.node,
    ingressPort,
    remoteHost,
    remotePort,
    listenHost: typeof row.listen_ip === "string" ? row.listen_ip : null,
    protocol: directPlan.protocol.name,
    ...tlsPathsFor(row, directPlan.protocol.name),
  });
  if (!dispatched.ok) {
    const compensation = await compensateRuntimesThenRelease({
      tunnelId,
      orchestrator,
      removals: [
        {
          tunnelId,
          node: pick.node,
          direction: "direct",
          revision: revision + 1,
          reason: "direct apply failed",
        },
      ],
      portPoolDeps: deps.portPoolDeps,
    });
    const originalCode = mapDispatchCode("ingress", dispatched);
    const code = compensation.ok
      ? originalCode
      : SCHEDULER_ERROR_CODES.compensation_failed;
    const detail = compensation.ok
      ? dispatched.error
      : `${dispatched.error}；${compensation.error}`;
    await store.tunnel.update({
      where: { id: tunnelId },
      data: {
        apply_status: APPLY_STATUS.error,
        desired_status: DESIRED_STATUS.inactive,
        apply_error_code: code,
        apply_error: `[${code}] ${detail}`.slice(0, 500),
        config_revision: revision,
      },
    });
    return { ok: false, tunnelId, error_code: code, error: detail, retryable: isRetryable(code) };
  }

  await store.tunnel.update({
    where: { id: tunnelId },
    data: {
      apply_status: APPLY_STATUS.active,
      desired_status: DESIRED_STATUS.active,
      config_revision: revision,
      applied_revision: revision,
      last_applied_at: deps.now(),
      apply_error_code: null,
      apply_error: null,
    },
  });

  return { ok: true, tunnelId, revision, ingressNodeId: pick.node.id, ingressPort };
}

/** 行投影收窄（`findUnique` 返回 unknown，本文件内部使用）。 */
function asRow<T>(row: unknown): T | null {
  return row ? (row as T) : null;
}
