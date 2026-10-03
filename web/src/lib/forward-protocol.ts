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
export const FORWARD_PROTOCOLS = ["tcp", "tls", "ws"] as const;

export type ForwardProtocol = (typeof FORWARD_PROTOCOLS)[number];

/** 缺省协议（后端 `DEFAULT_FORWARD_PROTOCOL`）。 */
export const DEFAULT_FORWARD_PROTOCOL: ForwardProtocol = "tcp";

/** 需要节点本地证书/私钥路径的协议。 */
export const TLS_FORWARD_PROTOCOL: ForwardProtocol = "tls";

/** 后端 zod schema 对证书/私钥路径的长度上限（`max(512)`）。 */
export const FORWARD_TLS_PATH_MAX = 512;

/**
 * 持久化协议事实的类型。
 *
 * 之所以不是纯 `ForwardProtocol`：后端投影的是**行上的事实**
 * （`forward_protocol` 优先，回落 legacy `tunnel_type`），历史行因此可能是运行时
 * 尚未开放的值（`wss` / `udp` / …）——`protocol_supported: false` 就是给这种行
 * 准备的。类型保持开放，界面才不会为了迁就类型而把一条 `wss` 行谎报成 `tcp`。
 */
export type ForwardProtocolFact = ForwardProtocol | (string & {});

/** 创建表单的协议选项：一个契约值一项，**不含** `wss`。 */
export const FORWARD_PROTOCOL_OPTIONS: readonly {
  value: ForwardProtocol;
  label: string;
}[] = FORWARD_PROTOCOLS.map((value) => ({ value, label: value.toUpperCase() }));

export function isForwardProtocol(value: unknown): value is ForwardProtocol {
  return (
    typeof value === "string" && (FORWARD_PROTOCOLS as readonly string[]).includes(value)
  );
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
  return forwardProtocolFact(value, legacy).toUpperCase();
}

/**
 * 创建时可用的协议：只有契约值可用；历史值（`wss` / `udp` …）**不能**被原样再创建
 * （后端 `z.enum(FORWARD_PROTOCOLS)` 会 400），由调用方显式改选。
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
 *   · 只有 `tls` 会带上路径，且路径非空才出现 —— tcp / ws 的 payload 里
 *     `tls_cert_path` / `tls_key_path` 这两个键**结构上不存在**，
 *     不可能出现「发出去再由 Agent 决定忽略」的字段；
 *   · 路径为空时**不发空串**：「tls 但没有证书」在契约里不是一种状态，
 *     该状态由 {@link tlsPathFieldErrors} 在提交前拦下，绝不静默降级。
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
 * 协议 → 已经本地化的说明文案（创建表单里 Select 下方的一行）。
 *
 * 未知协议不给「未开放」以外的说法：编一句「等价于 X」就是在替后端猜。
 */
export function forwardProtocolNote(
  locale: Locale | string,
  protocol: ForwardProtocol,
): string {
  const zh = locale !== "en";
  switch (protocol) {
    case "tls":
      return zh
        ? "入口监听为 TLS（证书在入口节点本地文件里），跨节点一跳仍为普通 TCP。"
        : "The ingress listener speaks TLS (certificate files live on the ingress node); the inter-node hop stays plain TCP.";
    case "ws":
      return zh
        ? "客户端以 WebSocket 连接入口，解帧后的字节流按普通 TCP 转发。"
        : "Clients connect to the ingress over WebSocket; the decoded byte stream is forwarded as plain TCP.";
    default:
      return zh
        ? "普通 TCP 入口监听。"
        : "A plain TCP ingress listener.";
  }
}
