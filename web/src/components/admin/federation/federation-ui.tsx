"use client";

import Link from "next/link";
import { AlertTriangle, Check, Copy, KeyRound, RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  type BadgeTone,
  type FederationErrorInfo,
  federationErrorAction,
  type InvitationOnceState,
  invitationTokenForDisplay,
} from "@/components/admin/federation/federation-status";
import type { FederationInviteInput, FederationPeer } from "@/lib/types";

/**
 * Admin Console 联邦页面的展示件（V5-WP14/15/16）。
 *
 * 这些组件**只渲染给它们的事实**，不做判定、不发请求：
 *  - 所有组件都接受显式 `locale`，不依赖 I18nProvider / usePathname，
 *    因此可以在 `renderToStaticMarkup` 下被单测直接断言（仓库既有做法）；
 *  - 错误一律通过 `FederationErrorNotice` 渲染，它把**后端错误码**与
 *    「下一步」并排给出 —— 这是「不把异常压成一个 ERROR」的落点。
 */

export type Locale = "zh" | "en";

const t = (locale: Locale, zh: string, en: string) => (locale === "en" ? en : zh);

const TONE_CLASS: Record<BadgeTone, string> = {
  success: "",
  secondary: "",
  outline: "",
  muted: "",
  destructive: "",
};

/** 统一的状态徽章（色彩走既有 Badge variant，不新造视觉 token）。 */
export function StatusPill({ label, tone, testId }: { label: string; tone: BadgeTone; testId?: string }) {
  return (
    <Badge variant={tone} className={TONE_CLASS[tone]} data-testid={testId} data-tone={tone}>
      {label}
    </Badge>
  );
}

/** 机器可读的错误码 / 引用码（等宽显示，便于照抄进日志检索）。 */
export function CodeBadge({ code, testId }: { code: string; testId?: string }) {
  return (
    <code
      className="rounded border border-[var(--border)] bg-[var(--muted)] px-1 py-0.5 font-mono text-[11px]"
      data-testid={testId}
    >
      {code}
    </code>
  );
}

/**
 * 联邦错误提示：**后端错误码 + 人读原因 + 下一步 + 是否可重试 + correlation id**。
 *
 * 五件事缺一不可 —— 少了「下一步」，管理员只能看到一个红框；
 * 少了 `correlation_id`，跨面板排障时无法把两侧日志对上。
 */
export function FederationErrorNotice({
  error,
  locale,
  testId = "federation-error",
  onRetry,
}: {
  error: FederationErrorInfo;
  locale: Locale;
  testId?: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      data-testid={testId}
      data-error-code={error.code ?? "unknown"}
      data-retryable={error.retryable ? "true" : "false"}
      className="flex flex-col gap-2 rounded-lg border border-[var(--destructive)]/40 bg-[var(--destructive)]/5 p-3 text-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        <AlertTriangle className="size-4 text-[var(--destructive)]" aria-hidden="true" />
        {error.code ? (
          <CodeBadge code={error.code} testId={`${testId}-code`} />
        ) : (
          <StatusPill label={t(locale, "无错误码", "no code")} tone="muted" />
        )}
        <span className="font-medium">{error.message}</span>
        <StatusPill
          label={error.retryable ? t(locale, "可重试", "retryable") : t(locale, "不可重试", "not retryable")}
          tone={error.retryable ? "outline" : "muted"}
          testId={`${testId}-retryable`}
        />
        {!error.known && error.code && (
          <StatusPill label={t(locale, "未知错误码", "unknown code")} tone="destructive" testId={`${testId}-unknown-code`} />
        )}
      </div>
      <p className="text-[var(--muted-foreground)]" data-testid={`${testId}-action`}>
        {federationErrorAction(locale, error.code)}
      </p>
      {error.peer_panel_id && (
        <p className="text-xs text-[var(--muted-foreground)]">
          {t(locale, "对端", "peer")}: <CodeBadge code={error.peer_panel_id} />
        </p>
      )}
      {error.correlation_id && (
        <p className="text-xs text-[var(--muted-foreground)]">
          correlation_id: <CodeBadge code={error.correlation_id} testId={`${testId}-correlation`} />
        </p>
      )}
      {onRetry && (
        <div>
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw className="size-3.5" />
            {t(locale, "重试", "Retry")}
          </Button>
        </div>
      )}
    </div>
  );
}

/** 一次性 token 面板：明文只在这里出现，确认后从内存里丢掉。 */
export function TokenOncePanel({
  state,
  locale,
  onDismiss,
}: {
  state: InvitationOnceState;
  locale: Locale;
  onDismiss: () => void;
}) {
  const token = invitationTokenForDisplay(state);
  const [copied, setCopied] = useState(false);
  if (!token) return null;
  return (
    <div
      data-testid="federation-invite-token"
      data-token-visible="true"
      className="flex flex-col gap-2 rounded-lg border border-[var(--primary)]/40 bg-[var(--primary)]/5 p-3 text-sm"
    >
      <div className="flex flex-wrap items-center gap-2 font-medium">
        <KeyRound className="size-4" aria-hidden="true" />
        {t(locale, "邀请 token（只显示这一次）", "Invitation token (shown once)")}
      </div>
      <code
        data-testid="federation-invite-token-value"
        className="break-all rounded border border-[var(--border)] bg-[var(--card)] px-2 py-1 font-mono text-xs"
      >
        {token}
      </code>
      <p className="text-xs text-[var(--muted-foreground)]" data-testid="federation-invite-token-hint">
        {t(
          locale,
          "请通过**带外渠道**（人工/密码管理器）交给对端管理员；关闭后本页不再显示，库里只存哈希。",
          "Hand this to the peer admin out-of-band (human/password manager). It will not be shown again; only a hash is stored.",
        )}
      </p>
      <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--muted-foreground)]">
        {state.expires_at && (
          <span>
            {t(locale, "过期时间", "expires")}: <CodeBadge code={state.expires_at} />
          </span>
        )}
        {state.panel_id && (
          <span>
            panel_id: <CodeBadge code={state.panel_id} />
          </span>
        )}
        {state.key_id && (
          <span>
            key_id: <CodeBadge code={state.key_id} />
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void navigator.clipboard?.writeText(token);
            setCopied(true);
          }}
        >
          <Copy className="size-3.5" />
          {copied ? t(locale, "已复制", "Copied") : t(locale, "复制 token", "Copy token")}
        </Button>
        <Button variant="default" size="sm" data-testid="federation-invite-ack" onClick={onDismiss}>
          <Check className="size-3.5" />
          {t(locale, "我已记录，关闭", "I saved it, close")}
        </Button>
      </div>
    </div>
  );
}

/** 顶部统计块（概览页与各列表页共用）。 */
export function StatTile({
  label,
  value,
  hint,
  testId,
}: {
  label: string;
  value: string;
  hint?: string;
  testId?: string;
}) {
  return (
    <Card data-testid={testId}>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="text-xl font-semibold" data-testid={testId ? `${testId}-value` : undefined}>
          {value}
        </div>
        {hint && <p className="mt-1 text-xs text-[var(--muted-foreground)]">{hint}</p>}
      </CardContent>
    </Card>
  );
}

/** 联邦子导航（服务端页把 `active` 传进来，避免依赖 usePathname）。 */
export const FEDERATION_TABS: ReadonlyArray<{ href: string; id: string; zh: string; en: string }> = [
  { href: "/admin/federation", id: "overview", zh: "总览", en: "Overview" },
  { href: "/admin/federation/peers", id: "peers", zh: "对等面板", en: "Peers" },
  { href: "/admin/federation/trust", id: "trust", zh: "信任与密钥", en: "Trust & Keys" },
  { href: "/admin/federation/grants", id: "grants", zh: "授予", en: "Grants" },
  { href: "/admin/federation/remote-leases", id: "remote-leases", zh: "远端租约", en: "Remote Leases" },
  { href: "/admin/federation/usage", id: "usage", zh: "用量", en: "Usage" },
];

export function FederationTabs({ active, locale }: { active: string; locale: Locale }) {
  return (
    <nav
      data-testid="federation-tabs"
      data-active={active}
      className="flex flex-wrap gap-1 border-b border-[var(--border)] pb-2"
      aria-label={t(locale, "联邦子页面", "Federation sections")}
    >
      {FEDERATION_TABS.map((tab) => {
        const isActive = tab.id === active;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            data-federation-tab={tab.id}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "rounded-md px-2.5 py-1 text-sm transition-colors",
              isActive
                ? "bg-[var(--accent)] font-medium text-[var(--accent-foreground)]"
                : "text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]",
            )}
          >
            {t(locale, tab.zh, tab.en)}
          </Link>
        );
      })}
    </nav>
  );
}

/** 页面区块（各页统一的标题 + 说明 + 内容）。 */
export function FederationSection({
  title,
  description,
  actions,
  children,
  testId,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <Card data-testid={testId}>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export interface FederationColumn {
  key: string;
  label: string;
  /** 右对齐（数字/端口/revision） */
  numeric?: boolean;
}

/** 通用列表骨架（列定义 + 行内容由页面给，避免每页复制表头/空态样板）。 */
export function FederationTable({
  columns,
  empty,
  rowCount,
  children,
}: {
  columns: FederationColumn[];
  empty: string;
  /** 行数：为 0 时才渲染空态行（`TableEmpty` 是无条件渲染的组件，不能当兜底用） */
  rowCount: number;
  children: React.ReactNode;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {columns.map((c) => (
            <TableHead key={c.key} className={c.numeric ? "text-right" : undefined}>
              {c.label}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {children}
        {rowCount === 0 && <TableEmpty colSpan={columns.length} text={empty} />}
      </TableBody>
    </Table>
  );
}

/** 错误码单元格：统一渲染后端 `last_error_code`（没有就显示占位）。 */
export function LastErrorCode({ code, locale }: { code: string | null | undefined; locale: Locale }) {
  if (!code) return <span className="text-[var(--muted-foreground)]">—</span>;
  return <CodeBadge code={code} testId="federation-last-error-code" />;
}

/** 信任状态图标（列表与详情共用，语义与 PeerStatusBadge 一致）。 */
export function TrustIcon({ status }: { status: string }) {
  if (status === "active") return <ShieldCheck className="size-4 text-[var(--success,theme(colors.green.600))]" aria-hidden="true" />;
  if (status === "revoked") return <ShieldAlert className="size-4 text-[var(--destructive)]" aria-hidden="true" />;
  return <ShieldAlert className="size-4 text-[var(--muted-foreground)]" aria-hidden="true" />;
}

/** 邀请表单的初始值（供测试与默认值复用）。 */
export const EMPTY_INVITE_INPUT: FederationInviteInput = { display_name: "", endpoint_url: "", ttl_seconds: 900 };

/** 判断一个 peer 是否还能做「轮转 / 撤销」动作（撤销后不可逆，不再给入口）。 */
export function peerActionsDisabled(peer: Pick<FederationPeer, "status">): boolean {
  return peer.status === "revoked";
}
