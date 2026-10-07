"use client";

/**
 * 用户域：**投递记录**卡片（切片 N4 —— 让"投递失败"第一次可见）。
 *
 * ── 它为什么必须存在 ──
 * 在此之前投递账本**只写不读**：被拒的目标、解不开的凭据、账本不可用，用户与管理员都看不到。
 * 一个"发失败了但界面不说"的通知系统，会把"我们通知过了"变成一句无法验证的话。
 *
 * ── 这个卡片刻意遵守的四条 ──
 *  ① **只用服务端事实**：状态、失败原因、尝试次数、是否降级、以及**汇总数字**全部来自
 *     `/api/notifications/deliveries`；前端不数、不推、不合并（两处口径必然分叉）。
 *  ② **绝不折叠**：`rejected_target` / `secret_unreadable` 各有各的人话与下一步，**不是**"正常"；
 *     遇到不认识的失败码**原样显示并标注**"本页不认识这个码"（这比猜一个解释诚实）。
 *  ③ **`degraded` 与 `failed` 正交**：降级意味着"投递时静默期机制失效 ⇒ 抑制可能失效、**可能多报**"，
 *     一次**成功**的投递也可能带这个标记，所以它单独一档、单独计数。
 *  ④ **空账本 ≠ 一切正常**：账本记录的是**尝试过的投递**；"一个渠道都没开""事实触发器没接线"
 *     这类情形后端根本不会调用投递层。所以 `total=0` 只能读作"这段时间没有投递记录"。
 *
 * ── 目标隐私 ──
 * 服务端对**所有人一律脱敏**（邮箱只留域名、chat id 全掩码、webhook 只留 origin+摘要）。
 * 本组件不做任何还原或猜测，只显示服务端给的脱敏串，并标明"已脱敏"。
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/components/providers";
import { ApiError } from "@/lib/api";
import {
  DELIVERY_FAILURE_REASON_CODES,
  notificationsApi,
  type DeliveryPage,
  type DeliveryRow,
} from "@/lib/api/notifications";
import { formatDateTime } from "@/lib/utils";
import type { Locale } from "@/lib/i18n";

/* ================================================================== */
/* 文案                                                                */
/* ================================================================== */

interface Copy {
  title: string;
  subtitle: string;
  loading: string;
  forbiddenTitle: string;
  forbiddenHint: string;
  unavailableTitle: string;
  unavailableHint: string;
  retry: string;
  emptyTitle: string;
  emptyHint: string;
  filterAll: string;
  filterFailed: string;
  filterSent: string;
  filterSending: string;
  summaryLine: string;
  degradedLine: string;
  truncatedLine: string;
  noTruncation: string;
  status: Record<string, string>;
  failureTitle: string;
  failure: Record<string, string>;
  failureUnknownCode: string;
  degradedBadge: string;
  degradedHint: string;
  attemptsLine: string;
  targetLine: string;
  targetMasked: string;
  targetNone: string;
  targetsCount: string;
  occurredLine: string;
  windowLine: string;
  sourceLine: string;
  reasonLine: string;
  errorLine: string;
  noError: string;
  channel: Record<string, string>;
}

const COPY: Record<Locale, Copy> = {
  zh: {
    title: "投递记录",
    subtitle: "本工作空间的通知投递记录（谁被通知过、有没有发出去）。失败也会留一行。",
    loading: "正在读取投递记录…",
    forbiddenTitle: "没有读取本工作空间投递记录的权限",
    forbiddenHint: "这不代表「没有失败记录」——面板没有读到任何记录，所以不显示任何状态。",
    unavailableTitle: "取不到投递记录",
    unavailableHint: "这不代表「一切正常」，也不代表「没有失败」：请重试。",
    retry: "重试",
    emptyTitle: "这段时间没有投递记录",
    emptyHint:
      "账本记录的是**尝试过的投递**：「没有记录」只说明这段时间没有投递发生（例如没有任何渠道被打开、或对应的事实触发器尚未接线）——它不是「没有失败」，更不是「通知都在正常工作」。",
    filterAll: "全部",
    filterFailed: "只看失败",
    filterSent: "只看已发送",
    filterSending: "只看发送中",
    summaryLine: "共 {total} 条：已发送 {sent}、失败 {failed}、发送中 {sending}",
    degradedLine: "其中 {degraded} 条在投递时处于降级状态（静默期机制失效 ⇒ 抑制可能失效、可能多报）",
    truncatedLine: "只显示最近 {limit} 条：还有更早的记录没有显示（不是「只有这些」）",
    noTruncation: "",
    status: {
      sent: "已发送（渠道已接受；不代表收件人已读）",
      failed: "失败",
      sending: "发送中（未收敛）",
    },
    failureTitle: "失败原因",
    failure: {
      not_configured: "渠道未配置：服务端没有打开这个渠道（或没有可用凭据），这条通知没有发出去。",
      transport_error: "传输失败：已按上限重试仍失败（对端不可达/超时/被拒收）。",
      rejected_target: "目标被拒绝：收件人形状非法或对端明确拒收。这不是「已发送」。",
      unsupported_channel: "渠道类型不在实现闭集内：这一格从未尝试投递。",
      secret_unreadable: "凭据解不开：密文存在但无法用当前主密钥解开 ⇒ 是「配置坏了」，不是「没配置」。请重新写入凭据。",
      ledger_unavailable: "账本不可用：为避免产生不可审计的投递，这次**放弃了投递**（没有发出）。",
    },
    failureUnknownCode: "本页不认识这个失败码（服务端新增？）：原样显示，不做解释。",
    degradedBadge: "降级",
    degradedHint: "投递时静默期机制（Redis）不可用，改用了进程内近似去重：抑制可能失效，可能多报。",
    attemptsLine: "尝试次数 {count}",
    targetLine: "目标（服务端脱敏）",
    targetMasked: "已脱敏",
    targetNone: "（没有目标）",
    targetsCount: "共 {count} 个目标",
    occurredLine: "发生时间",
    windowLine: "静默窗口起点",
    sourceLine: "来源",
    reasonLine: "原因码",
    errorLine: "服务端错误摘要",
    noError: "服务端没有给出错误摘要",
    channel: { email: "邮件", telegram: "Telegram", webhook: "Webhook" },
  },
  en: {
    title: "Delivery records",
    subtitle: "Notification delivery records for this workspace (who was notified, and whether it went out). Failures keep a row too.",
    loading: "Loading delivery records…",
    forbiddenTitle: "You cannot read this workspace's delivery records",
    forbiddenHint: "This does not mean “no failures”: the panel could not read anything, so no state is shown.",
    unavailableTitle: "Could not load delivery records",
    unavailableHint: "This is neither “all good” nor “no failures”: retry.",
    retry: "Retry",
    emptyTitle: "No delivery records in this period",
    emptyHint:
      "The ledger records delivery **attempts**: “no records” only means no delivery happened (e.g. no channel was enabled, or the fact trigger is not wired) — it is not “no failures”, and certainly not “notifications are working”.",
    filterAll: "All",
    filterFailed: "Failures only",
    filterSent: "Sent only",
    filterSending: "In flight only",
    summaryLine: "{total} total: {sent} sent, {failed} failed, {sending} in flight",
    degradedLine: "{degraded} of them ran in a degraded state (cooldown store unavailable ⇒ suppression may have failed, so over-reporting is possible)",
    truncatedLine: "Showing the {limit} most recent rows: earlier records exist and are not shown (not “these are all”)",
    noTruncation: "",
    status: {
      sent: "Sent (accepted by the channel; not the same as read)",
      failed: "Failed",
      sending: "In flight (not settled)",
    },
    failureTitle: "Failure reason",
    failure: {
      not_configured: "Channel not configured: the server did not enable this channel (or has no usable credential); nothing was sent.",
      transport_error: "Transport failure: retried up to the limit and still failed (unreachable, timeout, refused).",
      rejected_target: "Target rejected: the recipient shape is invalid or the peer refused it. This is not “sent”.",
      unsupported_channel: "Channel kind is outside the implemented set: this cell was never attempted.",
      secret_unreadable: "Credential cannot be decrypted: ciphertext exists but does not decrypt with the current master secret — a broken configuration, not “not configured”. Write the credential again.",
      ledger_unavailable: "Ledger unavailable: to avoid an unauditable delivery, this delivery was **abandoned** (nothing was sent).",
    },
    failureUnknownCode: "This page does not know this failure code (added by a newer server?): shown verbatim, without interpretation.",
    degradedBadge: "Degraded",
    degradedHint: "The cooldown store (Redis) was unavailable during delivery, so in-process coarse dedupe was used: suppression may have failed and over-reporting is possible.",
    attemptsLine: "{count} attempt(s)",
    targetLine: "Target (redacted by the server)",
    targetMasked: "redacted",
    targetNone: "(no target)",
    targetsCount: "{count} target(s)",
    occurredLine: "Occurred",
    windowLine: "Silence window start",
    sourceLine: "Source",
    reasonLine: "Reason code",
    errorLine: "Server error summary",
    noError: "The server provided no error summary",
    channel: { email: "Email", telegram: "Telegram", webhook: "Webhook" },
  },
};

function copy(locale: Locale): Copy {
  return COPY[locale] ?? COPY.zh;
}

function fill(template: string, params: Record<string, string | number>): string {
  return Object.entries(params).reduce((acc, [key, value]) => acc.split(`{${key}}`).join(String(value)), template);
}

/* ================================================================== */
/* 纯逻辑                                                              */
/* ================================================================== */

export type DeliveryReadState =
  | { kind: "loading" }
  | { kind: "forbidden"; message: string }
  | { kind: "unavailable"; code: string | null; message: string }
  | { kind: "ready"; page: DeliveryPage };

export type DeliveryView =
  | { kind: "loading" }
  | { kind: "forbidden"; message: string }
  | { kind: "unavailable"; code: string | null; message: string }
  | { kind: "empty"; page: DeliveryPage }
  | { kind: "ready"; page: DeliveryPage };

/** 五态：loading / forbidden / unavailable / empty / ready。`empty` 只在**真的读到 0 行**时成立。 */
export function deliveryView(read: DeliveryReadState): DeliveryView {
  if (read.kind === "loading") return { kind: "loading" };
  if (read.kind === "forbidden") return { kind: "forbidden", message: read.message };
  if (read.kind === "unavailable") return { kind: "unavailable", code: read.code, message: read.message };
  return read.page.rows.length === 0 ? { kind: "empty", page: read.page } : { kind: "ready", page: read.page };
}

export function classifyDeliveryReadError(err: unknown, fallback: string): DeliveryReadState {
  const message = err instanceof Error && err.message !== "" ? err.message : fallback;
  if (err instanceof ApiError) {
    const data = err.data && typeof err.data === "object" ? (err.data as { code?: unknown }) : null;
    const code = typeof data?.code === "string" && data.code !== "" ? data.code : null;
    if (err.status === 403) return { kind: "forbidden", message };
    return { kind: "unavailable", code, message };
  }
  return { kind: "unavailable", code: null, message };
}

/** 状态徽章的文字。**未知 status 原样显示**（不猜成"已发送"）。 */
export function deliveryStatusText(locale: Locale, status: string): string {
  const text = copy(locale);
  return Object.prototype.hasOwnProperty.call(text.status, status) ? text.status[status] : status;
}

/** 失败原因 → 人话。未知码：原样回落 + 明确标注"本页不认识"（绝不解释成"正常"）。 */
export function deliveryFailureText(
  locale: Locale,
  failureReason: string | null,
  known: boolean,
): { title: string; detail: string; known: boolean } {
  const text = copy(locale);
  if (failureReason === null) return { title: "—", detail: "", known: true };
  if (known && Object.prototype.hasOwnProperty.call(text.failure, failureReason)) {
    return { title: failureReason, detail: text.failure[failureReason], known: true };
  }
  return { title: failureReason, detail: text.failureUnknownCode, known: false };
}

/** 已知失败码集合（供测试与文案覆盖断言）。 */
export const DELIVERY_KNOWN_FAILURE_CODES = DELIVERY_FAILURE_REASON_CODES;

export function deliveryChannelText(locale: Locale, channel: string): string {
  const table = copy(locale).channel;
  return Object.prototype.hasOwnProperty.call(table, channel) ? table[channel] : channel;
}

/* ================================================================== */
/* 展示层                                                              */
/* ================================================================== */

export interface NotificationDeliveriesBodyProps {
  view: DeliveryView;
  locale: Locale;
  statusFilter: string | null;
  onFilterChange: (status: string | null) => void;
  onRetry: () => void;
}

function statusTone(status: string): string {
  if (status === "failed") return "destructive";
  if (status === "sent") return "success";
  return "muted";
}

function DeliveryRowView({ row, locale }: { row: DeliveryRow; locale: Locale }) {
  const text = copy(locale);
  const failure = deliveryFailureText(locale, row.failure_reason, row.failure_reason_known);
  return (
    <div className="flex flex-col gap-1 rounded-md border border-[var(--border)] px-3 py-2" data-testid={`delivery-row-${row.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{deliveryChannelText(locale, row.channel_kind)}</span>
        <Badge variant={statusTone(row.status) as never} data-testid={`delivery-status-${row.id}`}>
          {deliveryStatusText(locale, row.status)}
        </Badge>
        {row.degraded && (
          <Badge variant="outline" data-testid={`delivery-degraded-${row.id}`}>
            {text.degradedBadge}
          </Badge>
        )}
        <span className="field-hint" data-testid={`delivery-attempts-${row.id}`}>
          {fill(text.attemptsLine, { count: row.attempts })}
        </span>
        <span className="field-hint">{row.id}</span>
      </div>

      {row.status === "failed" && (
        <div className="flex flex-col gap-0.5" data-testid={`delivery-failure-${row.id}`}>
          <div className="text-sm">
            {text.failureTitle}：{failure.title}
          </div>
          <div className="field-hint" data-testid={`delivery-failure-detail-${row.id}`}>
            {failure.detail}
          </div>
        </div>
      )}

      {row.degraded && (
        <div className="field-hint" data-testid={`delivery-degraded-hint-${row.id}`}>
          {text.degradedHint}
        </div>
      )}

      <div className="field-hint" data-testid={`delivery-target-${row.id}`}>
        {text.targetLine}：{row.target === "" ? text.targetNone : row.target}
        {row.target_masked && row.target !== "" ? `（${text.targetMasked}）` : ""}
        {row.targets_count > 1 ? ` ${fill(text.targetsCount, { count: row.targets_count })}` : ""}
      </div>
      <div className="field-hint" data-testid={`delivery-meta-${row.id}`}>
        {text.sourceLine}：{row.source_kind} #{row.source_id}；{text.reasonLine}：{row.reason_code}；{text.occurredLine}：
        {row.occurred_at ? formatDateTime(row.occurred_at) : "-"}
      </div>
      <div className="field-hint" data-testid={`delivery-window-${row.id}`}>
        {text.windowLine}：{row.window_start ? formatDateTime(row.window_start) : "-"}
      </div>
      <div className="field-hint" data-testid={`delivery-error-${row.id}`}>
        {text.errorLine}：{row.error ?? text.noError}
      </div>
    </div>
  );
}

export function NotificationDeliveriesBody({ view, locale, statusFilter, onFilterChange, onRetry }: NotificationDeliveriesBodyProps) {
  const text = copy(locale);
  const filters: Array<{ value: string | null; label: string }> = [
    { value: null, label: text.filterAll },
    { value: "failed", label: text.filterFailed },
    { value: "sent", label: text.filterSent },
    { value: "sending", label: text.filterSending },
  ];

  return (
    <Card data-testid="notification-deliveries">
      <CardHeader>
        <CardTitle>{text.title}</CardTitle>
        <CardDescription>{text.subtitle}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {view.kind === "loading" && (
          <p className="field-hint flex items-center gap-2" data-testid="deliveries-loading">
            <Loader2 className="size-4 animate-spin" />
            {text.loading}
          </p>
        )}

        {view.kind === "forbidden" && (
          <div className="flex flex-col gap-2 rounded-md border border-[var(--border)] px-3 py-3" role="alert" data-testid="deliveries-forbidden">
            <div className="text-sm font-medium">{text.forbiddenTitle}</div>
            <div className="field-hint">{text.forbiddenHint}</div>
            <div className="field-hint" data-testid="deliveries-forbidden-detail">
              {view.message}
            </div>
            <div>
              <Button variant="outline" size="sm" onClick={onRetry} data-testid="deliveries-retry">
                {text.retry}
              </Button>
            </div>
          </div>
        )}

        {view.kind === "unavailable" && (
          <div className="flex flex-col gap-2 rounded-md border border-[var(--border)] px-3 py-3" role="alert" data-testid="deliveries-unavailable">
            <div className="text-sm font-medium">{text.unavailableTitle}</div>
            <div className="field-hint">{text.unavailableHint}</div>
            <div className="field-hint" data-testid="deliveries-unavailable-detail">
              {view.message}
            </div>
            <div>
              <Button variant="outline" size="sm" onClick={onRetry} data-testid="deliveries-retry">
                {text.retry}
              </Button>
            </div>
          </div>
        )}

        {(view.kind === "empty" || view.kind === "ready") && (
          <>
            <div className="flex flex-wrap items-center gap-2" data-testid="deliveries-filters">
              {filters.map((filter) => (
                <Button
                  key={filter.label}
                  variant={statusFilter === filter.value ? "default" : "outline"}
                  size="sm"
                  onClick={() => onFilterChange(filter.value)}
                  data-testid={`deliveries-filter-${filter.value ?? "all"}`}
                >
                  {filter.label}
                </Button>
              ))}
              <Button variant="ghost" size="sm" onClick={onRetry} data-testid="deliveries-refresh">
                <RefreshCw className="size-4" />
                {text.retry}
              </Button>
            </div>

            <div className="field-hint" data-testid="deliveries-summary">
              {fill(text.summaryLine, {
                total: view.page.summary.total,
                sent: view.page.summary.sent,
                failed: view.page.summary.failed,
                sending: view.page.summary.sending,
              })}
            </div>
            {view.page.summary.degraded > 0 && (
              <div className="field-hint" role="alert" data-testid="deliveries-degraded-summary">
                {fill(text.degradedLine, { degraded: view.page.summary.degraded })}
              </div>
            )}
            {view.page.truncated && (
              <div className="field-hint" role="alert" data-testid="deliveries-truncated">
                {fill(text.truncatedLine, { limit: view.page.limit })}
              </div>
            )}

            {view.kind === "empty" ? (
              <div className="flex flex-col gap-1" data-testid="deliveries-empty">
                <div className="text-sm font-medium">{text.emptyTitle}</div>
                <div className="field-hint">{text.emptyHint}</div>
              </div>
            ) : (
              <div className="flex flex-col gap-2" data-testid="deliveries-rows">
                {view.page.rows.map((row) => (
                  <DeliveryRowView key={row.id} row={row} locale={locale} />
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/* ================================================================== */
/* 容器                                                                */
/* ================================================================== */

export function NotificationDeliveries() {
  const { locale, t } = useI18n();
  const text = copy(locale);
  const [view, setView] = useState<DeliveryView>({ kind: "loading" });
  const [statusFilter, setStatusFilter] = useState<string | null>(null);

  const load = useCallback(
    async (status: string | null) => {
      setView({ kind: "loading" });
      try {
        const page = await notificationsApi.deliveries(status === null ? {} : { status: status as never });
        setView(deliveryView({ kind: "ready", page }));
      } catch (err) {
        setView(deliveryView(classifyDeliveryReadError(err, t("common.loadFailed"))));
      }
    },
    [t],
  );

  useEffect(() => {
    void load(statusFilter);
  }, [load, statusFilter]);

  return (
    <NotificationDeliveriesBody
      view={view}
      locale={locale}
      statusFilter={statusFilter}
      onFilterChange={setStatusFilter}
      onRetry={() => void load(statusFilter)}
    />
  );
}
