"use client";

import { AlertTriangle, ArrowRight, Eye, GitBranch, Lock, RefreshCw, ShieldCheck, Users } from "lucide-react";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  errorLayerText,
  hopChain,
  type RouteProfileErrorInfo,
  UNKNOWN_ERROR_NEXT_ACTION,
  visibilityText,
} from "@/components/admin/route-profiles/route-profile-status";
import type { RouteProfileTemplate } from "@/lib/types";

/**
 * Admin Console Route Profile 的展示件（V5-WP13.5B）。
 *
 * 只渲染给它们的事实；全部接受显式 `locale`，不依赖 I18nProvider / usePathname，
 * 因此可以在 `renderToStaticMarkup` 下被单测直接断言。
 *
 * 关键展示契约：
 *  - `RouteProfileErrorNotice` 把 **code + 失败层 + retryable + 后端给的 next_action**
 *    一起摊开 —— 这是「profile_disabled / no_eligible_node / forbidden /
 *    profile_not_visible / unsupported_topology 各自不同」的落点；
 *  - `TransitChain` 把**顺序**画出来（带序号），顺序就是语义；
 *  - `ReadOnlyNotice` 明确写「只读、不会触发任何下发」。
 */

export type Locale = "zh" | "en";

const t = (locale: Locale, zh: string, en: string) => (locale === "en" ? en : zh);

export function VersionBadge({ version, locale }: { version: number; locale: Locale }) {
  return (
    <Badge variant="outline" data-testid="route-profile-version" data-version={version}>
      <GitBranch className="size-3" />
      {t(locale, `v${version}`, `v${version}`)}
    </Badge>
  );
}

export function VisibilityPill({ visibility, locale }: { visibility: string; locale: Locale }) {
  const text = visibilityText(locale, visibility);
  return (
    <Badge variant={text.tone} data-testid="route-profile-visibility" data-visibility={visibility} title={text.hint}>
      {visibility === "PUBLIC" ? <Users className="size-3" /> : visibility === "ASSIGNED" ? <ShieldCheck className="size-3" /> : <Lock className="size-3" />}
      {text.label}
    </Badge>
  );
}

/** 失败提示：code / 层 / 可重试 / next_action（后端原文）。 */
export function RouteProfileErrorNotice({
  error,
  locale,
  testId = "route-profile-error",
  onRetry,
}: {
  error: RouteProfileErrorInfo;
  locale: Locale;
  testId?: string;
  onRetry?: () => void;
}) {
  const layer = errorLayerText(locale, error.error_layer);
  const nextAction = error.next_action ?? t(locale, UNKNOWN_ERROR_NEXT_ACTION.zh, UNKNOWN_ERROR_NEXT_ACTION.en);
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
        {error.code && (
          <code className="rounded border border-[var(--border)] bg-[var(--muted)] px-1 py-0.5 font-mono text-[11px]" data-testid={`${testId}-code`}>
            {error.code}
          </code>
        )}
        {layer && (
          <Badge variant="outline" data-testid={`${testId}-layer`}>
            {t(locale, "失败层", "layer")}: {layer}
          </Badge>
        )}
        <span className="font-medium">{error.message}</span>
        <Badge
          variant={error.retryable ? "outline" : "muted"}
          data-testid={`${testId}-retryable`}
        >
          {error.retryable ? t(locale, "可重试", "retryable") : t(locale, "不可重试", "not retryable")}
        </Badge>
        {!error.known && error.code && <Badge variant="destructive">{t(locale, "未知错误码", "unknown code")}</Badge>}
      </div>
      <p className="text-[var(--muted-foreground)]" data-testid={`${testId}-next-action`}>
        {t(locale, "下一步", "Next")}: {nextAction}
      </p>
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

/**
 * 有序跳链：入口 → 中转 1 → … → 出口（**顺序显式可见**）。
 *
 * 每个跳位带序号徽章；出口为 `null`（DIRECT）时写「同入口（直连）」而不是留空。
 */
export function TransitChain({
  template,
  locale,
  testId = "route-profile-chain",
}: {
  template: RouteProfileTemplate | null | undefined;
  locale: Locale;
  testId?: string;
}) {
  const hops = hopChain(locale, template);
  if (hops.length === 0) return <span className="text-[var(--muted-foreground)]">—</span>;
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid={testId} data-hop-count={hops.length}>
      {hops.map((hop, i) => (
        <span key={`${hop.role}-${hop.index}`} className="flex items-center gap-1.5">
          {i > 0 && <ArrowRight className="size-3 text-[var(--muted-foreground)]" aria-hidden="true" />}
          <span
            className="flex items-center gap-1 rounded border border-[var(--border)] bg-[var(--card)] px-1.5 py-0.5 text-[11px]"
            data-hop-index={hop.index}
            data-hop-role={hop.role}
          >
            <span className="rounded bg-[var(--muted)] px-1 font-mono">{hop.index}</span>
            <span className="text-[var(--muted-foreground)]">{hop.roleLabel}</span>
            <span className="font-mono">{hop.selector}</span>
          </span>
        </span>
      ))}
    </div>
  );
}

/** 「只读，不会触发下发」的显式声明（Impact Analysis 用）。 */
export function ReadOnlyNotice({ locale, children, testId = "impact-readonly" }: { locale: Locale; children?: React.ReactNode; testId?: string }) {
  return (
    <div
      data-testid={testId}
      data-read-only="true"
      className="flex items-start gap-2 rounded-lg border border-[var(--border)] bg-[var(--muted)]/40 p-2 text-xs"
    >
      <Eye className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <div>
        <div className="font-medium">{t(locale, "只读预览：不会触发任何下发", "Read-only preview: nothing is dispatched")}</div>
        <p className="text-[var(--muted-foreground)]">
          {children ??
            t(
              locale,
              "这里不会改任何 Forward / revision / rollout。要真正生效必须在下面显式勾选 Forward 并执行 apply。",
              "This changes no Forward / revision / rollout. To take effect, select forwards below and run apply explicitly.",
            )}
        </p>
      </div>
    </div>
  );
}

export function StatTile({ label, value, hint, testId }: { label: string; value: string; hint?: string; testId?: string }) {
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

export interface ProfileColumn {
  key: string;
  label: string;
}

/** 列表骨架（列定义 + 行内容由页面给）。 */
export function RouteProfileTable({
  columns,
  empty,
  rowCount,
  children,
}: {
  columns: ProfileColumn[];
  empty: string;
  rowCount: number;
  children: React.ReactNode;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {columns.map((c) => (
            <TableHead key={c.key}>{c.label}</TableHead>
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
