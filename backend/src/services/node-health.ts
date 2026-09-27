/**
 * V4-WP6 — Node health synthesis（`DEVELOPMENT.md` §13.4.4）
 *
 * ── 单一职责：把**事实**变成 `healthy | warning | error | unknown` ──
 *
 * 本模块不查询 DB、不发请求、不写日志：输入是已经读出来的事实（node 行、
 * state_report 快照、desired runtime 集合），输出是 Health 判定 + 理由清单。
 * 所有 IO 由调用方（node-admin 的读路径）完成，因此规则可离线穷举单测。
 *
 * ── 为什么必须由面板算（§13.4.1 明文）──
 *   「Health：Backend 根据事实计算；Agent 只上报原始状态，不允许一句
 *    `health=healthy` 成为最终真相。」
 * 所以 Agent 侧（reporter）只发数字，判定阈值与优先级全部在本文件。
 *
 * ── 四态语义（与 §13.4.4 一一对应）──
 *   healthy  ：Connection online，关键 runtime/revision 一致，无持续错误；
 *   warning  ：在线但 revision 落后、部分 Forward error、版本落后或资源接近阈值；
 *   error    ：Agent/runtime 初始化失败或关键 runtime 持续不可用；
 *   unknown  ：尚未安装 / 没有足够报告。
 *
 * ── 三条不允许走捷径的判定纪律 ──
 *   1. **Offline ≠ error**（§13.4.4 末句）。掉线是 Connection 状态，不是
 *      健康故障：一个正常关机维护的节点不该在健康列里显示成红色故障。掉线
 *      且无其它事实时返回 `unknown`（「没有足够报告」），而不是 `error`。
 *   2. **缺字段 = unknown，不是 0**。资源阈值只在对应的采样字段真实存在时
 *      参与判定；旧 Agent 不报内存，面板就不该判它内存超限。
 *   3. **只有「持续错误」才是 error**。单次历史错误（一个 `error_count > 0`
 *      但 `last_error_at` 早已过期，或所有 runtime 都已按最新 revision 起来）
 *      降级为 warning。持续 = 最近一个上报窗口内仍在出错，或关键 runtime
 *      完全缺失/落后，或 apply_status=error。
 */
import { deriveConnection, type NodeConnectionValue } from "./node-lifecycle.ts";

/* ================================================================== */
/* 常量                                                               */
/* ================================================================== */

/**
 * 判定阈值（部署方可覆盖）。
 *
 * 显式接口而不是从 `as const` 字面量推导：字面量推导会把每个字段收成
 * 具体数值类型（`memoryUsedRatio: 0.85`），调用方传 `{ memoryUsedRatio: 0.1 }`
 * 就变成类型错误——阈值本来就该是可调的。
 */
export interface HealthThresholds {
  memoryUsedRatio: number;
  diskUsedRatio: number;
  loadPerCpu: number;
  errorRecentMs: number;
}

/** 判定用的默认阈值（可由调用方覆盖，测试因此不必钉具体数值）。 */
export const HEALTH_THRESHOLDS: HealthThresholds = {
  /**
   * 资源「接近阈值」的告警线（§13.4.4 warning「资源接近阈值」）。
   *
   * 选 85% / load 每核 1.5 的理由：这是运维熟悉的经验线（磁盘 85% 通常还有
   * 一两次日志轮转的余量；load 1.5×核心数意味着队列已经开始积压）。它们
   * **只用于 warning**，绝不单独升级为 error——资源紧张不是节点故障，把
   * 快要满的磁盘报成 error 会让真正的 error（runtime 起不来）淹没在噪声里。
   */
  memoryUsedRatio: 0.85,
  diskUsedRatio: 0.85,
  /** load1 / cpu_count 的告警倍数。 */
  loadPerCpu: 1.5,
  /**
   * 「持续错误」窗口：最近错误发生在这个窗口内即视为仍在出错。
   *
   * 与心跳周期（30s）和 stale 窗口（90s）同源：如果节点按心跳节奏上报，
   * 窗口内出现过错误说明它**现在**还在失败；超出窗口说明失败已经过去至少
   * 几个上报周期，属于历史。
   */
  errorRecentMs: 90_000,
};

/** 版本判定：面板侧的「建议升级」目标版本（env 可注入）。 */
export const UNKNOWN_AGENT_VERSION = "unknown";

/** Health 四态（§13.4.1）。 */
export const NODE_HEALTHS = ["healthy", "warning", "error", "unknown"] as const;
export type NodeHealthValue = (typeof NODE_HEALTHS)[number];

/** 判定理由码：让 UI 能给出「下一步动作」而不是一句「不健康」。 */
export type HealthReasonCode =
  | "no_credential"
  | "never_reported"
  | "report_stale"
  | "connection_offline"
  | "agent_errors_ongoing"
  | "agent_errors_historical"
  | "runtime_missing"
  | "runtime_revision_behind"
  | "port_not_bound"
  | "forward_apply_error"
  | "agent_version_behind"
  | "agent_version_unknown"
  | "resource_memory_high"
  | "resource_disk_high"
  | "resource_load_high"
  | "role_mismatch";

export type HealthSeverity = "info" | "warning" | "error";

export interface HealthReason {
  code: HealthReasonCode;
  severity: HealthSeverity;
  /** 面向用户的一句话（UI 直接渲染；不给内部 revision 术语）。 */
  message: string;
  /** 该项涉及的具体对象（隧道 id / 端口），没有则为 null。 */
  detail?: string | null;
}

/* ================================================================== */
/* 输入（全部是已读出的纯事实）                                          */
/* ================================================================== */

/** Agent 上报的 runtime 计数（对齐 reporter.RuntimeCounts）。 */
export interface RuntimeCounts {
  direct?: number | null;
  relay_ingress?: number | null;
  relay_egress?: number | null;
  total?: number | null;
}

/** Agent 上报的轻量资源采样（对齐 reporter.HostSample）。 */
export interface HostMetrics {
  cpu_count?: number | null;
  load1?: number | null;
  load5?: number | null;
  load15?: number | null;
  memory_total_bytes?: number | null;
  memory_used_bytes?: number | null;
  disk_path?: string | null;
  disk_total_bytes?: number | null;
  disk_free_bytes?: number | null;
  host_uptime_seconds?: number | null;
  process_rss_bytes?: number | null;
}

/** 快照里的一条 runtime（对齐 agent-side TunnelConfig 的上报子集）。 */
export interface ReportedRuntime {
  id: string;
  mode?: string | null;
  ingress_port?: number | null;
  egress_port?: number | null;
  revision?: number | null;
}

/** 面板侧的 desired runtime（每条 Forward 在本节点上应有的运行态）。 */
export interface DesiredRuntime {
  /** 用户可见的 Forward 标识（用于理由文案，避免暴露内部 runtime id）。 */
  label: string;
  runtime_id: string;
  /** 期望 revision；null = 未进入 v3 期望模型，不参与落后判定。 */
  config_revision?: number | null;
  /** `tunnel.apply_status`；`error` 即该 Forward 上次应用失败。 */
  apply_status?: string | null;
  apply_error?: string | null;
  /** 期望它处于运行态（desired_status=active）。 */
  wants_active: boolean;
  /**
   * 该 runtime 应该占用的监听端口（DIRECT/RELAY 入口侧为 `tunnel.listen_port`；
   * EGRESS 侧为 null——出口 runtime 不监听面板分配的入口端口）。
   *
   * §13.4.4 的核心事实链里「端口是否真实占用」的最后一段：runtime 进程在跑
   * 不等于**面板给的那个端口**真的被监听（换端口失败、被别的进程抢占都会
   * 出现「runtime 在、端口不在」）。null = 不判（出口侧 / 未分配）。
   */
  listen_port?: number | null;
}

/** state_report 快照（面板侧读出来的那一行，字段可缺）。 */
export interface TelemetrySnapshot {
  version?: string | null;
  role?: string | null;
  reported_revision?: number | null;
  known_revision?: number | null;
  tunnels?: unknown;
  used_ports?: unknown;
  last_error?: string | null;
  error_count?: number | null;
  last_error_at?: Date | null;
  agent_started_at?: Date | null;
  hostname?: string | null;
  os?: string | null;
  arch?: string | null;
  runtime_counts?: unknown;
  host_metrics?: unknown;
  reported_at?: Date | null;
}

export interface HealthInput {
  /** `node.status`（连接态的既有口径，Redis 防抖翻转）。 */
  status?: string | null;
  /** `node.last_seen_at`（最近心跳）。 */
  last_seen_at?: Date | null;
  /** 是否已签发节点凭据。 */
  has_credential?: boolean;
  credential_revoked?: boolean;
  /** `node.role`：面板声明的角色（比对 Agent 自报 role）。 */
  node_role?: string | null;
  /** `node.version`：面板观察到的版本（回退口径）。 */
  node_version?: string | null;
  snapshot?: TelemetrySnapshot | null;
  /** 该节点上的 desired runtime（未传 = 本输入不做 runtime 判定）。 */
  desired?: DesiredRuntime[] | null;
  /** 面板期望的最新 agent 版本；null/缺省 = 不判版本落后。 */
  expected_agent_version?: string | null;
  /** 判定时刻（测试注入，避免读真实时钟）。 */
  now?: Date;
  thresholds?: Partial<HealthThresholds>;
}

export interface HealthResult {
  health: NodeHealthValue;
  connection: NodeConnectionValue;
  /** 判定理由，按严重度降序（error → warning → info）。 */
  reasons: HealthReason[];
  /** 便于 UI 的布尔投影，语义与 reasons 完全一致（不引入第二套判定）。 */
  flags: {
    reports_fresh: boolean;
    revision_in_sync: boolean;
    agent_errors_ongoing: boolean;
    resources_ok: boolean;
    /** §13.4.4「端口是否真实占用」：所有该占用的监听端口都在上报的清单里。 */
    ports_bound: boolean;
  };
}

/* ================================================================== */
/* 纯判定助手                                                          */
/* ================================================================== */

/** 元素是否是「真实存在的数字」（0 有效，null/undefined/NaN 无效）。 */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 把 unknown 收窄成协议里的 runtime 计数（未知字段一律忽略）。 */
export function parseRuntimeCounts(input: unknown): RuntimeCounts | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const o = input as Record<string, unknown>;
  const out: RuntimeCounts = {};
  let seen = false;
  for (const key of ["direct", "relay_ingress", "relay_egress", "total"] as const) {
    const v = num(o[key]);
    if (v !== null) {
      out[key] = v;
      seen = true;
    }
  }
  return seen ? out : null;
}

/** 把 unknown 收窄成资源采样（坏形状整体丢弃，不做部分猜测）。 */
export function parseHostMetrics(input: unknown): HostMetrics | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const o = input as Record<string, unknown>;
  const out: HostMetrics = {};
  let seen = false;
  for (const key of [
    "cpu_count",
    "load1",
    "load5",
    "load15",
    "memory_total_bytes",
    "memory_used_bytes",
    "disk_total_bytes",
    "disk_free_bytes",
    "host_uptime_seconds",
    "process_rss_bytes",
  ] as const) {
    const v = num(o[key]);
    if (v !== null) {
      out[key] = v;
      seen = true;
    }
  }
  if (typeof o.disk_path === "string" && o.disk_path.length > 0) {
    out.disk_path = o.disk_path;
    seen = true;
  }
  return seen ? out : null;
}

/** 快照里的 tunnels JSON → runtime 列表（坏形状按空列表，不抛错）。 */
export function parseReportedRuntimes(input: unknown): ReportedRuntime[] {
  if (!Array.isArray(input)) return [];
  const out: ReportedRuntime[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.id !== "string" || o.id.length === 0) continue;
    out.push({
      id: o.id,
      mode: typeof o.mode === "string" ? o.mode : null,
      ingress_port: num(o.ingress_port),
      egress_port: num(o.egress_port),
      revision: num(o.revision),
    });
  }
  return out;
}

/**
 * 取证：Agent 上报的「实际占用端口」集合。
 *
 * 只收正整数（端口 0 与负数在协议里没有意义）。NaN/字符串一律丢弃——
 * 端口判定必须基于确切数字，否则会把「类型错的 0」读成「端口没被占用」。
 */
export function parseUsedPorts(input: unknown): Set<number> {
  const out = new Set<number>();
  if (!Array.isArray(input)) return out;
  for (const p of input) {
    if (typeof p === "number" && Number.isInteger(p) && p > 0 && p <= 65535) out.add(p);
  }
  return out;
}

/**
 * 版本比较：`a` 是否严格旧于 `b`。
 *
 * 只做数字段比较（`0.13.22` = [0,13,22]），非数字段（`-rc1`、`dev`）在
 * 同长度下按字典序比较——足够回答「面板建议升级吗」，且不引入 semver 库
 * （Agent 的版本号格式由 build 时的 ldflags 决定，不受控件约束）。
 * 任一版本无法解析（空串 / `unknown` / 非数字起头）→ 返回 null =
 * 「无法判定」，调用方据此给 `agent_version_unknown` 而不是谎报落后。
 */
export function isVersionOlder(a: string | null | undefined, b: string | null | undefined): boolean | null {
  const pa = parseVersionParts(a);
  const pb = parseVersionParts(b);
  if (!pa || !pb) return null;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i];
    const y = pb[i];
    // 段数不同：`1.2` vs `1.2.0` 相等，`1.2` vs `1.2.1` 后者更新；但若剩下的是
    // **非数字段**（`1.4.0` vs `1.4.0-rc1`），那一段是预发布标记——释放版比
    // 同号预发布版新。
    if (x === undefined) return typeof y === "number" ? y !== 0 : false;
    if (y === undefined) return typeof x === "number" ? false : true;
    if (typeof x === "number" && typeof y === "number") {
      if (x !== y) return x < y;
      continue;
    }
    const sx = String(x);
    const sy = String(y);
    if (sx !== sy) return sx < sy;
  }
  return false;
}

function parseVersionParts(v: string | null | undefined): Array<number | string> | null {
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/^v/i, "");
  if (t === "" || t === UNKNOWN_AGENT_VERSION) return null;
  const parts = t.split(/[.\-+]/).filter((s) => s.length > 0);
  if (parts.length === 0) return null;
  // 首段必须是数字，否则这不是版本号（例如 "latest"）。
  if (!/^\d+$/.test(parts[0])) return null;
  return parts.map((p) => (/^\d+$/.test(p) ? Number(p) : p));
}

/** 资源采样的判定：只对**存在**的字段算比例。 */
export function resourceReasons(
  metrics: HostMetrics | null,
  thresholds: HealthThresholds,
): HealthReason[] {
  if (!metrics) return [];
  const out: HealthReason[] = [];

  const memTotal = num(metrics.memory_total_bytes);
  const memUsed = num(metrics.memory_used_bytes);
  if (memTotal !== null && memUsed !== null && memTotal > 0) {
    const ratio = memUsed / memTotal;
    if (ratio >= thresholds.memoryUsedRatio) {
      out.push({
        code: "resource_memory_high",
        severity: "warning",
        message: `内存使用率 ${(ratio * 100).toFixed(1)}%（阈值 ${pct(thresholds.memoryUsedRatio)}）`,
        detail: null,
      });
    }
  }

  const diskTotal = num(metrics.disk_total_bytes);
  const diskFree = num(metrics.disk_free_bytes);
  if (diskTotal !== null && diskFree !== null && diskTotal > 0) {
    const used = Math.max(0, diskTotal - diskFree);
    const ratio = used / diskTotal;
    if (ratio >= thresholds.diskUsedRatio) {
      out.push({
        code: "resource_disk_high",
        severity: "warning",
        message: `数据盘使用率 ${(ratio * 100).toFixed(1)}%（阈值 ${pct(thresholds.diskUsedRatio)}）`,
        detail: metrics.disk_path ?? null,
      });
    }
  }

  const cpus = num(metrics.cpu_count);
  const load1 = num(metrics.load1);
  if (cpus !== null && cpus > 0 && load1 !== null) {
    const per = load1 / cpus;
    if (per >= thresholds.loadPerCpu) {
      out.push({
        code: "resource_load_high",
        severity: "warning",
        message: `1 分钟负载 ${load1.toFixed(2)}（${cpus} 核，每核 ${per.toFixed(2)}）`,
        detail: null,
      });
    }
  }
  return out;
}

/**
 * 阈值文案。`85.0%` 的阈值若也渲染成 `85%`，理由字符串会变成
 * 「内存使用率 85.0%（85% 阈值）」——两个数字看起来是同一个，用户读不出
 * 「刚好越线」还是「远超阈值」。统一保留一位小数（与上面的实测值同精度）。
 */
function pct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

/* ================================================================== */
/* 主判定                                                              */
/* ================================================================== */

const SEVERITY_ORDER: Record<HealthSeverity, number> = { error: 0, warning: 1, info: 2 };

/**
 * 合成节点 Health。
 *
 * 判定顺序（先事实后期望，与 §13.4.4 的「核心监控事实」链条一致）：
 *
 *   1. **没有足够报告** → `unknown`。两个来源：从未签发凭据（waiting）与
 *      从未上报（没有快照）。这是「尚未安装」，不是故障。
 *   2. **持续错误 / 关键 runtime 不可用** → `error`。三类：Agent 账本报告
 *      最近仍在出错、desired active 的 runtime 在快照里根本不存在、有
 *      `apply_status=error` 的 Forward。
 *   3. 其余在线异常（revision 落后、单个历史错误、版本落后、资源接近阈值）
 *      → `warning`。
 *   4. 无任何理由且 connection 为 online → `healthy`。
 *   5. **掉线但仍有足够事实** → `unknown`（不是 error：§13.4.4 明文
 *      「Offline 是 Connection 状态，不等价于 Health=error」）。掉线也不会
 *      抹掉已有的 warning/error 理由：一个「维护中掉线、但上次上报磁盘
 *      95%」的节点仍应看到磁盘告警。
 */
export function synthesiseHealth(input: HealthInput): HealthResult {
  const now = input.now ?? new Date();
  const thresholds = { ...HEALTH_THRESHOLDS, ...(input.thresholds ?? {}) };

  const connection = deriveConnection({
    status: input.status,
    last_seen_at: input.last_seen_at,
    has_credential: input.has_credential,
    credential_revoked: input.credential_revoked,
    now,
  });

  const reasons: HealthReason[] = [];
  const snapshot = input.snapshot ?? null;

  // ── 1. 没有足够事实 → unknown ──
  if (connection === "waiting") {
    reasons.push({
      code: "no_credential",
      severity: "info",
      message: "尚未安装 Agent（未签发节点凭据）",
      detail: null,
    });
    return finish("unknown", connection, reasons);
  }
  if (!snapshot || !snapshot.reported_at) {
    reasons.push({
      code: "never_reported",
      severity: "info",
      message: "等待首次状态上报",
      detail: null,
    });
    return finish("unknown", connection, reasons);
  }

  // ── 2. 事实判定 ──
  const reportAgeMs = now.getTime() - new Date(snapshot.reported_at).getTime();
  const stale = reportAgeMs > thresholds.errorRecentMs;

  const errorCount = num(snapshot.error_count);
  const lastErrorAt = snapshot.last_error_at ? new Date(snapshot.last_error_at) : null;
  const errorRecent =
    lastErrorAt !== null && now.getTime() - lastErrorAt.getTime() <= thresholds.errorRecentMs;
  if (errorRecent) {
    reasons.push({
      code: "agent_errors_ongoing",
      severity: "error",
      message: `Agent 最近仍在报错${errorCount !== null && errorCount > 0 ? `（累计 ${errorCount} 次）` : ""}`,
      detail: snapshot.last_error ?? null,
    });
  } else if ((errorCount !== null && errorCount > 0) || (snapshot.last_error && snapshot.last_error.length > 0)) {
    // 「装完失败过一次、之后一直正常」必须可见，但它是历史而非故障。
    reasons.push({
      code: "agent_errors_historical",
      severity: "warning",
      message: "历史上出现过 apply / runtime 错误，最近一次已超出持续窗口",
      detail: snapshot.last_error ?? null,
    });
  }

  // runtime 判定（调用方给了 desired 才做）
  const reported = parseReportedRuntimes(snapshot.tunnels);
  const byId = new Map(reported.map((r) => [r.id, r]));
  // 「实际占用端口」这一事实：只在 Agent 报过 used_ports 时才有意义。
  // `tunnels` 里带 ports 但 used_ports 缺失的旧 Agent → 不判端口（unknown 不
  // 等于「没占用」），否则升级瞬间所有节点都会红一片。
  const usedPorts = parseUsedPorts(snapshot.used_ports);
  const hasPortFacts = Array.isArray(snapshot.used_ports);
  let revisionBehindCount = 0;
  if (Array.isArray(input.desired)) {
    for (const d of input.desired) {
      const got = byId.get(d.runtime_id) ?? null;
      // 顺序按「原因优先于症状」：一次失败的应用既会留下 apply_status=error
      // 又没有 runtime，此时告诉用户「上次应用失败（原因）」比「没有运行
      // （症状）」更有下一步价值。只有没有失败记录时，缺失 runtime 才作为
      // 独立故障上报（例如 Agent 重启后丢了配置）。
      if (d.apply_status === "error") {
        reasons.push({
          code: "forward_apply_error",
          severity: "error",
          message: `转发「${d.label}」上次应用失败`,
          detail: d.apply_error ?? null,
        });
        continue;
      }
      if (d.wants_active && !got) {
        reasons.push({
          code: "runtime_missing",
          severity: "error",
          message: `转发「${d.label}」在此节点上没有运行`,
          detail: d.runtime_id,
        });
        continue;
      }
      const want = num(d.config_revision);
      const have = got ? num(got.revision) : null;
      if (d.wants_active && want !== null && (have === null || have < want)) {
        revisionBehindCount++;
        reasons.push({
          code: "runtime_revision_behind",
          severity: "warning",
          message: `转发「${d.label}」的配置尚未在此节点生效`,
          detail: got ? `${have ?? "无"} < ${want}` : "无运行实例",
        });
      }
      // §13.4.4 事实链的最后一环：runtime 在运行 ≠ 面板给的那个端口真的被监听。
      // 只在该 runtime **确实在运行**（got 存在）且面板给了端口时才判——runtime
      // 根本没起来已经由 runtime_missing 表达，再报一次端口是重复噪声。
      const listenPort = num(d.listen_port);
      if (hasPortFacts && got && d.wants_active && listenPort !== null && !usedPorts.has(listenPort)) {
        reasons.push({
          code: "port_not_bound",
          severity: "error",
          message: `转发「${d.label}」的监听端口未被占用`,
          detail: String(listenPort),
        });
      }
    }
  }

  // 版本判定：优先用 Agent 自报（快照），回退面板观察列。
  const reportedVersion = snapshot.version ?? input.node_version ?? null;
  let versionBehind = false;
  if (input.expected_agent_version) {
    const older = isVersionOlder(reportedVersion, input.expected_agent_version);
    if (older === true) {
      versionBehind = true;
      reasons.push({
        code: "agent_version_behind",
        severity: "warning",
        message: `Agent 版本 ${reportedVersion} 落后于 ${input.expected_agent_version}`,
        detail: null,
      });
    } else if (older === null && reportedVersion !== input.expected_agent_version) {
      reasons.push({
        code: "agent_version_unknown",
        severity: "info",
        message: `无法判定 Agent 版本（上报 ${reportedVersion ?? "未知"}）`,
        detail: null,
      });
    }
  }

  // 自报角色与面板角色不一致：只提示（§7.4 role 不回填、不猜）。
  if (snapshot.role && input.node_role && !sameRole(snapshot.role, input.node_role)) {
    reasons.push({
      code: "role_mismatch",
      severity: "warning",
      message: `Agent 自报角色 ${snapshot.role} 与面板设置 ${input.node_role} 不一致`,
      detail: null,
    });
  }

  const metrics = parseHostMetrics(snapshot.host_metrics);
  const resource = resourceReasons(metrics, thresholds);
  reasons.push(...resource);

  if (stale) {
    reasons.push({
      code: "report_stale",
      severity: "warning",
      message: "状态上报已过期",
      detail: null,
    });
  }

  // ── 3/4/5. 定级 ──
  if (reasons.some((r) => r.severity === "error")) return finish("error", connection, reasons);
  if (connection !== "online") {
    // 掉线本身不是 error（§13.4.4）。保留已收集的 warning，但整体归 unknown：
    // 「没有足够**新鲜**报告」比「已知不健康」更准确。
    if (!reasons.some((r) => r.severity === "warning")) {
      reasons.push({
        code: "connection_offline",
        severity: "info",
        message: "节点当前离线（连接状态，不是健康故障）",
        detail: null,
      });
    }
    return finish("unknown", connection, reasons);
  }
  if (reasons.some((r) => r.severity === "warning")) return finish("warning", connection, reasons);
  return finish("healthy", connection, reasons);
}

function finish(health: NodeHealthValue, connection: NodeConnectionValue, reasons: HealthReason[]): HealthResult {
  const sorted = [...reasons].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return {
    health,
    connection,
    reasons: sorted,
    flags: {
      reports_fresh: !sorted.some((r) => r.code === "report_stale" || r.code === "never_reported"),
      revision_in_sync: !sorted.some((r) => r.code === "runtime_revision_behind" && r.severity === "warning"),
      agent_errors_ongoing: sorted.some((r) => r.code === "agent_errors_ongoing"),
      resources_ok: !sorted.some((r) => r.code.startsWith("resource_")),
      ports_bound: !sorted.some((r) => r.code === "port_not_bound"),
    },
  };
}

/** 角色比较：面板存小写、Agent 自报大写（`BOTH`），两边都要能对上。 */
function sameRole(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
