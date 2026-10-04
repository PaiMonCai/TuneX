"use client";

import { useState } from "react";
import { Power, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  FederationErrorNotice,
  FederationSection,
  type Locale,
  StatTile,
  StatusPill,
} from "@/components/admin/federation/federation-ui";
import { useFederationAction } from "@/components/admin/federation/use-federation-action";
import type { FederationStatus } from "@/lib/types";

/**
 * 联邦总览（`/admin/federation`）。
 *
 * 展示本机身份（panel_id / key_id）、开关状态与三个计数；enable/disable 是写操作，
 * 走**二次确认 + 结果反馈**：这不是普通开关 —— 关掉它等于拒绝一切跨面板协作。
 */
export function FederationOverviewManager({ initial, locale }: { initial: FederationStatus; locale: Locale }) {
  const [status, setStatus] = useState<FederationStatus>(initial);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { pending, error, notice, run, clear } = useFederationAction();

  const refresh = async () => {
    await run("refresh", () => api.admin.federation.status(), {
      onSuccess: (next) => setStatus(next as FederationStatus),
    });
  };

  const toggle = async () => {
    const target = !status.enabled;
    await run(target ? "enable" : "disable", () =>
      target ? api.admin.federation.enable() : api.admin.federation.disable(),
      {
        describe: (result) =>
          target
            ? `${locale === "en" ? "Federation enabled" : "已启用联邦"} · panel_id=${
                (result as { panel_id?: string }).panel_id ?? "—"
              }`
            : locale === "en"
              ? "Federation disabled"
              : "已停用联邦",
        onSuccess: () => setStatus({ ...status, enabled: target }),
      },
    );
    setConfirmOpen(false);
  };

  return (
    <div className="flex flex-col gap-4" data-testid="federation-overview">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          testId="fed-stat-enabled"
          label={locale === "en" ? "State" : "联邦状态"}
          value={status.enabled ? (locale === "en" ? "Enabled" : "已启用") : locale === "en" ? "Disabled" : "已停用"}
          hint={
            status.enabled
              ? locale === "en"
                ? "Cross-panel leases allowed"
                : "允许跨面板租约"
              : locale === "en"
                ? "All federation calls fail closed"
                : "所有联邦调用 fail-closed"
          }
        />
        <StatTile testId="fed-stat-peers" label={locale === "en" ? "Peers" : "对等面板"} value={String(status.peers)} hint={`${status.revoked_peers} ${locale === "en" ? "revoked" : "已撤销"}`} />
        <StatTile testId="fed-stat-grants" label={locale === "en" ? "Grants" : "授予"} value={String(status.grants)} />
        <StatTile
          testId="fed-stat-leases"
          label={locale === "en" ? "Live remote leases" : "活跃远端租约"}
          value={String(status.active_leases)}
          hint={locale === "en" ? "reserved / active / releasing" : "reserved / active / releasing"}
        />
      </div>

      <FederationSection
        testId="federation-identity"
        title={locale === "en" ? "Local panel identity" : "本机面板身份"}
        description={
          locale === "en"
            ? "Stable panel_id (changes only on reinstall) and the current signing key id."
            : "稳定 panel_id（只有重装才变）与当前签名密钥 key_id。"
        }
        actions={
          <>
            <Button variant="outline" size="sm" onClick={refresh} disabled={pending !== null}>
              <RefreshCw className="size-3.5" />
              {locale === "en" ? "Refresh" : "刷新"}
            </Button>
            <Button
              variant={status.enabled ? "destructive" : "default"}
              size="sm"
              data-testid="federation-toggle"
              onClick={() => setConfirmOpen(true)}
              disabled={pending !== null}
            >
              <Power className="size-3.5" />
              {status.enabled ? (locale === "en" ? "Disable federation" : "停用联邦") : locale === "en" ? "Enable federation" : "启用联邦"}
            </Button>
          </>
        }
      >
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-[var(--muted-foreground)]">panel_id</dt>
            <dd className="font-mono text-xs" data-testid="federation-panel-id">
              {status.panel_id ?? "—"}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--muted-foreground)]">key_id</dt>
            <dd className="font-mono text-xs" data-testid="federation-key-id">
              {status.key_id ?? "—"}
            </dd>
          </div>
        </dl>
        {!status.enabled && (
          <p className="mt-3 text-xs text-[var(--muted-foreground)]" data-testid="federation-disabled-hint">
            {locale === "en"
              ? "Federation is off: peer requests are rejected with federation_disabled (no silent local fallback)."
              : "联邦已关闭：对端请求会被 federation_disabled 拒绝，且不会静默回落到本地节点。"}
          </p>
        )}
        <div className="mt-3 flex items-center gap-2">
          <StatusPill
            label={status.enabled ? (locale === "en" ? "enabled" : "已启用") : locale === "en" ? "disabled" : "已停用"}
            tone={status.enabled ? "success" : "muted"}
            testId="federation-state-pill"
          />
        </div>
      </FederationSection>

      {error && <FederationErrorNotice error={error} locale={locale} onRetry={refresh} />}
      {notice && (
        <p className="text-sm text-[var(--muted-foreground)]" data-testid="federation-overview-notice">
          {notice}
        </p>
      )}
      {pending && (
        <p className="text-xs text-[var(--muted-foreground)]" data-testid="federation-pending">
          {locale === "en" ? "working…" : "处理中…"}
        </p>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{status.enabled ? (locale === "en" ? "Disable federation?" : "确认停用联邦？") : locale === "en" ? "Enable federation?" : "确认启用联邦？"}</DialogTitle>
            <DialogDescription>
              {status.enabled
                ? locale === "en"
                  ? "Peer calls will be rejected (fail-closed) until you enable it again. Existing leases keep their own state and will be reconciled."
                  : "对端调用会被 fail-closed 拒绝，直到重新启用。已有租约保持自身状态，由对账收敛。"
                : locale === "en"
                  ? "This generates the panel key pair on first use and allows peer trust to be established."
                  : "首次启用会生成本机密钥对，并允许建立对端信任。"}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              {locale === "en" ? "Cancel" : "取消"}
            </Button>
            <Button variant={status.enabled ? "destructive" : "default"} data-testid="federation-toggle-confirm" onClick={toggle}>
              {locale === "en" ? "Confirm" : "确认"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {pending === "refresh" && <Badge variant="outline">refresh</Badge>}
    </div>
  );
}
