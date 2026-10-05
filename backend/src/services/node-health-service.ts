/**
 * V4-WP6 — Node health service（DB 读路径 + health synthesis 接线）
 *
 * 依据 `DEVELOPMENT.md` §13.4.4。分工：
 *   · `services/node-health.ts`  纯判定（无 IO，可离线穷举单测）；
 *   · 本文件                    读事实（node / node_state_report / tunnel）
 *                              然后调用纯判定，并把上报快照投影成给 UI 的
 *                              遥测视图（版本 / 资源 / runtime / 端口）。
 *
 * ── 为什么单独一个文件而不是改 node-admin.ts ──
 * WP6 只消费 node-admin 的既有读接口（`resolveNodeId`）而不修改它：WP9（列表
 * 分页/筛选）与 WP10（权限/NodeGroup）之后都要动 node-admin 的查询面，把
 * health 混进去会让三方在同一个函数里冲突。这里的查询面是**只读**的，且
 * 只依赖 schema 里已存在的列。
 *
 * ── desired runtime 的 id 约定 ──
 * 与 `services/reconciler.ts` 的 runtimeId 同源（`tunex-<id>-direct|relay|egress`），
 * 直接 import 复用而不是复制一份字符串拼接——两处各拼一次，Agent 侧改了
 * id 规则时就会出现「reconciler 说落后、health 说没运行」的分叉。
 *
 * ── 凭据纪律 ──
 * 本文件不 select `node_credential_hash`：health 只需要「有没有凭据」这一个
 * 布尔（`deriveConnection` 的 waiting 判定）。哈希绝不进入返回值。
 */
import {
  synthesiseHealth,
  parseHostMetrics,
  parseRuntimeCounts,
  parseReportedRuntimes,
  parseUsedPorts,
  type DesiredRuntime,
  type HealthInput,
  type HealthResult,
  type NodeHealthValue,
  type TelemetrySnapshot,
} from "./node-health.ts";
import { runtimeId } from "./reconciler.ts";
import type { TunnelProtocolDiag } from "./tunnel-diag.ts";
import { env } from "../env.ts";
import { NODE_LIFECYCLES } from "./node-lifecycle.ts";

/* ================================================================== */
/* DB 投影（可注入替身）                                                */
/* ================================================================== */

export interface NodeHealthDb {
  node: {
    findUnique(args: unknown): Promise<unknown>;
    findMany(args: unknown): Promise<unknown>;
  };
  nodeStateReport: {
    findUnique(args: unknown): Promise<unknown>;
    findMany(args: unknown): Promise<unknown>;
  };
  tunnel: {
    findMany(args: unknown): Promise<unknown>;
  };
}

export interface NodeHealthDeps {
  db?: NodeHealthDb;
  /** 判定时刻（测试注入，避免真实时钟）。 */
  now?: () => Date;
  /** 面板期望的 Agent 版本（建议升级的目标）；缺省 = 不判版本落后。 */
  expectedAgentVersion?: string | null;
}

/**
 * 惰性解析进程级 db。
 *
 * 与 node-lifecycle.ts 同一取向：顶层 import `db.ts` 会在模块加载期就
 * new PrismaClient()，让只用纯判定的调用方也把真实 db 拽进模块图，从而
 * 抢在测试替身之前注册 db.ts。首调用时才 import 即可完全避开。
 */
let defaultDbPromise: Promise<NodeHealthDb> | undefined;

function loadDefaultDb(): Promise<NodeHealthDb> {
  defaultDbPromise ??= import("../db.ts").then((m) => m.db as unknown as NodeHealthDb);
  return defaultDbPromise;
}

async function deps(over: NodeHealthDeps | undefined): Promise<{
  db: NodeHealthDb;
  now: () => Date;
  expectedAgentVersion: string | null;
}> {
  const now = over?.now ?? (() => new Date());
  // 显式传入优先（测试与调用方覆盖）；否则取部署配置的基线；未配置 = null =
  // 不判版本落后（`agent_version_behind` / `agent_version_unknown` 都不出现）。
  //
  // 读法必须容忍 `env` 里**没有**这个键：仓库里三个测试文件
  //（redis-scope / traffic-pipeline / policy-concurrency）为了绕开 env.ts 顶部的
  // fail-fast 而 `mock.module("env.ts", () => ({ env: {...} }))`，那些替身是**部分**
  // 拷贝；bun 的 mock.module 是进程级注册表，先加载者生效，于是同一个
  // `bun test src` 进程里后面加载的模块拿到的是缺键的 env。直接
  // `env.agentLatestVersion.length` 会在这种进程里抛
  // `TypeError: undefined is not an object`，把 health 路由测试全部打挂
  //（实测 18 失败）。缺键 = 部署方未配置 = 不判版本，与空串同义。
  const configuredVersion = typeof env.agentLatestVersion === "string" ? env.agentLatestVersion.trim() : "";
  const expectedAgentVersion =
    over?.expectedAgentVersion ?? (configuredVersion.length > 0 ? configuredVersion : null);
  if (over?.db) return { db: over.db, now, expectedAgentVersion };
  return loadDefaultDb().then((db) => ({ db, now, expectedAgentVersion }));
}

/* ================================================================== */
/* 行投影                                                              */
/* ================================================================== */

interface HealthNodeRow {
  id: number;
  node_id: string;
  role: string | null;
  status: string;
  lifecycle: string;
  version: string | null;
  last_seen_at: Date | null;
  port_range_min: number | null;
  port_range_max: number | null;
  node_credential_hash: string | null;
  credential_revoked: boolean;
}

interface HealthTunnelRow {
  id: number;
  name: string | null;
  tunnel_mode: string | null;
  desired_status: string | null;
  config_revision: number | null;
  apply_status: string | null;
  apply_error: string | null;
  ingress_node_id: number | null;
  egress_node_id: number | null;
  listen_port: number | null;
  egress_port: number | null;
}

/**
 * 节点行 + 快照的 select 投影。
 *
 * 点名字段而不是 `include`：本模块只需要 health 判定用得到的列，多拉的列
 * 会有被顺带写进响应的风险（`node_credential_hash` 就是典型）。
 */
const NODE_SELECT = {
  id: true,
  node_id: true,
  role: true,
  status: true,
  lifecycle: true,
  version: true,
  last_seen_at: true,
  port_range_min: true,
  port_range_max: true,
  node_credential_hash: true,
  credential_revoked: true,
} as const;

const TUNNEL_SELECT = {
  id: true,
  name: true,
  tunnel_mode: true,
  desired_status: true,
  config_revision: true,
  apply_status: true,
  apply_error: true,
  ingress_node_id: true,
  egress_node_id: true,
  listen_port: true,
  egress_port: true,
} as const;

/* ================================================================== */
/* desired runtime 推导                                                */
/* ================================================================== */

/**
 * 把该节点上的 Forward 投影成 desired runtime 列表。
 *
 * 一个 Forward 可能在**两个**节点上各有一个 runtime（RELAY 的 ingress 与
 * egress 各一个），本函数对给定节点只产出它自己那一份：
 *   · 作为 ingress 的 DIRECT  → `tunex-<id>-direct`
 *   · 作为 ingress 的 RELAY   → `tunex-<id>-relay`
 *   · 作为 egress 的 RELAY    → `tunex-<id>-egress`
 *
 * `label` 用 Forward 名：health 理由要面向用户（§13.4.4 的 warning/error
 * 文案），而 `tunex-12-relay` 这种内部 id 不该出现在 UI 上。
 */
export function desiredRuntimesForNode(nodeId: number, tunnels: HealthTunnelRow[]): DesiredRuntime[] {
  const out: DesiredRuntime[] = [];
  for (const t of tunnels) {
    const mode = (t.tunnel_mode ?? "").toLowerCase();
    const label = t.name && t.name.length > 0 ? t.name : `#${t.id}`;
    const wantsActive = t.desired_status === "active";
    const base = {
      label,
      config_revision: t.config_revision,
      apply_status: t.apply_status,
      apply_error: t.apply_error,
      wants_active: wantsActive,
    };
    if (t.ingress_node_id === nodeId) {
      // 入口侧 runtime 才监听面板分配的 `listen_port`（DIRECT 与 RELAY 的
      // 入口都一样）；出口侧不监听入口端口，所以传 null = 不判端口。
      out.push({
        ...base,
        runtime_id: runtimeId(t.id, mode === "relay" ? "ingress" : "direct"),
        listen_port: t.listen_port,
      });
    }
    if (t.egress_node_id === nodeId) {
      out.push({ ...base, runtime_id: runtimeId(t.id, "egress"), listen_port: null });
    }
  }
  return out;
}

/* ================================================================== */
/* 遥测视图（给 UI 的事实投影）                                          */
/* ================================================================== */

/** 上报快照的 UI 投影：版本 / 资源 / runtime / 端口。 */
export interface NodeTelemetryView {
  reported_at: string | null;
  /** 面板侧计算的上报年龄（秒）；null = 从未上报。 */
  age_seconds: number | null;
  version: string | null;
  /** Agent 自报角色（与 node.role 的差异由 health 的 role_mismatch 理由表达）。 */
  reported_role: string | null;
  /** Agent 已应用的最新 revision。 */
  applied_revision: number | null;
  /** Agent 见过的最新 revision（与 applied 比较 = 是否卡在应用环节）。 */
  known_revision: number | null;
  /** 见过但没应用上 = 面板在推、节点应用不了。 */
  revision_pending: boolean;
  hostname: string | null;
  os: string | null;
  arch: string | null;
  agent_started_at: string | null;
  /** Agent 进程 uptime（秒）；由面板用**面板时钟**算，不信 Agent 时钟。 */
  uptime_seconds: number | null;
  runtime: {
    /** Agent 自报的分类计数；旧 Agent 不报时为 null（未知 ≠ 0）。 */
    counts: ReturnType<typeof parseRuntimeCounts>;
    /** 正在运行的 runtime id 列表。 */
    running: string[];
    /**
     * V5-WP19-F：按 runtime id 索引的**协议专属事实**（udp/tls/ws 的
     * `drops`/`packets_*`/证书到期…）。**只有真的带 diag 的 runtime 才有键**：
     * 一条 tcp 隧道不产生键，而不是产生一个空对象 —— 「这个协议没有事实」与
     * 「这个协议的事实全是空」在 UI 上必须是两个答案（一个把每个报文都丢掉的出口
     * 与一个空闲的出口，区别就在这里）。
     */
    diags: Record<string, TunnelProtocolDiag>;
  };
  used_ports: number[];
  /** 轻量资源采样；旧 Agent 不报时为 null。 */
  host: ReturnType<typeof parseHostMetrics>;
  errors: {
    count: number | null;
    last_at: string | null;
    last_message: string | null;
  };
  /** 期望版本（面板建议升级的目标）。 */
  expected_version: string | null;
}

function telemetryView(
  snapshot: TelemetrySnapshot | null,
  now: Date,
  expectedVersion: string | null,
): NodeTelemetryView | null {
  if (!snapshot || !snapshot.reported_at) return null;
  const reportedAt = new Date(snapshot.reported_at);
  const ageSeconds = Math.max(0, Math.round((now.getTime() - reportedAt.getTime()) / 1000));
  const running = parseReportedRuntimes(snapshot.tunnels);
  const applied = snapshot.reported_revision ?? null;
  const known = snapshot.known_revision ?? null;
  const startedAt = snapshot.agent_started_at ? new Date(snapshot.agent_started_at) : null;
  return {
    reported_at: reportedAt.toISOString(),
    age_seconds: ageSeconds,
    version: snapshot.version ?? null,
    reported_role: snapshot.role ?? null,
    applied_revision: applied,
    known_revision: known,
    // 「见过但没应用上」：两边都有值才判，缺一边说明旧 Agent / 未上报。
    revision_pending: known !== null && applied !== null && known > applied,
    hostname: snapshot.hostname ?? null,
    os: snapshot.os ?? null,
    arch: snapshot.arch ?? null,
    agent_started_at: startedAt ? startedAt.toISOString() : null,
    uptime_seconds: startedAt ? Math.max(0, Math.round((now.getTime() - startedAt.getTime()) / 1000)) : null,
    // V5-WP19-F：与 `running` 同一次解析（parseReportedRuntimes 已带上 diag），
    // 所以视图里「哪些 runtime 在跑」和「它们各自的协议事实」永远来自同一份上报，
    // 不会出现「列表里有这个 runtime、diag 却来自另一次上报」的错位。
    runtime: {
      counts: parseRuntimeCounts(snapshot.runtime_counts),
      running: running.map((r) => r.id),
      diags: Object.fromEntries(
        running.filter((r) => r.diag !== undefined).map((r) => [r.id, r.diag as TunnelProtocolDiag]),
      ),
    },
    // 与判定同源（同一次解析）：视图里显示的端口清单和「是否真实占用」的
    // 结论必须来自同一份事实，否则会出现「列表里有 8443 但判端口未占用」。
    used_ports: [...parseUsedPorts(snapshot.used_ports)].sort((a, b) => a - b),
    host: parseHostMetrics(snapshot.host_metrics),
    errors: {
      count: snapshot.error_count ?? null,
      last_at: snapshot.last_error_at ? new Date(snapshot.last_error_at).toISOString() : null,
      last_message: snapshot.last_error ?? null,
    },
    expected_version: expectedVersion,
  };
}

/** 完整的节点健康视图。 */
export interface NodeHealthView {
  node_id: number;
  node_key: string;
  role: string | null;
  lifecycle: string;
  health: NodeHealthValue;
  connection: HealthResult["connection"];
  reasons: HealthResult["reasons"];
  flags: HealthResult["flags"];
  telemetry: NodeTelemetryView | null;
  desired_runtime_count: number | null;
  /** 该节点上的 Forward 数（含非 active 的），便于 UI 显示规模。 */
  forward_count: number;
}

export type NodeHealthError = { ok: false; code: "not_found"; message: string };

/* ================================================================== */
/* 读路径                                                              */
/* ================================================================== */

function asRow<T>(row: unknown): T | null {
  return row ? (row as T) : null;
}

function asRows<T>(rows: unknown): T[] {
  return Array.isArray(rows) ? (rows as T[]) : [];
}

/** 单节点 health：读 node + 快照 + 该节点的 Forward，然后合成。 */
export async function getNodeHealth(
  nodeId: number,
  inject?: NodeHealthDeps,
): Promise<{ ok: true; view: NodeHealthView } | NodeHealthError> {
  const { db: pd, now, expectedAgentVersion } = await deps(inject);

  const node = asRow<HealthNodeRow>(
    await pd.node.findUnique({ where: { id: nodeId }, select: NODE_SELECT }),
  );
  if (!node) return { ok: false, code: "not_found", message: "节点不存在" };

  const snapshot = asRow<TelemetrySnapshot>(
    await pd.nodeStateReport.findUnique({ where: { node_id: nodeId } }),
  );
  const tunnels = asRows<HealthTunnelRow>(
    await pd.tunnel.findMany({
      where: { OR: [{ ingress_node_id: nodeId }, { egress_node_id: nodeId }] },
      select: TUNNEL_SELECT,
    }),
  );
  const desired = desiredRuntimesForNode(nodeId, tunnels);

  return {
    ok: true,
    view: buildView(node, snapshot, desired, tunnels.length, now(), expectedAgentVersion),
  };
}

/**
 * Fleet health（巡检/异常入口）。
 *
 * `health` 过滤在**内存**里做而不是 SQL：判定依赖派生事实（revision 是否
 * 落后、错误是否仍在持续），SQL 里复刻一遍判定就等于把 §13.4.4 的规则写两
 * 份，两边迟早分叉。节点规模是百到千级，读全表后过滤的代价可接受（与
 * node-admin 的 `listNodeStates` 同一取向）。若将来规模上来了再考虑把
 * 「快照 → health」物化成列，那时也应是**同一份**判定的输出。
 */
export interface FleetHealthOptions {
  /** 只返回该 health 值的节点（缺省/空串 = 全部）。 */
  health?: string | null;
  /** `lifecycle` 过滤（§13.4.1，支持 disabled/retiring 巡检）。 */
  lifecycle?: string | null;
}

export async function listNodeHealth(
  options: FleetHealthOptions = {},
  inject?: NodeHealthDeps,
): Promise<
  | { ok: true; items: NodeHealthView[]; total: number; summary: Record<NodeHealthValue, number> }
  | { ok: false; code: "invalid_input"; message: string }
> {
  const { db: pd, now, expectedAgentVersion } = await deps(inject);
  const nowDate = now();

  const healthFilter = normalizeQueryToken(options.health);
  if (healthFilter !== null && !Object.hasOwn(EMPTY_SUMMARY, healthFilter)) {
    return { ok: false, code: "invalid_input", message: "health 只能是 healthy / warning / error / unknown" };
  }
  const lifecycleFilter = normalizeQueryToken(options.lifecycle);
  // lifecycle 是 Prisma **枚举**列，面板对它的唯一真相是 NODE_LIFECYCLES
  // （不在这里重抄一份字面量）。不校验就塞进 `where` 的话，`?lifecycle=banana`
  // 会把非法枚举值交给 Prisma，在查询期抛错 → 未捕获的 500；那不是「客户端
  // 输入错」，而是面板把一个探测请求变成了自己的故障。与上面的 health 同一
  // 口径：非法值显式 400，不静默返回空列表。
  if (lifecycleFilter !== null && !(NODE_LIFECYCLES as readonly string[]).includes(lifecycleFilter)) {
    return { ok: false, code: "invalid_input", message: "lifecycle 只能是 active / maintenance / disabled / retiring" };
  }

  const where: Record<string, unknown> = {};
  if (lifecycleFilter !== null) where.lifecycle = lifecycleFilter;

  const nodes = asRows<HealthNodeRow>(
    await pd.node.findMany({ where, orderBy: [{ order_by: "asc" }, { id: "asc" }], select: NODE_SELECT }),
  );
  // 一次拉全再分桶：逐节点 findUnique 是 N+1（与 node-admin 同一取舍）。
  const reports = asRows<TelemetrySnapshot & { node_id: number }>(
    await pd.nodeStateReport.findMany({}),
  );
  const reportByNode = new Map(reports.map((r) => [r.node_id, r]));
  const tunnels = asRows<HealthTunnelRow>(await pd.tunnel.findMany({ where: {}, select: TUNNEL_SELECT }));
  const tunnelsByNode = new Map<number, HealthTunnelRow[]>();
  for (const t of tunnels) {
    for (const id of [t.ingress_node_id, t.egress_node_id]) {
      if (id === null) continue;
      const list = tunnelsByNode.get(id) ?? [];
      list.push(t);
      tunnelsByNode.set(id, list);
    }
  }

  const items: NodeHealthView[] = [];
  const summary = { ...EMPTY_SUMMARY };
  for (const node of nodes) {
    const own = tunnelsByNode.get(node.id) ?? [];
    const view = buildView(
      node,
      reportByNode.get(node.id) ?? null,
      desiredRuntimesForNode(node.id, own),
      own.length,
      nowDate,
      expectedAgentVersion,
    );
    summary[view.health]++;
    if (healthFilter !== null && view.health !== healthFilter) continue;
    items.push(view);
  }
  return { ok: true, items, total: items.length, summary };
}

/** health 计数的零值（也是合法的过滤取值集合）。 */
const EMPTY_SUMMARY: Record<NodeHealthValue, number> = { healthy: 0, warning: 0, error: 0, unknown: 0 };

/** 下拉框口径：缺省/空串/`all` 都是「不过滤」，不是非法值。 */
function normalizeQueryToken(input: string | null | undefined): string | null {
  if (input === undefined || input === null) return null;
  const v = input.trim().toLowerCase();
  if (v === "" || v === "all") return null;
  return v;
}

/** 组装一个节点的完整视图（单节点与 fleet 共用，保证两者答案一致）。 */
function buildView(
  node: HealthNodeRow,
  snapshot: TelemetrySnapshot | null,
  desired: DesiredRuntime[],
  forwardCount: number,
  now: Date,
  expectedAgentVersion: string | null,
): NodeHealthView {
  const hasCredential = typeof node.node_credential_hash === "string" && node.node_credential_hash.length > 0;
  const input: HealthInput = {
    status: node.status,
    last_seen_at: node.last_seen_at,
    has_credential: hasCredential,
    credential_revoked: node.credential_revoked,
    node_role: node.role,
    node_version: node.version,
    snapshot,
    desired,
    expected_agent_version: expectedAgentVersion,
    now,
  };
  const health = synthesiseHealth(input);
  return {
    node_id: node.id,
    node_key: node.node_id,
    role: node.role,
    lifecycle: node.lifecycle,
    health: health.health,
    connection: health.connection,
    reasons: health.reasons,
    flags: health.flags,
    telemetry: telemetryView(snapshot, now, expectedAgentVersion),
    desired_runtime_count: desired.length,
    forward_count: forwardCount,
  };
}
