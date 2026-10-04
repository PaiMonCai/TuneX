"use client";

import { useState } from "react";
import { Activity, KeyRound, Plus, RefreshCw, ShieldOff, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import { Input, Label } from "@/components/ui/input";
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
  TokenOncePanel,
  TrustIcon,
} from "@/components/admin/federation/federation-ui";
import { useFederationAction } from "@/components/admin/federation/use-federation-action";
import {
  dismissInvitation,
  invitationTokenForDisplay,
  NO_INVITATION,
  peerStatusText,
  revealInvitation,
  type InvitationOnceState,
} from "@/components/admin/federation/federation-status";
import type { FederationPeer } from "@/lib/types";

/**
 * 对等面板（`/admin/federation/peers`）：信任列表 + 邀请 + 握手 + ping + 轮转 + 撤销。
 *
 * 每条动作都直接把**后端错误码**摊给管理员（`FederationErrorNotice`）：
 * `peer_unreachable`（网络不通，可重试）与 `handshake_invalid`（token 无效）
 * 是两件完全不同的事，界面必须分得开。
 */
export function FederationPeersManager({ initial, locale }: { initial: FederationPeer[]; locale: Locale }) {
  const [peers, setPeers] = useState<FederationPeer[]>(initial);
  const [invitation, setInvitation] = useState<InvitationOnceState>(NO_INVITATION);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [handshakeOpen, setHandshakeOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<FederationPeer | null>(null);
  const [revokedImpact, setRevokedImpact] = useState<{ peer_panel_id: string; revoked_leases: number } | null>(null);
  const [inviteForm, setInviteForm] = useState({ display_name: "", endpoint_url: "", ttl_seconds: "900" });
  const [handshakeForm, setHandshakeForm] = useState({ endpoint_url: "", token: "", display_name: "TuneX Panel" });
  const { pending, error, notice, run, clear } = useFederationAction();

  const refresh = async () => {
    await run("refresh", () => api.admin.federation.peers(), {
      onSuccess: (next) => setPeers(next as FederationPeer[]),
    });
  };

  const submitInvite = async () => {
    const okDone = await run(
      "invite",
      () =>
        api.admin.federation.invitePeer({
          display_name: inviteForm.display_name.trim(),
          endpoint_url: inviteForm.endpoint_url.trim(),
          ttl_seconds: Number(inviteForm.ttl_seconds) || undefined,
        }),
      {
        describe: (result) =>
          `${locale === "en" ? "Invitation created" : "邀请已生成"} · peer_id=${(result as { peer_id: number }).peer_id}`,
        onSuccess: (result) => {
          // 明文 token 只进这一次性状态；列表刷新不会带出它
          setInvitation(revealInvitation(result as never));
          setInviteOpen(false);
        },
      },
    );
    if (okDone) await refresh();
  };

  const submitHandshake = async () => {
    const okDone = await run("handshake", () =>
      api.admin.federation.handshake({
        endpoint_url: handshakeForm.endpoint_url.trim(),
        token: handshakeForm.token.trim(),
        display_name: handshakeForm.display_name.trim() || "TuneX Panel",
      }),
      {
        describe: (result) =>
          `${locale === "en" ? "Trust established" : "信任已建立"} · ${
            (result as { peer_panel_id: string }).peer_panel_id
          }`,
        onSuccess: () => {
          setHandshakeOpen(false);
          setHandshakeForm({ endpoint_url: "", token: "", display_name: "TuneX Panel" });
        },
      },
    );
    if (okDone) await refresh();
  };

  const ping = (peer: FederationPeer) =>
    run(`ping:${peer.id}`, () => api.admin.federation.pingPeer(peer.id), {
      describe: (result) =>
        `${peer.display_name} ${locale === "en" ? "reachable" : "可达"} · ${
          (result as { peer_panel_id: string }).peer_panel_id
        }`,
      onSuccess: () => refresh(),
    });

  const rotate = (peer: FederationPeer) =>
    run(`rotate:${peer.id}`, () => api.admin.federation.rotatePeerKey(peer.id), {
      describe: (result) =>
        `${locale === "en" ? "Key rotated" : "密钥已轮转"} · key_id=${(result as { key_id: string }).key_id}`,
      onSuccess: () => refresh(),
    });

  const revoke = async () => {
    if (!revokeTarget) return;
    const target = revokeTarget;
    const okDone = await run("revoke", () => api.admin.federation.revokePeer(target.id), {
      describe: (result) =>
        `${locale === "en" ? "Trust revoked" : "信任已撤销"} · ${
          (result as { revoked_leases: number }).revoked_leases
        } ${locale === "en" ? "leases revoked" : "条租约被连带撤销"}`,
      onSuccess: (result) => {
        setRevokedImpact({
          peer_panel_id: (result as { peer_panel_id: string }).peer_panel_id,
          revoked_leases: (result as { revoked_leases: number }).revoked_leases,
        });
        setRevokeTarget(null);
      },
    });
    if (okDone) await refresh();
  };

  return (
    <div className="flex flex-col gap-4" data-testid="federation-peers">
      <FederationSection
        testId="federation-peers-section"
        title={locale === "en" ? "Trusted peers" : "信任的对等面板"}
        description={
          locale === "en"
            ? "Fingerprints are key ids only — public keys are never rendered. Ping distinguishes network failures from trust failures."
            : "指纹只展示 key_id（不下发公钥原文）。ping 自检区分「网络不通」与「信任不成立」。"
        }
        actions={
          <>
            <Button variant="outline" size="sm" onClick={refresh} disabled={pending !== null}>
              <RefreshCw className="size-3.5" />
              {locale === "en" ? "Refresh" : "刷新"}
            </Button>
            <Button variant="outline" size="sm" data-testid="federation-handshake-open" onClick={() => setHandshakeOpen(true)} disabled={pending !== null}>
              <KeyRound className="size-3.5" />
              {locale === "en" ? "Handshake with token" : "用 token 握手"}
            </Button>
            <Button variant="default" size="sm" data-testid="federation-invite-open" onClick={() => setInviteOpen(true)} disabled={pending !== null}>
              <Plus className="size-3.5" />
              {locale === "en" ? "Create invitation" : "生成邀请"}
            </Button>
          </>
        }
      >
        {invitationTokenForDisplay(invitation) && (
          <div className="mb-3">
            <TokenOncePanel state={invitation} locale={locale} onDismiss={() => setInvitation(dismissInvitation(invitation))} />
          </div>
        )}
        {revokedImpact && (
          <p className="mb-3 text-sm" data-testid="federation-revoke-impact">
            {locale === "en" ? "Revoked peer" : "已撤销对端"} <CodeBadge code={revokedImpact.peer_panel_id} /> ·{" "}
            {revokedImpact.revoked_leases} {locale === "en" ? "leases cascaded to revoked" : "条租约被级联撤销"}
          </p>
        )}
        <FederationTable
          rowCount={peers.length}
          empty={locale === "en" ? "No peers yet." : "还没有对等面板。"}
          columns={[
            { key: "peer", label: locale === "en" ? "Peer" : "对端" },
            { key: "status", label: locale === "en" ? "Trust" : "信任" },
            { key: "endpoint", label: "Endpoint" },
            { key: "fingerprint", label: locale === "en" ? "Fingerprint (key_id)" : "指纹（key_id）" },
            { key: "seen", label: locale === "en" ? "Last seen" : "最近可见" },
            { key: "actions", label: locale === "en" ? "Actions" : "操作" },
          ]}
        >
          {peers.map((peer) => {
            const status = peerStatusText(locale, peer.status);
            const mutable = peer.status !== "revoked";
            return (
              <TableRow key={peer.id} data-testid="federation-peer-row" data-peer-panel-id={peer.peer_panel_id}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <TrustIcon status={peer.status} />
                    <span className="font-medium">{peer.display_name}</span>
                  </div>
                  <div className="font-mono text-[11px] text-[var(--muted-foreground)]">{peer.peer_panel_id}</div>
                </TableCell>
                <TableCell>
                  <StatusPill label={status.label} tone={status.tone} testId="federation-peer-status" />
                </TableCell>
                <TableCell className="font-mono text-[11px]">{peer.endpoint_url}</TableCell>
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
                <TableCell className="text-xs text-[var(--muted-foreground)]">{formatDateTime(peer.last_seen_at)}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid="federation-peer-ping"
                      disabled={pending !== null}
                      onClick={() => void ping(peer)}
                    >
                      <Activity className="size-3.5" />
                      ping
                    </Button>
                    <Button variant="ghost" size="sm" disabled={pending !== null || !mutable} onClick={() => void rotate(peer)}>
                      <KeyRound className="size-3.5" />
                      {locale === "en" ? "rotate" : "轮转"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid="federation-peer-revoke"
                      disabled={pending !== null || !mutable}
                      onClick={() => setRevokeTarget(peer)}
                    >
                      <Trash2 className="size-3.5" />
                      {locale === "en" ? "revoke" : "撤销"}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </FederationTable>
      </FederationSection>

      {error && <FederationErrorNotice error={error} locale={locale} onRetry={refresh} />}
      {notice && (
        <p className="text-sm text-[var(--muted-foreground)]" data-testid="federation-peers-notice">
          {notice}
        </p>
      )}
      {pending && (
        <p className="text-xs text-[var(--muted-foreground)]" data-testid="federation-pending">
          {locale === "en" ? "working…" : "处理中…"}
        </p>
      )}

      {/* 生成邀请 */}
      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{locale === "en" ? "Create trust invitation" : "生成信任邀请"}</DialogTitle>
            <DialogDescription>
              {locale === "en"
                ? "The token is shown exactly once and must be delivered out-of-band."
                : "token 只会显示一次，必须通过带外渠道交给对端管理员。"}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div>
              <Label htmlFor="fed-invite-name">{locale === "en" ? "Display name" : "显示名"}</Label>
              <Input
                id="fed-invite-name"
                data-testid="federation-invite-name"
                value={inviteForm.display_name}
                onChange={(e) => setInviteForm({ ...inviteForm, display_name: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="fed-invite-endpoint">{locale === "en" ? "Peer endpoint URL" : "对端地址"}</Label>
              <Input
                id="fed-invite-endpoint"
                data-testid="federation-invite-endpoint"
                placeholder="https://panel-b.internal:3000"
                value={inviteForm.endpoint_url}
                onChange={(e) => setInviteForm({ ...inviteForm, endpoint_url: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="fed-invite-ttl">{locale === "en" ? "TTL (seconds, 60–3600)" : "有效期（秒，60–3600）"}</Label>
              <Input
                id="fed-invite-ttl"
                value={inviteForm.ttl_seconds}
                onChange={(e) => setInviteForm({ ...inviteForm, ttl_seconds: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInviteOpen(false)}>
              {locale === "en" ? "Cancel" : "取消"}
            </Button>
            <Button data-testid="federation-invite-submit" onClick={() => void submitInvite()} disabled={pending !== null}>
              {locale === "en" ? "Generate" : "生成"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 握手 */}
      <Dialog open={handshakeOpen} onOpenChange={setHandshakeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{locale === "en" ? "Handshake using a token" : "用 token 完成握手"}</DialogTitle>
            <DialogDescription>
              {locale === "en"
                ? "Use the token the peer admin gave you. Failures keep the backend code (handshake_invalid / peer_unreachable)."
                : "填入对端管理员给你的 token。失败时保留后端错误码（handshake_invalid / peer_unreachable）。"}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div>
              <Label htmlFor="fed-hs-endpoint">{locale === "en" ? "Peer endpoint URL" : "对端地址"}</Label>
              <Input
                id="fed-hs-endpoint"
                data-testid="federation-handshake-endpoint"
                value={handshakeForm.endpoint_url}
                onChange={(e) => setHandshakeForm({ ...handshakeForm, endpoint_url: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="fed-hs-token">token</Label>
              <Input
                id="fed-hs-token"
                data-testid="federation-handshake-token"
                value={handshakeForm.token}
                onChange={(e) => setHandshakeForm({ ...handshakeForm, token: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setHandshakeOpen(false)}>
              {locale === "en" ? "Cancel" : "取消"}
            </Button>
            <Button data-testid="federation-handshake-submit" onClick={() => void submitHandshake()} disabled={pending !== null}>
              {locale === "en" ? "Handshake" : "握手"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 撤销二次确认（不可逆） */}
      <Dialog open={revokeTarget !== null} onOpenChange={(open) => !open && setRevokeTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldOff className="size-4 text-[var(--destructive)]" />
              {locale === "en" ? "Revoke trust (irreversible)" : "撤销信任（不可逆）"}
            </DialogTitle>
            <DialogDescription>
              {locale === "en"
                ? "All live remote leases of this peer are cascaded to revoked and the services are stopped. A revoked trust cannot be revived — you must establish trust again."
                : "该 peer 名下所有活跃远端租约会级联置为 revoked 并停服。撤销不可逆，之后必须重新建立信任。"}
            </DialogDescription>
          </DialogHeader>
          {revokeTarget && (
            <div className="text-sm">
              <CodeBadge code={revokeTarget.peer_panel_id} />
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevokeTarget(null)}>
              {locale === "en" ? "Cancel" : "取消"}
            </Button>
            <Button variant="destructive" data-testid="federation-peer-revoke-confirm" onClick={() => void revoke()} disabled={pending !== null}>
              {locale === "en" ? "Revoke" : "确认撤销"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {error && (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={clear}>
            {locale === "en" ? "dismiss error" : "关闭错误提示"}
          </Button>
        </div>
      )}
    </div>
  );
}
