/**
 * V5-WP1 —— Runtime admission（能力协商的**唯一**判定入口）。
 *
 * §13.5 的第 5 层：命令入队前的最后一道条件。三个正交维度必须**同时**成立，
 * 命令才可以被放进队列：
 *
 *   action      该节点实现了这个动作             ← V4 WP11B（agent-capability.ts）
 *   protocol    该节点实现了这个产品协议          ← V5 WP1（capability-manifest.ts）
 *   transport   该节点实现了这个传输契约          ← V5 WP1
 *
 * 为什么要有这个模块，而不是让两个调用点各自拼一遍：
 * 「先查动作、再查协议、再查传输」的顺序、以及**哪一个节点**（DIRECT 的入口 /
 * RELAY 的进出口两端）必须满足，是编排知识。让 scheduler 和 command bus 各写
 * 一遍，迟早出现「调度器查了两端、下发只查了一端」这种半开的口子，而它正好
 * 只在 RELAY 失败路径上暴露。
 *
 * 这里返回**结构化原因**，调用方负责翻译成各自的错误码空间：scheduler 落
 * `Tunnel.apply_error_code`，command bus 抛 `AgentTransportError`。判定本身
 * 只有一处实现。
 */

import {
  capabilityErrorBody,
  decideCapability,
  type AgentCapabilityFacts,
  type CapabilityDecision,
} from "./agent-capability.ts";
import {
  decideProtocolCapability,
  decideTransportCapability,
  type AgentV2CapabilityFacts,
  type ManifestDecision,
  type ManifestRejectionReason,
} from "./capability-manifest.ts";
import {
  FORWARD_PROTOCOL_SPECS,
  buildForwardRuntimePlan,
  normalizeForwardProtocol,
  type ForwardProtocol,
  type ForwardTransport,
} from "./forward-contract.ts";

/* ================================================================== */
/* 形状                                                                */
/* ================================================================== */

/** 一次下发的三个正交维度。`protocol` 已通过 WP0 白名单。 */
export interface RuntimeAdmissionRequest {
  action: string;
  protocol: unknown;
}

/**
 * 参与本次下发的节点。`role` 只用于**错误文案**（说清楚是入口还是出口不满足），
 * 不参与判定——判定规则对所有节点一致。
 */
export interface RuntimeAdmissionNode {
  nodeId: number;
  role: "ingress" | "egress";
  facts: AgentV2CapabilityFacts | null;
}

export type RuntimeAdmissionReason = ManifestRejectionReason;

export interface RuntimeAdmissionDenied {
  ok: false;
  node_id: number;
  node_role: RuntimeAdmissionNode["role"];
  layer: "action" | "protocol" | "transport";
  reason: RuntimeAdmissionReason;
  error_layer: "runtime_admission";
  detail: string;
  /** 直接可用的 HTTP 错误体（路由层不必再拼一次）。 */
  body: {
    error: string;
    code: string;
    error_layer: "runtime_admission";
    condition: string;
  };
}

export type RuntimeAdmissionResult = { ok: true } | RuntimeAdmissionDenied;

/* ================================================================== */
/* 纯判定                                                              */
/* ================================================================== */

/**
 * 只判**动作**维度（诊断 / 节点级命令没有协议维度）。
 *
 * 单独留一个入口而不是让 `protocol` 变成可选参数：`{ action, protocol? }` 里
 * 忘传协议就会静默跳过协议与传输两个维度，而那种漏判只在 RELAY 的失败路径上
 * 暴露。签名里没有这个参数，就没有「忘了传」这种失败模式。
 */
export function admitAction(node: RuntimeAdmissionNode, action: string): RuntimeAdmissionResult {
  const decision = decideCapability(actionFactsOf(node.facts), action);
  if (decision.supported) return { ok: true };
  return deny(node, "action", decision.reason, decision.detail, capabilityErrorBody(decision));
}

/**
 * 某个节点是否满足本次下发的全部条件。
 *
 * 三个维度的判定顺序固定为 action → protocol → transport：动作是最常见的拒绝
 * 原因（旧 Agent 还没有新动作），先判它能让绝大多数拒绝落在最可行动的文案上。
 */
export function admitOnNode(
  node: RuntimeAdmissionNode,
  request: RuntimeAdmissionRequest,
): RuntimeAdmissionResult {
  const actionResult = admitAction(node, request.action);
  if (!actionResult.ok) return actionResult;

  const protocol = normalizeForwardProtocol(request.protocol);
  if (protocol === null) {
    // 走到这里说明调用方跳过了 WP0 的白名单准入。仍然拒绝，且**不**回退成 TCP：
    // 「未知协议当 TCP 处理」正是 WP0 要消灭的那种静默降级。
    return deny(
      node,
      "protocol",
      "protocol_not_supported",
      `协议 ${String(request.protocol)} 尚未进入当前 runtime 白名单`,
      null,
    );
  }

  const protocolDecision = decideProtocolCapability(node.facts, protocol);
  if (!protocolDecision.supported) {
    return deny(node, "protocol", protocolDecision.reason, protocolDecision.detail, null);
  }

  const transport = forwardTransportFor(protocol);
  const transportDecision = decideTransportCapability(node.facts, transport);
  if (!transportDecision.supported) {
    return deny(node, "transport", transportDecision.reason, transportDecision.detail, null);
  }

  return { ok: true };
}

/**
 * 一次下发的**全部**参与节点都必须满足（DIRECT：只传入口；RELAY：入口 + 出口）。
 *
 * 全量检查后再返回失败，是有意的：RELAY 若只先查出口，入口不满足时命令已经
 * 进了出口节点的队列，就要走补偿路径撤一个本不该存在的 runtime。先查完两端，
 * 端口租约都还没产生，失败是干净的。
 */
export function admitRuntime(
  nodes: readonly RuntimeAdmissionNode[],
  request: RuntimeAdmissionRequest,
): RuntimeAdmissionResult {
  if (nodes.length === 0) {
    return {
      ok: false,
      node_id: 0,
      node_role: "ingress",
      layer: "action",
      reason: "incompatible_agent",
      error_layer: "runtime_admission",
      detail: "runtime admission 需要至少一个节点",
      body: {
        error: "runtime admission 需要至少一个节点",
        code: "incompatible_agent",
        error_layer: "runtime_admission",
        condition: "incompatible_agent",
      },
    };
  }
  const decisions = nodes.map((node) => ({ node, result: admitOnNode(node, request) }));
  const firstFailure = decisions.find((d) => !d.result.ok);
  return firstFailure ? firstFailure.result : { ok: true };
}

/** 本次下发使用的传输契约（由协议派生，不是第二个用户字段）。 */
export function forwardTransportFor(protocol: ForwardProtocol): ForwardTransport {
  return buildForwardRuntimePlan("direct", protocol).transport.name;
}

function deny(
  node: RuntimeAdmissionNode,
  layer: RuntimeAdmissionDenied["layer"],
  reason: RuntimeAdmissionReason,
  detail: string,
  body: RuntimeAdmissionDenied["body"] | null,
): RuntimeAdmissionDenied {
  const roleLabel = node.role === "ingress" ? "入口" : "出口";
  const text = `${roleLabel}节点 ${node.nodeId}：${detail}`;
  return {
    ok: false,
    node_id: node.nodeId,
    node_role: node.role,
    layer,
    reason,
    error_layer: "runtime_admission",
    detail: text,
    body: body
      ? { ...body, error: text }
      : {
          error: text,
          code: reason,
          error_layer: "runtime_admission",
          condition: reason,
        },
  };
}

/**
 * V4 动作事实投影。
 *
 * `capabilitiesMalformed` → 传一个空数组：V4 的 {@link decideCapability} 对
 * 「字段存在但不含该动作」的语义正是 fail-closed（baseline 变
 * `incompatible_agent`，其余变 `upgrade_required`），所以这里不需要第二套规则。
 * 传 `null` 会得到 baseline 放行——那才是错的方向。
 */
function actionFactsOf(facts: AgentV2CapabilityFacts | null): AgentCapabilityFacts | null {
  if (!facts) return null;
  if (facts.capabilitiesMalformed) {
    return { capabilities: [], protocolVersion: facts.protocolVersion };
  }
  return { capabilities: facts.capabilities, protocolVersion: facts.protocolVersion };
}

/* ================================================================== */
/* 判定结果的展示                                                       */
/* ================================================================== */

/** 判定维度 → 面板可展示的中文名（前端分流用）。 */
export function admissionLayerLabel(layer: RuntimeAdmissionDenied["layer"]): string {
  switch (layer) {
    case "action":
      return "动作能力";
    case "protocol":
      return "协议能力";
    case "transport":
      return "传输能力";
  }
}

/**
 * 排障用的原因前缀。
 *
 * 判定层只产出 `layer` + `reason`；把它翻成**编排层**的错误码是调用方的事
 * （scheduler 的 `apply_error_code`、路由的 HTTP body），因为错误码词汇表属于
 * 那一层。让判定模块导出 scheduler 的枚举名会让两个模块互相知道对方的词表。
 */
export function admissionFailureDetail(denied: RuntimeAdmissionDenied): string {
  return `[runtime_admission:${denied.reason}:${denied.layer}] ${denied.detail}`;
}

/* ================================================================== */
/* 读库（可注入，便于离线测试）                                          */
/* ================================================================== */

/** 一台节点的协商事实读取器。 */
export type CapabilityFactsLoader = (nodeId: number) => Promise<AgentV2CapabilityFacts | null>;

/** 单次下发要检查的节点 id + 角色。 */
export interface AdmissionTarget {
  nodeId: number;
  role: RuntimeAdmissionNode["role"];
}

/**
 * 生产实现：读 `node_state_report`。
 *
 * 与 WP11B 同样**懒加载**：本模块被 worker 引用，顶层 import Prisma 会在单测里
 * 建立连接。读失败按「无事实」处理（baseline 动作仍可下发），但**坏形状的库值
 * 不在此处吞掉**——`capabilityFactsFromStoredV2` 把它记成 flag，判定会 fail-closed。
 */
export async function loadNodeCapabilityFacts(nodeId: number): Promise<AgentV2CapabilityFacts | null> {
  const { db } = await import("../db.ts");
  const row = await db.nodeStateReport.findUnique({
    where: { node_id: nodeId },
    select: {
      control_protocol_version: true,
      capabilities: true,
      capability_manifest: true,
      reported_at: true,
      // 重装保留 node_id 与 agent_id，所以陈旧行可能描述一个已经不存在的进程。
      node: { select: { credential_rotated_at: true } },
    },
  });
  if (!row) return null;
  const { capabilityFactsFromStoredV2 } = await import("./capability-manifest.ts");
  return capabilityFactsFromStoredV2({
    control_protocol_version: row.control_protocol_version,
    capabilities: row.capabilities,
    capability_manifest: row.capability_manifest,
    reported_at: row.reported_at,
    credential_rotated_at: row.node?.credential_rotated_at ?? null,
  });
}

/**
 * 读一批节点的协商事实，然后做一次完整判定。
 *
 * 读不到事实（无行 / 陈旧 / 查询失败）→ 交给判定函数按 baseline 处理，
 * **不是**在这里提前拒绝：那会把一次数据库抖动变成一次全网停摆。
 */
export async function admitRuntimeFromStore(
  targets: readonly AdmissionTarget[],
  request: RuntimeAdmissionRequest,
  load: CapabilityFactsLoader = loadNodeCapabilityFacts,
): Promise<RuntimeAdmissionResult> {
  const nodes: RuntimeAdmissionNode[] = [];
  for (const target of targets) {
    let facts: AgentV2CapabilityFacts | null = null;
    try {
      facts = await load(target.nodeId);
    } catch {
      facts = null;
    }
    nodes.push({ nodeId: target.nodeId, role: target.role, facts });
  }
  return admitRuntime(nodes, request);
}

/** 供测试与调用方使用的类型出口（保持 services 层「只导出纯函数/服务函数」纪律）。 */
export type { CapabilityDecision, ManifestDecision, AgentV2CapabilityFacts };
