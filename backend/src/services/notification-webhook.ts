/**
 * V5-WP18.3 —— Webhook 渠道 + 出站 SSRF 边界（契约 §F9 / §5.0 O4 / §7 DoD5）。
 *
 * ── 这个模块解决什么 ──
 * Webhook 是**第一个由用户（或操作员）指定目标地址的出站请求**。仓库里今天没有任何可复用的
 * URL/IP 守卫（`forward-probe-plan.ts` / `agent-diagnose.ts` 只有「别把客户机房当内网扫描器」
 * 的产品边界注释），所以「面板会不会变成出站跳板」这件事必须在**本模块**回答清楚（契约 §F9）。
 *
 * F9 的四条边界，逐条在代码里对应一个**纯函数**（可离线断言，不需要网络）：
 *   1. 只允许 `https://`；`http://` 仅在 `NODE_ENV !== "production"` **且**显式打开时放行
 *      → {@link parseWebhookTarget} + {@link isWebhookInsecureHttpAllowed}；
 *   2. 目标地址不得是 loopback / private / link-local / multicast / ULA 等非公网地址
 *      → {@link classifyWebhookAddress}（**IPv4 与 IPv6 都覆盖，含 IPv4-mapped**）；
 *   3. **禁止重定向**：3xx 一律 `rejected_target`，且实现上**根本不跟随**
 *      （传输层只读到响应头就断开 → 「跟随」这件事在本模块里不存在，不是靠配置关掉的）；
 *   4. **DNS rebinding**：解析一次 → 校验**全部**解析结果 → 直接连到那个 IP（TLS SNI / Host
 *      头仍是域名）→ 见 {@link createPinnedSocketTransport}。
 *
 * ── 三个刻意的取舍（都写进契约交付记录）──
 *  · **出站不用 `fetch`，而用 net/tls 手写最小客户端**：`fetch` 无法把连接固定到已校验的 IP
 *    （Bun 不暴露 dispatcher/Agent），二次解析比对仍有窗口。仓库已有手写最小协议客户端的
 *    先例（`mail.ts` 的 `SmtpClient`）。手写 HTTP 在这里是**安全属性的一部分**，不是炫技：
 *    只发一次、只读响应头、连接级固定 IP，三条都是 SSRF 边界要的东西。
 *  · **Host 头/路径不参与拼接**：Host 取自 `URL.host`、路径取自 `URL.pathname+search`，
 *    写之前再过一次 CRLF 断言（URL 解析器本身会剥掉裸 CR/LF/TAB，这里是纵深防御）。
 *  · **账本里的 target 必须脱敏**：webhook URL **本身就是凭据**（Slack/Discord 的 hook URL
 *    拿到就能发消息）。{@link redactWebhookTarget} 只保留 origin + 目标 URL 的短摘要，
 *    既能让运维区分「同一个 host 上的两个 hook」，又不落任何秘密。
 *
 * ── 部署级开关：默认关（Lead 裁决 O4 追加约束）──
 * 「新增的出站通道默认关，要开必须显式打开」。开关是**部署面**的东西（env），不是凭据——
 * 与 F5「token 不进 env」不矛盾：F5 禁的是把凭据塞进不可变部署面，不是禁部署方决定
 * 「这个安装要不要这个出站通道」。关着的时候 `isConfigured()` 返回 false →
 * 投递层记一条 `not_configured` 失败行、**零出站**（C3：不假装成功）。
 */
import { createHash } from "node:crypto";
import { isIP, connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { NotificationScope } from "./notification-facts.ts";
import type {
  ChannelConfigCheck,
  ChannelResult,
  NotificationChannel,
  RenderedNotification,
} from "./notification-delivery.ts";

/* ================================================================== */
/* 常量与开关                                                          */
/* ================================================================== */

/** 目标 URL 长度上限。**防的是**：把几千字符塞进 URL 让日志/账本/内存吃满（畸形输入的一类）。 */
export const WEBHOOK_TARGET_MAX = 2_048;
/** 单次出站超时（ms）。与 `federation/trust.ts` 的握手同口径（10s）：出站通道不该挂住投递循环。 */
export const WEBHOOK_TIMEOUT_MS = 10_000;
/** 只读响应头的字节上限：**绝不读响应体**（响应体是对方可控的任意长度，读完就是把内存交给对方）。 */
export const WEBHOOK_RESPONSE_HEAD_MAX = 8_192;
/** 错误摘要上限（`ChannelResult.detail` → 账本 `error` 列）。 */
export const WEBHOOK_DETAIL_MAX = 300;
/** 载荷版本（改动载荷形状 = 改版本号，消费方据此分支）。 */
export const WEBHOOK_PAYLOAD_VERSION = 1;
/** 脱敏摘要长度（origin + 这段摘要 = 可区分、不可反推）。 */
export const WEBHOOK_TARGET_DIGEST_LENGTH = 12;

/** 部署级开关的 env 名（默认关；`"true"` 之外的任何值都算关）。 */
export const WEBHOOK_ENABLED_ENV = "TUNEX_NOTIFICATION_WEBHOOK_ENABLED";
/** 「允许 http://」的 env 名（**还要** `NODE_ENV !== "production"` 才生效）。 */
export const WEBHOOK_ALLOW_HTTP_ENV = "TUNEX_NOTIFICATION_WEBHOOK_ALLOW_HTTP";

/** 开关判定（纯函数，env 注入以便单测；默认读 `process.env`）。 */
export function isWebhookChannelEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[WEBHOOK_ENABLED_ENV] === "true";
}

/**
 * 是否允许明文 `http://` 目标。**两个条件同时成立**：非生产环境 **且** 显式打开。
 * 「显式打开」单独一项不够（生产上有人配了一个 `=true` 就全裸），
 * 「非生产」单独一项也不够（开发环境同样不该把面板当内网跳板）。
 */
export function isWebhookInsecureHttpAllowed(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (env.NODE_ENV ?? "development") !== "production" && env[WEBHOOK_ALLOW_HTTP_ENV] === "true";
}

/* ================================================================== */
/* 地址分类（纯函数，F9.2）                                             */
/* ================================================================== */

/**
 * 地址类别。**除了 `public` 之外全部拒绝**（fail-closed）：
 * 白名单只有一格，新增的「未知类别」自动落进 `reserved` 而不是 `public`。
 */
export type WebhookAddressClass =
  | "public"
  | "loopback"
  | "private"
  | "link_local"
  | "unique_local"
  | "shared"
  | "multicast"
  | "unspecified"
  | "reserved"
  | "not_ip";

function parseIpv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    // 只认十进制点分形态：`0x7f.1` / `0177.0.0.1` / `127.1` 这类历史写法一律拒绝
    // （`isIP()` 同样不认，但这里显式写出来，免得后人"顺手放宽"）。
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    out.push(value);
  }
  return out;
}

/** IPv4 分类。比契约 F9.2 列出的更严（多拒 CGNAT/保留段）——fail-closed 的方向由契约 §F9 背书。 */
function classifyIpv4(octets: readonly number[]): WebhookAddressClass {
  const a = octets[0]!;
  const b = octets[1]!;
  const c = octets[2]!;
  if (a === 0) return "unspecified"; // 0.0.0.0/8（含 0.0.0.0，"本机"的另一种写法）
  if (a === 127) return "loopback"; // 127/8
  if (a === 10) return "private"; // 10/8
  if (a === 172 && b >= 16 && b <= 31) return "private"; // 172.16/12
  if (a === 192 && b === 168) return "private"; // 192.168/16
  if (a === 169 && b === 254) return "link_local"; // 169.254/16（云元数据 169.254.169.254 在此段内）
  if (a === 100 && b >= 64 && b <= 127) return "shared"; // 100.64/10 CGNAT（RFC 6598，非全球可达）
  if (a >= 224 && a <= 239) return "multicast"; // 224/4
  if (a >= 240) return "reserved"; // 240/4
  // 其余保留/文档段：TEST-NET、192.0.0.0/24、198.18/15 基准测试段、192.88.99/24（6to4 中继）。
  if (a === 192 && b === 0 && c === 0) return "reserved";
  if (a === 192 && b === 0 && c === 2) return "reserved";
  if (a === 198 && b === 51 && c === 100) return "reserved";
  if (a === 203 && b === 0 && c === 113) return "reserved";
  if (a === 198 && (b === 18 || b === 19)) return "reserved";
  if (a === 192 && b === 88 && c === 99) return "reserved";
  return "public";
}

/**
 * 展开 IPv6 成 8 个 16 位组。手写而不是引三方依赖（仓库零新运行时依赖的纪律）：
 * 只需要回答「这个字面量落在哪个段」，不需要通用 IP 库。
 * 返回 null = 不是合法的 IPv6 字面量。
 */
function expandIpv6(text: string): number[] | null {
  // 区域 id（`fe80::1%eth0`）只对链路本地有意义，剥掉不影响分类（照样落 link_local）。
  const zoneAt = text.indexOf("%");
  const body = zoneAt === -1 ? text : text.slice(0, zoneAt);
  let head = body;
  let embedded: number[] | null = null;
  const lastColon = body.lastIndexOf(":");
  if (lastColon !== -1) {
    const tail = body.slice(lastColon + 1);
    if (tail.includes(".")) {
      embedded = parseIpv4(tail);
      if (!embedded) return null;
      // 保留到**这个冒号本身**（`::ffff:1.2.3.4` → head `::ffff:`，`::1.2.3.4` → head `::`）：
      // 否则 `::1.2.3.4` 会被切掉一个冒号而展开失败（表现为「不是合法 IPv6」，虽然仍是拒绝，
      // 但会让 `::<v4>` 这类内嵌形态失去逐段分类的证据）。
      head = body.slice(0, lastColon + 1);
    }
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  // 空组永远不是合法组：内嵌 v4 前的那个分隔冒号会在切分后留下一个空串（`::ffff:` → `ffff:`），
  // 过滤掉即可；其余位置出现空串本来也就是畸形输入。
  const left = halves[0] ? halves[0]!.split(":").filter((s) => s !== "") : [];
  const right = halves.length === 2 ? (halves[1] ? halves[1]!.split(":").filter((s) => s !== "") : []) : [];
  const explicit = left.length + right.length + (embedded ? 2 : 0);
  if (halves.length === 1) {
    if (explicit !== 8) return null;
  } else if (explicit > 7) {
    // `::` 至少要压缩掉一组，否则不是合法的简写。
    return null;
  }
  const fill = new Array<string>(8 - explicit).fill("0");
  const groups = [...left, ...fill, ...right];
  const out: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    out.push(Number.parseInt(group, 16));
  }
  if (embedded) out.push((embedded[0]! << 8) | embedded[1]!, (embedded[2]! << 8) | embedded[3]!);
  return out.length === 8 ? out : null;
}

/**
 * IPv6 分类。契约 F9.2 点名 `::1` / `fc00::/7` / `fe80::/10`；
 * 这里额外把 6to4 / NAT64 / 文档段归 `reserved`（同样不可信，方向仍是 fail-closed）。
 */
function classifyIpv6(groups: readonly number[]): WebhookAddressClass {
  const g = groups;
  const leadingZero = g.slice(0, 7).every((x) => x === 0);
  if (leadingZero && g[7] === 0) return "unspecified"; // ::
  if (leadingZero && g[7] === 1) return "loopback"; // ::1
  // IPv4-mapped（::ffff:a.b.c.d）：**必须**按内嵌 IPv4 判，否则 `::ffff:10.0.0.1`
  // 会被当成"公网 IPv6"直接放行（最经典的绕过手法）。
  if (g.slice(0, 5).every((x) => x === 0)) {
    if (g[5] === 0xffff) return classifyIpv4([g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff]);
    // `::` 与 `::1` 已在上面的分支返回；剩下的 `::x:y`（IPv4-compatible）是 RFC 4291 废弃形态，
    // 路由行为依操作系统而异 —— 不可信，归 reserved（fail-closed）。
    return "reserved";
  }
  if ((g[0]! & 0xfe00) === 0xfc00) return "unique_local"; // fc00::/7
  if ((g[0]! & 0xffc0) === 0xfe80) return "link_local"; // fe80::/10
  if ((g[0]! & 0xff00) === 0xff00) return "multicast"; // ff00::/8
  if (g[0] === 0x64 && g[1] === 0xff9b) return "reserved"; // 64:ff9b::/96 NAT64
  if (g[0] === 0x2001 && g[1] === 0x0db8) return "reserved"; // 2001:db8::/32 文档段
  if (g[0] === 0x2002) return "reserved"; // 2002::/16 6to4（可内嵌任意 v4）
  if ((g[0]! & 0xe000) === 0x2000) return "public"; // 2000::/3 全球单播
  return "reserved";
}

/**
 * 地址分类（IPv4 / IPv6 / 非 IP 字面量）。**这是 F9.2 的唯一判据**：
 * 只有 `"public"` 允许出站，其余一律拒绝。
 */
export function classifyWebhookAddress(raw: string): WebhookAddressClass {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") return "not_ip";
  const version = isIP(text);
  if (version === 4) {
    const octets = parseIpv4(text);
    return octets ? classifyIpv4(octets) : "not_ip";
  }
  if (version === 6) {
    const groups = expandIpv6(text);
    return groups ? classifyIpv6(groups) : "not_ip";
  }
  return "not_ip";
}

/** 该地址是否允许作为出站目标（F9.2：解析结果必须是公网地址）。 */
export function isPermittedWebhookAddress(raw: string): boolean {
  return classifyWebhookAddress(raw) === "public";
}

/* ================================================================== */
/* URL 校验（纯函数，F9.1 / F9.2）                                      */
/* ================================================================== */

/** 拒绝原因（闭集；`validateConfig` 只把全部拒绝折叠成 `rejected_target`，细分留给调用方排障）。 */
export const WEBHOOK_TARGET_REJECTIONS = [
  "not_a_string",
  "empty",
  "too_long",
  "malformed_url",
  "unsupported_protocol",
  "insecure_protocol_disallowed",
  "credentials_in_url",
  "missing_host",
  "invalid_port",
  "blocked_hostname",
  "forbidden_address",
  "unresolvable",
] as const;
export type WebhookTargetRejection = (typeof WEBHOOK_TARGET_REJECTIONS)[number];

export type WebhookTargetCheck =
  | { readonly ok: true; readonly url: URL; readonly hostname: string }
  | { readonly ok: false; readonly reason: WebhookTargetRejection };

/**
 * 静态结构校验（**不含 DNS**，所以是同步纯函数，正好满足 `NotificationChannel.validateConfig` 的同步签名）。
 *
 * 这里判完的结论是「形状可以拿去解析」，**不是**「目标可用」——DNS 与 IP 判定在
 * {@link resolveWebhookTarget}（异步），两者都过才允许出站。分开是刻意的：
 * 把 DNS 塞进 `validateConfig` 会让渠道接口变成异步，而 F3 的形状已经冻结。
 */
export function parseWebhookTarget(
  input: string | null | undefined,
  options: { allowInsecureHttp?: boolean } = {},
): WebhookTargetCheck {
  if (typeof input !== "string") return { ok: false, reason: "not_a_string" };
  const target = input.trim();
  if (target === "") return { ok: false, reason: "empty" };
  if (target.length > WEBHOOK_TARGET_MAX) return { ok: false, reason: "too_long" };

  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return { ok: false, reason: "malformed_url" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "unsupported_protocol" };
  }
  if (url.protocol === "http:" && options.allowInsecureHttp !== true) {
    return { ok: false, reason: "insecure_protocol_disallowed" };
  }
  // `https:///hook`：WHATWG 解析器（Bun 与 Node 一致）会**静默吞掉**多余斜杠，把 `hook` 当主机名。
  // 结果虽然还能过后面的 DNS/IP 校验，但"操作员写的路径变成了主机名"这种事必须显式拒掉，
  // 不能靠解析器的宽容归一化。这一条不依赖 URL 实现（先看原始串）。
  const authorityAt = target.indexOf("://") + 3;
  const firstOfAuthority = target.slice(authorityAt, authorityAt + 1);
  if (firstOfAuthority === "" || firstOfAuthority === "/" || firstOfAuthority === "?" || firstOfAuthority === "#") {
    return { ok: false, reason: "malformed_url" };
  }
  // URL 里的凭据（`https://user:pass@host/`）：它既不该进日志，也该由渠道自己的密文列承载。
  if (url.username !== "" || url.password !== "") return { ok: false, reason: "credentials_in_url" };
  if (url.port !== "") {
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return { ok: false, reason: "invalid_port" };
  }
  const hostname = url.hostname;
  if (hostname === "") return { ok: false, reason: "missing_host" };
  // `localhost` / `*.localhost`：解析不经过 DNS（RFC 6761），拿不到"解析结果"来校验 IP，
  // 所以静态拒掉 —— 不做「先放过、等 DNS 兜底」这种依赖解析器行为的假设。
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return { ok: false, reason: "blocked_hostname" };
  }
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (isIP(bare) !== 0 && !isPermittedWebhookAddress(bare)) {
    return { ok: false, reason: "forbidden_address" };
  }
  return { ok: true, url, hostname: bare };
}

/* ================================================================== */
/* 脱敏（F5：凭据不回显 / 账本不落秘密）                                 */
/* ================================================================== */

const REDACT_MASK = "***";

/**
 * 目标 URL 的脱敏形态：`<origin>/***<短摘要>`。
 *
 * 为什么保留 origin：账本要能回答「发给谁了」，只留摘要会让人无从排查。
 * 为什么路径/查询全部丢掉：Slack / Discord / 飞书 这类 hook URL 的凭据**就在路径与查询里**，
 * 任何"保留前 N 段"的规则都会在某家厂商的格式上漏一次。摘要让同一 host 上的多个 hook
 * 仍然可区分（运维知道"另一个 hook 又失败了"），但反推不出 URL。
 */
export function redactWebhookTarget(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    // 不可解析的形态一律不落原文（畸形输入里同样可能藏 token）。
    return `${REDACT_MASK}:${digest(raw)}`;
  }
  return `${url.protocol}//${url.host}/***${digest(raw)}`;
}

/** 短摘要（`sha256` 前 N 位十六进制）。标准库，不新增依赖；域名段不参与（见上面的取舍）。 */
function digest(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex").slice(0, WEBHOOK_TARGET_DIGEST_LENGTH);
}

/**
 * 错误摘要脱敏：把摘要里出现的**原始目标 URL** 换成脱敏形态，顺手剥换行 + 截断。
 *
 * 为什么必须做：传输层抛出的错误消息常常**带上完整 URL**（`request to <url> failed`），
 * 而 `detail` 会落进投递账本的 `error` 列 —— 不脱敏就等于把凭据写进了另一张表。
 */
export function redactWebhookDetail(message: unknown, rawTarget?: string | null): string {
  const text = message instanceof Error ? message.message : typeof message === "string" ? message : String(message ?? "");
  let out = text;
  if (typeof rawTarget === "string" && rawTarget !== "") {
    const masked = redactWebhookTarget(rawTarget);
    out = out.split(rawTarget).join(masked);
    try {
      const encoded = encodeURI(rawTarget);
      if (encoded !== rawTarget) out = out.split(encoded).join(masked);
    } catch {
      /* encodeURI 对畸形串可能抛错：脱敏不该因此失败，原样继续。 */
    }
  }
  return out.replace(/[\r\n\t]+/g, " ").trim().slice(0, WEBHOOK_DETAIL_MAX);
}

/* ================================================================== */
/* 目标解析（DNS，F9.2 / F9.4）                                         */
/* ================================================================== */

export interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

/** DNS 解析器（注入以便离线断言；生产走 `node:dns/promises`）。 */
export type WebhookResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export type WebhookResolvedTarget =
  | {
      readonly ok: true;
      readonly url: URL;
      readonly hostname: string;
      /**
       * 校验通过的全部公网地址。传输层固定用第一个（**不**交给系统解析器再选一次）。
       * 保留全部是为了让调用方/测试能看到"校验的是全部结果"，而不只是被用的那一个。
       */
      readonly addresses: readonly ResolvedAddress[];
    }
  | { readonly ok: false; readonly reason: WebhookTargetRejection };

/** 默认解析器：`lookup(all:true)` 拿到**全部**结果（只校验一个结果等于给轮询 DNS 留后门）。 */
export const defaultWebhookResolver: WebhookResolver = async (hostname) => {
  const { lookup } = await import("node:dns/promises");
  const results = await lookup(hostname, { all: true });
  return results.map((r) => ({ address: r.address, family: r.family }));
};

/**
 * 解析 + 校验（异步）。判定顺序：静态形状 → 解析 → **全部**解析结果必须是公网地址。
 *
 * 为什么是「全部」而不是「第一个」：多 A 记录/轮询 DNS 下，只要有一个结果是内网地址，
 * 「连到哪一个」就变成了运气问题。全部必须干净才放行（fail-closed）。
 *
 * DNS 失败（ENOTFOUND / 超时）映射成 `rejected_target` 而不是 `transport_error`：
 * 解析不了的目标在静默期内重试同样的次数也是同样的结果，而 `transport_error` 会触发
 * F4.3 的 3 次重试（契约 F9 第 4 条明确「校验失败 → 不重试」）。
 */
export async function resolveWebhookTarget(
  input: string | null | undefined,
  options: { allowInsecureHttp?: boolean; resolve?: WebhookResolver } = {},
): Promise<WebhookResolvedTarget> {
  const parsed = parseWebhookTarget(input, options);
  if (!parsed.ok) return parsed;

  const resolveFn = options.resolve ?? defaultWebhookResolver;
  let resolved: readonly ResolvedAddress[];
  try {
    resolved = await resolveFn(parsed.hostname);
  } catch {
    return { ok: false, reason: "unresolvable" };
  }
  if (!Array.isArray(resolved) || resolved.length === 0) return { ok: false, reason: "unresolvable" };
  for (const entry of resolved) {
    if (!isPermittedWebhookAddress(entry?.address ?? "")) {
      return { ok: false, reason: "forbidden_address" };
    }
  }
  return { ok: true, url: parsed.url, hostname: parsed.hostname, addresses: [...resolved] };
}

/* ================================================================== */
/* 载荷（F9 明确不做自定义模板 ⇒ 冻结一个中性 JSON 信封）                */
/* ================================================================== */

/**
 * 载荷形状（v1，冻结）：
 * ~~~json
 * { "version": 1, "source": "tunex", "subject": "...", "text": "..." }
 * ~~~
 *
 * 为什么是**中性信封**而不是 Slack/DingTalk/企微各自的格式：F9 明确"不做用户自定义 URL 模板"，
 * 而 `scripts/ops/alert.sh` 那套 vendor JSON 一旦搬进来，就等于给每家的格式在控制面里留一份实现
 * 与一份测试。中性信封 + `text` 字段是把"怎么显示"留给接收方（各自的转发器/中间层）。
 *
 * 注意 `text` 就是 F10 渲染出来的纯文本（原因码/资源/时间），**不含**任何凭据：
 * 投递目标由渠道自己持有，不进载荷。
 */
export function buildWebhookPayload(rendered: RenderedNotification): string {
  return JSON.stringify({
    version: WEBHOOK_PAYLOAD_VERSION,
    source: "tunex",
    subject: rendered.subject,
    text: rendered.text,
  });
}

/* ================================================================== */
/* 出站传输（连接级固定 IP，F9.4）                                       */
/* ================================================================== */

export interface WebhookTransportRequest {
  readonly url: URL;
  /** 已校验的目标地址（**必须**连它，而不是再解析一次域名）。 */
  readonly address: ResolvedAddress;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly timeoutMs: number;
}

export interface WebhookTransportResponse {
  readonly status: number;
  /** 3xx 的 Location（只为把「拒绝重定向」的原因写清楚，**绝不**跟随）。 */
  readonly location: string | null;
}

export type WebhookTransport = (request: WebhookTransportRequest) => Promise<WebhookTransportResponse>;

/** 请求行/头里出现 CRLF 就拒绝：Host 与路径都必须来自 URL 解析结果，不允许任何拼接注入。 */
function assertNoCrlf(value: string, what: string): void {
  if (/[\r\n]/.test(value)) throw new Error(`webhook: CRLF in ${what}`);
}

/** 组装请求头字节（导出以便离线断言 Host/Content-Length/CRLF 纪律）。 */
export function buildWebhookRequestHead(request: WebhookTransportRequest): string {
  const { url } = request;
  const head = `${(url.pathname || "/") + url.search}`;
  const host = url.port === "" ? url.hostname : `${url.hostname}:${url.port}`;
  assertNoCrlf(head, "path");
  assertNoCrlf(host, "host");
  for (const [key, value] of Object.entries(request.headers)) {
    assertNoCrlf(key, "header name");
    assertNoCrlf(value, `header ${key}`);
  }
  const lines = [
    `POST ${head} HTTP/1.1`,
    `Host: ${host}`,
    `User-Agent: tunex-notification/${WEBHOOK_PAYLOAD_VERSION}`,
    `Content-Type: application/json`,
    `Accept: application/json`,
    `Content-Length: ${Buffer.byteLength(request.body, "utf8")}`,
    `Connection: close`,
    ...Object.entries(request.headers).map(([key, value]) => `${key}: ${value}`),
  ];
  return `${lines.join("\r\n")}\r\n\r\n`;
}

/** 解析状态行（`HTTP/1.1 302 Found`）。畸形响应 → null（调用方按传输失败处理）。 */
export function parseWebhookStatusLine(head: string): number | null {
  const match = /^HTTP\/1\.[01] (\d{3})/.exec(head);
  if (!match) return null;
  const status = Number(match[1]);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

/** 从响应头里取 Location（大小写不敏感；不存在 → null）。 */
export function parseWebhookLocationHeader(head: string): string | null {
  const match = /^location:[ \t]*(.*)$/im.exec(head);
  const value = match?.[1]?.trim();
  return value ? value : null;
}

/**
 * 默认传输：**直连已校验的 IP**，Host 头 / TLS SNI 仍用域名，只读响应头就断开。
 *
 * 这里刻意不用 `fetch`（见文件头注释）：
 *  · `fetch` 无法指定连接目标 IP（Bun 不暴露 dispatcher/Agent）→ 会有二次解析窗口；
 *  · `fetch` 默认跟随重定向（要记得关，且"记得关"不是边界）；
 *  · `fetch` 会把整个响应体读进来（对方可控长度）。
 * 本实现三条都是结构性的：连哪个 IP 是参数、读到 `\r\n\r\n` 就断开、永不发第二个请求。
 */
export function createPinnedSocketTransport(): WebhookTransport {
  return (request) =>
    new Promise<WebhookTransportResponse>((resolve, reject) => {
      const head = buildWebhookRequestHead(request);
      const port = request.url.port === "" ? (request.url.protocol === "https:" ? 443 : 80) : Number(request.url.port);
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        fn();
      };

      const socket: Socket =
        request.url.protocol === "https:"
          ? tlsConnect(
              {
                host: request.address.address,
                port,
                // SNI + 证书校验都对着**域名**：固定 IP 只影响"连到哪"，不影响"信任谁"。
                // IP 字面量目标（`https://<public-ip>/`）没有 SNI 可言，省略（Node 明确不接受 IP 作 servername）。
                ...(isIP(request.url.hostname) === 0 ? { servername: request.url.hostname } : {}),
              },
              onConnect,
            )
          : netConnect({ host: request.address.address, port }, onConnect);

      socket.setTimeout(request.timeoutMs, () => {
        socket.destroy();
        finish(() => reject(new Error("webhook: request timeout")));
      });
      socket.on("error", (err) => finish(() => reject(err)));
      // `end`（连接被对端关掉却还没拿到完整响应头）也要收敛，否则 Promise 永远挂着。
      socket.on("close", () => finish(() => reject(new Error("webhook: connection closed before response"))));

      let buffer = "";
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("latin1");
        if (buffer.length > WEBHOOK_RESPONSE_HEAD_MAX) {
          socket.destroy();
          finish(() => reject(new Error("webhook: response headers too large")));
          return;
        }
        const endOfHead = buffer.indexOf("\r\n\r\n");
        if (endOfHead === -1) return;
        const headText = buffer.slice(0, endOfHead);
        const status = parseWebhookStatusLine(headText);
        const location = parseWebhookLocationHeader(headText);
        // ★ 只读响应头：**不读响应体**，也不发第二个请求（重定向在这里没有实现余地）。
        socket.destroy();
        if (status === null) {
          finish(() => reject(new Error("webhook: malformed status line")));
          return;
        }
        finish(() => resolve({ status, location }));
      });

      function onConnect(): void {
        socket.write(head + request.body, "utf8");
      }
    });
}

/* ================================================================== */
/* 渠道实现                                                            */
/* ================================================================== */

export interface WebhookChannelDeps {
  /** 部署级开关；默认 {@link isWebhookChannelEnabled}（读 env，**默认关**）。 */
  enabled?: () => boolean;
  /** 是否允许明文 http；默认 {@link isWebhookInsecureHttpAllowed}。 */
  allowInsecureHttp?: () => boolean;
  /** DNS 解析器；默认 {@link defaultWebhookResolver}。 */
  resolve?: WebhookResolver;
  /** 出站传输；默认 {@link createPinnedSocketTransport}（单测注入替身以断言"零出站"）。 */
  transport?: WebhookTransport;
  timeoutMs?: number;
}

/**
 * webhook 渠道。`isConfigured` = 部署级开关**开着**：
 *
 * 渠道配置（URL、启用状态）按 F5 存在 `notification_channel` 表里，由调用方的
 * `resolveTargets` 取出来作为 `target` 传进来（18.2 的 `NotificationTargetResolver`
 * 契约：收件人**由调用方给出**，本层绝不猜）。本层只管「拿到的目标能不能发」。
 */
export function createWebhookChannel(deps: WebhookChannelDeps = {}): NotificationChannel {
  const enabled = deps.enabled ?? (() => isWebhookChannelEnabled());
  const allowInsecureHttp = deps.allowInsecureHttp ?? (() => isWebhookInsecureHttpAllowed());
  const resolveFn = deps.resolve ?? defaultWebhookResolver;
  const transport = deps.transport ?? createPinnedSocketTransport();
  const timeoutMs = deps.timeoutMs ?? WEBHOOK_TIMEOUT_MS;

  return {
    kind: "webhook",
    isConfigured(_scope: NotificationScope) {
      // 本期渠道是平台级部署开关，不看 scope（按租户自带渠道是契约 O6，本期明确不做）。
      return enabled();
    },
    validateConfig(input): ChannelConfigCheck {
      const check = parseWebhookTarget(input.target, { allowInsecureHttp: allowInsecureHttp() });
      return check.ok ? { ok: true } : { ok: false, reason: "rejected_target" };
    },
    async send(rendered, target): Promise<ChannelResult> {
      // 1) 形状 + DNS + IP：**任何一步不过都不出站**（DoD5 的"零出站"就是这一步的产物）。
      const resolved = await resolveWebhookTarget(target, {
        allowInsecureHttp: allowInsecureHttp(),
        resolve: resolveFn,
      });
      if (!resolved.ok) {
        return {
          sent: false,
          reason: "rejected_target",
          detail: redactWebhookDetail(`webhook target rejected: ${resolved.reason}`, target),
        };
      }

      const body = buildWebhookPayload(rendered);
      const address = resolved.addresses[0]!;
      let response: WebhookTransportResponse;
      try {
        response = await transport({
          url: resolved.url,
          address,
          headers: {},
          body,
          timeoutMs,
        });
      } catch (err) {
        return { sent: false, reason: "transport_error", detail: redactWebhookDetail(err, target) };
      }

      // 2) 3xx：**拒绝**而不是跟随（F9.3）。跟随重定向会绕过上面刚做完的 IP 校验。
      if (response.status >= 300 && response.status < 400) {
        return {
          sent: false,
          reason: "rejected_target",
          detail: redactWebhookDetail(`webhook redirect not allowed: http_${response.status}`, target),
        };
      }
      if (response.status >= 200 && response.status < 300) return { sent: true };
      return {
        sent: false,
        reason: "transport_error",
        detail: redactWebhookDetail(`webhook http_${response.status}`, target),
      };
    },
    redactTarget(target: string) {
      return redactWebhookTarget(target);
    },
  };
}
