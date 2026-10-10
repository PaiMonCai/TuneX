"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useI18n } from "@/components/providers";
import { LinkBindingForm, LinkConfigForm, selectClass } from "@/components/links/link-forms";
import { linksCopy } from "@/components/links/links-copy";
import { linksApi, linkErrorInfo } from "@/lib/links-api";
import type { LinkBindingInput, LinkCreateInput, LinkResource } from "@/lib/links-types";
import type { UserNode } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type ReadState = "loading" | "ready" | "failed";

/**
 * Unified Forward creation keeps the Link as the sole writer for FXP-managed rules.
 * Neither the native Forward API nor its runtime is used here.
 */
export function EncryptedForwardCreateDialog({ workspaceId, nodes, canManageNodes, onClose, onCreated }: {
  workspaceId: number; nodes: UserNode[]; canManageNodes: boolean;
  onClose: () => void; onCreated: (linkId: number, forwardId: number) => void;
}) {
  const { locale } = useI18n();
  const copy = linksCopy(locale);
  const zh = locale !== "en";
  const [links, setLinks] = useState<LinkResource[]>([]);
  const [readState, setReadState] = useState<ReadState>("loading");
  const [linkId, setLinkId] = useState("");
  const [newLink, setNewLink] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [writeUnconfirmed, setWriteUnconfirmed] = useState(false);

  useEffect(() => {
    let current = true;
    linksApi.list(workspaceId).then((result) => {
      if (!current) return;
      setLinks(result.filter((link) => !["retiring", "retired"].includes(link.status)));
      setReadState("ready");
    }).catch(() => { if (current) setReadState("failed"); });
    return () => { current = false; };
  }, [workspaceId]);

  const onNewLink = async (input: LinkCreateInput) => {
    if (busy || !canManageNodes) return;
    setBusy(true); setErrorCode(null);
    try {
      const created = await linksApi.create(workspaceId, input);
      setLinks((rows) => [created, ...rows]);
      setLinkId(String(created.id));
      setNewLink(false);
    } catch (error) {
      setErrorCode(linkErrorInfo(error).code);
      // A lost response may follow a committed write. Don't offer blind retry.
      setWriteUnconfirmed(true);
    } finally { setBusy(false); }
  };

  const onCreateForward = async (binding: LinkBindingInput) => {
    const id = Number(linkId);
    if (busy || writeUnconfirmed || !Number.isSafeInteger(id) || id <= 0) return;
    setBusy(true); setErrorCode(null);
    try {
      const created = await linksApi.createForward(workspaceId, id, binding);
      onCreated(id, created.id);
    } catch (error) {
      setErrorCode(linkErrorInfo(error).code);
      // The Forward revision can persist before Link deployment fails.
      setWriteUnconfirmed(true);
    } finally { setBusy(false); }
  };

  const selected = links.find((link) => String(link.id) === linkId);
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent className="max-w-2xl" data-testid="encrypted-forward-create">
      <DialogHeader>
        <DialogTitle>{zh ? "创建加密转发" : "Create encrypted forward"}</DialogTitle>
        <DialogDescription>{zh
          ? "每条转发规则绑定一个可复用的 FXP 加密连接；节点间连接端口与业务监听端口分别配置。"
          : "Bind a forwarding rule to a reusable FXP link. The carrier port is separate from the business listener."}</DialogDescription>
      </DialogHeader>
      {!canManageNodes ? <p role="alert">{zh ? "创建或使用加密连接需要节点管理权限。" : "Managing an encrypted link requires node management permission."}</p>
      : readState === "loading" ? <p role="status">{copy.loading}</p>
      : readState === "failed" ? <div className="space-y-2"><p role="alert">{copy.readFailed}</p>
          <Button variant="outline" onClick={onClose}>{copy.cancel}</Button></div>
      : <>
        {errorCode && <div role="alert" className="rounded-md border border-[var(--destructive)] p-3 text-sm text-[var(--destructive)]">
          {errorCode === "fxp_links_not_enabled" ? copy.disabled : copy.failed} <span className="font-mono">{errorCode}</span>
        </div>}
        {writeUnconfirmed ? <div className="space-y-3 rounded-md border border-[var(--border)] p-3" data-testid="encrypted-forward-unconfirmed">
          <p className="text-sm">{zh
            ? "请求结果尚未确认。为避免重复创建，请先到加密连接资源页核对实际规则和部署状态。"
            : "The write result is unconfirmed. Check the link and its rules before attempting another creation."}</p>
          <Button asChild variant="outline"><Link href={selected ? `/links?selected=${selected.id}` : "/links"}>{zh ? "查看加密连接" : "Inspect encrypted links"}</Link></Button>
        </div> : <>
          {!newLink && <div className="space-y-2">
            <Label htmlFor="encrypted-forward-link">{zh ? "选择加密连接（Link）" : "Encrypted link"}</Label>
            <select id="encrypted-forward-link" className={selectClass} value={linkId} disabled={busy} onChange={(e) => setLinkId(e.target.value)}>
              <option value="">{zh ? "请选择已有加密连接" : "Choose an existing link"}</option>
              {links.map((link) => <option key={link.id} value={link.id}>{link.name} · #{link.id} · {link.status}</option>)}
            </select>
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="outline" size="sm" disabled={busy} onClick={() => { setNewLink(true); setLinkId(""); }}>
                {zh ? "新建加密连接" : "Create new link"}
              </Button>
              <Link className="text-sm underline underline-offset-4" href="/links">{zh ? "管理连接资源" : "Manage link resources"}</Link>
            </div>
            {links.length === 0 && <p className="text-sm text-[var(--muted-foreground)]">{zh
              ? "还没有可复用的加密连接。请先创建连接，再添加业务规则。"
              : "No reusable link yet. Create one before adding a forwarding rule."}</p>}
          </div>}
          {newLink ? <section className="space-y-3 rounded-md border border-[var(--border)] p-3">
              <h3 className="font-medium">{zh ? "第一步：创建加密连接" : "Step 1: Create encrypted link"}</h3>
              <LinkConfigForm copy={copy} nodes={nodes} nodesError={false} busy={busy}
                onCancel={() => setNewLink(false)} onSubmit={onNewLink} />
            </section>
          : selected ? <section className="space-y-3 rounded-md border-t border-[var(--border)] pt-4">
              <h3 className="font-medium">{zh ? "第二步：配置业务转发规则" : "Step 2: Configure forwarding rule"}</h3>
              <p className="text-sm text-[var(--muted-foreground)]">{zh
                ? "创建后由加密连接部署流程统一应用。后续修改、暂停或删除请到对应连接管理。"
                : "The FXP link owns deployment. Edit, suspend or delete this rule from its link management page."}</p>
              <LinkBindingForm key={selected.id} copy={copy} busy={busy} onCancel={onClose} onSubmit={onCreateForward} />
            </section>
          : null}
        </>}
      </>}
    </DialogContent>
  </Dialog>;
}
