/**
 * Forward 诊断（服务层）。
 *
 * 这一层回答一个用户真正会问的问题：**「这条转发到底哪一段不通？」**
 *
 * ── 三个不可协商的边界 ──
 *
 * 1. **探针目标是服务端自己算出来的**，不是请求体给的。请求只带一个 Forward
 *    id；host/port 来自该转发的**已授权期望状态**（DIRECT 的 remote_host/port、
 *    RELAY 的出口节点 next-hop 与它自己那份 EgressPool）。否则这个端点就成了
 *    "用别人的机器扫我的内网"的 SSRF 工具。
 * 2. **分段探测，不假装端到端**。DIRECT 探「入口节点 → 目标」；RELAY 探
 *    「入口节点 → 出口节点」和「出口节点 → 目标」。返回的是每段的 TCP 可达性，
 *    不是"业务可用"——TCP 连上不代表对端说对了协议。
 * 3. **只读**。探针不移动 revision、不改 desired（Agent 侧同样是只读动作），
 *    结果里也不含任何凭据。
 *
 * 诊断命令与普通下发走同一套护栏：能力协商、pending/ACK 绑定、超时清理。
 */

import { capabilityFactsFromStored, decideCapability, type AgentCapabilityFacts } from "./agent-capability.ts";
import {
  probeTargetsForForward,
  type DiagnoseProbeTarget,
  type PlannedSegment,
} from "./forward-probe-plan.ts";
import { redact } from "./redaction.ts";
import { persistedForwardProtocol } from "./forward-contract.ts";

/** 面板侧对一次诊断的最大目标数（与 Agent 侧上限一致，超出即拒绝而不是截断）。 */
export const DIAGNOSE_MAX_TARGETS = 8;

/** 一次诊断命令的等待上限（毫秒）。探针本身有更小的预算，这里只兜底。 */
export const DIAGNOSE_COMMAND_TIMEOUT_MS = 20_000;

export type DiagnoseSegmentName =
  | "ingress_to_target"
  | "ingress_to_egress"
  // V5.4：三跳路由把"入口↔出口"这一段**拆成两段**，因此诊断也要按 hop 分解 ——
  // 否则三跳下只能得到"这条转发有问题"，而 G4 明确要求遥测能**定位失败跳**。
  | "ingress_to_middle"
  | "middle_to_egress"
  | "egress_to_target";

/**
 * How a segment's conclusion was obtained.
 *
 * `node_facts` exists because the ingress↔egress path runs through the egress
 * node's BUSINESS listener: dialling it would create a real business connection
 * (accept → pick target → dial upstream → count it in Stats). A diagnostic must
 * not do that, so that segment reports only what the two agents' state reports
 * say, and is explicitly marked as unverified.
 */
export type DiagnoseSegmentMethod = "tcp_probe" | "node_facts";

export interface DiagnoseSegment {
  protocol?: "tcp";
  segment: DiagnoseSegmentName;
  method: DiagnoseSegmentMethod;
  /** `false` = 这一段没有做过连通性验证，结论只来自节点上报的事实。 */
  verified: boolean;
  /** 在哪个节点上执行的探测（panel 视角的节点 id）；facts 段是入口节点。 */
  node_id: number;
  node_key: string;
  /**
   * 该节点在**下发命令**时的能力事实（未上报 → 新动作会被拒）。
   * facts 段不发命令，因此不带这个字段：把它填成 advertised:false 会让人误以为
   * "这个节点不支持诊断"，而事实核对根本不需要诊断能力。
   */
  capability?: { advertised: boolean; actions: string[] | null };
  targets: DiagnoseProbeTarget[];
  /** Agent 返回的逐目标结果；拒绝或失败时为空。 */
  results: DiagnoseProbeResult[];
  /** facts 段的事实明细（tcp_probe 段为 undefined）。 */
  facts?: DiagnoseSegmentFacts;
  /** 整段的机器可读结论。`unknown` = 事实不足，不能当成正常。 */
  outcome: "ok" | "unreachable" | "unsupported" | "failed" | "unknown";
  error_code?: string;
  message?: string;
}

/** 两端运行态事实（全部来自状态上报，没有一次拨号）。 */
export interface DiagnoseSegmentFacts {
  /** 展示用：配置的下一跳地址（指向业务监听端口，故只展示不探测）。 */
  hop: { host: string; port: number } | null;
  expected_revision: number | null;
  ingress: {
    node_id: number;
    reported: boolean;
    runtime_present: boolean;
    runtime_revision: number | null;
    listener_port: number | null;
  };
  egress: {
    node_id: number;
    reported: boolean;
    runtime_present: boolean;
    runtime_revision: number | null;
    listener_port: number | null;
  };
}

export interface DiagnoseProbeResult {
  host: string;
  port: number;
  status: string;
  elapsed_ms: number;
  resolved_ip?: string;
  detail?: string;
}

export interface DiagnoseReport {
  forward_id: number;
  mode: "direct" | "relay";
  generated_at: string;
  /** 逐段结果；DIRECT 只有一段。 */
  segments: DiagnoseSegment[];
  /** 面向用户的下一步（可行动的一句话），没结论时为 null。 */
  next_step: string | null;
}

export interface DiagnoseDeps {
  /** 读一条 workspace 作用域内的 Forward（含节点与池）。 */
  loadForward(forwardId: number, workspaceId: number): Promise<ForwardForDiagnose | null>;
  /** 读节点的能力事实。 */
  loadCapability(nodeId: number): Promise<AgentCapabilityFacts | null>;
  /** 读一个节点最近一次状态上报里与本转发相关的事实（不发命令）。 */
  loadNodeRuntimeFacts(input: {
    nodeId: number;
    runtimeId: string;
  }): Promise<{ reported: boolean; runtime_present: boolean; runtime_revision: number | null; listener_port: number | null }>;
  /** 发一条只读诊断命令并等待结果。 */
  issueDiagnose(input: {
    nodeId: number;
    nodeKey: string;
    forwardId: number;
    /** Runtime id of the segment this command addresses (from the plan). */
    resourceId: string;
    targets: DiagnoseProbeTarget[];
    timeoutMs: number;
  }): Promise<{ ok: true; results: DiagnoseProbeResult[] } | { ok: false; error_code: string; error: string }>;
  now?: () => Date;
}

/** 诊断需要的最小 Forward 投影（全部来自 desired state）。 */
export interface ForwardForDiagnose {
  protocol?: string;
  federated_egress_peer?: string | null;
  tls_cert_path?: string | null; tls_key_path?: string | null; link_source_config?: unknown;
  id: number;
  mode: "direct" | "relay";
  ingress_node_id: number | null;
  ingress_node_key: string;
  ingress_connect_ip: string | null;
  egress_node_id: number | null;
  egress_node_key: string | null;
  egress_connect_ip: string | null;
  egress_port: number | null;
  /**
   * V5.4：三跳路由的中间跳（`null`/缺省 = 单跳）。诊断必须知道它，才能把
   * "入口↔出口"拆成两段并**点名**失败的那一跳。
   */
  middle_node_id?: number | null;
  middle_node_key?: string | null;
  middle_connect_ip?: string | null;
  /** 中间跳自己的监听端口（节点间内部端口）。 */
  middle_port?: number | null;
  remote_host: string | null;
  remote_port: number | null;
  /** 期望两端收敛到的 revision（desired）；facts 段用它判断是否落后。 */
  config_revision: number | null;
  /** RELAY 专用池的目标（system managed `forward-<id>`）。 */
  pool_targets: { host: string; port: number }[];
}

export type DiagnoseOutcome =
  | { ok: true; report: DiagnoseReport }
  | { ok: false; status: 404 | 409 | 502; code: string; message: string; error_layer: "resource_scope" | "runtime_admission" };

/**
 * 跑一次诊断。调用方负责 RBAC 与资源作用域（路由层用 forward:read + scoped load），
 * 这里只负责「构造探针 → 逐段下发 → 汇总」。
 */
export async function diagnoseForward(
  forwardId: number,
  workspaceId: number,
  deps: DiagnoseDeps,
): Promise<DiagnoseOutcome> {
  const forward = await deps.loadForward(forwardId, workspaceId);
  if (!forward) {
    return { ok: false, status: 404, code: "not_found", message: "端口转发不存在", error_layer: "resource_scope" };
  }

  const plan = probeTargetsForForward(forward);
  if (!plan.ok) {
    return { ok: false, status: 409, code: plan.code, message: plan.message, error_layer: "runtime_admission" };
  }
  // The plan already refuses an over-limit pool; this is a second, cheap guard so
  // a future planner change cannot silently exceed the agent's own cap.
  if (plan.segments.some((seg) => seg.kind === "tcp_probe" && seg.targets.length > DIAGNOSE_MAX_TARGETS)) {
    return {
      ok: false, status: 409, code: "too_many_targets",
      message: `诊断目标超过上限（${DIAGNOSE_MAX_TARGETS}）`, error_layer: "runtime_admission",
    };
  }

  const now = deps.now ?? (() => new Date());
  const segments: DiagnoseSegment[] = [];

  for (const planned of plan.segments) {
    if (planned.kind === "node_facts") {
      segments.push(await factsSegment(planned, deps));
      continue;
    }

    const facts = await deps.loadCapability(planned.node_id);
    const decision = decideCapability(facts, "diagnose_tunnel");
    const segment: DiagnoseSegment = {
      segment: planned.segment,
      method: "tcp_probe",
      ...(planned.protocol ? { protocol: planned.protocol } : {}),
      verified: true,
      node_id: planned.node_id,
      node_key: planned.node_key,
      capability: { advertised: facts?.capabilities !== null && facts !== null, actions: facts?.capabilities ?? null },
      targets: planned.targets,
      results: [],
      outcome: "failed",
    };
    if (!decision.supported) {
      // Never queue a command the node has not told us it implements: the agent
      // would answer `unsupported_action` and the timeout would look like a
      // network fault (the whole reason WP11B negotiation exists).
      segment.outcome = "unsupported";
      segment.error_code = decision.reason;
      segment.message = decision.detail;
      segments.push(segment);
      continue;
    }

    const issued = await deps.issueDiagnose({
      nodeId: planned.node_id,
      nodeKey: planned.node_key,
      forwardId: forward.id,
      resourceId: planned.resource_id,
      targets: planned.targets,
      timeoutMs: DIAGNOSE_COMMAND_TIMEOUT_MS,
    });
    if (!issued.ok) {
      segment.outcome = "failed";
      segment.error_code = issued.error_code;
      segment.message = issued.error;
      segments.push(segment);
      continue;
    }
    // Completeness first: a probe answer that does not cover exactly the
    // requested targets must never be summarised as "everything is reachable".
    const completeness = checkResultCompleteness(planned.targets, issued.results);
    if (!completeness.ok) {
      segment.outcome = "failed";
      segment.error_code = completeness.code;
      segment.message = completeness.message;
      segment.results = (redact(issued.results) as DiagnoseProbeResult[]).slice(0, DIAGNOSE_MAX_TARGETS);
      segments.push(segment);
      continue;
    }
    // Redact defensively: a probe result should only ever carry host/port/status,
    // but the bundle that renders it must not depend on that staying true.
    segment.results = (redact(issued.results) as DiagnoseProbeResult[]).slice(0, DIAGNOSE_MAX_TARGETS);
    segment.outcome = summarizeSegment(segment.results);
    segments.push(segment);
  }

  return {
    ok: true,
    report: {
      forward_id: forward.id,
      mode: forward.mode,
      generated_at: now().toISOString(),
      segments,
      next_step: nextStepFor(segments, forward.mode),
    },
  };
}

/**
 * A probe answer must cover EXACTLY the requested targets.
 *
 * Otherwise "we could not probe target B" would be reported as "A is reachable,
 * therefore the path is fine" — the failure mode that makes a diagnostic worse
 * than no diagnostic. Duplicates and unknown hosts are refused for the same
 * reason: they mean the answer does not describe this request.
 */
export function checkResultCompleteness(
  requested: DiagnoseProbeTarget[],
  results: DiagnoseProbeResult[],
): { ok: true } | { ok: false; code: string; message: string } {
  if (results.length !== requested.length) {
    return {
      ok: false, code: "incomplete_result",
      message: `节点只返回了 ${results.length} 个结果，请求了 ${requested.length} 个目标`,
    };
  }
  const key = (t: { host: string; port: number }) => `${t.host.toLowerCase()}:${t.port}`;
  const seen = new Set<string>();
  for (const r of results) {
    const k = key({ host: String(r.host ?? ""), port: Number(r.port ?? 0) });
    if (seen.has(k)) return { ok: false, code: "duplicate_result", message: `结果里出现重复目标 ${k}` };
    seen.add(k);
  }
  for (const t of requested) {
    if (!seen.has(key(t))) {
      return { ok: false, code: "missing_result", message: `结果里缺少请求的目标 ${key(t)}` };
    }
  }
  return { ok: true };
}

/**
 * 入口↔出口一段：只核对两端上报的事实，**不拨业务监听端口**。
 *
 * 结论里永远不会出现"可达"：`ok` 只表示两端事实一致（运行时都在、revision 一致），
 * 而 `verified: false` 明确告诉读的人这一段没有做过连通性验证。
 */
async function factsSegment(
  planned: Extract<PlannedSegment, { kind: "node_facts" }>,
  deps: DiagnoseDeps,
): Promise<DiagnoseSegment> {
  const [ingress, egress] = await Promise.all([
    deps.loadNodeRuntimeFacts({ nodeId: planned.ingress_node_id, runtimeId: planned.ingress_runtime_id }),
    deps.loadNodeRuntimeFacts({ nodeId: planned.egress_node_id, runtimeId: planned.egress_runtime_id }),
  ]);
  const segment: DiagnoseSegment = {
    segment: planned.segment,
    method: "node_facts",
    verified: false,
    node_id: planned.ingress_node_id,
    node_key: planned.ingress_node_key,
    targets: [],
    results: [],
    facts: {
      hop: planned.hop,
      expected_revision: planned.expected_revision,
      ingress: { node_id: planned.ingress_node_id, ...ingress },
      egress: { node_id: planned.egress_node_id, ...egress },
    },
    outcome: "unknown",
  };

  if (!ingress.reported || !egress.reported) {
    segment.outcome = "unknown";
    segment.error_code = "facts_missing";
    segment.message = "两端尚未上报足够的状态事实，无法核对节点间链路；该段未做连通性验证";
    return segment;
  }
  if (!ingress.runtime_present || !egress.runtime_present) {
    segment.outcome = "failed";
    segment.error_code = "runtime_missing";
    segment.message = "至少一端的运行时不存在，节点间链路无法承载流量（该段未做连通性验证）";
    return segment;
  }
  const expected = planned.expected_revision;
  const behind = expected !== null && (ingress.runtime_revision !== expected || egress.runtime_revision !== expected);
  if (behind) {
    segment.outcome = "failed";
    segment.error_code = "revision_behind";
    segment.message = `两端运行时版本未收敛到 ${expected}（该段未做连通性验证）`;
    return segment;
  }
  segment.outcome = "ok";
  segment.message = "两端运行时事实一致；该段未做连通性验证（不探测业务监听端口）";
  return segment;
}

/** 一段的结论：全通 = ok；有 refused/timeout/dns = unreachable；其余 = failed。 */
export function summarizeSegment(results: DiagnoseProbeResult[]): DiagnoseSegment["outcome"] {
  if (results.length === 0) return "failed";
  if (results.every((r) => r.status === "reachable")) return "ok";
  if (results.some((r) => r.status === "refused" || r.status === "timeout" || r.status === "dns_error")) {
    return "unreachable";
  }
  return "failed";
}

/**
 * 「错误 → 下一步」。文案必须回答"用户现在能做什么"，而不是复述状态码。
 */
export function nextStepFor(segments: DiagnoseSegment[], mode: "direct" | "relay"): string | null {
  const unsupported = segments.find((s) => s.outcome === "unsupported");
  if (unsupported) {
    // A facts-only segment still works on an old agent (it needs no command), so
    // the message must not claim the whole diagnosis was impossible.
    const others = segments.filter((s) => s !== unsupported);
    const hadFacts = others.some((s) => s.method === "node_facts" && s.outcome !== "unsupported");
    return hadFacts
      ? "该节点尚未升级到支持诊断的 Agent 版本：本次只核对了节点上报的事实，未做连通性验证。"
      : "该节点尚未升级到支持诊断的 Agent 版本，请先升级节点后再试。";
  }
  const factsMissing = segments.find((s) => s.method === "node_facts" && s.outcome === "unknown");
  if (factsMissing) {
    return "两端状态事实不足（至少一个节点尚未上报），节点间链路未验证；请先确认两个节点都在线。";
  }
  const failed = segments.find((s) => s.outcome === "failed");
  if (failed) {
    if (failed.error_code === "runtime_missing") {
      // Which side is missing comes from the facts, not from the segment name:
      // the ingress↔egress facts segment covers both ends.
      const egressMissing = failed.facts ? !failed.facts.egress.runtime_present : failed.segment === "egress_to_target";
      return egressMissing
        ? "出口节点上没有这条转发的运行时：请检查出口节点是否在线、配置是否已下发。"
        : "入口节点上没有这条转发的运行时：请检查入口节点是否在线、配置是否已下发。";
    }
    if (failed.error_code === "revision_behind") {
      return "两端运行时版本还没收敛：这是下发中或节点落后，稍后重试即可。";
    }
    if (failed.error_code === "incomplete_result" || failed.error_code === "missing_result") {
      return "节点返回的诊断结果不完整，未采信：请稍后重试；若持续出现请提交支持包。";
    }
    return "节点未能在规定时间内返回诊断结果，请确认节点在线后重试。";
  }

  const dns = segments.find((s) => s.results.some((r) => r.status === "dns_error"));
  if (dns) return "目标域名在该节点上无法解析；请改用可解析的地址或检查节点 DNS。";
  const refused = segments.find((s) => s.results.some((r) => r.status === "refused"));
  if (refused) return "目标端口拒绝连接：请确认目标服务在监听，且没有被防火墙拒绝。";
  const timedOut = segments.find((s) => s.results.some((r) => r.status === "timeout"));
  if (timedOut) return "目标无响应（连接超时）：请检查目标主机是否放行该端口。";

  const unverified = segments.find((s) => s.outcome === "unknown");
  if (unverified) {
    return "目标侧已确认可达，但节点之间的那一段没有做连通性验证（不会探测业务端口）：如整体仍不通，请检查出口节点在线状态与节点间放行。";
  }
  if (segments.every((s) => s.outcome === "ok" && s.verified)) {
    return mode === "relay"
      ? "出口节点到目标的 TCP 可达；节点间那一段未做连通性验证，若业务仍不通请从两端节点日志继续排查。"
      : "入口节点到目标的 TCP 可达；若业务仍不通，请检查目标服务本身。";
  }
  if (segments.every((s) => s.outcome === "ok")) {
    return "本次诊断未发现不一致；其中未验证的段不能当作已确认可达。";
  }
  return null;
}

/* ================================================================== */
/* 生产接线（懒加载：测试与 worker import 期都不连库/Redis）              */
/* ================================================================== */

/**
 * 生产依赖。全部懒加载，理由与 reconciler/rollout 一致：worker 在 import 期就
 * 加载服务模块，任何顶层 `db`/`redis` 引用都会让单测强制建连接。
 */
export function defaultDiagnoseDeps(): DiagnoseDeps {
  return {
    async loadForward(forwardId, workspaceId) {
      const { db } = await import("../db.ts");
      const row = await db.tunnel.findFirst({
        where: { id: forwardId, workspace_id: workspaceId, category: "port_forward" },
        include: {
          ingress_node: { select: { id: true, node_id: true, connect_ip: true } },
          egress_node: { select: { id: true, node_id: true, connect_ip: true } },
          // V5.4：中间跳也是**一跳**，诊断必须能点名它，否则三跳下只能得到
          // "这条转发有问题"，而 G4 明确要求遥测能定位失败跳。
          middle_node: { select: { id: true, node_id: true, connect_ip: true } },
          egress_pool: { select: { name: true, targets: { select: { host: true, port: true } } } },
        },
      });
      if (!row) return null;
      // 中间跳的端口：与 `allocateTunnelPort({direction: "egress", nodeId: middle})` 同一个键，
      // 因此这里按 (node, tunnel, active) 查一次即可 —— 不在 tunnel 行上再放一列，
      // 因为"哪个节点上哪个端口"的事实本来就属于租约表。
      const middlePort =
        row.middle_node == null
          ? null
          : ((await db.nodePortLease.findFirst({
              // 租约表**没有** `direction` 列（方向由节点在拓扑里的角色决定，不重复存储）——
              // 键就是 (node, tunnel, active)。我第一版加了 direction，Prisma 直接拒绝，
              // 而路由层把它变成了 500：**查询形状的错误会以 500 的形式出现**，
              // 所以失败时先看服务端日志，不要从客户端状态码猜原因。
              where: { tunnel_id: row.id, node_id: row.middle_node.id, status: "active" },
              orderBy: { id: "desc" },
              select: { port: true },
            })) as { port: number } | null)?.port ?? null;
      return {
        id: row.id,
        protocol: persistedForwardProtocol(row.forward_protocol, row.tunnel_type),
        federated_egress_peer: row.federated_egress_peer,
        tls_cert_path: row.tls_cert_path, tls_key_path: row.tls_key_path, link_source_config: row.link_source_config,
        mode: (row.tunnel_mode ?? "direct") as "direct" | "relay",
        ingress_node_id: row.ingress_node?.id ?? null,
        ingress_node_key: row.ingress_node?.node_id ?? String(row.ingress_node_id ?? ""),
        ingress_connect_ip: row.ingress_node?.connect_ip ?? null,
        egress_node_id: row.egress_node?.id ?? null,
        egress_node_key: row.egress_node?.node_id ?? null,
        egress_connect_ip: row.egress_node?.connect_ip ?? null,
        egress_port: row.egress_port ?? null,
        // 中间跳的事实（三跳才有）。它的监听端口用 `egress_port` 这一列承载不了 ——
        // 中间跳的端口来自它自己的 `node_port_lease`（`direction=egress`，节点是中间跳），
        // 因此这里按同一个键取：该 (node, tunnel) 上 active 的 egress 租约。
        middle_node_id: row.middle_node?.id ?? null,
        middle_node_key: row.middle_node?.node_id ?? null,
        middle_connect_ip: row.middle_node?.connect_ip ?? null,
        // 中间跳的监听端口不在 tunnel 行上（那一列的语义是"出口的内部端口"）：它来自
        // 中间跳自己的端口租约 `(node_id=middle, tunnel_id=row, direction=egress, active)`。
        middle_port: middlePort,
        remote_host: row.remote_host ?? null,
        remote_port: row.remote_port ?? null,
        config_revision: row.config_revision ?? null,
        // Only the forward's own dedicated pool counts: a shared pool would make
        // the probe describe somebody else's targets.
        pool_targets: row.egress_pool?.name === `forward-${row.id}` ? (row.egress_pool.targets ?? []) : [],
      };
    },

    async loadCapability(nodeId) {
      const { db } = await import("../db.ts");
      const row = await db.nodeStateReport.findUnique({
        where: { node_id: nodeId },
        select: {
          control_protocol_version: true,
          capabilities: true,
          reported_at: true,
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

    async loadNodeRuntimeFacts(input) {
      const { db } = await import("../db.ts");
      const row = await db.nodeStateReport.findUnique({
        where: { node_id: input.nodeId },
        select: { reported_at: true, tunnels: true, used_ports: true, reported_revision: true },
      });
      if (!row) {
        return { reported: false, runtime_present: false, runtime_revision: null, listener_port: null };
      }
      // Facts come from the node's own report; nothing here dials anything.
      const tunnels = Array.isArray(row.tunnels) ? (row.tunnels as Record<string, unknown>[]) : [];
      const match = tunnels.find((t) => String(t?.id ?? "") === input.runtimeId) ?? null;
      const asPort = (value: unknown): number | null =>
        typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
      return {
        reported: true,
        runtime_present: match !== null,
        runtime_revision: match && Number.isInteger(match.revision) ? Number(match.revision) : null,
        listener_port: match ? asPort(match.ingress_port) ?? asPort(match.egress_port) : null,
      };
    },

    async issueDiagnose(input) {
      const { issueAgentDiagnose } = await import("./agent-command-bus.ts");
      return issueAgentDiagnose({
        nodeId: input.nodeId,
        resourceId: input.resourceId,
        targets: input.targets,
        timeoutMs: input.timeoutMs,
      });
    },
  };
}
