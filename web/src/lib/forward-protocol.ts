/**
 * V5-WP5-A1 §6.1 —— Forward **协议契约**的前端镜像（纯逻辑，无 React / 无网络）。
 *
 * ── 为什么单独一个模块 ──
 * 「哪些协议可以创建」「tls 需要证书/私钥路径」「路径什么时候必须带上、什么时候
 * 一个字节都不能带」这三条是**同一份契约**，后端实现见
 * `backend/src/services/forward-contract.ts`（`FORWARD_PROTOCOLS` /
 * `tlsPathsForProtocol`）与 `backend/src/routes/forwards.ts`（zod schema）。
 * 如果创建表单、复制流程、mock 各写一遍白名单和路径规则，就会出现「界面允许提交、
 * 后端 400」或更糟的「界面把 tcp 的证书路径也发出去」——所以这里只留一份实现，
 * 由 `components/forwards/__tests__/forward-protocol.test.ts` 直接读后端源码做
 * 集合断言（后端加/减协议而前端没跟上，测试立刻红）。
 *
 * ── 两个维度不要混 ──
 *   protocol（客户端说什么）: tcp | ws
 *   transport security（加不加 TLS）: 目前没有独立字段，`tls` 只是「入口监听是
 *   TLS server」这一种协议的形态。
 * 因此 `wss` **不是**协议值（§6.1 明确不把 `wss` 加进枚举：那正是 WP0 拆掉的
 * 「三个维度混成一个枚举」）。这里也绝不发明第四个值。
 */
import type { Locale } from "./i18n";

/**
 * 产品协议白名单。**必须逐字等于**后端 `FORWARD_PROTOCOLS`。
 *
 * 注意与 `lib/constants.ts` 的 `TUNNEL_TYPES` 区分：后者是 legacy Prisma 枚举
 * （含 `wss` / `mtls` / `tunex` 等历史实现名）。「枚举里有这个名字」不等于
 * 「产品支持这个协议」（V5-WP0 立的规矩）。
 */
export const FORWARD_PROTOCOLS = ["tcp", "tls", "ws", "udp", "both"] as const;

export type ForwardProtocol = (typeof FORWARD_PROTOCOLS)[number];

/** 缺省协议（后端 `DEFAULT_FORWARD_PROTOCOL`）。 */
export const DEFAULT_FORWARD_PROTOCOL: ForwardProtocol = "tcp";

/** 需要节点本地证书/私钥路径的协议。 */
export const TLS_FORWARD_PROTOCOL: ForwardProtocol = "tls";

/**
 * 已开放的**传输**契约。与 `FORWARD_PROTOCOLS` 是两个维度：
 * protocol 回答「客户端说什么」，transport 回答「报文/字节在节点里怎么走」。
 *
 * V5.1b 增加 `datagram`（DEVELOPMENT.md §6.2）：udp 是第一个**不在** stream 上的
 * 协议。传输是**派生**量，永远不是第二个用户字段。
 */
export const FORWARD_TRANSPORTS = ["stream", "datagram", "mixed"] as const;

export type ForwardTransport = (typeof FORWARD_TRANSPORTS)[number];

/**
 * 传输的生命周期语义 —— 这正是 datagram 必须是第二种传输（而不是 stream 上的
 * 一个 flag）的原因：
 *
 *   connection  stream 的工作单位是**连接**：有人关闭它才结束（§6.1）；
 *   mapping     datagram 的工作单位是**映射**：按空闲超时过期，目标侧没有任何
 *               可持有的对象（UDP 里没有 FIN 可观察，§6.2）。
 *
 * 界面凡是要说「连接」的地方，都必须先问这里：datagram 上说「连接」就是错的事实。
 */
export type ForwardTransportLifecycle = "connection" | "mapping" | "connection_and_mapping";

export const FORWARD_TRANSPORT_SPECS: Readonly<
  Record<ForwardTransport, { readonly lifecycle: ForwardTransportLifecycle }>
> = {
  stream: { lifecycle: "connection" },
  datagram: { lifecycle: "mapping" },
  mixed: { lifecycle: "connection_and_mapping" },
};

export interface ForwardProtocolSpec {
  readonly transport: ForwardTransport;
  /**
   * legacy `Tunnel.tunnel_type` 的兼容值；`null` = 该枚举里没有能表达这个协议的
   * 名字（`ws` / `both`：历史 wrapper `wss` 或独立 `tcp` 都不能替代它们）。
   */
  readonly legacy_tunnel_type: "tcp" | "tls" | "udp" | null;
}

/** 协议 → 传输/兼容列的唯一映射表（逐字镜像后端 `FORWARD_PROTOCOL_SPECS`）。 */
export const FORWARD_PROTOCOL_SPECS: Readonly<
  Record<ForwardProtocol, ForwardProtocolSpec>
> = {
  tcp: { transport: "stream", legacy_tunnel_type: "tcp" },
  tls: { transport: "stream", legacy_tunnel_type: "tls" },
  ws: { transport: "stream", legacy_tunnel_type: null },
  // V5.1b：udp 是 datagram 的第一位成员。legacy 枚举里一直有 `udp`，所以这次
  // 不需要协议迁移（与 ws 的处境不同）。
  udp: { transport: "datagram", legacy_tunnel_type: "udp" },
  both: { transport: "mixed", legacy_tunnel_type: null },
};

/** 后端 zod schema 对证书/私钥路径的长度上限（`max(512)`）。 */
export const FORWARD_TLS_PATH_MAX = 512;

/**
 * 持久化协议事实的类型。
 *
 * 之所以不是纯 `ForwardProtocol`：后端投影的是**行上的事实**
 * （`forward_protocol` 优先，回落 legacy `tunnel_type`），历史行因此可能是运行时
 * 尚未开放的值（`wss` / `quic` / …）——`protocol_supported: false` 就是给这种行
 * 准备的。类型保持开放，界面才不会为了迁就类型而把一条 `wss` 行谎报成 `tcp`。
 */
export type ForwardProtocolFact = ForwardProtocol | (string & {});

/** 创建表单的协议选项：一个契约值一项，**不含**任何非契约值。 */
export const FORWARD_PROTOCOL_OPTIONS: readonly {
  value: ForwardProtocol;
  label: string;
}[] = FORWARD_PROTOCOLS.map((value) => ({ value, label: forwardProtocolLabel(value) }));

export function isForwardProtocol(value: unknown): value is ForwardProtocol {
  return (
    typeof value === "string" && (FORWARD_PROTOCOLS as readonly string[]).includes(value)
  );
}

export function isForwardTransport(value: unknown): value is ForwardTransport {
  return (
    typeof value === "string" &&
    (FORWARD_TRANSPORTS as readonly string[]).includes(value)
  );
}

/**
 * 协议 → 传输；**未被运行时开放的协议返回 `null`**（与后端
 * `forwardTransportFor` 的 fail-closed 方向一致：未知协议绝不按 stream 处理）。
 *
 * 界面因此有两个「不知道」要区分清楚：
 *   transport === null      这一行的协议不开放，它根本不会跑（不需要讨论连接）；
 *   lifecycle === "mapping" 这一行跑的是报文映射，**没有连接**。
 */
export function forwardTransportFor(value: unknown): ForwardTransport | null {
  if (!isForwardProtocol(value)) return null;
  return FORWARD_PROTOCOL_SPECS[value].transport;
}

/** 该协议（若已开放）的生命周期语义；未开放的协议返回 `null`。 */
export function forwardTransportLifecycle(
  value: unknown,
): ForwardTransportLifecycle | null {
  const transport = forwardTransportFor(value);
  return transport === null ? null : FORWARD_TRANSPORT_SPECS[transport].lifecycle;
}

/**
 * 这条协议（若已开放）是否以**连接**为工作单位。
 *
 * `false` = 报文映射（无连接）；`null` = 协议未开放，不适用。
 * 这是界面唯一被允许回答「有没有连接」的地方 —— 任何组件自己比较
 * `protocol === "udp"` 都是在复制第二份真相。
 */
export function forwardProtocolHasConnections(value: unknown): boolean | null {
  const lifecycle = forwardTransportLifecycle(value);
  return lifecycle === null ? null : lifecycle !== "mapping";
}

/**
 * 持久化协议事实 → 规范名。
 *
 * 镜像后端 `persistedForwardProtocol`：`forward_protocol` 优先，缺失时回落
 * legacy `tunnel_type`，都没有时 = 缺省协议（V4 的「省略 = tcp」只在**入口**成立，
 * 但面板拿到的投影总已经被后端解析过，所以这里同样按事实读）。
 */
export function forwardProtocolFact(value: unknown, legacy?: unknown): string {
  const raw = value !== undefined && value !== null && value !== "" ? value : legacy;
  if (typeof raw !== "string") return DEFAULT_FORWARD_PROTOCOL;
  const name = raw.trim().toLowerCase();
  return name === "" ? DEFAULT_FORWARD_PROTOCOL : name;
}

/** 当前运行时是否开放这个协议（= 是否在 `FORWARD_PROTOCOLS` 里）。 */
export function forwardProtocolSupported(value: unknown, legacy?: unknown): boolean {
  return isForwardProtocol(forwardProtocolFact(value, legacy));
}

/**
 * 展示用标签。
 *
 * 未知协议**不回落成 "unknown"**：标签就是事实本身的大写形式（`wss` → `WSS`），
 * 用户看到的永远是这一行真实写着的协议。是否已开放由
 * {@link forwardProtocolSupported} 单独表达（多一个「未开放」注记），而不是把事实
 * 替换掉。
 */
export function forwardProtocolLabel(value: unknown, legacy?: unknown): string {
  const fact = forwardProtocolFact(value, legacy);
  return fact === "both" ? "TCP + UDP" : fact.toUpperCase();
}

/**
 * 创建时可用的协议：只有契约值可用；历史值（`wss` / `quic` / `mtcp` …）**不能**被
 * 原样再创建（后端 `z.enum(FORWARD_PROTOCOLS)` 会 400），由调用方显式改选。
 *
 * `udp` 是当前契约值；`quic` / `mtcp` 等历史值仍不可直接重新创建。
 */
export function forwardProtocolForCreate(value: unknown): ForwardProtocol | null {
  const fact = forwardProtocolFact(value);
  return isForwardProtocol(fact) ? fact : null;
}

/* ================================================================== */
/* 创建 payload：协议字段（含 tls 路径的形状规则）                       */
/* ================================================================== */

/**
 * 创建请求里的协议字段。
 *
 * 不变量（与后端 `ForwardCreateSchema` + `tlsPathsForProtocol` 同一口径）：
 *   · `protocol` **总是**显式携带（不靠后端默认值，创建了什么就发什么）；
 *   · 只有 `tls` 会带上路径，且路径非空才出现 —— tcp / ws / **udp** 的 payload 里
 *     `tls_cert_path` / `tls_key_path` 这两个键**结构上不存在**，
 *     不可能出现「发出去再由 Agent 决定忽略」的字段；
 *   · 路径为空时**不发空串**：「tls 但没有证书」在契约里不是一种状态，
 *     该状态由 {@link tlsPathFieldErrors} 在提交前拦下，绝不静默降级。
 *
 * udp 属于第二类：它**没有**任何协议专属配置（不像 tls 需要证书路径），所以选它
 * 既不需要、也不会产生额外字段 —— 报文映射的键/超时/上限全是运行时的事（§6.2），
 * 面板没有可填的东西。
 */
export function forwardProtocolFields(
  protocol: ForwardProtocol,
  certPath: string,
  keyPath: string,
): { protocol: ForwardProtocol; tls_cert_path?: string; tls_key_path?: string } {
  if (protocol !== TLS_FORWARD_PROTOCOL) return { protocol };
  const cert = certPath.trim();
  const key = keyPath.trim();
  const fields: {
    protocol: ForwardProtocol;
    tls_cert_path?: string;
    tls_key_path?: string;
  } = { protocol };
  if (cert !== "") fields.tls_cert_path = cert;
  if (key !== "") fields.tls_key_path = key;
  return fields;
}

/** 路径字段的错误（值为 i18n key；空对象 = 通过）。 */
export type TlsPathFieldErrors = {
  tls_cert_path?: string;
  tls_key_path?: string;
};

function tlsPathErrorFor(value: string): string | null {
  if (value === "") return "forward.tlsPathRequired";
  // 节点本地绝对路径：后端 zod `.startsWith("/")`，且面板看不到节点的文件系统，
  // 所以「文件是否存在」不在这里判定（那是 Agent 构建 listener 时的拒绝）。
  if (!value.startsWith("/")) return "forward.tlsPathAbsolute";
  if (value.length > FORWARD_TLS_PATH_MAX) return "forward.tlsPathTooLong";
  return null;
}

/**
 * tls 路径的形态预检 —— 与 {@link forwardProtocolFields} 是**一对**：
 * 这个函数说不通过的，payload builder 就不该被调用。
 *
 * 两条规则都 fail-closed（对齐后端 `tlsPathsForProtocol`）：
 *   · `tls` 必须**同时**给出证书与私钥路径（「服务 TLS 但没证书」没有安全默认值）；
 *   · 非 tls 协议**不接受**任何路径（把路径挂在 tcp 上就是一份骗人的配置）。
 * 第二条在界面里通常到不了（切走协议会清空输入），保留它是为了防止有人把
 * 表单接成「协议与路径各自独立提交」。
 */
export function tlsPathFieldErrors(
  protocol: ForwardProtocol,
  certPath: string,
  keyPath: string,
): TlsPathFieldErrors {
  const cert = certPath.trim();
  const key = keyPath.trim();
  const errors: TlsPathFieldErrors = {};
  if (protocol !== TLS_FORWARD_PROTOCOL) {
    if (cert !== "" || key !== "") {
      errors.tls_cert_path = "forward.tlsPathNotAllowed";
      errors.tls_key_path = "forward.tlsPathNotAllowed";
    }
    return errors;
  }
  const certError = tlsPathErrorFor(cert);
  if (certError) errors.tls_cert_path = certError;
  const keyError = tlsPathErrorFor(key);
  if (keyError) errors.tls_key_path = keyError;
  return errors;
}

/**
 * 协议 → 已经本地化的说明文案（创建/编辑表单里 Select 下方的一行）。
 *
 * 这里**没有** `default:` 分支，而且四个契约值都显式列出：任何一次「新增协议忘了
 * 写文案」都会变成 tsc 错误（函数不再保证有返回值），而不是静默落进一个
 * 「普通 TCP 入口监听」的兜底 —— udp 就是这样被兜底说成 TCP 过一次（V5.1b 之前
 * 的 default 分支），而 §6.2 要求 udp **永不**被当作 stream 协议呈现。
 *
 * 未知（未开放）协议不经过本函数：调用方应先看 `protocol_supported`。
 */
export function forwardProtocolNote(
  locale: Locale | string,
  protocol: ForwardProtocol,
): string {
  const zh = locale !== "en";
  switch (protocol) {
    case "both":
      return zh
        ? "原生普通 TCP + UDP，一个业务 ID、一个监听端口、一条共享预算；TCP 流与 UDP 活跃映射共享总并发、每来源 IP 并发及双向速率上限。仅支持 DIRECT 或本地单跳 RELAY，不支持中间跳、联邦、TLS、WS 或来源透传。"
        : "Native plain TCP + UDP: one business ID, one listen port and one shared budget for TCP streams + active UDP mappings, including total/per-source-IP concurrency and directional rates. DIRECT or single-hop local RELAY only; no middle hop, federation, TLS, WS or client-source forwarding.";
    case "udp":
      // datagram：工作单位是**映射**，不是连接（§6.2）。措辞里必须出现「没有连接」，
      // 因为这个协议最容易被人按 TCP 的连接模型理解。
      return zh
        ? "客户端以 UDP 报文访问入口：入口按客户端地址建立一条映射，空闲超时后回收；udp 没有连接，也没有显式关闭。"
        : "Clients send UDP datagrams to the ingress: one mapping is keyed per client address and reclaimed on idle timeout; there is no connection and no explicit close.";
    case "tls":
      return zh
        ? "入口监听为 TLS（证书在入口节点本地文件里），跨节点一跳仍为普通 TCP。"
        : "The ingress listener speaks TLS (certificate files live on the ingress node); the inter-node hop stays plain TCP.";
    case "ws":
      return zh
        ? "客户端以 WebSocket 连接入口，解帧后的字节流按普通 TCP 转发。"
        : "Clients connect to the ingress over WebSocket; the decoded byte stream is forwarded as plain TCP.";
    case "tcp":
      // 与 V5.1a 的措辞**逐字相同**：tcp/tls/ws 的既有界面不因 datagram 的加入而改变
      // （criterion：tcp+tls+ws 必须与改动前一致）。
      return zh ? "普通 TCP 入口监听。" : "A plain TCP ingress listener.";
  }
}

/* ================================================================== */
/* 编辑 patch：协议字段                                                  */
/* ================================================================== */

/**
 * 编辑请求里的协议专属字段（只有**变更过**的才出现，与 `draftToPatch` 的增量语义一致）。
 *
 * 两条不变量：
 *   · **只有 tls 行**可以携带路径。tcp / ws / **udp** 一律返回空对象 —— 后端 create
 *     对非 tls 携带路径是 400；patch 侧目前只会静默丢弃（见任务回报的契约缺口），
 *     所以「结构上不发」是这里唯一的正确做法；
 *   · 空串**永远不发**（后端 zod 是 `.min(1).startsWith("/")`，发空串就是 400）。
 *     「把路径清空」在契约里不是一种状态：那是表单预检的失败
 *     （{@link tlsPathFieldErrors}），由调用方在提交前拦下并给出必填提示。
 */
export function forwardProtocolPatchFields(
  protocol: ForwardProtocolFact,
  current: { cert?: string | null; key?: string | null },
  draft: { cert: string; key: string },
): { tls_cert_path?: string; tls_key_path?: string } {
  if (forwardProtocolFact(protocol) !== TLS_FORWARD_PROTOCOL) return {};
  const out: { tls_cert_path?: string; tls_key_path?: string } = {};
  const cert = draft.cert.trim();
  const key = draft.key.trim();
  if (cert !== "" && cert !== (current.cert ?? "")) out.tls_cert_path = cert;
  if (key !== "" && key !== (current.key ?? "")) out.tls_key_path = key;
  return out;
}
