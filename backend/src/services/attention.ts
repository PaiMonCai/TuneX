/**
 * V4-WP8 §13.6 / §13.7 Wave 4 —— Dashboard「需要处理」聚合（纯读 + 可注入）。
 *
 * ── 这个模块存在的理由 ──
 * 改造前 Dashboard 只有计数（`/api/dashboard/stats` 的 `active_nodes` 等），
 * 用户看不到「哪个节点还没装好 / 哪台掉线了 / 哪条转发失败了」。要让 Dashboard
 * 显示**异常、离线、等待安装**入口，就必须有一个聚合口径；如果把它写在前端，
 * 就出现了 §13.4.4 明令禁止的第二套判定（前端再抄一遍 deriveConnection /
 * nodeAdmission / apply 状态语义）。
 *
 * 因此聚合放在后端，且**判定全部复用既有实现**：
 *   · Connection / Lifecycle / 准入 —— `services/node-lifecycle.ts` 的
 *     `deriveConnection` + `nodeAdmission`（经 `services/node-view.ts` 投影）；
 *   · Forward 失败是否值得用户重试 —— `services/scheduler.ts` 的
 *     `isRetryable`（编排知识属于服务层，不是展示偏好）；
 *   · 码（reason_code）一律取既有词表：WP6 的 `HealthReasonCode`、
 *     WP5 的准入拒绝码、WP3 的 scheduler 错误码。**不新造一套码**。
 *
 * 本模块不判定 health（§13.4.4 的 Health 层需要遥测快照，归 WP6 的
 * `node-health-service`）：Dashboard 的待办用 Connection + Lifecycle + 准入 +
 * Forward 运行状态就已经能给出可执行下一步，不重复实现第三层。
 *
 * ── 依赖注入 ──
 * 与 `node-lifecycle.ts` / `node-health-service.ts` 同一取向：默认走进程级
 * `db`，测试传内存替身；`db.ts` 用**惰性** import，避免只想要聚合纯逻辑的
 * 调用方在加载期就把真实 PrismaClient 拽进模块图。
 */
import {
  deriveConnection,
  nodeAdmission,
  type NodeConnectionValue,
} from "./node-lifecycle.ts";

/* ================================================================== */
/* 类型                                                               */
/* ================================================================== */

/**
 * 待办种类。用户侧只有两类资源：节点与转发；`kind` 决定前端跳哪一页。
 *
 * 备注：后端**不**返回 href —— 产品路由是 Web 的事，后端拼 URL 会把
 * 「页面路径」变成 API 契约的一部分。
 */
export type AttentionKind = "node" | "forward";

/** 严重度：error = 已失败；warning = 需要处理但未失败；info = 提示（管理态）。 */
export type AttentionSeverity = "error" | "warning" | "info";

/** 既有词表里的理由码（不新造）。 */
export type AttentionReasonCode =
  // ── WP5 准入拒绝码（含 Connection 层的 node_waiting_install）──
  | "node_waiting_install"
  | "node_in_maintenance"
  | "node_disabled"
  | "node_retiring"
  // ── WP6 健康理由码（同码复用，前端沿用同一套 reasonAction 文案）──
  | "connection_offline"
  | "forward_apply_error"
  | "runtime_revision_behind"
  // ── 本层新增：仅「等待下发」这一个状态在既有词表里没有对应码 ──
  | "forward_pending_apply";

export interface AttentionItem {
  kind: AttentionKind;
  id: number;
  /** 展示名：节点用 `node_id`，转发用 `name`。 */
  name: string;
  severity: AttentionSeverity;
  reason_code: AttentionReasonCode;
  /**
   * Forward 编排失败的结构化错误码（`scheduler.ts` 的 SCHEDULER_ERROR_CODES）。
   * 只对 `forward_apply_error` 有值；前端按它给「重试 / 联系管理员」的下一步。
   */
  apply_error_code?: string | null;
  /**
   * 该错误是否值得用户自行重试（服务端 `isRetryable` 的结论）。
   * null = 与重试无关（节点类条目、或没有错误码的失败）。
   */
  retryable?: boolean | null;
}

export interface AttentionSummary {
  /** Connection=offline 的节点（维护中正常关机也算，语义上是「联系不上」）。 */
  nodes_offline: number;
  /** 还没完成安装（Connection=waiting）的节点。 */
  nodes_waiting_install: number;
  /** 管理态不接受新业务的节点（maintenance / disabled / retiring）。 */
  nodes_restricted: number;
  /** apply_status=error 的转发。 */
  forwards_error: number;
  /** 还在下发中（pending / applying）或已 active 但 revision 落后。 */
  forwards_pending: number;
}

export interface AttentionPayload {
  items: AttentionItem[];
  summary: AttentionSummary;
  /** 命中条数（items 可能被截断，见 ATTENTION_MAX_ITEMS）。 */
  total: number;
  /** 判定时刻（面板显示「N 分钟前的状态」用）。 */
  generated_at: string;
  /**
   * 聚合失败时的降级标记（仅路由兜底分支会带）。
   *
   * 为什么需要它：Dashboard 是首页，一个聚合查询失败不该让整页打不开，但
   * 「空清单」和「取不到清单」对用户是两件事 —— 少了这个字段，查询失败会
   * 伪装成「一切正常」。
   */
  degraded?: boolean;
}

/** items 上限：Dashboard 只做入口，不做全量清单（全量在各资源页）。 */
export const ATTENTION_MAX_ITEMS = 25;

/* ================================================================== */
/* DB 投影（可注入）                                                   */
/* ================================================================== */

export interface AttentionNodeRow {
  id: number;
  node_id: string;
  status?: string | null;
  lifecycle?: string | null;
  last_seen_at?: Date | null;
  has_credential?: boolean;
  credential_revoked?: boolean;
}

export interface AttentionForwardRow {
  id: number;
  name: string;
  apply_status?: string | null;
  apply_error_code?: string | null;
  config_revision?: number | null;
  applied_revision?: number | null;
  updated_at?: Date | null;
}

export interface AttentionDb {
  node: { findMany(args: unknown): Promise<unknown> };
  tunnel: { findMany(args: unknown): Promise<unknown> };
}

export interface AttentionDeps {
  db?: AttentionDb;
  /** 判定时刻（测试注入，避免真实时钟）。 */
  now?: () => Date;
  /**
   * 重试语义（默认懒加载 `services/scheduler.ts` 的 `isRetryable`）。
   *
   * 为什么注入而不是顶层 import：`scheduler.ts` 顶层 import `db.ts`，会把
   * 真实 PrismaClient（以及 portPool → redis）拽进加载期，离线单测就被拖下水。
   * 注入让测试既不需要 Redis，也仍然只消费**同一份**重试判定。
   */
  isRetryable?: (code: string) => boolean;
}

let defaultDbPromise: Promise<AttentionDb> | undefined;

function loadDefaultDb(): Promise<AttentionDb> {
  defaultDbPromise ??= import("../db.ts").then((m) => m.db as unknown as AttentionDb);
  return defaultDbPromise;
}

async function resolveIsRetryable(
  injected: AttentionDeps["isRetryable"],
): Promise<(code: string) => boolean> {
  if (injected) return injected;
  const mod = await import("./scheduler.ts");
  return (code) => mod.isRetryable(code as Parameters<typeof mod.isRetryable>[0]);
}

const NODE_SELECT = {
  id: true,
  node_id: true,
  status: true,
  lifecycle: true,
  last_seen_at: true,
  node_credential_hash: true,
  credential_revoked: true,
} as const;

const FORWARD_SELECT = {
  id: true,
  name: true,
  apply_status: true,
  apply_error_code: true,
  config_revision: true,
  applied_revision: true,
  updated_at: true,
} as const;

/** 严重度排序权重（越小越靠前）：失败 → 待处理 → 提示。 */
const SEVERITY_WEIGHT: Record<AttentionSeverity, number> = { error: 0, warning: 1, info: 2 };

/* ================================================================== */
/* 聚合                                                               */
/* ================================================================== */

function asRows<T>(rows: unknown): T[] {
  return Array.isArray(rows) ? (rows as T[]) : [];
}

/**
 * 一台节点是否需要出现在 Dashboard 待办里。
 *
 * 三种情况互斥且按「先解决最前置的问题」排序：
 *   1. 还没装（waiting）→ 给安装命令；
 *   2. 管理态不接受新业务（maintenance / disabled / retiring）→ 给生命周期动作；
 *   3. 掉线（offline）→ 检查网络/电源。
 *
 * 注意 2 排在 3 前面：维护中的节点掉线是**预期行为**，把它报成「离线故障」
 * 会让用户去查一台本来就该关机的机器（§13.4.2 / §13.4.4 末句）。
 */
/**
 * `nodeAdmission` 的拒绝码里，**本层会出现**的那三个（管理态拒绝）。
 *
 * 其余 `LifecycleConditionCode`（`invalid_transition` / `node_not_retiring` /
 * `dependency_blocked` / `node_still_used_as_*` / `port_range_would_orphan_leases`）
 * 来自生命周期**迁移/删除**路径，不来自准入谓词 —— 本层不得凭空把它们当成
 * 待办理由（那会让 Dashboard 显示一个用户根本没发起的操作失败）。
 */
const NODE_MANAGED_REJECTIONS = [
  "node_in_maintenance",
  "node_disabled",
  "node_retiring",
] as const;

function nodeRejectionCode(condition: string): AttentionReasonCode | null {
  return (NODE_MANAGED_REJECTIONS as readonly string[]).includes(condition)
    ? (condition as AttentionReasonCode)
    : null;
}

function nodeAttention(row: AttentionNodeRow, now: Date): AttentionItem | null {
  const facts = {
    lifecycle: row.lifecycle ?? "active",
    status: row.status ?? null,
    last_seen_at: row.last_seen_at ?? null,
    has_credential: Boolean(row.has_credential),
    credential_revoked: Boolean(row.credential_revoked),
    // `now` 必须显式传下去：`deriveConnection` 缺省读**真实时钟**，不注入就会
    // 让「注入的判定时刻」只影响 generated_at、却让在线窗口按 wall clock 判 ——
    // 测试里相对 NOW 构造的新鲜心跳会被判成离线（本 WP 实测踩过一次）。
    now,
  };
  const connection: NodeConnectionValue = deriveConnection(facts);
  const admission = nodeAdmission(facts);
  const base = { kind: "node" as const, id: row.id, name: row.node_id };

  if (connection === "waiting") {
    return {
      ...base,
      severity: "warning",
      reason_code: "node_waiting_install",
      retryable: null,
    };
  }

  if (!admission.ok) {
    const code = nodeRejectionCode(admission.condition);
    if (code) {
      return { ...base, severity: "info", reason_code: code, retryable: null };
    }
  }

  if (connection === "offline") {
    return {
      ...base,
      severity: "warning",
      reason_code: "connection_offline",
      retryable: null,
    };
  }

  return null;
}

/** 一条转发是否需要出现在待办里（与节点同一取向：一次只报最前置的问题）。 */
function forwardAttention(
  row: AttentionForwardRow,
  isRetryable: (code: string) => boolean,
): AttentionItem | null {
  const base = { kind: "forward" as const, id: row.id, name: row.name };
  const status = row.apply_status ?? null;

  if (status === "error") {
    const code = row.apply_error_code ?? null;
    return {
      ...base,
      severity: "error",
      reason_code: "forward_apply_error",
      apply_error_code: code,
      retryable: code === null ? null : isRetryable(code),
    };
  }

  const desired = row.config_revision ?? null;
  const applied = row.applied_revision ?? null;
  // 「已 active 但 applied < desired」= 面板在推、节点没应用上（WP6 同一码）。
  if (status === "active" && desired !== null && applied !== null && applied < desired) {
    return {
      ...base,
      severity: "warning",
      reason_code: "runtime_revision_behind",
      retryable: null,
    };
  }

  if (status === "pending" || status === "applying") {
    return {
      ...base,
      severity: "info",
      reason_code: "forward_pending_apply",
      retryable: null,
    };
  }

  // suspended 是用户主动暂停，不是待办；active 且 revision 一致 = 健康。
  return null;
}

function emptySummary(): AttentionSummary {
  return {
    nodes_offline: 0,
    nodes_waiting_install: 0,
    nodes_restricted: 0,
    forwards_error: 0,
    forwards_pending: 0,
  };
}

/**
 * 汇总 workspace 的待办条目。
 *
 * 排序是**确定性**的（严重度 → 种类 → id），否则同一个库在不同进程里
 * 会给出一份顺序不同的清单，前端快照测试与用户预期都会抖。
 */
export async function collectAttention(
  workspaceId: number,
  inject?: AttentionDeps,
): Promise<AttentionPayload> {
  const db = inject?.db ?? (await loadDefaultDb());
  const now = inject?.now ?? (() => new Date());
  // 判定时刻**只取一次**：节点在线窗口与 generated_at 必须基于同一瞬间，
  // 否则同一次聚合里两个节点可能落在窗口的两侧（跨秒时）。
  const nowDate = now();
  const isRetryable = await resolveIsRetryable(inject?.isRetryable);

  const [nodeRows, forwardRows] = await Promise.all([
    db.node.findMany({
      where: { node_group: { workspace_id: workspaceId } },
      orderBy: [{ order_by: "asc" }, { id: "asc" }],
      select: NODE_SELECT,
    }),
    db.tunnel.findMany({
      where: { workspace_id: workspaceId, category: "port_forward" },
      orderBy: [{ order_by: "asc" }, { id: "asc" }],
      select: FORWARD_SELECT,
    }),
  ]);

  const nodes = asRows<Record<string, unknown>>(nodeRows).map((row) => ({
    id: Number(row.id),
    node_id: String(row.node_id ?? ""),
    status: (row.status as string | null) ?? null,
    lifecycle: (row.lifecycle as string | null) ?? null,
    last_seen_at: (row.last_seen_at as Date | null) ?? null,
    has_credential: Boolean(row.node_credential_hash),
    credential_revoked: Boolean(row.credential_revoked),
  })) as AttentionNodeRow[];

  const forwards = asRows<Record<string, unknown>>(forwardRows).map((row) => ({
    id: Number(row.id),
    name: String(row.name ?? ""),
    apply_status: (row.apply_status as string | null) ?? null,
    apply_error_code: (row.apply_error_code as string | null) ?? null,
    config_revision: (row.config_revision as number | null) ?? null,
    applied_revision: (row.applied_revision as number | null) ?? null,
    updated_at: (row.updated_at as Date | null) ?? null,
  })) as AttentionForwardRow[];

  const summary = emptySummary();
  const items: AttentionItem[] = [];

  for (const node of nodes) {
    const item = nodeAttention(node, nowDate);
    if (!item) continue;
    if (item.reason_code === "node_waiting_install") summary.nodes_waiting_install++;
    else if (item.reason_code === "connection_offline") summary.nodes_offline++;
    else summary.nodes_restricted++;
    items.push(item);
  }

  for (const forward of forwards) {
    const item = forwardAttention(forward, isRetryable);
    if (!item) continue;
    if (item.reason_code === "forward_apply_error") summary.forwards_error++;
    else summary.forwards_pending++;
    items.push(item);
  }

  items.sort((a, b) => {
    const bySeverity = SEVERITY_WEIGHT[a.severity] - SEVERITY_WEIGHT[b.severity];
    if (bySeverity !== 0) return bySeverity;
    if (a.kind !== b.kind) return a.kind === "node" ? -1 : 1;
    return a.id - b.id;
  });

  return {
    items: items.slice(0, ATTENTION_MAX_ITEMS),
    summary,
    total: items.length,
    generated_at: nowDate.toISOString(),
  };
}
