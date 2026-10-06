// 行为参照：ForwardX（AGPL-3.0-only）——Looking Glass 方法集与结果语义；代码为本项目改写，未复制其实现。

/**
 * Looking Glass（面板侧安全边界 + 有界编排）。
 *
 * 契约：`docs/v5-wp19-latency-observability-contract.md` §3 D7 / §4.0 O2 / §5 WP19-D / §7 G19.9–G19.13。
 * 边界来自 控制面安全边界「用户输入不能让 Agent 变成任意网络扫描器」。
 *
 * ── 这个功能是什么 ──
 * 「从我的某个节点出发，能不能连上一个**公网**目标」——一次有界、可审计、默认关闭的
 * 主动测试。它不是数据面的一部分，也不产生 desired 事实（D4：观测不得成为第二份真相）。
 *
 * ── 五条边界（同时成立，D7）──
 * ① 只能测**本 workspace 内、调用者有权读**的节点，跨租户一律拒绝（404，不泄漏存在性）；
 * ② 目标解释后**全部**为公网单播：私网/环回/链路本地/多播/保留段一律拒绝；
 * ③ 同一节点同一时刻**至多一个**测试（并发第二条 fail-closed，不是排队）；
 * ④ **部署级开关默认关闭**：关闭时非管理员明确拒绝（不是静默空结果），平台管理员
 *    仍可用但审计里带 `admin_override` 标记；
 * ⑤ 每次发起/拒绝/完成都写审计（actor+node+方法+目标+结果码），结果**不落库**、
 *    只出现在发起者的响应里，不含数据面载荷。
 *
 * ── 威胁模型（谁在攻击什么）──
 * 这个功能的危险在于：**Agent 跑在客户机房里**，而请求来自用户输入。若不做边界，
 * 它就等于一个"用别人家的机器扫内网"的跳板（SSRF + 端口扫描）。因此：
 *
 *   · 私网拒绝**在面板侧**先做一遍（不把扫描请求发出去）；
 *   · 面板把域名**解析成地址**并把地址**钉死**（pin）写进命令，Agent **只拨字面地址**、
 *     自己再判一次公网 —— 这一层同时防住 DNS 重绑定（TOCTOU）与"面板有 bug/被攻破"；
 *   · 数字写法变体（十进制 `2130706433`、八进制 `0177.0.0.1`、十六进制 `0x7f.0.0.1`、
 *     短形式 `127.1`）**一律拒绝而不是解释**：解释权是 libc/解析器差异的发源地，
 *     拒绝比"猜得对"更安全，而且 Agent 侧（Go `netip`）也不会重新解释它们；
 *   · Agent 侧先校验**全部**目标，任何一个不合格就**一个包都不发**（不是"跳过坏的继续"）。
 *
 * ── 明确不防 / 不做（写清楚比假装安全重要）──
 *   · **不做 HTTP**：本 WP 只做 TCP 连接探测，因此没有重定向跟随、没有 HTTPS 降级、
 *     没有代理环境变量、没有 Host 头伪造这四类绕过面 —— 因为这些代码路径根本不存在。
 *     （若将来加 HTTP 探测，必须先回答重定向与凭据泄漏问题，另立契约。）
 *   · **不做节点侧 DNS 诊断**：域名一定由面板解析。因此本功能**不能**回答
 *     "节点侧 DNS 能不能解析这个域名"，这是有意的取舍（代价写进 caveats）。
 *   · **不防**目标地址在 Agent 拨号瞬间被网络层重定向（BGP/路由劫持、目标自身也是
 *     攻击者）：我们能保证的是"包只发给这个公网地址"，不能保证"这个地址的运营者是谁"。
 *   · **不是**端口扫描器：一次请求 ≤4 个固定 (地址,端口)，无端口范围语法，无并发放大。
 *   · 单飞锁是**进程内**的：多副本部署时它不是全局锁（见 `LookingGlassLocks`）。
 */

import { redact } from "./redaction.ts";
import type { AgentV2CapabilityFacts } from "./capability-manifest.ts";
import { admitAction } from "./runtime-admission.ts";

/* ================================================================== */
/* 常量表（每一项都注明保护什么，参照 target-health-thresholds.ts 纪律）  */
/* ================================================================== */

/** 新控制协议动作名。与 Go 侧 `control.ActionLookingGlass` 必须逐字一致。 */
export const LOOKING_GLASS_ACTION = "looking_glass";

/**
 * 方法闭集（task-40 从 1 种扩到 3 种）。成员是**我们真的能执行**的方法：
 *  · `tcp_connect` —— 无特权、无 shell、无载荷，和既有 diag 探针同一原语；
 *  · `ping` / `ping6` —— ICMP echo。**旧注释里"ICMP 需要 CAP_NET_RAW"只对了一半**，
 *    2026-10-07 在生产 caps（`--cap-drop ALL --cap-add NET_BIND_SERVICE`，CapEff=0x400）
 *    下实测：内核允许非特权 ICMP 时（`net.ipv4.ping_group_range=0 2147483647`），
 *    busybox `ping` 走 SOCK_DGRAM/ICMP **成功**收到真实回包（1.1.1.1，avg 1.983 ms）；
 *    需要 CAP_NET_RAW 的是 **raw socket**，也就是 `traceroute`（实测 EPERM）。
 *    agent 侧因此不自己开 socket，而是在固定候选绝对路径上调用镜像自带的 ping 二进制。
 *  · **不做** `traceroute`/`traceroute6`/`mtr`/`mtr6` —— 见 {@link LOOKING_GLASS_UNAVAILABLE_METHODS}，
 *    如实标"不可用"并给原因，而不是假装支持；
 *  · 不做 UDP（没有可靠回包来源，做了就是编造事实，D6/§4.0 O3）；
 *  · 不做 HTTP（见文件头：重定向/降级/凭据是另一份威胁模型的活）。
 * 未知方法**拒绝**而不是"忽略后当 TCP 处理"（危险方向：静默降级）。
 */
export const LOOKING_GLASS_METHODS = ["tcp_connect", "ping", "ping6"] as const;

/**
 * 本版本**明确不提供**的方法，以及原因。
 *
 * 为什么要有一个显式列表而不是"干脆不提"：ForwardX 的方法集里有它们（traceroute/
 * traceroute6/mtr/mtr6），运维会照着找。不说清"为什么没有"就会被读成"这个产品没有
 * 诊断能力"，而真相是**在我们的权限模型下做不到**：
 *
 *   · `traceroute`/`traceroute6` —— 需要 **raw socket**（CAP_NET_RAW）。生产安装脚本
 *     给 agent 的是 `--cap-drop ALL --cap-add NET_BIND_SERVICE`，实测
 *     `socket(AF_INET,3,1): Operation not permitted`。放宽它等于给每个节点开一个
 *     原始包能力，与"静态非特权二进制"的取向冲突，本版本不做。
 *   · `mtr`/`mtr6` —— 镜像里**没有这个二进制**，且同样依赖 raw socket。
 *
 * 这份列表同时是 UI 的文案来源：面板据此显示"该方法是本版本不提供的，原因是 X"，
 * 而不是让用户以为"按钮坏了"。
 */
export const LOOKING_GLASS_UNAVAILABLE_METHODS = [
  {
    method: "traceroute",
    reason: "需要 raw socket（CAP_NET_RAW）；生产安装用 --cap-drop ALL --cap-add NET_BIND_SERVICE，实测 socket 被拒（EPERM）",
  },
  {
    method: "traceroute6",
    reason: "同 traceroute：raw socket 需要 CAP_NET_RAW，生产 caps 下不可用",
  },
  { method: "mtr", reason: "镜像里没有 mtr 二进制，且依赖 raw socket（CAP_NET_RAW）" },
  { method: "mtr6", reason: "同 mtr：无二进制 + 依赖 raw socket" },
] as const;
export type LookingGlassMethod = (typeof LOOKING_GLASS_METHODS)[number];
export const LOOKING_GLASS_DEFAULT_METHOD: LookingGlassMethod = "tcp_connect";

/** 一次请求最多几个用户目标。保护：这个功能不能变成扫描器（无放大、无范围语法）。 */
export const LOOKING_GLASS_MAX_REQUESTED_TARGETS = 4;
/** 解析后最多几个固定地址（一个域名可能有多条 A/AAAA）。超限**拒绝而非截断**。 */
export const LOOKING_GLASS_MAX_PINNED_ADDRESSES = 4;
/** 单次连接尝试的默认/最大超时。保护：一次请求的总时长有上界。 */
export const LOOKING_GLASS_DEFAULT_TIMEOUT_MS = 3000;
export const LOOKING_GLASS_MAX_TIMEOUT_MS = 5000;
/** 面板侧 DNS 解析预算。保护：解析不能成为"请求挂住"的入口。 */
export const LOOKING_GLASS_RESOLVE_TIMEOUT_MS = 3000;
/** 等 ACK 的余量/上限：`timeout * 地址数 + slack`，封顶 20s。 */
export const LOOKING_GLASS_ACK_SLACK_MS = 5000;
export const LOOKING_GLASS_MAX_ACK_WAIT_MS = 20_000;
/**
 * 单飞锁的 TTL。保护：一次崩溃/超时的请求**不能永久占住**一个节点
 * （宁可在一个有界窗口后放行下一个请求，也不要让功能静默死掉）。
 */
export const LOOKING_GLASS_INFLIGHT_TTL_MS = 30_000;
/** 部署级开关的环境变量名。默认关闭（未设置 = 关闭）。 */
export const LOOKING_GLASS_ENABLED_ENV = "LOOKING_GLASS_ENABLED";
/** 目标字符串长度上界（与控制协议 `MAX_ADDRESS_LEN` 一致）。 */
export const LOOKING_GLASS_MAX_HOST_CHARS = 253;
/** 单条 detail 的字符上界（与 Agent 侧 `diag.MaxDetailChars` 一致）。 */
export const LOOKING_GLASS_DETAIL_MAX_CHARS = 160;

/** 结果状态闭集（与 Go `diag.Status` 逐字一致）。 */
export const LOOKING_GLASS_STATUSES = [
  "reachable",
  "refused",
  "timeout",
  "dns_error",
  "invalid_target",
  "error",
  "unsupported",
] as const;

export const LOOKING_GLASS_CODES = {
  disabled: "looking_glass_disabled",
  busy: "looking_glass_busy",
  notFound: "not_found",
  tooManyTargets: "too_many_targets",
  tooManyAddresses: "too_many_pinned_addresses",
  duplicateTarget: "duplicate_target",
  invalidPort: "invalid_port",
  addressNotCanonical: "address_not_canonical",
  specialUseName: "special_use_name",
  invalidHostname: "invalid_hostname",
  targetNotPublic: "target_not_public",
  targetUnresolved: "target_unresolved",
  resolverInvalid: "resolver_returned_invalid_address",
  methodNotSupported: "method_not_supported",
  timeoutOutOfRange: "timeout_out_of_range",
  auditUnavailable: "audit_unavailable",
  agentFailed: "agent_failed",
  incompleteResult: "incomplete_result",
  invalidResult: "invalid_result",
} as const;

/**
 * 口径声明：随报告一起返回，避免"连上了"被读成"业务可用"。
 * `null ≠ 0`、`不可比的不并排`（D12）同样适用：这里只给事实与边界。
 */
export const LOOKING_GLASS_CAVEATS: readonly string[] = [
  "这是从该节点发出的主动探测（tcp_connect / ping / ping6）：连上或收到回包只证明 L3/L4 可达，不证明对端业务可用。",
  "域名由面板解析、节点只拨固定地址：因此它不能回答「节点侧 DNS 能否解析该域名」。",
  "ping/ping6 由节点在容器内调用镜像自带的 ping 二进制（非特权 ICMP），**依赖节点内核允许非特权 ICMP**；" +
    "ping6 还需要节点自身有 IPv6 出网路径 —— 没有时结果是 unreachable，那不是方法未实现。",
  "不含 traceroute / mtr：它们需要 raw socket（CAP_NET_RAW），而生产安装用 --cap-drop ALL --cap-add NET_BIND_SERVICE（实测 EPERM；mtr 连二进制都没有）。",
  "不含 UDP：datagram 没有可靠探测来源，本版本不产生该事实。",
  "不含 HTTP：重定向/降级/凭据是另一份威胁模型，本版本不做。",
  "结果不含任何数据面载荷与凭据；每次发起与拒绝都会写审计。",
];

/* ================================================================== */
/* 开关（默认关；解析严格 fail-closed）                                  */
/* ================================================================== */

/**
 * 解析 `LOOKING_GLASS_ENABLED`。
 *
 * 只有显式真值（`1/true/yes/on`，大小写不敏感、两侧空白忽略）才开启；**其它一切**
 * ——包括未设置、空串、拼写错误（`ture`/`enable`/`TRUE `（trim 后可以））——都是关闭。
 * 方向刻意的：开关解析"宽松"意味着一次拼写错误就把一个对客户机房发探测包的功能打开。
 */
export function lookingGlassEnabledFromEnv(raw: string | undefined | null): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

/* ================================================================== */
/* 地址解析：先规范，再分类                                              */
/* ================================================================== */

/**
 * 规范 IPv4 字面量的唯一写法：四段十进制、无前导零。
 *
 * 前导零是**写法变体**的核心：`0177.0.0.1` 在有的解析器里是八进制（=127.0.0.1），
 * 在另一些里直接报错。我们不做那种解释，直接判成"非规范地址写法"并拒绝。
 * `2130706433` / `0x7f000001` / `127.1` 同理（见 `looksLikeAddressLiteralVariant`）。
 */
export function parseCanonicalIPv4(text: string): number | null {
  const match = /^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$/.exec(text);
  if (!match) return null;
  let value = 0;
  for (let i = 1; i <= 4; i += 1) {
    const octet = Number(match[i]);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

export function formatIPv4(value: number): string {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(".");
}

const IPV6_GROUP = /^[0-9a-fA-F]{1,4}$/;

/**
 * 严格 IPv6 解析（RFC 4291 文本形式），产出 16 字节。
 *
 * 为什么自己写而不是用平台 API：**分类必须在字节上做**（私网判断、映射形式、前缀匹配），
 * 而各平台 API 对"哪个字符串算合法"的宽容度不同（是否接受 zone id、是否接受 `<v4>`
 * 尾段、是否折叠 `::`）。这里只要一种解释，并且有与 Go `netip` 共享的测试向量。
 *
 * 拒绝：zone id（`%eth0`）、多个 `::`、组数不为 8（无 `::` 时）、组数 ≥8（有 `::` 时）、
 * 空组（非 `::` 位置）、非十六进制字符、尾部 IPv4 段非规范 IPv4。
 */
export function parseIPv6(text: string): Uint8Array | null {
  const raw = text.trim();
  if (raw === "" || raw.length > 45) return null;
  if (raw.includes("%")) return null; // zone id：绝不拨带 zone 的地址
  if (!raw.includes(":")) return null;
  const marker = raw.indexOf("::");
  if (marker !== -1 && raw.indexOf("::", marker + 1) !== -1) return null;

  const head = marker === -1 ? raw : raw.slice(0, marker);
  const tail = marker === -1 ? "" : raw.slice(marker + 2);
  const headBytes = parseIPv6Groups(head === "" ? [] : head.split(":"), false);
  const tailBytes = parseIPv6Groups(tail === "" ? [] : tail.split(":"), true);
  if (headBytes === null || tailBytes === null) return null;
  const total = headBytes.length + tailBytes.length;
  if (marker === -1) {
    if (total !== 16) return null;
  } else if (total >= 16) {
    // `::` 至少要代表一个 16 位组；`1:2:3:4:5:6:7:8::` 这种是非法的。
    return null;
  }
  const bytes = new Uint8Array(16);
  bytes.set(headBytes, 0);
  bytes.set(tailBytes, 16 - tailBytes.length);
  return bytes;
}

function parseIPv6Groups(groups: string[], allowIPv4Tail: boolean): number[] | null {
  const out: number[] = [];
  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i];
    if (group === "") return null;
    if (allowIPv4Tail && i === groups.length - 1 && group.includes(".")) {
      const embedded = parseCanonicalIPv4(group);
      if (embedded === null) return null;
      out.push((embedded >>> 24) & 0xff, (embedded >>> 16) & 0xff, (embedded >>> 8) & 0xff, embedded & 0xff);
      continue;
    }
    if (!IPV6_GROUP.test(group)) return null;
    const value = Number.parseInt(group, 16);
    out.push((value >> 8) & 0xff, value & 0xff);
  }
  return out;
}

/** 小写、无前导零、压缩最长零段的规范文本（可被 `netip.ParseAddr` 逐字接受）。 */
export function formatIPv6(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new TypeError("IPv6 必须是 16 字节");
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((bytes[i] << 8) | bytes[i + 1]);

  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;
  for (let i = 0; i <= groups.length; i += 1) {
    if (i < groups.length && groups[i] === 0) {
      if (runStart === -1) runStart = i;
    } else if (runStart !== -1) {
      const len = i - runStart;
      if (len > bestLen) {
        bestLen = len;
        bestStart = runStart;
      }
      runStart = -1;
    }
  }
  if (bestLen < 2) return groups.map((g) => g.toString(16)).join(":");
  const left = groups.slice(0, bestStart).map((g) => g.toString(16)).join(":");
  const right = groups.slice(bestStart + bestLen).map((g) => g.toString(16)).join(":");
  return `${left}::${right}`;
}

function isIPv4Mapped(bytes: Uint8Array): boolean {
  for (let i = 0; i < 10; i += 1) if (bytes[i] !== 0) return false;
  return bytes[10] === 0xff && bytes[11] === 0xff;
}

function ipv4FromBytes(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
  );
}

/* ------------------------------------------------------------------ */
/* 非公网段表（黑名单，逐条注明命中说明）                                 */
/* ------------------------------------------------------------------ */

interface V4Range {
  readonly start: number;
  readonly end: number;
  readonly label: string;
}

/** `a.b.c.d/n` → [start, end]；只在模块加载时算一次。 */
function v4Range(cidr: string, label: string): V4Range {
  const [addr, bitsText] = cidr.split("/");
  const bits = Number(bitsText);
  const base = parseCanonicalIPv4(addr);
  if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    throw new TypeError(`非法 IPv4 网段: ${cidr}`);
  }
  const size = 2 ** (32 - bits);
  const start = bits === 0 ? 0 : (base - (base % size)) >>> 0;
  return { start, end: (start + size - 1) >>> 0, label };
}

/**
 * 非公网 IPv4 段。**这是安全边界**，不是便利性设置。
 *
 * 列表刻意覆盖比 RFC1918 更宽：凡是"不是可路由公网单播"的都拒绝。理由是可审计性——
 * 一条"只信公网"的规则可以由这张表逐条复核，而"只拒 RFC1918"要靠列举绕过手法来证明安全。
 */
export const NON_PUBLIC_V4_RANGES: readonly V4Range[] = [
  v4Range("0.0.0.0/8", "0.0.0.0/8 本网络"),
  v4Range("10.0.0.0/8", "10.0.0.0/8 私网"),
  v4Range("100.64.0.0/10", "100.64.0.0/10 运营商级 NAT"),
  v4Range("127.0.0.0/8", "127.0.0.0/8 环回"),
  v4Range("169.254.0.0/16", "169.254.0.0/16 链路本地（含云元数据）"),
  v4Range("172.16.0.0/12", "172.16.0.0/12 私网"),
  v4Range("192.0.0.0/24", "192.0.0.0/24 IETF 协议保留"),
  v4Range("192.0.2.0/24", "192.0.2.0/24 文档用 TEST-NET-1"),
  v4Range("192.88.99.0/24", "192.88.99.0/24 6to4 中继任播"),
  v4Range("192.168.0.0/16", "192.168.0.0/16 私网"),
  v4Range("198.18.0.0/15", "198.18.0.0/15 基准测试"),
  v4Range("198.51.100.0/24", "198.51.100.0/24 文档用 TEST-NET-2"),
  v4Range("203.0.113.0/24", "203.0.113.0/24 文档用 TEST-NET-3"),
  v4Range("224.0.0.0/4", "224.0.0.0/4 多播"),
  v4Range("240.0.0.0/4", "240.0.0.0/4 保留（含 255.255.255.255 广播）"),
];

interface V6Range {
  readonly bytes: Uint8Array;
  readonly bits: number;
  readonly label: string;
}

function v6Range(cidr: string, label: string): V6Range {
  const [addr, bitsText] = cidr.split("/");
  const bits = Number(bitsText);
  const bytes = parseIPv6(addr);
  if (bytes === null || !Number.isInteger(bits) || bits < 0 || bits > 128) {
    throw new TypeError(`非法 IPv6 网段: ${cidr}`);
  }
  return { bytes, bits, label };
}

/**
 * 非公网 IPv6 段。除了私网/环回/链路本地/多播，还包含**会内嵌 IPv4 的隧道形式**
 * （6to4 `2002::/16`、Teredo `2001::/32`、NAT64 `64:ff9b::/96`）：它们可以把一个
 * 内网 v4 地址"包装"成看起来正常的 v6 地址，因此整段拒绝，不做内嵌解析。
 */
export const NON_PUBLIC_V6_RANGES: readonly V6Range[] = [
  v6Range("::/96", "::/96 未指定 / IPv4 兼容（已废弃）"),
  v6Range("64:ff9b::/96", "64:ff9b::/96 NAT64 知名前缀"),
  v6Range("64:ff9b:1::/48", "64:ff9b:1::/48 本地用 NAT64"),
  v6Range("100::/64", "100::/64 丢弃专用"),
  v6Range("2001::/32", "2001::/32 Teredo（内嵌 IPv4）"),
  v6Range("2001:2::/48", "2001:2::/48 基准测试"),
  v6Range("2001:10::/28", "2001:10::/28 ORCHID"),
  v6Range("2001:20::/28", "2001:20::/28 ORCHIDv2"),
  v6Range("2001:db8::/32", "2001:db8::/32 文档用"),
  v6Range("2002::/16", "2002::/16 6to4（内嵌 IPv4）"),
  v6Range("3fff::/20", "3fff::/20 文档用"),
  v6Range("5f00::/16", "5f00::/16 SRv6 SID"),
  v6Range("fc00::/7", "fc00::/7 唯一本地地址"),
  v6Range("fe80::/10", "fe80::/10 链路本地"),
  v6Range("fec0::/10", "fec0::/10 站点本地（已废弃）"),
  v6Range("ff00::/8", "ff00::/8 多播"),
];

function prefixMatches(bytes: Uint8Array, range: V6Range): boolean {
  const fullBytes = range.bits >> 3;
  for (let i = 0; i < fullBytes; i += 1) if (bytes[i] !== range.bytes[i]) return false;
  const remainder = range.bits & 7;
  if (remainder === 0) return true;
  const mask = 0xff << (8 - remainder) & 0xff;
  return (bytes[fullBytes] & mask) === (range.bytes[fullBytes] & mask);
}

/* ------------------------------------------------------------------ */
/* 地址 → 判定                                                        */
/* ------------------------------------------------------------------ */

export type AddressVerdict =
  | { ok: true; address: string; family: 4 | 6 }
  | { ok: false; code: string; message: string };

function refuse(code: string, message: string): AddressVerdict {
  return { ok: false, code, message };
}

/**
 * 字面地址 → 公网判定。**唯一**的地址准入函数（面板与 Agent 两侧各自实现同一张表）。
 *
 * 关键性质（都有反例断言）：
 *   · 非规范写法（十进制/八进制/十六进制/短形式/前导零）→ `address_not_canonical`，
 *     不会被"猜"成某个地址；
 *   · 方括号形式（`[::1]`）与 zone id（`fe80::1%eth0`）**拒绝**（与 Agent 侧同规则，
 *     不做"剥掉后判定"——两处不对称比一种写法被拒更难查）；
 *   · `::ffff:127.0.0.1` 这类映射形式**先还原成内嵌 IPv4 再判定**，因此映射不构成绕过；
 *   · 大小写不敏感（十六进制大小写、`::FFFF:` 都归一）。
 */
export function classifyTargetAddress(input: string): AddressVerdict {
  const trimmed = input.trim();
  if (trimmed === "") return refuse(LOOKING_GLASS_CODES.addressNotCanonical, "地址为空");
  // 方括号形式（URL 里的 `[::1]`）**拒绝而不是剥掉后判定**：理由不是"剥掉不安全"
  // （剥掉后照样按字节判），而是**两侧只有一条规则**。Agent 侧用 `netip.ParseAddr`，
  // 它同样不接受方括号；面板如果把 `[2606:4700::1111]` 归一成 `2606:4700::1111` 发出去，
  // 就会出现"面板接受了一种 Agent 不接受的输入"这种不对称——它今天无害，明天就是
  // 一个"面板明明判过了却被拒"的谜题。宁可现在让用户看到"请去掉方括号"。
  if (trimmed.startsWith("[") || trimmed.endsWith("]")) {
    return refuse(
      LOOKING_GLASS_CODES.addressNotCanonical,
      "方括号形式一律拒绝：请使用不带方括号的字面地址（IPv6 也直接写，不加 []）",
    );
  }
  const text = trimmed;
  if (text.includes("%")) {
    return refuse(LOOKING_GLASS_CODES.addressNotCanonical, "带 zone id 的地址一律拒绝");
  }

  const v4 = parseCanonicalIPv4(text);
  if (v4 !== null) return classifyIPv4(v4);

  const v6 = parseIPv6(text);
  if (v6 !== null) {
    // 映射形式（::ffff:a.b.c.d）在这里被还原：它和裸 IPv4 是同一个地址，必须同一套判定。
    if (isIPv4Mapped(v6)) return classifyIPv4(ipv4FromBytes(v6, 12));
    for (const range of NON_PUBLIC_V6_RANGES) {
      if (prefixMatches(v6, range)) {
        return refuse(LOOKING_GLASS_CODES.targetNotPublic, `目标地址不属于公网单播（命中保留段 ${range.label}）`);
      }
    }
    return { ok: true, address: formatIPv6(v6), family: 6 };
  }

  return refuse(
    LOOKING_GLASS_CODES.addressNotCanonical,
    "不是规范的 IPv4/IPv6 字面量写法：十进制/八进制/十六进制/短形式一律拒绝（本服务不解释这些写法）",
  );
}

function classifyIPv4(value: number): AddressVerdict {
  for (const range of NON_PUBLIC_V4_RANGES) {
    if (value >= range.start && value <= range.end) {
      return refuse(LOOKING_GLASS_CODES.targetNotPublic, `目标地址不属于公网单播（命中保留段 ${range.label}）`);
    }
  }
  return { ok: true, address: formatIPv4(value), family: 4 };
}

const DOTTED_NUMERIC_LABEL = /^(?:[0-9]+|0[xX][0-9a-fA-F]+)$/;

/**
 * 这是不是一个"看起来像地址、但不是规范地址"的**写法变体**？
 *
 * 命中即**拒绝，且不交给解析器**。这条规则是"写法变体"防线的核心：它保证
 * `2130706433`、`0x7f000001`、`127.1`、`0177.0.0.1`、`127.0.0.1.`、`1.2.3.4.5`
 * 这些字符串**永远不会**被送进 DNS 解析器或拨号器（那里才是 libc/Go 解释差异的战场）。
 *
 * **规范字面量不是变体**：`93.184.216.34` 与 `2606:4700::1111` 在这里返回 false
 * （它们是本服务唯一接受的写法）。这一点必须**先**判，否则所有规范 IPv4 都会被当成
 * "数字变体"拒掉——这不是假设，是这份代码的第一版实测症状。
 *
 * 会不会误伤正常域名？纯数字或"全数字/全 `0x` 段的点分形式"不是合法公网域名
 * （RFC 1123 要求顶级标签以字母开头），因此误伤不可能。
 */
export function looksLikeAddressLiteralVariant(text: string): boolean {
  const value = text.trim();
  if (value === "") return false;
  if (parseCanonicalIPv4(value) !== null) return false; // 规范写法，不是变体
  if (parseIPv6(value) !== null) return false; // 规范 IPv6 同理
  if (/^[0-9]+$/.test(value)) return true;
  if (/^0[xX][0-9a-fA-F]+$/.test(value)) return true;
  if (value.includes(".")) {
    const body = value.endsWith(".") ? value.slice(0, -1) : value;
    if (body !== "" && body.split(".").every((label) => DOTTED_NUMERIC_LABEL.test(label))) return true;
  }
  return false;
}

/**
 * 特殊用途域名后缀：即使解析成功也不测。
 *
 * `.localhost` / `.local`（mDNS）/ `.internal` 等是"内网语义"的名字，`.test`/`.invalid`/
 * `.example` 是 RFC 2606 保留名，`.in-addr.arpa` 是反向解析域。它们的共同点是
 * **不指向公网业务**，而解析它们只会把面板的解析器暴露给内网/挂起的解析路径。
 */
export const SPECIAL_USE_NAME_SUFFIXES: readonly string[] = [
  "localhost",
  "local",
  "localdomain",
  "internal",
  "intranet",
  "home.arpa",
  "onion",
  "test",
  "invalid",
  "example",
  "in-addr.arpa",
  "ip6.arpa",
];

function isPlainHostname(text: string): boolean {
  if (text.length === 0 || text.length > LOOKING_GLASS_MAX_HOST_CHARS) return false;
  if (text.endsWith(".")) return false; // 根点形式：另一种写法变体，拒绝
  const labels = text.split(".");
  if (labels.length < 2) return false; // 单标签名字（内网短名）拒绝
  return labels.every((label) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label) && label.length <= 63);
}

export type HostVerdict =
  | { kind: "literal"; address: string; family: 4 | 6 }
  | { kind: "name"; name: string }
  | { kind: "refused"; code: string; message: string };

/**
 * 用户输入的 host → 字面地址 / 待解析域名 / 拒绝。
 *
 * 顺序刻意：**先**按规范字面量判定（公网允许、私网拒绝），**再**判"是不是写法变体"，
 * 最后才承认它是个域名。反过来做的话，`127.1` 会掉进"域名"分支并被解析器解释；
 * 而把变体判定放在字面量判定**之前**，会把 `93.184.216.34` 这种规范写法也判成
 * "数字变体"（第一版实测症状：所有 IPv4 目标全被拒）。
 */
export function classifyRequestedHost(host: string): HostVerdict {
  const text = String(host ?? "").trim();
  if (text === "") return { kind: "refused", code: LOOKING_GLASS_CODES.invalidHostname, message: "目标为空" };
  if (text.length > LOOKING_GLASS_MAX_HOST_CHARS) {
    return { kind: "refused", code: LOOKING_GLASS_CODES.invalidHostname, message: "目标过长" };
  }
  if (/[\s/\\@?#]/.test(text)) {
    return {
      kind: "refused",
      code: LOOKING_GLASS_CODES.invalidHostname,
      message: "目标含空白或 URL 类字符；这里只接受裸主机名或字面地址",
    };
  }
  const asAddress = classifyTargetAddress(text);
  if (asAddress.ok) return { kind: "literal", address: asAddress.address, family: asAddress.family };
  // 私网字面量的拒绝原样带回（这条最容易被中间层"翻译"掉）。
  if (asAddress.code === LOOKING_GLASS_CODES.targetNotPublic) {
    return { kind: "refused", code: asAddress.code, message: asAddress.message };
  }
  // 到这里它已经不是规范字面量了。是"数字写法变体"就明确拒绝，且**绝不进解析器**。
  if (looksLikeAddressLiteralVariant(text)) {
    return {
      kind: "refused",
      code: LOOKING_GLASS_CODES.addressNotCanonical,
      message: "不是规范的 IP 写法（十进制/八进制/十六进制/短形式/前导零一律拒绝，且不会被解析）",
    };
  }
  // 含冒号的一律按地址问题报（方括号/zone 的具体理由比"不是合法域名"可行动得多）。
  if (text.includes(":")) {
    return { kind: "refused", code: asAddress.code, message: asAddress.message };
  }
  if (!isPlainHostname(text)) {
    return { kind: "refused", code: LOOKING_GLASS_CODES.invalidHostname, message: "既不是规范 IP 字面量，也不是合法域名" };
  }
  const lower = text.toLowerCase();
  const special = SPECIAL_USE_NAME_SUFFIXES.find(
    (suffix) => lower === suffix || lower.endsWith(`.${suffix}`),
  );
  if (special) {
    return {
      kind: "refused",
      code: LOOKING_GLASS_CODES.specialUseName,
      message: `特殊用途域名（.${special}）不测：它不可能指向公网业务`,
    };
  }
  return { kind: "name", name: lower };
}

/* ================================================================== */
/* 请求 → 钉死地址（panel resolves, node dials literals）               */
/* ================================================================== */

export interface LookingGlassRequestedTarget {
  host: string;
  port: number;
}

export interface LookingGlassPinnedTarget {
  /** 规范公网字面地址。命令里传的就是它，Agent 不会再解析。 */
  address: string;
  port: number;
}

export type TargetPlan =
  | {
      ok: true;
      requested: LookingGlassRequestedTarget[];
      pinned: LookingGlassPinnedTarget[];
      /** 用户输入 → 钉死地址的映射（报告里回显口径用）。 */
      pinnedByHost: Array<{ host: string; addresses: string[] }>;
    }
  | { ok: false; code: string; message: string };

function parsePort(value: unknown): number | null {
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

/**
 * 校验用户目标列表（纯函数，0 网络 IO）→ 解析 → 公网判定 → 钉死地址。
 *
 * 拒绝语义全部是**整请求拒绝**：
 *   · 超限 → 拒绝（不截断）；
 *   · 解析出多个地址而有任何一个不是公网 → 拒绝（不是"跳过那个私网的"）；
 *   · 解析失败 → 拒绝（不是"发出去让节点自己解析"）。
 * 理由同一句：**部分成功的地址列表会被读成"这条路径没问题"**（与 diagnose 的
 * `matchExpectedTargets` 同一条纪律）。
 */
export async function planLookingGlassTargets(
  input: unknown,
  deps: {
    resolve(host: string): Promise<string[]>;
    resolveTimeoutMs?: number;
    now?: () => number;
  },
): Promise<TargetPlan> {
  if (!Array.isArray(input) || input.length === 0) {
    return { ok: false, code: LOOKING_GLASS_CODES.tooManyTargets, message: "至少需要一个目标" };
  }
  if (input.length > LOOKING_GLASS_MAX_REQUESTED_TARGETS) {
    return {
      ok: false,
      code: LOOKING_GLASS_CODES.tooManyTargets,
      message: `一次最多 ${LOOKING_GLASS_MAX_REQUESTED_TARGETS} 个目标（超限拒绝，不截断）`,
    };
  }

  const requested: LookingGlassRequestedTarget[] = [];
  const seenRequested = new Set<string>();
  for (const entry of input) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, code: LOOKING_GLASS_CODES.invalidHostname, message: "目标必须是 {host, port} 对象" };
    }
    const row = entry as Record<string, unknown>;
    const host = String(row.host ?? "").trim();
    const port = parsePort(row.port);
    if (port === null) return { ok: false, code: LOOKING_GLASS_CODES.invalidPort, message: "端口必须是 1-65535 的整数" };
    const hostVerdict = classifyRequestedHost(host);
    if (hostVerdict.kind === "refused") return { ok: false, code: hostVerdict.code, message: hostVerdict.message };
    const key = `${host.toLowerCase()}:${port}`;
    if (seenRequested.has(key)) {
      return { ok: false, code: LOOKING_GLASS_CODES.duplicateTarget, message: `重复目标 ${key}` };
    }
    seenRequested.add(key);
    requested.push({ host: hostVerdict.kind === "name" ? hostVerdict.name : host, port });
  }

  const pinned: LookingGlassPinnedTarget[] = [];
  const pinnedKeys = new Set<string>();
  const pinnedByHost: Array<{ host: string; addresses: string[] }> = [];
  const pushPinned = (address: string, port: number): boolean => {
    const key = `${address}:${port}`;
    if (pinnedKeys.has(key)) return true; // 同一个地址被两个域名/多条记录重复给出：去重而不是报错
    if (pinned.length >= LOOKING_GLASS_MAX_PINNED_ADDRESSES) return false;
    pinnedKeys.add(key);
    pinned.push({ address, port });
    return true;
  };

  for (let i = 0; i < requested.length; i += 1) {
    const target = requested[i];
    const verdict = classifyRequestedHost(target.host);
    if (verdict.kind === "refused") return { ok: false, code: verdict.code, message: verdict.message };
    if (verdict.kind === "literal") {
      if (!pushPinned(verdict.address, target.port)) {
        return {
          ok: false,
          code: LOOKING_GLASS_CODES.tooManyAddresses,
          message: `解析后地址数超过 ${LOOKING_GLASS_MAX_PINNED_ADDRESSES}（拒绝，不截断）`,
        };
      }
      pinnedByHost.push({ host: target.host, addresses: [verdict.address] });
      continue;
    }

    let records: string[];
    try {
      records = await withTimeout(
        deps.resolve(verdict.name),
        deps.resolveTimeoutMs ?? LOOKING_GLASS_RESOLVE_TIMEOUT_MS,
      );
    } catch (error) {
      return {
        ok: false,
        code: LOOKING_GLASS_CODES.targetUnresolved,
        message: `面板侧解析失败：${(error as Error).message ?? "unknown"}`,
      };
    }
    if (!Array.isArray(records) || records.length === 0) {
      return { ok: false, code: LOOKING_GLASS_CODES.targetUnresolved, message: "该域名没有解析到任何地址" };
    }
    const addresses: string[] = [];
    for (const record of records) {
      if (typeof record !== "string") {
        return { ok: false, code: LOOKING_GLASS_CODES.resolverInvalid, message: "解析器返回了非字符串地址" };
      }
      const classified = classifyTargetAddress(record);
      if (!classified.ok) {
        // 名字解析到私网/保留段：整请求拒绝。这是防"别名域名打内网"的那一条。
        return {
          ok: false,
          code: classified.code === LOOKING_GLASS_CODES.targetNotPublic
            ? LOOKING_GLASS_CODES.targetNotPublic
            : LOOKING_GLASS_CODES.resolverInvalid,
          message: `${verdict.name} 解析到不可测地址（${record}）：${classified.message}`,
        };
      }
      if (!addresses.includes(classified.address)) addresses.push(classified.address);
    }
    for (const address of addresses) {
      if (!pushPinned(address, target.port)) {
        return {
          ok: false,
          code: LOOKING_GLASS_CODES.tooManyAddresses,
          message: `解析后地址数超过 ${LOOKING_GLASS_MAX_PINNED_ADDRESSES}（拒绝，不截断）`,
        };
      }
    }
    pinnedByHost.push({ host: target.host, addresses });
  }

  if (pinned.length === 0) {
    return { ok: false, code: LOOKING_GLASS_CODES.targetUnresolved, message: "没有可测的目标地址" };
  }
  return { ok: true, requested, pinned, pinnedByHost };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`解析超时（${timeoutMs}ms）`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/* ================================================================== */
/* 单飞锁（每节点至多一个在途测试；进程内，有 TTL）                       */
/* ================================================================== */

/**
 * 进程内的"每节点单飞"。
 *
 * 为什么是 fail-closed 而不是排队：一个排队中的测试会让调用者以为"我发起了"，
 * 而它可能在一分钟后才真的从客户机房发包（D7③ 的"未冻结前默认拒绝"）。
 *
 * 两个诚实的边界：
 *   · **不是分布式锁**：多副本部署时两个副本可以各自放行一次（见契约 §5.3 待办）；
 *   · TTL 到期会**自动放行**下一个请求：宁可在一个有界窗口后允许重试，也不要让
 *     一次进程崩溃把某个节点的测试功能永久锁死（"静默死掉"比"偶发重复"更难发现）。
 */
export class LookingGlassLocks {
  private readonly heldAt = new Map<number, number>();

  constructor(private readonly ttlMs: number = LOOKING_GLASS_INFLIGHT_TTL_MS) {}

  claim(nodeId: number, nowMs: number): { ok: true } | { ok: false; heldForMs: number } {
    const held = this.heldAt.get(nodeId);
    if (held !== undefined) {
      const age = nowMs - held;
      if (age >= 0 && age < this.ttlMs) return { ok: false, heldForMs: age };
    }
    this.heldAt.set(nodeId, nowMs);
    return { ok: true };
  }

  release(nodeId: number): void {
    this.heldAt.delete(nodeId);
  }

  isHeld(nodeId: number, nowMs: number): boolean {
    const held = this.heldAt.get(nodeId);
    return held !== undefined && nowMs - held >= 0 && nowMs - held < this.ttlMs;
  }

  size(): number {
    return this.heldAt.size;
  }
}

export const defaultLookingGlassLocks = new LookingGlassLocks();

/* ================================================================== */
/* 结果归一（Agent 的答案要"不多不少"地回答本次问题）                     */
/* ================================================================== */

export interface LookingGlassResultRow {
  address: string;
  port: number;
  status: string;
  elapsed_ms: number;
  detail?: string;
}

export type ResultNormalization =
  | { ok: true; results: LookingGlassResultRow[] }
  | { ok: false; code: string; message: string };

function keyOf(address: string, port: number): string {
  return `${address.toLowerCase()}:${port}`;
}

/**
 * 归一 Agent 的探测结果。
 *
 * 逐条重建而不是透传（同 `normalizeDiagnoseResults` 的理由：诊断答案不能变成
 * "节点往面板产物里塞任意数据"的通道），并且：
 *   · 覆盖性必须**恰好**等于请求集合 —— 少一个会被读成"这条路径没问题"，多一个
 *     说明节点自己在扫别的地址；
 *   · `resolved_ip` 非空 ⇒ **拒绝整份结果**：我们钉死了字面地址、节点不该做任何
 *     名称解析，出现解析痕迹意味着边界被绕过（这条比"删掉字段"更有价值）。
 */
export function normalizeLookingGlassResults(
  value: unknown,
  expected: readonly LookingGlassPinnedTarget[],
): ResultNormalization {
  if (!Array.isArray(value)) return { ok: false, code: LOOKING_GLASS_CODES.invalidResult, message: "结果必须是数组" };
  const wanted = new Map(expected.map((target) => [keyOf(target.address, target.port), target]));
  if (value.length !== expected.length) {
    return {
      ok: false,
      code: LOOKING_GLASS_CODES.incompleteResult,
      message: `节点返回 ${value.length} 条结果，请求 ${expected.length} 个目标`,
    };
  }
  const seen = new Set<string>();
  const results: LookingGlassResultRow[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, code: LOOKING_GLASS_CODES.invalidResult, message: "结果条目必须是对象" };
    }
    const row = entry as Record<string, unknown>;
    if (typeof row.host !== "string" || row.host.length === 0 || row.host.length > LOOKING_GLASS_MAX_HOST_CHARS) {
      return { ok: false, code: LOOKING_GLASS_CODES.invalidResult, message: "结果 host 缺失或过长" };
    }
    if (typeof row.resolved_ip === "string" && row.resolved_ip.trim() !== "") {
      return {
        ok: false,
        code: LOOKING_GLASS_CODES.invalidResult,
        message: "节点返回了 resolved_ip：本功能要求节点只拨固定地址、不做名称解析",
      };
    }
    const port = parsePort(row.port);
    if (port === null) return { ok: false, code: LOOKING_GLASS_CODES.invalidResult, message: "结果 port 非法" };
    const key = keyOf(row.host, port);
    if (!wanted.has(key)) {
      return { ok: false, code: LOOKING_GLASS_CODES.invalidResult, message: `节点报告了未请求的地址 ${key}` };
    }
    if (seen.has(key)) {
      return { ok: false, code: LOOKING_GLASS_CODES.invalidResult, message: `节点重复报告了 ${key}` };
    }
    seen.add(key);
    if (typeof row.status !== "string" || !LOOKING_GLASS_STATUSES.includes(row.status as never)) {
      return { ok: false, code: LOOKING_GLASS_CODES.invalidResult, message: `未知状态 ${String(row.status)}` };
    }
    if (typeof row.elapsed_ms !== "number" || !Number.isFinite(row.elapsed_ms) || row.elapsed_ms < 0) {
      return { ok: false, code: LOOKING_GLASS_CODES.invalidResult, message: "结果 elapsed_ms 非法" };
    }
    const detail = typeof row.detail === "string" && row.detail !== ""
      ? String(redact(row.detail.slice(0, LOOKING_GLASS_DETAIL_MAX_CHARS)))
      : undefined;
    const target = wanted.get(key)!;
    results.push({
      address: target.address,
      port: target.port,
      status: row.status,
      elapsed_ms: Math.trunc(row.elapsed_ms),
      ...(detail === undefined ? {} : { detail }),
    });
  }
  for (const key of wanted.keys()) {
    if (!seen.has(key)) {
      return { ok: false, code: LOOKING_GLASS_CODES.incompleteResult, message: `节点漏报了 ${key}` };
    }
  }
  return { ok: true, results };
}

/* ================================================================== */
/* 编排                                                                */
/* ================================================================== */

export interface LookingGlassAuditRow {
  action: "looking_glass.test_refused" | "looking_glass.test_issued" | "looking_glass.test_completed";
  workspace_id: number;
  actor_user_id: number | null;
  node_id: number | null;
  node_key: string | null;
  ip: string | null;
  code: string;
  method: LookingGlassMethod | null;
  /** `host:port`（拒绝时是请求原文）或 `address:port`（已钉死）。**只放目标，不放载荷**。 */
  targets: string[];
  admin_override: boolean;
  detail: Record<string, unknown> | null;
}

export interface LookingGlassIssueInput {
  nodeId: number;
  nodeKey: string;
  method: LookingGlassMethod;
  targets: LookingGlassPinnedTarget[];
  timeoutMs: number;
}

export type LookingGlassIssueOutcome =
  | { ok: true; results: unknown }
  | { ok: false; error_code: string; error: string };

export interface LookingGlassDeps {
  /** 部署级开关（生产读 `env.lookingGlassEnabled`）。 */
  enabled(): boolean | Promise<boolean>;
  /** 面板侧解析器（生产用纯 DNS `resolve4`/`resolve6`）。 */
  resolve(host: string): Promise<string[]>;
  /** 本 workspace 内的节点；跨租户必须返回 null（不泄漏存在性）。 */
  loadNode(nodeId: number, workspaceId: number): Promise<{ id: number; node_key: string } | null>;
  /** 能力事实（读不到按"不可用"处理，fail-closed 到"未上报"）。 */
  capabilityFacts(nodeId: number): Promise<AgentV2CapabilityFacts | null>;
  /** 走既有命令总线（`issueAgentLookingGlass`）。 */
  issue(input: LookingGlassIssueInput): Promise<LookingGlassIssueOutcome>;
  /** 审计写入；返回 false = 没写进去。 */
  audit(row: LookingGlassAuditRow): Promise<boolean>;
  locks?: LookingGlassLocks;
  now?: () => Date;
}

export interface LookingGlassRequestInput {
  nodeId: number;
  workspaceId: number;
  actorUserId: number | null;
  isPlatformAdmin: boolean;
  ip?: string | null;
  targets: unknown;
  method?: unknown;
  timeoutMs?: unknown;
}

export interface LookingGlassReport {
  node: { id: number; node_key: string };
  generated_at: string;
  method: LookingGlassMethod;
  /** 开关状态与是否走了管理员例外（透明地告诉操作者"为什么它能跑"）。 */
  entry: { enabled: boolean; admin_override: boolean };
  requested: LookingGlassRequestedTarget[];
  pinned: LookingGlassPinnedTarget[];
  pinned_by_host: Array<{ host: string; addresses: string[] }>;
  results: LookingGlassResultRow[];
  caveats: readonly string[];
}

export type LookingGlassErrorLayer = "capability" | "resource_scope" | "runtime_admission";

export type LookingGlassOutcome =
  | { ok: true; report: LookingGlassReport }
  | {
      ok: false;
      status: 400 | 403 | 404 | 409 | 502 | 503;
      code: string;
      message: string;
      error_layer: LookingGlassErrorLayer;
    };

/** 开关判定：默认关 + 管理员例外（D7④）。 */
export function decideLookingGlassEntry(input: { enabled: boolean; isPlatformAdmin: boolean }):
  { allow: true; admin_override: boolean } | { allow: false; reason: string } {
  if (input.enabled) return { allow: true, admin_override: false };
  if (input.isPlatformAdmin) return { allow: true, admin_override: true };
  return {
    allow: false,
    reason: `Looking Glass 在本部署未启用（未设置 ${LOOKING_GLASS_ENABLED_ENV}=true）：功能默认关闭，请联系管理员开启`,
  };
}

/** 一次请求的总预算：每个地址一个超时 + ACK 余量，封顶 20s。 */
export function lookingGlassAckWaitMs(timeoutMs: number, addressCount: number): number {
  const budget = timeoutMs * Math.max(1, addressCount) + LOOKING_GLASS_ACK_SLACK_MS;
  return Math.min(budget, LOOKING_GLASS_MAX_ACK_WAIT_MS);
}

/**
 * 发起一次 Looking Glass 测试。
 *
 * 顺序 = 边界的实现顺序（每一步都必须在**任何发包之前**）：
 *   开关 → 节点归属 → 方法/超时 → 目标写法与公网判定（含面板侧解析）
 *   → 单飞占位 → 能力协商 → 审计 → 下发。
 */
export async function runLookingGlass(
  input: LookingGlassRequestInput,
  deps: LookingGlassDeps,
): Promise<LookingGlassOutcome> {
  const now = deps.now ?? (() => new Date());
  const locks = deps.locks ?? defaultLookingGlassLocks;
  const enabled = await deps.enabled();
  const entry = decideLookingGlassEntry({ enabled, isPlatformAdmin: input.isPlatformAdmin });

  const requestedForAudit = Array.isArray(input.targets)
    ? (input.targets as Array<Record<string, unknown>>)
        .map((row) => (row && typeof row === "object" ? `${String(row.host ?? "")}:${String(row.port ?? "")}` : "?"))
        .slice(0, LOOKING_GLASS_MAX_REQUESTED_TARGETS + 1)
    : [];

  const refuse = async (
    status: 400 | 403 | 404 | 409 | 502 | 503,
    code: string,
    message: string,
    error_layer: LookingGlassErrorLayer,
    nodeKey: string | null,
    targets: string[],
  ): Promise<LookingGlassOutcome> => {
    await deps
      .audit({
        action: "looking_glass.test_refused",
        workspace_id: input.workspaceId,
        actor_user_id: input.actorUserId,
        node_id: input.nodeId,
        node_key: nodeKey,
        ip: input.ip ?? null,
        code,
        method: null,
        targets,
        admin_override: entry.allow ? entry.admin_override : false,
        detail: { error_layer, status },
      })
      .catch(() => false);
    return { ok: false, status, code, message, error_layer };
  };

  if (!entry.allow) {
    // 关闭时的答复是**明确拒绝**（有 code / error_layer / 文案），不是空结果。
    return refuse(403, LOOKING_GLASS_CODES.disabled, entry.reason, "capability", null, requestedForAudit);
  }

  const node = await deps.loadNode(input.nodeId, input.workspaceId);
  if (!node) {
    return refuse(404, LOOKING_GLASS_CODES.notFound, "节点不存在", "resource_scope", null, requestedForAudit);
  }

  const method = (typeof input.method === "string" && input.method !== ""
    ? input.method
    : LOOKING_GLASS_DEFAULT_METHOD) as string;
  if (!(LOOKING_GLASS_METHODS as readonly string[]).includes(method)) {
    return refuse(
      400,
      LOOKING_GLASS_CODES.methodNotSupported,
      `本版本只支持方法 ${LOOKING_GLASS_METHODS.join("/")}（未知方法拒绝，不降级）`,
      "runtime_admission",
      node.node_key,
      requestedForAudit,
    );
  }

  const timeoutMs = input.timeoutMs === undefined || input.timeoutMs === null
    ? LOOKING_GLASS_DEFAULT_TIMEOUT_MS
    : Number(input.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > LOOKING_GLASS_MAX_TIMEOUT_MS) {
    return refuse(
      400,
      LOOKING_GLASS_CODES.timeoutOutOfRange,
      `timeout 必须是 1-${LOOKING_GLASS_MAX_TIMEOUT_MS} 的整数毫秒`,
      "runtime_admission",
      node.node_key,
      requestedForAudit,
    );
  }

  const plan = await planLookingGlassTargets(input.targets, { resolve: deps.resolve });
  if (!plan.ok) {
    return refuse(400, plan.code, plan.message, "runtime_admission", node.node_key, requestedForAudit);
  }
  const pinnedForAudit = plan.pinned.map((target) => `${target.address}:${target.port}`);

  const claim = locks.claim(node.id, now().getTime());
  if (!claim.ok) {
    return refuse(
      409,
      LOOKING_GLASS_CODES.busy,
      `该节点已有一个测试在途（${Math.trunc(claim.heldForMs / 1000)}s）：同一节点同一时刻至多一个测试`,
      "runtime_admission",
      node.node_key,
      pinnedForAudit,
    );
  }

  try {
    let facts: AgentV2CapabilityFacts | null = null;
    try {
      facts = await deps.capabilityFacts(node.id);
    } catch {
      facts = null;
    }
    // 能力协商：没广告就不下发。旧 Agent 会回 unsupported_action，而调用者会把它
    // 读成"网络故障"——那正是 WP11B 存在的理由。
    const decision = admitAction({ nodeId: node.id, role: "ingress", facts }, LOOKING_GLASS_ACTION);
    if (!decision.ok) {
      return refuse(409, decision.reason, decision.detail, "runtime_admission", node.node_key, pinnedForAudit);
    }

    const issuedAudit: LookingGlassAuditRow = {
      action: "looking_glass.test_issued",
      workspace_id: input.workspaceId,
      actor_user_id: input.actorUserId,
      node_id: node.id,
      node_key: node.node_key,
      ip: input.ip ?? null,
      code: "issued",
      method: method as LookingGlassMethod,
      targets: pinnedForAudit,
      admin_override: entry.admin_override,
      detail: { requested: plan.requested.map((t) => `${t.host}:${t.port}`) },
    };
    // D7⑤ 把审计当作动作的一部分：写不进去就不发起（"没有记录的主动探测"不成立）。
    const audited = await deps.audit(issuedAudit).catch(() => false);
    if (!audited) {
      return {
        ok: false,
        status: 503,
        code: LOOKING_GLASS_CODES.auditUnavailable,
        message: "审计写入失败：拒绝发起未留痕的主动测试",
        error_layer: "runtime_admission",
      };
    }

    const issued = await deps.issue({
      nodeId: node.id,
      nodeKey: node.node_key,
      method: method as LookingGlassMethod,
      targets: plan.pinned,
      timeoutMs,
    });

    const complete = async (code: string, detail: Record<string, unknown> | null): Promise<void> => {
      await deps
        .audit({
          action: "looking_glass.test_completed",
          workspace_id: input.workspaceId,
          actor_user_id: input.actorUserId,
          node_id: node.id,
          node_key: node.node_key,
          ip: input.ip ?? null,
          code,
          method: method as LookingGlassMethod,
          targets: pinnedForAudit,
          admin_override: entry.admin_override,
          detail,
        })
        .catch(() => false);
    };

    if (!issued.ok) {
      await complete(issued.error_code, { error: issued.error });
      return {
        ok: false,
        status: 502,
        code: issued.error_code || LOOKING_GLASS_CODES.agentFailed,
        message: issued.error,
        error_layer: "runtime_admission",
      };
    }

    const normalized = normalizeLookingGlassResults(issued.results, plan.pinned);
    if (!normalized.ok) {
      await complete(normalized.code, { error: normalized.message });
      return {
        ok: false,
        status: 502,
        code: normalized.code,
        message: normalized.message,
        error_layer: "runtime_admission",
      };
    }

    await complete("ok", {
      statuses: normalized.results.map((row) => row.status),
    });

    return {
      ok: true,
      report: {
        node: { id: node.id, node_key: node.node_key },
        generated_at: now().toISOString(),
        method: method as LookingGlassMethod,
        entry: { enabled, admin_override: entry.admin_override },
        requested: plan.requested,
        pinned: plan.pinned,
        pinned_by_host: plan.pinnedByHost,
        results: normalized.results,
        caveats: LOOKING_GLASS_CAVEATS,
      },
    };
  } finally {
    locks.release(node.id);
  }
}

/* ================================================================== */
/* 生产接线（懒加载：worker/测试 import 本模块时不连 DB / 不读 token）     */
/* ================================================================== */

export function defaultLookingGlassDeps(): LookingGlassDeps {
  return {
    async enabled() {
      const { env } = await import("../env.ts");
      return env.lookingGlassEnabled;
    },
    async resolve(host) {
      // 纯 DNS（resolve4/resolve6）：刻意不走 /etc/hosts / NSS。面板要做的是
      // "这个公网域名现在指向哪些公网地址"，而不是"本机的 hosts 文件写了什么"。
      const dns = await import("node:dns/promises");
      const [v4, v6] = await Promise.allSettled([dns.resolve4(host), dns.resolve6(host)]);
      const out: string[] = [];
      if (v4.status === "fulfilled") out.push(...v4.value);
      if (v6.status === "fulfilled") out.push(...v6.value);
      if (out.length === 0) {
        const first = v4.status === "rejected" ? v4.reason : (v6 as PromiseRejectedResult).reason;
        throw new Error(first instanceof Error ? first.message : String(first));
      }
      return out;
    },
    async loadNode(nodeId, workspaceId) {
      const { db } = await import("../db.ts");
      const row = await db.node.findFirst({
        where: { id: nodeId, node_group: { workspace_id: workspaceId } },
        select: { id: true, node_id: true },
      });
      return row ? { id: row.id, node_key: row.node_id } : null;
    },
    async capabilityFacts(nodeId) {
      const { db } = await import("../db.ts");
      const { capabilityFactsFromStoredV2 } = await import("./capability-manifest.ts");
      const row = await db.nodeStateReport.findUnique({
        where: { node_id: nodeId },
        select: {
          control_protocol_version: true,
          capabilities: true,
          capability_manifest: true,
          reported_at: true,
          node: { select: { credential_rotated_at: true } },
        },
      });
      return capabilityFactsFromStoredV2(
        row
          ? {
              control_protocol_version: row.control_protocol_version,
              capabilities: row.capabilities,
              capability_manifest: row.capability_manifest,
              reported_at: row.reported_at,
              credential_rotated_at: row.node?.credential_rotated_at ?? null,
            }
          : null,
      );
    },
    async issue(input) {
      const { issueAgentLookingGlass } = await import("./agent-command-bus.ts");
      return issueAgentLookingGlass({
        nodeId: input.nodeId,
        nodeKey: input.nodeKey,
        method: input.method,
        targets: input.targets,
        // 两个预算刻意分开传：per-attempt 超时进 payload，等 ACK 的总预算只影响
        // 面板等多久。混成一个会让"等 15 秒"被当成"每次尝试 15 秒"（还会被
        // validator 的线形上限拒掉整条命令）。
        perAttemptTimeoutMs: input.timeoutMs,
        ackWaitMs: lookingGlassAckWaitMs(input.timeoutMs, input.targets.length),
      });
    },
    async audit(row) {
      const { db } = await import("../db.ts");
      try {
        await db.auditEvent.create({
          data: {
            workspace_id: row.workspace_id,
            actor_user_id: row.actor_user_id,
            action: row.action,
            resource_type: "node",
            resource_id: row.node_id === null ? null : String(row.node_id),
            ip: row.ip,
            // 只记目标与方法/结果码。**不放**任何数据面载荷（D7⑤）。
            detail: {
              code: row.code,
              method: row.method,
              targets: row.targets,
              admin_override: row.admin_override,
              ...(row.detail ?? {}),
            },
          },
        });
        return true;
      } catch {
        return false;
      }
    },
  };
}
