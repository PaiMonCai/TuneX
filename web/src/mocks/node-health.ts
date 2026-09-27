/**
 * V4-WP6 mock 侧的 **health 投影**（`GET /admin/node/:id/health` 与
 * `GET /admin/node/health` 的响应）。
 *
 * ── 为什么 mock 要重写一遍判定逻辑 ──
 * 真实判定只有一个真相：`backend/src/services/node-health.ts`（§13.4.1 明文
 * 「Agent 只上报原始状态，Backend 根据事实计算」）。mock 不可能 import 后端
 * Deno/Node 双栈的 `.ts` 模块，而 mock 模式（NEXT_PUBLIC_API_MOCK=1）是前端
 * 演示与契约测试唯一的运行环境，所以这里**只镜像形状与关键规则**，用于：
 *   1. 让前端在 mock 模式下能渲染真实的四态/理由/遥测（而不是假数据）；
 *   2. 让契约测试能断言 UI 依赖的字段一个都不少。
 * 镜像的口径与后端逐条对齐：connection 三态、四态判定优先级、reason code 集合、
 * 「未知 ≠ 0」。**任何判定改动都以后端为准**，这里只需保证形状与前端消费一致。
 */
import type {
  ID,
  Node,
  NodeHealthReason,
  NodeHealthSummary,
  NodeHealthValue,
  NodeHealthView,
  NodeHostMetrics,
  NodeRuntimeCounts,
  NodeStateReport,
  NodeTelemetry,
  HealthReasonCode,
  NodeLifecycleValue,
  Tunnel,
} from "@/lib/types";

/** 与后端 `HEALTH_THRESHOLDS` 同值（85% / 每核 1.5 / 90s 持续窗口）。 */
const MOCK_THRESHOLDS = { memoryUsedRatio: 0.85, diskUsedRatio: 0.85, loadPerCpu: 1.5, errorRecentMs: 90_000 };

/** 与后端 `CONNECTION_ONLINE_WINDOW_MS`（node-lifecycle.ts）同值。 */
const ONLINE_WINDOW_MS = 90_000;

/**
 * mock 的「面板建议版本」基线 —— 真实环境来自 `TUNEX_AGENT_LATEST_VERSION`
 * （`env.agentLatestVersion`，未配置 = null = 不判落后）。这里给一个具体值，
 * 否则 mock 模式永远看不到「建议升级」这条 UI 路径。
 */
export const MOCK_AGENT_LATEST_VERSION = "1.8.4";

/** 期望的 runtime（面板侧由 Forward 推导；mock 由 handler 用同一口径喂进来）。 */
export interface MockDesiredRuntime {
  label: string;
  runtime_id: string;
  config_revision?: number | null;
  apply_status?: string | null;
  apply_error?: string | null;
  wants_active: boolean;
  listen_port?: number | null;
}

/**
 * runtime id 口径：镜像 `backend/src/services/reconciler.ts` 的 `runtimeId`。
 * 后端那边是 import 复用而不是各拼一份；mock 无法跨仓库 import，只能镜像，
 * 因此**改后端 id 规则时必须同时改这里**（否则 mock 会显示 runtime_missing）。
 */
export function mockRuntimeId(tunnelId: number, direction: "direct" | "ingress" | "egress"): string {
  if (direction === "direct") return `tunex-${tunnelId}-direct`;
  if (direction === "ingress") return `tunex-${tunnelId}-relay`;
  return `tunex-${tunnelId}-egress`;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** mock 节点行的 lifecycle：schema 默认 active（WP5），允许 fixture 覆盖。 */
export function mockLifecycle(node: Node): NodeLifecycleValue {
  const raw = (node as Node & { lifecycle?: string | null }).lifecycle;
  if (raw === "maintenance" || raw === "disabled" || raw === "retiring") return raw;
  return "active";
}

export function mockConnection(node: Node, now: Date): "waiting" | "online" | "offline" {
  if (!node.has_credential) return "waiting";
  if (node.credential_revoked) return "offline";
  if (node.status !== "active") return "offline";
  if (!node.last_seen_at) return "offline";
  return now.getTime() - new Date(node.last_seen_at).getTime() <= ONLINE_WINDOW_MS ? "online" : "offline";
}

/** 上报端口清单（与后端 `parseUsedPorts` 同口径：只收合法端口号）。 */
function usedPortSet(snapshot: NodeStateReport | undefined): { ports: Set<number>; known: boolean } {
  const raw = snapshot?.used_ports;
  const known = Array.isArray(raw);
  const ports = new Set<number>();
  if (known) {
    for (const p of raw as unknown[]) {
      if (typeof p === "number" && Number.isInteger(p) && p > 0 && p <= 65535) ports.add(p);
    }
  }
  return { ports, known };
}

/** 上报的 runtime 列表（坏形状按空列表，与后端 `parseReportedRuntimes` 同口径）。 */
function reportedRuntimes(snapshot: NodeStateReport | undefined): { id: string; revision: number | null }[] {
  const raw = snapshot?.tunnels;
  if (!Array.isArray(raw)) return [];
  const out: { id: string; revision: number | null }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    // `tunnels` is typed as NodeRuntimeTunnel[], but external payloads still need runtime shape checks.
    const row = item as unknown as Record<string, unknown>;
    if (typeof row.id !== "string" || row.id.length === 0) continue;
    out.push({ id: row.id, revision: num(row.revision) });
  }
  return out;
}

/** 与后端 `isVersionOlder` 同口径的粗比较；任一端不可解析 → null（不判落后）。 */
function versionOlder(a: string | null | undefined, b: string | null | undefined): boolean | null {
  const parse = (v: string | null | undefined): Array<number | string> | null => {
    if (typeof v !== "string") return null;
    const t = v.trim().replace(/^v/i, "");
    if (t === "" || t === "unknown") return null;
    const parts = t.split(/[.\-+]/).filter((s) => s.length > 0);
    if (parts.length === 0 || !/^\d+$/.test(parts[0]!)) return null;
    return parts.map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return typeof y === "number" ? y !== 0 : false;
    if (y === undefined) return typeof x === "number" ? false : true;
    if (typeof x === "number" && typeof y === "number") {
      if (x !== y) return x < y;
      continue;
    }
    if (String(x) !== String(y)) return String(x) < String(y);
  }
  return false;
}

function resourceReasons(host: NodeHostMetrics | null): NodeHealthReason[] {
  if (!host) return [];
  const out: NodeHealthReason[] = [];
  const used = num(host.memory_used_bytes);
  const total = num(host.memory_total_bytes);
  if (used !== null && total !== null && total > 0 && used / total >= MOCK_THRESHOLDS.memoryUsedRatio) {
    out.push({
      code: "resource_memory_high",
      severity: "warning",
      message: `内存使用率 ${((used / total) * 100).toFixed(1)}%（85.0% 阈值）`,
      detail: null,
    });
  }
  const diskTotal = num(host.disk_total_bytes);
  const diskFree = num(host.disk_free_bytes);
  if (diskTotal !== null && diskFree !== null && diskTotal > 0) {
    const ratio = Math.max(0, diskTotal - diskFree) / diskTotal;
    if (ratio >= MOCK_THRESHOLDS.diskUsedRatio) {
      out.push({
        code: "resource_disk_high",
        severity: "warning",
        message: `数据盘使用率 ${(ratio * 100).toFixed(1)}%（85.0% 阈值）`,
        detail: host.disk_path ?? null,
      });
    }
  }
  const cpus = num(host.cpu_count);
  const load1 = num(host.load1);
  if (cpus !== null && cpus > 0 && load1 !== null && load1 / cpus >= MOCK_THRESHOLDS.loadPerCpu) {
    out.push({
      code: "resource_load_high",
      severity: "warning",
      message: `1 分钟负载 ${load1.toFixed(2)}（${cpus} 核，每核 ${(load1 / cpus).toFixed(2)}）`,
      detail: null,
    });
  }
  return out;
}

const SEVERITY_ORDER: Record<NodeHealthReason["severity"], number> = { error: 0, warning: 1, info: 2 };

export interface MockHealthInput {
  node: Node;
  snapshot: NodeStateReport | undefined;
  desired: MockDesiredRuntime[];
  forward_count: number;
  now: Date;
  expected_version?: string | null;
}

/** 合成一个节点的 health 视图（与后端 `buildView` 同形状）。 */
export function mockHealthView(input: MockHealthInput): NodeHealthView {
  const { node, snapshot, desired, forward_count } = input;
  const now = input.now;
  const expectedVersion = input.expected_version ?? MOCK_AGENT_LATEST_VERSION;
  const connection = mockConnection(node, now);
  const reasons: NodeHealthReason[] = [];
  const hasReport = Boolean(snapshot && snapshot.reported_at);
  const host = (snapshot?.host_metrics ?? null) as NodeHostMetrics | null;
  const { ports, known: portsKnown } = usedPortSet(snapshot);
  let revisionBehind = false;
  let portsMissing = false;

  let health: NodeHealthValue;
  if (connection === "waiting") {
    reasons.push({ code: "no_credential", severity: "info", message: "尚未安装 Agent（未签发节点凭据）", detail: null });
    health = "unknown";
  } else if (!hasReport) {
    reasons.push({ code: "never_reported", severity: "info", message: "等待首次状态上报", detail: null });
    health = "unknown";
  } else {
    const ages = now.getTime() - new Date(snapshot!.reported_at).getTime();
    const stale = ages > MOCK_THRESHOLDS.errorRecentMs;
    const lastErrorAt = snapshot!.last_error_at ? new Date(snapshot!.last_error_at) : null;
    const errorRecent = lastErrorAt !== null && now.getTime() - lastErrorAt.getTime() <= MOCK_THRESHOLDS.errorRecentMs;
    if (errorRecent) {
      reasons.push({
        code: "agent_errors_ongoing",
        severity: "error",
        message: `Agent 最近仍在报错${snapshot!.error_count && snapshot!.error_count > 0 ? `（累计 ${snapshot!.error_count} 次）` : ""}`,
        detail: snapshot!.last_error ?? null,
      });
    } else if ((snapshot!.error_count ?? 0) > 0 || (snapshot!.last_error ?? "").length > 0) {
      reasons.push({
        code: "agent_errors_historical",
        severity: "warning",
        message: "历史上出现过 apply / runtime 错误，最近一次已超出持续窗口",
        detail: snapshot!.last_error ?? null,
      });
    }

    const reported = reportedRuntimes(snapshot);
    const byId = new Map(reported.map((r) => [r.id, r]));
    for (const d of desired) {
      const got = byId.get(d.runtime_id) ?? null;
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
        revisionBehind = true;
        reasons.push({
          code: "runtime_revision_behind",
          severity: "warning",
          message: `转发「${d.label}」的配置尚未在此节点生效`,
          detail: got ? `${have ?? "无"} < ${want}` : "无运行实例",
        });
      }
      const listenPort = num(d.listen_port);
      if (portsKnown && got && d.wants_active && listenPort !== null && !ports.has(listenPort)) {
        portsMissing = true;
        reasons.push({
          code: "port_not_bound",
          severity: "error",
          message: `转发「${d.label}」的监听端口未被占用`,
          detail: String(listenPort),
        });
      }
    }

    const reportedVersion = snapshot!.version ?? node.version ?? null;
    const expected = expectedVersion;
    if (expected) {
      const older = versionOlder(reportedVersion, expected);
      if (older === true) {
        reasons.push({
          code: "agent_version_behind",
          severity: "warning",
          message: `Agent 版本 ${reportedVersion} 落后于 ${expected}`,
          detail: null,
        });
      } else if (older === null && reportedVersion !== expected) {
        // 与后端同口径：格式无法比较时给 info 级提示，**不**判落后（否则
        // 老 Agent 报 `unknown` 会被渲染成「必须升级」）。
        reasons.push({
          code: "agent_version_unknown",
          severity: "info",
          message: `无法判定 Agent 版本（上报 ${reportedVersion ?? "未知"}）`,
          detail: null,
        });
      }
    }

    if (snapshot!.role && node.role && snapshot!.role.trim().toLowerCase() !== node.role.trim().toLowerCase()) {
      reasons.push({
        code: "role_mismatch",
        severity: "warning",
        message: `Agent 自报角色 ${snapshot!.role} 与面板设置 ${node.role} 不一致`,
        detail: null,
      });
    }

    reasons.push(...resourceReasons(host));
    if (stale) reasons.push({ code: "report_stale", severity: "warning", message: "状态上报已过期", detail: null });

    if (reasons.some((r) => r.severity === "error")) {
      health = "error";
    } else if (connection !== "online") {
      if (!reasons.some((r) => r.severity === "warning")) {
        reasons.push({
          code: "connection_offline",
          severity: "info",
          message: "节点当前离线（连接状态，不是健康故障）",
          detail: null,
        });
      }
      health = "unknown";
    } else if (reasons.some((r) => r.severity === "warning")) {
      health = "warning";
    } else {
      health = "healthy";
    }
  }

  const sorted = [...reasons].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return {
    node_id: node.id,
    node_key: node.node_id,
    role: node.role ?? null,
    lifecycle: mockLifecycle(node),
    health,
    connection,
    reasons: sorted,
    flags: {
      reports_fresh: !sorted.some((r) => r.code === "report_stale" || r.code === "never_reported"),
      revision_in_sync: !revisionBehind,
      agent_errors_ongoing: sorted.some((r) => r.code === "agent_errors_ongoing"),
      resources_ok: !sorted.some((r) => r.code.startsWith("resource_")),
      ports_bound: !portsMissing,
    },
    telemetry: presenceTelemetry(snapshot, now, expectedVersion),
    desired_runtime_count: desired.length,
    forward_count,
  };
}

/** 上报快照的 UI 投影（与后端 `telemetryView` 同字段）。 */
function presenceTelemetry(snapshot: NodeStateReport | undefined, now: Date, expected: string): NodeTelemetry | null {
  if (!snapshot || !snapshot.reported_at) return null;
  const reportedAt = new Date(snapshot.reported_at);
  const startedAt = snapshot.agent_started_at ? new Date(snapshot.agent_started_at) : null;
  const running = reportedRuntimes(snapshot).map((r) => r.id);
  const applied = snapshot.reported_revision ?? null;
  const known = snapshot.known_revision ?? null;
  const { ports } = usedPortSet(snapshot);
  return {
    reported_at: reportedAt.toISOString(),
    age_seconds: Math.max(0, Math.round((now.getTime() - reportedAt.getTime()) / 1000)),
    version: snapshot.version ?? null,
    reported_role: snapshot.role ?? null,
    applied_revision: applied,
    known_revision: known,
    revision_pending: known !== null && applied !== null && known > applied,
    hostname: snapshot.hostname ?? null,
    os: snapshot.os ?? null,
    arch: snapshot.arch ?? null,
    agent_started_at: startedAt ? startedAt.toISOString() : null,
    uptime_seconds: startedAt ? Math.max(0, Math.round((now.getTime() - startedAt.getTime()) / 1000)) : null,
    runtime: { counts: (snapshot.runtime_counts ?? null) as NodeRuntimeCounts | null, running },
    used_ports: [...ports].sort((a, b) => a - b),
    host: (snapshot.host_metrics ?? null) as NodeHostMetrics | null,
    errors: {
      count: snapshot.error_count ?? null,
      last_at: snapshot.last_error_at ? new Date(snapshot.last_error_at).toISOString() : null,
      last_message: snapshot.last_error ?? null,
    },
    expected_version: expected,
  };
}

/** 四态计数（过滤前全量，与后端 summary 口径一致）。 */
export function mockHealthSummary(items: NodeHealthView[]): NodeHealthSummary {
  const summary: NodeHealthSummary = { healthy: 0, warning: 0, error: 0, unknown: 0 };
  for (const item of items) summary[item.health] += 1;
  return summary;
}

export const MOCK_HEALTH_VALUES: NodeHealthValue[] = ["healthy", "warning", "error", "unknown"];

/** 供 handler 判定合法过滤值（与后端 400 口径一致）。 */
export function isHealthValue(v: string): v is NodeHealthValue {
  return (MOCK_HEALTH_VALUES as string[]).includes(v);
}

/** 生命周期枚举 —— 与后端 `NODE_LIFECYCLES` 同值（node-lifecycle.ts）。 */
export const MOCK_LIFECYCLES = ["active", "maintenance", "disabled", "retiring"] as const;

/** 与后端 `normalizeQueryToken` 同口径：空串与 `all` 都表示「不过滤」。 */
export function normalizeQueryToken(input: string | null | undefined): string | null {
  if (input === undefined || input === null) return null;
  const v = input.trim().toLowerCase();
  if (v === "" || v === "all") return null;
  return v;
}

/** 理由码集合导出，便于测试断言「UI 码表覆盖了后端会发的每一个码」。 */
export const MOCK_REASON_CODES: HealthReasonCode[] = [
  "no_credential",
  "never_reported",
  "report_stale",
  "connection_offline",
  "agent_errors_ongoing",
  "agent_errors_historical",
  "runtime_missing",
  "runtime_revision_behind",
  "port_not_bound",
  "forward_apply_error",
  "agent_version_behind",
  "agent_version_unknown",
  "resource_memory_high",
  "resource_disk_high",
  "resource_load_high",
  "role_mismatch",
];

/** mock 节点解析（数字主键或字符串 node_id），与后端 resolveNodeId 同语义。 */
export function mockResolveNode(nodes: Node[], raw: string | undefined): Node | null {
  if (!raw) return null;
  const asNumber = Number(raw);
  if (Number.isInteger(asNumber) && asNumber > 0) {
    return nodes.find((n) => n.id === asNumber) ?? null;
  }
  return nodes.find((n) => n.node_id === raw) ?? null;
}

/* ================================================================== */
/* store → health 视图（handler 只做路由，投影逻辑留在这里）             */
/* ================================================================== */

export interface MockHealthWorld {
  nodes: Node[];
  tunnels: Tunnel[];
  nodeStates: Map<ID, NodeStateReport>;
  /** RELAY 入口解析：handler 用与转发视图**同一**口径（mockIngressNode）。 */
  ingressNodeIdFor: (tunnel: Tunnel) => ID | null;
  now: Date;
  expected_version?: string | null;
}

/**
 * 与后端 `desiredRuntimesForNode` 同口径：只产出**该节点自己那一份** runtime。
 * `wants_active` 只看 `desired_status`（不看 status），出口侧 listen_port 传 null。
 */
export function mockDesiredRuntimes(world: MockHealthWorld, node: Node): MockDesiredRuntime[] {
  const out: MockDesiredRuntime[] = [];
  for (const t of world.tunnels) {
    const mode = (t.tunnel_mode ?? "").toLowerCase();
    const label = t.name && t.name.length > 0 ? t.name : `#${t.id}`;
    const base = {
      label,
      config_revision: t.config_revision ?? null,
      apply_status: t.apply_status ?? null,
      apply_error: t.apply_error ?? null,
      wants_active: t.desired_status === "active",
    };
    if (world.ingressNodeIdFor(t) === node.id) {
      out.push({ ...base, runtime_id: mockRuntimeId(t.id, mode === "relay" ? "ingress" : "direct"), listen_port: t.listen_port ?? null });
    }
    if (t.egress_node_id === node.id) {
      out.push({ ...base, runtime_id: mockRuntimeId(t.id, "egress"), listen_port: null });
    }
  }
  return out;
}

/** 参与该节点的 Forward 数（同一 Forward 的 ingress/egress 只算一次）。 */
export function mockForwardCount(world: MockHealthWorld, node: Node): number {
  let count = 0;
  for (const t of world.tunnels) {
    if (world.ingressNodeIdFor(t) === node.id || t.egress_node_id === node.id) count += 1;
  }
  return count;
}

/** 单个节点的 health 视图。 */
export function mockNodeHealth(world: MockHealthWorld, node: Node): NodeHealthView {
  return mockHealthView({
    node,
    snapshot: world.nodeStates.get(node.id),
    desired: mockDesiredRuntimes(world, node),
    forward_count: mockForwardCount(world, node),
    now: world.now,
    expected_version: world.expected_version ?? MOCK_AGENT_LATEST_VERSION,
  });
}

export interface MockHealthListResult {
  items: NodeHealthView[];
  total: number;
  summary: NodeHealthSummary;
}

/**
 * 全量巡检：`total` / `summary` 都是**过滤前**的全量口径（与后端一致，
 * 保证「列表被过滤后，四态计数不会跟着缩水」）。
 */
export function mockFleetHealth(
  world: MockHealthWorld,
  filter: { health?: string | null; lifecycle?: string | null; keyword?: string | null } = {},
): MockHealthListResult | { invalid: string } {
  const healthFilter = normalizeQueryToken(filter.health);
  if (healthFilter !== null && !isHealthValue(healthFilter)) {
    return { invalid: "health 只能是 healthy / warning / error / unknown" };
  }
  const lifecycleFilter = normalizeQueryToken(filter.lifecycle);
  // 不校验就过滤的话，`?lifecycle=banana` 会静默返回空列表——面板会把「我拼错
  // 了参数」显示成「一个节点都没有」。与 health 同口径：非法值显式 400。
  if (lifecycleFilter !== null && !(MOCK_LIFECYCLES as readonly string[]).includes(lifecycleFilter)) {
    return { invalid: "lifecycle 只能是 active / maintenance / disabled / retiring" };
  }
  const all = world.nodes.map((n) => mockNodeHealth(world, n));
  const summary = mockHealthSummary(all);
  const keyword = (filter.keyword ?? "").trim().toLowerCase();
  const items = all.filter((v) => {
    if (healthFilter && v.health !== healthFilter) return false;
    if (lifecycleFilter && v.lifecycle !== lifecycleFilter) return false;
    if (keyword) {
      const hay = `${v.node_key} ${v.node_id}`.toLowerCase();
      if (!hay.includes(keyword)) return false;
    }
    return true;
  });
  return { items, total: summary.healthy + summary.warning + summary.error + summary.unknown, summary };
}
