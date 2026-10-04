"use client";

import { useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TableCell, TableRow } from "@/components/ui/table";
import {
  CodeBadge,
  FederationErrorNotice,
  FederationSection,
  FederationTable,
  type Locale,
  StatusPill,
} from "@/components/admin/federation/federation-ui";
import { useFederationAction } from "@/components/admin/federation/use-federation-action";
import { attributionHintText, formatBytesBig, splitUsage } from "@/components/admin/federation/federation-status";
import { formatDateTime } from "@/lib/utils";
import type { FederationUsageRecord } from "@/lib/types";

/**
 * 用量（`/admin/federation/usage`）。
 *
 * 契约 §4.2：**归因不到就进单独桶并告警，绝不静默丢弃、也绝不混进正常行**。
 * 因此这里把两桶做成两个独立区块：`unattributed` 有红色边框、独立计数与金额化的字节数，
 * 并且不允许出现在 attributed 表里（单测直接断言两桶互斥）。
 *
 * 字节数是后端 BigInt 序列化来的**字符串**，展示走 BigInt（`formatBytesBig`），
 * 不经过 Number。
 */
export function FederationUsageManager({ initial, locale }: { initial: FederationUsageRecord[]; locale: Locale }) {
  const [rows, setRows] = useState<FederationUsageRecord[]>(initial);
  const { pending, error, notice, run } = useFederationAction();

  const refresh = async () => {
    await run("refresh", () => api.admin.federation.usage(), {
      onSuccess: (next) => setRows(next as FederationUsageRecord[]),
    });
  };

  const split = splitUsage(rows);

  return (
    <div className="flex flex-col gap-4" data-testid="federation-usage">
      {split.unattributed.length > 0 && (
        <div
          role="status"
          data-testid="federation-usage-unattributed-alert"
          className="flex items-start gap-2 rounded-lg border border-[var(--destructive)]/40 bg-[var(--destructive)]/5 p-3 text-sm"
        >
          <AlertTriangle className="mt-0.5 size-4 text-[var(--destructive)]" aria-hidden="true" />
          <div>
            <div className="font-medium">
              {locale === "en"
                ? `${split.unattributed.length} unattributed usage record(s)`
                : `${split.unattributed.length} 条无法归因的用量记录`}
            </div>
            <p className="text-xs text-[var(--muted-foreground)]">
              {locale === "en"
                ? "They are kept in their own bucket (never dropped, never mixed into normal rows). Each row carries a verifiable hint: whether this panel has a placement row for that lease."
                : "单独成桶保留（不丢弃、不混进正常行）。每行都带**可验证的判据**：本机有没有这条租约的放置记录。"}
            </p>
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card data-testid="fed-usage-attributed-count">
          <CardHeader className="pb-2">
            <CardDescription>{locale === "en" ? "Attributed records" : "已归因记录"}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-semibold">{split.attributedTotals.records}</div>
          </CardContent>
        </Card>
        <Card data-testid="fed-usage-attributed-bytes">
          <CardHeader className="pb-2">
            <CardDescription>{locale === "en" ? "Attributed traffic" : "已归因流量"}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-semibold" data-testid="fed-usage-attributed-bytes-value">
              ↑{formatBytesBig(split.attributedTotals.bytes_out)} / ↓{formatBytesBig(split.attributedTotals.bytes_in)}
            </div>
            <p className="mt-1 text-xs text-[var(--muted-foreground)]">
              {split.attributedTotals.connections} {locale === "en" ? "connections" : "连接"}
            </p>
          </CardContent>
        </Card>
        <Card data-testid="fed-usage-unattributed-count">
          <CardHeader className="pb-2">
            <CardDescription>{locale === "en" ? "Unattributed records" : "未归因记录"}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-semibold" data-testid="fed-usage-unattributed-count-value">
              {split.unattributedTotals.records}
            </div>
          </CardContent>
        </Card>
        <Card data-testid="fed-usage-unattributed-bytes">
          <CardHeader className="pb-2">
            <CardDescription>{locale === "en" ? "Unattributed traffic" : "未归因流量"}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-semibold">
              ↑{formatBytesBig(split.unattributedTotals.bytes_out)} / ↓{formatBytesBig(split.unattributedTotals.bytes_in)}
            </div>
          </CardContent>
        </Card>
      </div>

      <FederationSection
        testId="federation-usage-attributed-section"
        title={locale === "en" ? "Attributed usage" : "已归因用量"}
        description={locale === "en" ? "Mapped to a local forward/tunnel." : "已映射到本机转发 / 隧道。"}
        actions={
          <Button variant="outline" size="sm" onClick={refresh} disabled={pending !== null}>
            <RefreshCw className="size-3.5" />
            {locale === "en" ? "Refresh" : "刷新"}
          </Button>
        }
      >
        <FederationTable
          rowCount={split.attributed.length}
          empty={locale === "en" ? "No attributed usage." : "没有已归因的用量。"}
          columns={[
            { key: "window", label: locale === "en" ? "Window" : "窗口" },
            { key: "peer", label: locale === "en" ? "Peer / lease" : "对端 / 租约" },
            { key: "target", label: "forward / tunnel" },
            { key: "in", label: "bytes_in", numeric: true },
            { key: "out", label: "bytes_out", numeric: true },
            { key: "conns", label: "connections", numeric: true },
          ]}
        >
          {split.attributed.map((row) => (
            <TableRow key={row.usage_id} data-testid="federation-usage-row" data-attribution="attributed">
              <TableCell className="text-xs">
                <div>{formatDateTime(row.window_start)}</div>
                <div className="text-[11px] text-[var(--muted-foreground)]">{formatDateTime(row.window_end)}</div>
                {row.received_at && (
                  <div className="text-[11px] text-[var(--muted-foreground)]" data-testid="federation-usage-received">
                    {locale === "en" ? "received" : "收到"} {formatDateTime(row.received_at)}
                  </div>
                )}
              </TableCell>
              <TableCell className="text-xs">
                <div className="font-mono">{row.peer_panel_id}</div>
                <div className="text-[11px] text-[var(--muted-foreground)]">{row.lease_ref}</div>
              </TableCell>
              <TableCell className="text-xs font-mono">
                {row.forward_ref ?? "—"} / {row.tunnel_id ?? "—"}
              </TableCell>
              <TableCell className="text-right text-xs">{formatBytesBig(row.bytes_in)}</TableCell>
              <TableCell className="text-right text-xs">{formatBytesBig(row.bytes_out)}</TableCell>
              <TableCell className="text-right text-xs">{row.connections}</TableCell>
            </TableRow>
          ))}
        </FederationTable>
      </FederationSection>

      <FederationSection
        testId="federation-usage-unattributed-section"
        title={locale === "en" ? "Unattributed usage (separate bucket)" : "未归因用量（独立桶）"}
        description={
          locale === "en"
            ? "Kept visible on purpose: attribution failures must be actionable, not silently dropped."
            : "刻意保留可见：归因失败要能被处理，不能被静默丢弃。"
        }
      >
        <FederationTable
          rowCount={split.unattributed.length}
          empty={locale === "en" ? "Everything is attributed." : "全部记录都已归因。"}
          columns={[
            { key: "window", label: locale === "en" ? "Window" : "窗口" },
            { key: "peer", label: locale === "en" ? "Peer / lease" : "对端 / 租约" },
            { key: "why", label: locale === "en" ? "Why not attributed" : "为何未归因" },
            { key: "in", label: "bytes_in", numeric: true },
            { key: "out", label: "bytes_out", numeric: true },
          ]}
        >
          {split.unattributed.map((row) => (
            <TableRow key={row.usage_id} data-testid="federation-usage-row" data-attribution="unattributed">
              <TableCell className="text-xs">
                <div>{formatDateTime(row.window_start)}</div>
                <div className="text-[11px] text-[var(--muted-foreground)]">{formatDateTime(row.window_end)}</div>
                {row.received_at && (
                  <div className="text-[11px] text-[var(--muted-foreground)]" data-testid="federation-usage-received">
                    {locale === "en" ? "received" : "收到"} {formatDateTime(row.received_at)}
                  </div>
                )}
              </TableCell>
              <TableCell className="text-xs">
                <div className="font-mono">{row.peer_panel_id}</div>
                <div className="text-[11px] text-[var(--muted-foreground)]">{row.lease_ref}</div>
              </TableCell>
              <TableCell className="text-xs">
                <StatusPill label={String(row.attribution)} tone="destructive" testId="federation-usage-attribution" />
                {row.attribution_hint && (
                  <div className="mt-1" data-testid="federation-usage-hint" data-hint={String(row.attribution_hint)}>
                    <CodeBadge code={String(row.attribution_hint)} />
                    <div className="text-[11px] text-[var(--muted-foreground)]">
                      {attributionHintText(locale, String(row.attribution_hint))}
                    </div>
                  </div>
                )}
              </TableCell>
              <TableCell className="text-right text-xs">{formatBytesBig(row.bytes_in)}</TableCell>
              <TableCell className="text-right text-xs">{formatBytesBig(row.bytes_out)}</TableCell>
            </TableRow>
          ))}
        </FederationTable>
        <p className="mt-2 text-xs text-[var(--muted-foreground)]">
          {locale === "en" ? "Raw lease refs:" : "原始租约引用："}{" "}
          {split.unattributed.slice(0, 3).map((row) => (
            <span key={row.usage_id} className="mr-2 inline-block">
              <CodeBadge code={row.lease_ref} />
            </span>
          ))}
        </p>
      </FederationSection>

      {error && <FederationErrorNotice error={error} locale={locale} onRetry={refresh} />}
      {notice && (
        <p className="text-sm text-[var(--muted-foreground)]" data-testid="federation-usage-notice">
          {notice}
        </p>
      )}
    </div>
  );
}
