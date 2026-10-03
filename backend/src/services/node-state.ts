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
import { authenticateNode, hashNodeCredential } from "./node-credential.ts";
import { normalizeCapabilities } from "./agent-capability.ts";

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
  /** V4-WP11B：能力协商字段形状坏（版本非非负整数 / 能力不是字符串数组）。 */
  | "bad_capabilities";

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
      tunnels: b.tunnels as ReportedTunnel[] | undefined,
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
  };
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
  | { ok: true; node_id: number; scope: number; reported_at: Date }
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

  // 顺带刷新 node.last_seen_at：面板展示与离线判定都读它（WP1 列，WP7 首次写入）。
  await db.node
    .updateMany({ where: { id: auth.node_id }, data: { last_seen_at: reportedAt } })
    .catch(() => {
      /* 心跳刷新失败不影响上报结论 */
    });

  return { ok: true, node_id: auth.node_id, scope: auth.scope, reported_at: reportedAt };
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
 */
export async function buildReconnectSnapshot(nodeDbId: number): Promise<Record<string, unknown> | null> {
  const snap = await loadNodeSnapshot(nodeDbId);
  if (!snap) return null;
  return {
    version: snap.version,
    role: snap.role,
    reported_revision: snap.reported_revision,
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
