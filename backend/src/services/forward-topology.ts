/**
 * V5-WP19-C —— 链路拓扑与逐跳明细（**只读投影**）。
 *
 * 契约的硬约束（§5 WP19-C 行）：**复用 route plan / 三跳段与 diag 逐跳结果；不新建拓扑真相**。
 * 这一条不是风格要求，而是这个仓库反复付学费的地方：一旦出现第二份拓扑真相，它就会和第一份
 * 漂移，而"两处各自都对、只是不同"是最难查的一类故障（同样的话写在 `forward-contract.ts`
 * 关于 `hop_peer` 的注释里）。
 *
 * 所以本模块只做两件事：
 *
 *   ① **段结构**直接取自 `probeTargetsForForward()` 的 `node_facts` 段 —— 它本来就是
 *      "入口↔出口被拆成两段，每段点名它两端的节点与期望 runtime"，也就是"失败的那一段就是
 *      失败的那一跳"这条能力的实现；这里不再算一遍。
 *   ② **活事实**从每个节点**自己的上报**里按 runtime id 取（`diagOfTunnel`）——
 *      "面板说 active" 与 "节点真的在跑那条 runtime" 是两件事，本视图把后者摆在明面上：
 *      `running` 就是"这条 runtime 出现在该节点最近一次上报里吗"。
 *
 * ── 明确的边界 ──
 * 本模块**不探测**（那是 diag / Looking Glass 的事）、**不读 DNS**、**不聚合延迟**
 * （延迟序列是 WP19-B）。它只是把"现在的拓扑长什么样、每一跳各自在报什么"如实拼出来。
 */
import { probeTargetsForForward, type NodeFactsSegment } from "./forward-probe-plan.ts";
import type { ForwardForDiagnose } from "./agent-diagnose.ts";
import type { Prisma } from "@prisma/client";
import { diagOfTunnel, type TunnelProtocolDiag } from "./tunnel-diag.ts";

/** 一个节点最近一次上报里与本视图有关的部分。 */
export interface TopologyNodeReport {
  /** 该节点上报的 `tunnels`（原始 JSON；解析与有界化交给 `diagOfTunnel`）。 */
  readonly tunnels: unknown;
  /** 该上报的时刻（ISO 字符串）；`null` = 该节点从未上报过。 */
  readonly reported_at: string | null;
}

/** 一跳的一端（某节点上的某条 runtime）。 */
export interface TopologyEndpoint {
  readonly node_id: number;
  readonly node_key: string;
  readonly runtime_id: string;
  /**
   * 该 runtime 是否出现在该节点**最近一次上报**里。
   *
   * 这是本视图最有用的一列：隧道 `apply_status=active` 只说明面板收到了 ACK，
   * 而"节点此刻是否真的在跑这条 runtime"只有节点自己的上报能回答 —— 两者不一致正是
   * "面板全绿、数据面不通"的典型形态。
   */
  readonly running: boolean;
  /** 上报里那条 runtime 的 revision；没上报时为 `null`。 */
  readonly revision: number | null;
  /** 该 runtime 的协议事实（有界化的类型化视图；没有则 `null`）。 */
  readonly diag: TunnelProtocolDiag | null;
}

export interface TopologySegment {
  /** 段名与 `NodeFactsSegment` 同一套词表（不新造）。 */
  readonly segment: NodeFactsSegment["segment"];
  readonly from: TopologyEndpoint;
  readonly to: TopologyEndpoint;
  /** 该段的下一跳地址（展示用；本视图不探测）。 */
  readonly hop: { readonly host: string; readonly port: number } | null;
  /** 两端都应收敛到的 revision（desired）。 */
  readonly expected_revision: number | null;
}

export interface ForwardTopology {
  readonly forward_id: number;
  readonly mode: "direct" | "relay";
  readonly segments: readonly TopologySegment[];
  /**
   * 观测新鲜度：参与本拓扑的节点里**最新**的一条上报时刻（ISO）；`null` = 全都从未上报。
   * 它回答的是"这份视图有多新鲜"，而不是"拓扑是什么"。
   */
  readonly observed_at: string | null;
  /**
   * 有过上报、但**最近一次上报里缺少**至少一端 runtime 的段数。
   *
   * 单独给出来是为了让"面板说在跑、节点自己没这么说"变成**可断言的数字**，
   * 而不是让人从一长串 `running: false` 里去数。
   */
  readonly stale_segments: number;
}

export type ForwardTopologyResult =
  | { readonly ok: true; readonly topology: ForwardTopology }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** 上报里那一条 runtime 的最小形状（`tunnels` 是原始 JSON，所以这里只取需要的两列）。 */
function runtimeEntry(tunnels: unknown, runtimeId: string): { revision: number | null; diag: TunnelProtocolDiag | null } {
  const diag = diagOfTunnel(tunnels, runtimeId);
  if (!Array.isArray(tunnels)) return { revision: null, diag };
  for (const entry of tunnels) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as { id?: unknown; revision?: unknown };
    if (String(row.id ?? "") !== runtimeId) continue;
    return { revision: typeof row.revision === "number" ? row.revision : null, diag };
  }
  return { revision: null, diag };
}

function endpoint(
  reports: Readonly<Record<number, TopologyNodeReport>>,
  nodeId: number,
  nodeKey: string,
  runtimeId: string,
): TopologyEndpoint {
  const report = reports[nodeId];
  // 没有上报（或该节点从未上报）⇒ `running: false` 且 `diag: null`，**不是**"它不健康"。
  // 这两种状态在本视图里必须可区分：`reported_at === null` 是"从没说过话"，
  // `reported_at` 有值而 `running === false` 是"最近一次上报里没有它"。
  if (!report) {
    return { node_id: nodeId, node_key: nodeKey, runtime_id: runtimeId, running: false, revision: null, diag: null };
  }
  const found = runtimeEntry(report.tunnels, runtimeId);
  const running = Array.isArray(report.tunnels)
    ? report.tunnels.some((e) => !!e && typeof e === "object" && String((e as { id?: unknown }).id ?? "") === runtimeId)
    : false;
  return {
    node_id: nodeId,
    node_key: nodeKey,
    runtime_id: runtimeId,
    running,
    revision: found.revision,
    diag: found.diag,
  };
}

/**
 * 组装只读拓扑视图。
 *
 * 段结构来自 `probeTargetsForForward()`（唯一真相源）；本函数**不做任何**"再算一遍拓扑"的事。
 * `forward` 的形状就是诊断路径已经在用的那个（`ForwardForDiagnose`），所以路由层可以复用
 * 既有的 `loadForward` 依赖，不需要为这个视图再写一条查询。
 */
export function projectForwardTopology(input: {
  readonly forward: ForwardForDiagnose;
  readonly reports: Readonly<Record<number, TopologyNodeReport>>;
}): ForwardTopologyResult {
  const plan = probeTargetsForForward(input.forward);
  if (!plan.ok) {
    // 计划本身不成立（比如缺入口连接地址）⇒ 如实转述，不编一个"空拓扑"。
    return { ok: false, code: plan.code, message: plan.message };
  }

  const segments = plan.segments.filter((s): s is NodeFactsSegment => s.kind === "node_facts");
  if (segments.length === 0) {
    // DIRECT 没有节点间段：这是**正常**的（它的链路是"入口 → 目标"，不是节点到节点）。
    return {
      ok: true,
      topology: {
        forward_id: input.forward.id,
        mode: input.forward.mode,
        segments: [],
        observed_at: null,
        stale_segments: 0,
      },
    };
  }

  const projected: TopologySegment[] = segments.map((s) => {
    const from = endpoint(input.reports, s.ingress_node_id, s.ingress_node_key, s.ingress_runtime_id);
    const to = endpoint(input.reports, s.egress_node_id, s.egress_node_key, s.egress_runtime_id);
    return {
      segment: s.segment,
      from,
      to,
      hop: s.hop,
      expected_revision: s.expected_revision,
    };
  });

  const observedAt = Object.values(input.reports)
    .map((r) => r.reported_at)
    .filter((v): v is string => typeof v === "string" && v !== "")
    .sort()
    .at(-1) ?? null;

  const staleSegments = projected.filter((s) => {
    // "有过上报却说不出这一端在跑"才算 stale；两端都没上报过节点的情形留给 observed_at 表达。
    const knowsFrom = input.reports[s.from.node_id] !== undefined;
    const knowsTo = input.reports[s.to.node_id] !== undefined;
    return (knowsFrom && !s.from.running) || (knowsTo && !s.to.running);
  }).length;

  return {
    ok: true,
    topology: {
      forward_id: input.forward.id,
      mode: input.forward.mode,
      segments: projected,
      observed_at: observedAt,
      stale_segments: staleSegments,
    },
  };
}

/* ================================================================== */
/* 编排与生产接线                                                       */
/* ================================================================== */

/**
 * 本视图的依赖缝隙。
 *
 * 参数用**真实 Prisma 参数类型**（不是 `unknown`）：用 `unknown` 等于关掉 Prisma 的字段与
 * 关系名校验，症状是运行期 500 而不是编译错误 —— 这个仓库在同一天里被这条咬过四次
 * （`has_credential`、`workspace_members` 关系名、`DNSProviderType`、`seed.ts` 枚举穷尽）。
 */
export interface TopologyDeps {
  /** 与诊断路径**同一个** loader（`ForwardForDiagnose`），不为本视图另写一条查询。 */
  readonly loadForward: (forwardId: number, workspaceId: number) => Promise<ForwardForDiagnose | null>;
  /** 取这些节点最近一次上报里与本视图有关的两列。 */
  readonly loadReports: (nodeIds: readonly number[]) => Promise<Record<number, TopologyNodeReport>>;
}

export type LoadTopologyResult =
  | ForwardTopologyResult
  | { readonly ok: false; readonly code: "not_found"; readonly message: string };

/**
 * 读一条转发的拓扑视图。
 *
 * 先取计划需要的行（复用诊断的 loader），**再从行里算出该问哪些节点**，最后只查这些节点的
 * 上报 —— 而不是把所有节点的上报都拉一遍再看。差别不只是省查询：`node_state_report` 的
 * `tunnels` 是 JSON 大列，按需取是这类视图能不能用的分界。
 */
export async function loadForwardTopology(
  deps: TopologyDeps,
  input: { readonly forwardId: number; readonly workspaceId: number },
): Promise<LoadTopologyResult> {
  const forward = await deps.loadForward(input.forwardId, input.workspaceId);
  if (!forward) return { ok: false, code: "not_found", message: "端口转发不存在" };

  const nodeIds = [
    forward.ingress_node_id,
    forward.middle_node_id ?? null,
    forward.egress_node_id,
  ].filter((v): v is number => typeof v === "number");

  const reports = await deps.loadReports([...new Set(nodeIds)]);
  return projectForwardTopology({ forward, reports });
}

/**
 * 生产接线。`db` 延迟 import：本模块的纯函数部分要能在没有 `DATABASE_URL` 的进程里被断言
 * （与 `agent-diagnose` / `ddns-successor` 同一取向）。
 */
export function defaultTopologyDeps(): TopologyDeps {
  return {
    loadForward: async (forwardId, workspaceId) => {
      const { defaultDiagnoseDeps } = await import("./agent-diagnose.ts");
      return defaultDiagnoseDeps().loadForward(forwardId, workspaceId);
    },
    loadReports: async (nodeIds) => {
      if (nodeIds.length === 0) return {};
      const { db } = await import("../db.ts");
      const rows = (await db.nodeStateReport.findMany({
        where: { node_id: { in: [...nodeIds] } },
        select: { node_id: true, tunnels: true, reported_at: true },
      } as Prisma.NodeStateReportFindManyArgs)) as Array<{ node_id: number; tunnels: unknown; reported_at: Date | null }>;
      const out: Record<number, TopologyNodeReport> = {};
      for (const row of rows) {
        out[row.node_id] = {
          tunnels: row.tunnels,
          reported_at: row.reported_at instanceof Date ? row.reported_at.toISOString() : null,
        };
      }
      return out;
    },
  };
}
