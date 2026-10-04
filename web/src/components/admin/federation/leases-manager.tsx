"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TableCell, TableRow } from "@/components/ui/table";
import {
  CodeBadge,
  FederationErrorNotice,
  FederationSection,
  FederationTable,
  LastErrorCode,
  type Locale,
  StatusPill,
} from "@/components/admin/federation/federation-ui";
import { useFederationAction } from "@/components/admin/federation/use-federation-action";
import { isExpired, leaseRevisionView, leaseStateText, placementStateText } from "@/components/admin/federation/federation-status";
import type { FederationLease, FederationPlacement } from "@/lib/types";

/**
 * 远端租约（`/admin/federation/remote-leases`）。
 *
 * 这页回答的是「**本机**现在替别人跑着什么」，因此把 host 侧权威字段全摊开：
 * `state` / `lease_epoch` / 节点与端口 / `requested` vs `applied` revision /
 * `expires_at` / `last_error_code`。
 *
 * 两处刻意不合并：
 *  1. `requested_revision` 与 `applied_revision` 分两列显示（只说「同步」无法定位卡在哪）；
 *  2. `state=failed` 与 `state=revoked/expired` 用不同徽章 —— 失败要人查，终态不用。
 * 同页附上 home 侧镜像（placements），两侧对不齐时管理员能一眼看出。
 */
export function FederationLeasesManager({
  initial,
  placements,
  locale,
}: {
  initial: FederationLease[];
  placements: FederationPlacement[];
  locale: Locale;
}) {
  const [leases, setLeases] = useState<FederationLease[]>(initial);
  const [mirrors, setMirrors] = useState<FederationPlacement[]>(placements);
  const { pending, error, notice, run } = useFederationAction();

  const refresh = async () => {
    await run("refresh", async () => {
      const [nextLeases, nextPlacements] = await Promise.all([
        api.admin.federation.leases(),
        api.admin.federation.placements(),
      ]);
      return { nextLeases, nextPlacements };
    }, {
      onSuccess: (result) => {
        const r = result as { nextLeases: FederationLease[]; nextPlacements: FederationPlacement[] };
        setLeases(r.nextLeases);
        setMirrors(r.nextPlacements);
      },
    });
  };

  const live = leases.filter((l) => ["reserved", "active", "releasing"].includes(String(l.state)));
  const failing = leases.filter((l) => l.state === "failed" || (l.last_error_code && l.applied_revision !== l.requested_revision));

  return (
    <div className="flex flex-col gap-4" data-testid="federation-remote-leases">
      <div className="grid gap-4 sm:grid-cols-3">
        <Card data-testid="fed-lease-live">
          <CardHeader className="pb-2">
            <CardDescription>{locale === "en" ? "Live leases" : "占用中的租约"}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-semibold">{live.length}</div>
          </CardContent>
        </Card>
        <Card data-testid="fed-lease-failing">
          <CardHeader className="pb-2">
            <CardDescription>{locale === "en" ? "Needs attention" : "需要处理"}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-semibold" data-testid="fed-lease-failing-count">
              {failing.length}
            </div>
            <p className="mt-1 text-xs text-[var(--muted-foreground)]">
              {locale === "en" ? "failed, or applied lagging behind requested" : "failed，或 applied 落后于 requested"}
            </p>
          </CardContent>
        </Card>
        <Card data-testid="fed-placement-mirrors">
          <CardHeader className="pb-2">
            <CardDescription>{locale === "en" ? "Home mirrors" : "home 侧镜像"}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-semibold">{mirrors.length}</div>
          </CardContent>
        </Card>
      </div>

      <FederationSection
        testId="federation-leases-section"
        title={locale === "en" ? "Leases on this panel (host authority)" : "本机租约（host 权威）"}
        description={
          locale === "en"
            ? "Both revisions are shown on purpose: applied < requested means the runtime has not converged yet."
            : "两个 revision 都摊开：applied < requested 表示运行态还没收敛。"
        }
        actions={
          <Button variant="outline" size="sm" onClick={refresh} disabled={pending !== null}>
            <RefreshCw className="size-3.5" />
            {locale === "en" ? "Refresh" : "刷新"}
          </Button>
        }
      >
        <FederationTable
          rowCount={leases.length}
          empty={locale === "en" ? "No remote leases." : "没有远端租约。"}
          columns={[
            { key: "lease", label: locale === "en" ? "Lease" : "租约" },
            { key: "state", label: locale === "en" ? "State" : "状态" },
            { key: "placement", label: locale === "en" ? "Node / port" : "节点 / 端口" },
            { key: "revision", label: locale === "en" ? "applied / requested" : "applied / requested" },
            { key: "expires", label: locale === "en" ? "Expires" : "到期" },
            { key: "error", label: locale === "en" ? "Last error" : "最近错误" },
          ]}
        >
          {leases.map((lease) => {
            const state = leaseStateText(locale, String(lease.state));
            const revision = leaseRevisionView(lease, locale);
            const expired = isExpired(lease.expires_at) && ["reserved", "active", "releasing"].includes(String(lease.state));
            return (
              <TableRow key={lease.lease_ref} data-testid="federation-lease-row" data-lease-ref={lease.lease_ref}>
                <TableCell>
                  <div className="font-mono text-xs">{lease.lease_ref}</div>
                  <div className="text-[11px] text-[var(--muted-foreground)]">
                    grant #{lease.grant_id} · {lease.hop_role} · intent {lease.intent_id}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-col gap-1">
                    <StatusPill label={state.label} tone={state.tone} testId="federation-lease-state" />
                    <span className="text-[11px] text-[var(--muted-foreground)]">epoch {lease.lease_epoch}</span>
                  </div>
                </TableCell>
                <TableCell className="text-xs">
                  {lease.node_id === null ? (
                    <span className="text-[var(--muted-foreground)]">{locale === "en" ? "unassigned" : "未分配"}</span>
                  ) : (
                    <>
                      node {lease.node_id} : {lease.listen_port ?? "—"}
                    </>
                  )}
                </TableCell>
                <TableCell className="text-xs">
                  <span data-testid="federation-lease-revision" data-synced={revision.synced ? "true" : "false"} data-lagging={revision.lagging ? "true" : "false"}>
                    {revision.text}
                  </span>
                  {revision.lagging && (
                    <div className="text-[11px] text-[var(--destructive)]" data-testid="federation-lease-lagging">
                      {locale === "en" ? "not converged" : "尚未收敛"}
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-xs text-[var(--muted-foreground)]">
                  {formatDateTime(lease.expires_at)}
                  {expired && (
                    <div className="text-[11px] text-[var(--destructive)]" data-testid="federation-lease-expired">
                      {locale === "en" ? "expired — host must stop serving" : "已到期 —— host 必须停服"}
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  <LastErrorCode code={lease.last_error_code} locale={locale} />
                </TableCell>
              </TableRow>
            );
          })}
        </FederationTable>
      </FederationSection>

      <FederationSection
        testId="federation-placements-section"
        title={locale === "en" ? "Home-side mirrors (placements)" : "home 侧镜像（placements）"}
        description={
          locale === "en"
            ? "What this panel believes the host has. Divergence from the host table above is a reconcile signal, not a second truth."
            : "本机认为对端建了什么。与上表的差异是对账信号，不是第二份真相。"
        }
      >
        <FederationTable
          rowCount={mirrors.length}
          empty={locale === "en" ? "No mirrors." : "没有镜像记录。"}
          columns={[
            { key: "forward", label: "Forward" },
            { key: "state", label: locale === "en" ? "State" : "状态" },
            { key: "peer", label: locale === "en" ? "Peer node / port" : "对端节点 / 端口" },
            { key: "revision", label: locale === "en" ? "desired / applied" : "desired / applied" },
            { key: "error", label: locale === "en" ? "Last error" : "最近错误" },
          ]}
        >
          {mirrors.map((row) => {
            const state = placementStateText(locale, String(row.state));
            return (
              <TableRow key={`${row.peer_panel_id}:${row.intent_id}`} data-testid="federation-placement-row">
                <TableCell className="text-xs">
                  <div className="font-mono">{row.forward_ref}</div>
                  <div className="text-[11px] text-[var(--muted-foreground)]">
                    tunnel {row.tunnel_id ?? "—"} · {row.hop_role} · lease {row.lease_ref}
                  </div>
                </TableCell>
                <TableCell>
                  <StatusPill label={state.label} tone={state.tone} />
                </TableCell>
                <TableCell className="text-xs">
                  {row.peer_node_ref ?? "—"} : {row.peer_port ?? "—"}
                  <div className="text-[11px] text-[var(--muted-foreground)]">
                    epoch <CodeBadge code={String(row.lease_epoch)} />
                  </div>
                </TableCell>
                <TableCell className="text-xs">
                  {row.applied_revision ?? "—"} / {row.desired_revision ?? "—"}
                </TableCell>
                <TableCell>
                  <LastErrorCode code={row.last_error_code} locale={locale} />
                </TableCell>
              </TableRow>
            );
          })}
        </FederationTable>
      </FederationSection>

      {error && <FederationErrorNotice error={error} locale={locale} onRetry={refresh} />}
      {notice && (
        <p className="text-sm text-[var(--muted-foreground)]" data-testid="federation-leases-notice">
          {notice}
        </p>
      )}
    </div>
  );
}
