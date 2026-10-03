/**
 * V4-WP11C — Support Bundle（服务层）。
 *
 * 这是一份**给排障用的、可以安全带出控制面的快照**。它的全部设计都围绕一个
 * 前提：产物会离开控制面（下载、贴进工单、发邮件），一旦漏掉一处凭据，泄漏就是
 * 永久且不可撤回的。
 *
 * ── 两道独立防线（缺一不可）──
 *
 * 1. **白名单采集**：只取显式列出的字段，逐字段投影。不是"取出整行再删敏感字段"
 *    ——后者会在新加一列时静默泄漏，而这一层必须对"上游加了字段"免疫。
 * 2. **确定性脱敏**（`services/redaction.ts`）：整份产物再过一遍键名/形状/已知密值
 *    三层脱敏。白名单会随功能放松，脱敏是最后一道与业务无关的确定性防线。
 *
 * ── 其他硬约束 ──
 *
 * · **只读**：不产生 Agent 命令、不移动 revision；
 * · **有界**：每段条数上限 + 整体字节上限，超限**显式标记 truncated**（不能静默
 *   截断，否则"没有错误"与"没取到错误"分不清）；
 * · **离线可用**：节点从未上报时给 `state_report: null` 与说明，而不是报错；
 * · **不假装全知**：产物只陈述控制面**知道**的事实，不推断运行态。
 */

import { redact, redactToJson, type RedactOptions } from "./redaction.ts";

/** 每段条数上限。 */
export const BUNDLE_MAX_FORWARDS = 50;
export const BUNDLE_MAX_ROLLOUTS = 25;
export const BUNDLE_MAX_AUDIT = 25;
/** 整份产物（序列化后）的字节上限。 */
export const BUNDLE_MAX_BYTES = 256 * 1024;

export interface SupportBundleDeps {
  /**
   * The node's own self report (WP11C, Agent side). Optional because it needs a
   * live round trip: a bundle must still be produced when the node is offline,
   * and a missing section is then reported as such instead of failing the artefact.
   */
  loadAgentFacts?: (nodeId: number) => Promise<
    { ok: true; facts: import("./agent-command-bus.ts").NodeSelfFacts }
    | { ok: false; error_code: string; message: string }
  >;
  loadNode(nodeId: number, workspaceId: number): Promise<BundleNodeRow | null>;
  loadStateReport(nodeId: number): Promise<BundleStateRow | null>;
  loadForwards(nodeId: number, workspaceId: number, limit: number): Promise<BundleForwardRow[]>;
  loadRollouts(tunnelIds: number[], limit: number): Promise<BundleRolloutRow[]>;
  loadAudit(workspaceId: number, nodeId: number, limit: number): Promise<BundleAuditRow[]>;
  panelVersion?: string;
  now?: () => Date;
}

/** 节点行的**白名单投影**：刻意不含 `node_credential_hash` / `credential_rotated_at` 等。 */
export interface BundleNodeRow {
  id: number;
  node_id: string;
  agent_id: string;
  role: string | null;
  lifecycle: string | null;
  status: string | null;
  last_seen_at: Date | null;
  port_range_min: number | null;
  port_range_max: number | null;
  lb_strategy: string | null;
  group: { id: number; name: string } | null;
  /** 凭据**状态**（是否签过/是否撤销）——不是凭据本身。 */
  has_credential: boolean;
  credential_revoked: boolean;
}

export interface BundleStateRow {
  version: string | null;
  role: string | null;
  control_protocol_version: number | null;
  capabilities: unknown;
  reported_revision: number | null;
  known_revision: number | null;
  runtime_counts: unknown;
  host_metrics: unknown;
  used_ports: unknown;
  error_count: number | null;
  last_error: string | null;
  reported_at: Date;
}

export interface BundleForwardRow {
  id: number;
  name: string;
  mode: string;
  listen_port: number | null;
  target_host: string | null;
  target_port: number | null;
  desired_status: string | null;
  apply_status: string | null;
  config_revision: number | null;
  applied_revision: number | null;
  apply_error_code: string | null;
  apply_error: string | null;
  ingress_node_id: number | null;
  egress_node_id: number | null;
}

export interface BundleRolloutRow {
  id: number;
  tunnel_id: number;
  revision: number;
  phase: string;
  strategy: string | null;
  last_error_code: string | null;
  updated_at: Date;
}

export interface BundleAuditRow {
  id: number;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  actor_user_id: number | null;
  created_at: Date;
}

export interface SupportBundle {
  schema_version: 1;
  generated_at: string;
  panel_version: string | null;
  node: BundleNodeRow;
  state_report: BundleStateRow | null;
  forwards: BundleForwardRow[];
  rollouts: BundleRolloutRow[];
  audit: BundleAuditRow[];
  /**
   * Agent 侧白名单自述（版本 / 进程 / listeners / LKG 状态）。
   * `null` 表示没有取到（节点离线或版本不支持），`agent_facts_error` 说明原因——
   * "没有"与"没取到"必须在产物里可区分。
   */
  agent_facts?: import("./agent-command-bus.ts").NodeSelfFacts | null;
  agent_facts_error?: { error_code: string; message: string } | null;
  /** 有界采样的可见标记：`null` = 什么都没被截断。 */
  truncated: { forwards: boolean; rollouts: boolean; audit: boolean } | null;
  /** 采集期的说明（离线、空集合等），供读的人判断"没有"与"没取到"。 */
  notes: string[];
}

/**
 * Which sections the caller is allowed to see.
 *
 * Explicit, with no default: a default that leaks is worse than a required
 * argument. The route computes it from the actor's effective permissions, so a
 * node-only reader never receives forward details in a bundle.
 */
export interface BundleSections {
  forwards: boolean;
  audit: boolean;
}

export type BundleOutcome =
  | { ok: true; bundle: SupportBundle; json: string; bytes: number }
  | { ok: false; status: 404 | 500; code: string; message: string; error_layer: "resource_scope" | "runtime_admission" };

/**
 * 采集一份 Support Bundle。调用方负责 RBAC（`node:read`）与资源作用域：
 * 这里只接受**已经在当前 workspace 里解析过的** node id。
 */
export async function collectSupportBundle(
  nodeId: number,
  workspaceId: number,
  deps: SupportBundleDeps,
  sections: BundleSections,
): Promise<BundleOutcome> {
  const node = await deps.loadNode(nodeId, workspaceId);
  if (!node) {
    return { ok: false, status: 404, code: "not_found", message: "节点不存在", error_layer: "resource_scope" };
  }

  const now = deps.now ?? (() => new Date());
  const notes: string[] = [];
  const state = await deps.loadStateReport(nodeId);
  if (!state) notes.push("该节点尚未上报过状态（state_report 为 null，不代表节点故障）");

  if (!sections.forwards) notes.push("未包含转发明细：当前身份没有 forward:read");
  if (!sections.audit) notes.push("未包含审计记录：当前身份没有 audit:read");

  const forwards = sections.forwards
    ? await deps.loadForwards(nodeId, workspaceId, BUNDLE_MAX_FORWARDS + 1)
    : [];
  const forwardsTruncated = forwards.length > BUNDLE_MAX_FORWARDS;
  if (forwardsTruncated) notes.push(`转发列表超过 ${BUNDLE_MAX_FORWARDS} 条，已截断`);

  const tunnelIds = forwards.slice(0, BUNDLE_MAX_FORWARDS).map((f) => f.id);
  const rollouts = tunnelIds.length === 0
    ? []
    : await deps.loadRollouts(tunnelIds, BUNDLE_MAX_ROLLOUTS + 1);
  const rolloutsTruncated = rollouts.length > BUNDLE_MAX_ROLLOUTS;
  if (rolloutsTruncated) notes.push(`rollout 记录超过 ${BUNDLE_MAX_ROLLOUTS} 条，已截断`);

  // Agent 侧事实：有则更好，没有也要出产物（离线节点照样要能生成支持包）。
  let agentFacts: SupportBundle["agent_facts"] = null;
  let agentFactsError: SupportBundle["agent_facts_error"] = null;
  if (deps.loadAgentFacts) {
    try {
      const asked = await deps.loadAgentFacts(nodeId);
      if (asked.ok) {
        agentFacts = asked.facts;
      } else {
        agentFactsError = { error_code: asked.error_code, message: asked.message };
        notes.push(`未包含节点自述事实：${asked.message}`);
      }
    } catch (error) {
      agentFactsError = { error_code: "agent_facts_failed", message: (error as Error).message };
      notes.push("未包含节点自述事实：采集失败");
    }
  } else {
    notes.push("未包含节点自述事实：本次调用没有提供采集器");
  }

  const audit = sections.audit ? await deps.loadAudit(workspaceId, nodeId, BUNDLE_MAX_AUDIT + 1) : [];
  const auditTruncated = audit.length > BUNDLE_MAX_AUDIT;
  if (auditTruncated) notes.push(`审计记录超过 ${BUNDLE_MAX_AUDIT} 条，已截断`);

  const bundle: SupportBundle = {
    schema_version: 1,
    generated_at: now().toISOString(),
    panel_version: deps.panelVersion ?? null,
    node,
    state_report: state,
    ...(agentFacts ? { agent_facts: agentFacts } : {}),
    ...(agentFactsError ? { agent_facts_error: agentFactsError } : {}),
    forwards: forwards.slice(0, BUNDLE_MAX_FORWARDS),
    rollouts: rollouts.slice(0, BUNDLE_MAX_ROLLOUTS),
    audit: audit.slice(0, BUNDLE_MAX_AUDIT),
    truncated: forwardsTruncated || rolloutsTruncated || auditTruncated
      ? { forwards: forwardsTruncated, rollouts: rolloutsTruncated, audit: auditTruncated }
      : null,
    notes,
  };

  return finalizeBundle(bundle);
}

/**
 * 脱敏 + 体积封顶。导出端点与测试都走这里，保证只有一条产物路径。
 */
export function finalizeBundle(bundle: SupportBundle, options: RedactOptions = {}): BundleOutcome {
  // Second line of defence: whatever the collectors returned, the artefact is
  // redacted before it leaves the control plane.
  const safe = redact(bundle, 0, options) as SupportBundle;
  let json = redactToJson(safe, true, options);
  if (Buffer.byteLength(json, "utf8") > BUNDLE_MAX_BYTES) {
    // Over budget: keep the shape and the facts that matter for triage, and say so.
    const trimmed: SupportBundle = {
      ...safe,
      forwards: [],
      rollouts: [],
      audit: [],
      truncated: { forwards: true, rollouts: true, audit: true },
      notes: [...safe.notes, `产物超过 ${BUNDLE_MAX_BYTES} 字节上限，已只保留节点与状态摘要`],
    };
    json = redactToJson(trimmed, true, options);
    return { ok: true, bundle: trimmed, json, bytes: Buffer.byteLength(json, "utf8") };
  }
  return { ok: true, bundle: safe, json, bytes: Buffer.byteLength(json, "utf8") };
}

/* ================================================================== */
/* 生产接线（懒加载：测试与 worker import 期都不连库）                    */
/* ================================================================== */

export function defaultSupportBundleDeps(): SupportBundleDeps {
  return {
    panelVersion: process.env.TUNEX_PANEL_VERSION?.trim() || undefined,

    async loadNode(nodeId, workspaceId) {
      const { db } = await import("../db.ts");
      const row = await db.node.findFirst({
        where: { id: nodeId, node_group: { workspace_id: workspaceId } },
        select: {
          id: true, node_id: true, agent_id: true, role: true, lifecycle: true, status: true,
          last_seen_at: true, port_range_min: true, port_range_max: true, lb_strategy: true,
          node_credential_hash: true, credential_revoked: true,
          node_group: { select: { id: true, name: true } },
        },
      });
      if (!row) return null;
      // Whitelist projection: the credential hash is used ONLY to derive a
      // boolean and never enters the bundle.
      return {
        id: row.id,
        node_id: row.node_id,
        agent_id: row.agent_id,
        role: row.role,
        lifecycle: row.lifecycle,
        status: row.status,
        last_seen_at: row.last_seen_at,
        port_range_min: row.port_range_min,
        port_range_max: row.port_range_max,
        lb_strategy: row.lb_strategy,
        group: row.node_group ? { id: row.node_group.id, name: row.node_group.name } : null,
        has_credential: Boolean(row.node_credential_hash),
        credential_revoked: Boolean(row.credential_revoked),
      };
    },

    async loadStateReport(nodeId) {
      const { db } = await import("../db.ts");
      const row = await db.nodeStateReport.findUnique({
        where: { node_id: nodeId },
        select: {
          version: true, role: true, control_protocol_version: true, capabilities: true,
          reported_revision: true, known_revision: true, runtime_counts: true,
          host_metrics: true, used_ports: true, error_count: true, last_error: true, reported_at: true,
        },
      });
      return row ?? null;
    },

    async loadForwards(nodeId, workspaceId, limit) {
      const { db } = await import("../db.ts");
      const rows = await db.tunnel.findMany({
        where: {
          workspace_id: workspaceId,
          category: "port_forward",
          OR: [{ ingress_node_id: nodeId }, { egress_node_id: nodeId }],
        },
        orderBy: { id: "asc" },
        take: limit,
        select: {
          id: true, name: true, tunnel_mode: true, listen_port: true, remote_host: true, remote_port: true,
          desired_status: true, apply_status: true, config_revision: true, applied_revision: true,
          apply_error_code: true, apply_error: true, ingress_node_id: true, egress_node_id: true,
        },
      });
      return rows.map((r) => ({ ...r, mode: r.tunnel_mode ?? "direct" })) as never;
    },

    async loadRollouts(tunnelIds, limit) {
      const { db } = await import("../db.ts");
      const rows = await db.forwardRollout.findMany({
        where: { tunnel_id: { in: tunnelIds } },
        orderBy: [{ updated_at: "desc" }, { id: "desc" }],
        take: limit,
        select: {
          id: true, tunnel_id: true, revision: true, phase: true, strategy: true,
          last_error_code: true, updated_at: true,
        },
      });
      return rows as never;
    },

    async loadAgentFacts(nodeId) {
      const { collectNodeDiagnostics, defaultNodeDiagnosticsDeps } = await import("./node-diagnostics.ts");
      const { db } = await import("../db.ts");
      const node = await db.node.findUnique({
        where: { id: nodeId },
        select: { node_group: { select: { workspace_id: true } } },
      });
      const workspaceId = node?.node_group.workspace_id;
      if (workspaceId === undefined) {
        return { ok: false as const, error_code: "not_found", message: "节点不存在" };
      }
      // Same offline gate as the diagnostics endpoint: a bundle for an offline
      // node says "offline" instead of spending the command timeout.
      const report = await collectNodeDiagnostics(nodeId, workspaceId, defaultNodeDiagnosticsDeps());
      if (!report.ok) return { ok: false as const, error_code: report.code, message: report.message };
      if (report.report.agent_facts) return { ok: true as const, facts: report.report.agent_facts };
      const error = report.report.agent_facts_error;
      return {
        ok: false as const,
        error_code: error?.error_code ?? "offline",
        message: error?.message ?? `节点未在线（reachability=${report.report.reachability}）`,
      };
    },

    async loadAudit(workspaceId, nodeId, limit) {
      const { db } = await import("../db.ts");
      const rows = await db.auditEvent.findMany({
        where: { workspace_id: workspaceId, resource_type: "node", resource_id: String(nodeId) },
        orderBy: [{ created_at: "desc" }, { id: "desc" }],
        take: limit,
        select: { id: true, action: true, resource_type: true, resource_id: true, actor_user_id: true, created_at: true },
      });
      return rows as never;
    },
  };
}
