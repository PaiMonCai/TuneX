"use client";

/**
 * Forward 详情 · 节点间链路（`GET /forwards/:id/topology` 的**首个** Web 消费点）
 * ＋ 「累计流量」换源（F11 修正）。
 *
 * ── 这个文件为什么存在 ──
 *
 * 后端从很早就有一条只读拓扑投影（`backend/src/services/forward-topology.ts`，路由
 * `routes/forwards.ts`），但 Web 侧零 consumer：计划里的节点间段、两端最近一次上报的
 * `running` / `revision` / `diag` 全都有，用户却看不到。本组件只做**展示**：不发命令、
 * 不探测、不新增后端。
 *
 * 另一件事是**事实错误修正**（F11）：详情页原来的「累计流量」读 `PortForward.traffic`，
 * 而这一列**已经没有写入者**（`forward-service.ts` 的 `forwardView` 仍在投影它，但全仓
 * 没有任何 `tunnel.update/create/upsert` 携带 `traffic`）——于是它永远显示 `0 B`，还和
 * 列表页/图表用的**归档账本**（`tunnel_traffic`）互相矛盾。本文件里的
 * {@link ForwardLedgerTotal} 就是从归档账本算「累计」，并显式标注窗口与归档延迟；
 * 挂载点由集成任务负责（本组件自包含，不改 `forward-detail.tsx`）。
 *
 * ── 四条读法纪律（都能被行为测试钉住）──
 *
 *  1. DIRECT 的 `segments: []` 是**设计结论**（入口直接到目标，没有节点间跳），
 *     **不是缺数据**：画成「入口 → 目标（直连）」并明说，不得退化成空态/错误态；
 *  2. `observed_at === null` 只能读成「**没有任何节点上报过**」；有值时它是「参与节点中
 *     最新一条上报的时刻」，**不是**链路检查时刻；
 *  3. `diag` 的三态（`null` / `facts: {}` / `facts: {drops: 0}`）必须**互不相同**地呈现；
 *     `null` 绝不能渲染成「没丢包」；键集开放，未知键原样展示；
 *  4. 取不到（网络失败 / 403 / 409 / 404）时：独立 testid、显示后端 `code` + 原文、
 *     **不重试**，并且**不得**出现「正常 / 可达 / 健康」这类结论词 —— 拿不到证据时
 *     我们做不出任何结论。`running: false` 与 revision 不一致同样是**两件事**，分别表述。
 *
 * ── 为什么文案在本文件里，而不是 i18n 字典 ──
 *
 * 本模块是**自包含**切片（写入范围只有本文件 + `lib/api/forwards.ts` + mock），
 * 避免与其他并行切片争抢 `lib/i18n/dictionaries.ts`。文案通过 `useI18nOptional()`
 * 取 locale（无 Provider 时回落 `zh`），与 `forward-diagnose.tsx` 的既有做法一致；
 * 集成时可整体搬进字典，不需要改本模块的结构。
 */

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import {
  LEDGER_ARCHIVE_INTERVAL_MINUTES,
  LEDGER_TIME_ZONE,
  summarizeForwardLedger,
  type ForwardLedgerSummary,
  type ForwardTopology,
  type ForwardTopologySegment,
  type TopologyDiagFact,
  type TopologyEndpointFact,
} from "@/lib/api/forwards";
import { useI18nOptional } from "@/components/providers";
import { forwardProtocolLabel } from "@/lib/forward-protocol";
import { useWorkspace } from "@/components/workspace/workspace-context";
import { PERMISSION_DENIED } from "@/lib/workspace-permissions";
import type { Locale } from "@/lib/i18n";
import type { ID, TrafficPoint } from "@/lib/types";
import { formatBytes, formatDateTime } from "@/lib/utils";

/* ================================================================== */
/* 文案（zh / en；en 侧同样回避 healthy / reachable / normal 这类结论词）  */
/* ================================================================== */

export interface TopologyCopy {
  title: string;
  subtitle: string;
  loading: string;
  deniedTitle: string;
  unavailableTitle: string;
  /** 取不到时**必须**出现「不代表正常」这层意思（zh 用固定短语，en 用 not evidence）。 */
  unavailableBody: string;
  unavailableNoRetry: string;
  errorCode: string;
  directLine: string;
  directNote: string;
  directNoProbe: string;
  relayTitle: string;
  hopMissing: string;
  endpointIngress: string;
  endpointEgress: string;
  runningInReport: string;
  runningAbsentFromReport: string;
  revisionUnknown: string;
  revisionExpectedUnknown: string;
  revisionMatches: (reported: number, expected: number) => string;
  revisionDiffers: (reported: number, expected: number) => string;
  observedTitle: string;
  observedNever: string;
  observedAt: (value: string) => string;
  observedMeaning: string;
  staleSegments: (count: number) => string;
  diagNone: string;
  diagEmpty: string;
  diagFactsTitle: (protocol: string) => string;
  diagTruncated: string;
  ledgerTitle: string;
  /** 标题后面的口径括号（必须跟着 locale 走，否则 en 界面里会漏出中文）。 */
  ledgerTitleSuffix: string;
  ledgerNoData: string;
  ledgerNoDataNote: string;
  ledgerWindow: (from: string, to: string, days: number) => string;
  ledgerWindowUnknown: string;
  ledgerArchiveLag: string;
  ledgerSource: string;
}

const ZH: TopologyCopy = {
  title: "节点间链路",
  subtitle:
    "只读：段结构来自期望状态，两端事实来自各节点最近一次上报。本视图不发命令、不做连通性探测。",
  loading: "正在读取链路…",
  deniedTitle: "没有查看链路的权限",
  unavailableTitle: "链路取不到",
  unavailableBody:
    "链路取不到：这次请求没有拿到数据，因此不代表正常，也不代表异常 —— 拿不到证据时做不出任何结论。请刷新页面再试一次，或联系管理员。",
  unavailableNoRetry: "本卡片不会自动重试：重试不会让缺失的期望状态出现。",
  errorCode: "后端返回",
  directLine: "入口节点 → 目标（直连）",
  directNote:
    "DIRECT 转发没有节点之间的跳：这是这条链路的设计结论，不是缺数据，也不是空态。",
  directNoProbe:
    "本视图不验证连通性：它不回答「这条转发通不通」，也不构成任何连通性结论。需要结论请用「诊断」。",
  relayTitle: "逐段明细",
  hopMissing: "配置里没有可展示的下一跳地址",
  endpointIngress: "起点",
  endpointEgress: "终点",
  runningInReport: "最近一次上报里有这条 runtime",
  runningAbsentFromReport:
    "最近一次上报里没有这条 runtime（可能是还没跑起来，也可能是这次没报它；本视图不判断是哪种）",
  revisionUnknown: "上报里没有这条 runtime 的 revision：未知，不是 0",
  revisionExpectedUnknown: "期望 revision 未知（计划里没有给出）",
  revisionMatches: (reported, expected) => `上报 revision ${reported} = 期望 ${expected}`,
  revisionDiffers: (reported, expected) =>
    `上报 revision ${reported} ≠ 期望 ${expected}（两端尚未收敛到同一条期望状态）`,
  observedTitle: "观测新鲜度",
  observedNever: "没有任何节点上报过（这份视图里没有任何一条上报记录）",
  observedAt: (value) => `${value}`,
  observedMeaning: "这是参与节点中最新一条上报的时刻，不是链路检查时刻。",
  staleSegments: (count) =>
    `有 ${count} 段属于：节点有过上报，但最近一次上报里没有这条 runtime。`,
  diagNone:
    "协议诊断：没有（null）= 这次上报里没有这块事实。它不等于「没有丢包」，也不等于「没有错误」。",
  diagEmpty:
    "协议诊断：上报里有这块，但没有任何标量事实（{}）。它不等于「没有丢包」。",
  diagFactsTitle: (protocol) => `协议诊断（${forwardProtocolLabel(protocol)}）`,
  diagTruncated: "视图做过有界化：下面不是原始块的全部键。",
  ledgerTitle: "累计流量",
  ledgerTitleSuffix: `（${LEDGER_TIME_ZONE} 日界 · 归档账本）`,
  ledgerNoData: "无数据",
  ledgerNoDataNote:
    "窗口内归档账本没有任何流量记录 ⇒ 无数据；这里不给零值数字：零值是一个测量结果，而我们只知道自己没有记录。",
  ledgerWindow: (from, to, days) => `窗口 ${from} ~ ${to}（${days} 天，按 ${LEDGER_TIME_ZONE} 日界）`,
  ledgerWindowUnknown: "窗口未知（没有账本点）",
  ledgerArchiveLag: `归档节奏：每 ${LEDGER_ARCHIVE_INTERVAL_MINUTES} 分钟一次；今天是不完整日，最新归档最多滞后 ${LEDGER_ARCHIVE_INTERVAL_MINUTES} 分钟；面板没有实时速率。`,
  ledgerSource:
    "口径：与列表页同一个归档账本（tunnel_traffic）；不再是详情接口里那条没有写入者的 legacy traffic 列。",
};

const EN: TopologyCopy = {
  title: "Path between nodes",
  subtitle:
    "Read-only: segment structure comes from desired state, endpoint facts from each node's latest report. No commands, no connectivity probing.",
  loading: "Reading the path…",
  deniedTitle: "No permission to read the path",
  unavailableTitle: "Path unavailable",
  unavailableBody:
    "Path unavailable: this request returned no data, so it is not evidence that things are fine — and not evidence that they are broken either. With no evidence there is no conclusion.",
  unavailableNoRetry: "This card does not retry: retrying cannot create missing desired state.",
  errorCode: "Backend said",
  directLine: "Ingress node → target (direct)",
  directNote:
    "A DIRECT forward has no hop between nodes: that is the design conclusion for this path, not missing data and not an empty state.",
  directNoProbe:
    "This view does not verify connectivity: it does not answer \"is this forward working\", and it is not a connectivity conclusion.",
  relayTitle: "Per-segment detail",
  hopMissing: "No next-hop address to show in stored config",
  endpointIngress: "from",
  endpointEgress: "to",
  runningInReport: "present in the latest report",
  runningAbsentFromReport:
    "absent from the latest report (maybe not started yet, maybe simply not reported this time; this view does not decide which)",
  revisionUnknown: "the report carries no revision for this runtime: unknown, not 0",
  revisionExpectedUnknown: "expected revision unknown (not present in the plan)",
  revisionMatches: (reported, expected) => `reported revision ${reported} = expected ${expected}`,
  revisionDiffers: (reported, expected) =>
    `reported revision ${reported} ≠ expected ${expected} (the two ends have not converged on the same desired state)`,
  observedTitle: "Observation freshness",
  observedNever: "No node has ever reported (this view holds no report at all)",
  observedAt: (value) => `${value}`,
  observedMeaning: "This is the newest report time among participating nodes, not a link check time.",
  staleSegments: (count) =>
    `${count} segment(s): the node has reported before, but its latest report does not contain this runtime.`,
  diagNone:
    "Protocol diagnostics: none (null) = no such block in this report. It does not mean \"no packet loss\" and not \"no errors\".",
  diagEmpty:
    "Protocol diagnostics: the block is present but carries no scalar fact ({}). It does not mean \"no packet loss\".",
  diagFactsTitle: (protocol) => `Protocol diagnostics (${forwardProtocolLabel(protocol)})`,
  diagTruncated: "The view is bounded: the keys below are not the whole original block.",
  ledgerTitle: "Total traffic",
  ledgerTitleSuffix: `(${LEDGER_TIME_ZONE} day boundary · archived ledger)`,
  ledgerNoData: "No data",
  ledgerNoDataNote:
    "The archived ledger has no traffic record in this window ⇒ no data; no zero figure is shown here: zero is a measurement, and all we know is that we have no record.",
  ledgerWindow: (from, to, days) =>
    `window ${from} ~ ${to} (${days} days, ${LEDGER_TIME_ZONE} day boundary)`,
  ledgerWindowUnknown: "window unknown (no ledger point)",
  ledgerArchiveLag: `Archive cadence: every ${LEDGER_ARCHIVE_INTERVAL_MINUTES} minutes; today is an incomplete day, so the newest archive can lag up to ${LEDGER_ARCHIVE_INTERVAL_MINUTES} minutes; the panel has no live rate.`,
  ledgerSource:
    "Source: the same archived ledger (tunnel_traffic) the list page uses; no longer the legacy traffic column that has no writer.",
};

const COPY: Record<Locale, TopologyCopy> = { zh: ZH, en: EN };

function useCopy(): TopologyCopy {
  return COPY[useI18nOptional()?.locale ?? "zh"];
}

/* ================================================================== */
/* 纯展示：链路结论（可静态渲染，覆盖全部状态）                            */
/* ================================================================== */

/** 取不到时的错误信息（后端 `code` + 原文；两者都缺失时给一句人话）。 */
export interface TopologyErrorInfo {
  code: string | null;
  message: string;
}

/**
 * 从 API 错误里取「后端 `code` + 原文」。
 *
 * 契约要求的是**原样转述**：`ApiError.data` 里带着后端错误体
 * （`{ error, code, error_layer }`），把 `code` 丢掉就等于把用户唯一能念给管理员的
 * 排障材料丢掉。取不到就明说取不到，不猜。
 */
export function topologyErrorInfo(error: unknown): TopologyErrorInfo {
  const data = (error as { data?: unknown } | null | undefined)?.data;
  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  const rawCode = record?.code;
  const code = typeof rawCode === "string" && rawCode.trim() !== "" ? rawCode : null;
  const message =
    error instanceof Error && error.message.trim() !== ""
      ? error.message
      : "拓扑接口没有返回可用的错误信息";
  return { code, message };
}

/**
 * 组件状态。
 *
 * `denied` 与 `error` 分开：前者是「没有 `forward:read`，**请求根本没发**」，
 * 后者是「发了但拿不到」。把两者合并会让用户以为接口坏了，而其实是他没权限。
 */
export interface ForwardTopologyState {
  status: "loading" | "ok" | "error" | "denied";
  topology: ForwardTopology | null;
  error: TopologyErrorInfo | null;
}

/** 切 Workspace / 切转发时的**三态重置**：旧证据一律从屏幕上撤掉。 */
export function resetTopologyState(): ForwardTopologyState {
  return { status: "loading", topology: null, error: null };
}

export function deniedTopologyState(): ForwardTopologyState {
  return { status: "denied", topology: null, error: null };
}

/** 链路的一段：`from → hop → to` + 两端事实（`running` 与 revision 分别表述）。 */
export function ForwardTopologySegmentView({
  segment,
  copy,
}: {
  segment: ForwardTopologySegment;
  copy: TopologyCopy;
}) {
  const hop = segment.hop
    ? `${segment.hop.host}:${segment.hop.port}`
    : copy.hopMissing;
  return (
    <li data-testid="forward-topology-segment" className="rounded-md border border-[var(--border)] p-3">
      <div className="font-mono text-xs break-all" data-testid="forward-topology-chain">
        {segment.from.node_key} → {hop} → {segment.to.node_key}
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <EndpointFacts
          role={copy.endpointIngress}
          fact={segment.from}
          expectedRevision={segment.expected_revision}
          copy={copy}
        />
        <EndpointFacts
          role={copy.endpointEgress}
          fact={segment.to}
          expectedRevision={segment.expected_revision}
          copy={copy}
        />
      </div>
      <p className="mt-2 text-xs text-[var(--muted-foreground)]">
        {`${segment.segment} · expected_revision: ${segment.expected_revision ?? "—"}`}
      </p>
    </li>
  );
}

function EndpointFacts({
  role,
  fact,
  expectedRevision,
  copy,
}: {
  role: string;
  fact: TopologyEndpointFact;
  expectedRevision: number | null;
  copy: TopologyCopy;
}) {
  return (
    <div className="rounded bg-[var(--muted)] p-2 text-xs">
      <div className="font-medium">
        {role}：{fact.node_key}
      </div>
      <div className="mt-1 text-[var(--muted-foreground)]">
        runtime <span className="font-mono">{fact.runtime_id}</span>
      </div>
      <div className="mt-1" data-testid="forward-topology-running">
        {fact.running ? copy.runningInReport : copy.runningAbsentFromReport}
      </div>
      <div className="mt-1" data-testid="forward-topology-revision">
        {revisionText(fact, expectedRevision, copy)}
      </div>
      <DiagFacts diag={fact.diag} copy={copy} />
    </div>
  );
}

/** revision 与 `expected_revision` 只做「相等 / 不等 / 未知」三种表述，不合并成「异常」。 */
function revisionText(
  fact: TopologyEndpointFact,
  expected: number | null,
  copy: TopologyCopy,
): string {
  if (fact.revision === null) return copy.revisionUnknown;
  if (expected === null) return `${copy.revisionExpectedUnknown}；上报 revision ${fact.revision}`;
  return fact.revision === expected
    ? copy.revisionMatches(fact.revision, expected)
    : copy.revisionDiffers(fact.revision, expected);
}

/**
 * `diag` 三态：`null`（没有证据）/ 空 `facts`（报了但没有标量事实）/
 * 有键（真的报了，例如 `drops: 0`）。三者的渲染与 testid 都不同。
 */
export function DiagFacts({ diag, copy }: { diag: TopologyDiagFact | null; copy: TopologyCopy }) {
  const locale = useI18nOptional()?.locale ?? "zh";
  if (!diag) {
    return (
      <p className="mt-1 text-[var(--muted-foreground)]" data-testid="forward-topology-diag-none">
        {copy.diagNone}
      </p>
    );
  }
  const entries = Object.entries(diag.facts);
  if (entries.length === 0) {
    return (
      <p className="mt-1 text-[var(--muted-foreground)]" data-testid="forward-topology-diag-empty">
        {copy.diagEmpty}
      </p>
    );
  }
  return (
    <div className="mt-1" data-testid="forward-topology-diag-facts">
      <div className="text-[var(--muted-foreground)]">
        {copy.diagFactsTitle(diag.protocol ?? "—")}
      </div>
      {diag.protocol === "both" ? <p data-testid="forward-mixed-stats-note" className="text-[var(--muted-foreground)]">{locale === "en"
        ? "Mixed runtime facts: bytes sum TCP + UDP; live connections count TCP only, live mappings, packet and drop counts are separate UDP facts. One shared total/per-IP budget. Only reported counters are shown; missing is unreported, not zero. Neither an unknown nor a failed leg is Ready; revision matches alone do not prove readiness or connectivity."
        : "混合运行态事实：字节数为 TCP + UDP 合计；活跃连接仅计 TCP，活跃映射、报文与丢弃计数分别是 UDP 事实。共用总并发与每 IP 预算。仅展示实际上报的计数；缺失是未上报，不是零。任一侧未知或失败都不能视为就绪；仅版本相同不证明就绪或连通性。"}</p> : null}
      <ul className="mt-1 space-y-0.5 font-mono">
        {entries.map(([key, value]) => (
          <li key={key}>
            {key}: {String(value)}
          </li>
        ))}
      </ul>
      {diag.truncated ? (
        <p className="mt-1 text-[var(--muted-foreground)]">{copy.diagTruncated}</p>
      ) : null}
    </div>
  );
}

/** 已加载的链路视图（纯展示、无取数；静态渲染即可覆盖全部状态）。 */
export function ForwardTopologyPanel({ state }: { state: ForwardTopologyState }) {
  const copy = useCopy();
  return (
    <section
      data-testid="forward-topology"
      className="rounded-lg border border-[var(--border)] p-4"
    >
      <header>
        <h3 className="text-sm font-medium">{copy.title}</h3>
        <p className="mt-1 text-xs text-[var(--muted-foreground)]">{copy.subtitle}</p>
      </header>
      {state.status === "loading" ? (
        <p className="mt-3 text-sm" data-testid="forward-topology-loading">
          {copy.loading}
        </p>
      ) : null}
      {state.status === "denied" ? (
        <p role="alert" className="mt-3 text-sm" data-testid="forward-topology-denied">
          {copy.deniedTitle}：{PERMISSION_DENIED}
        </p>
      ) : null}
      {state.status === "error" ? (
        <div role="alert" className="mt-3" data-testid="forward-topology-unavailable">
          <p className="text-sm font-medium">{copy.unavailableTitle}</p>
          <p className="mt-1 text-sm">{copy.unavailableBody}</p>
          <p className="mt-1 text-xs text-[var(--muted-foreground)]" data-testid="forward-topology-error-detail">
            {copy.errorCode}：{state.error?.code ?? "—"} · {state.error?.message ?? "—"}
          </p>
          <p className="mt-1 text-xs text-[var(--muted-foreground)]">{copy.unavailableNoRetry}</p>
        </div>
      ) : null}
      {state.status === "ok" && state.topology ? (
        <TopologyBody topology={state.topology} copy={copy} />
      ) : null}
    </section>
  );
}

function TopologyBody({ topology, copy }: { topology: ForwardTopology; copy: TopologyCopy }) {
  return (
    <div className="mt-3 space-y-3">
      {topology.mode === "direct" ? (
        <div data-testid="forward-topology-direct" className="rounded-md bg-[var(--muted)] p-3">
          <p className="text-sm font-medium">{copy.directLine}</p>
          <p className="mt-1 text-xs">{copy.directNote}</p>
          <p className="mt-1 text-xs text-[var(--muted-foreground)]">{copy.directNoProbe}</p>
        </div>
      ) : (
        <div>
          <p className="text-xs font-medium">{copy.relayTitle}</p>
          <ul className="mt-2 space-y-2">
            {topology.segments.map((segment) => (
              <ForwardTopologySegmentView
                key={`${segment.segment}-${segment.from.node_id}-${segment.to.node_id}`}
                segment={segment}
                copy={copy}
              />
            ))}
          </ul>
        </div>
      )}

      <div className="text-xs">
        <span className="font-medium">{copy.observedTitle}：</span>
        <span data-testid="forward-topology-observed-at">
          {topology.observed_at === null
            ? copy.observedNever
            : copy.observedAt(formatDateTime(topology.observed_at))}
        </span>
        {topology.observed_at === null ? null : (
          <span className="text-[var(--muted-foreground)]"> {copy.observedMeaning}</span>
        )}
      </div>

      {topology.stale_segments > 0 ? (
        <p className="text-xs" data-testid="forward-topology-stale">
          {copy.staleSegments(topology.stale_segments)}
        </p>
      ) : null}
    </div>
  );
}

/* ================================================================== */
/* 取数与作用域守卫（切 Workspace 丢弃晚到响应）                          */
/* ================================================================== */

/**
 * 「只接受最新一次请求」的作用域守卫。
 *
 * 切 Workspace（或换一条转发）时先 `claim()` 一次新令牌，之前所有在途响应的令牌就
 * 不再 current —— 它们是**上一个工作空间**的证据，落在新空间的屏幕上就是错的。
 * `invalidate()` 用于卸载/清理路径，语义同样是「从此旧令牌一律作废」。
 */
export interface TopologyScopeGuard {
  claim(): number;
  invalidate(): void;
  isCurrent(token: number): boolean;
}

export function createTopologyScopeGuard(): TopologyScopeGuard {
  let latest = 0;
  return {
    claim: () => ++latest,
    invalidate: () => {
      latest += 1;
    },
    isCurrent: (token) => token === latest,
  };
}

/**
 * 取一次链路，并回答「这次结果该不该落到屏幕上」。
 *
 * 返回值刻意是 `{ applied, state }` 而不是直接 setState：
 * `applied === false` 表示响应**晚到**（期间切了 Workspace 或换了转发），调用方必须丢弃它，
 * 连错误也不能显示 —— 一个属于旧空间的失败提示同样会误导用户。
 */
export async function loadTopologyState(input: {
  forwardId: ID;
  token: number;
  guard: TopologyScopeGuard;
  read?: (id: ID) => Promise<ForwardTopology>;
}): Promise<{ applied: boolean; state: ForwardTopologyState }> {
  const read = input.read ?? ((id: ID) => api.forwards.topology(id));
  try {
    const topology = await read(input.forwardId);
    const state: ForwardTopologyState = { status: "ok", topology, error: null };
    return { applied: input.guard.isCurrent(input.token), state };
  } catch (error) {
    const state: ForwardTopologyState = {
      status: "error",
      topology: null,
      error: topologyErrorInfo(error),
    };
    return { applied: input.guard.isCurrent(input.token), state };
  }
}

/**
 * 权限还没读出来时**不能**当作「没有权限」。
 *
 * `permissionsLoading === true` 期间 `can("forward:read")` 必然为 false；若直接渲染成
 * 「无权限」，用户每次进详情页都会先看到一句假指控。三种走向（等 / 无权 / 取数）
 * 必须是显式的，所以这里做成一个可断言的判定函数。
 */
export function topologyGate(input: {
  hasReadPermission: boolean;
  permissionsLoading: boolean;
}): "wait" | "denied" | "load" {
  if (input.permissionsLoading) return "wait";
  return input.hasReadPermission ? "load" : "denied";
}

/**
 * 自取数的链路卡片。
 *
 * 挂载点由集成任务决定（本文件不改 `forward-detail.tsx`）。`read` 是测试注入缝隙，
 * 生产用 `api.forwards.topology`；传它时请保持引用稳定（否则每次渲染都会重新取数）。
 */
export function ForwardTopologyCard({
  forwardId,
  read,
}: {
  forwardId: ID;
  read?: (id: ID) => Promise<ForwardTopology>;
}) {
  const { currentId, can, permissionsLoading } = useWorkspace();
  const canRead = can("forward:read");
  const [state, setState] = useState<ForwardTopologyState>(resetTopologyState);
  const guardRef = useRef<TopologyScopeGuard | null>(null);
  if (guardRef.current === null) guardRef.current = createTopologyScopeGuard();
  const guard = guardRef.current;

  useEffect(() => {
    const token = guard.claim();
    // 重置三态：切空间/切转发后，上一个作用域里的链路与错误都不再属于这块屏幕。
    setState(resetTopologyState());
    const gate = topologyGate({ hasReadPermission: canRead, permissionsLoading });
    if (gate !== "load") {
      // 权限还没读出来（wait）⇒ 保持加载态：既不发请求，也不误报"无权限"。
      if (gate === "denied") setState(deniedTopologyState());
      return () => guard.invalidate();
    }
    void loadTopologyState({ forwardId, token, guard, read }).then((result) => {
      if (result.applied) setState(result.state);
    });
    return () => guard.invalidate();
  }, [forwardId, currentId, canRead, permissionsLoading, guard, read]);

  return <ForwardTopologyPanel state={state} />;
}

/* ================================================================== */
/* F11：累计流量改用归档账本（换掉已无写入者的 legacy traffic 死列）        */
/* ================================================================== */

/** 归档账本的展示描述（窗口 / 是否含今天 / 归档延迟），供卡片与测试共用。 */
export function ledgerWindowText(summary: ForwardLedgerSummary, copy: TopologyCopy): string {
  if (summary.from === null || summary.to === null) return copy.ledgerWindowUnknown;
  return copy.ledgerWindow(summary.from, summary.to, summary.days);
}

/**
 * 「累计流量」的换源实现（F11）。
 *
 * 输入必须是 `GET /forwards/:id/traffic` 的归档账本序列（与图表、列表页**同一口径**）。
 * 空窗口渲染「无数据」而**不是** `0 B`：`0 B` 是一个测量结论，而账本只能告诉我们
 * 「没有记录」。窗口与归档延迟必须同屏出现，否则用户会把一个 14 天窗口的累计值
 * 当成实时总量。
 */
export function ForwardLedgerTotal({
  points,
  now,
}: {
  points: readonly TrafficPoint[];
  now?: Date;
}) {
  const copy = useCopy();
  const summary = summarizeForwardLedger(points, { now });
  return (
    <div data-testid="forward-ledger-total" className="text-xs">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-medium">
          {copy.ledgerTitle}
          <span className="text-[var(--muted-foreground)]">{copy.ledgerTitleSuffix}</span>
        </span>
        {summary.has_data ? (
          <span data-testid="forward-ledger-value" className="font-mono">
            {formatBytes(summary.total_bytes)}
          </span>
        ) : (
          <span data-testid="forward-ledger-no-data" className="font-medium">
            {copy.ledgerNoData}
          </span>
        )}
      </div>
      {summary.has_data ? null : (
        <p className="mt-1 text-[var(--muted-foreground)]" data-testid="forward-ledger-no-data-note">
          {copy.ledgerNoDataNote}
        </p>
      )}
      <p className="mt-1 text-[var(--muted-foreground)]" data-testid="forward-ledger-window">
        {ledgerWindowText(summary, copy)}
      </p>
      <p className="mt-1 text-[var(--muted-foreground)]" data-testid="forward-ledger-archive-lag">
        {copy.ledgerArchiveLag}
      </p>
      <p className="mt-1 text-[var(--muted-foreground)]" data-testid="forward-ledger-source">
        {copy.ledgerSource}
      </p>
    </div>
  );
}
