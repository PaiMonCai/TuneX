"use client";

import { useState } from "react";
import { KeyRound, RefreshCw, ShieldOff } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { TableCell, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  CodeBadge,
  FederationErrorNotice,
  FederationSection,
  FederationTable,
  type Locale,
  StatusPill,
  TrustIcon,
} from "@/components/admin/federation/federation-ui";
import { useFederationAction } from "@/components/admin/federation/use-federation-action";
import { peerStatusText, scopeSummary } from "@/components/admin/federation/federation-status";
import type { FederationPeer } from "@/lib/types";

/**
 * 信任与密钥（`/admin/federation/trust`）。
 *
 * 与「对等面板」页的分工：那页管**建立/撤销信任**（邀请、握手、ping），
 * 这页管**信任的范围与密钥材料**：每个 peer 的 `trust_scope`（允许的节点组 / hop 角色）、
 * 当前 key_id 指纹、逐 peer 轮转密钥，以及本机密钥的整体轮转。
 *
 * 全部动作都用**真实端点**（`GET /peers`、`POST /peers/:id/rotate`、`POST /key/rotate`、
 * `DELETE /peers/:id`），没有 mock-only 的界面。
 */
export function FederationTrustManager({ initial, locale }: { initial: FederationPeer[]; locale: Locale }) {
  const [peers, setPeers] = useState<FederationPeer[]>(initial);
  const [revokeTarget, setRevokeTarget] = useState<FederationPeer | null>(null);
  const [rotateAllOpen, setRotateAllOpen] = useState(false);
  const [rotateAllResult, setRotateAllResult] = useState<string | null>(null);
  const { pending, error, notice, run } = useFederationAction();

  const refresh = async () => {
    await run("refresh", () => api.admin.federation.peers(), {
      onSuccess: (next) => setPeers(next as FederationPeer[]),
    });
  };

  const rotateOne = (peer: FederationPeer) =>
    run(`rotate:${peer.id}`, () => api.admin.federation.rotatePeerKey(peer.id), {
      describe: (result) =>
        `${peer.display_name} · ${locale === "en" ? "new key" : "新密钥"} ${
          (result as { key_id: string }).key_id
        } · ${(result as { notified: string[] }).notified.length} ${locale === "en" ? "notified" : "个对端已同步"}`,
      onSuccess: () => refresh(),
    });

  const rotateAll = async () => {
    const okDone = await run("rotate-all", () => api.admin.federation.rotateLocalKey(), {
      describe: (result) => {
        const body = result as { ok: boolean; key_id: string; notified: string[]; failed?: Array<{ peer_panel_id: string; code: string }> };
        if (body.ok) {
          return `${locale === "en" ? "Rotated" : "已轮转"} · key_id=${body.key_id} · ${body.notified.length} ${
            locale === "en" ? "peers notified" : "个对端已通知"
          }`;
        }
        return locale === "en" ? "Rotation aborted (some peers rejected the new key)" : "轮转已放弃（部分对端未接受新公钥）";
      },
      onSuccess: (result) => {
        const body = result as { ok: boolean; key_id: string; failed?: Array<{ peer_panel_id: string; code: string }> };
        setRotateAllResult(
          body.ok
            ? null
            : `${locale === "en" ? "failed peers" : "失败对端"}: ${(body.failed ?? [])
                .map((f) => `${f.peer_panel_id}(${f.code})`)
                .join(", ")}`,
        );
        setRotateAllOpen(false);
      },
    });
    if (okDone) await refresh();
  };

  const revoke = async () => {
    if (!revokeTarget) return;
    const target = revokeTarget;
    const okDone = await run("revoke", () => api.admin.federation.revokePeer(target.id), {
      describe: (result) =>
        `${locale === "en" ? "Revoked" : "已撤销"} · ${(result as { revoked_leases: number }).revoked_leases} ${
          locale === "en" ? "leases cascaded" : "条租约级联撤销"
        }`,
      onSuccess: () => setRevokeTarget(null),
    });
    if (okDone) await refresh();
  };

  return (
    <div className="flex flex-col gap-4" data-testid="federation-trust">
      <FederationSection
        testId="federation-trust-scope"
        title={locale === "en" ? "Trust scope & key material" : "信任范围与密钥材料"}
        description={
          locale === "en"
            ? "Scope is what this panel allows the peer to consume. Only key ids (fingerprints) are displayed."
            : "范围表示本机允许该对端消费什么。这里只展示 key_id 指纹。"
        }
        actions={
          <>
            <Button variant="outline" size="sm" onClick={refresh} disabled={pending !== null}>
              <RefreshCw className="size-3.5" />
              {locale === "en" ? "Refresh" : "刷新"}
            </Button>
            <Button variant="default" size="sm" data-testid="federation-key-rotate-all" onClick={() => setRotateAllOpen(true)} disabled={pending !== null}>
              <KeyRound className="size-3.5" />
              {locale === "en" ? "Rotate local key" : "轮转本机密钥"}
            </Button>
          </>
        }
      >
        <FederationTable
          rowCount={peers.length}
          empty={locale === "en" ? "No peers yet." : "还没有对等面板。"}
          columns={[
            { key: "peer", label: locale === "en" ? "Peer" : "对端" },
            { key: "status", label: locale === "en" ? "Trust" : "信任" },
            { key: "scope", label: locale === "en" ? "Allowed scope" : "允许范围" },
            { key: "keys", label: locale === "en" ? "Keys (key_id)" : "密钥（key_id）" },
            { key: "actions", label: locale === "en" ? "Actions" : "操作" },
          ]}
        >
          {peers.map((peer) => {
            const status = peerStatusText(locale, peer.status);
            return (
              <TrustRow
                key={peer.id}
                peer={peer}
                statusLabel={status.label}
                statusTone={status.tone}
                scopeText={peer.trust_scope ? scopeSummary(locale, peer.trust_scope) : locale === "en" ? "not negotiated" : "尚未协商"}
                locale={locale}
                disabled={pending !== null || peer.status === "revoked"}
                onRotate={() => void rotateOne(peer)}
                onRevoke={() => setRevokeTarget(peer)}
              />
            );
          })}
        </FederationTable>
      </FederationSection>

      {error && <FederationErrorNotice error={error} locale={locale} onRetry={refresh} />}
      {notice && (
        <p className="text-sm text-[var(--muted-foreground)]" data-testid="federation-trust-notice">
          {notice}
        </p>
      )}
      {rotateAllResult && (
        <p className="text-sm text-[var(--destructive)]" data-testid="federation-key-rotate-failures">
          {rotateAllResult}
        </p>
      )}

      <Dialog open={rotateAllOpen} onOpenChange={setRotateAllOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{locale === "en" ? "Rotate local signing key?" : "确认轮转本机密钥？"}</DialogTitle>
            <DialogDescription>
              {locale === "en"
                ? "All trusted peers are notified. If any peer rejects the new public key the whole rotation is abandoned (no half-rotated state)."
                : "会通知所有可信对端。任一 peer 不接受新公钥则整体放弃，不会留下半轮转状态。"}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRotateAllOpen(false)}>
              {locale === "en" ? "Cancel" : "取消"}
            </Button>
            <Button data-testid="federation-key-rotate-all-confirm" onClick={() => void rotateAll()} disabled={pending !== null}>
              {locale === "en" ? "Rotate" : "确认轮转"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={revokeTarget !== null} onOpenChange={(open) => !open && setRevokeTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldOff className="size-4 text-[var(--destructive)]" />
              {locale === "en" ? "Revoke trust (irreversible)" : "撤销信任（不可逆）"}
            </DialogTitle>
            <DialogDescription>
              {locale === "en"
                ? "The peer's live leases are cascaded to revoked and services are stopped."
                : "该对端的活跃租约会级联置为 revoked 并停服。"}
            </DialogDescription>
          </DialogHeader>
          {revokeTarget && <CodeBadge code={revokeTarget.peer_panel_id} />}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevokeTarget(null)}>
              {locale === "en" ? "Cancel" : "取消"}
            </Button>
            <Button variant="destructive" data-testid="federation-trust-revoke-confirm" onClick={() => void revoke()} disabled={pending !== null}>
              {locale === "en" ? "Revoke" : "确认撤销"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 单行信任（拆出来避免内联回调把表格 JSX 撑爆）。 */
function TrustRow({
  peer,
  statusLabel,
  statusTone,
  scopeText,
  locale,
  disabled,
  onRotate,
  onRevoke,
}: {
  peer: FederationPeer;
  statusLabel: string;
  statusTone: "success" | "secondary" | "outline" | "muted" | "destructive";
  scopeText: string;
  locale: Locale;
  disabled: boolean;
  onRotate: () => void;
  onRevoke: () => void;
}) {
  return (
    <TableRow data-testid="federation-trust-row" data-peer-panel-id={peer.peer_panel_id}>
      <TableCell data-peer-panel-id={peer.peer_panel_id}>
        <div className="flex items-center gap-2">
          <TrustIcon status={peer.status} />
          <div>
            <div className="font-medium">{peer.display_name}</div>
            <div className="font-mono text-[11px] text-[var(--muted-foreground)]">{peer.peer_panel_id}</div>
          </div>
        </div>
      </TableCell>
      <TableCell>
        <StatusPill label={statusLabel} tone={statusTone} />
      </TableCell>
      <TableCell className="text-xs" data-testid="federation-trust-scope-cell">
        {scopeText}
      </TableCell>
      <TableCell>
        {peer.key_ids.length === 0 ? (
          <span className="text-[var(--muted-foreground)]">—</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {peer.key_ids.map((kid) => (
              <CodeBadge key={kid} code={kid} />
            ))}
          </div>
        )}
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1">
          <Button variant="ghost" size="sm" data-testid="federation-trust-rotate" disabled={disabled} onClick={onRotate}>
            <KeyRound className="size-3.5" />
            {locale === "en" ? "rotate" : "轮转"}
          </Button>
          <Button variant="ghost" size="sm" disabled={disabled} onClick={onRevoke}>
            <ShieldOff className="size-3.5" />
            {locale === "en" ? "revoke" : "撤销"}
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}
