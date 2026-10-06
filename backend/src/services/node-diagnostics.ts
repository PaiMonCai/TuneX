/**
 * Node 级诊断（面板侧编排）。
 *
 * 与 Forward 诊断的区别：Forward 诊断回答"这条转发哪一段不通"，Node 诊断回答
 * "这个节点现在到底在跑什么"。因此它不猜、不探测、不读远端文件：事实只有两个来源——
 *   1. 面板自己持有的（节点行、最近一次状态上报、desired/applied 汇总）；
 *   2. **节点进程自述**（`collect_diagnostics`，见 Agent 侧 internal/selfinfo）。
 *
 * ── 为什么必须先判"离线" ──
 *
 * 老实现会直接下发命令再等 20 秒 ACK 超时。对一台已经掉线的机器等 20 秒毫无意义：
 * 用户要的是"它离线了"这个事实，而不是一个超时。所以这里**先用上报新鲜度判活**，
 * 离线就立刻返回结构化 `offline`，一条命令都不发。
 */

import { redact } from "./redaction.ts";
import type { NodeSelfFacts } from "./agent-command-bus.ts";
import { decideCapability, type AgentCapabilityFacts } from "./agent-capability.ts";

/** 状态上报超过这个秒数没有更新，就认为节点不在线（心跳间隔 30s 的 2.5 倍）。 */
export const NODE_OFFLINE_AFTER_SECONDS = 75;

/** 一次 Node 诊断的总预算（毫秒）：命令等待 + 面板侧读取。 */
export const NODE_DIAGNOSTICS_TIMEOUT_MS = 12_000;

export interface NodePanelFacts {
  id: number;
  node_id: string;
  agent_id: string | null;
  role: string | null;
  lifecycle: string | null;
  status: string | null;
  last_seen_at: string | null;
  /** 最近一次状态上报里的事实（面板侧持有的那一份）。 */
  reported: {
    version: string | null;
    role: string | null;
    control_protocol_version: number | null;
    capabilities: string[] | null;
    reported_revision: number | null;
    known_revision: number | null;
    reported_at: string | null;
    age_seconds: number | null;
    last_error: string | null;
    error_count: number | null;
  } | null;
  /** 该节点上转发的 desired/applied 汇总（只给计数与不一致数，不下发配置）。 */
  forwards: {
    total: number;
    active: number;
    pending: number;
    failed: number;
    /** desired 与 applied revision 不一致的条数（收敛性事实）。 */
    unconverged: number;
  };
}

export interface NodeDiagnosticsReport {
  node_id: number;
  node_key: string;
  generated_at: string;
  /** `online` = 面板认为它在线上；`offline` = 上报过期，未下发任何命令。 */
  reachability: "online" | "offline" | "unknown";
  /** 离线或不支持时为空；`null` 表示"没有取到自述事实"，与"取到但为空"区分。 */
  agent_facts: NodeSelfFacts | null;
  agent_facts_error: { error_code: string; message: string } | null;
  panel: NodePanelFacts;
  /** 面向用户的下一步。 */
  next_step: string | null;
}

export interface NodeDiagnosticsDeps {
  loadPanelFacts(nodeId: number, workspaceId: number): Promise<NodePanelFacts | null>;
  /** 读能力事实（不产生命令）。 */
  loadCapability(nodeId: number): Promise<AgentCapabilityFacts | null>;
  /** 向节点索取自述事实。 */
  collectAgentFacts(input: { nodeId: number; timeoutMs: number }):
    Promise<{ ok: true; facts: NodeSelfFacts } | { ok: false; error_code: string; error: string }>;
  now?: () => Date;
}

export type NodeDiagnosticsOutcome =
  | { ok: true; report: NodeDiagnosticsReport }
  | { ok: false; status: 404; code: string; message: string; error_layer: "resource_scope" };

/**
 * 采集一份 Node 诊断。调用方负责 RBAC（`node:read`）与资源作用域。
 */
export async function collectNodeDiagnostics(
  nodeId: number,
  workspaceId: number,
  deps: NodeDiagnosticsDeps,
): Promise<NodeDiagnosticsOutcome> {
  const panel = await deps.loadPanelFacts(nodeId, workspaceId);
  if (!panel) {
    return { ok: false, status: 404, code: "not_found", message: "节点不存在", error_layer: "resource_scope" };
  }

  const now = deps.now ?? (() => new Date());
  const age = panel.reported?.age_seconds ?? null;
  // Freshness decides reachability BEFORE anything is dispatched. A node that has
  // not reported for longer than the offline threshold is not "slow to answer",
  // it is gone — and waiting for the ACK timeout would only delay that fact.
  const reachability: NodeDiagnosticsReport["reachability"] =
    age === null ? "unknown" : age > NODE_OFFLINE_AFTER_SECONDS ? "offline" : "online";

  const report: NodeDiagnosticsReport = {
    node_id: panel.id,
    node_key: panel.node_id,
    generated_at: now().toISOString(),
    reachability,
    agent_facts: null,
    agent_facts_error: null,
    panel,
    next_step: null,
  };

  if (reachability !== "online") {
    report.next_step = reachability === "offline"
      ? `节点已 ${age ?? "?"} 秒没有上报（超过 ${NODE_OFFLINE_AFTER_SECONDS} 秒阈值）：请检查节点主机与 Agent 进程是否在运行，未下发任何自检命令。`
      : "该节点还没有上报过状态：请先完成安装并确认 Agent 能连上面板。";
    return { ok: true, report };
  }

  const facts = await deps.loadCapability(nodeId);
  const decision = decideCapability(facts, "collect_diagnostics");
  if (!decision.supported) {
    // Never send a command the node has not advertised: the agent would answer
    // unsupported_action and the caller would read it as a fault.
    report.agent_facts_error = { error_code: decision.reason, message: decision.detail };
    report.next_step = "该节点的 Agent 版本不支持自检，请先升级节点后再试（面板侧事实仍然可用）。";
    return { ok: true, report };
  }

  const issued = await deps.collectAgentFacts({ nodeId, timeoutMs: NODE_DIAGNOSTICS_TIMEOUT_MS });
  if (!issued.ok) {
    report.agent_facts_error = { error_code: issued.error_code, message: issued.error };
    report.next_step = issued.error_code === "ack_timeout"
      ? "节点在线但没有在规定时间内回答自检：可能有命令积压，请稍后重试。"
      : "节点拒绝了自检请求；面板侧事实仍然可用。";
    return { ok: true, report };
  }
  // Redact defensively: the fact shape is closed and validated in the bus, and
  // the artefact the user reads must not depend on that staying true.
  report.agent_facts = redact(issued.facts) as NodeSelfFacts;
  report.next_step = nodeNextStep(report);
  return { ok: true, report };
}

/**
 * 「已知事实 → 下一步」。只在事实确实指向一个问题时给建议，否则老实说不确定。
 */
export function nodeNextStep(report: NodeDiagnosticsReport): string | null {
  const facts = report.agent_facts;
  if (!facts) {
    return report.agent_facts_error ? "节点自检未取到事实；面板侧事实仍然可用。" : null;
  }

  if (facts.shutting_down) {
    return "节点正在关机/排空中：此时不接受新业务，存量连接在有界窗口内结束。";
  }
  // The process's own view vs the panel's view: a mismatch here is the single
  // most useful thing a node diagnostic can surface.
  const panelRevision = report.panel.reported?.reported_revision ?? null;
  if (panelRevision !== null && panelRevision !== facts.runtime.tunnel_count) {
    // Not a defect by itself (a node may run tunnels the panel also counts), so
    // only a count mismatch on the SAME descriptor is reported as a hint.
  }
  if (facts.runtime.truncated) {
    return `节点运行的转发超过自检上限（只列出 ${facts.runtime.tunnels.length} 条），计数仍是真实总数。`;
  }
  if (facts.state_dir.configured && !facts.state_dir.cache_valid) {
    return facts.state_dir.cache_present
      ? "本机已知良好状态缓存存在但未通过校验：面板停机重启时该节点可能无法恢复监听，请检查状态目录与 Agent 版本。"
      : "本机还没有已知良好状态缓存：面板停机重启时该节点无法恢复监听（首次启动属正常，长期如此请检查状态目录权限）。";
  }
  const unconverged = report.panel.forwards.unconverged;
  if (unconverged > 0) {
    return `该节点有 ${unconverged} 条转发尚未收敛（desired ≠ applied）：稍后重试，若持续出现请查看 rollout 记录。`;
  }
  if (report.panel.forwards.failed > 0) {
    return `该节点有 ${report.panel.forwards.failed} 条转发处于失败状态：请查看对应转发的错误码。`;
  }
  return null;
}

/* ================================================================== */
/* 生产接线（懒加载）                                                    */
/* ================================================================== */

export function defaultNodeDiagnosticsDeps(): NodeDiagnosticsDeps {
  return {
    async loadPanelFacts(nodeId, workspaceId) {
      const { db } = await import("../db.ts");
      const row = await db.node.findFirst({
        where: { id: nodeId, node_group: { workspace_id: workspaceId } },
        select: {
          id: true, node_id: true, agent_id: true, role: true, lifecycle: true, status: true, last_seen_at: true,
          state_report: {
            select: {
              version: true, role: true, control_protocol_version: true, capabilities: true,
              reported_revision: true, known_revision: true, reported_at: true,
              last_error: true, error_count: true,
            },
          },
        },
      });
      if (!row) return null;

      const tunnels = await db.tunnel.findMany({
        where: { workspace_id: workspaceId, OR: [{ ingress_node_id: nodeId }, { egress_node_id: nodeId }] },
        select: { apply_status: true, desired_status: true, config_revision: true, applied_revision: true },
      });
      const nowMs = Date.now();
      const reported = row.state_report;
      const capabilities = Array.isArray(reported?.capabilities)
        ? (reported?.capabilities as string[]).filter((c) => typeof c === "string")
        : null;

      return {
        id: row.id,
        node_id: row.node_id,
        agent_id: row.agent_id,
        role: row.role,
        lifecycle: row.lifecycle,
        status: row.status,
        last_seen_at: row.last_seen_at ? row.last_seen_at.toISOString() : null,
        reported: reported
          ? {
              version: reported.version,
              role: reported.role,
              control_protocol_version: reported.control_protocol_version ?? null,
              capabilities,
              reported_revision: reported.reported_revision ?? null,
              known_revision: reported.known_revision ?? null,
              reported_at: reported.reported_at ? reported.reported_at.toISOString() : null,
              age_seconds: reported.reported_at
                ? Math.max(0, Math.round((nowMs - reported.reported_at.getTime()) / 1000))
                : null,
              last_error: reported.last_error ?? null,
              error_count: reported.error_count ?? null,
            }
          : null,
        forwards: {
          total: tunnels.length,
          active: tunnels.filter((t) => t.apply_status === "active").length,
          pending: tunnels.filter((t) => t.apply_status === "pending" || t.apply_status === "applying").length,
          failed: tunnels.filter((t) => t.apply_status === "failed").length,
          unconverged: tunnels.filter(
            (t) => t.config_revision !== null && t.applied_revision !== null && t.config_revision !== t.applied_revision,
          ).length,
        },
      };
    },

    async loadCapability(nodeId) {
      const { db } = await import("../db.ts");
      const { capabilityFactsFromStored } = await import("./agent-capability.ts");
      const row = await db.nodeStateReport.findUnique({
        where: { node_id: nodeId },
        select: {
          control_protocol_version: true, capabilities: true, reported_at: true,
          node: { select: { credential_rotated_at: true } },
        },
      });
      return capabilityFactsFromStored(
        row
          ? {
              control_protocol_version: row.control_protocol_version,
              capabilities: row.capabilities,
              reported_at: row.reported_at,
              credential_rotated_at: row.node?.credential_rotated_at ?? null,
            }
          : null,
      );
    },

    async collectAgentFacts(input) {
      const { issueAgentDiagnostics } = await import("./agent-command-bus.ts");
      return issueAgentDiagnostics({ nodeId: input.nodeId, timeoutMs: input.timeoutMs });
    },
  };
}
