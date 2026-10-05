/**
 * V5-WP19-F —— 每隧道协议诊断（`tunnels[].diag`）的面板**一等读路径**。
 *
 * ── 这个文件存在的理由（既有缺陷，2026-10-05 核实）──
 * Agent 从 V5-WP5-A3 起就在状态上报的每条隧道上带 `diag`（udp/tls/ws 的协议专属事实：
 * 握手失败、证书到期、`mappings`、`packets_*`、`drops`、`idle_timeout_seconds`…），
 * `node_state_report.tunnels` 里也**一直有值**（`services/forward-contract.ts:datagramHopPeerFor`
 * 今天就靠它工作，① 的出口取证纠正依赖这个通路）。缺的不是数据，是**消费点**：
 * `ReportedTunnel`/`StateSnapshot` 没有 `diag` 字段，`node-health.ts:parseReportedRuntimes`
 * 重建 runtime 时把它丢掉，Web 类型里也没有。
 *
 * 后果不是「少一个字段」：**一个把每个报文都丢掉的出口，和一个空闲的出口在面板上长得
 * 一模一样**（`drops` 读不到）。而且 Agent 侧零值 `omit`，所以「这个协议没有 diag 块」
 * （tcp 隧道、或旧 Agent）与「diag 块存在但计数为 0」是**两个不同的事实**，读取方必须
 * 能分辨（`null` ≠ `{}`）。G1B.12 之所以能读到 diag，是 gate 直接
 * `SELECT tunnels FROM node_state_report` —— 绕过了面板接口，这正好是「面板零消费点」的证据。
 *
 * ── 三条纪律 ──
 *   1. **只读，不改写落库的原始块**。`tunnels[].diag` 必须保持 Agent 发来的样子：
 *      `hop_local_addr` 是出口取证纠正的**唯一**来源（`forward-contract.ts`），G1B.12 也直接
 *      读原始 JSON。本模块产出的是**读取视图**，不是第二份事实来源，也永不回写；
 *   2. **键集开放、坏值逐条不进视图**。协议事实的键集合由 Agent 拥有（将来会加键），
 *      面板不设白名单，未知键照样进视图（G19.2：未知 diag 键不毁上报）。反过来，
 *      非标量（嵌套对象/数组）与非法数字（NaN/Infinity）不进视图：它们不是标量事实，
 *      塞给 UI 只会让读取方猜。这与 `runtime_counts` 的**封闭键集**恰好相反 —— 而 `diag`
 *      之所以能长在 per-tunnel 对象上，正是因为它是原样透传的：往 `runtime_counts` 加一个
 *      未知键会让**整份上报**被 400 拒掉（隧道/端口/健康一起丢）；
 *   3. **有界，且超过上限时显式标注**。视图层对键数与字符串长度设硬上限，触顶时
 *      `truncated = true`，不静默变成一份「看起来完整」的视图（原始块仍在库里，可读）。
 */

/** 视图里保留的标量事实。 */
export type TunnelDiagScalar = number | string | boolean;

/**
 * 一条隧道的协议诊断读取视图。
 *
 * `null`（整个视图，见 {@link normalizeTunnelDiag}）= 这条隧道这次**没有**协议诊断块：
 * tcp 隧道本来就没有协议专属事实，旧 Agent 也不上报。它与 `facts: {}`（报了、但这次
 * 一个标量都没有）不同，与 `facts: { drops: 0 }` 更不同 —— 三种事实不能合并。
 */
export interface TunnelProtocolDiag {
  /**
   * 该诊断块属于哪种协议（`tcp`/`tls`/`ws`/`udp`，Agent 侧必给）。
   * `null` = 这一块没有身份（不猜成 tcp：猜错方向的协议标签比没有标签更坏）。
   */
  protocol: string | null;
  /** 标量事实，键集**开放**（Agent 拥有键），未知键原样保留。 */
  facts: Readonly<Record<string, TunnelDiagScalar>>;
  /** 视图层做过有界化（键数上限 / 长字符串截断）。true 时 `facts` 不是原始块的全量。 */
  truncated: boolean;
}

/** 视图层的键数上限（防御性：一块 diag 不该有几百个键）。 */
export const TUNNEL_DIAG_MAX_KEYS = 128;
/**
 * 视图层的字符串上限。Agent 侧自己已经把诊断文本 limit 在 200 字符（`diagErrMaxChars`），
 * 这里再兜一层：一个坏 Agent 不能把几 MB 的字符串灌进面板响应 / UI。
 */
export const TUNNEL_DIAG_MAX_STRING_CHARS = 400;

/** 纯对象（`{}`），排除 null / 数组 / 标量。 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 原始 `diag` 值 → 读取视图。**永不抛错**（读取路径不该因为一个坏字段 500）。
 *
 * 非对象（含 `undefined`）→ `null`，即「这条隧道没有协议诊断」。
 * 标量键原样保留；数字要求有限（NaN/Infinity 不是事实）；字符串超长截断并标
 * `truncated`；嵌套结构不进视图（不猜它的形状）。
 */
export function normalizeTunnelDiag(value: unknown): TunnelProtocolDiag | null {
  if (!isPlainObject(value)) return null;
  let truncated = false;
  const facts: Record<string, TunnelDiagScalar> = {};
  let accepted = 0;
  for (const [key, raw] of Object.entries(value)) {
    if (accepted >= TUNNEL_DIAG_MAX_KEYS) {
      truncated = true;
      break;
    }
    let scalar: TunnelDiagScalar | null = null;
    if (typeof raw === "string") {
      if (raw.length > TUNNEL_DIAG_MAX_STRING_CHARS) {
        truncated = true;
        scalar = raw.slice(0, TUNNEL_DIAG_MAX_STRING_CHARS);
      } else {
        scalar = raw;
      }
    } else if (typeof raw === "number") {
      // 非法数字不进视图（它会让阈值/图表给出随机结论，而不是报错）。**不 clamp**：
      // 负数照原样保留，面板显示负计数比把 -3 抹成 0 更容易被发现（D12）。
      if (Number.isFinite(raw)) scalar = raw;
    } else if (typeof raw === "boolean") {
      scalar = raw;
    }
    if (scalar === null) continue;
    facts[key] = scalar;
    accepted += 1;
  }
  const protocol = typeof value.protocol === "string" && value.protocol.trim() !== "" ? value.protocol : null;
  return { protocol, facts, truncated };
}

/**
 * `node_state_report.tunnels`（原样 JSON）→ `{ [runtimeId]: 诊断视图 }`。
 *
 * 只在隧道条目**真的带 diag**时才有键：一条 tcp 隧道不产生键，而不是产生一个空对象
 * ——读取方据此区分「这个协议没有事实」与「这个协议的事实全是空」。
 * 同 id 出现两次时**第一条为准**（与 ACK 账本 `SET NX` 同一取向：后来的不能改写已被读过的答案）。
 */
export function tunnelDiagsById(tunnels: unknown): Record<string, TunnelProtocolDiag> {
  const out: Record<string, TunnelProtocolDiag> = {};
  if (!Array.isArray(tunnels)) return out;
  for (const entry of tunnels) {
    if (!isPlainObject(entry)) continue;
    const id = typeof entry.id === "string" ? entry.id : "";
    if (id === "" || Object.hasOwn(out, id)) continue;
    const diag = normalizeTunnelDiag(entry.diag);
    if (diag) out[id] = diag;
  }
  return out;
}

/** 单条隧道的诊断视图；没有该隧道、或它没有 diag → null。 */
export function diagOfTunnel(tunnels: unknown, runtimeId: string): TunnelProtocolDiag | null {
  if (!Array.isArray(tunnels) || runtimeId === "") return null;
  for (const entry of tunnels) {
    if (!isPlainObject(entry)) continue;
    if (entry.id !== runtimeId) continue;
    return normalizeTunnelDiag(entry.diag);
  }
  return null;
}
