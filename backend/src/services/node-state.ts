/**
 * WP7 — Node state report（上报落库） + reconnect snapshot（重连恢复）
 *
 * 依据 `DEVELOPMENT.md` §7.10「WP7 — Node Credential / Session / State Report」。
 *
 * ── 上报的形状（Agent → 面板，Agent 主动出站 POST）──
 *   `POST /api/internal/node/state`  `Authorization: Bearer <node credential>`
 *   {
 *     "version": "0.13.22", "role": "BOTH",
 *     "tunnels":    [ { "id", "mode", "ingress_port", "egress_port", "revision", "targets"? } ],
 *     "used_ports": [ 8443, 30001 ],
 *     "egress_pools": { "<tunnelId>": { "strategy": "round", "targets": ["10.0.0.2:80"] } },
 *     "reported_revision": 17, "last_error": null
 *   }
 * 身份**不来自载荷**：node 由 Bearer 凭据解析（services/node-credential.ts），
 * 载荷里的 role 只作展示对齐，不一致以 `node.role` 为准（面板管理员显式设置的
 * 才是真相，§7.4「role 不回填、不猜」的延伸）。
 *
 * ── 为什么每节点一行（upsert）而不是追加时序 ──
 *   · reconnect snapshot 的语义是「这个节点当前是什么状态」，时序表要再查最近
 *     一条才能得到同一结论，且历史行会无限膨胀（节点每分钟心跳一次）；
 *   · WP9 reconciler 对比 desired / applied 需要 O(1) 取到「Agent 自述事实」；
 *   · 离线判定用 `reported_at` + Redis 心跳键（§7.10 的状态查询不替代
 *     offline-detector 的防抖），本表只回答「最近一次报的是什么」。
 *
 * ── 与 WP6 控制协议的关系 ──
 * 上报是**回报类**（非 mutating）：它不推进任何 revision，只更新事实快照。
 * `reported_revision` 是否落后于 `tunnel.config_revision` 由调用方判定
 * （WP9 reconciler：落后 = 该重发，不是该拒绝）。
 *
 * ── V4-WP6 遥测扩展（§13.4.4）──
 * `hostname/os/arch`、`known_revision`、`started_at`、`runtime_counts`、
 * `host`（轻量资源采样）与 `error_count/last_error_at` 都进**同一份**上报
 * （§13.4.4 明文禁止第二套 Node 监控真相），全部可选：旧 Agent 不报 →
 * 列保持 NULL → health synthesis 判 `unknown`（不是 0）。校验只拦「类型错」，
 * 不拦「缺失」，因此新旧 Agent 用的是同一个端点、同一份契约。
 *
 * ── 日志纪律 ──
 * 本模块不写 console。载荷里没有凭据，路由层也不得把 Authorization 头回显
 * 到任何日志/响应（见 routes/node-state.ts 的批注）。
 */
import { Prisma } from "@prisma/client";
import { db } from "../db.ts";
import { LEASE_TTL_SECONDS } from "./placement-lease.ts";
import { authenticateNode, hashNodeCredential } from "./node-credential.ts";
import { normalizeCapabilities } from "./agent-capability.ts";
import { normalizeCapabilityManifest, type CapabilityManifest } from "./capability-manifest.ts";
import { isPlainObject, type TunnelProtocolDiag } from "./tunnel-diag.ts";
import {
  appendLatencySamples,
  defaultLatencyHistoryDeps,
  type LatencySampleRow,
} from "./latency-history.ts";

/* ================================================================== */
/* 形状（与 agent/internal/api 的 NodeState 字段对齐）                  */
/* ================================================================== */

/** Agent 上报的单个出口目标（对齐 forwarder.Target 的 JSON 形态）。 */
export interface ReportedTarget {
  /** Agent 侧字段名是 `host`（forwarder.Target），面板侧别处用 `address`：
   *  上报载荷**以 Agent 为准**收 `host`，同时容忍 `address`（历史载荷）。 */
  host?: string;
  address?: string;
  port?: number;
  weight?: number;
  order?: number;
}

/** Agent 上报的单条隧道状态（对齐 forwarder.TunnelConfig 的 JSON 形态）。 */
export interface ReportedTunnel {
  id: string;
  mode?: string;
  ingress_port?: number;
  egress_port?: number;
  revision?: number;
  /** Agent 其余自报字段（remote_host/lb_strategy/…）原样透传。 */
  remote_host?: string;
  remote_port?: number;
  lb_strategy?: string;
  protocol?: string;
  speed_limit?: number;
  listen_host?: string;
  targets?: ReportedTarget[];
  /**
   * V5-WP19-F —— 该 runtime 的**协议专属事实**（`forwarder.ProtocolDiagnostics`）：
   * tls 的证书到期 / 握手失败、ws 的 upgrade 拒绝、udp 的 `mappings`/`packets_*`/
   * `bytes_*`/`drops`/`idle_timeout_seconds`，以及 RELAY 入口腿的 `hop_local_addr`。
   *
   * 落库时**原样透传**（这个块也是 `forward-contract.ts:datagramHopPeerFor` 读
   * `hop_local_addr` 的唯一来源，绝不能在这里重建成白名单字段）。面板侧的类型化读视图
   * 在 `services/tunnel-diag.ts`（键集开放、坏值不进视图、绝不回写）。
   *
   * **不在这里的字段一律视为「该协议没有这个事实」，不是 0**：Agent 侧零值 `omit`，
   * 所以 tcp 隧道 / 旧 Agent 干脆没有这个键（`undefined`），而不是一个空对象。
   */
  diag?: TunnelProtocolDiag;
}

/** Agent 上报的出口池快照（对齐 agent reporter.EgressPool）。 */
export interface ReportedEgressPool {
  strategy: string;
  targets: string[];
}

/** 上报载荷。未定义未知字段不做猜测式解析——原样存 JSON，坏形状由校验函数拦。 */
export interface StateReportInput {
  agent_id?: string;
  version?: string;
  role?: string;
  tunnels?: ReportedTunnel[];
  /**
   * V5.2 WP5 —— 该节点观测到的目标事实（DEVELOPMENT.md §7）。
   *
   * 每条是**这个观测视角**的事实，不是目标的"健康状态"：合成（WP6）是面板的事，
   * Agent 只报它测到的 8 个事实。`observation_age` 刻意不在线上——它是
   * `now - last_observed_at`，由读取方计算。
   */
  target_observations?: ReportedTargetObservation[];
  used_ports?: number[];
  egress_pools?: Record<string, ReportedEgressPool>;
  reported_revision?: number;
  last_error?: string | null;

  // ── V4-WP6（§13.4.4）──
  /** Agent 在信封里见过的最新 revision（与 reported_revision 比较 = 是否卡住）。 */
  known_revision?: number;
  /** Agent 进程启动时刻，unix 秒（面板据此算 uptime）。 */
  started_at?: number;
  hostname?: string;
  os?: string;
  arch?: string;
  /** `{ direct, relay_ingress, relay_egress, total }`。 */
  runtime_counts?: RuntimeCountsInput;
  /** 轻量资源采样；缺失分组没有键。 */
  host?: HostMetricsInput;
  /** 累计 apply/runtime 错误条数。 */
  error_count?: number;
  /** 最近一次错误时刻，unix 秒。 */
  last_error_at?: number;

  // ── V4-WP11B：控制协议能力协商 ──
  /** Agent 实现的控制协议版本（缺失 = 旧 Agent 未上报）。 */
  control_protocol_version?: number;
  /** Agent 实际实现的控制动作清单（缺失 = 未上报，与空数组语义不同）。 */
  capabilities?: string[];

  // ── V5-WP1：能力协商 v2 ──
  /** Agent 实际实现的协议 / 传输 / runtime 能力清单（缺失 = 旧 Agent 未上报）。 */
  capability_manifest?: CapabilityManifestInput;
}

/**
 * Agent 上报的 v2 能力清单（对齐 agent/internal/control.Manifest 的 JSON 形态）。
 *
 * 字段全部可选：Agent 侧尚未上报的维度会整键省略，面板按「这一维什么都没说」
 * 处理（空集 → fail-closed），而不是补一个默认值。**不要**在这里加默认协议，
 * 那会把「未上报」变成「上报了 tcp」，恰好抹掉协商的意义。
 */
export interface CapabilityManifestInput {
  schema_version?: number;
  protocols?: string[];
  transports?: string[];
  runtime?: string[];
  diagnostics?: string[];
}

/** Agent 自报的 runtime 计数（形状由 agent/internal/reporter 定义）。 */
export interface RuntimeCountsInput {
  direct?: number;
  relay_ingress?: number;
  relay_egress?: number;
  total?: number;
}

/**
 * Agent 自报的轻量资源采样。
 *
 * 面板侧**不做单位换算**：字节就是字节、秒就是秒，键名自带单位。未知分组
 * 没有键（而不是 0），parseHostMetrics 只在字段真实存在时参与阈值判定。
 */
export interface HostMetricsInput {
  cpu_count?: number;
  load1?: number;
  load5?: number;
  load15?: number;
  memory_total_bytes?: number;
  memory_used_bytes?: number;
  disk_path?: string;
  disk_total_bytes?: number;
  disk_free_bytes?: number;
  host_uptime_seconds?: number;
  process_rss_bytes?: number;
}

/** 落库后的快照（供 reconnect / 查询用）。 */
export interface StateSnapshot {
  node_id: number;
  version: string | null;
  role: string | null;
  reported_revision: number | null;
  tunnels: unknown;
  egress_pools: unknown;
  used_ports: unknown;
  last_error: string | null;
  reported_at: Date;

  // ── V4-WP6 遥测（全部可空：旧 Agent / 未上报 = NULL = 未知）──
  known_revision: number | null;
  agent_started_at: Date | null;
  hostname: string | null;
  os: string | null;
  arch: string | null;
  runtime_counts: unknown;
  host_metrics: unknown;
  error_count: number | null;
  last_error_at: Date | null;
}

/* ================================================================== */
/* 纯校验（无 IO，可离线单测）                                          */
/* ================================================================== */

export type StateReportRejection =
  | "missing_credential"
  | "invalid_json"
  | "bad_agent_id"
  | "bad_version"
  | "bad_role"
  | "bad_tunnels"
  | "bad_used_ports"
  | "bad_egress_pools"
  | "bad_revision"
  | "bad_last_error"
  /** V4-WP6：遥测字段形状坏（类型错 / 负计数 / 非法 unix 秒）。 */
  | "bad_telemetry"
  /** V5.2 WP5：观测载荷根本不是数组（逐条坏记录会被丢弃，不进这里）。 */
  | "bad_target_observations"
  /** V4-WP11B：能力协商字段形状坏（版本非非负整数 / 能力不是字符串数组）。 */
  | "bad_capabilities"
  /** V5-WP1：capability_manifest 形状坏（非对象 / schema_version 非整数 / 维度不是字符串数组）。 */
  | "bad_capability_manifest";

/**
 * 载荷校验（fail-closed）：任何坏形状返回原因码，调用方回 400。
 *
 * 刻意宽松的地方：`role` 接受任意非空字符串（Agent 自报，面板以 node.role 为准）；
 * `tunnels[i]` 只要求 `id` 非空字符串，其余字段缺失即视为「该隧道还没来得及
 * 报全」而不是整体拒绝——Agent 的部分状态比没有状态有用。
 */
/**
 * 遥测文本段长度上限。
 *
 * `hostname` 对应 schema 的 VarChar(255)。这里显式拦长串：Prisma 会把超长
 * 值交给 MySQL，MySQL 严格模式报错 → 整个上报 500，连带丢掉隧道与端口这些
 * 更有用的字段。上报层只做「能不能安全落库」的形状判断，不做语义判断。
 *
 * **按列宽逐字段给上限**（不是三列共用 255）：`os` / `arch` 是 VarChar(32)
 * （见迁移 20261010000000 与线上 `SHOW CREATE TABLE`）。共用 255 的话，一个
 * 40 字符的 `os` 会通过校验、再被 MySQL 严格模式（8.4 默认
 * `STRICT_TRANS_TABLES`）以 `ERROR 1406 (22001) Data too long for column 'os'`
 * 拒掉 → 整份上报 500，正好绕过本护栏。
 */
export const TELEMETRY_TEXT_MAX = 255;

/**
 * 逐字段上限表。**刻意不 export**：services 层不导出数据对象
 * （`node-credential.test.ts` 的「只 export 纯函数/服务函数」纪律）。
 */
const TELEMETRY_LEN_LIMITS: Record<"hostname" | "os" | "arch", number> = {
  hostname: TELEMETRY_TEXT_MAX,
  os: 32,
  arch: 32,
};

/** 非负整数（计数 / revision；0 合法，负数与小数与 NaN 都是坏形状）。 */
function isNonNegativeInt(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/** unix 秒：正有限整数。0 视为「未知/未报」，因此允许。 */
function isUnixSeconds(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/**
 * runtime_counts 形状：`{ direct?, relay_ingress?, relay_egress?, total? }`。
 *
 * 只要求「给了的键必须是非负整数」——空对象是合法的（Agent 刚启动、什么都
 * 没在跑，或旧版本只报了一部分）。
 *
 * 未知键**拒绝**（与 host 采样的宽容相反，这是刻意的）：这四个键是 §13.4.4
 * 枚举的 runtime 种类，集合本身有语义。若放行一种未知种类，面板的
 * runtime 普查就是**不完整**的，而 health 仍会据此说 `healthy`——把监控
 * 说成正常是这里最坏的失败模式。拒一份形状可疑的上报，Agent 会拿到 400 与
 * 原因，比面板长期少算一类 runtime 容易排查得多。
 */
function isRuntimeCounts(v: unknown): boolean {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!(RUNTIME_COUNT_KEYS as readonly string[]).includes(key)) return false;
    if (!isNonNegativeInt(o[key])) return false;
  }
  return true;
}

/** §13.4.4 枚举的 runtime 种类（与 agent/internal/reporter.RuntimeCounts 同名）。 */
const RUNTIME_COUNT_KEYS = ["direct", "relay_ingress", "relay_egress", "total"] as const;

/**
 * host 采样形状：每个已知键的类型必须对；缺失键合法；**未知键忽略**。
 *
 * 与 {@link isRuntimeCounts} 的严格相反，这里是宽容的：资源采样的键集合是
 * 开放集合（将来可能加 inode、网络字节、温度…），多一个键不会让健康结论
 * 变错方向——面板只读它认识的那几个。而 runtime 种类是枚举，少算一类会让
 * 「runtime 是否都在跑」这个核心结论失真，所以那边必须拒。
 *
 * 负数被拒（内存/磁盘/负载都不可能是负的，负值说明 Agent 侧算错了，落库
 * 会让阈值判定出怪结论）。`disk_path` 是路径字符串，允许任意非空内容。
 */
function isHostMetrics(v: unknown): boolean {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  for (const key of [
    "cpu_count",
    "memory_total_bytes",
    "memory_used_bytes",
    "disk_total_bytes",
    "disk_free_bytes",
    "host_uptime_seconds",
    "process_rss_bytes",
  ]) {
    if (o[key] !== undefined && !isNonNegativeInt(o[key])) return false;
  }
  for (const key of ["load1", "load5", "load15"]) {
    const value = o[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return false;
  }
  if (o.disk_path !== undefined && typeof o.disk_path !== "string") return false;
  return true;
}

/** V5.2 WP5：单个目标的观测事实（线上形状）。 */
export interface ReportedTargetObservation {
  host: string;
  port: number;
  reachable: boolean;
  /** 连接耗时；不可达为 null（不写 0：0 是"瞬间可达"）。 */
  latency_ms: number | null;
  consecutive_success: number;
  consecutive_failure: number;
  /** 最近 N 次探测的成功比例（观测方计算，面板不重算）。 */
  success_rate: number;
  /** 观测时刻（unix 秒）。 */
  last_observed_at: number;
  /** 谁说的：观测节点角色 + 探测种类。 */
  observation_source: string;
}

/**
 * 校验观测数组。
 *
 * 与 `tunnels` 的严格程度**刻意不同**：隧道列表是"这个节点现在跑着什么"，
 * 形状坏掉意味着面板会基于错的运行态做决策；观测是**附加证据**，一条坏记录
 * 只是那一条没用。所以这里逐条丢弃坏记录并返回丢弃数，而不是让整份上报 400 ——
 * 那会因为一个观测字段的类型错误，把节点的遥测、健康、隧道列表一起黑掉。
 * 丢弃不是静默的：调用方会把计数记进日志。
 */
export function validateTargetObservations(
  value: unknown,
): { ok: true; observations: ReportedTargetObservation[]; dropped: number } | { ok: false; reason: StateReportRejection } {
  if (value === undefined || value === null) return { ok: true, observations: [], dropped: 0 };
  if (!Array.isArray(value)) return { ok: false, reason: "bad_target_observations" };
  const out: ReportedTargetObservation[] = [];
  let dropped = 0;
  for (const raw of value) {
    const entry = normalizeTargetObservation(raw);
    if (entry === null) {
      dropped += 1;
      continue;
    }
    out.push(entry);
  }
  return { ok: true, observations: out, dropped };
}

/** 一条观测的归一化；null = 坏记录（丢弃，不中断整份上报）。 */
function normalizeTargetObservation(raw: unknown): ReportedTargetObservation | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const host = typeof o.host === "string" ? o.host.trim().toLowerCase().replace(/\.$/, "") : "";
  if (!host || host.length > 255) return null;
  const port = o.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (typeof o.reachable !== "boolean") return null;
  const latency = o.latency_ms;
  if (latency !== null && latency !== undefined && (typeof latency !== "number" || !Number.isFinite(latency) || latency < 0)) {
    return null;
  }
  // 不可达时 latency 必须是 null：写 0 会让"没测到"和"零延迟"变成同一个值。
  const latencyMs = o.reachable === false ? null : latency === undefined ? null : (latency as number | null);
  const counters = ["consecutive_success", "consecutive_failure"];
  for (const key of counters) {
    const v = (o as Record<string, unknown>)[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return null;
  }
  const rate = o.success_rate;
  if (rate !== undefined && (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || rate > 1)) return null;
  const observedAt = o.last_observed_at;
  if (typeof observedAt !== "number" || !Number.isInteger(observedAt) || observedAt <= 0) return null;
  const source = typeof o.observation_source === "string" ? o.observation_source.trim().slice(0, 64) : "";
  if (!source) return null;
  return {
    host,
    port,
    reachable: o.reachable,
    latency_ms: latencyMs,
    consecutive_success: typeof o.consecutive_success === "number" ? o.consecutive_success : 0,
    consecutive_failure: typeof o.consecutive_failure === "number" ? o.consecutive_failure : 0,
    success_rate: typeof rate === "number" ? rate : 0,
    last_observed_at: observedAt,
    observation_source: source,
  };
}

/**
 * V5-WP19-F —— 上报隧道列表的**显式投影**：`diag` 必须被带过去。
 *
 * 这是「凡重建上报形状处都必须带上 diag」这条纪律在**落库路径**上的那一个锚点
 * （同一条纪律的另一半在 `services/tunnel-diag.ts` 的读取侧，机械守卫见
 * `src/services/__tests__/v5-wp19/`）。它做的只有两件事：
 *
 *   · **未知字段原样保留**（`remote_host`/`protocol`/`targets`/将来新增的都在里面），
 *     面板不在上报层做语义判断（与顶层校验同一取向）；
 *   · `diag` **原样带走**（不是 `normalizeTunnelDiag` 的输出！）—— 那个块是
 *     `datagramHopPeerFor` 读 `hop_local_addr` 的唯一来源，也是 G1B.12 直接查的原始 JSON，
 *     重建成白名单字段就会把它废掉。这里唯一会动 `diag` 的情况是**它根本不是对象**
 *     （`"not-an-object"` / 数组 / `null`）：那不是事实，落库只会让读取方猜形状，
 *     所以整键丢弃 —— 丢掉的是**这一条信息**，不是整份上报（观测类坏形状逐条丢弃，
 *     绝不升级成整份 400，方向与 capability fail-closed 相反）。
 */
export function projectReportedTunnels(
  tunnels: ReportedTunnel[] | undefined,
): ReportedTunnel[] | undefined {
  if (tunnels === undefined) return undefined;
  return tunnels.map((tunnel) => {
    const record = tunnel as unknown as Record<string, unknown>;
    if (!Object.hasOwn(record, "diag") || isPlainObject(record.diag)) {
      return { ...record } as unknown as ReportedTunnel;
    }
    const { diag: _dropped, ...rest } = record;
    return { ...rest } as unknown as ReportedTunnel;
  });
}

export function validateStateReport(body: unknown): { ok: true; report: StateReportInput } | { ok: false; reason: StateReportRejection } {
  // 数组也是 object，但状态载荷必须是「带名字段的对象」——`[1,2]` / `[]`
  // 一律坏形状（Agent 不会把状态报成一个列表）。
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, reason: "invalid_json" };
  const b = body as Record<string, unknown>;

  if (b.agent_id !== undefined && (typeof b.agent_id !== "string" || b.agent_id.length === 0 || b.agent_id.length > 64)) {
    return { ok: false, reason: "bad_agent_id" };
  }
  if (b.version !== undefined && typeof b.version !== "string") return { ok: false, reason: "bad_version" };
  if (b.role !== undefined && typeof b.role !== "string") return { ok: false, reason: "bad_role" };
  if (b.reported_revision !== undefined && typeof b.reported_revision !== "number") {
    return { ok: false, reason: "bad_revision" };
  }
  if (b.last_error !== undefined && b.last_error !== null && typeof b.last_error !== "string") {
    return { ok: false, reason: "bad_last_error" };
  }

  if (b.tunnels !== undefined) {
    if (!Array.isArray(b.tunnels)) return { ok: false, reason: "bad_tunnels" };
    for (const t of b.tunnels) {
      if (!t || typeof t !== "object") return { ok: false, reason: "bad_tunnels" };
      const tt = t as Record<string, unknown>;
      if (typeof tt.id !== "string" || tt.id.length === 0) return { ok: false, reason: "bad_tunnels" };
      // 端口字段：缺失 = Agent 还没报全（容忍），类型错 = 坏形状（拒绝）。
      for (const key of ["ingress_port", "egress_port", "revision"]) {
        const v = tt[key];
        if (v !== undefined && typeof v !== "number") return { ok: false, reason: "bad_tunnels" };
      }
      // targets：Agent 报的可能是旧形状（address）或新形状（host）。只要求
      // 「数组里的每项是对象、port 是数字」，其余字段缺失不拦——面板侧
      // reconciler（WP9）自己决定能不能用这个 target，上报层不做语义判断。
      // `null` is what a Go nil slice marshals to, and every RELAY ingress
      // tunnel has no targets of its own — treating null as a type error made
      // those nodes' reports permanently 400 (no telemetry, no health), for a
      // field the contract itself calls optional. Absent and null are the same
      // fact here; only a *wrong non-null* shape is rejected.
      if (tt.targets !== undefined && tt.targets !== null) {
        if (!Array.isArray(tt.targets)) return { ok: false, reason: "bad_tunnels" };
        for (const tgt of tt.targets) {
          if (!tgt || typeof tgt !== "object") return { ok: false, reason: "bad_tunnels" };
          const t = tgt as Record<string, unknown>;
          if (t.port !== undefined && typeof t.port !== "number") {
            return { ok: false, reason: "bad_tunnels" };
          }
        }
      }
    }
  }

  const observations = validateTargetObservations(b.target_observations);
  if (!observations.ok) return { ok: false, reason: observations.reason };

  if (b.used_ports !== undefined) {
    if (!Array.isArray(b.used_ports)) return { ok: false, reason: "bad_used_ports" };
    if (!b.used_ports.every((p) => typeof p === "number")) return { ok: false, reason: "bad_used_ports" };
  }

  // ── V4-WP6 遥测（§13.4.4）──
  //
  // 校验纪律与上面一致：**类型错拒绝，缺失容忍**。新旧 Agent 共用这个端点，
  // 所以「没这个键」必须是合法形状；但「给了个字符串计数」必须拦——那会让
  // 面板把 NaN 当阈值输入，症状是健康判定随机漂移而不是报错。
  if (b.known_revision !== undefined && !isNonNegativeInt(b.known_revision)) {
    return { ok: false, reason: "bad_telemetry" };
  }
  if (b.error_count !== undefined && !isNonNegativeInt(b.error_count)) {
    return { ok: false, reason: "bad_telemetry" };
  }
  if (b.last_error_at !== undefined && !isUnixSeconds(b.last_error_at)) {
    return { ok: false, reason: "bad_telemetry" };
  }
  if (b.started_at !== undefined && !isUnixSeconds(b.started_at)) {
    return { ok: false, reason: "bad_telemetry" };
  }
  for (const key of ["hostname", "os", "arch"] as const) {
    const v = b[key];
    if (v !== undefined && (typeof v !== "string" || v.length > TELEMETRY_LEN_LIMITS[key])) {
      return { ok: false, reason: "bad_telemetry" };
    }
  }
  if (b.runtime_counts !== undefined && !isRuntimeCounts(b.runtime_counts)) {
    return { ok: false, reason: "bad_telemetry" };
  }
  if (b.host !== undefined && !isHostMetrics(b.host)) {
    return { ok: false, reason: "bad_telemetry" };
  }

  // ── V4-WP11B：能力协商 ──
  //
  // 与遥测同一纪律：**缺失容忍、类型错拒绝**。这里额外多一条要求：坏形状
  // 绝不能退化成"未上报"——那会把 fail-closed（Agent 报了坏清单）静默降级成
  // baseline 放行，方向恰好错反。所以先校验形状，再走 normalize。
  if (b.control_protocol_version !== undefined && !isNonNegativeInt(b.control_protocol_version)) {
    return { ok: false, reason: "bad_capabilities" };
  }
  if (b.capabilities !== undefined) {
    if (!Array.isArray(b.capabilities)) return { ok: false, reason: "bad_capabilities" };
    try {
      normalizeCapabilities(b.capabilities);
    } catch {
      return { ok: false, reason: "bad_capabilities" };
    }
  }

  // ── V5-WP1：能力协商 v2 ──
  //
  // 三条纪律，与上面完全一致：
  //   · 缺失容忍        —— 旧 Agent 不发这个字段，上报照收（面板按 baseline 判定）；
  //   · 坏形状拒绝       —— 回 400 并给出原因码，而不是落一个坏 JSON；
  //   · **不静默降级**   —— 坏形状绝不能被写成 NULL，那会把 fail-closed 变成
  //                        baseline 放行，方向恰好错反（capability-manifest.ts
  //                        的 normalize 抛错正是为了这一点）。
  //
  // 刻意**不**拒绝 schema_version ≠ 2：那是「本面板读不懂的更新版清单」，不是
  // 坏载荷。normalize 对它返回 null → 落库为 NULL → 判定按 baseline 处理，
  // 于是未来 Agent 灰度上线时 TCP 不会中断。若在这里回 400，新版 Agent 连状态
  // 都上报不了，一次灰度就变成整批节点失去可观测性。
  if (b.capability_manifest !== undefined) {
    if (!b.capability_manifest || typeof b.capability_manifest !== "object" || Array.isArray(b.capability_manifest)) {
      return { ok: false, reason: "bad_capability_manifest" };
    }
    try {
      normalizeCapabilityManifest(b.capability_manifest);
    } catch {
      return { ok: false, reason: "bad_capability_manifest" };
    }
  }

  if (b.egress_pools !== undefined) {
    if (!b.egress_pools || typeof b.egress_pools !== "object" || Array.isArray(b.egress_pools)) {
      return { ok: false, reason: "bad_egress_pools" };
    }
    for (const pool of Object.values(b.egress_pools as Record<string, unknown>)) {
      if (!pool || typeof pool !== "object") return { ok: false, reason: "bad_egress_pools" };
      const p = pool as Record<string, unknown>;
      if (typeof p.strategy !== "string") return { ok: false, reason: "bad_egress_pools" };
      if (!Array.isArray(p.targets)) return { ok: false, reason: "bad_egress_pools" };
    }
  }

  return {
    ok: true,
    report: {
      agent_id: b.agent_id as string | undefined,
      version: b.version as string | undefined,
      role: b.role as string | undefined,
      // V5-WP19-F：走**显式投影**而不是直接 `b.tunnels` —— 每隧道的 `diag`
      // （协议专属事实）必须落进 `node_state_report.tunnels` 原样带走，坏形状逐条丢弃。
      // 这里曾经是"看起来只是类型断言"的那种写法，而在这个仓库里，"看起来等价"
      // 的字段拷贝点正是事实静默消失的地方（WP5-B2 的六处边界）。
      tunnels: projectReportedTunnels(b.tunnels as ReportedTunnel[] | undefined),
      used_ports: b.used_ports as number[] | undefined,
      egress_pools: b.egress_pools as Record<string, ReportedEgressPool> | undefined,
      reported_revision: b.reported_revision as number | undefined,
      last_error: b.last_error as string | null | undefined,
      known_revision: b.known_revision as number | undefined,
      started_at: b.started_at as number | undefined,
      hostname: b.hostname as string | undefined,
      os: b.os as string | undefined,
      arch: b.arch as string | undefined,
      runtime_counts: b.runtime_counts as RuntimeCountsInput | undefined,
      host: b.host as HostMetricsInput | undefined,
      error_count: b.error_count as number | undefined,
      last_error_at: b.last_error_at as number | undefined,
      // V4-WP11B：这条投影是**白名单**——校验通过但没列在这里的字段会被静默
      // 丢掉。新增协商字段时必须同步这里，否则症状是"校验通过、库里永远是
      // NULL"，即面板一直以为该 Agent 未上报能力（fail-closed 但不报错）。
      control_protocol_version: b.control_protocol_version as number | undefined,
      capabilities: b.capabilities as string[] | undefined,
      // V5-WP1：同一个白名单陷阱——校验通过但没列在这里的字段会被静默丢掉，
      // 症状是"上报 200、库里永远 NULL"，即面板一直以为该 Agent 没有 v2 能力。
      capability_manifest: b.capability_manifest as CapabilityManifestInput | undefined,
      // V5.2 WP5：白名单陷阱同样适用。用**归一化后**的列表，坏记录已经在
      // validateTargetObservations 里被逐条丢弃。
      //
      // `undefined` 与 `[]` 必须保持区别：前者是"这个 Agent 没有观测能力"
      // （旧版本），后者是"我会观测，此刻没有观测"。写成 `observations.observations`
      // 会让前者退化成 `[]`，而落库那条路径据此清空整张投影 —— 于是一次旧版本
      // Agent 上报就把"没有证据"伪造成"刚刚观测过且什么都没有"。
      target_observations:
        b.target_observations === undefined || b.target_observations === null
          ? undefined
          : observations.observations,
    },
  };
}

/**
 * 上报载荷 → 遥测列对象（V4-WP6，纯函数：无 IO，可离线断言映射）。
 *
 * 与隧道段同一取舍：**键缺失 = 这个 Agent 不报该事实 = NULL**（health
 * synthesis 判 unknown），空对象/空数组 = 「现在是空的」= 有意义的事实。
 * 两类事实在 DB 里必须可区分，否则「旧 Agent 不报内存」会被面板显示成
 * 「内存使用 0%」——把未知说成健康是监控最坏的失败模式。
 *
 * 独立成函数而不是内联在 upsert 里：这样映射规则可以被离线测试逐字段钉住，
 * 而不必替身一次真实的 upsert。
 */
export function telemetryColumns(report: StateReportInput): {
  known_revision: number | null;
  agent_started_at: Date | null;
  hostname: string | null;
  os: string | null;
  arch: string | null;
  runtime_counts: Prisma.InputJsonValue | typeof Prisma.JsonNull;
  host_metrics: Prisma.InputJsonValue | typeof Prisma.JsonNull;
  error_count: number | null;
  last_error_at: Date | null;
  control_protocol_version: number | null;
  capabilities: Prisma.InputJsonValue | typeof Prisma.JsonNull;
  capability_manifest: Prisma.InputJsonValue | typeof Prisma.JsonNull;
} {
  return {
    known_revision: report.known_revision ?? null,
    agent_started_at: unixOrNull(report.started_at),
    hostname: report.hostname ?? null,
    os: report.os ?? null,
    arch: report.arch ?? null,
    // JSON 列不能用裸 `null`：Prisma 的输入类型里 `null` 不属于
    // `InputJsonValue`，必须显式 `Prisma.JsonNull`（与 forward-revision.ts
    // 同一处理）。语义上 JsonNull 与 SQL NULL 在本模型里统一按「未上报」读。
    runtime_counts: report.runtime_counts
      ? (report.runtime_counts as unknown as Prisma.InputJsonValue)
      : Prisma.JsonNull,
    host_metrics: report.host ? (report.host as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
    error_count: report.error_count ?? null,
    last_error_at: unixOrNull(report.last_error_at),
    // NULL 与"空数组"在这里必须保持不同：NULL = 该 Agent 未上报能力，
    // 空数组 = 明确上报了"什么都不支持"。两者对下发的含义完全不同
    // （见 services/agent-capability.ts 的 decideCapability）。
    control_protocol_version: report.control_protocol_version ?? null,
    capabilities: report.capabilities
      ? (normalizeCapabilities(report.capabilities) as unknown as Prisma.InputJsonValue)
      : Prisma.JsonNull,
    // V5-WP1：落库的是**规范化后**的清单（去重 + 排序 + 维度补齐为空数组），
    // 判定函数因此不必在每次下发时再规整一遍。读不懂的 schema 版本落 NULL，
    // 与「未上报」同义：baseline 放行、其余拒绝（见 capability-manifest.ts）。
    capability_manifest: normalizeManifestColumn(report.capability_manifest),
  };
}

/**
 * `capability_manifest` 上报值 → 可落库的 JSON 列值。
 *
 * 读不懂的 schema 版本归一到 `JsonNull`（= 未上报的语义），**不是**落一个空对象：
 * 空对象会被判定层读成「上报了，但四个维度都是空」→ fail-closed，那就把一次
 * 无害的版本超前变成了全网拒绝下发。
 */
function normalizeManifestColumn(
  value: CapabilityManifestInput | undefined,
): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (!value) return Prisma.JsonNull;
  let normalized: CapabilityManifest | null = null;
  try {
    normalized = normalizeCapabilityManifest(value);
  } catch {
    // 校验阶段已经拦过坏形状；这里再兜一次是为了让本函数**不会抛**——
    // 它在下发路径的 upsert 里被调用，抛出去会变成一次 500。
    return Prisma.JsonNull;
  }
  return normalized === null ? Prisma.JsonNull : (normalized as unknown as Prisma.InputJsonValue);
}

/**
/* ================================================================== */
/* V5.3 WP9 —— 上报即续约                                              */
/* ================================================================== */

/**
 * 续约 this node 持有的租约。只续自己的；不创建、不抢占。
 *
 * 为什么不在这里 claim：认领意味着"我打算承载它"，那是编排决策（rollout PREPARE），
 * 不是上报的副作用。上报只能说"我还在"，而"我还在"正是续约的语义。
 */
export async function renewOwnedLeases(nodeId: number, now: Date): Promise<LeaseFact[]> {
  // **续约失败绝不影响上报本身**：上报是节点的主要职责（遥测/健康/隧道列表全靠它），
  // 而续约是面板侧的记账。让一次租约存储抖动把上报打成 500，会用一个次要功能拖垮主要功能。
  // 失败时返回空数组 = "这次没有新的归属信息"，Agent 保持它已有的截止时刻。
  try {
    return await renewOwnedLeasesUnsafe(nodeId, now);
  } catch {
    return [];
  }
}

async function renewOwnedLeasesUnsafe(nodeId: number, now: Date): Promise<LeaseFact[]> {
  const extended = new Date(now.getTime() + LEASE_TTL_SECONDS * 1000);
  const result = await db.placementLease.updateMany({
    where: { owner_node_id: nodeId },
    data: { lease_expires_at: extended },
  });
  if (result.count === 0) return [];
  // The refreshed facts are RETURNED, not just written to the row.
  //
  // V5.3 的关键一环：Agent 侧按契约"到期即停"，而续约只发生在库里 —— 如果不把这些事实
  // 送回给 Agent，每个隧道都会在下发后一个 TTL（30s）到期时**自己把自己停掉**，在健康节点
  // 上制造一次全量中断。这是本阶段实现者发现并上报的真实集成缺口。
  return db.placementLease
    .findMany({
      where: { owner_node_id: nodeId },
      select: { tunnel_id: true, epoch: true, lease_expires_at: true, revision: true },
    })
    .then((rows) => rows.map((r) => ({
      tunnel_id: r.tunnel_id,
      epoch: r.epoch,
      lease_expires_at: r.lease_expires_at.toISOString(),
      revision: r.revision,
    })));
}

/** V5.3 WP9：一次续约后回给 Agent 的归属事实。 */
export interface LeaseFact {
  tunnel_id: number;
  epoch: number;
  lease_expires_at: string;
  revision: number;
}

/* ================================================================== */
/* V5.2 WP5 —— 目标观测投影的同步                                       */
/* ================================================================== */

/** 目标身份：归一化 host + 端口。空 host 或非法端口返回 null（调用方跳过）。 */
export function targetKeyOf(host: string, port: number): string | null {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^\[|\]$/g, "");
  if (!normalized || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return `${normalized}:${port}`;
}

/**
 * 把一次上报里的观测同步进 `target_observation` 投影（V5.2 WP5，DEVELOPMENT.md §7）。
 *
 * 唯一键 (node_id, target_key)：同一 host:port 被两个节点观测是**两条独立事实**
 * （观察视角不同），合并成一条会抹掉"一个节点通、另一个不通"这个信号。
 *
 * 与隧道列表不同，这里不"全删再插"：观测是周期性到达的，全删会在两次上报之间留下
 * 空窗，让面板读到"刚刚没有任何观测"。做法是写入本次上报的，再删掉本节点**不再
 * 观测**的行（目标已从 desired 移除，投影里不该留一个永远不会再更新的悬空行）。
 */
export async function syncTargetObservations(
  nodeId: number,
  observations: ReportedTargetObservation[],
  reportedAt: Date,
): Promise<void> {
  const seen: string[] = [];
  for (const o of observations) {
    const key = targetKeyOf(o.host, o.port);
    if (!key) continue;
    seen.push(key);
    const row = {
      host: o.host,
      port: o.port,
      reachable: o.reachable,
      latency_ms: o.latency_ms,
      consecutive_success: o.consecutive_success,
      consecutive_failure: o.consecutive_failure,
      success_rate: o.success_rate,
      observed_at: new Date(o.last_observed_at * 1000),
      reported_at: reportedAt,
      observation_source: o.observation_source,
    };
    await db.targetObservation.upsert({
      where: { node_id_target_key: { node_id: nodeId, target_key: key } },
      create: { node_id: nodeId, target_key: key, ...row },
      update: row,
    });
  }
  await db.targetObservation.deleteMany({ where: { node_id: nodeId, target_key: { notIn: seen } } });
}

/* ================================================================== */
/* V5-WP19-B —— 观测历史档案（只追加；与上面的投影并列，互不写入）        */
/* ================================================================== */

/**
 * 一次上报的观测 → 档案样本行（**纯函数**，不碰 DB）。
 *
 * 身份用同一个 {@link targetKeyOf}：档案与投影必须指向同一个目标 —— 在这里自己拼一份
 * `host:port` 就等于有了第二份归一化，两边一旦漂移，历史会挂到一个投影里不存在的目标上。
 *
 * `latency_ms` 再钉一次「不可达 = NULL」：投影层已经归一化过，但档案是**只追加**的，
 * 写错一行没有 upsert 可以修正 —— 宁可在两个入口各钉一次（同一件事不允许有两个答案）。
 */
export function latencySampleRows(observations: readonly ReportedTargetObservation[]): LatencySampleRow[] {
  const rows: LatencySampleRow[] = [];
  for (const o of observations) {
    const key = targetKeyOf(o.host, o.port);
    if (!key) continue;
    rows.push({
      target_key: key,
      host: o.host,
      port: o.port,
      reachable: o.reachable,
      latency_ms: o.reachable ? o.latency_ms : null,
      success_rate: o.success_rate,
      observed_at: new Date(o.last_observed_at * 1000),
      observation_source: o.observation_source,
    });
  }
  return rows;
}

/**
 * 把这次上报的观测追加进历史档案（V5-WP19-B，契约 §4.0 裁决 O1+O4）。
 *
 * **失败必须 fail-soft**：档案是**附加事实**（D4：永不作为判定输入），而这一拍上报还背着
 * 隧道/端口/健康/租约续期。让一次档案写失败把上报打成 500，等于节点因为一个"观众"掉线 ——
 * 与 `renewOwnedLeases` 同一取向（次要功能不得拖垮主要功能）。原始样本的 24h 窗口由
 * 后续节拍继续填，丢掉一拍不改变任何判定。
 */
export async function archiveObservationSamples(
  nodeId: number,
  observations: readonly ReportedTargetObservation[],
): Promise<void> {
  try {
    const rows = latencySampleRows(observations);
    if (rows.length === 0) return;
    await appendLatencySamples(defaultLatencyHistoryDeps(), nodeId, rows);
  } catch {
    /* 档案写不进去不影响上报结论（见函数头）。 */
  }
}

/**
 * unix 秒 → Date，`undefined`/`0` → null。
 *
 * 0 的语义是「Agent 没有这个事实」（旧 Agent 不报 started_at、从未出错所以
 * 没有 last_error_at），把它变成 1970-01-01 会让面板显示「错误发生在 56 年前」。
 */
function unixOrNull(seconds: number | undefined): Date | null {
  if (typeof seconds !== "number" || seconds <= 0) return null;
  return new Date(seconds * 1000);
}

/** 从 Authorization 头取 Bearer 明文（不解析合法性，只做形态抽取）。 */
export function extractBearerCredential(authorization: string | undefined | null): string | null {
  if (!authorization) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!m) return null;
  const token = m[1].trim();
  return token.length > 0 ? token : null;
}

/* ================================================================== */
/* 上报（身份由凭据定，不由载荷定）                                       */
/* ================================================================== */

export type SubmitResult =
  | {
      ok: true;
      node_id: number;
      scope: number;
      reported_at: Date;
      /**
       * V5.3 WP9：本次上报续约成功的归属事实。
       *
       * 为什么必须回传：Agent 按契约"租约到期即停"，而续约是面板侧写的。不回传的话，
       * 每个隧道在最后一次下发后一个 TTL 就会自停 —— 在健康节点上制造全量中断。
       * 挂在既有响应上，不新增心跳、不新增往返。
       */
      leases: LeaseFact[];
    }
  | { ok: false; status: 401 | 400 | 503; reason: string };

/**
 * 认证 + 落库一次上报。
 *
 * 顺序不可换：先 {@link authenticateNode}（凭据即身份），再校验载荷，最后 upsert。
 * 反过来会让未认证的载荷先过校验、把错误信息当探针。DB 不可用回 503 而不是
 * 回 400/200——Agent 需要区分「我形状错了」和「面板暂时坏了，待会儿重试」。
 */
export async function submitStateReport(
  authorization: string | undefined | null,
  body: unknown,
): Promise<SubmitResult> {
  const credential = extractBearerCredential(authorization);
  if (!credential) return { ok: false, status: 401, reason: "missing_credential" };

  const auth = await authenticateNode(credential);
  if (!auth.ok) {
    // blocked / invalid / revoked 都回 401（不区分，避免拿响应当重试信号）；
    // db_unavailable 回 503，Agent 该退避重试而不是换凭据。
    return { ok: false, status: auth.reason === "db_unavailable" ? 503 : 401, reason: auth.reason };
  }

  const validated = validateStateReport(body);
  if (!validated.ok) return { ok: false, status: 400, reason: validated.reason };

  const report = validated.report;
  // Credential remains the authentication truth. agent_id is an immutable
  // runtime-instance guard: new Agents report it and must match the Node row.
  // Older Agents that do not report agent_id remain temporarily compatible.
  if (report.agent_id !== undefined && report.agent_id !== auth.agent_id) {
    return { ok: false, status: 401, reason: "agent_id_mismatch" };
  }
  const reportedAt = new Date();
  const telemetry = telemetryColumns(report);
  const core = {
    version: report.version ?? null,
    role: report.role ?? null,
    reported_revision: report.reported_revision ?? null,
    // 空数组也照原样写：Agent 「现在一个隧道都没有」是有意义的事实，
    // 与「还没报过」不同（后者在 DB 里表现为没有这一行）。
    tunnels: (report.tunnels ?? []) as never,
    egress_pools: (report.egress_pools ?? {}) as never,
    used_ports: (report.used_ports ?? []) as never,
    last_error: report.last_error ?? null,
    reported_at: reportedAt,
  };
  await db.nodeStateReport.upsert({
    where: { node_id: auth.node_id },
    create: { node_id: auth.node_id, ...core, ...telemetry },
    update: { ...core, ...telemetry },
  });

  // ── V5.3 WP9：本人续约 ──
  //
  // 一个节点上报它正在服务的隧道，就是它仍在承载这些 Forward 的最好证据，所以续约挂在这条
  // 既有节拍上，而不是新开一个心跳通道（第二条时间真相）。续不上（或别人是 owner）时**什么
  // 都不做**：抢别人的归属必须走显式的两阶段交接，不能靠"报告里提到了它"。
  // V5.3 WP9（round 6 修正）：续约**不依赖"被服务方上报了它"**。
  //
  // 第一版按"上报的隧道"续约，于是出现一个自锁：栅栏停掉隧道 → agent 不再上报它 →
  // 续约永远续不到 → 租约一直过期 → 隧道一直停（实测落后 83s 且不恢复）。
  // 正确的语义是：**一次上报证明的是"这个节点"还活着**，而面板知道它**持有**哪些租约；
  // 只要它还活着，它手里的租约就该被续上（否则"租约到期即停"会退化成"一次抖动永久停服务"）。
  //
  // 注意这不会让"该停的隧道停不下来"：停一条隧道靠的是配置/remove 命令，不是靠让租约烂掉。
  const renewedLeases = await renewOwnedLeases(auth.node_id, reportedAt);

  // ── V5.2 WP5：目标观测投影 ──
  //
  // 两种"缺失"含义完全不同，必须分开：
  //   · 字段**存在**（哪怕是空数组）= 这个 Agent 会观测，且这就是它现在的全部
  //     观测 → 按上报同步：写进投影，并删掉它不再观测的目标（目标已从 desired
  //     移除，投影里不该留下一个永远不会再更新的悬空行）；
  //   · 字段**不存在** = 这是个还没有观测能力的旧 Agent → 保持投影不动。
  //     若按 `tunnels ?? []` 的写法把它当空集，一次旧版本 Agent 上报就会清空
  //     整张观测表，把"没有证据"伪造成"刚刚观测过且什么都没有"。
  if (report.target_observations !== undefined) {
    await syncTargetObservations(auth.node_id, report.target_observations, reportedAt);
    // V5-WP19-B：同一份观测再追加进**档案**（只 INSERT）。与投影并列、互不写入：
    // 投影回答"现在怎么样"（会被下面的 deleteMany 收窄），档案回答"过去怎么样"
    // （24h 原始样本 + 30d 小时桶，见 services/latency-history.ts）。fail-soft。
    await archiveObservationSamples(auth.node_id, report.target_observations);
  }

  // 顺带刷新 node.last_seen_at：面板展示与离线判定都读它（WP1 列，WP7 首次写入）。
  await db.node
    .updateMany({ where: { id: auth.node_id }, data: { last_seen_at: reportedAt } })
    .catch(() => {
      /* 心跳刷新失败不影响上报结论 */
    });

  // V5.3 WP9: the renewed ownership facts travel back in the report's own response —
  // zero extra round trips, zero new cadence, and the agent learns "you may keep serving
  // until T" from the very answer it is already waiting for.
  return {
    ok: true,
    node_id: auth.node_id,
    scope: auth.scope,
    reported_at: reportedAt,
    leases: renewedLeases,
  };
}

/* ================================================================== */
/* reconnect snapshot（断线重连后的状态恢复）                            */
/* ================================================================== */

/**
 * 取节点最近一次上报的快照。**null = 从未上报过**（新节点 / 刚签发凭据）。
 *
 * 这是 reconnect snapshot 的读取面：Agent 断开又连上时，面板用它回答
 * 「这个节点上次的状态是什么」，与 restore（Agent 侧拉 ACTIVE 隧道）互补：
 *   · restore 给 Agent **该运行的**（desired）；
 *   · 本函数给面板**它曾运行的**（reported）。
 * 两者的差就是 WP9 reconciler 的输入。
 */
export async function loadNodeSnapshot(nodeDbId: number): Promise<StateSnapshot | null> {
  const row = await db.nodeStateReport.findUnique({
    where: { node_id: nodeDbId },
    select: {
      node_id: true,
      version: true,
      role: true,
      reported_revision: true,
      // V5-WP19-F：`tunnels` 是**整块 JSON**，每隧道的 `diag`（协议专属事实）就在里面。
      // 不要把这里改成逐字段投影（那会把 diag 丢在一次"看起来等价"的重构里）；
      // 读取侧用 `services/tunnel-diag.ts` 的 `tunnelDiagsById(snapshot.tunnels)` 取类型化视图。
      tunnels: true,
      egress_pools: true,
      used_ports: true,
      last_error: true,
      reported_at: true,
      // V4-WP6：health synthesis 的事实来源（见 services/node-health.ts）。
      known_revision: true,
      agent_started_at: true,
      hostname: true,
      os: true,
      arch: true,
      runtime_counts: true,
      host_metrics: true,
      error_count: true,
      last_error_at: true,
    },
  });
  if (!row) return null;
  return row as StateSnapshot;
}

/**
 * 给 Agent 的重连快照（REST 形态，`GET /api/internal/node/snapshot`）。
 *
 * 只回**Agent 自己那一份**（nodeDbId 由凭据解析，不接受路径参数指定别的节点）——
 * 否则 A 的凭据就能读 B 的快照。字段保持在 Agent 侧可消费的最小集：
 * 版本、角色、revision、隧道、端口、池。不回 reported_at 之类面板内部字段。
 *
 * V5-WP19-F：`tunnels` **整块原样回给 Agent**（不逐字段重建）—— 每隧道的 `diag`
 * 就在里面。这条路径是"重放"面：Agent 重启后拿到的快照必须与它上次上报的一致，
 * 在这里做一次字段白名单重建，就等于把 Agent 自己刚发来的事实丢掉（G19.14 模型）。
 */
export async function buildReconnectSnapshot(nodeDbId: number): Promise<Record<string, unknown> | null> {
  const snap = await loadNodeSnapshot(nodeDbId);
  if (!snap) return null;
  return {
    version: snap.version,
    role: snap.role,
    reported_revision: snap.reported_revision,
    // 不要改成逐条 `{ id, mode, ingress_port, ... }`：per-tunnel `diag` 会整块消失。
    tunnels: snap.tunnels ?? [],
    used_ports: snap.used_ports ?? [],
    egress_pools: snap.egress_pools ?? {},
  };
}

/**
 * 指纹：上报内容的稳定摘要（用于「这次上报和上次有区别吗」的低成本比较）。
 * 不存明文凭据，也不存任何密钥——输入只有快照字段。
 *
 * V4-WP6 把遥测里**会变但对排障有意义**的字段纳入指纹：`error_count` 与
 * `last_error_at`（同一个错误反复出现时内容指纹不变，但计数会动，排障时
 * 「这次上报和上次一样吗」的答案应该是「不一样」）；`known_revision` 同理。
 * `host_metrics` 刻意**不**入指纹——内存/负载每 30s 必然变化，纳入就等于
 * 让指纹永远不同，从而失去「无变化」这个信号。
 */
export function snapshotFingerprint(snapshot: StateSnapshot | null): string {
  if (!snapshot) return "";
  return hashNodeCredential(
    JSON.stringify({
      v: snapshot.version,
      r: snapshot.role,
      rev: snapshot.reported_revision,
      t: snapshot.tunnels ?? null,
      p: snapshot.used_ports ?? null,
      e: snapshot.egress_pools ?? null,
      kr: snapshot.known_revision ?? null,
      ec: snapshot.error_count ?? null,
      le: snapshot.last_error_at ? new Date(snapshot.last_error_at).toISOString() : null,
      h: snapshot.hostname ?? null,
    }),
  );
}
