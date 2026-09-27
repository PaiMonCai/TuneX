/**
 * V4-WP6 §13.4.4 —— 节点健康视图的**纯展示逻辑**（无 React / 无网络 / 无 IO）。
 *
 * ── 边界（这是本模块存在的唯一理由）──
 * 判定（healthy / warning / error / unknown、reasons、flags）**只由后端**给出
 * （`backend/src/services/node-health.ts`）。本模块绝不重新计算健康、也不重算
 * reasons 的严重度顺序——否则面板会给出与后端不一致的第二套结论，正是
 * DEVELOPMENT.md §13.4.4 禁止的「第二套 Node 监控真相」。
 *
 * 这里只做「事实 → 可读文本」的翻译：比例、时长、端口区间、计数条目。
 * 文本一律保持**语言中立**（数字与单位），中英差异交给
 * `node-health-i18n.ts` 的码表 —— 测试因此不需要 locale 就能断言。
 *
 * ── 「未知 ≠ 0」纪律 ──
 * 旧 Agent 不报内存时 `host.memory_total_bytes` 是缺失的键，不是 0。
 * 所有取值函数对缺失字段返回 null，由调用方渲染成「-」；把它算成 0
 * 会把「不知道」显示成「内存用光了」。
 */
import type {
  NodeHostMetrics,
  NodeHealthSummary,
  NodeHealthValue,
  NodeRuntimeCounts,
} from "./types";

/** 四态枚举（顺序 = 界面展示顺序：好 → 坏 → 未知）。 */
export const NODE_HEALTH_VALUES: NodeHealthValue[] = ["healthy", "warning", "error", "unknown"];

/** 四态计数的零值；后端 summary 缺字段时回落它（不把未知当 0 之外的编造）。 */
export const EMPTY_HEALTH_SUMMARY: NodeHealthSummary = { healthy: 0, warning: 0, error: 0, unknown: 0 };

/**
 * 把后端 `summary` 收窄成四态计数。
 *
 * 只接受真实存在的数字：缺字段 / 非数字 / 负数一律按 0 计（计数为 0 与
 * 「缺计数」在界面上没有区别，但负数或 NaN 会渲染成乱码）。
 */
export function normalizeHealthSummary(input: unknown): NodeHealthSummary {
  const src = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const pick = (key: NodeHealthValue): number => {
    const v = src[key];
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
  };
  return { healthy: pick("healthy"), warning: pick("warning"), error: pick("error"), unknown: pick("unknown") };
}

/** 徽章样式映射：healthy=success、warning=secondary（提醒但非故障）、error=destructive、unknown=muted。 */
export function healthBadgeVariant(health: NodeHealthValue): "success" | "secondary" | "destructive" | "muted" {
  if (health === "healthy") return "success";
  if (health === "warning") return "secondary";
  if (health === "error") return "destructive";
  return "muted";
}

/**
 * 连接态徽章：`offline` **不用** destructive。
 *
 * §13.4.4 末句明文「Offline 是 Connection 状态，不等价于 Health=error」——
 * 把掉线画成红色故障，会让「维护中正常关机」看起来像事故。
 */
export function connectionBadgeVariant(connection: string): "success" | "outline" | "muted" {
  if (connection === "online") return "success";
  if (connection === "offline") return "outline";
  return "muted";
}

/** 生命周期徽章：只有 disabled / retiring 用中性强调，maintenance 用 outline。 */
export function lifecycleBadgeVariant(lifecycle: string): "success" | "secondary" | "outline" | "muted" {
  if (lifecycle === "active") return "success";
  if (lifecycle === "maintenance") return "outline";
  if (lifecycle === "retiring") return "secondary";
  return "muted";
}

/** 理由严重度徽章：error=destructive、warning=secondary、info=outline。 */
export function severityBadgeVariant(severity: string): "destructive" | "secondary" | "outline" {
  if (severity === "error") return "destructive";
  if (severity === "warning") return "secondary";
  return "outline";
}

/** 有限数字，否则 null（0 是有效值）。 */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** used / total，非法输入返回 null（分母 0 = 无法判定，不是 0%）。 */
export function ratio(used: number | null | undefined, total: number | null | undefined): number | null {
  const u = num(used);
  const t = num(total);
  if (u === null || t === null || t <= 0) return null;
  return Math.min(1, Math.max(0, u / t));
}

/** 由「总量 + 可用量」算使用率（磁盘上报的是 free 而不是 used）。 */
export function usedRatioFromFree(total: number | null | undefined, free: number | null | undefined): number | null {
  const t = num(total);
  const f = num(free);
  if (t === null || f === null || t <= 0) return null;
  return ratio(Math.max(0, t - f), t);
}

/** 比例 → 百分比文本（1 位小数）；null → "-"。 */
export function formatPercent(r: number | null | undefined): string {
  if (r === null || r === undefined || !Number.isFinite(r)) return "-";
  return `${(r * 100).toFixed(1)}%`;
}

/**
 * 秒 → 紧凑时长（最多两段，语言中立）：`3d 4h` / `4h 12m` / `12m 5s` / `45s`。
 * 负数 / 非数字 → "-"（时间做减法时时钟回拨会给出负数，不能渲染成 `-5s`）。
 */
export function formatDuration(seconds: number | null | undefined): string {
  const s = num(seconds);
  if (s === null || s < 0) return "-";
  const total = Math.floor(s);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

/**
 * 端口列表 → 区间文本：`[20001,20002,20003,20010]` → `20001-20003, 20010`。
 *
 * 节点上报的 used_ports 在真实环境里动辄几十个连续端口，逐个列出会把这一行
 * 挤爆且看不出「占了一段」。去重 + 排序 + 合并连续段是这里唯一该做的加工。
 */
export function groupPorts(ports: number[] | null | undefined, maxGroups = 12): string {
  const list = (Array.isArray(ports) ? ports : [])
    .filter((p): p is number => typeof p === "number" && Number.isInteger(p) && p > 0)
    .sort((a, b) => a - b);
  if (list.length === 0) return "-";
  const groups: string[] = [];
  let start = list[0]!;
  let prev = list[0]!;
  for (let i = 1; i <= list.length; i++) {
    const cur = list[i];
    if (cur !== undefined && cur === prev + 1) {
      prev = cur;
      continue;
    }
    groups.push(start === prev ? String(start) : `${start}-${prev}`);
    if (cur !== undefined) {
      start = cur;
      prev = cur;
    }
  }
  if (groups.length <= maxGroups) return groups.join(", ");
  return `${groups.slice(0, maxGroups).join(", ")} … (+${groups.length - maxGroups})`;
}

/** runtime 分类计数的展示条目（只给真实存在的分类：未知分类 = 旧 Agent 没报）。 */
export interface RuntimeCountEntry {
  key: "direct" | "relay_ingress" | "relay_egress" | "total";
  value: number;
}

export function runtimeCountEntries(counts: NodeRuntimeCounts | null | undefined): RuntimeCountEntry[] {
  if (!counts || typeof counts !== "object") return [];
  const keys: RuntimeCountEntry["key"][] = ["direct", "relay_ingress", "relay_egress", "total"];
  const out: RuntimeCountEntry[] = [];
  for (const key of keys) {
    const v = num(counts[key]);
    if (v !== null) out.push({ key, value: v });
  }
  return out;
}

/** 资源区的一行（text 已格式化；ratio 只在有分母时给出，用于进度条）。 */
export interface ResourceRow {
  key: "cpu" | "load" | "memory" | "disk" | "rss" | "hostUptime";
  text: string;
  ratio: number | null;
  /** 附加信息（磁盘路径），没有则 null。 */
  note: string | null;
}

/** 人类可读字节（与 utils.formatBytes 同口径，此处自带一份以避免循环依赖）。 */
function bytes(v: number | null): string {
  if (v === null || v <= 0) return v === 0 ? "0 B" : "-";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(Math.floor(Math.log(v) / Math.log(1024)), units.length - 1);
  return `${(v / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * 资源采样 → 展示行。
 *
 * 缺失分组**直接不出行**（而不是出行写 0）：旧 Agent 不报磁盘时，界面不该
 * 出现一行「磁盘 0.0%」让人误以为刚清空过。
 */
export function resourceRows(host: NodeHostMetrics | null | undefined): ResourceRow[] {
  if (!host || typeof host !== "object") return [];
  const rows: ResourceRow[] = [];

  const cpus = num(host.cpu_count);
  if (cpus !== null) rows.push({ key: "cpu", text: String(cpus), ratio: null, note: null });

  const load1 = num(host.load1);
  const load5 = num(host.load5);
  const load15 = num(host.load15);
  if (load1 !== null || load5 !== null || load15 !== null) {
    const text = [load1, load5, load15].map((l) => (l === null ? "-" : l.toFixed(2))).join(" / ");
    // 每核负载才有可比性：核心数不明时不给比例（不给读者一个错误的满格）
    const per = cpus !== null && cpus > 0 && load1 !== null ? load1 / cpus : null;
    rows.push({ key: "load", text, ratio: per, note: per === null ? null : per.toFixed(2) });
  }

  const memUsed = num(host.memory_used_bytes);
  const memTotal = num(host.memory_total_bytes);
  if (memUsed !== null || memTotal !== null) {
    const r = ratio(memUsed, memTotal);
    rows.push({
      key: "memory",
      text: `${bytes(memUsed)} / ${bytes(memTotal)} (${formatPercent(r)})`,
      ratio: r,
      note: null,
    });
  }

  const diskTotal = num(host.disk_total_bytes);
  const diskFree = num(host.disk_free_bytes);
  if (diskTotal !== null || diskFree !== null) {
    const used = diskTotal !== null && diskFree !== null ? Math.max(0, diskTotal - diskFree) : null;
    const r = usedRatioFromFree(diskTotal, diskFree);
    rows.push({
      key: "disk",
      text: `${bytes(used)} / ${bytes(diskTotal)} (${formatPercent(r)})`,
      ratio: r,
      note: typeof host.disk_path === "string" && host.disk_path.length > 0 ? host.disk_path : null,
    });
  }

  const rss = num(host.process_rss_bytes);
  if (rss !== null) rows.push({ key: "rss", text: bytes(rss), ratio: null, note: null });

  const hostUptime = num(host.host_uptime_seconds);
  if (hostUptime !== null) rows.push({ key: "hostUptime", text: formatDuration(hostUptime), ratio: null, note: null });

  return rows;
}

/**
 * 「建议升级」只认后端给出的理由码。
 *
 * 前端**不得**自己比较 `telemetry.version` 与 `expected_version`：版本比较
 * 规则（预发布段、段数不同）在后端 `isVersionOlder` 里，前端再实现一遍就会
 * 与 `agent_version_behind` 的理由出现分叉。
 */
export function hasReasonCode(view: { reasons?: { code: string }[] } | null | undefined, code: string): boolean {
  return Boolean(view?.reasons?.some((r) => r.code === code));
}

/** 是否有任一 error 级理由（用于把「最需要处理的那条」前置到徽章旁）。 */
export function hasErrorSeverity(view: { reasons?: { severity: string }[] } | null | undefined): boolean {
  return Boolean(view?.reasons?.some((r) => r.severity === "error"));
}

/** 上报年龄（秒）→ 文本；null（从未上报）单独返回 null 让调用方走空态文案。 */
export function reportAgeText(ageSeconds: number | null | undefined): string | null {
  const s = num(ageSeconds);
  if (s === null) return null;
  return formatDuration(s);
}
