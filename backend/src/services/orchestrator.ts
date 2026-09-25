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

import {
  ControlValidator,
  createCommand,
  type CommandAck,
  type CommandEnvelope,
} from "./control-protocol/index.ts";
import type { CommandAction, ResourceStatus } from "./control-protocol/index.ts";

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
  mode: "EGRESS" | "RELAY";
  ingress_port: number;
  egress_port: number;
  remote_host: string;
  remote_port: number;
  /** RELAY 模式必填：`<egress node ip>:<egress port>`（validate 会强校验）。 */
  next_hop: string;
  targets: { host: string; port: number; weight: number; order: number }[];
  lb_strategy: "ROUND_ROBIN" | "RANDOM" | "WEIGHTED_ROUND_ROBIN";
  protocol: "tcp";
  speed_limit: number;
  revision: number;
  listen_host?: string;
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
  /** 命令没到 Agent：DNS / 连接拒绝 / 超时。 */
  agent_unreachable: "agent_unreachable",
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
  applyEgress(node: OrchestratorNode, config: AgentTunnelConfig): Promise<unknown>;
  /** 在入口节点上应用/替换一条 RELAY 隧道。 */
  applyRelay(node: OrchestratorNode, config: AgentTunnelConfig): Promise<unknown>;
  /** 下线一条隧道（补偿路径；幂等，Agent 侧未知 id 返回 ok）。 */
  removeTunnel(node: OrchestratorNode, tunnelId: string): Promise<unknown>;
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

  removeTunnel(node: OrchestratorNode, tunnelId: string): Promise<unknown> {
    return this.post(node, `/tunnel?id=${encodeURIComponent(tunnelId)}`, {});
  }
}

/* ================================================================== */
/* Orchestrator                                                        */
/* ================================================================== */

export interface DispatchEgressInput {
  tunnelId: number;
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
}

export interface DispatchIngressInput {
  tunnelId: number;
  revision: number;
  ingressNode: OrchestratorNode;
  ingressPort: number;
  /** `<egress ip>:<egress port>`，来自 {@link dispatchEgress} 的返回值。 */
  nextHop: string;
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
  /** 在哪台节点上撤。RELAY 的补偿必须知道撤的是哪一端。 */
  node: OrchestratorNode;
  /** 补偿用的 revision：比失败的那次高 1（让 Agent 侧的闸门放行）。 */
  revision: number;
  reason?: string;
}

export interface OrchestratorOptions {
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

  constructor(opts: OrchestratorOptions) {
    this.transport = opts.transport;
    this.validator = opts.validator ?? new ControlValidator();
    this.probe = opts.probeReachable ?? true;
  }

  /* ---------------------------------------------------------------- */
  /* 命令构造                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * 出口侧隧道 id：`tunex-<tunnelId>-egress`。
   * 加方向后缀是必须的——同一 `tunnelId` 在入口节点上是 RELAY、在出口节点上
   * 是 EGRESS，两者若共用一个 id，Agent 的 `map[id]` 会互相覆盖
   * （BOTH 节点同机部署时尤其致命）。
   */
  static egressTunnelId(tunnelId: number): string {
    return `tunex-${tunnelId}-egress`;
  }

  /** 入口侧隧道 id：`tunex-<tunnelId>-relay`。 */
  static relayTunnelId(tunnelId: number): string {
    return `tunex-${tunnelId}-relay`;
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
    const egressId = Orchestrator.egressTunnelId(input.tunnelId);
    const resourceId = egressId;

    const unreachable = await this.reachable(input.egressNode);
    if (unreachable) return unreachable;

    const targets = input.targets.map((t, i) => ({
      host: t.host,
      port: t.port,
      weight: t.weight ?? 1,
      order: t.order_by ?? (i + 1) * 10,
    }));

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
      lb_strategy: normalizeLbStrategy(input.lbStrategy),
      protocol: "tcp",
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
          tunnel_type: "tcp",
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
    const relayId = Orchestrator.relayTunnelId(input.tunnelId);

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
      protocol: "tcp",
      speed_limit: 0,
      revision: input.revision,
    };

    const envelope = createCommand({
      resource: "tunnel",
      resource_id: relayId,
      revision: input.revision,
      action: "apply_tunnel",
      payload: {
        tunnel: {
          name: relayId,
          tunnel_type: "tcp",
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
      input.node.role === "egress"
        ? Orchestrator.egressTunnelId(input.tunnelId)
        : Orchestrator.relayTunnelId(input.tunnelId);

    const unreachable = await this.reachable(input.node);
    if (unreachable) return unreachable;

    // 补偿撤下必须**幂等**：同一条 remove 重发要拿到同一个 command_id，
    // 否则 validator 的去重闸门会把它当成另一条新命令，且 Agent 侧看到的是
    // 两个不同幂等键 —— 第一次已删、第二次「又删一遍」在多数实现里是 no-op，
    // 但账本里会留下两条不可对齐的记录。
    const commandId = `tunex-${id}-remove-r${input.revision}`;
    const envelope = createCommand({
      resource: "tunnel",
      resource_id: id,
      revision: input.revision,
      action: "remove_tunnel",
      command_id: commandId,
      payload: { reason: (input.reason ?? "compensation").slice(0, 255) },
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
          ? this.transport.applyEgress(node, config)
          : this.transport.applyRelay(node, config));
      } else if (envelope.action === "remove_tunnel") {
        raw = await this.transport.removeTunnel(node, envelope.resource_id);
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
