"use client";

/**
 * Forward 详情 · 延迟历史（D6 只读端点 `GET /forwards/:id/latency` 的消费点）。
 *
 * 与 `forward-topology.tsx` 同一套纪律：只做展示、不发命令、不新增后端；
 * 取不到时**不得**说成「正常 / 健康 / 可达」。
 *
 * ── 消费这份响应时最容易犯的五个错（本文件逐条兜住）──
 *
 *  1. **按 `series.length` 分支**：`no_samples` / `no_observer` / `ambiguous_target` 都返回
 *     空数组，但它们是三件不同的事（这个窗口没观测 / 按构造不可能有观测 / 拒绝在多目标里挑一个）。
 *     唯一判据是 `status`，四态各有独立 testid 与文案；
 *  2. **把 `latency_ms: null` 补成 0**：`null` = 那一次**没有测得**（失败/超时），不是 0ms。
 *     折线必须在 `null` 处**断开**（本文件的 `latencyChartRuns()` 把序列切成多段折线），
 *     不许插值、不许拉着画过去。真实数据里这两件事同时存在（集成拓扑上实测 97 个点中
 *     62 个 `null`、7 个真的 0ms），所以界面必须分别说出来；
 *  3. **把 409 `raw_window_expired` 当成「那段时间没有观测」**：前者是档案里**已经没有**那段
 *     原始样本（保留期清理），后者是 200 `no_samples`。这是两个 UI 状态，前者的下一步是
 *     「改用 hour 粒度或把窗口前移」，不是「没有数据」；
 *  4. **自己传 `node_id` / `target_key`**：维度由服务端从已授权转发推导（`target_latency_sample`
 *     没有 workspace 列，客户端指定目标就是跨租户探针）。本文件的请求体只有
 *     `granularity` 与窗口，`ForwardLatencyResponse.dimension` 只用于**回显**；
 *  5. **前端重算**：窗口、保留期、平均值、成功率一律回显服务端给的字段；`truncated: true`
 *     必须显式呈现，否则一条被截断的曲线会被当成完整曲线。
 *
 * ── 轮询 ──
 *
 * 观测节拍是 30s（节点每 30s 观测/上报一次），所以自动刷新间隔 ≥ {@link LATENCY_POLL_MS}：
 * 更快只会重复读同一份档案。且只有「会随时间变化」的状态才轮询（`ok` / `no_samples`）；
 * `no_observer` / `ambiguous_target` 是结构事实，轮询不会改变它，徒增负载。
 *
 * 文案在本文件内（zh/en 表，`useI18nOptional()` 取 locale），与 `forward-topology.tsx` 同样
 * 刻意不碰 `lib/i18n/dictionaries.ts`，避免与并行切片争抢同一个字典文件。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import {
  LATENCY_POLL_MS,
  LATENCY_WINDOW_MAX_HOURS,
  type ForwardLatencyPoint,
  type ForwardLatencyReason,
  type ForwardLatencyResponse,
  type LatencyGranularity,
} from "@/lib/api/forwards";
import { useI18nOptional } from "@/components/providers";
import { useWorkspace } from "@/components/workspace/workspace-context";
import { PERMISSION_DENIED } from "@/lib/workspace-permissions";
import type { Locale } from "@/lib/i18n";
import type { ID } from "@/lib/types";
import { formatDateTime } from "@/lib/utils";

/* ================================================================== */
/* 文案（zh / en；两侧都回避 正常 / 健康 / 可达 这类结论词）               */
/* ================================================================== */

export interface LatencyCopy {
  title: string;
  subtitle: string;
  loading: string;
  deniedTitle: string;
  unavailableTitle: string;
  unavailableBody: string;
  unavailableNoAutoRetry: string;
  errorCode: string;
  retry: string;
  refresh: string;
  refreshing: string;
  granularitySample: string;
  granularityHour: string;
  windowHours: (hours: number) => string;
  chartGap: (nullCount: number) => string;
  chartZeros: (zeroCount: number) => string;
  chartNoPoints: string;
  truncatedBanner: string;
  serverWindow: (from: string, to: string, hours: number) => string;
  dimension: (observerNodeId: number, targetKey: string) => string;
  dimensionMeaning: string;
  statusNoSamples: string;
  statusNoObserver: string;
  statusAmbiguous: (candidates: number | null) => string;
  statusOk: string;
  retentionTitle: string;
  retentionBody: string;
  retentionAction: string;
  switchToHour: string;
  windowTooLong: (maxHours: number | null, granularity: string) => string;
  reason: Record<ForwardLatencyReason, string>;
}

const ZH: LatencyCopy = {
  title: "延迟历史",
  subtitle:
    "只读：来自节点观测器（每 30s 一次）的既有档案。这条线是「某个节点看某个目标」，不是整条转发的端到端延迟。",
  loading: "正在读取延迟档案…",
  deniedTitle: "没有查看延迟历史的权限",
  unavailableTitle: "延迟历史取不到",
  unavailableBody:
    "这次请求没有拿到数据，所以它不构成任何结论：既不能说明这条线有问题，也不能说明它没问题。请刷新页面再试一次，或联系管理员。",
  unavailableNoAutoRetry: "本卡片不会自动重试：重试不会让缺失的档案出现。",
  errorCode: "后端返回",
  retry: "重新读取",
  refresh: "刷新",
  refreshing: "读取中…",
  granularitySample: "原始样本",
  granularityHour: "小时平均",
  windowHours: (hours) => `近 ${hours} 小时`,
  chartGap: (nullCount) =>
    `本窗口有 ${nullCount} 个点没有测得延迟（失败或超时）：图上断开，不补 0、不插值。`,
  chartZeros: (zeroCount) => `另有 ${zeroCount} 个点是真的 0 ms（测到了 0，不是缺失）。`,
  chartNoPoints: "窗口成立但序列里没有任何点。",
  truncatedBanner:
    "这条曲线被服务端按点数上限截断过（truncated: true）：它不是完整曲线，缺的是窗口中最新的部分。",
  serverWindow: (from, to, hours) => `服务端窗口 ${from} ~ ${to}（${hours} 小时，半开区间）`,
  dimension: (observerNodeId, targetKey) =>
    `维度：观测节点 #${observerNodeId} 观测目标 ${targetKey}`,
  dimensionMeaning:
    "维度由服务端从这条已授权的转发推导；界面不能指定节点或目标（那是跨租户边界）。",
  statusNoSamples:
    "这个窗口里没有任何观测样本（no_samples）：是数据缺口，不是 0 ms，也不是曲线没画好。换个窗口或稍后再看。",
  statusNoObserver:
    "这条转发按构造就没有可观测维度（no_observer）：面板不会用 0 去填一个从来没有过的观测。",
  statusAmbiguous: (candidates) =>
    `出口池里有多个目标（ambiguous_target）${candidates === null ? "" : `，共 ${candidates} 个`}：一次只回答一条会把其余目标的抖动藏起来，所以这里拒绝猜。请把池收敛到单个 active 目标再回来看这条曲线。`,
  statusOk: "窗口内有真实观测点。",
  retentionTitle: "这段时间的原始样本已被保留期清理",
  retentionBody:
    "这是 409 raw_window_expired：档案里已经没有那段原始样本了 —— 它不是「那段时间没有观测」（那是 200 no_samples）。不用去读「没有问题」或「当时一切顺利」这类结论。",
  retentionAction: "下一步：改用小时平均粒度，或把窗口前移到原始样本保留期内。",
  switchToHour: "改用小时平均",
  windowTooLong: (maxHours, granularity) =>
    `这个窗口超过了服务端上限（${granularity} 粒度最多 ${maxHours ?? "?"} 小时，400 window_too_long），服务端不会静默截短：请换一个更短的窗口。`,
  reason: {
    direct_not_observed:
      "DIRECT 转发由入口节点直拨目标，而节点的观测器只枚举本节点服务的出口池目标 ⇒ 这半边从来没有样本。",
    federated_egress:
      "出口腿在联邦对端的面板上：观测由那边的节点上报、落在那边的档案里；本面板只能说「我这边没有」，不能说目标没抖动。",
    no_egress_pool: "这条转发没有出口池 / 没有出口节点，因此没有可观测维度。",
    no_active_target: "出口池里没有 active 目标，因此没有可观测目标。",
    dimension_conflict:
      "出口池的主人 ≠ 这条转发的出口节点：下发事实与归属对不上，面板不挑一个信。",
    multiple_targets: "出口池有多个目标，一次只回答一条会藏起其余目标。",
  },
};

const EN: LatencyCopy = {
  title: "Latency history",
  subtitle:
    "Read-only: from the nodes' existing observability archive (one probe per 30s). This line is one node watching one target, not end-to-end latency for the forward.",
  loading: "Reading the latency archive…",
  deniedTitle: "No permission to read latency history",
  unavailableTitle: "Latency history unavailable",
  unavailableBody:
    "This request returned no data, so it carries no conclusion at all: it does not mean the line is broken, and it does not mean the line is fine. Reload the page or contact an administrator.",
  unavailableNoAutoRetry: "This card does not retry automatically: retrying cannot create missing archive.",
  errorCode: "Backend said",
  retry: "Read again",
  refresh: "Refresh",
  refreshing: "Reading…",
  granularitySample: "Raw samples",
  granularityHour: "Hourly average",
  windowHours: (hours) => `Last ${hours} h`,
  chartGap: (nullCount) =>
    `${nullCount} point(s) in this window have no measured latency (failed or timed out): the line breaks there — no zero fill, no interpolation.`,
  chartZeros: (zeroCount) => `${zeroCount} point(s) are a real 0 ms (measured as 0, not missing).`,
  chartNoPoints: "The window holds, but the series carries no point at all.",
  truncatedBanner:
    "This curve was truncated by the server at its point limit (truncated: true): it is not the full curve, and the missing part is the newest end of the window.",
  serverWindow: (from, to, hours) => `Server window ${from} ~ ${to} (${hours} h, half-open)`,
  dimension: (observerNodeId, targetKey) =>
    `Dimension: observer node #${observerNodeId} watching target ${targetKey}`,
  dimensionMeaning:
    "The dimension is derived by the server from this authorized forward; the UI cannot name a node or target (that is a cross-tenant boundary).",
  statusNoSamples:
    "No observation sample in this window (no_samples): this is a data gap, not 0 ms and not a broken chart. Try another window or look again later.",
  statusNoObserver:
    "This forward has no observable dimension by construction (no_observer): the panel will not fill a never-existing observation with 0.",
  statusAmbiguous: (candidates) =>
    `The egress pool holds more than one target (ambiguous_target)${candidates === null ? "" : `, ${candidates} in total`}: answering one series would hide the others' jitter, so this view refuses to guess. Narrow the pool to a single active target and come back.`,
  statusOk: "The window holds real observation points.",
  retentionTitle: "Raw samples for this span were removed by retention",
  retentionBody:
    "This is 409 raw_window_expired: the archive no longer holds those raw samples — it is not \"that span had no observation\" (that would be 200 no_samples). Treat it as no conclusion in either direction.",
  retentionAction: "Next step: switch to the hourly granularity, or move the window inside raw-sample retention.",
  switchToHour: "Switch to hourly",
  windowTooLong: (maxHours, granularity) =>
    `This window is over the server limit (${granularity} accepts at most ${maxHours ?? "?"} h, 400 window_too_long) and the server will not silently shorten it: pick a shorter window.`,
  reason: {
    direct_not_observed:
      "A DIRECT forward dials the target from the ingress node, while a node's observer only enumerates the egress pool targets it serves ⇒ this side never had a sample.",
    federated_egress:
      "The egress leg lives on the federated peer's panel: observations are reported by that node into that archive. This panel can only say \"I have none here\".",
    no_egress_pool: "This forward has no egress pool / no egress node, so there is no observable dimension.",
    no_active_target: "The egress pool has no active target, so there is nothing to observe.",
    dimension_conflict:
      "The edge pool owner differs from this forward's egress node: the facts disagree, and the panel will not pick one to trust.",
    multiple_targets: "The egress pool holds several targets; one series would hide the rest.",
  },
};

const COPY: Record<Locale, LatencyCopy> = { zh: ZH, en: EN };

function useCopy(): LatencyCopy {
  return COPY[useI18nOptional()?.locale ?? "zh"];
}

/* ================================================================== */
/* 折线：null 必须断开（纯函数，可单独断言）                              */
/* ================================================================== */

export interface LatencyChartPoint {
  at: string;
  latency_ms: number;
  x: number;
  y: number;
}

export interface LatencyChartGeometry {
  /** 连续可测点组成的折线段；`null` 点把序列切成多段，绝不跨过去连。 */
  runs: LatencyChartPoint[][];
  /** 没有测得延迟的点数（图上表现为断口）。 */
  nullCount: number;
  /** 真的测得 0 ms 的点数（与 `null` 是两件事，不能合并）。 */
  zeroCount: number;
  /** y 轴标度只由**可测点**决定：缺失点不许把标度拉到 0。 */
  minMs: number | null;
  maxMs: number | null;
  width: number;
  height: number;
  padding: number;
}

/**
 * 把服务端序列折算成 SVG 折线几何。
 *
 * 三条纪律在这里落地：
 *   · `latency_ms === null` 只**断口**，绝不产生一个 0 值点（也不插值）；
 *   · y 标度只用可测点计算，因此一个缺失点不会把整条线压扁；
 *   · x 按**点在序列里的序位**均匀铺开（而不是按时间差重新分箱）——面板不重算横轴，
 *     时间真相由服务端点自带的 `at` 承担（渲染时逐段显示）。
 */
export function latencyChartGeometry(
  points: readonly ForwardLatencyPoint[],
  options?: { width?: number; height?: number; padding?: number },
): LatencyChartGeometry {
  const width = options?.width ?? 600;
  const height = options?.height ?? 160;
  const padding = options?.padding ?? 8;
  const measured = points
    .map((point) => (typeof point.latency_ms === "number" && Number.isFinite(point.latency_ms)
      ? point.latency_ms
      : null))
    .filter((value): value is number => value !== null);
  const minMs = measured.length > 0 ? Math.min(...measured) : null;
  const maxMs = measured.length > 0 ? Math.max(...measured) : null;
  const span = minMs === null || maxMs === null ? 0 : maxMs - minMs;
  const innerW = Math.max(1, width - padding * 2);
  const innerH = Math.max(1, height - padding * 2);
  // 所有可测点都一样时的退化情形：画在中线，而不是贴着底边（贴着底边看起来像 0）。
  const ratio = (value: number): number => {
    if (minMs === null || maxMs === null) return 0.5;
    return span === 0 ? 0.5 : (value - minMs) / span;
  };

  const runs: LatencyChartPoint[][] = [];
  let current: LatencyChartPoint[] = [];
  let nullCount = 0;
  let zeroCount = 0;
  points.forEach((point, index) => {
    const value = point.latency_ms;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      nullCount += 1;
      if (current.length > 0) runs.push(current);
      current = [];
      return;
    }
    if (value === 0) zeroCount += 1;
    const x = padding + (points.length <= 1 ? 0 : (index / (points.length - 1)) * innerW);
    const y = padding + innerH - ratio(value) * innerH;
    current.push({ at: point.at, latency_ms: value, x, y });
  });
  if (current.length > 0) runs.push(current);

  return { runs, nullCount, zeroCount, minMs, maxMs, width, height, padding };
}

/* ================================================================== */
/* 取数：状态机 + 作用域守卫 + 轮询节流                                   */
/* ================================================================== */

export type LatencyQuery = { granularity: LatencyGranularity; hours: number };

/** 界面侧的错误信息（后端 `code` + 原文 + 保留期/上限等补充字段）。 */
export interface LatencyErrorInfo {
  code: string | null;
  message: string;
  layer: string | null;
  /** 400 `window_too_long` 时后端给的上限（小时）；其他错误为 `null`。 */
  maxHours: number | null;
}

export function latencyErrorInfo(error: unknown): LatencyErrorInfo {
  const data = (error as { data?: unknown } | null | undefined)?.data;
  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  const code = typeof record?.code === "string" ? record.code : null;
  const layer = typeof record?.error_layer === "string" ? record.error_layer : null;
  const extra = record?.data && typeof record.data === "object"
    ? (record.data as Record<string, unknown>)
    : null;
  const maxHours = typeof extra?.max_hours === "number" ? extra.max_hours : null;
  return {
    code,
    message: error instanceof Error && error.message.trim() !== ""
      ? error.message
      : "延迟接口没有返回可用的错误信息",
    layer,
    maxHours,
  };
}

export interface ForwardLatencyState {
  status: "loading" | "denied" | "error" | "data";
  query: LatencyQuery;
  response: ForwardLatencyResponse | null;
  error: LatencyErrorInfo | null;
}

export function resetLatencyState(query: LatencyQuery): ForwardLatencyState {
  return { status: "loading", query, response: null, error: null };
}

export function deniedLatencyState(query: LatencyQuery): ForwardLatencyState {
  return { status: "denied", query, response: null, error: null };
}

/** 与拓扑卡片同一套「只接受最新请求」的守卫（本文件自带一份以保持自包含）。 */
export interface LatencyScopeGuard {
  claim(): number;
  invalidate(): void;
  isCurrent(token: number): boolean;
}

export function createLatencyScopeGuard(): LatencyScopeGuard {
  let latest = 0;
  return {
    claim: () => ++latest,
    invalidate: () => {
      latest += 1;
    },
    isCurrent: (token) => token === latest,
  };
}

export async function loadLatencyState(input: {
  forwardId: ID;
  query: LatencyQuery;
  token: number;
  guard: LatencyScopeGuard;
  read?: (forwardId: ID, query: LatencyQuery) => Promise<ForwardLatencyResponse>;
}): Promise<{ applied: boolean; state: ForwardLatencyState }> {
  const read =
    input.read ?? ((id: ID, query: LatencyQuery) => api.forwards.latency(id, query));
  try {
    const response = await read(input.forwardId, input.query);
    return {
      applied: input.guard.isCurrent(input.token),
      state: { status: "data", query: input.query, response, error: null },
    };
  } catch (error) {
    return {
      applied: input.guard.isCurrent(input.token),
      state: {
        status: "error",
        query: input.query,
        response: null,
        error: latencyErrorInfo(error),
      },
    };
  }
}

/**
 * 权限还没读出来时不能当作「没有权限」（同 `forward-topology.tsx:topologyGate`）。
 */
export function latencyGate(input: {
  hasReadPermission: boolean;
  permissionsLoading: boolean;
}): "wait" | "denied" | "load" {
  if (input.permissionsLoading) return "wait";
  return input.hasReadPermission ? "load" : "denied";
}

/**
 * 该不该自动刷新（以及多久一次）。
 *
 *   · `error` / `denied` / 还没取到 ⇒ 不轮询（错误不许自动重试；403 重试还是 403）；
 *   · `no_observer` / `ambiguous_target` ⇒ 不轮询：它们是**结构事实**（这条转发按构造没有
 *     维度 / 池里有多个目标），30 秒后问一次不会改变答案；
 *   · `ok` / `no_samples` ⇒ 按观测节拍（30s）刷新：这两个状态会随时间变化。
 */
export function latencyPollIntervalMs(state: ForwardLatencyState): number | null {
  if (state.status !== "data" || state.response === null) return null;
  if (state.response.status === "ok" || state.response.status === "no_samples") {
    return LATENCY_POLL_MS;
  }
  return null;
}

/* ================================================================== */
/* 展示                                                                */
/* ================================================================== */

/** 粒度 + 窗口预设（服务端仍会自己校验；这里只提供不会超限的选项）。 */
const PRESETS: Record<LatencyGranularity, number[]> = {
  sample: [1, 6, LATENCY_WINDOW_MAX_HOURS.sample],
  hour: [24, 168, LATENCY_WINDOW_MAX_HOURS.hour],
};

const DEFAULT_QUERY: LatencyQuery = { granularity: "sample", hours: 1 };

/** 折线图（纯 SVG：`null` 处天然断开，不依赖任何"connectNulls"开关）。 */
export function LatencyChart({ response }: { response: ForwardLatencyResponse }) {
  const copy = useCopy();
  const geometry = latencyChartGeometry(response.series);
  const { runs, width, height, padding } = geometry;
  return (
    <div data-testid="forward-latency-chart" className="mt-2">
      <svg
        role="img"
        aria-label={copy.title}
        viewBox={`0 0 ${width} ${height}`}
        className="h-40 w-full"
        preserveAspectRatio="none"
      >
        <line
          x1={padding}
          y1={height - padding}
          x2={width - padding}
          y2={height - padding}
          stroke="currentColor"
          strokeOpacity={0.2}
        />
        {runs.map((run, index) => (
          <polyline
            key={`${run[0]?.at ?? "run"}-${index}`}
            data-testid="forward-latency-run"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            points={run.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ")}
          />
        ))}
        {runs.length === 1 && runs[0]!.length === 1 ? (
          <circle
            cx={runs[0]![0]!.x}
            cy={runs[0]![0]!.y}
            r={2}
            fill="currentColor"
          />
        ) : null}
      </svg>
      <p className="mt-1 text-xs" data-testid="forward-latency-counts">
        {geometry.nullCount > 0 ? copy.chartGap(geometry.nullCount) : copy.statusOk}
        {geometry.zeroCount > 0 ? ` ${copy.chartZeros(geometry.zeroCount)}` : ""}
      </p>
    </div>
  );
}

/** 已取到的响应（纯展示，四态各有独立 testid）。 */
export function ForwardLatencyDataView({ response }: { response: ForwardLatencyResponse }) {
  const copy = useCopy();
  return (
    <div data-testid="forward-latency-body" className="mt-3 space-y-2">
      {response.truncated ? (
        <p
          data-testid="forward-latency-truncated"
          className="rounded bg-amber-50 p-2 text-xs dark:bg-amber-950"
        >
          {copy.truncatedBanner}
        </p>
      ) : null}

      {response.status === "ok" ? (
        <div data-testid="forward-latency-ok">
          {response.series.length === 0 ? (
            <p className="text-xs">{copy.chartNoPoints}</p>
          ) : (
            <LatencyChart response={response} />
          )}
        </div>
      ) : null}

      {response.status === "no_samples" ? (
        <p data-testid="forward-latency-no-samples" className="text-sm">
          {copy.statusNoSamples}
        </p>
      ) : null}

      {response.status === "no_observer" ? (
        <div data-testid="forward-latency-no-observer" className="text-sm">
          <p>{copy.statusNoObserver}</p>
          {response.reason ? (
            <p data-testid="forward-latency-reason" className="mt-1 text-xs">
              {copy.reason[response.reason]}
            </p>
          ) : null}
        </div>
      ) : null}

      {response.status === "ambiguous_target" ? (
        <div data-testid="forward-latency-ambiguous" className="text-sm">
          <p>{copy.statusAmbiguous(response.candidate_targets ?? null)}</p>
          {response.reason ? (
            <p data-testid="forward-latency-reason" className="mt-1 text-xs">
              {copy.reason[response.reason]}
            </p>
          ) : null}
        </div>
      ) : null}

      <p className="text-xs text-[var(--muted-foreground)]" data-testid="forward-latency-server-window">
        {copy.serverWindow(
          formatDateTime(response.window.from),
          formatDateTime(response.window.to),
          response.window.hours,
        )}
      </p>
      {response.dimension ? (
        <div className="text-xs text-[var(--muted-foreground)]" data-testid="forward-latency-dimension">
          <div>{copy.dimension(response.dimension.observer_node_id, response.dimension.target_key)}</div>
          <div>{copy.dimensionMeaning}</div>
        </div>
      ) : (
        <p className="text-xs text-[var(--muted-foreground)]" data-testid="forward-latency-dimension-none">
          {copy.dimensionMeaning}
        </p>
      )}
    </div>
  );
}

export interface ForwardLatencyPanelProps {
  state: ForwardLatencyState;
  /** 手工刷新（用户主动；卡片仍然不会自动重试失败）。 */
  onReload?: () => void;
  onSelectQuery?: (query: LatencyQuery) => void;
  busy?: boolean;
}

/** 纯展示面板：四态 + 409 与「无样本」分开（静态渲染即可覆盖）。 */
export function ForwardLatencyPanel({
  state,
  onReload,
  onSelectQuery,
  busy,
}: ForwardLatencyPanelProps) {
  const copy = useCopy();
  const expired = state.error?.code === "raw_window_expired";
  const tooLong = state.error?.code === "window_too_long";
  return (
    <section data-testid="forward-latency" className="rounded-lg border border-[var(--border)] p-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">{copy.title}</h3>
          <p className="mt-1 text-xs text-[var(--muted-foreground)]">{copy.subtitle}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {(["sample", "hour"] as const).map((granularity) => (
            <button
              key={granularity}
              type="button"
              data-testid={`forward-latency-granularity-${granularity}`}
              aria-pressed={state.query.granularity === granularity}
              onClick={() =>
                onSelectQuery?.({
                  granularity,
                  hours:
                    granularity === state.query.granularity
                      ? state.query.hours
                      : (PRESETS[granularity][0] as number),
                })
              }
              className="rounded border border-[var(--border)] px-2 py-0.5 text-xs"
            >
              {granularity === "sample" ? copy.granularitySample : copy.granularityHour}
            </button>
          ))}
          {onReload ? (
            <button
              type="button"
              data-testid="forward-latency-reload"
              onClick={onReload}
              disabled={busy}
              className="rounded border border-[var(--border)] px-2 py-0.5 text-xs disabled:opacity-50"
            >
              {busy ? copy.refreshing : copy.refresh}
            </button>
          ) : null}
        </div>
      </header>

      <div className="mt-2 flex flex-wrap gap-1">
        {PRESETS[state.query.granularity].map((hours) => (
          <button
            key={hours}
            type="button"
            data-testid={`forward-latency-window-${hours}`}
            aria-pressed={state.query.hours === hours}
            onClick={() => onSelectQuery?.({ granularity: state.query.granularity, hours })}
            className="rounded border border-[var(--border)] px-2 py-0.5 text-xs"
          >
            {copy.windowHours(hours)}
          </button>
        ))}
      </div>

      {state.status === "loading" ? (
        <p className="mt-3 text-sm" data-testid="forward-latency-loading">
          {copy.loading}
        </p>
      ) : null}

      {state.status === "denied" ? (
        <p role="alert" className="mt-3 text-sm" data-testid="forward-latency-denied">
          {copy.deniedTitle}：{PERMISSION_DENIED}
        </p>
      ) : null}

      {state.status === "error" ? (
        <div role="alert" className="mt-3" data-testid={expired ? "forward-latency-window-expired" : "forward-latency-unavailable"}>
          <p className="text-sm font-medium">
            {expired ? copy.retentionTitle : copy.unavailableTitle}
          </p>
          <p className="mt-1 text-sm">{expired ? copy.retentionBody : copy.unavailableBody}</p>
          {tooLong ? (
            <p className="mt-1 text-sm" data-testid="forward-latency-window-too-long">
              {copy.windowTooLong(state.error?.maxHours ?? null, state.query.granularity)}
            </p>
          ) : null}
          <p className="mt-1 text-xs text-[var(--muted-foreground)]" data-testid="forward-latency-error-detail">
            {copy.errorCode}：{state.error?.code ?? "—"} · {state.error?.message ?? "—"}
          </p>
          {expired ? (
            <p className="mt-1 text-xs" data-testid="forward-latency-retention-action">
              {copy.retentionAction}{" "}
              <button
                type="button"
                data-testid="forward-latency-switch-hour"
                onClick={() => onSelectQuery?.({ granularity: "hour", hours: PRESETS.hour[0] as number })}
                className="underline"
              >
                {copy.switchToHour}
              </button>
            </p>
          ) : (
            <p className="mt-1 text-xs text-[var(--muted-foreground)]">{copy.unavailableNoAutoRetry}</p>
          )}
        </div>
      ) : null}

      {state.status === "data" && state.response ? (
        <ForwardLatencyDataView response={state.response} />
      ) : null}
    </section>
  );
}

/**
 * 自取数的延迟卡片（只吃 `forwardId`；挂载点由集成任务决定）。
 *
 * `read` 是测试注入缝隙，生产用 `api.forwards.latency`；传它时请保持引用稳定。
 * `pollMs` 覆盖自动刷新间隔（默认 {@link LATENCY_POLL_MS} = 观测节拍 30s）。
 */
export function ForwardLatencyCard({
  forwardId,
  read,
  pollMs = LATENCY_POLL_MS,
}: {
  forwardId: ID;
  read?: (forwardId: ID, query: LatencyQuery) => Promise<ForwardLatencyResponse>;
  pollMs?: number;
}) {
  const { currentId, can, permissionsLoading } = useWorkspace();
  const canRead = can("forward:read");
  const [state, setState] = useState<ForwardLatencyState>(() => resetLatencyState(DEFAULT_QUERY));
  const [busy, setBusy] = useState(false);
  const guardRef = useRef<LatencyScopeGuard | null>(null);
  if (guardRef.current === null) guardRef.current = createLatencyScopeGuard();
  const guard = guardRef.current;
  // 同一时刻只允许一个在途请求：手动刷新与轮询不许互相叠加。
  const inFlightRef = useRef(false);

  const run = useCallback(
    (query: LatencyQuery, options?: { keepState?: boolean }) => {
      const token = guard.claim();
      if (!options?.keepState) setState(resetLatencyState(query));
      setBusy(true);
      inFlightRef.current = true;
      void loadLatencyState({ forwardId, query, token, guard, read })
        .then((result) => {
          if (result.applied) setState(result.state);
        })
        .finally(() => {
          inFlightRef.current = false;
          setBusy(false);
        });
    },
    [forwardId, guard, read],
  );

  useEffect(() => {
    const gate = latencyGate({ hasReadPermission: canRead, permissionsLoading });
    if (gate === "wait") return;
    if (gate === "denied") {
      guard.claim();
      setState(deniedLatencyState(DEFAULT_QUERY));
      return;
    }
    run(DEFAULT_QUERY);
    return () => guard.invalidate();
  }, [currentId, canRead, permissionsLoading, guard, run]);

  // 自动刷新：只有会随时间变化的状态才轮询（见 latencyPollIntervalMs 的三条口径）。
  useEffect(() => {
    const interval = latencyPollIntervalMs(state);
    if (interval === null || pollMs <= 0) return;
    const timer = setInterval(() => {
      if (inFlightRef.current) return; // 上一次还没回来，跳过这一拍（节流）
      run(state.query, { keepState: true });
    }, Math.max(pollMs, interval));
    return () => clearInterval(timer);
  }, [state, pollMs, run]);

  return (
    <ForwardLatencyPanel
      state={state}
      busy={busy}
      onReload={() => run(state.query, { keepState: true })}
      onSelectQuery={(query) => run(query)}
    />
  );
}
