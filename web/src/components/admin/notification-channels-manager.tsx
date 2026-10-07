"use client";

/**
 * Admin 域：**平台级通知渠道配置**（切片 N2-UI，消费 task-10 的端点）。
 *
 * ── 这个页面存在的唯一理由：让"配置好了"不再是一句无从验证的话 ──
 * task-10 交付了读写端点，但没有界面时，退出条件 #6（Notification 可以从 UI 配置）不成立。
 * 界面本身的风险不在"能不能提交表单"，而在**它会不会撒谎**。所以这个组件把三件事当第一等公民：
 *
 *  ① **凭据只写不读**：telegram token / webhook URL 一律**非受控**（`ref` 读，成功后立刻清空），
 *     从不回填、从不进 React state；服务端回显的 `value` 恒为空串，界面只显示 `secret_configured`。
 *  ② **`secret_state` 三态分开展示**：`unset`（没配过）/ `sealed`（密文在且能解开）/
 *     `unreadable`（密文在但**解不开 = 配置坏了**）。把第三种折叠成"未配置"就是掩盖一次密钥事故。
 *  ③ **"保存成功 ≠ 会被投递"**：直接渲染服务端的 `delivery_kinds`（注册表 / 已开启 / 公告实际用）
 *     与 `warnings` —— **不在前端推**，前端只负责把它们说清楚。
 *
 * 另外两条既有教训也在这里兑现：**403 不得渲染成"暂无渠道"**（五态里 `forbidden` 是独立一态）；
 * 表**没有唯一索引** ⇒ 同一 kind 多行是真实状态，界面按 id 逐行展示、并把服务端的多行 warning
 * 原样贴出来（不假装"一个渠道一行"）。
 *
 * ── 文案为什么就地存放 ──
 * `lib/i18n/dictionaries.ts` 是共享热点（本切片不持有它），因此按 `lib/*-i18n.ts` 的取向把中英文
 * 放在本文件内的 `COPY` 里；需要收口时再整体搬走。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Separator } from "@/components/ui/card";
import { Switch } from "@/components/ui/form";
import { Input, Label } from "@/components/ui/input";
import { useI18n } from "@/components/providers";
import { ApiError } from "@/lib/api";
import {
  notificationAdminApi,
  type DeliveryKinds,
  type NotificationChannelPermission,
  type NotificationChannelRow,
  type NotificationChannelsPayload,
  type SecretState,
} from "@/lib/api/notification-admin";
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
  refresh: string;
  emptyTitle: string;
  emptyHint: string;
  deliveryTitle: string;
  deliveryRegistered: string;
  deliveryEnabled: string;
  deliveryAnnouncement: string;
  deliverySaveNotDelivery: string;
  deliveryNoneRegistered: string;
  deliveryNoneEnabled: string;
  warningsTitle: string;
  warningSavedNotDelivered: string;
  rowsTitle: string;
  rowId: string;
  rowKind: string;
  rowEnabled: string;
  rowTarget: string;
  rowMasked: string;
  rowNoTarget: string;
  rowCreatedAt: string;
  rowConfigLoaded: string;
  rowConfigNotLoaded: string;
  secretLabel: string;
  secretState: Record<SecretState, string>;
  secretStateHint: Record<SecretState, string>;
  permission: Record<"unknown" | "read" | "write", string>;
  telegramTitle: string;
  telegramHint: string;
  telegramToken: string;
  telegramTokenPlaceholder: string;
  telegramTokenHint: string;
  telegramEnabled: string;
  telegramSave: string;
  telegramSaved: string;
  telegramCleared: string;
  removeAllOfKind: string;
  confirmRemove: string;
  cancel: string;
  remove: string;
  webhookTitle: string;
  webhookHint: string;
  webhookTarget: string;
  webhookTargetPlaceholder: string;
  webhookTargetHint: string;
  webhookEnabled: string;
  webhookSave: string;
  webhookSaved: string;
  saved: string;
  savedGeneric: string;
  removed: string;
  actionForbidden: string;
  actionRejected: string;
  actionUnavailable: string;
  emailNote: string;
}

const COPY: Record<Locale, Copy> = {
  zh: {
    title: "通知渠道",
    subtitle: "平台级渠道配置：凭据只写不读，界面只显示「配没配」。",
    loading: "正在读取通知渠道配置…",
    forbiddenTitle: "当前管理员角色没有读取通知渠道的权限",
    forbiddenHint:
      "该功能需要资源键 notification_channels 的读权限；这个提示**不是**「还没有配置渠道」——面板没有读到任何渠道，所以不显示任何渠道状态。",
    unavailableTitle: "取不到通知渠道配置",
    unavailableHint: "这不代表「一个渠道都没配」——请重试。",
    retry: "重试",
    refresh: "重新读取",
    emptyTitle: "还没有配置任何平台级通知渠道",
    emptyHint: "这是真的读到了、且一行都没有（≠ 取不到）。下面的投递状态仍然反映服务端此刻的事实。",
    deliveryTitle: "投递状态（服务端推导）",
    deliveryRegistered: "投递注册表支持的渠道",
    deliveryEnabled: "本安装已开启的渠道",
    deliveryAnnouncement: "公告实际会走的渠道",
    deliverySaveNotDelivery: "保存成功只代表服务端记下了配置：它不会让未接线的渠道开始投递，也不会打开部署级的渠道开关。",
    deliveryNoneRegistered: "（空）",
    deliveryNoneEnabled: "（空）",
    warningsTitle: "服务端的告警",
    warningSavedNotDelivered: "",
    rowsTitle: "已配置的行",
    rowId: "行 id",
    rowKind: "渠道",
    rowEnabled: "启用",
    rowTarget: "目标（服务端脱敏后）",
    rowMasked: "已脱敏",
    rowNoTarget: "（没有目标）",
    rowCreatedAt: "创建于",
    rowConfigLoaded: "被渠道配置加载器读取",
    rowConfigNotLoaded: "未被加载器读取（停用 / 不是生效行 / 渠道未接线）",
    secretLabel: "凭据",
    secretState: {
      unset: "没有凭据",
      sealed: "凭据已封存（可解开）",
      unreadable: "凭据解不开（配置坏了）",
    },
    secretStateHint: {
      unset: "这一行没有密文：需要写入凭据才能投递。",
      sealed: "密文存在，且能用当前主密钥解开。",
      unreadable: "密文存在但**解不开**（主密钥被轮换过、或被截断/损坏）——这是「配置坏了」，不是「没配置」：请重新写入凭据，不要当成一切正常。",
    },
    permission: {
      unknown: "权限尚未确定：先按只读处理。",
      read: "只读（需要 notification_channels 的写权限才能修改）。",
      write: "可读写。",
    },
    telegramTitle: "Telegram",
    telegramHint: "平台一个 bot token 对应一个 bot；凭据写入后不再回显。",
    telegramToken: "Bot token（只写不读）",
    telegramTokenPlaceholder: "粘贴 bot token（形如 123456789:AA…）",
    telegramTokenHint: "提交后立即从输入框清除，不回填、不显示、不进 URL/日志。留空表示只改「启用」开关。",
    telegramEnabled: "启用这条渠道配置",
    telegramSave: "保存 Telegram 配置",
    telegramSaved: "Telegram 配置已保存（凭据不再回显）",
    telegramCleared: "输入框已清空",
    removeAllOfKind: "移除该渠道的全部配置",
    confirmRemove: "确认移除",
    cancel: "取消",
    remove: "移除",
    webhookTitle: "Webhook",
    webhookHint: "每一行是一个独立接收方（URL 就是这一行的身份：同 URL 更新、新 URL 新增）。",
    webhookTarget: "Webhook URL（只写不读）",
    webhookTargetPlaceholder: "https://hooks.example.com/…",
    webhookTargetHint: "URL 本身就是凭据：服务端只回显 origin + 摘要，原文不会回到页面。",
    webhookEnabled: "启用这个接收方",
    webhookSave: "添加 / 更新 Webhook",
    webhookSaved: "Webhook 已保存",
    saved: "已保存",
    savedGeneric: "配置已保存",
    removed: "已移除",
    actionForbidden: "当前管理员角色没有写权限（需要 notification_channels 的写权限）：这次没有做任何修改。",
    actionRejected: "服务端拒绝了这次提交（未修改任何配置）",
    actionUnavailable: "这次没写进去（存储暂时不可用），可以重试",
    emailNote: "email 渠道的凭据来自部署级 SMTP 配置（不在本页；见部署文档）。",
  },
  en: {
    title: "Notification channels",
    subtitle: "Platform-level channel configuration. Credentials are write-only; the UI only shows whether one is set.",
    loading: "Loading notification channel configuration…",
    forbiddenTitle: "This admin role cannot read notification channel configuration",
    forbiddenHint:
      "Reading requires the notification_channels resource key. This is NOT “no channel is configured” — the panel could not read anything, so no channel state is shown.",
    unavailableTitle: "Could not load notification channel configuration",
    unavailableHint: "This does not mean “no channel is configured” — retry.",
    retry: "Retry",
    refresh: "Reload",
    emptyTitle: "No platform-level notification channel is configured yet",
    emptyHint: "This is a real read with zero rows (not a failure). The delivery state below still reflects the server's current facts.",
    deliveryTitle: "Delivery state (derived by the server)",
    deliveryRegistered: "Kinds in the delivery registry",
    deliveryEnabled: "Kinds enabled on this install",
    deliveryAnnouncement: "Kinds announcements actually use",
    deliverySaveNotDelivery:
      "Saving only records the configuration: it does not start delivering on channels that are not wired, and it does not flip deployment-level switches on.",
    deliveryNoneRegistered: "(none)",
    deliveryNoneEnabled: "(none)",
    warningsTitle: "Server warnings",
    warningSavedNotDelivered: "",
    rowsTitle: "Configured rows",
    rowId: "Row id",
    rowKind: "Kind",
    rowEnabled: "Enabled",
    rowTarget: "Target (redacted by the server)",
    rowMasked: "redacted",
    rowNoTarget: "(no target)",
    rowCreatedAt: "Created",
    rowConfigLoaded: "Read by the channel config loader",
    rowConfigNotLoaded: "Not read by the loader (disabled / not the effective row / kind not wired)",
    secretLabel: "Credential",
    secretState: {
      unset: "No credential",
      sealed: "Credential sealed (decryptable)",
      unreadable: "Credential cannot be decrypted (broken config)",
    },
    secretStateHint: {
      unset: "This row has no ciphertext: a credential is required before anything can be delivered.",
      sealed: "The ciphertext exists and decrypts with the current master secret.",
      unreadable:
        "The ciphertext exists but does NOT decrypt (master secret rotated, or the ciphertext is truncated/corrupt). This is a broken configuration, not “not configured”: write the credential again and do not treat it as healthy.",
    },
    permission: {
      unknown: "Permission unknown: treated as read-only for now.",
      read: "Read-only (writing needs the notification_channels write level).",
      write: "Read/write.",
    },
    telegramTitle: "Telegram",
    telegramHint: "One platform bot token maps to one bot; the credential is never echoed back.",
    telegramToken: "Bot token (write-only)",
    telegramTokenPlaceholder: "Paste the bot token (e.g. 123456789:AA…)",
    telegramTokenHint: "Cleared from the input right after submit — never refilled, never shown, never in the URL or logs. Leave empty to only change the enabled switch.",
    telegramEnabled: "Enable this channel configuration",
    telegramSave: "Save Telegram configuration",
    telegramSaved: "Telegram configuration saved (credential no longer shown)",
    telegramCleared: "Input cleared",
    removeAllOfKind: "Remove all configuration of this channel",
    confirmRemove: "Confirm removal",
    cancel: "Cancel",
    remove: "Remove",
    webhookTitle: "Webhook",
    webhookHint: "Each row is an independent receiver (the URL is the row's identity: same URL updates, new URL inserts).",
    webhookTarget: "Webhook URL (write-only)",
    webhookTargetPlaceholder: "https://hooks.example.com/…",
    webhookTargetHint: "The URL itself is a credential: the server only returns origin + digest; the raw value never comes back.",
    webhookEnabled: "Enable this receiver",
    webhookSave: "Add / update webhook",
    webhookSaved: "Webhook saved",
    saved: "Saved",
    savedGeneric: "Configuration saved",
    removed: "Removed",
    actionForbidden: "This admin role has no write level (notification_channels write is required): nothing was changed.",
    actionRejected: "The server rejected this submission (nothing was changed)",
    actionUnavailable: "This write did not go through (store temporarily unavailable); you can retry",
    emailNote: "The email channel credential comes from deployment-level SMTP configuration (not this page; see the deployment docs).",
  },
};

function copy(locale: Locale): Copy {
  return COPY[locale] ?? COPY.zh;
}

/* ================================================================== */
/* 纯逻辑（可离线驱动的部分）                                            */
/* ================================================================== */

export type ChannelsReadState =
  | { kind: "loading" }
  /** 读都没权限（403）：**不是**"暂无渠道"。 */
  | { kind: "forbidden"; message: string }
  | { kind: "unavailable"; code: string | null; message: string }
  | { kind: "ready"; payload: NotificationChannelsPayload };

export type ChannelsView =
  | { kind: "loading" }
  | { kind: "forbidden"; message: string }
  | { kind: "unavailable"; code: string | null; message: string }
  | { kind: "empty"; payload: NotificationChannelsPayload }
  | { kind: "ready"; payload: NotificationChannelsPayload };

/** 五态：loading / forbidden / unavailable / empty / ready。`empty` 只在**真的读到 0 行**时成立。 */
export function notificationChannelsView(read: ChannelsReadState): ChannelsView {
  if (read.kind === "loading") return { kind: "loading" };
  if (read.kind === "forbidden") return { kind: "forbidden", message: read.message };
  if (read.kind === "unavailable") return { kind: "unavailable", code: read.code, message: read.message };
  return read.payload.channels.length === 0
    ? { kind: "empty", payload: read.payload }
    : { kind: "ready", payload: read.payload };
}

export interface AdminActionFailure {
  kind: "forbidden" | "rejected" | "unavailable";
  code: string | null;
  message: string;
}

function errorCodeOf(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const data = err.data;
  if (!data || typeof data !== "object") return null;
  const code = (data as { code?: unknown }).code;
  return typeof code === "string" && code !== "" ? code : null;
}

/**
 * 写操作失败的**分档**：403（无写权限）/ 400（这次提交本身被拒，例如 URL 形状非法）/
 * 其它（存储或链路暂时不可用，可重试）。三者的"下一步"完全不同，不能合成一句"保存失败"。
 */
export function classifyAdminActionError(err: unknown, fallback: string): AdminActionFailure {
  const code = errorCodeOf(err);
  const message = err instanceof Error && err.message !== "" ? err.message : fallback;
  if (err instanceof ApiError && err.status === 403) return { kind: "forbidden", code, message };
  if (err instanceof ApiError && err.status === 400) return { kind: "rejected", code, message };
  return { kind: "unavailable", code, message };
}

/** 读操作失败的分档：403 单独一态，其余按"取不到"处理（都**不能**渲染成空列表）。 */
export function classifyReadError(err: unknown, fallback: string): ChannelsReadState {
  const code = errorCodeOf(err);
  const message = err instanceof Error && err.message !== "" ? err.message : fallback;
  if (err instanceof ApiError && err.status === 403) return { kind: "forbidden", message };
  return { kind: "unavailable", code, message };
}

/** 渠道中文名（未知 kind 原样显示，不隐藏）。 */
export function channelKindLabel(locale: Locale, kind: string): string {
  const table: Record<string, string> = locale === "en"
    ? { email: "Email", telegram: "Telegram", webhook: "Webhook" }
    : { email: "邮件", telegram: "Telegram", webhook: "Webhook" };
  return table[kind] ?? kind;
}

function deliveryList(values: readonly string[], locale: Locale, emptyLabel: string): string {
  if (values.length === 0) return emptyLabel;
  return values.map((value) => channelKindLabel(locale, value)).join("、");
}

/* ================================================================== */
/* 展示层                                                              */
/* ================================================================== */

export interface NotificationChannelsBodyProps {
  view: ChannelsView;
  permission: NotificationChannelPermission;
  locale: Locale;
  busy: string | null;
  actionError: AdminActionFailure | null;
  actionNotice: string | null;
  telegramEnabled: boolean;
  webhookEnabled: boolean;
  credentialRef: { current: HTMLInputElement | null };
  targetRef: { current: HTMLInputElement | null };
  pendingRemove: string | null;
  onRetry: () => void;
  onToggleTelegram: (value: boolean) => void;
  onToggleWebhook: (value: boolean) => void;
  onSaveTelegram: () => void;
  onSaveWebhook: () => void;
  onRequestRemove: (key: string | null) => void;
  onRemoveKind: (kind: string) => void;
  onRemoveRow: (kind: string, id: number) => void;
}

function SecretStateBadge({
  row,
  text,
}: {
  row: NotificationChannelRow;
  text: Copy;
}) {
  const tone = row.secret_state === "unreadable" ? "destructive" : row.secret_state === "sealed" ? "success" : "muted";
  return (
    <>
      <Badge variant={tone as never} data-testid={`notification-secret-${row.id}`}>
        {text.secretState[row.secret_state]}
      </Badge>
      <p className="field-hint" data-testid={`notification-secret-hint-${row.id}`}>
        {text.secretStateHint[row.secret_state]}
      </p>
    </>
  );
}

export function NotificationChannelsBody(props: NotificationChannelsBodyProps) {
  const { view, permission, locale, busy, actionError, actionNotice } = props;
  const text = copy(locale);
  const canWrite = permission === "write";

  return (
    <div className="flex flex-col gap-4" data-testid="notification-channels-manager">
      <Card>
        <CardHeader>
          <CardTitle>{text.title}</CardTitle>
          <CardDescription>{text.subtitle}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="field-hint" data-testid="notification-permission">
            {text.permission[permission]}
          </p>

          {view.kind === "loading" && (
            <p className="field-hint flex items-center gap-2" data-testid="notification-channels-loading">
              <Loader2 className="size-4 animate-spin" />
              {text.loading}
            </p>
          )}

          {view.kind === "forbidden" && (
            <div className="flex flex-col gap-2 rounded-md border border-[var(--border)] px-3 py-3" role="alert" data-testid="notification-channels-forbidden">
              <div className="text-sm font-medium">{text.forbiddenTitle}</div>
              <div className="field-hint">{text.forbiddenHint}</div>
              <div className="field-hint" data-testid="notification-channels-forbidden-detail">
                {view.message}
              </div>
              <div>
                <Button variant="outline" size="sm" onClick={props.onRetry} data-testid="notification-channels-retry">
                  {text.retry}
                </Button>
              </div>
            </div>
          )}

          {view.kind === "unavailable" && (
            <div className="flex flex-col gap-2 rounded-md border border-[var(--border)] px-3 py-3" role="alert" data-testid="notification-channels-unavailable">
              <div className="text-sm font-medium">{text.unavailableTitle}</div>
              <div className="field-hint">{text.unavailableHint}</div>
              <div className="field-hint" data-testid="notification-channels-unavailable-detail">
                {view.message}
              </div>
              <div>
                <Button variant="outline" size="sm" onClick={props.onRetry} data-testid="notification-channels-retry">
                  {text.retry}
                </Button>
              </div>
            </div>
          )}

          {(view.kind === "empty" || view.kind === "ready") && (
            <>
              {view.kind === "empty" && (
                <div className="flex flex-col gap-1" data-testid="notification-channels-empty">
                  <div className="text-sm font-medium">{text.emptyTitle}</div>
                  <div className="field-hint">{text.emptyHint}</div>
                </div>
              )}

              {/* ── 投递状态：直接渲染服务端的推导结果 ── */}
              <Separator />
              <div className="flex flex-col gap-2" data-testid="notification-delivery">
                <div className="text-sm font-medium">{text.deliveryTitle}</div>
                <div className="field-hint" data-testid="notification-delivery-registered">
                  {text.deliveryRegistered}：{deliveryList(view.payload.delivery_kinds.registered, locale, text.deliveryNoneRegistered)}
                </div>
                <div className="field-hint" data-testid="notification-delivery-enabled">
                  {text.deliveryEnabled}：{deliveryList(view.payload.delivery_kinds.enabled, locale, text.deliveryNoneEnabled)}
                </div>
                <div className="field-hint" data-testid="notification-delivery-announcement">
                  {text.deliveryAnnouncement}：{deliveryList(view.payload.delivery_kinds.announcement, locale, text.deliveryNoneEnabled)}
                </div>
                <div className="field-hint" data-testid="notification-delivery-note">
                  {text.deliverySaveNotDelivery}
                </div>
                <div className="field-hint" data-testid="notification-delivery-email-note">
                  {text.emailNote}
                </div>
              </div>

              {/* ── 服务端 warnings：原样贴出来（多行是真实状态）── */}
              {view.payload.warnings.length > 0 && (
                <div className="flex flex-col gap-1 rounded-md border border-[var(--border)] px-3 py-2" data-testid="notification-warnings">
                  <div className="text-sm font-medium">{text.warningsTitle}</div>
                  {view.payload.warnings.map((warning) => (
                    <div key={warning} className="field-hint" data-testid="notification-warning">
                      {warning}
                    </div>
                  ))}
                </div>
              )}

              {/* ── 行 ── */}
              {view.kind === "ready" && (
                <div className="flex flex-col gap-2" data-testid="notification-rows">
                  <div className="text-sm font-medium">{text.rowsTitle}</div>
                  {view.payload.channels.map((row) => {
                    const removeKey = `row:${row.kind}:${row.id}`;
                    return (
                      <div
                        key={row.id}
                        className="flex flex-col gap-1 rounded-md border border-[var(--border)] px-3 py-2"
                        data-testid={`notification-row-${row.id}`}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">{channelKindLabel(locale, row.kind)}</span>
                          <Badge variant="outline" data-testid={`notification-row-kind-${row.id}`}>
                            {row.kind}
                          </Badge>
                          <Badge variant={row.enabled ? "success" : "muted"} data-testid={`notification-row-enabled-${row.id}`}>
                            {row.enabled ? text.rowEnabled : `${text.rowEnabled}：否`}
                          </Badge>
                          <span className="field-hint" data-testid={`notification-row-id-${row.id}`}>
                            {text.rowId} {row.id}
                          </span>
                          <span className="field-hint" data-testid={`notification-row-created-${row.id}`}>
                            {text.rowCreatedAt} {row.created_at ? formatDateTime(row.created_at) : "-"}
                          </span>
                        </div>
                        <div className="field-hint" data-testid={`notification-row-target-${row.id}`}>
                          {text.rowTarget}：{row.target === "" ? text.rowNoTarget : row.target}
                          {row.target_masked && row.target !== "" ? `（${text.rowMasked}）` : ""}
                        </div>
                        <SecretStateBadge row={row} text={text} />
                        <div className="field-hint" data-testid={`notification-row-loaded-${row.id}`}>
                          {row.config_loaded ? text.rowConfigLoaded : text.rowConfigNotLoaded}
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          {props.pendingRemove === removeKey ? (
                            <>
                              <Button
                                variant="destructive"
                                size="sm"
                                disabled={!canWrite || busy !== null}
                                onClick={() => props.onRemoveRow(row.kind, row.id)}
                                data-testid={`notification-row-remove-confirm-${row.id}`}
                              >
                                {text.confirmRemove}
                              </Button>
                              <Button variant="ghost" size="sm" onClick={() => props.onRequestRemove(null)}>
                                {text.cancel}
                              </Button>
                            </>
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={!canWrite || busy !== null}
                              onClick={() => props.onRequestRemove(removeKey)}
                              data-testid={`notification-row-remove-${row.id}`}
                            >
                              <Trash2 className="size-4" />
                              {text.remove}
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* ── Telegram 配置 ── */}
              <Separator />
              <div className="flex flex-col gap-2" data-testid="notification-telegram-form">
                <div className="text-sm font-medium">{text.telegramTitle}</div>
                <p className="field-hint">{text.telegramHint}</p>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="notification-telegram-token">{text.telegramToken}</Label>
                  {/* 非受控 + 不回填：凭据不进 React state、不进 SSR、提交后立刻清空。 */}
                  <Input
                    id="notification-telegram-token"
                    ref={props.credentialRef}
                    type="password"
                    autoComplete="off"
                    placeholder={text.telegramTokenPlaceholder}
                    disabled={!canWrite}
                    data-testid="notification-telegram-token"
                  />
                  <p className="field-hint">{text.telegramTokenHint}</p>
                </div>
                <div className="flex items-center justify-between gap-4 rounded-md border border-[var(--border)] px-3 py-2">
                  <span className="text-sm">{text.telegramEnabled}</span>
                  <Switch
                    checked={props.telegramEnabled}
                    onCheckedChange={props.onToggleTelegram}
                    disabled={!canWrite}
                    id="notification-telegram-enabled"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    onClick={props.onSaveTelegram}
                    disabled={!canWrite || busy !== null}
                    data-testid="notification-telegram-save"
                  >
                    {busy === "telegram" && <Loader2 className="size-4 animate-spin" />}
                    {text.telegramSave}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!canWrite || busy !== null}
                    onClick={() => props.onRemoveKind("telegram")}
                    data-testid="notification-telegram-remove"
                  >
                    <Trash2 className="size-4" />
                    {text.removeAllOfKind}
                  </Button>
                </div>
              </div>

              {/* ── Webhook 配置 ── */}
              <Separator />
              <div className="flex flex-col gap-2" data-testid="notification-webhook-form">
                <div className="text-sm font-medium">{text.webhookTitle}</div>
                <p className="field-hint">{text.webhookHint}</p>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="notification-webhook-target">{text.webhookTarget}</Label>
                  {/* 同样非受控：服务端只回显脱敏形态，输入框也不回填。 */}
                  <Input
                    id="notification-webhook-target"
                    ref={props.targetRef}
                    type="text"
                    autoComplete="off"
                    placeholder={text.webhookTargetPlaceholder}
                    disabled={!canWrite}
                    data-testid="notification-webhook-target"
                  />
                  <p className="field-hint">{text.webhookTargetHint}</p>
                </div>
                <div className="flex items-center justify-between gap-4 rounded-md border border-[var(--border)] px-3 py-2">
                  <span className="text-sm">{text.webhookEnabled}</span>
                  <Switch
                    checked={props.webhookEnabled}
                    onCheckedChange={props.onToggleWebhook}
                    disabled={!canWrite}
                    id="notification-webhook-enabled"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button onClick={props.onSaveWebhook} disabled={!canWrite || busy !== null} data-testid="notification-webhook-save">
                    {busy === "webhook" && <Loader2 className="size-4 animate-spin" />}
                    {text.webhookSave}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!canWrite || busy !== null}
                    onClick={() => props.onRemoveKind("webhook")}
                    data-testid="notification-webhook-remove"
                  >
                    <Trash2 className="size-4" />
                    {text.removeAllOfKind}
                  </Button>
                </div>
              </div>

              {actionError && (
                <div className="flex flex-col gap-1 rounded-md border border-[var(--border)] px-3 py-2" role="alert" data-testid="notification-action-error">
                  <div className="text-sm font-medium">
                    {actionError.kind === "forbidden"
                      ? text.actionForbidden
                      : actionError.kind === "rejected"
                        ? text.actionRejected
                        : text.actionUnavailable}
                  </div>
                  <div className="field-hint" data-testid="notification-action-error-detail">
                    {actionError.code ? `${actionError.code}：` : ""}
                    {actionError.message}
                  </div>
                </div>
              )}

              {actionNotice && (
                <div className="field-hint" data-testid="notification-action-notice">
                  {actionNotice}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ================================================================== */
/* 容器                                                                */
/* ================================================================== */

export function NotificationChannelsManager() {
  const { locale, t } = useI18n();
  const text = copy(locale);

  const [view, setView] = useState<ChannelsView>({ kind: "loading" });
  const [permission, setPermission] = useState<NotificationChannelPermission>("unknown");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<AdminActionFailure | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [telegramEnabled, setTelegramEnabled] = useState(true);
  const [webhookEnabled, setWebhookEnabled] = useState(true);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const credentialRef = useRef<HTMLInputElement | null>(null);
  const targetRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setView({ kind: "loading" });
    const [perm, read] = await Promise.all([
      notificationAdminApi.permission(),
      notificationAdminApi.channels().then(
        (payload) => ({ kind: "ready", payload }) as ChannelsReadState,
        (err: unknown) => classifyReadError(err, t("common.loadFailed")),
      ),
    ]);
    setPermission(perm);
    // 权限接口读不到时不做任何乐观隐藏：按只读呈现（写操作仍会被后端 RBAC 拦下并如实显示原因）。
    setView(notificationChannelsView(read));
    setActionError(null);
    setActionNotice(null);
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const canWrite = permission === "write";

  async function run(action: string, fn: () => Promise<string>): Promise<void> {
    if (!canWrite) {
      setActionError({ kind: "forbidden", code: null, message: text.actionForbidden });
      return;
    }
    setBusy(action);
    setActionError(null);
    setActionNotice(null);
    try {
      const notice = await fn();
      setActionNotice(notice);
      await load();
    } catch (err) {
      setActionError(classifyAdminActionError(err, text.actionUnavailable));
    } finally {
      setBusy(null);
    }
  }

  function tokenValue(): string {
    return credentialRef.current?.value ?? "";
  }

  function targetValue(): string {
    return targetRef.current?.value?.trim() ?? "";
  }

  return (
    <NotificationChannelsBody
      view={view}
      permission={permission}
      locale={locale}
      busy={busy}
      actionError={actionError}
      actionNotice={actionNotice}
      telegramEnabled={telegramEnabled}
      webhookEnabled={webhookEnabled}
      credentialRef={credentialRef}
      targetRef={targetRef}
      pendingRemove={pendingRemove}
      onRetry={() => void load()}
      onToggleTelegram={setTelegramEnabled}
      onToggleWebhook={setWebhookEnabled}
      onSaveTelegram={() =>
        void run("telegram", async () => {
          const secret = tokenValue().trim();
          await notificationAdminApi.putTelegram({
            enabled: telegramEnabled,
            ...(secret === "" ? {} : { secret }),
          });
          // 凭据只写不读：无论服务端回显什么，输入框立刻清空。
          if (credentialRef.current) credentialRef.current.value = "";
          return secret === "" ? text.telegramSaved : `${text.telegramSaved}（${text.telegramCleared}）`;
        })
      }
      onSaveWebhook={() =>
        void run("webhook", async () => {
          const target = targetValue();
          if (target === "") {
            // 前端只做"必填"提示，形状判定仍在服务端（复用既有解析器）。
            throw new ApiError(400, locale === "en" ? "The webhook URL is required" : "webhook URL 不能为空", {
              code: "invalid_target",
            });
          }
          await notificationAdminApi.putWebhook({ target, enabled: webhookEnabled });
          if (targetRef.current) targetRef.current.value = "";
          return text.webhookSaved;
        })
      }
      onRequestRemove={setPendingRemove}
      onRemoveKind={(kind) =>
        void run(`remove:${kind}`, async () => {
          await notificationAdminApi.removeKind(kind);
          setPendingRemove(null);
          return text.removed;
        })
      }
      onRemoveRow={(kind, id) =>
        void run(`remove:${kind}:${id}`, async () => {
          await notificationAdminApi.removeRow(kind, id);
          setPendingRemove(null);
          return text.removed;
        })
      }
    />
  );
}
