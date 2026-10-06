/**
 * Canonical Forward protocol/topology contract.
 *
 * Product support is defined here, not by the historical Prisma TunnelType enum.
 * A protocol becomes usable only when parser, runtime, capability advertisement
 * and regression coverage agree on it. Legacy DB projection is compatibility
 * metadata and never a product-support signal.
 */

export const FORWARD_MODES = ["direct", "relay"] as const;
export type ForwardMode = (typeof FORWARD_MODES)[number];

/**
 * Product protocols the runtime has opened.
 *
 * A value lands here only together with its own Gate (regression coverage established the
 * "enum presence is not product support" rule;  enforced it). V5.1a adds
 * `tls` — the same stream lifecycle with a TLS-terminated client-facing listener
 * (DEVELOPMENT.md §6.1). `ws` follows in . `udp` follows in V5.1b
 * (DEVELOPMENT.md §6.2, `docs/v5-1b-datagram-contract-draft.md`), and it is the
 * first protocol whose TRANSPORT is not `stream`; `quic` comes last.
 */
export const FORWARD_PROTOCOLS = ["tcp", "tls", "ws", "udp"] as const;
export type ForwardProtocol = (typeof FORWARD_PROTOCOLS)[number];

/**
 * Enabled transport contracts. Transport is derived from protocol and is NOT a
 * second user/DB field.
 *
 * V5.1b adds `datagram` (DEVELOPMENT.md §6.2). It is a TRANSPORT and not a
 * protocol because the transport dimension is already defined over how the bytes
 * or packets actually move, and because the same protocol can be imagined over a
 * different transport — while the user-facing dimension stays `protocol`.
 *
 * The lifecycle differs, and that difference is the whole reason this is a second
 * transport rather than a flag on the first: a stream tunnel's unit of work is a
 * CONNECTION that exists until someone closes it, while a datagram tunnel's unit
 * is a MAPPING that expires by idle timeout and whose target side has no holdable
 * object at all (there is no FIN to observe in UDP).
 */
export const FORWARD_TRANSPORTS = ["stream", "datagram"] as const;
export type ForwardTransport = (typeof FORWARD_TRANSPORTS)[number];

export interface ForwardTransportSpec {
  readonly lifecycle: "connection" | "mapping";
}

export const FORWARD_TRANSPORT_SPECS: Readonly<
  Record<ForwardTransport, ForwardTransportSpec>
> = {
  stream: { lifecycle: "connection" },
  datagram: { lifecycle: "mapping" },
};

export interface ForwardProtocolSpec {
  readonly transport: ForwardTransport;
  /**
   * Compatibility value for the legacy `Tunnel.tunnel_type` column, or `null`
   * when the legacy Prisma enum has **no value that means this protocol**.
   *
   * `ws` is the first such case: the legacy enum carries `wss` (a historical
   * wrapper name) but not `ws`. Writing `wss` would assert "WebSocket over TLS"
   * about a plain-WS tunnel — a lie in a column that older readers still consult
   * — and adding `ws` to the enum is exactly the protocol-set churn §3.4 warns
   * about ("不要用 DB enum 承载会频繁扩展的协议集合").
   *
   * So the honest projection is "nothing useful to say here": the write omits
   * the column and the canonical `forward_protocol` remains the only protocol
   * fact ( made it authoritative and it is never NULL for a new Forward).
   */
  readonly legacy_tunnel_type: string | null;
}

export const DEFAULT_FORWARD_PROTOCOL: ForwardProtocol = "tcp";

export const FORWARD_PROTOCOL_SPECS: Readonly<
  Record<ForwardProtocol, ForwardProtocolSpec>
> = {
  tcp: { transport: "stream", legacy_tunnel_type: "tcp" },
  // TLS terminates at the INGRESS listener; the inter-node hop stays plain TCP,
  // which is why this is a protocol (what the client speaks) and not a
  // transport (how bytes move between nodes).
  tls: { transport: "stream", legacy_tunnel_type: "tls" },
  // A WebSocket front is a client-facing framing layer; the inter-node hop stays
  // plain TCP, exactly like tls.
  ws: { transport: "stream", legacy_tunnel_type: null },
  // `udp` is the first protocol on the datagram transport. Its legacy projection
  // is the enum's own name, so unlike `ws` there is no projection problem here —
  // `udp` has been in the wire vocabulary and the DB enum since long before V5,
  // which is why V5.1b needs no protocol migration (only an entitlement one).
  udp: { transport: "datagram", legacy_tunnel_type: "udp" },
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

/**
 * The legacy column projection, or `null` when the legacy enum cannot express
 * this protocol (see {@link ForwardProtocolSpec.legacy_tunnel_type}).
 */
export function legacyTunnelTypeForForwardProtocol(
  protocol: ForwardProtocol,
): string | null {
  return FORWARD_PROTOCOL_SPECS[protocol].legacy_tunnel_type;
}

/* ================================================================== */
/* RuntimePlan（ 立形， 补全为可用的纯计划）                  */
/* ================================================================== */

/**
 * 一次下发**在哪两台节点上**发生。
 *
 * 刻意是 id（而不是 Node 对象）：计划要能被序列化、比较、写进 Gate 证据，
 * 一旦装进对象就必然有人开始从计划里读实时状态——那会让"计划"变成第二份
 * desired state 真相，正是 §1.4 禁止的。
 */
/**
 * The persisted protocol fact of a Forward row, **if the current runtime admits
 * it**; `null` means "this fact is not runnable".
 *
 * This is the single implementation used by scheduler, reconcile and rollout
 * paths so a persisted protocol cannot be interpreted differently by each path.
 */
export function admitPersistedProtocol(row: {
  forward_protocol?: unknown;
  tunnel_type?: unknown;
}): ForwardProtocol | null {
  // Persisted rows must carry a protocol fact. Missing projection columns fail
  // closed instead of silently reinterpreting the runtime as TCP.
  if (row.forward_protocol == null && row.tunnel_type == null) return null;
  try {
    return normalizeForwardProtocol(persistedForwardProtocol(row.forward_protocol, row.tunnel_type));
  } catch {
    return null;
  }
}

/**
 * : validate the tls front's paths for a given protocol.
 *
 * Two rules, both fail-closed:
 *   · `protocol === "tls"` requires BOTH paths — dispatching "serve TLS" without
 *     a certificate is never acceptable, and there is no safe default;
 *   · every other protocol rejects them — attaching paths to tcp would put fields
 *     on the wire that the Agent has to decide to ignore, and "the Agent ignores
 *     it" is not a contract.
 *
 * Existence is deliberately NOT checked here: the files live on the node, and
 * the panel cannot see them. The Agent fails the build before binding a listener.
 */
export function tlsPathsForProtocol(
  protocol: ForwardProtocol,
  certPath: unknown,
  keyPath: unknown,
):
  | { ok: true; columns: { tls_cert_path: string | null; tls_key_path: string | null } }
  | { ok: false; reason: string } {
  const cert = typeof certPath === "string" ? certPath.trim() : "";
  const key = typeof keyPath === "string" ? keyPath.trim() : "";
  if (protocol !== "tls") {
    if (cert !== "" || key !== "") {
      return { ok: false, reason: "只有 tls 转发可以携带证书/私钥路径" };
    }
    return { ok: true, columns: { tls_cert_path: null, tls_key_path: null } };
  }
  if (cert === "" || key === "") {
    return { ok: false, reason: "tls 转发必须提供证书与私钥路径" };
  }
  if (!cert.startsWith("/") || !key.startsWith("/")) {
    return { ok: false, reason: "证书/私钥路径必须是节点本地绝对路径" };
  }
  return { ok: true, columns: { tls_cert_path: cert, tls_key_path: key } };
}

/**
 * Wire-side helper: what `payload.tunnel.tunnel_type` carries for a protocol.
 *
 * The wire vocabulary (`control-protocol/types.ts` TUNNEL_TYPES) can express
 * every product protocol, including ones the DATABASE enum cannot store. So when
 * there is no legacy name, the payload echoes the protocol name itself instead
 * of `null`: a payload field that is always a string keeps the frozen validator
 * simple, and the field is descriptive anyway — the Agent reads the tunnel
 * config, and `protocol` is the canonical fact.
 */
export function wireTunnelTypeForForwardProtocol(protocol: ForwardProtocol): string {
  return legacyTunnelTypeForForwardProtocol(protocol) ?? protocol;
}

/**
 * Write-side helper: the `tunnel_type` column assignment for a protocol, or an
 * empty object when the legacy enum has no value for it.
 *
 * Spread into a Prisma `data` object so the column keeps its historical default
 * rather than being set to a name that means a different protocol.
 */
export function legacyTunnelTypeColumn(
  protocol: ForwardProtocol,
): { tunnel_type?: string } {
  const legacy = legacyTunnelTypeForForwardProtocol(protocol);
  return legacy === null ? {} : { tunnel_type: legacy };
}

/**
 * Resolve protocol plus protocol-specific dispatch configuration in one place.
 * `null` means the persisted row is not runnable and callers must fail closed.
 */
export interface DispatchFacts {
  readonly protocol: ForwardProtocol;
  readonly tlsCertPath?: string;
  readonly tlsKeyPath?: string;
  /**
   * V5.1b：datagram 跳上"配对入口节点"的地址，出口腿据此取证。
   *
   * 只有 datagram 协议会带上它：TCP/TLS/WS 的跳是裸 TCP，握手本身就说明了对面是谁，
   * 多带一个字段只会是一个**没人读**的字段（而"没人读的字段"正是慢慢漂移的开始）。
   *
   * 它是**地址**而不是 `ip:port`：入口对出口只有一个 socket，它的**源端口是临时的**，
   * 入口 runtime 一重启端口就变——钉住端口会把一次正常重启变成永久故障。
   */
  readonly hopPeer?: string;
}

/**
 * `Node.connect_ip` 可能是一串以逗号分隔的候选地址（历史上一个节点挂过多个地址）。
 * 面板在下发任何"对端可达地址"时必须挑**同一个**第一个非空项，否则两条腿会指向
 * 不同的地址：RELAY 的 `next_hop`（入口 → 出口）与 datagram 跳的 `hop_peer`
 *（出口 → 入口）必须是同一次挑选的结果。
 */
export function firstConnectIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return raw.split(",").map((s) => s.trim()).find(Boolean) ?? null;
}

/** `ip:port` / `[v6]:port` / 裸地址 → 地址部分；空串或非字符串 → null。
 *
 * 导出是因为**编排层也要用它** 入口 ACK 回报的是 `ip:port`，而面板要拿地址部分去与
 * `connect_ip` 比对，才能判断这次下发的取证地址是不是错的。第二份解析就是漂移的开始。 */
export function addressPartOfEndpoint(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close > 1) return value.slice(1, close);
  }
  const lastColon = value.lastIndexOf(":");
  if (lastColon > 0 && /^\d+$/.test(value.slice(lastColon + 1))) {
    return value.slice(0, lastColon);
  }
  return value;
}

/**
 * 出口该取证的地址（V5.1b ，契约 §12.5 回填第 8 条）。
 *
 * **优先用入口自己上报的跳端点**（`diag.hop_local_addr`），回落到 `connect_ip`。
 *
 * 为什么不能只用 `connect_ip`：那个值在多宿节点上是**错的**。跳的源地址由内核按路由选，
 * 可能是面板完全不知道的那张网——真拓扑上的observed就是"入口从出口网地址发出，面板却告诉出口
 * 接受它的入口网地址"，于是每个跳报文都被丢弃（`ingress packets_in=1` /
 * `egress drops=1, packets_in=0`）。而"告诉入口该用哪个源地址"也不行：跨子网源地址会被
 * 当作 martian 丢弃（observed绑定源地址后**没有任何回应**）。所以这个地址只能由**真正知道它
 * 的那一端**发布——与 `next_hop` 的流向（出口 → 面板 → 入口）恰好相反。
 *
 * **只取地址部分，不取端口** 端口是临时的，入口一重启就变；把它写进出口腿的配置会让
 * 配置在每次重启后都不一样（无谓的 revision 抖动），而出口本来就只钉地址、忽略端口。
 */
export function datagramHopPeerFor(input: {
  /** 入口腿的运行时 id（`tunex-<id>-relay`）；缺了就无从在报告里找到它。 */
  ingressRuntimeId?: string | null;
  ingressConnectIp?: string | null;
  /** 入口节点最近一次上报的 `tunnels`（原样，未解析）。 */
  ingressReportedTunnels?: unknown;
}): string | null {
  const { ingressRuntimeId, ingressReportedTunnels } = input;
  if (ingressRuntimeId && Array.isArray(ingressReportedTunnels)) {
    for (const entry of ingressReportedTunnels) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as { id?: unknown; diag?: unknown };
      if (String(record.id ?? "") !== ingressRuntimeId) continue;
      const diag = record.diag as { hop_local_addr?: unknown } | null | undefined;
      const reported = addressPartOfEndpoint(diag?.hop_local_addr);
      if (reported) return reported;
      break;
    }
  }
  return firstConnectIp(input.ingressConnectIp ?? null);
}

export function dispatchFactsFromRow(row: {
  forward_protocol?: unknown;
  tunnel_type?: unknown;
  tls_cert_path?: unknown;
  tls_key_path?: unknown;
  /** 配对入口节点（只有 datagram 协议会用到；缺了它 = 出口无法取证）。 */
  ingress_node?: {
    connect_ip?: unknown;
    /** 该节点最近一次上报（`node_state_report`）。跳端点就藏在它的 `tunnels` 里。 */
    state_report?: { tunnels?: unknown } | null;
  } | null;
  /** 入口腿的运行时 id：在入口的上报里定位跳端点用（见 `datagramHopPeerFor`）。 */
  ingress_runtime_id?: unknown;
}): DispatchFacts | null {
  const protocol = admitPersistedProtocol(row);
  if (protocol === null) return null;
  const paths = tlsPathsForProtocol(protocol, row.tls_cert_path, row.tls_key_path);
  if (!paths.ok) return null;
  const cert = paths.columns.tls_cert_path;
  const key = paths.columns.tls_key_path;
  // A datagram hop has no handshake, so the peer cannot be implied — the panel has
  // to say who may feed the exit. The address is derived HERE, in the one place
  // that turns a tunnel row into dispatch facts, rather than at each dispatch
  // site: two sites deriving it independently is how `next_hop` and `hop_peer`
  // would end up naming different addresses for the same hop.
  const hopPeer =
    FORWARD_PROTOCOL_SPECS[protocol].transport === "datagram"
      ? datagramHopPeerFor({
          ingressRuntimeId: typeof row.ingress_runtime_id === "string" ? row.ingress_runtime_id : null,
          ingressConnectIp: row.ingress_node?.connect_ip as string | null | undefined,
          ingressReportedTunnels: row.ingress_node?.state_report?.tunnels,
        })
      : null;
  return {
    protocol,
    ...(cert ? { tlsCertPath: cert } : {}),
    ...(key ? { tlsKeyPath: key } : {}),
    ...(hopPeer ? { hopPeer } : {}),
  };
}

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
 *  的职责是把它补全成一个"能回答后续所有协议/HA/multi-hop 需要的问题"的
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
 *  仍然只生成 TCP/stream 计划：这里没有任何"未来协议"的字段。
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

/** 计划里尚未确定的事实（ 调用方保持可用的默认值）。 */
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
 * 前两个参数是  的冻结签名：不传 `facts` 时得到的就是  的那个最小计划
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
 * Internal consistency validation for a pure RuntimePlan. The function returns
 * violations as data so callers can report all inconsistencies without throwing.
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
