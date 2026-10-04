/**
 * V4-WP11C — 诊断探针计划（纯函数，无 IO）。
 *
 * 这个模块的**全部职责**是把一条 Forward 的已授权期望状态翻译成诊断计划。
 * 它存在的理由有两个，都不是"方便"，而是边界：
 *
 * 1. **不要把用户输入当成探测目标**。诊断端点如果接受 host/port 参数，它就变成了
 *    "用别人的机器扫我的内网"的 SSRF 工具——节点在客户机房，能到达面板本身到不了
 *    的地址。目标只能来自 desired state。
 *
 * 2. **不要拨业务监听端口**。入口→出口那一段的真实地址是**出口节点的业务 EGRESS
 *    listener**：拨它会触发一次真实业务连接（Agent 会 accept、选目标、建上游、计入
 *    业务连接与 Stats）。那已经不是"诊断"，而是"替用户发了一次业务流量"，还会污染
 *    计费与连接额度事实。因此这一段**不做 TCP 探测**，只核对两端 Agent 上报的运行态
 *    事实，并明确标注"未经连通性验证"。
 *
 * 分段与验证方式：
 *   DIRECT：入口节点 → 目标           （TCP 直探目标；不经过任何业务监听端口）
 *   RELAY ：入口 ←→ 出口              （仅节点事实核对，verified=false）
 *           出口节点 → 目标池目标      （TCP 直探目标；同样不经过业务监听端口）
 *
 * 刻意**不**从入口节点直连目标来"模拟"整条 RELAY：那样探测的是面板的一个假设，
 * 不是这条转发真实的路径。
 */

import type { ForwardForDiagnose } from "./agent-diagnose.ts";

/** 与 Agent 侧上限一致。 */
export const PROBE_MAX_TARGETS_PER_SEGMENT = 8;

export interface DiagnoseProbeTarget {
  host: string;
  port: number;
}

export type SegmentName =
  | "ingress_to_target"
  | "ingress_to_egress"
  // V5.4：三跳路由的两段（入口→中间、中间→出口）。
  | "ingress_to_middle"
  | "middle_to_egress"
  | "egress_to_target";

/** 真正发出去的 TCP 探测（只针对目标，不针对任何业务监听端口）。 */
export interface TcpProbeSegment {
  kind: "tcp_probe";
  segment: SegmentName;
  node_id: number;
  node_key: string;
  targets: DiagnoseProbeTarget[];
  /** 下发命令的 resource_id（与运行时 id 约定一致，便于排障对齐）。 */
  resource_id: string;
}

/**
 * 只核对事实、不发探测的一段。
 *
 * `expected_runtime_ids` 是我们要在两端状态上报里找的运行时 id；`hop` 是配置里的
 * 下一跳地址，**仅用于展示**（它指向业务监听端口，拨它就会产生业务连接）。
 */
export interface NodeFactsSegment {
  kind: "node_facts";
  segment: "ingress_to_egress" | "ingress_to_middle" | "middle_to_egress";
  ingress_node_id: number;
  ingress_node_key: string;
  egress_node_id: number;
  egress_node_key: string;
  ingress_runtime_id: string;
  egress_runtime_id: string;
  /** 展示用：出口节点的内部地址与端口（不探测）。 */
  hop: { host: string; port: number } | null;
  /** 期望两端都收敛到的 revision。 */
  expected_revision: number | null;
}

export type PlannedSegment = TcpProbeSegment | NodeFactsSegment;

export type ProbePlan =
  | { ok: true; segments: PlannedSegment[] }
  | { ok: false; code: string; message: string };

function usablePort(port: number | null | undefined): port is number {
  return typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535;
}

function usableHost(host: string | null | undefined): host is string {
  return typeof host === "string" && host.trim() !== "";
}

/** 运行时 id 约定。 */
export function runtimeIdFor(forwardId: number, mode: "direct" | "relay", role: "ingress" | "egress" = "ingress"): string {
  if (mode === "direct") return `tunex-${forwardId}-direct`;
  return role === "egress" ? `tunex-${forwardId}-egress` : `tunex-${forwardId}-relay`;
}

/**
 * 把一条 Forward 折算成诊断计划。
 *
 * 缺关键事实时返回 `ok: false` 并给出**可行动**的原因，而不是发一个注定无意义的
 * 探测（例如对没有出口端口的 RELAY 探 next-hop）。
 */
export function probeTargetsForForward(forward: ForwardForDiagnose): ProbePlan {
  if (!forward.ingress_node_id) {
    return { ok: false, code: "no_ingress_node", message: "该转发还没有入口节点，无法诊断" };
  }
  const ingressNodeKey = forward.ingress_node_key || String(forward.ingress_node_id);

  if (forward.mode === "direct") {
    if (!usableHost(forward.remote_host) || !usablePort(forward.remote_port)) {
      return { ok: false, code: "no_target", message: "该转发还没有完整的目标地址，无法诊断" };
    }
    return {
      ok: true,
      segments: [{
        kind: "tcp_probe",
        segment: "ingress_to_target",
        node_id: forward.ingress_node_id,
        node_key: ingressNodeKey,
        targets: [{ host: forward.remote_host.trim(), port: forward.remote_port }],
        resource_id: runtimeIdFor(forward.id, "direct"),
      }],
    };
  }

  // RELAY：出口节点的目标池是唯一可以安全直探的对象。
  if (!forward.egress_node_id) {
    return {
      ok: false, code: "no_egress_runtime",
      message: "该中继转发还没有出口节点，无法诊断",
    };
  }
  if (forward.pool_targets.length === 0) {
    return { ok: false, code: "no_pool_targets", message: "该中继转发的出口目标池为空，无法诊断出口段" };
  }

  const validTargets = forward.pool_targets.filter((t) => usableHost(t.host) && usablePort(t.port));
  if (validTargets.length === 0) {
    return { ok: false, code: "no_pool_targets", message: "该中继转发的出口目标池没有有效目标，无法诊断出口段" };
  }
  // Over-limit is REFUSED, never silently truncated: dropping targets would
  // report "all reachable" for a pool that was only partly probed.
  if (validTargets.length > PROBE_MAX_TARGETS_PER_SEGMENT) {
    return {
      ok: false, code: "too_many_targets",
      message: `出口目标池有 ${validTargets.length} 个有效目标，超过单次诊断上限 ${PROBE_MAX_TARGETS_PER_SEGMENT}；请拆分后再诊断`,
    };
  }

  const hop = usableHost(forward.egress_connect_ip) && usablePort(forward.egress_port)
    ? { host: forward.egress_connect_ip.trim(), port: forward.egress_port }
    : null;

  // V5.4：三跳时"入口↔出口"被拆成**两段**，每段各自点名它两端的节点与期望 runtime。
  // 这正是"遥测能定位失败跳"的实现方式：失败的那一段就是失败的那一跳。
  const middleNodeId = forward.middle_node_id ?? null;
  const middleKey = middleNodeId == null ? null : forward.middle_node_key || String(middleNodeId);
  const middleHop =
    middleNodeId != null && usableHost(forward.middle_connect_ip) && usablePort(forward.middle_port)
      ? { host: (forward.middle_connect_ip as string).trim(), port: forward.middle_port as number }
      : null;
  const factsSegments: NodeFactsSegment[] =
    middleNodeId != null && middleKey != null
      ? [
          {
            kind: "node_facts",
            segment: "ingress_to_middle",
            ingress_node_id: forward.ingress_node_id,
            ingress_node_key: ingressNodeKey,
            egress_node_id: middleNodeId,
            egress_node_key: middleKey,
            ingress_runtime_id: runtimeIdFor(forward.id, "relay", "ingress"),
            // 中间跳的 runtime 与出口同形（runtime id 按节点分命名空间）。
            egress_runtime_id: runtimeIdFor(forward.id, "relay", "egress"),
            hop: middleHop,
            expected_revision: forward.config_revision ?? null,
          },
          {
            kind: "node_facts",
            segment: "middle_to_egress",
            ingress_node_id: middleNodeId,
            ingress_node_key: middleKey,
            egress_node_id: forward.egress_node_id,
            egress_node_key: forward.egress_node_key || String(forward.egress_node_id),
            ingress_runtime_id: runtimeIdFor(forward.id, "relay", "egress"),
            egress_runtime_id: runtimeIdFor(forward.id, "relay", "egress"),
            hop,
            expected_revision: forward.config_revision ?? null,
          },
        ]
      : [
          {
            kind: "node_facts",
            segment: "ingress_to_egress",
            ingress_node_id: forward.ingress_node_id,
            ingress_node_key: ingressNodeKey,
            egress_node_id: forward.egress_node_id,
            egress_node_key: forward.egress_node_key || String(forward.egress_node_id),
            ingress_runtime_id: runtimeIdFor(forward.id, "relay", "ingress"),
            egress_runtime_id: runtimeIdFor(forward.id, "relay", "egress"),
            hop,
            expected_revision: forward.config_revision ?? null,
          },
        ];

  return {
    ok: true,
    segments: [
      ...factsSegments,
      {
        kind: "tcp_probe",
        segment: "egress_to_target",
        node_id: forward.egress_node_id,
        node_key: forward.egress_node_key || String(forward.egress_node_id),
        targets: validTargets.map((t) => ({ host: t.host.trim(), port: t.port })),
        resource_id: runtimeIdFor(forward.id, "relay", "egress"),
      },
    ],
  };
}

/** 计划里真正会发 TCP 探测的段（供调用方与测试断言"没有别的地址被拨"）。 */
export function dialedTargets(plan: ProbePlan): { host: string; port: number }[] {
  if (!plan.ok) return [];
  return plan.segments.flatMap((s) => (s.kind === "tcp_probe" ? s.targets : []));
}
