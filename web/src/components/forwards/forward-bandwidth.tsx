// 行为参照：ForwardX（AGPL-3.0-only）——流量面「带标签的时间窗 + 分桶 + 单位标注」的产品逻辑；
// 代码为本项目改写（复用我们自己的 `tunnel_traffic` 归档账本与既有三态/措辞纪律），未复制其实现。
// 参照溯源：docs/agent/forwardx-code-reuse.md
"use client";

/**
 * Forward 详情 · 吞吐序列（只读卡片）。
 *
 * ── 它回答什么 ──
 * "这条转发的流量**随时间**怎么变"——按天上一条序列，带**服务端给的**时间窗、聚合粒度与单位。
 * 数据源是既有的归档账本（`tunnel_traffic`，日行 + 每 10 分钟把缓冲同步进当天那一行），
 * 端点 `GET /api/forwards/:id/throughput`。
 *
 * ── 为什么不用详情页那张现成的柱状图（`GET /:id/traffic`）──
 * 那个端点会给窗口内**没有归档行的日子补 0**，于是"那天没有数据"和"那天流量是 0"
 * 在界面上长得一模一样。吞吐视图的价值恰恰在于缺口看得见，所以这里消费的是
 * **保留 `null`** 的那条投影：缺口画成空洞（并显式计数），0 画成贴地基线的一小段。
 *
 * ── 三条纪律（都有行为测试）──
 *  1. **窗口/粒度/单位全部读服务端**：`window` / `granularity` / `unit` / `archive` 只回显，
 *     前端不重算窗口、不换算单位、不把"今天"当完整日与其他天比较（`complete: false` 单独标注）；
 *  2. **缺口 ≠ 0**：`bytes === null` 不参与任何求和、不画成 0 高的柱子；文案分别说清
 *     "缺口天数"与"真的有数据的天数"；
 *  3. **空账本如实说"无数据"**：绝不出现"正常/健康/可达"，也不把"没有归档行"说成
 *     "当时没有流量"。
 *
 * 只吃 `forwardId`（自包含；挂载点由集成任务负责）。
 */

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import {
  type ForwardThroughputPoint,
  type ForwardThroughputResponse,
} from "@/lib/api/forwards";
import { useI18nOptional } from "@/components/providers";
import { useWorkspace } from "@/components/workspace/workspace-context";
import { PERMISSION_DENIED } from "@/lib/workspace-permissions";
import type { Locale } from "@/lib/i18n";
import type { ID } from "@/lib/types";
import { formatBytes } from "@/lib/utils";

/* ================================================================== */
/* 文案（zh / en；未知状态下不得出现正向结论词）                          */
/* ================================================================== */

export interface ThroughputCopy {
  title: string;
  subtitle: (granularity: string, unit: string) => string;
  loading: string;
  deniedTitle: string;
  unavailableTitle: string;
  unavailableBody: string;
  retry: string;
  windowLabel: (from: string, to: string) => string;
  windowUnknown: string;
  archiveNote: (minutes: number, tz: string) => string;
  coverage: (withData: number, missing: number) => string;
  totalLabel: string;
  avgLabel: string;
  noDataTitle: string;
  noDataBody: string;
  gapsTitle: (gaps: number) => string;
  gapNote: string;
  zeroNote: string;
  incompleteNote: string;
  scaleNote: string;
  windowDays: (days: number) => string;
}

const ZH: ThroughputCopy = {
  title: "吞吐序列",
  subtitle: (granularity, unit) =>
    `只读：来自归档账本，聚合粒度 ${granularity}，点值单位 ${unit}；窗口由服务端给出。`,
  loading: "正在读取吞吐序列…",
  deniedTitle: "没有查看吞吐序列的权限",
  unavailableTitle: "吞吐序列取不到",
  unavailableBody:
    "这次请求没有拿到数据，所以它不构成任何结论：既不能说明这条转发有问题，也不能说明它没问题。请刷新页面再试一次。",
  retry: "重新读取",
  windowLabel: (from, to) => `窗口 ${from} ~ ${to}（含端点，按日归档）`,
  windowUnknown: "窗口未知（服务端没有给出窗口）",
  archiveNote: (minutes, tz) =>
    `归档节拍：每 ${minutes} 分钟把缓冲同步进当天那一行（${tz} 日界）；今天是不完整日，最新一天最多滞后一个节拍。`,
  coverage: (withData, missing) => `窗口内 ${withData} 天有归档行、${missing} 天没有归档行（缺口）。`,
  totalLabel: "窗口内合计",
  avgLabel: "整窗平均速率",
  noDataTitle: "窗口内没有任何归档行",
  noDataBody:
    "这不是「流量为 0」：账本里这一段时间**没有任何一行**（可能还没有流量流过、节点没在跑，或者已经超出归档保留期）。因此这里不写 0，也不给任何结论。",
  gapsTitle: (gaps) => `缺口 ${gaps} 天（图上留空，不补 0）`,
  gapNote: "空洞 = 那天没有归档行；与「那天流量为 0」是两件事。",
  zeroNote: "贴地细条 = 那天有归档行、测到的流量是 0。",
  incompleteNote: "斜纹柱 = 不完整日（今天）：它的速率分母只算已过时间，不要与其他天直接比较。",
  scaleNote: "纵轴按窗口内最大值线性缩放（全为 0 时按 1 字节处理，避免除零）。",
  windowDays: (days) => `近 ${days} 天`,
};

const EN: ThroughputCopy = {
  title: "Throughput series",
  subtitle: (granularity, unit) =>
    `Read-only: from the archived ledger, ${granularity} granularity, point unit ${unit}; the window comes from the server.`,
  loading: "Reading the throughput series…",
  deniedTitle: "No permission to read the throughput series",
  unavailableTitle: "Throughput series unavailable",
  unavailableBody:
    "This request returned no data, so it carries no conclusion: it does not mean this forward is broken, and it does not mean it is fine. Reload the page and try again.",
  retry: "Read again",
  windowLabel: (from, to) => `window ${from} ~ ${to} (inclusive, daily archive)`,
  windowUnknown: "window unknown (the server did not provide one)",
  archiveNote: (minutes, tz) =>
    `Archive cadence: the buffer is folded into today's row every ${minutes} minutes (${tz} day boundary); today is incomplete, so the newest day can lag by one cadence.`,
  coverage: (withData, missing) =>
    `${withData} day(s) in the window have an archive row, ${missing} have none (gaps).`,
  totalLabel: "Total in window",
  avgLabel: "Window-average rate",
  noDataTitle: "No archive row in this window",
  noDataBody:
    "This is not traffic of 0: the ledger holds no row at all for this span (nothing has flowed yet, the node was not running, or the span is past retention). So no zero is shown, and no conclusion is drawn.",
  gapsTitle: (gaps) => `${gaps} day(s) are gaps (left empty on the chart, not filled with 0)`,
  gapNote: "An empty slot means there is no archive row for that day; that is not the same as traffic being 0.",
  zeroNote: "A hairline at the baseline means the day has a row whose measured traffic is 0.",
  incompleteNote: "Hatched bar = incomplete day (today): its rate divides by elapsed time only, so do not compare it with full days.",
  scaleNote: "The y-axis scales linearly to the window maximum (treated as 1 byte when everything is 0, to avoid dividing by zero).",
  windowDays: (days) => `Last ${days} d`,
};

const COPY: Record<Locale, ThroughputCopy> = { zh: ZH, en: EN };

function useCopy(): ThroughputCopy {
  return COPY[useI18nOptional()?.locale ?? "zh"];
}

/* ================================================================== */
/* 纯函数：几何与统计（可单独断言）                                       */
/* ================================================================== */

export interface ThroughputBar {
  date: string;
  bytes: number;
  /** 归一化高度（0..1）；`null` 的点不进这里（缺口留空）。 */
  ratio: number;
  complete: boolean;
}

export interface ThroughputGeometry {
  bars: ThroughputBar[];
  /** 缺口天数（`bytes === null`）——它不参与最大值，也不画柱。 */
  gaps: number;
  /** 有归档行、且测到的字节数为 0 的天数（与缺口是两件事）。 */
  zeroRows: number;
  /** 纵轴标度用的最大值（只看有数据的天）。 */
  maxBytes: number;
}

/**
 * 把服务端序列折算成柱状几何。
 *
 * 三条纪律在这里落地：
 *   · `bytes === null` ⇒ 不产生柱子（缺口留空），也**不参与最大值**（缺口不许拉低/拉高标度）；
 *   · `bytes === 0` ⇒ 产生一根高度 0 的柱子（与缺口在几何上就是两回事）；
 *   · 最大值只由有数据的天决定；全为 0 时按 1 字节兜底（避免 0/0）。
 */
export function throughputGeometry(
  series: readonly ForwardThroughputPoint[],
): ThroughputGeometry {
  const measured = series.filter(
    (point): point is ForwardThroughputPoint & { bytes: number } => typeof point.bytes === "number",
  );
  const maxBytes = measured.reduce((max, point) => Math.max(max, point.bytes), 0);
  const scale = maxBytes > 0 ? maxBytes : 1;
  return {
    bars: measured.map((point) => ({
      date: point.date,
      bytes: point.bytes,
      ratio: point.bytes / scale,
      complete: point.complete,
    })),
    gaps: series.length - measured.length,
    zeroRows: measured.filter((point) => point.bytes === 0).length,
    maxBytes,
  };
}

/**
 * 速率 → 人话（服务端给的是 bytes/s；**不做**窗口/单位换算，只做量纲显示）。
 *
 * ⚠️ 这里**不能**直接用 `utils.formatBytes`：它对 `(0, 1)` 区间的值会算出
 * `Math.floor(log(n)/log(1024)) === -1`，于是 `units[-1]` 是 `undefined`
 * ⇒ 渲染出 `327.68 undefined`。吞吐速率**天然落在亚字节区间**（十几 KB/天 ÷ 86400 ≈ 0.x B/s），
 * 所以这条路径必然踩到它。本函数在自己的范围内规避（<1 时按 B 保留 3 位），
 * 并把 `formatBytes` 的这条缺陷登记在交付报告里（它在 `lib/utils.ts`，不在本切片写入范围）。
 */
export function formatRate(bytesPerSecond: number): string {
  const value = Number(bytesPerSecond ?? 0);
  if (!Number.isFinite(value) || value <= 0) return "0 B/s";
  if (value < 1) return `${value.toFixed(3)} B/s`;
  return `${formatBytes(value)}/s`;
}

/* ================================================================== */
/* 取数：状态机 + 作用域守卫（切 Workspace 丢弃晚到响应）                  */
/* ================================================================== */

export interface ThroughputErrorInfo {
  code: string | null;
  message: string;
}

export function throughputErrorInfo(error: unknown): ThroughputErrorInfo {
  const data = (error as { data?: unknown } | null | undefined)?.data;
  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  const code = typeof record?.code === "string" ? record.code : null;
  return {
    code,
    message:
      error instanceof Error && error.message.trim() !== ""
        ? error.message
        : "吞吐端点没有返回可用的错误信息",
  };
}

export interface ForwardThroughputState {
  status: "loading" | "denied" | "error" | "data";
  days: number;
  response: ForwardThroughputResponse | null;
  error: ThroughputErrorInfo | null;
}

export function resetThroughputState(days = 14): ForwardThroughputState {
  return { status: "loading", days, response: null, error: null };
}

export function deniedThroughputState(days = 14): ForwardThroughputState {
  return { status: "denied", days, response: null, error: null };
}

export interface ThroughputScopeGuard {
  claim(): number;
  invalidate(): void;
  isCurrent(token: number): boolean;
}

export function createThroughputScopeGuard(): ThroughputScopeGuard {
  let latest = 0;
  return {
    claim: () => ++latest,
    invalidate: () => {
      latest += 1;
    },
    isCurrent: (token) => token === latest,
  };
}

export async function loadThroughputState(input: {
  forwardId: ID;
  days: number;
  token: number;
  guard: ThroughputScopeGuard;
  read?: (forwardId: ID, days: number) => Promise<ForwardThroughputResponse>;
}): Promise<{ applied: boolean; state: ForwardThroughputState }> {
  const read = input.read ?? ((id: ID, days: number) => api.forwards.throughput(id, days));
  try {
    const response = await read(input.forwardId, input.days);
    return {
      applied: input.guard.isCurrent(input.token),
      state: { status: "data", days: input.days, response, error: null },
    };
  } catch (error) {
    return {
      applied: input.guard.isCurrent(input.token),
      state: {
        status: "error",
        days: input.days,
        response: null,
        error: throughputErrorInfo(error),
      },
    };
  }
}

/** 权限还没读出来时不能当作「没有权限」。 */
export function throughputGate(input: {
  hasReadPermission: boolean;
  permissionsLoading: boolean;
}): "wait" | "denied" | "load" {
  if (input.permissionsLoading) return "wait";
  return input.hasReadPermission ? "load" : "denied";
}

/* ================================================================== */
/* 展示                                                                */
/* ================================================================== */

/** 窗口预设（服务端仍会自己钳制到 `limits.max_days`；这里只提供不会超限的选项）。 */
export const THROUGHPUT_WINDOW_PRESETS = [7, 14, 30, 90] as const;

/** 柱状图（纯 SVG：缺口不画柱，0 画贴地细条，不完整日画斜纹）。 */
export function ThroughputChart({ series }: { series: readonly ForwardThroughputPoint[] }) {
  const copy = useCopy();
  const geometry = throughputGeometry(series);
  const width = 720;
  const height = 160;
  const slot = series.length > 0 ? width / series.length : width;
  const barWidth = Math.max(2, slot * 0.6);
  return (
    <div data-testid="forward-throughput-chart" className="mt-2">
      <svg
        role="img"
        aria-label={copy.title}
        viewBox={`0 0 ${width} ${height}`}
        className="h-40 w-full"
        preserveAspectRatio="none"
      >
        <line
          x1={0}
          y1={height - 1}
          x2={width}
          y2={height - 1}
          stroke="currentColor"
          strokeOpacity={0.25}
        />
        {geometry.bars.map((bar, index) => {
          const barHeight = Math.max(bar.ratio * (height - 8), bar.bytes === 0 ? 1 : 2);
          return (
            <rect
              key={bar.date}
              data-testid="forward-throughput-bar"
              data-date={bar.date}
              data-complete={bar.complete ? "true" : "false"}
              x={index * slot + (slot - barWidth) / 2}
              y={height - barHeight}
              width={barWidth}
              height={barHeight}
              fill="currentColor"
              fillOpacity={bar.complete ? 0.7 : 0.35}
            />
          );
        })}
      </svg>
      <div className="mt-1 flex flex-col gap-0.5 text-xs text-[var(--muted-foreground)]">
        {geometry.gaps > 0 ? (
          <span data-testid="forward-throughput-gap-note">
            {copy.gapsTitle(geometry.gaps)} · {copy.gapNote}
          </span>
        ) : null}
        {geometry.zeroRows > 0 ? (
          <span data-testid="forward-throughput-zero-note">{copy.zeroNote}</span>
        ) : null}
        {series.some((point) => !point.complete) ? (
          <span data-testid="forward-throughput-incomplete-note">{copy.incompleteNote}</span>
        ) : null}
        <span>{copy.scaleNote}</span>
      </div>
    </div>
  );
}

/** 已取到的响应（纯展示：无数据 / 有数据 两态都如实说）。 */
export function ForwardThroughputDataView({ response }: { response: ForwardThroughputResponse }) {
  const copy = useCopy();
  const hasAnyRow = response.series.some((point) => point.bytes !== null);
  const windowText =
    response.window.from === null || response.window.to === null
      ? copy.windowUnknown
      : copy.windowLabel(response.window.from, response.window.to);
  return (
    <div data-testid="forward-throughput-body" className="mt-3 space-y-2">
      <p className="text-xs text-[var(--muted-foreground)]" data-testid="forward-throughput-window">
        {windowText}
      </p>
      <p className="text-xs text-[var(--muted-foreground)]" data-testid="forward-throughput-archive">
        {copy.archiveNote(response.archive.interval_minutes, response.window.time_zone)}
      </p>

      {hasAnyRow ? (
        <>
          <div className="flex flex-wrap items-baseline gap-3 text-xs">
            <span data-testid="forward-throughput-total">
              {copy.totalLabel}：<span className="font-mono">{formatBytes(response.summary.total_bytes)}</span>
            </span>
            <span data-testid="forward-throughput-avg">
              {copy.avgLabel}：{formatRate(response.summary.avg_rate_bps_over_window)}
            </span>
          </div>
          <ThroughputChart series={response.series} />
          <p className="text-xs" data-testid="forward-throughput-coverage">
            {copy.coverage(
              response.summary.coverage.days_with_data,
              response.summary.coverage.days_missing,
            )}
          </p>
        </>
      ) : (
        <div data-testid="forward-throughput-no-data">
          <p className="text-sm font-medium">{copy.noDataTitle}</p>
          <p className="mt-1 text-sm">{copy.noDataBody}</p>
        </div>
      )}
    </div>
  );
}

/** 纯展示面板（三态 + 窗口选择；静态渲染即可覆盖）。 */
export function ForwardThroughputPanel({
  state,
  onReload,
  onSelectDays,
}: {
  state: ForwardThroughputState;
  onReload?: () => void;
  onSelectDays?: (days: number) => void;
}) {
  const copy = useCopy();
  return (
    <section
      data-testid="forward-throughput"
      className="rounded-lg border border-[var(--border)] p-4"
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">{copy.title}</h3>
          <p className="mt-1 text-xs text-[var(--muted-foreground)]">
            {copy.subtitle(
              state.response?.granularity ?? "day",
              state.response?.unit ?? "bytes_per_second",
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {THROUGHPUT_WINDOW_PRESETS.map((days) => (
            <button
              key={days}
              type="button"
              data-testid={`forward-throughput-window-${days}`}
              aria-pressed={state.days === days}
              onClick={() => onSelectDays?.(days)}
              className="rounded border border-[var(--border)] px-2 py-0.5 text-xs"
            >
              {copy.windowDays(days)}
            </button>
          ))}
          {onReload ? (
            <button
              type="button"
              data-testid="forward-throughput-reload"
              onClick={onReload}
              className="rounded border border-[var(--border)] px-2 py-0.5 text-xs"
            >
              {copy.retry}
            </button>
          ) : null}
        </div>
      </header>

      {state.status === "loading" ? (
        <p className="mt-3 text-sm" data-testid="forward-throughput-loading">
          {copy.loading}
        </p>
      ) : null}
      {state.status === "denied" ? (
        <p role="alert" className="mt-3 text-sm" data-testid="forward-throughput-denied">
          {copy.deniedTitle}：{PERMISSION_DENIED}
        </p>
      ) : null}
      {state.status === "error" ? (
        <div role="alert" className="mt-3" data-testid="forward-throughput-unavailable">
          <p className="text-sm font-medium">{copy.unavailableTitle}</p>
          <p className="mt-1 text-sm">{copy.unavailableBody}</p>
          <p className="mt-1 text-xs text-[var(--muted-foreground)]">
            {state.error?.code ?? "—"} · {state.error?.message ?? "—"}
          </p>
        </div>
      ) : null}
      {state.status === "data" && state.response ? (
        <ForwardThroughputDataView response={state.response} />
      ) : null}
    </section>
  );
}

/**
 * 自取数的吞吐卡片（只吃 `forwardId`）。
 *
 * `read` 是测试注入缝隙；生产用 `api.forwards.throughput`。切 Workspace / 换窗口时
 * 用世代令牌作废在途请求（旧响应**不改状态**、也不弹错）。
 */
export function ForwardThroughputCard({
  forwardId,
  read,
}: {
  forwardId: ID;
  read?: (forwardId: ID, days: number) => Promise<ForwardThroughputResponse>;
}) {
  const { currentId, can, permissionsLoading } = useWorkspace();
  const canRead = can("forward:read");
  const [state, setState] = useState<ForwardThroughputState>(() => resetThroughputState());
  const guardRef = useRef<ThroughputScopeGuard | null>(null);
  if (guardRef.current === null) guardRef.current = createThroughputScopeGuard();
  const guard = guardRef.current;

  function run(days: number) {
    const token = guard.claim();
    setState(resetThroughputState(days));
    void loadThroughputState({ forwardId, days, token, guard, read }).then((result) => {
      if (result.applied) setState(result.state);
    });
  }

  useEffect(() => {
    const gate = throughputGate({ hasReadPermission: canRead, permissionsLoading });
    if (gate === "wait") return;
    if (gate === "denied") {
      guard.claim();
      setState(deniedThroughputState());
      return;
    }
    run(14);
    return () => guard.invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forwardId, currentId, canRead, permissionsLoading, guard]);

  return (
    <ForwardThroughputPanel
      state={state}
      onReload={() => run(state.days)}
      onSelectDays={(days) => run(days)}
    />
  );
}
