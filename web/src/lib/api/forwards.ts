import type {
  DiagnoseReport,
  NodeDiagnosticsReport,
  NodeUpgradeCommand,
  AdminDashboardStats,
  AdminListInput,
  AdminResourceMeta,
  AdminRole,
  AdminRoleInput,
  AdminUserInput,
  AttentionPayload,
  AuditLog,
  AuditLogQuery,
  AuthSession,
  BalanceLog,
  DashboardStats,
  EgressPool,
  EgressPoolInput,
  EgressTarget,
  EgressTargetInput,
  FederationDisableResult,
  FederationEnableResult,
  FederationGrant,
  FederationGrantActionResult,
  FederationGrantCreateResult,
  FederationGrantInput,
  FederationHandshakeInput,
  FederationHandshakeResult,
  FederationInvitation,
  FederationInviteInput,
  FederationKeyRotateResult,
  FederationLease,
  FederationPeer,
  FederationPeerRevokeResult,
  FederationPeerRotateResult,
  FederationPingResult,
  FederationPlacement,
  FederationStatus,
  FederationUsageRecord,
  ID,
  LicenseInfo,
  ListQuery,
  LBStrategy,
  Node,
  NodeCredentialIssued,
  NodeCredentialRevoked,
  NodeEnrollmentIssued,
  NodeBinding,
  NodeDetail,
  NodeGroup,
  NodeGroupInput,
  NodeHealthList,
  NodeHealthSummary,
  NodeHealthValue,
  NodeHealthView,
  NodeImpactResult,
  NodeInput,
  NodeLifecycleChangeResult,
  NodeLifecycleValue,
  NodeLifecycleView,
  NodeRole,
  NodeStateReport,
  ConsumableRouteProfileList,
  Paginated,
  PasswordChangeInput,
  RouteProfileApplyInput,
  RouteProfileApplyResult,
  RouteProfileCreateInput,
  RouteProfileDetail,
  RouteProfileImpact,
  RouteProfilePatchInput,
  RouteProfilePublishInput,
  RouteProfilePublishResult,
  RouteProfileVersionBody,
  RouteProfileVersionEntry,
  RouteProfileView,
  PortForward,
  ForwardCreateInput,
  ForwardPatchInput,
  ForwardPreviewResult,
  ForwardListQuery,
  ForwardBatchInput,
  ForwardBatchResult,
  ForwardSummary,
  ProvisionNodeResult,
  Payment,
  Plan,
  PlanInput,
  PlanOrder,
  ProfileUpdateInput,
  SystemConfigItem,
  Ticket,
  TopupOrder,
  TrafficPoint,
  Tunnel,
  TunnelUpdateInput,
  User,
  UserNode,
  Workspace,
  WorkspaceAcceptInviteResult,
  WorkspaceCreateInput,
  WorkspaceInvite,
  WorkspaceInviteInput,
  WorkspaceMember,
  WorkspaceTrafficSummary,
} from "../types";
import { normalizeHealthSummary } from "../node-health";
// 公告类型单独维护在 announcements.ts。
import type { Announcement } from "../announcements";
// 目标健康状态与理由码在 target-health.ts 维护。
import type { TargetPoolHealth } from "../target-health";
import { shouldRedirectToLogin } from "../workspace-permissions";
import type { EffectiveWorkspacePermissions, WorkspaceCustomRole, WorkspaceCustomRoleInput, WorkspaceMemberRoleInput } from "../workspace-permissions";

import { request, get, post, put, patch, del, applyMockSessionCookie, clearMockSessionCookie } from "./core";

/* ================================================================== */
/* Forward 链路（topology）Web 侧契约                                    */
/* ================================================================== */

/**
 * 一条 runtime 的协议诊断读取视图（后端 `TunnelProtocolDiag` 的同形投影）。
 *
 * **三态不可合并**（这是本视图最容易读错的地方）：
 *   · `diag === null` —— 这次上报里**没有**协议诊断块（tcp 隧道本来就没有，
 *     旧 Agent 也不上报）：没有证据；
 *   · `facts` 为空对象 —— 报了诊断块，但这次一个标量事实都没有；
 *   · `facts: { drops: 0 }` —— 报了，而且真的没有丢包。
 * 把第一种渲染成「没丢包 / 一切正常」是本视图最严重的误读方式。
 *
 * `facts` 的键集由 Agent 拥有且**开放**：未知键照原样进视图，读取方不得自建白名单。
 */
export interface TopologyDiagFact {
  protocol: string | null;
  facts: Record<string, number | string | boolean>;
  /** 后端视图做过有界化（键数上限 / 长字符串截断）；true 时 `facts` 不是原始块全量。 */
  truncated: boolean;
}

/** 一跳的一端：某节点上的某条 runtime 的事实。 */
export interface TopologyEndpointFact {
  node_id: number;
  node_key: string;
  runtime_id: string;
  /**
   * 该 runtime 是否出现在该节点**最近一次上报**里。
   *
   * `false` 有两种成因、且都**不是**「已停机 / 不健康」的结论：
   *   · 该节点从未上报过（看 `observed_at === null` / 该端的 `revision === null`）；
   *   · 该节点报过，但最近一次上报里没有这条 runtime（面板抢先、节点还没跑起来）。
   */
  running: boolean;
  /** 上报里那条 runtime 的 revision；没有上报时为 `null`（未知，不是 0）。 */
  revision: number | null;
  diag: TopologyDiagFact | null;
}

/** 一段节点间链路。段名沿用后端 `NodeFactsSegment` 的词表，Web 不另造名字。 */
export interface ForwardTopologySegment {
  segment: "ingress_to_egress" | "ingress_to_middle" | "middle_to_egress";
  from: TopologyEndpointFact;
  to: TopologyEndpointFact;
  /** 配置里的下一跳地址（**仅展示**：它指向业务监听端口，本视图不拨它）。 */
  hop: { host: string; port: number } | null;
  /** 两端都应收敛到的 desired revision。 */
  expected_revision: number | null;
}

/**
 * `GET /api/forwards/:id/topology` 的响应体（只读投影）。
 *
 * 三条已被真实响应证实的读法：
 *  1. `mode === "direct"` 时 `segments` **一定是空数组**，这是 DIRECT 的设计结论
 *     （入口直接到目标，没有节点间跳），**不是缺数据**，也不该画成空态/错误；
 *  2. `observed_at` 是「参与节点中**最新**一条上报的时刻」，`null` = 没有任何节点上报过。
 *     它回答「这份视图有多新鲜」，**不是**链路检查时刻，也不代表链路通或不通；
 *  3. `stale_segments` 是「节点有过上报、但最近一次上报里缺至少一端 runtime」的段数，
 *     让「面板说在跑、节点自己没说」变成一个可断言的数字。
 */
export interface ForwardTopology {
  forward_id: number;
  mode: "direct" | "relay";
  segments: ForwardTopologySegment[];
  observed_at: string | null;
  stale_segments: number;
}

/* ================================================================== */
/* 流量口径（F11：详情页累计流量必须与归档账本同源）                      */
/* ================================================================== */

/** 归档账本 `tunnel_traffic` 的写入节奏：每 10 分钟一次（后端 cron 的 `star/10` 表达式）。 */
export const LEDGER_ARCHIVE_INTERVAL_MINUTES = 10;
/** 账本日界时区（后端 `billingDayKeyStamp` 用的是 Asia/Shanghai 日界）。 */
export const LEDGER_TIME_ZONE = "Asia/Shanghai";

/** 某个时刻在账本日界时区里的日键（`YYYY-MM-DD`）。 */
export function ledgerDayKey(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: LEDGER_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

/**
 * 归档账本窗口的汇总（详情页「累计流量」的唯一算法，取代已无写入者的
 * `PortForward.traffic` 死列 —— F11）。
 *
 * `GET /forwards/:id/traffic` 返回的是**补零后的稠密窗口**（后端 `fillDays`），
 * 所以 Web 侧无法区分「这一天没有账本行」与「这一天有行但为 0」。因此：
 *   · `has_data` 的口径是**窗口内有没有任何非零流量**，不是「有没有行」；
 *   · `has_data === false` 时，UI 必须说「无数据」，**不得**渲染成 `0 B`
 *     （`0 B` 是一个测量结果，而我们只知道自己没有记录）。
 * 这是本视图刻意保留的一处不可知，不能靠猜补上。
 */
export interface ForwardLedgerSummary {
  days: number;
  /** 窗口首日（账本日键）；窗口为空时 `null`。 */
  from: string | null;
  /** 窗口末日（账本日键）；窗口为空时 `null`。 */
  to: string | null;
  total_bytes: number;
  total_cost: number;
  has_data: boolean;
  /** 窗口是否包含「今天」（= 最后一个不完整日，归档最多滞后 10 分钟）。 */
  includes_today: boolean;
}

export function summarizeForwardLedger(
  points: readonly TrafficPoint[],
  options?: { now?: Date },
): ForwardLedgerSummary {
  let totalBytes = 0;
  let totalCost = 0;
  let hasData = false;
  for (const point of points) {
    const bytes = Number(point.traffic ?? 0);
    const cost = Number(point.traffic_cost ?? 0);
    if (Number.isFinite(bytes)) totalBytes += bytes;
    if (Number.isFinite(cost)) totalCost += cost;
    if ((Number.isFinite(bytes) && bytes > 0) || (Number.isFinite(cost) && cost > 0)) {
      hasData = true;
    }
  }
  const today = ledgerDayKey(options?.now ?? new Date());
  return {
    days: points.length,
    from: points[0]?.date ?? null,
    to: points[points.length - 1]?.date ?? null,
    total_bytes: totalBytes,
    total_cost: totalCost,
    has_data: hasData,
    includes_today: points.some((point) => point.date === today),
  };
}

/* ================================================================== */
/* 延迟历史（D6 只读端点）Web 侧契约                                     */
/* ================================================================== */

/**
 * 「有没有数据」的四种形状 —— **稳定字符串，界面必须按它分支，而不是按 `series.length`**。
 *
 * 为什么不能按长度分支：`ok` 的序列里每个点都可能是 `latency_ms: null`（那次观测失败），
 * 而 `no_samples` / `no_observer` / `ambiguous_target` 都返回空数组 —— 只看长度就会把
 * 「这个窗口没有观测」「按构造不可能有观测」「拒绝猜目标」三种完全不同的真相，
 * 一起渲染成「没有数据」。
 *   · `ok`               —— 有真观测点（点内仍可能是 `null`）；
 *   · `no_samples`       —— 观测维度成立，但窗口内一行都没有（**数据缺口**，不是 0ms）；
 *   · `no_observer`      —— 按构造不可能有观测（DIRECT / 联邦出口 / 无池 / 无 active 目标 / 归属冲突）；
 *   · `ambiguous_target` —— 出口池有多个目标：一次只答一条会藏起其余目标的抖动 ⇒ 拒绝猜。
 */
export type ForwardLatencyStatus = "ok" | "no_samples" | "no_observer" | "ambiguous_target";

/** `no_observer` / `ambiguous_target` 的稳定原因码（界面按它给一句人话，不猜原因）。 */
export type ForwardLatencyReason =
  | "direct_not_observed"
  | "federated_egress"
  | "no_egress_pool"
  | "no_active_target"
  | "dimension_conflict"
  | "multiple_targets";

export type LatencyGranularity = "sample" | "hour";

/** 服务端裁剪后的真实窗口（半开区间 `[from, to)`）。界面**照实回显**，不自己算窗口。 */
export interface ForwardLatencyWindow {
  from: string;
  to: string;
  hours: number;
}

/**
 * 服务端推导的观测维度：**观测方节点 + 目标身份**。
 *
 * 这条线回答的是「某个节点的观测器看某个目标」，**不是**「这条转发」——界面必须把
 * 维度说出来，否则用户会把一条出口节点的探测曲线当成整条转发的端到端延迟。
 * 这两个值**只能**由服务端从已授权转发推导：`target_latency_sample` 没有 workspace 列，
 * 让客户端指定 `target_key` 就是一个跨租户探针，所以 Web 侧**不提供**这两个参数。
 */
export interface ForwardLatencyDimension {
  observer_node_id: number;
  target_key: string;
}

export interface ForwardLatencyPoint {
  /** 横轴：`sample` = 观测时刻；`hour` = 桶起点（UTC 整点）。ISO 串。 */
  at: string;
  /** 那次测得的延迟；**`null` = 那次没有测得（失败/超时）**，绝不是 0。 */
  latency_ms: number | null;
  samples: number;
  successes: number;
  failures: number;
  latency_min_ms: number | null;
  latency_max_ms: number | null;
  observation_source: string;
}

/** `GET /api/forwards/:id/latency` 的响应体（200）。 */
export interface ForwardLatencyResponse {
  forward_id: number;
  mode: "direct" | "relay";
  granularity: LatencyGranularity;
  window: ForwardLatencyWindow;
  /** 没有可观测维度时为 `null`（此时 `status` 一定不是 `ok`/`no_samples`）。 */
  dimension: ForwardLatencyDimension | null;
  status: ForwardLatencyStatus;
  reason: ForwardLatencyReason | null;
  /** 仅 `ambiguous_target` 给出：池里有几个候选目标（只有数量，没有清单）。 */
  candidate_targets?: number;
  series: ForwardLatencyPoint[];
  /** 命中点数上限被截断：**必须**显式呈现，否则截断过的线会被当成完整曲线。 */
  truncated: boolean;
}

/**
 * 各粒度的窗口硬上限（小时）。**只用于给界面提供合法的预设选项**：
 * 真相永远在服务端——超限时服务端返回 400 `window_too_long`（带 `data.max_hours`），
 * 界面照原样转述，不自己重算窗口、也不静默改小。
 */
export const LATENCY_WINDOW_MAX_HOURS: Record<LatencyGranularity, number> = {
  sample: 24,
  hour: 720,
};

/**
 * 轮询下限 = 观测节拍（节点每 30s 观测/上报一次）。
 *
 * 比节拍更快只会重复读同一份档案：既不可能多出信息，又白耗面板与 DB。
 * 界面用 {@link LATENCY_POLL_MS} 做自动刷新间隔，并对同一时刻的在途请求去重。
 */
export const LATENCY_POLL_MS = 30_000;

/**
 * 读延迟历史（只读、零副作用）。
 *
 * 参数只有 `granularity` 与窗口（`hours`，或 `from`+`to`）——**故意没有**任何
 * `node_id` / `target_key` / `observation_source` 字段：维度是服务端事实，
 * 客户端参数会被忽略（那是跨租户安全边界，不是一个可以试的选项）。
 */
export const forwardsApi = {
    summary: (cookie?: string) =>
      get<ForwardSummary>("/forwards/summary", undefined, cookie),
    /**
     * 延迟历史窗口的三种形态（与后端 `parseLatencyWindow` 一一对应）：
     *   · `{ hours }` —— 最近 N 小时；`{ from, to }` —— 显式区间（二者互斥）。
     * 窗口的最终裁剪以**响应里的 `window`** 为准。
     */
    latency: (
      id: ID,
      query: { granularity: LatencyGranularity; hours?: number; from?: string; to?: string },
      cookie?: string,
    ) => get<ForwardLatencyResponse>(`/forwards/${id}/latency`, query, cookie),
    /**
     * 列表支持服务端分页、排序和过滤。
     *
     * 带 `page` / `page_size` / `sort` / `order` 任一参数时后端返回
     * `Paginated<PortForward>`；不带则返回裸数组（冻结的旧契约）。
     * 用两个方法把这两种形态分开，调用点就无法"忘了带 page 却按分页读"。
     */
    list: (query?: ForwardListQuery, cookie?: string) =>
      get<PortForward[]>("/forwards", query, cookie),
    /** 分页形态：必须有分页/排序参数，响应为 `Paginated<PortForward>`。 */
    page: (query: ForwardListQuery, cookie?: string) =>
      get<Paginated<PortForward>>("/forwards", query, cookie),
    /**
     * 批量 retry / suspend / resume。
     *
     * 逐条结果 + 200（部分失败不改整体状态码），因此调用方必须读
     * `succeeded` / `failed` 而不是只看 promise 是否 reject。
     */
    batch: (
      input: ForwardBatchInput,
      cookie?: string,
    ) => post<ForwardBatchResult>("/forwards/batch", input, cookie),
    detail: (id: ID, cookie?: string) =>
      get<PortForward>(`/forwards/${id}`, undefined, cookie),
    traffic: (id: ID, days = 14, cookie?: string) =>
      get<TrafficPoint[]>(`/forwards/${id}/traffic`, { days }, cookie),
    /**
     * 只读链路投影：计划（期望状态）里的节点间段 + 两端**最近一次上报**的运行时事实。
     *
     * 不发命令、不做主动探测。失败语义由调用方负责呈现：
     * `not_found`(404) 与「计划不成立」(409，如 RELAY 缺出口端口，带后端 `code` + 原文)
     * 都必须**原样**显示，且**不重试** —— 重试不会让缺失的期望状态出现。
     */
    topology: (id: ID, cookie?: string) =>
      get<ForwardTopology>(`/forwards/${id}/topology`, undefined, cookie),
    create: (input: ForwardCreateInput, cookie?: string) =>
      post<PortForward>("/forwards", input, cookie),
    update: (id: ID, input: ForwardPatchInput, cookie?: string) =>
      patch<PortForward>(`/forwards/${id}`, input, cookie),
    /**
     * 保存前影响预览（不写库）。
     *
     * 与 update 共用后端同一个 candidate resolver，因此本方法放行 ⇔ update 接受。
     * UI 在每次字段变更后调用它渲染 impact warning。
     */
    preview: (id: ID, input: ForwardPatchInput, cookie?: string) =>
      post<ForwardPreviewResult>(`/forwards/${id}/preview`, input, cookie),
    action: (
      id: ID,
      action: "retry" | "suspend" | "resume",
      cookie?: string,
    ) => post<PortForward>(`/forwards/${id}/${action}`, {}, cookie),
    remove: (id: ID, cookie?: string) =>
      del<{ ok: true }>(`/forwards/${id}`, cookie),
    /**
     * Forward 诊断（只读）。
     *
     * 探针目标由**后端**从该转发的已授权期望状态推导，请求体不带 host/port ——
     * 因此这里刻意不接受任何参数：一个"带目标参数的诊断"就是把客户端变成内网扫描器。
     */
    diagnose: (id: ID, cookie?: string) =>
      post<DiagnoseReport>(`/forwards/${id}/diagnose`, {}, cookie),
};
