/**
 * V5-WP0 — canonical Forward protocol/topology contract.
 *
 * This module deliberately does NOT mirror Prisma's legacy TunnelType enum.
 * TunnelType contains historical implementation/wrapper names (wss/mtls/tunex...)
 * and "the enum contains a value" must never be interpreted as "the product
 * supports it". V5 protocols become product-visible only by being added here
 * together with their independent Gate.
 */

export const FORWARD_MODES = ["direct", "relay"] as const;
export type ForwardMode = (typeof FORWARD_MODES)[number];

export const FORWARD_PROTOCOLS = ["tcp"] as const;
export type ForwardProtocol = (typeof FORWARD_PROTOCOLS)[number];

/**
 * Enabled transport contracts. Transport is derived from protocol and is NOT a
 * second user/DB field. Datagram is intentionally absent until its own runtime
 * abstraction + Gate are opened.
 */
export const FORWARD_TRANSPORTS = ["stream"] as const;
export type ForwardTransport = (typeof FORWARD_TRANSPORTS)[number];

export interface ForwardTransportSpec {
  readonly lifecycle: "connection";
}

export const FORWARD_TRANSPORT_SPECS: Readonly<
  Record<ForwardTransport, ForwardTransportSpec>
> = {
  stream: { lifecycle: "connection" },
};

export interface ForwardProtocolSpec {
  readonly transport: ForwardTransport;
  /** Compatibility value written to legacy Tunnel.tunnel_type while it exists. */
  readonly legacy_tunnel_type: string;
}

export const DEFAULT_FORWARD_PROTOCOL: ForwardProtocol = "tcp";

export const FORWARD_PROTOCOL_SPECS: Readonly<
  Record<ForwardProtocol, ForwardProtocolSpec>
> = {
  tcp: { transport: "stream", legacy_tunnel_type: "tcp" },
};

export function normalizeForwardTransport(
  value: unknown,
): ForwardTransport | null {
  if (
    typeof value === "string" &&
    (FORWARD_TRANSPORTS as readonly string[]).includes(value)
  ) {
    return value as ForwardTransport;
  }
  return null;
}

export function isForwardMode(value: unknown): value is ForwardMode {
  return (
    typeof value === "string" &&
    (FORWARD_MODES as readonly string[]).includes(value)
  );
}

/**
 * Canonicalise a persisted protocol fact without deciding whether the current
 * runtime admits it. This preserves historical legacy facts (wss/tls/udp/...)
 * instead of silently relabelling them as TCP.
 */
export function protocolFactName(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_FORWARD_PROTOCOL;
  }
  if (typeof value !== "string") {
    throw new Error("invalid persisted Forward protocol: " + String(value));
  }
  const name = value.trim().toLowerCase();
  if (name === "") return DEFAULT_FORWARD_PROTOCOL;
  if (name.length > 16) {
    throw new Error("invalid persisted Forward protocol: " + name);
  }
  return name;
}

/**
 * Admission parser. Missing stays V4-compatible TCP; an explicit historical or
 * future protocol is rejected until it is added to FORWARD_PROTOCOLS and has
 * its independent Gate.
 */
export function normalizeForwardProtocol(
  value: unknown,
): ForwardProtocol | null {
  let name: string;
  try {
    name = protocolFactName(value);
  } catch {
    return null;
  }
  if ((FORWARD_PROTOCOLS as readonly string[]).includes(name)) {
    return name as ForwardProtocol;
  }
  return null;
}

/**
 * Read the persisted protocol fact. forward_protocol wins; old rows fall back
 * to legacy tunnel_type so migrations never erase what protocol they actually
 * represented. Whether that fact is executable is checked separately.
 */
export function persistedForwardProtocol(
  value: unknown,
  legacyTunnelType?: unknown,
): string {
  if (value !== undefined && value !== null && value !== "") {
    return protocolFactName(value);
  }
  return protocolFactName(legacyTunnelType);
}

export function legacyTunnelTypeForForwardProtocol(
  protocol: ForwardProtocol,
): string {
  return FORWARD_PROTOCOL_SPECS[protocol].legacy_tunnel_type;
}

/* ================================================================== */
/* RuntimePlan（V5-WP0 立形，V5-WP2 补全为可用的纯计划）                  */
/* ================================================================== */

/**
 * 一次下发**在哪两台节点上**发生。
 *
 * 刻意是 id（而不是 Node 对象）：计划要能被序列化、比较、写进 Gate 证据，
 * 一旦装进对象就必然有人开始从计划里读实时状态——那会让"计划"变成第二份
 * desired state 真相，正是 §1.4 禁止的。
 */
export interface ForwardRuntimePlacement {
  readonly ingress_node_id: number | null;
  readonly egress_node_id: number | null;
  readonly egress_pool_id: number | null;
}

/**
 * 入口 listener 的事实。`null` 一律表示**尚未确定**，不是 0：
 * `port` 为 null = 还没分配端口（启动前必须先分配），`host` 为 null = 面板不指定
 * 绑定地址（Agent 用自己的默认）。把 null 写成 0 会让"未分配"看起来像一个
 * 真实端口。
 */
export interface ForwardRuntimeListenerFacts {
  readonly host: string | null;
  readonly port: number | null;
}

/**
 * 流量的远端事实。
 *
 * `targets` 是**运维配置的那一份**（产品层目标池），`next_hop` 是 RELAY 的内部
 * 一跳（`<egress host>:<egress port>`），仅 RELAY 有。
 *
 * 两者都在计划里，不是为了展示，而是为了让 Gate 能断言
 * 「计划里的远端 == 实际下发到 Agent 的远端」。少了它，协议/传输对了但目标指错
 * 的配置仍然会通过契约检查。
 */
export interface ForwardRuntimeUpstreamFacts {
  readonly targets: readonly { readonly host: string; readonly port: number }[];
  readonly next_hop: string | null;
}

/**
 * `RuntimePlan`：**纯计划**，不含 socket、不含 goroutine、不含任何可失败的资源。
 *
 * WP2 的职责是把它补全成一个"能回答后续所有协议/HA/multi-hop 需要的问题"的
 * 形状，而不引入第二份真相：
 *
 *   topology  —— 用户选的拓扑（direct / relay）
 *   protocol  —— 产品协议（当前只有 tcp）
 *   transport —— 由 protocol 派生（当前只有 stream）
 *   revision  —— 这份计划对应的 config revision
 *   placement —— 下发到哪两台节点、哪个出口池
 *   listener  —— 入口绑定事实
 *   upstream  —— 远端事实
 *
 * WP2 仍然只生成 TCP/stream 计划：这里没有任何"未来协议"的字段。
 */
export interface ForwardRuntimePlan {
  readonly topology: { readonly mode: ForwardMode };
  readonly protocol: {
    readonly name: ForwardProtocol;
  };
  readonly transport: {
    readonly name: ForwardTransport;
    readonly lifecycle: ForwardTransportSpec["lifecycle"];
  };
  readonly revision: number;
  readonly placement: ForwardRuntimePlacement;
  readonly listener: ForwardRuntimeListenerFacts;
  readonly upstream: ForwardRuntimeUpstreamFacts;
}

/** 计划里尚未确定的事实（WP0 调用方保持可用的默认值）。 */
export const EMPTY_FORWARD_RUNTIME_PLACEMENT: ForwardRuntimePlacement = Object.freeze({
  ingress_node_id: null,
  egress_node_id: null,
  egress_pool_id: null,
});

/** 计划的默认 revision：0 = 「这份计划没有绑定任何 revision」。 */
export const UNBOUND_FORWARD_RUNTIME_REVISION = 0;

/** `buildForwardRuntimePlan` 的可选事实入参。 */
export interface ForwardRuntimePlanFacts {
  revision?: number;
  placement?: Partial<ForwardRuntimePlacement>;
  listener?: Partial<ForwardRuntimeListenerFacts>;
  upstream?: Partial<ForwardRuntimeUpstreamFacts>;
}

/**
 * 构造纯计划。
 *
 * 前两个参数是 WP0 的冻结签名：不传 `facts` 时得到的就是 WP0 的那个最小计划
 * （外加一组显式的"尚未确定"事实），所以既有调用方无需改动。
 */
export function buildForwardRuntimePlan(
  mode: ForwardMode,
  protocol: ForwardProtocol = DEFAULT_FORWARD_PROTOCOL,
  facts: ForwardRuntimePlanFacts = {},
): ForwardRuntimePlan {
  if (!isForwardMode(mode)) {
    throw new Error("unsupported Forward mode: " + String(mode));
  }
  const spec = FORWARD_PROTOCOL_SPECS[protocol];
  if (!spec) {
    throw new Error("unsupported Forward protocol: " + String(protocol));
  }
  const transport = normalizeForwardTransport(spec.transport);
  if (transport === null) {
    throw new Error("unsupported Forward transport: " + String(spec.transport));
  }
  return {
    topology: { mode },
    protocol: { name: protocol },
    transport: {
      name: transport,
      lifecycle: FORWARD_TRANSPORT_SPECS[transport].lifecycle,
    },
    revision: facts.revision ?? UNBOUND_FORWARD_RUNTIME_REVISION,
    placement: { ...EMPTY_FORWARD_RUNTIME_PLACEMENT, ...facts.placement },
    listener: { host: facts.listener?.host ?? null, port: facts.listener?.port ?? null },
    upstream: {
      targets: facts.upstream?.targets ?? [],
      next_hop: facts.upstream?.next_hop ?? null,
    },
  };
}

/**
 * 计划的**内部一致性**检查，返回违规清单（空 = 通过）。
 *
 * 为什么需要一个校验函数而不是只定义类型：这些规则用类型表达不了，而它们恰好是
 * 「协议对了、传输对了，但计划自相矛盾」的那一类错误——例如 RELAY 计划没有
 * next_hop、DIRECT 计划却带着出口节点。Gate V5-G0 与后续协议都会读计划，
 * 与其每个消费者各自假设，不如在这里一次说清。
 *
 * 纯函数，不抛：调用方（Gate、诊断、未来协议）需要把违规当成数据收集起来。
 */
export function forwardRuntimePlanViolations(plan: ForwardRuntimePlan): string[] {
  const out: string[] = [];

  // transport 必须**派生自** protocol，不能被独立填写。
  const derived = FORWARD_PROTOCOL_SPECS[plan.protocol.name]?.transport;
  if (derived === undefined) {
    out.push(`unknown protocol ${plan.protocol.name}`);
  } else if (derived !== plan.transport.name) {
    out.push(`transport ${plan.transport.name} does not carry protocol ${plan.protocol.name}`);
  } else if (FORWARD_TRANSPORT_SPECS[plan.transport.name].lifecycle !== plan.transport.lifecycle) {
    out.push(`transport ${plan.transport.name} lifecycle mismatch`);
  }

  if (!Number.isInteger(plan.revision) || plan.revision < 0) {
    out.push(`revision ${String(plan.revision)} is not a non-negative integer`);
  }

  const port = plan.listener.port;
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    out.push(`listener port ${String(port)} is not a valid TCP port`);
  }

  if (plan.topology.mode === "direct") {
    if (plan.placement.egress_node_id !== null) {
      out.push("DIRECT plan must not have an egress node");
    }
    if (plan.placement.egress_pool_id !== null) {
      out.push("DIRECT plan must not have an egress pool");
    }
    if (plan.upstream.next_hop !== null) {
      out.push("DIRECT plan must not have a next_hop");
    }
  } else {
    if (plan.placement.egress_node_id === null) {
      out.push("RELAY plan needs an egress node");
    }
    if (plan.upstream.next_hop === null || !/^.+:\d{1,5}$/.test(plan.upstream.next_hop)) {
      out.push("RELAY plan needs a <host>:<port> next_hop");
    }
  }

  for (const [index, target] of plan.upstream.targets.entries()) {
    if (typeof target.host !== "string" || target.host.trim() === "") {
      out.push(`upstream target ${index} has no host`);
    }
    if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) {
      out.push(`upstream target ${index} has an invalid port`);
    }
  }

  return out;
}
