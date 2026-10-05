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

/**
 * Product protocols the runtime has opened.
 *
 * A value lands here only together with its own Gate (V5-G0 established the
 * "enum presence is not product support" rule; V5-WP0 enforced it). V5.1a adds
 * `tls` — the same stream lifecycle with a TLS-terminated client-facing listener
 * (DEVELOPMENT.md §6.1). `ws` follows in V5-WP5-A2. `udp` follows in V5.1b
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
   * fact (WP0 made it authoritative and it is never NULL for a new Forward).
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
/* RuntimePlan（V5-WP0 立形，V5-WP2 补全为可用的纯计划）                  */
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
 * This is the single implementation used by every dispatch path — the scheduler,
 * the reconcile sink and the rollout executor. It lives here rather than in
 * scheduler.ts because a second copy is how one path ends up admitting a fact the
 * others refuse: the V5-G0 gate caught exactly that, with a historical `wss`
 * Forward being dispatched as TCP by the reconcile sink because that path passed
 * no protocol at all and the orchestrator's default is tcp.
 */
export function admitPersistedProtocol(row: {
  forward_protocol?: unknown;
  tunnel_type?: unknown;
}): ForwardProtocol | null {
  // A persisted row must CARRY a protocol fact. If neither column is present the
  // projection is wrong (a forgotten `select`), and "absent means tcp" — which is
  // correct at the V4 *ingest* boundary, where a client legitimately omits the
  // field — becomes catastrophic here: the row's own fact is silently replaced by
  // the default and a historical `wss` Forward is dispatched as TCP.
  //
  // Gate V5-G0 caught exactly that: the reconciler's desired-state projection did
  // not select the protocol columns, so every resend through the reconcile sink
  // admitted the default. Failing closed turns a missing column into a refusal
  // (visible, diagnosable) instead of a wrong runtime (invisible, live).
  if (row.forward_protocol == null && row.tunnel_type == null) return null;
  try {
    return normalizeForwardProtocol(persistedForwardProtocol(row.forward_protocol, row.tunnel_type));
  } catch {
    return null;
  }
}

/**
 * V5-WP5-A1: validate the tls front's paths for a given protocol.
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
 * Everything a dispatch needs to know about a persisted Forward, resolved in ONE
 * place: the protocol and its protocol-specific configuration.
 *
 * This exists because "the protocol" and "the fields that protocol needs" are one
 * fact, and splitting them across call sites is how a new required field is
 * forgotten on one path. Gate G0 and G1A each found a version of that: first a
 * dispatch path with no protocol at all, then (after `tls` arrived) a path that
 * carried the protocol but not the certificate paths, so every hot reload of a
 * tls Forward failed while create and restore worked.
 *
 * `null` means "this row must not be dispatched": either its protocol is not
 * admitted, or it is a tls row without a complete certificate pair. Callers
 * refuse; none of them re-derive the answer locally.
 */
export interface DispatchFacts {
  readonly protocol: ForwardProtocol;
  readonly tlsCertPath?: string;
  readonly tlsKeyPath?: string;
  /**
   * V5.1b WP5-B2：datagram 跳上"配对入口节点"的地址，出口腿据此取证。
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

export function dispatchFactsFromRow(row: {
  forward_protocol?: unknown;
  tunnel_type?: unknown;
  tls_cert_path?: unknown;
  tls_key_path?: unknown;
  /** 配对入口节点（只有 datagram 协议会用到；缺了它 = 出口无法取证）。 */
  ingress_node?: { connect_ip?: unknown } | null;
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
      ? firstConnectIp(row.ingress_node?.connect_ip as string | null | undefined)
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
