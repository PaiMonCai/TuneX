/**
 * WP8 — RELAY Orchestrator（Track C）。
 *
 * 依据 `DEVELOPMENT.md` §4.2「RELAY 编排铁律」、§1.1「RELAY 必须**先准备出口，
 * 再启入口**」与 devmap v3「tunnelOrchestrator 补全 RELAY 模式（两次下发逻辑）」。
 *
 * ── 铁律一：先出口，后入口 ──
 *
 * ```text
 * 5. 向 Egress 发送 apply，等待 ACK N。
 * 6. Egress 成功后向 Ingress 发送 apply，等待 ACK N。
 * 7. 两端均成功后 apply_status=active。
 * ```
 *
 * 为什么这个顺序不可交换（不是风格问题）：入口 listener 一旦 bind 就开始
 * 收用户流量，而它的 next-hop 指向出口节点。若入口先起、出口还没就绪，
 * 每一个进来的连接都会拿到 connection refused / timeout —— 用户侧看到的是
 * 「隧道建好了但连不上」，比「还在创建中」难排查得多。反过来先起出口：
 * 出口在等一个还没有人连接它的端口，对外完全不可见，零用户影响。
 *
 * 因此 {@link Orchestrator.dispatchIngress} 的入参里 `next_hop` 是**必填**——
 * 没有出口地址就不允许启入口。`dispatchEgress` 返回的 `egress_host` 就是它的
 * 唯一来源（见 {@link Orchestrator} 的两个方法如何配合）。
 *
 * ── 铁律二：两次下发，不是一次 ──
 * RELAY 在**两台物理机**上各有一条隧道，它们是两条独立 resource：
 *  · 出口节点上：一条 `EGRESS` 模式的隧道（监听 egress_port → 目标池 LB）；
 *  · 入口节点上：一条 `RELAY` 模式的隧道（监听 ingress_port → 出口节点）。
 *
 * WP4 Agent 的 `TunnelConfig` 就按这个模型建（`mode: EGRESS` / `mode: RELAY`，
 * `forwarder/interface.go`）。所以编排器必须**分别**下发两次，各自等各自
 * 的 ACK，各自记各自的 revision（两端用的是同一个 `config_revision` N，
 * 这样一次重发对两端都是同一个版本，WP9 reconciler 才能按版本对齐）。
 *
 * ── 铁律三：端口分配在编排器之外 ──
 * 本模块**不 import portPool**：端口是 WP3 的所有权（§5.1），编排器只消费
 * 已经拿到的端口号。把分配与下发分开，WP3 的并发/对账逻辑就不会被编排的
 * 失败路径污染（例如「入口下发失败要不要释放出口端口」属于编排补偿，
 * 属于本模块；「端口还能不能再分」属于所有权，属于 WP3）。
 *
 * ── transport 边界 ──
 * 下发动作全部走 {@link AgentTransport} 接口。默认实现 {@link HttpAgentTransport}
 * 经 WP4 Agent 的 `POST /tunnel` 管理面（127.0.0.1:9090，AGENT_ADMIN_TOKEN
 * bearer）；真正生产用的出站长连接（§3.1「私网 Agent 只需出站连接控制面」）
 * 由 WP7 node session 提供，届时替换这一个实现即可，编排顺序不变。
 *
 * ── 节点身份（§3.3 + WP7）──
 * 编排器**不**在这里验身份，但它在两个点上与 WP7 强绑定：
 *  1. `HttpAgentTransportOptions.tokenForNode` 返回的 bearer 必须是 WP7 的
 *     per-node credential（不是 `node_group.token`：一把组 token 能冒充组内
 *     任意节点，正是 §3.3 禁止的形态）。凭据的签发/轮换/撤销与解析都在
 *     `services/node-credential.ts`，本模块只消费 opaque token；
 *  2. 「这个节点有没有资格被编排」由 `scheduler.ts` 的 bind 阶段用 WP7 的
 *     {@link decideNodeAuth} 判定（见该文件 `nodeCredentialUsable`）。没有
 *     有效凭据的节点根本进不到下发这一步。
 *
 * 载荷统一经 WP6 {@link createCommand} 构造 + {@link ControlValidator} 走闸门：
 * stale / duplicate / expired 三条硬规则因此对**编排器自身**也生效——重放
 * 一次创建不会让 Agent 重建 listener（§3.2 hard rule 2）。
 */

import { createHash } from "node:crypto";

import {
  ControlValidator,
  createCommand,
  type CommandAck,
  type CommandEnvelope,
} from "./control-protocol/index.ts";
import type { CommandAction, ResourceStatus } from "./control-protocol/index.ts";
import { targetHealthWireEntries } from "./target-health-read.ts";
import { claimLease, releaseLease as releasePlacementLease } from "./placement-lease.ts";
import type { RoutePlan } from "./forward-route.ts";
import {
  DEFAULT_FORWARD_PROTOCOL,
  wireTunnelTypeForForwardProtocol,
  type ForwardProtocol,
} from "./forward-contract.ts";

/* ================================================================== */
/* Agent 管理面契约（WP4 api.Server 的镜像）                            */
/* ================================================================== */

/** 编排器眼里的节点投影（只需要寻址 + 角色，其余字段与调度无关）。 */
export interface OrchestratorNode {
  id: number;
  node_id: string;
  /** 入口节点用：`connect_ip` 里挑出来的可解析地址。 */
  connect_ip: string | null;
  role: "ingress" | "egress" | "both" | null;
}

/** Agent 侧的隧道配置（与 WP4 `forwarder.TunnelConfig` JSON 对齐）。 */
export interface AgentTunnelConfig {
  /** 稳定 id：`tunex-<tunnelId>-<direction>`。Agent 以它为幂等键。 */
  id: string;
  /** EGRESS = 出口侧；RELAY = 入口侧（WP4 `forwarder.Mode`）。 */
  mode: "DIRECT" | "EGRESS" | "RELAY";
  ingress_port: number;
  egress_port: number;
  remote_host: string;
  remote_port: number;
  /** RELAY 模式必填：`<egress node ip>:<egress port>`（validate 会强校验）。 */
  next_hop: string;
  targets: { host: string; port: number; weight: number; order: number }[];
  /**
   * V5.2 WP7 —— 合成后的目标健康，**与 `targets` 平行**而不是塞进每个 target 里。
   *
   * 两条理由，都不是风格问题：
   *   1. desired 与 health 是两类事实。塞进同一个元素，下一次改动就说不清新增字段
   *      属于哪一类；平行数组让"desired 一个字节没变"在结构上可见；
   *   2. Agent 据此**只调整选择顺序**（熔断 + 加权），永远不改写 desired 列表。
   *
   * 缺失（旧面板 / 健康读取失败）= 没有健康信号 → Agent 行为与今天完全一致。
   * 健康是**优化**，不是闸门：它读失败绝不能挡住一次下发。
   */
  target_health?: {
    host: string;
    port: number;
    state: string;
    latency_ms: number | null;
    age_ms: number | null;
    evidence: boolean;
  }[];
  lb_strategy: "ROUND_ROBIN" | "RANDOM" | "WEIGHTED_ROUND_ROBIN";
  /**
   * V5-WP2: the product protocol this config carries, taken from the forward's
   * RuntimePlan. It is no longer typed as the literal "tcp": the plan is the
   * single source of this fact, and the agent's outbound gate reads the very
   * same field (services/agent-command-bus.ts), so the admitted protocol and
   * the dispatched protocol cannot disagree.
   */
  protocol: ForwardProtocol;
  /**
   * V5.3 WP9 —— 归属事实：本节点被授权承载该 Forward 的世代与租约到期时刻。
   *
   * Agent 侧据此拒绝 stale epoch（收到比已见最高更低的 epoch 时拒绝激活），
   * 并在租约到期后停止服务。缺席 = 面板没有授权信息（旧面板）→ Agent 行为与今天一致。
   *
   * 这两个字段**必须同时出现在命令下发与重连快照两条路径上**，并且解码器必须认识它们 ——
   * V5 里这个类别已经踩过三次（协议、证书路径、健康），症状分别是"重启后静默失效"。
   */
  ownership_epoch?: number;
  lease_expires_at?: string;
  speed_limit: number;
  revision: number;
  listen_host?: string;
  /**
   * V5-WP5-A1: node-local certificate/key PATHS for a tls front. The control
   * plane never carries key material (§6.1 "Where are certificates owned?").
   * Omitted for every other protocol — the Agent refuses a tls tunnel without
   * them, so an omission cannot silently degrade into "TLS but unauthenticated".
   */
  tls_cert_path?: string;
  tls_key_path?: string;
}

/** 一次下发的结果（两条下发路径的公共形状）。 */
export interface DispatchResult {
  commandId: string;
  /** 对端 ACK 的 revision（= 下发的 revision）。 */
  revision: number;
  /** ACK 的原始报文（观测用；不含敏感字段）。 */
  ack: CommandAck;
}

export interface DispatchFailure {
  ok: false;
  error_code: RelayDispatchErrorCode;
  error: string;
  commandId?: string;
}

export type RelayDispatchOutcome =
  | { ok: true; result: DispatchResult }
  | DispatchFailure;

/**
 * 下发失败的**结构化错误码**（进 `Tunnel.apply_error_code`，与
 * `scheduler.ts` 的 {@link SCHEDULER_ERROR_CODES} 同一命名空间——那边做了
 * 映射，这里只报协议层能区分的东西）。
 */
export const RELAY_DISPATCH_ERROR_CODES = {
  /**
   * V5.4：路由本身不合法，或**尚未实现的形状**。
   *
   * 这是一个"宁可拒绝"的错误码，不是临时占位：`middle_node_id` 一旦非空，`RoutePlan`
   * 就是三跳，而当前下发链路只会发出单跳形状的配置。若在这里放行，用户配了中间跳之后
   * 转发会**静默地按单跳工作** —— 那正是本项目反复吃亏的一类失败（配置生效了，但不是
   * 用户要的那条路）。实现 WP12 之前，多跳必须在这里被明确拒绝并点名原因。
   */
  route_not_dispatchable: "route_not_dispatchable",
  /** 命令明确未建立可用管理面连接：DNS / 连接拒绝等。 */
  agent_unreachable: "agent_unreachable",
  /** outbound command 已入队，但同步等待窗口内没有收到 ACK；执行结果未知。 */
  ack_timeout: "ack_timeout",
  /** Agent 回了非 2xx（含 409 stale revision、400 payload）。 */
  agent_rejected: "agent_rejected",
  /** ACK 结构不合法（protocol validator 拒绝）。 */
  ack_invalid: "ack_invalid",
  /** ACK 的 status 不是 applied/duplicate。 */
  ack_failed: "ack_failed",
  /** ACK 回显的 revision 与下发的不一致。 */
  revision_mismatch: "revision_mismatch",
  /** 节点没有可用于转发的地址（connect_ip 解析不出）。 */
  node_unaddressable: "node_unaddressable",
} as const;

export type RelayDispatchErrorCode =
  (typeof RELAY_DISPATCH_ERROR_CODES)[keyof typeof RELAY_DISPATCH_ERROR_CODES];

/* ================================================================== */
/* Transport：唯一的 IO 接缝                                            */
/* ================================================================== */

/**
 * 与一台 Agent 管理面对话的最小接口。
 *
 * 分成两个方法而不是一个 `post(path, body)`：EGRESS 与 RELAY 的下发**走同一个
 * `POST /tunnel`**，但 payload 的 `mode` 与必填字段完全不同。分成两个方法让
 * 「忘填 next_hop」在类型层面就不可能发生（RELAY 的那个方法签名要求它）。
 */
export interface AgentTransport {
  /** 在出口节点上应用/替换一条 EGRESS 隧道。 */
  applyEgress(node: OrchestratorNode, config: AgentTunnelConfig, envelope?: CommandEnvelope): Promise<unknown>;
  /** 在入口节点上应用/替换一条 RELAY 隧道。 */
  applyRelay(node: OrchestratorNode, config: AgentTunnelConfig, envelope?: CommandEnvelope): Promise<unknown>;
  /** 在入口节点上应用/替换一条 DIRECT 隧道。 */
  applyDirect(node: OrchestratorNode, config: AgentTunnelConfig, envelope?: CommandEnvelope): Promise<unknown>;
  /** 下线一条隧道（补偿路径；幂等，Agent 侧未知 id 返回 ok）。 */
  removeTunnel(node: OrchestratorNode, tunnelId: string, envelope?: CommandEnvelope): Promise<unknown>;
  /** 节点管理面是否可达（用于快速失败；默认实现总是 true）。 */
  isReachable?(node: OrchestratorNode): Promise<boolean>;
}

/** 管理面不可达 / 被拒时抛出（transport 实现自己决定错误码）。 */
export class AgentTransportError extends Error {
  readonly code: RelayDispatchErrorCode;
  constructor(code: RelayDispatchErrorCode, message: string) {
    super(message);
    this.name = "AgentTransportError";
    this.code = code;
  }
}

/* ================================================================== */
/* HTTP transport（WP4 agent internal/api 的客户端）                     */
/* ================================================================== */

/** 默认管理面端口：devmap v3 的 agent port 9090（与 9191 上报口隔离）。 */
export const DEFAULT_AGENT_ADMIN_PORT = 9090;

export interface HttpAgentTransportOptions {
  /**
   * 每节点 bearer token。**语义是 WP7 per-node credential**（§3.3），不是
   * `node_group.token`：后者一组一把，能冒充组内任意节点。缺失的节点 =
   * 拒绝下发（`agent_rejected`）。凭据的签发/轮换/撤销在
   * `services/node-credential.ts`，调用方从那里取。
   */
  tokenForNode?: (node: OrchestratorNode) => string | null | undefined;
  /** 覆盖管理面端口（部署在不同端口时）。 */
  port?: number;
  /** 单次请求超时（毫秒）。下发是编排的关键路径，超时必须短且确定。 */
  timeoutMs?: number;
  /** 注入 fetch（测试替身）。 */
  fetch?: typeof fetch;
}

/**
 * 经 Agent 本地管理面 HTTP API 下发（WP4 `internal/api/server.go`）。
 *
 * 寻址规则：`http://<connect_ip>:<port>`。`connect_ip` 可能是逗号分隔多 IP
 * （`config-generator.ts` 的 `getConnectIP` 已在处理这个），这里取**第一个**
 * 可解析项——控制面到节点是私网/内网直连，不做 IP 优选。
 *
 * `127.0.0.1` / `localhost` 也允许：v3 部署拓扑里节点与 agent 同机，
 * 单机 BOTH 场景面板与 agent 同机部署时 connect_ip 常写成回环。
 */
export class HttpAgentTransport implements AgentTransport {
  private readonly tokens: HttpAgentTransportOptions["tokenForNode"];
  private readonly port: number;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(opts: HttpAgentTransportOptions = {}) {
    this.tokens = opts.tokenForNode;
    this.port = opts.port ?? DEFAULT_AGENT_ADMIN_PORT;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetchFn = opts.fetch ?? fetch;
  }

  /** 从 `connect_ip` 里挑一个可用 host（第一个非空trim项）。 */
  private hostFor(node: OrchestratorNode): string {
    const raw = String(node.connect_ip ?? "").trim();
    if (raw === "") throw new AgentTransportError(
      RELAY_DISPATCH_ERROR_CODES.node_unaddressable,
      `节点 ${node.node_id} 没有 connect_ip，无法寻址管理面`,
    );
    const first = raw.split(",").map((s) => s.trim()).find(Boolean);
    if (!first) throw new AgentTransportError(
      RELAY_DISPATCH_ERROR_CODES.node_unaddressable,
      `节点 ${node.node_id} 的 connect_ip 解析不出地址（${raw}）`,
    );
    // IPv6 字面量要加方括号，否则 URL 解析会把冒号当成端口分隔符。
    if (first.includes(":") && !first.startsWith("[")) return `[${first}]`;
    return first;
  }

  private authHeader(node: OrchestratorNode): string {
    const token = this.tokens?.(node);
    if (!token) {
      throw new AgentTransportError(
        RELAY_DISPATCH_ERROR_CODES.agent_rejected,
        `节点 ${node.node_id} 未配置管理面 token，拒绝下发`,
      );
    }
    return `Bearer ${token}`;
  }

  private async post(
    node: OrchestratorNode,
    path: string,
    body: unknown,
  ): Promise<unknown> {
    const url = `http://${this.hostFor(node)}:${this.port}${path}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: this.authHeader(node),
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text().catch(() => "");
      if (!res.ok) {
        throw new AgentTransportError(
          RELAY_DISPATCH_ERROR_CODES.agent_rejected,
          `Agent ${node.node_id} 返回 HTTP ${res.status}: ${text.slice(0, 200)}`,
        );
      }
      if (text.trim() === "") return null;
      try {
        return JSON.parse(text);
      } catch {
        // 200 但非 JSON：Agent 的 writeOK 一定是 JSON，这里说明中间有东西改了
        // 响应。按 unreachable 记（不是 reject：我们并不知道它成功没有）。
        throw new AgentTransportError(
          RELAY_DISPATCH_ERROR_CODES.agent_unreachable,
          `Agent ${node.node_id} 返回的非 JSON 响应`,
        );
      }
    } catch (e) {
      if (e instanceof AgentTransportError) throw e;
      throw new AgentTransportError(
        RELAY_DISPATCH_ERROR_CODES.agent_unreachable,
        `Agent ${node.node_id} 不可达（${url}）：${(e as Error)?.message ?? String(e)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  applyEgress(node: OrchestratorNode, config: AgentTunnelConfig): Promise<unknown> {
    // WP4 agent 的 POST /tunnel 同时接嵌套 TunnelConfig 与带 revision 的扁平
    // 信封（applyRequest），这里直接用嵌套形态。
    return this.post(node, "/tunnel", config);
  }

  applyRelay(node: OrchestratorNode, config: AgentTunnelConfig): Promise<unknown> {
    return this.post(node, "/tunnel", config);
  }

  applyDirect(node: OrchestratorNode, config: AgentTunnelConfig): Promise<unknown> {
    return this.post(node, "/tunnel", config);
  }

  removeTunnel(node: OrchestratorNode, tunnelId: string): Promise<unknown> {
    return this.post(node, `/tunnel?id=${encodeURIComponent(tunnelId)}`, {});
  }
}

/* ================================================================== */
/* Orchestrator                                                        */
/* ================================================================== */

/** V5.4：线性路由的下发输入（`dispatchRoute`）。 */
export interface DispatchRouteInput {
  readonly tunnelId: number;
  readonly revision: number;
  readonly plan: RoutePlan;
  /** 每一跳的节点（`hop_index` → 节点事实）。 */
  readonly hop_nodes: Readonly<Record<number, OrchestratorNode>>;
  /** 每一跳的端口（来自计划阶段的 `acquire_port`；这里不选端口）。 */
  readonly hop_ports: Readonly<Record<number, number>>;
  /** 出口跳的真实目标池。 */
  readonly targets: readonly { host: string; port: number; weight?: number; order_by?: number }[];
  readonly poolId: number | null;
  readonly lbStrategy?: string | null;
  readonly protocol?: ForwardProtocol;
  readonly tlsCertPath?: string | null;
  readonly tlsKeyPath?: string | null;
}

export type RouteDispatchOutcome =
  | { ok: true; plan: RoutePlan; hops_dispatched: readonly number[] }
  | DispatchFailure;

export interface DispatchEgressInput {
  tunnelId: number;
  /**
   * V5.5 WP15：覆盖运行时 id。本地 Forward 不传（用 `tunex-<tunnelId>-egress`）；
   * 联邦远端腿传 `Orchestrator.federatedTunnelId(leaseRef, "egress")`，
   * 避免与 host 上同号的本地 Forward 撞 id。**additive、可选**：不传时行为与今天逐字节一致。
   */
  runtimeId?: string;
  revision: number;
  /** 出口节点（bind 阶段选出）。 */
  egressNode: OrchestratorNode;
  /** 出口端口（WP3 分配的节点间内部端口）。 */
  egressPort: number;
  /** 目标池 id（`egress_pool_id`，未指定 default 池时为 null）。 */
  poolId: number | null;
  /** 池内 active 目标（`EgressTarget` 行）。 */
  targets: readonly {
    host: string;
    port: number;
    weight?: number;
    order_by?: number;
  }[];
  /** 池/节点上的 LB 策略；NULL = ROUND_ROBIN。 */
  lbStrategy?: string | null;
  /** V5-WP2: 该转发 RuntimePlan 里的协议；缺省 = V4 的 TCP。 */
  protocol?: ForwardProtocol;
  /** V5-WP5-A1: tls 前端的证书/私钥路径（仅 protocol=tls 时下发）。 */
  tlsCertPath?: string | null;
  tlsKeyPath?: string | null;
}

export interface DispatchIngressInput {
  tunnelId: number;
  /**
   * V5.5 WP15：覆盖运行时 id（联邦远端入口腿用 `federatedTunnelId(ref,"relay")`）。
   *
   * 传了它就同时意味着"这不是本机 Forward 的腿"：host 上没有对应的 tunnel 行，
   * 因此**不**写 `placement_lease` —— 联邦腿的归属由 `federation_lease.lease_epoch`
   * 表达，再写一份本地归属就是第二份真相（而那份归属会指向一个不存在的隧道）。
   */
  runtimeId?: string;
  revision: number;
  ingressNode: OrchestratorNode;
  ingressPort: number;
  /** `<egress ip>:<egress port>`，来自 {@link dispatchEgress} 的返回值。 */
  nextHop: string;
  /** V5-WP2: 该转发 RuntimePlan 里的协议；缺省 = V4 的 TCP。 */
  protocol?: ForwardProtocol;
  /** V5-WP5-A1: tls 前端的证书/私钥路径（仅 protocol=tls 时下发）。 */
  tlsCertPath?: string | null;
  tlsKeyPath?: string | null;
}

export interface DispatchDirectInput {
  tunnelId: number;
  revision: number;
  ingressNode: OrchestratorNode;
  ingressPort: number;
  remoteHost: string;
  remotePort: number;
  listenHost?: string | null;
  /** V5-WP2: 该转发 RuntimePlan 里的协议；缺省 = V4 的 TCP。 */
  protocol?: ForwardProtocol;
  /** V5-WP5-A1: tls 前端的证书/私钥路径（仅 protocol=tls 时下发）。 */
  tlsCertPath?: string | null;
  tlsKeyPath?: string | null;
}

/** dispatchEgress 成功时额外带回出口地址（入口下发要用它拼 next_hop）。 */
export interface EgressDispatchSuccess {
  ok: true;
  result: DispatchResult;
  /** 出口节点被判定的可寻址 host（即 next_hop 的前半段）。 */
  egress_host: string;
  /** 实际下发的端口（= 入参的 egressPort）。 */
  egress_port: number;
}

export type EgressDispatchOutcome = EgressDispatchSuccess | DispatchFailure;

export interface RemoveTunnelInput {
  tunnelId: number;
  /** V5.5 WP15：见 `DispatchEgressInput.runtimeId`（联邦远端腿用 `fed-` 命名空间）。 */
  runtimeId?: string;
  /** 在哪台节点上撤。 */
  node: OrchestratorNode;
  /** 明确 runtime 方向；不能再根据 Node.role 猜，BOTH 节点会猜错。 */
  direction?: "direct" | "ingress" | "egress";
  /** 补偿用的 revision：比失败的那次高 1（让 Agent 侧的闸门放行）。 */
  revision: number;
  reason?: string;
}

/**
 * V5.2 WP7 默认健康来源：读观测投影 → WP6 合成。
 *
 * 合成的结论**由面板给出**，Agent 不自己定义健康；这里产出的就是那一个模型的下发形式。
 * 失败一律回落到空数组（见 dispatchEgress 的说明）：健康是优化，不是闸门。
 */
const defaultTargetHealthSource: TargetHealthSource = async (targets) =>
  // ONE implementation of the wire mapping, shared with the snapshot path
  // (`buildDesiredNodeSnapshot`): two copies would drift, and the symptom of drift here
  // is an agent that has health after a command but not after a restart.
  targetHealthWireEntries(targets, new Date());

/** V5.2 WP7：一次下发的健康来源。可注入，便于离线断言"没有健康信号"的分支。 */
export type TargetHealthSource = (
  targets: readonly { host: string; port: number }[],
) => Promise<{
  host: string;
  port: number;
  state: string;
  latency_ms: number | null;
  age_ms: number | null;
  evidence: boolean;
}[]>;

export interface OrchestratorOptions {
  /** V5.2 WP7：健康来源；省略则读观测投影并做 WP6 合成。 */
  healthSource?: TargetHealthSource;
  transport: AgentTransport;
  /** WP6 校验器（进程级共享，revision 闸门跨请求生效）。 */
  validator?: ControlValidator;
  /** 下发前先探测节点可达性（默认 true；离线节点快速失败）。 */
  probeReachable?: boolean;
}

/**
 * Agent `POST /tunnel` 响应体的规范化解读。
 *
 * 呼吸契约是：2xx + `{"ok":true, "id":…, "revision":N}` = 应用成功；其余
 * （`{"ok":false,...}`、`{"error":…}`、空 body、数组、null）一律不是成功。
 *
 * 为什么不能只看 HTTP 状态码：WP4 agent 的 `handleApplyTunnel` 对
 * `ErrStaleRevision` 回 **409**、别的错误回 400，HTTP transport 已经把它们
 * 变成 throw。但**非 HTTP transport**（测试替身、未来的消息队列）会直接返回
 * body，此时 body 才是唯一真相。两者都要覆盖，所以解析放在这里而不是
 * transport 里。
 *
 * `raw === null`（空 body）按成功处理：`remove_tunnel` 的响应允许没有 body，
 * 而 2xx 的语义就是「已处理」。
 */
function parseAgentAck(
  raw: unknown,
): { ok: true; applied_revision?: number } | { ok: false; error_code?: string; error?: string } {
  if (raw === null || raw === undefined) return { ok: true };
  if (typeof raw !== "object") return { ok: false, error: `非对象响应体: ${String(raw)}` };
  const r = raw as Record<string, unknown>;
  // 没有 ok 字段时按「老 agent」处理：不矫情，乐观放行（revision 仍会在
  // 下一步由 validator 兜底校验）。
  if (r.ok === undefined) return { ok: true };
  if (r.ok === false || r.ok === 0 || r.ok === "") {
    const err = r.error ?? r.message ?? r.reason;
    const code =
      typeof err === "string" && /revision mismatch|revision_mismatch/i.test(err)
        ? "revision_mismatch"
        : undefined;
    return {
      ok: false,
      error_code: typeof r.error_code === "string" ? r.error_code : code,
      error: typeof err === "string" ? err : err === undefined ? undefined : String(err),
    };
  }
  const rev = r.applied_revision ?? r.revision;
  return { ok: true, applied_revision: typeof rev === "number" ? rev : undefined };
}

/**
 * RELAY 双下发编排器。
 *
 * 两个公开方法**必须**按顺序调用（先 {@link dispatchEgress} 后
 * {@link dispatchIngress}）——这不是约定而是铁律（见文件头）。
 * {@link removeTunnel} 是补偿专用：失败回滚时撤掉已经 ACK 的那一端。
 */
export class Orchestrator {
  private readonly transport: AgentTransport;
  private readonly validator: ControlValidator;
  private readonly probe: boolean;
  /**
   * V5.2 WP7: where the per-target health comes from. Injected so the orchestrator
   * keeps its "no IO beyond the transport" testability — a test can hand it a stub,
   * including the empty case, without a database.
   */
  private readonly healthSource: TargetHealthSource;

  constructor(opts: OrchestratorOptions) {
    this.transport = opts.transport;
    this.validator = opts.validator ?? new ControlValidator();
    this.probe = opts.probeReachable ?? true;
    this.healthSource = opts.healthSource ?? defaultTargetHealthSource;
  }

  /* ---------------------------------------------------------------- */
  /* 命令构造                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * V5-WP5-A1: the tls front's paths, or nothing.
   *
   * Only emitted for `protocol=tls`, and only as a pair: a half-configured TLS
   * front would otherwise reach an Agent that must then decide which half to
   * believe. Absent for every other protocol, so the wire shape of a tcp tunnel
   * is byte-for-byte what it was.
   */
  private static tlsFields(
    protocol: ForwardProtocol,
    input: { tlsCertPath?: string | null; tlsKeyPath?: string | null },
  ): { tls_cert_path?: string; tls_key_path?: string } {
    if (protocol !== "tls") return {};
    const cert = typeof input.tlsCertPath === "string" ? input.tlsCertPath.trim() : "";
    const key = typeof input.tlsKeyPath === "string" ? input.tlsKeyPath.trim() : "";
    if (cert === "" || key === "") {
      throw new AgentTransportError(
        RELAY_DISPATCH_ERROR_CODES.agent_rejected,
        "tls 转发缺少证书/私钥路径，拒绝下发",
      );
    }
    return { tls_cert_path: cert, tls_key_path: key };
  }

  /**
   * 出口侧隧道 id：`tunex-<tunnelId>-egress`。
   * 加方向后缀是必须的——同一 `tunnelId` 在入口节点上是 RELAY、在出口节点上
   * 是 EGRESS，两者若共用一个 id，Agent 的 `map[id]` 会互相覆盖
   * （BOTH 节点同机部署时尤其致命）。
   */
  static egressTunnelId(tunnelId: number): string {
    return `tunex-${tunnelId}-egress`;
  }

  /** 入口侧 RELAY 隧道 id：`tunex-<tunnelId>-relay`。 */
  static relayTunnelId(tunnelId: number): string {
    return `tunex-${tunnelId}-relay`;
  }

  /** DIRECT 隧道 id：`tunex-<tunnelId>-direct`。 */
  static directTunnelId(tunnelId: number): string {
    return `tunex-${tunnelId}-direct`;
  }

  /**
   * 一条本地 Forward 在某个节点上**可能**使用的全部 runtime id。
   *
   * 用途之一是端口分配：Agent 上报"某个端口被某个 runtime 占着"时，面板要能判断
   * "那是这条隧道自己的腿"还是"别人的"。少了这一层，把 listen_port 改成它当前正在用的
   * 值（幂等编辑 / 失败重试 / 还原夹具）会被自己挡回去。
   *
   * 只列本地腿；联邦远端腿走 `federatedTunnelId` 的独立命名空间（它没有本地 Forward 行，
   * 端口也归 host 的 portPool，不参与本地分配）。
   */
  static localRuntimeIdsForTunnel(tunnelId: number): string[] {
    return [
      Orchestrator.directTunnelId(tunnelId),
      Orchestrator.relayTunnelId(tunnelId),
      Orchestrator.egressTunnelId(tunnelId),
    ];
  }

  /**
   * V5.5 WP15 —— **联邦远端腿**的运行时 id：`tunex-fed-<leaseRef>-<direction>`。
   *
   * 为什么需要单独命名空间：host 侧承载的是一个远端 Forward 的一条腿，它**没有**本地
   * Forward 行，所以不能借用 `tunnel.id` —— 同一台 host 上"本地隧道 11"与"联邦租约 11"
   * 会算出同一个 `tunex-11-egress`，Agent 的 `map[id]` 会互相覆盖（BOTH 节点上尤其致命）。
   * `fed-` 前缀把两类资源在**运行时 id 这一层**分开，而不是靠"数字应该不会撞"的假设。
   *
   * 分段与本地腿完全一致（direct/relay/egress），因此 Agent 侧不需要认识"联邦"这个概念。
   */
  static federatedTunnelId(leaseRef: string, direction: "direct" | "relay" | "egress"): string {
    return `tunex-fed-${leaseRef}-${direction}`;
  }

  /* ---------------------------------------------------------------- */
  /* 线性路由的下发（V5.4 WP12）                                        */
  /* ---------------------------------------------------------------- */

  /**
   * 中间跳的**唯一实现**：一个监听 + 拨号到下一跳的转发，与出口跳同一个原语。
   *
   * 为什么单独抽出来：创建路径与 rollout 路径都需要发这一腿，而"同一个事实有两个实现"是本项目
   * 反复吃亏的形态（协议、证书路径、健康数组、池内容、schema）。**编排可以有两处，事实的实现只能有一处。**
   *
   * `nextHop` 必须是**下一跳自己 dispatch 返回值**里的地址，不能猜 —— 见 `dispatchRoute` 的说明。
   */
  async dispatchTransit(input: {
    tunnelId: number;
    /** V5.5 WP15：见 `DispatchEgressInput.runtimeId`。 */
    runtimeId?: string;
    revision: number;
    node: OrchestratorNode;
    port: number;
    nextHop: string;
    protocol?: ForwardProtocol;
  }): Promise<{ ok: true; host: string } | DispatchFailure> {
    const [host, portRaw] = input.nextHop.split(":");
    const nextPort = Number(portRaw);
    if (!host || !Number.isFinite(nextPort) || nextPort <= 0) {
      return {
        ok: false,
        error_code: RELAY_DISPATCH_ERROR_CODES.agent_rejected,
        error: `中间跳的下一跳地址非法：${input.nextHop}`,
      };
    }
    const outcome = await this.dispatchEgress({
      tunnelId: input.tunnelId,
      runtimeId: input.runtimeId,
      revision: input.revision,
      egressNode: input.node,
      egressPort: input.port,
      // 中间跳没有自己的池：它唯一的"目标"就是下一跳。
      poolId: null,
      targets: [{ host, port: nextPort, weight: 1, order_by: 10 }],
      protocol: input.protocol,
    });
    if (!outcome.ok) return outcome;
    return { ok: true, host: outcome.egress_host };
  }

  /**
   * 按 `RoutePlan` 下发一条线性路由。**这是既有原语的组合，不是第二条下发通道。**
   *
   * 三跳的形状，逐跳都是既有的两段式：
   *   · hop N-1（出口）：`dispatchEgress` 指向**真实目标池**；
   *   · 中间跳：同一个 `dispatchEgress` 形状，只是它的"目标"是**下一跳的节点间监听地址**
   *     （一跳的出口就是下一跳的入口 —— 这正是 RELAY 两段式的本质）；
   *   · hop 0（入口）：`dispatchIngress`，`next_hop` 指向它的下一跳。
   *
   * 顺序不可交换（§1 铁律在 N 跳上的推广）：**正向先远后近** —— 最远的一跳先起，客户端面前最后。
   * 任何一跳失败时调用方按 `compensationSteps()` 逆序拆除。
   *
   * 每一跳的端口必须已经由计划阶段 `acquire_port` 拿到：这里**不选端口**，端口分配是调度决策。
   * 每一跳的"可寻址地址"来自**该跳自己的 dispatch 返回值**，不猜 IP —— 猜错就是每个新连接都
   * 连不上的静默故障（这也是既有两段式一直遵守的规则）。
   */
  async dispatchRoute(input: DispatchRouteInput): Promise<RouteDispatchOutcome> {
    const hops = [...input.plan.hops];
    const last = hops[hops.length - 1];
    if (last === undefined) {
      return { ok: false, error_code: RELAY_DISPATCH_ERROR_CODES.agent_unreachable, error: "路由为空" };
    }

    const listeningAt = new Map<number, { host: string; port: number }>();

    for (let i = hops.length - 1; i >= 0; i -= 1) {
      const hop = hops[i]!;
      const port = input.hop_ports[hop.hop_index];
      const node = input.hop_nodes[hop.hop_index];
      if (node === undefined || port === undefined) {
        return {
          ok: false,
          error_code: RELAY_DISPATCH_ERROR_CODES.agent_unreachable,
          error: `hop ${hop.hop_index} 缺少节点或端口事实（计划阶段应先 acquire_port）`,
        };
      }

      if (hop.role === "ingress") {
        const next = listeningAt.get(hop.hop_index + 1);
        if (next === undefined) {
          return {
            ok: false,
            error_code: RELAY_DISPATCH_ERROR_CODES.agent_unreachable,
            error: "入口的下一跳没有就绪（正向必须先远后近）",
          };
        }
        const ingress = await this.dispatchIngress({
          tunnelId: input.tunnelId,
          revision: input.revision,
          ingressNode: node,
          ingressPort: port,
          nextHop: `${next.host}:${next.port}`,
          protocol: input.protocol,
          tlsCertPath: input.tlsCertPath ?? null,
          tlsKeyPath: input.tlsKeyPath ?? null,
        });
        if (!ingress.ok) return ingress;
        listeningAt.set(hop.hop_index, { host: next.host, port });
        continue;
      }

      const isEgress = hop.role === "egress";
      let targets: readonly { host: string; port: number; weight?: number; order_by?: number }[] | null;
      if (isEgress) {
        targets = input.targets;
      } else {
        const next = listeningAt.get(hop.hop_index + 1);
        targets = next === undefined ? null : [{ host: next.host, port: next.port, weight: 1, order_by: 10 }];
      }
      if (targets === null) {
        return {
          ok: false,
          error_code: RELAY_DISPATCH_ERROR_CODES.agent_unreachable,
          error: `hop ${hop.hop_index} 的下一跳没有就绪（正向必须先远后近）`,
        };
      }
      const dispatched = await this.dispatchEgress({
        tunnelId: input.tunnelId,
        revision: input.revision,
        egressNode: node,
        egressPort: port,
        poolId: isEgress ? input.poolId : null,
        targets,
        lbStrategy: isEgress ? input.lbStrategy : null,
        protocol: input.protocol,
      });
      if (!dispatched.ok) return dispatched;
      listeningAt.set(hop.hop_index, { host: dispatched.egress_host, port });
    }

    return { ok: true, plan: input.plan, hops_dispatched: hops.map((h) => h.hop_index) };
  }

  /* ---------------------------------------------------------------- */
  /* 归属事实（V5.3 WP9）                                              */
  /* ---------------------------------------------------------------- */

  /**
   * 本节点被授权承载该 Forward 的归属事实，或 nothing。
   *
   * 命令下发路径**必须**和快照路径一样带上它：V5 里"新事实只补了一条投递路径"已经踩过
   * 三次（协议、证书路径、健康），每次的症状都是"重启后静默失效"。归属这里更严重：
   * Agent 的 stale-epoch 栅栏以"见过的最高 epoch"为准，重启后若拿不到 epoch，它的栅栏
   * 就归零 —— 一个已被降级的节点会重新开始服务。
   */
  /**
   * 认领归属并返回要下发的归属事实；归属被别人持有且租约未过期时**拒绝下发**。
   *
   * 认领放在这里（与归属事实的附着同一处）有三个理由：
   *   1. 调用方不可能忘记认领 —— 忘了就没有 epoch，Agent 的栅栏就永远不生效（"实现存在
   *      但没有接线"在本项目已经出现过两次）；
   *   2. 两阶段交接在这一处统一执行：**旧租约未过期就不许换主人**，任何走这条路的调用方
   *      都自动获得这个保护；
   *   3. 同一节点的重新下发 = 续约（claim 对现任是幂等的），所以 reconcile/resend 不会
   *      把自己挡在门外。
   */
  /**
   * 显式释放入口归属（两阶段 handoff 的第一阶段）。
   *
   * 这里只改 ownership ledger；调用方必须先确认旧入口 runtime 已经撤下，才能
   * 调这个方法。把这条约束留在调用方，是因为只有 rollout 知道"旧 runtime 已
   * remove ACK"这个事实，placement-lease 模块本身不碰 Agent IO。
   */
  async releaseOwnership(input: {
    tunnelId: number;
    nodeId: number;
    now?: Date;
  }): Promise<{ ok: true } | { ok: false; reason: "not_owner" | "not_found" }> {
    return releasePlacementLease({
      tunnelId: input.tunnelId,
      nodeId: input.nodeId,
      now: input.now ?? new Date(),
    });
  }

  private async claimOwnership(
    tunnelId: number,
    nodeId: number,
    revision: number,
  ): Promise<
    | { ok: true; fields: { ownership_epoch?: number; lease_expires_at?: string } }
    | { ok: false; error: string }
  > {
    let claim: Awaited<ReturnType<typeof claimLease>> | null = null;
    try {
      claim = await claimLease({ tunnelId, nodeId, revision, now: new Date() });
    } catch {
      claim = null;
    }
    if (claim === null) {
      // 租约存储不可用（或无租约表可用，例如离线测试的桩）：**不下发 epoch，但也不拒绝**。
      //
      // 为什么不拒绝：面板侧的存储抖动不该变成数据面全量停发。安全方向由 Agent 侧保证 ——
      // 它的栅栏是"拒绝低于已见最高的 epoch"，而**缺席按 0 处理**，所以一个已经见过真实
      // epoch 的节点不会接受这次无 epoch 的激活（0 < highest ⇒ 拒绝）。于是"存储不可用"最多
      // 让**从未归属过**的隧道照常上线，而不会让被降级的节点复活。
      //
      // 注意这与"归属被别人持有且未过期"是两件事：那种情况 claim 会**成功返回** ok:false，
      // 必须拒绝下发（那才是双主风险）。
      return { ok: true, fields: {} };
    }
    if (!claim.ok) {
      return {
        ok: false,
        error:
          `归属仍由节点 ${claim.current?.owner_node_id ?? "?"} 持有（租约未过期）：` +
          "两阶段交接要求旧租约先过期或被显式释放，否则会同时服务两份流量",
      };
    }
    return {
      ok: true,
      fields: {
        ownership_epoch: claim.epoch,
        lease_expires_at: claim.lease.lease_expires_at.toISOString(),
      },
    };
  }

  /* ---------------------------------------------------------------- */
  /* 可达性                                                           */
  /* ---------------------------------------------------------------- */

  private async reachable(node: OrchestratorNode): Promise<DispatchFailure | null> {
    if (!this.probe) return null;
    if (!this.transport.isReachable) return null;
    try {
      const ok = await this.transport.isReachable(node);
      if (ok) return null;
    } catch (e) {
      return {
        ok: false,
        error_code: RELAY_DISPATCH_ERROR_CODES.agent_unreachable,
        error: `节点 ${node.node_id} 探测失败：${(e as Error)?.message ?? String(e)}`,
      };
    }
    return {
      ok: false,
      error_code: RELAY_DISPATCH_ERROR_CODES.agent_unreachable,
      error: `节点 ${node.node_id} 管理面不可达`,
    };
  }

  /* ---------------------------------------------------------------- */
  /* ⑥⑦ 出口下发                                                      */
  /* ---------------------------------------------------------------- */

  async dispatchEgress(input: DispatchEgressInput): Promise<EgressDispatchOutcome> {
    const egressId = input.runtimeId ?? Orchestrator.egressTunnelId(input.tunnelId);
    const resourceId = egressId;
    const protocol = input.protocol ?? DEFAULT_FORWARD_PROTOCOL;

    const unreachable = await this.reachable(input.egressNode);
    if (unreachable) return unreachable;

    const targets = input.targets.map((t, i) => ({
      host: t.host,
      port: t.port,
      weight: t.weight ?? 1,
      order: t.order_by ?? (i + 1) * 10,
    }));

    // V5.3 —— EGRESS **不认领归属**。
    //
    // 归属（placement ownership）属于**承载该 Forward 的那台入口节点**：RELAY 下客户端连的是入口
    // listener，被降级时必须停止服务的也是它。出口节点是一份**资源**（它只服务入口节点的流量），
    // 不是归属持有者。
    //
    // 第一版让出口腿也认领，于是出现一个自锁式的假故障：租约由入口节点（3）持有，出口侧向出口节点
    // （4）认领被两阶段规则正确地拒绝，**整条重发路径因此永久失败**（实测 `failed: 1`、池永远不更新）。
    // 规则没错，是问错了对象。

    // V5.2 WP7: the synthesized health travels BESIDE the desired targets, and a
    // failure to read it must never block a rollout — health is an optimization for
    // selection order, not a gate on whether a Forward may run. So a failure becomes
    // "no signal" (absent array), which the agent treats exactly like an older panel.
    let targetHealth: AgentTunnelConfig["target_health"];
    try {
      const health = await this.healthSource(input.targets.map((t) => ({ host: t.host, port: t.port })));
      targetHealth = health.length > 0 ? health : undefined;
    } catch {
      targetHealth = undefined;
    }

    const config: AgentTunnelConfig = {
      id: egressId,
      mode: "EGRESS",
      egress_port: input.egressPort,
      // EGRESS 模式不使用这两个字段，但 WP4 validate 要求结构完整
      //（ingress_port 仅在 DIRECT/RELAY 时强校验，这里给 0 表示不适用）。
      ingress_port: 0,
      remote_host: "",
      remote_port: 0,
      next_hop: "",
      targets,
      // Absent when there is no signal at all, so the wire says "nothing to say"
      // rather than "every target is unknown".
      ...(targetHealth ? { target_health: targetHealth } : {}),
      lb_strategy: normalizeLbStrategy(input.lbStrategy),
      protocol,
      speed_limit: 0,
      revision: input.revision,
    };

    // 经 WP6 工厂构造：坏 payload 在这里就抛，不会走到 Agent 才炸。
    const envelope = createCommand({
      resource: "tunnel",
      resource_id: resourceId,
      revision: input.revision,
      action: "apply_tunnel",
      payload: {
        tunnel: {
          name: egressId,
          tunnel_type: wireTunnelTypeForForwardProtocol(protocol),
          listen_port: input.egressPort,
          targets: targets.map((t) => ({ address: t.host, port: t.port, weight: t.weight })),
        },
      },
    });

    return this.send(input.egressNode, envelope, (ack) => {
      // EGRESS 隧道在 Agent 侧 bind 的就是 egress_port，回显必须一致。
      if (ack.applied_revision !== input.revision) {
        throw new AgentTransportError(
          RELAY_DISPATCH_ERROR_CODES.revision_mismatch,
          `出口 ACK revision=${ack.applied_revision} 与下发 revision=${input.revision} 不符`,
        );
      }
      return {
        ok: true as const,
        result: { commandId: envelope.command_id, revision: ack.applied_revision ?? input.revision, ack },
        egress_host: transportHost(this.transport, input.egressNode),
        egress_port: input.egressPort,
      };
    }, config);
  }

  /* ---------------------------------------------------------------- */
  /* ⑧⑨ 入口下发                                                      */
  /* ---------------------------------------------------------------- */

  async dispatchIngress(input: DispatchIngressInput): Promise<RelayDispatchOutcome> {
    // V5.3：RELAY 的**归属持有者是入口节点**（客户端连的 listener 在它身上，被降级时必须
    // 停止服务的也是它），所以认领发生在这里，而不是在出口腿。
    const relayId = input.runtimeId ?? Orchestrator.relayTunnelId(input.tunnelId);
    const protocol = input.protocol ?? DEFAULT_FORWARD_PROTOCOL;

    const unreachable = await this.reachable(input.ingressNode);
    if (unreachable) return unreachable;

    // next_hop 必须形如 host:port。缺它 = 调用方跳过了 dispatchEgress，
    // 那正是铁律要防的（入口先于出口启动）。
    const hop = splitNextHop(input.nextHop);
    if (!hop) {
      return {
        ok: false,
        error_code: RELAY_DISPATCH_ERROR_CODES.node_unaddressable,
        error: `next_hop 非法（${input.nextHop}），拒绝启动入口`,
      };
    }

    // The RELAY listener is client-facing, so this is where TLS terminates.
    // V5.3：RELAY 的**归属持有者是入口节点**（客户端连的 listener 在它身上，被降级时必须停止
    // 服务的也是它），所以认领发生在这里，而不是在出口腿 —— 出口节点是一份资源，不是归属持有者。
    // runtimeId 非空 = 联邦远端腿：归属由 federation_lease 的 lease_epoch 表达（见入参注释），
    // 因此**不**认领本地归属 —— 那会写出一条指向不存在隧道的 placement_lease。
    let ownershipFields: Record<string, unknown> = {};
    if (input.runtimeId === undefined) {
      const ownership = await this.claimOwnership(input.tunnelId, input.ingressNode.id, input.revision);
      if (!ownership.ok) {
        return { ok: false, error_code: RELAY_DISPATCH_ERROR_CODES.agent_unreachable, error: ownership.error };
      }
      ownershipFields = ownership.fields;
    }

    const tlsFields = Orchestrator.tlsFields(protocol, input);
    const config: AgentTunnelConfig = {
      id: relayId,
      mode: "RELAY",
      ingress_port: input.ingressPort,
      egress_port: hop.port,
      remote_host: hop.host,
      remote_port: hop.port,
      next_hop: input.nextHop,
      targets: [], // RELAY 侧不持有目标知识（目标在出口节点上）
      lb_strategy: "ROUND_ROBIN",
      protocol,
      speed_limit: 0,
      revision: input.revision,
      ...tlsFields,
      ...ownershipFields,
    };

    const envelope = createCommand({
      resource: "tunnel",
      resource_id: relayId,
      revision: input.revision,
      action: "apply_tunnel",
      payload: {
        tunnel: {
          name: relayId,
          tunnel_type: wireTunnelTypeForForwardProtocol(protocol),
          ...tlsFields,
          listen_port: input.ingressPort,
          // 入口侧的唯一「目标」是出口节点；WP6 的 targets 只是为了让信封
          // 结构合法（apply_tunnel 要求非空），Agent 的 RELAY forwarder 不读它。
          targets: [{ address: hop.host, port: hop.port }],
          listen_ip: undefined,
        },
      },
    });

    return this.send(input.ingressNode, envelope, (ack) => {
      if (ack.applied_revision !== input.revision) {
        throw new AgentTransportError(
          RELAY_DISPATCH_ERROR_CODES.revision_mismatch,
          `入口 ACK revision=${ack.applied_revision} 与下发 revision=${input.revision} 不符`,
        );
      }
      return {
        ok: true as const,
        result: { commandId: envelope.command_id, revision: ack.applied_revision ?? input.revision, ack },
      };
    }, config);
  }

  /* ---------------------------------------------------------------- */
  /* DIRECT 下发                                                       */
  /* ---------------------------------------------------------------- */

  async dispatchDirect(input: DispatchDirectInput): Promise<RelayDispatchOutcome> {
    const directId = Orchestrator.directTunnelId(input.tunnelId);
    const protocol = input.protocol ?? DEFAULT_FORWARD_PROTOCOL;
    const unreachable = await this.reachable(input.ingressNode);
    if (unreachable) return unreachable;

    // The DIRECT listener is client-facing, so this is where TLS terminates.
    const tlsFields = Orchestrator.tlsFields(protocol, input);
    const ownership = await this.claimOwnership(input.tunnelId, input.ingressNode.id, input.revision);
    if (!ownership.ok) {
      return { ok: false, error_code: RELAY_DISPATCH_ERROR_CODES.agent_unreachable, error: ownership.error };
    }

    const config: AgentTunnelConfig = {
      id: directId,
      mode: "DIRECT",
      ingress_port: input.ingressPort,
      egress_port: 0,
      remote_host: input.remoteHost,
      remote_port: input.remotePort,
      next_hop: "",
      targets: [],
      lb_strategy: "ROUND_ROBIN",
      protocol,
      speed_limit: 0,
      revision: input.revision,
      ...tlsFields,
      ...ownership.fields,
      ...(input.listenHost ? { listen_host: input.listenHost } : {}),
    };

    const envelope = createCommand({
      resource: "tunnel",
      resource_id: directId,
      revision: input.revision,
      action: "apply_tunnel",
      payload: {
        tunnel: {
          name: directId,
          tunnel_type: wireTunnelTypeForForwardProtocol(protocol),
          ...tlsFields,
          listen_port: input.ingressPort,
          targets: [{ address: input.remoteHost, port: input.remotePort }],
          ...(input.listenHost ? { listen_ip: input.listenHost } : {}),
        },
      },
    });

    return this.send(input.ingressNode, envelope, (ack) => {
      if (ack.applied_revision !== input.revision) {
        throw new AgentTransportError(
          RELAY_DISPATCH_ERROR_CODES.revision_mismatch,
          `DIRECT ACK revision=${ack.applied_revision} 与下发 revision=${input.revision} 不符`,
        );
      }
      return {
        ok: true as const,
        result: { commandId: envelope.command_id, revision: ack.applied_revision ?? input.revision, ack },
      };
    }, config);
  }

  /* ---------------------------------------------------------------- */
  /* 补偿：撤隧道                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * 从一台节点上撤下隧道（补偿路径）。
   *
   * 用 `revision + 1` 而不是失败那次 revision：Agent 的闸门是
   * 「applied_revision ≥ incoming → 拒绝 stale」。若失败的那次已经推进了
   * `applied_revision`，用同一 revision 重发会被判 stale 而撤不掉——
   * 补偿就会静默失效，出口端口继续被占。加 1 保证 remove 能过去。
   *
   * 幂等：Agent 侧未知 id 返回 ok（WP4 `manager.Remove` 对未知 id 是 no-op），
   * 因此补偿重复执行是安全的。
   */
  async removeTunnel(input: RemoveTunnelInput): Promise<RelayDispatchOutcome> {
    const id =
      input.runtimeId ??
      (input.direction === "egress"
        ? Orchestrator.egressTunnelId(input.tunnelId)
        : input.direction === "direct"
          ? Orchestrator.directTunnelId(input.tunnelId)
          : Orchestrator.relayTunnelId(input.tunnelId));

    const unreachable = await this.reachable(input.node);
    if (unreachable) return unreachable;

    // remove 既要“同一次意图重试稳定”，又不能只按 resource+revision 生成 ID：
    // compensation / drain / suspend 可能合法地在同一 revision 对同一 runtime 发
    // 不同 remove；若共用 command_id，validator 会因 payload.reason 不同报
    // duplicate_command_id。把规范化 reason 的短 hash 纳入 ID：同意图重试仍命中
    // 同一幂等键，不同意图则不会互相占用。总长严格限制在协议的 64 字符上界内。
    const reason = (input.reason ?? "compensation").slice(0, 255);
    const intent = createHash("sha256").update(reason).digest("hex").slice(0, 10);
    const suffix = `-rm-r${input.revision}-${intent}`;
    const commandId = `${id.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`;
    const envelope = createCommand({
      resource: "tunnel",
      resource_id: id,
      revision: input.revision,
      action: "remove_tunnel",
      command_id: commandId,
      payload: { reason },
    });

    return this.send(input.node, envelope, (ack) => ({
      ok: true as const,
      result: { commandId: envelope.command_id, revision: ack.applied_revision ?? input.revision, ack },
    }), null);
  }

  /* ---------------------------------------------------------------- */
  /* 公共发送路径                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * 走 transport 发一次配置，再把 Agent 的 HTTP 响应翻成 WP6 `command_ack`
   * 信封，最后过一遍 {@link ControlValidator}。
   *
   * 为什么 ACK 也要过 validator：`command_ack` 是 §7.9 冻结的六种命令之一，
   * 它的校验规则（acked_command_id 必须在账本里、回显字段必须一致）能挡住
   * 「一次伪造/错投的 ACK 把命令 A 的结果记到命令 B 头上」。代价是下发侧
   * 必须先 `handle` 一次下发信封把自己记进账本——所以 {@link send} 里
   * 先 `validator.handle(envelope, noopApplier)` 再发网络请求。
   */
  private async send<T>(
    node: OrchestratorNode,
    envelope: CommandEnvelope,
    onAck: (ack: CommandAck) => T,
    config: AgentTunnelConfig | null,
  ): Promise<T | DispatchFailure> {
    // ① 记入下发账本（幂等重放的依据；同 command_id 重发拿 duplicate）。
    const selfAck = await this.validator.handle(envelope, () => ({ status: "active" as ResourceStatus }));
    if (selfAck.status === "rejected") {
      return {
        ok: false,
        error_code: RELAY_DISPATCH_ERROR_CODES.ack_invalid,
        // 带上 command_id：调用方要能凭它去账本查「这条命令到底什么状态」，
        // 不能只拿到一句「本地校验拒绝」就完了。
        commandId: envelope.command_id,
        error: `本地校验拒绝本命令：${selfAck.error_code ?? "?"} ${selfAck.error ?? ""}`,
      };
    }

    // ② 真正发到 Agent。EGRESS / RELAY 走同一 `POST /tunnel`，只是 payload 的
    //    mode 不同；remove 走 DELETE（HttpAgentTransport 内部按方法分发）。
    let raw: unknown;
    try {
      if (envelope.action === "apply_tunnel") {
        if (config === null) {
          return {
            ok: false,
            error_code: RELAY_DISPATCH_ERROR_CODES.ack_invalid,
            error: "apply 下发缺少 AgentTunnelConfig（编码错误）",
          };
        }
        raw = await (config.mode === "EGRESS"
          ? this.transport.applyEgress(node, config, envelope)
          : config.mode === "DIRECT"
            ? this.transport.applyDirect(node, config, envelope)
            : this.transport.applyRelay(node, config, envelope));
      } else if (envelope.action === "remove_tunnel") {
        raw = await this.transport.removeTunnel(node, envelope.resource_id, envelope);
      } else {
        return {
          ok: false,
          error_code: RELAY_DISPATCH_ERROR_CODES.ack_invalid,
          error: `orchestrator 不支持的 action: ${envelope.action}`,
        };
      }
    } catch (e) {
      // AgentTransportError 已带编排错误码（node_unaddressable / agent_rejected
      // / agent_unreachable），直接透传；别的异常按 unreachable 记 —— 我们不知道
      // Agent 有没有真应用成功，不能断言 applied。
      const code =
        e instanceof AgentTransportError ? e.code : RELAY_DISPATCH_ERROR_CODES.agent_unreachable;
      return {
        ok: false,
        error_code: code,
        commandId: envelope.command_id,
        error: `下发 ${envelope.action} 到 ${node.node_id} 失败：${(e as Error)?.message ?? String(e)}`,
      };
    }

    // ②b Agent 的响应体是权威：HTTP 200 只代表「收到了」，`{ok:false}` 代表
    //     「拒了」。忽略它会把一次拒绝当成成功，tunnel 永远卡在 pending。
    const ack = parseAgentAck(raw);
    if (!ack.ok) {
      // Agent 侧的 stale（HTTP 409）应由 transport 抛 AgentTransportError，
      // 走到这里说明是响应体里的显式拒绝。统一按 ack_invalid 记：只有
      // revision_mismatch 有专门的错误码（它表示「对端版本和我们不一致」，
      // 排障时要去比对账本）。stale 属于 validator 已拦过的前置条件，
      // 真到达 Agent 那一层时更接近 ack_invalid 而不是独立的编排类。
      const code =
        ack.error_code === "revision_mismatch"
          ? RELAY_DISPATCH_ERROR_CODES.revision_mismatch
          : RELAY_DISPATCH_ERROR_CODES.ack_invalid;
      return {
        ok: false,
        error_code: code,
        commandId: envelope.command_id,
        error: `${node.node_id} 拒绝 ${envelope.action}：${ack.error || ack.error_code || "unknown"}`,
      };
    }

    // ③ 把「HTTP 200 + {ok:true}」折叠成一条 command_ack 信封。
    let ackEnvelope: CommandEnvelope;
    try {
      ackEnvelope = createCommand({
        resource: envelope.resource,
        resource_id: envelope.resource_id,
        revision: envelope.revision,
        action: "command_ack",
        payload: {
          acked_command_id: envelope.command_id,
          // Agent 回显 applied_revision；没有就给下发值（老版本 agent）。
          applied_revision: ack.applied_revision ?? envelope.revision,
          status: "applied",
        },
      });
    } catch (e) {
      const code =
        e instanceof AgentTransportError ? e.code : RELAY_DISPATCH_ERROR_CODES.agent_unreachable;
      const msg = e instanceof Error ? e.message : String(e);
      // transport 失败 = 命令没到/没成。回一条 failed ack 让 validator 记账：
      // 失败不推进 applied_revision，同 revision 重试仍会真的重发。
      await this.validator
        .handle(
          createCommand({
            resource: envelope.resource,
            resource_id: envelope.resource_id,
            revision: envelope.revision,
            action: "command_ack",
            payload: {
              acked_command_id: envelope.command_id,
              applied_revision: null,
              status: "failed",
              error_code: "apply_failed",
              error: msg.slice(0, 255),
            },
          }),
          () => undefined,
        )
        .catch(() => undefined);
      return { ok: false, error_code: code, error: msg, commandId: envelope.command_id };
    }

    // ④ ACK 过闸门：账本一致性 / 回显一致性都在这里校验。
    const ackResult = await this.validator.handle(ackEnvelope, () => ({ status: "active" as ResourceStatus }));
    if (ackResult.status === "rejected") {
      return {
        ok: false,
        error_code:
          ackResult.error_code === "revision_mismatch"
            ? RELAY_DISPATCH_ERROR_CODES.revision_mismatch
            : RELAY_DISPATCH_ERROR_CODES.ack_invalid,
        error: `ACK 被拒：${ackResult.error_code ?? "?"} ${ackResult.error ?? ""}`,
        commandId: envelope.command_id,
      };
    }
    if (ackResult.status === "failed") {
      return {
        ok: false,
        error_code: RELAY_DISPATCH_ERROR_CODES.ack_failed,
        error: ackResult.error ?? "Agent 报告执行失败",
        commandId: envelope.command_id,
      };
    }

    try {
      return onAck(ackResult);
    } catch (e) {
      if (e instanceof AgentTransportError) {
        return { ok: false, error_code: e.code, error: e.message, commandId: envelope.command_id };
      }
      throw e;
    }
  }

  /** 只读出口：当前校验器的 revision 闸门状态（WP9 reconciler 会用）。 */
  snapshot(resource_id: string) {
    return this.validator.snapshot("tunnel", resource_id);
  }
}

/* ================================================================== */
/* 助手                                                                */
/* ================================================================== */

/** 节点地址解析（从 transport 实例反推 host；HTTP 实现用的就是这个规则）。 */
function transportHost(transport: AgentTransport, node: OrchestratorNode): string {
  if (transport instanceof HttpAgentTransport) {
    try {
      // hostFor 是 private，这里用同样的规则再算一次（保持单一事实：
      // 规则只有一处实现，改的话两边都要改——所以抽成模块级函数）。
      const raw = String(node.connect_ip ?? "").trim();
      const first = raw.split(",").map((s) => s.trim()).find(Boolean) ?? "";
      return first.includes(":") && !first.startsWith("[") ? `[${first}]` : first;
    } catch {
      return "";
    }
  }
  // 非 HTTP transport：回退到 connect_ip 首项，让调用方自己解释。
  return String(node.connect_ip ?? "").split(",")[0]?.trim() ?? "";
}

/** 严格解析 `host:port`（next_hop 的形状）。 */
export function splitNextHop(value: string): { host: string; port: number } | null {
  const raw = String(value ?? "").trim();
  if (raw === "") return null;
  const v6 = /^\[([0-9a-fA-F:.]+)\]:(.+)$/.exec(raw);
  if (v6) {
    const port = Number(v6[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host: v6[1]!, port };
  }
  const at = raw.lastIndexOf(":");
  if (at <= 0) return null;
  const host = raw.slice(0, at);
  const port = Number(raw.slice(at + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (host === "" || host.includes(":")) return null; // 裸 IPv6 必须带方括号
  return { host, port };
}

/** DB 的 LBStrategy（round/rand）→ Agent 的 LBStrategy（ROUND_ROBIN/...）。 */
export function normalizeLbStrategy(value: string | null | undefined): AgentTunnelConfig["lb_strategy"] {
  switch (String(value ?? "").trim().toLowerCase()) {
    case "rand":
    case "random":
      return "RANDOM";
    case "weighted_round":
    case "weighted_round_robin":
      // WP4 的 LoadBalancer 接受该串并退化为等权轮询（见 lb.go 注释）；
      // v1.1 真正的平滑加权落地前，显式传它就是显式记录意图。
      return "WEIGHTED_ROUND_ROBIN";
    default:
      return "ROUND_ROBIN";
  }
}

/** 命令动作联合的类型守卫（供测试/上层复用）。 */
export function isApplyAction(action: CommandAction): boolean {
  return action === "apply_tunnel";
}
