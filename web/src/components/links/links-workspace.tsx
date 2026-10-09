"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/components/providers";
import { useWorkspace } from "@/components/workspace/workspace-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { request } from "@/lib/api/core";
import { linksApi, linkErrorInfo, type LinkErrorInfo } from "@/lib/links-api";
import type { LinkDetail, LinkForward, LinkResource } from "@/lib/links-types";
import { isLinkMaintenancePreviewCurrent, type LinkMaintenancePreviewInput } from "@/lib/link-maintenance-types";
import type { UserNode } from "@/lib/types";
import { linksCopy, type LinksCopy } from "./links-copy";
import { LinkBindingForm, LinkConfigForm, selectClass } from "./link-forms";
import { LinkDetailView } from "./link-detail";
import { LinkMaintenancePanel } from "./link-maintenance-preview";
import { LinkErrorDetails } from "./link-error-details";
import { bindingFromForward, createLinksScopeFence, linkErrorMessage, linkIdFromSelection } from "./link-state";

/** Remount on privilege/scope changes so editors and in-flight results cannot cross workspaces. */
export function LinksWorkspace({ selectedId }: { selectedId?: number | null } = {}) {
  const { locale } = useI18n();
  const workspace = useWorkspace();
  const copy = linksCopy(locale);
  if (workspace.loading || workspace.permissionsLoading) return <p role="status">{copy.loading}</p>;
  if (workspace.currentId === null) return <p>{copy.workspace}</p>;
  if (!workspace.can("node:read")) return <p role="alert">{copy.denied}</p>;
  const scopeKey = JSON.stringify([workspace.currentId, workspace.permissions, selectedId]);
  const canUpdate = (forward: LinkForward) => workspace.can("forward:update")
    && (workspace.permissions?.forward_mutations === "workspace" || (forward.user_id != null && forward.user_id === workspace.me?.id));
  return <ScopedLinksWorkspace key={scopeKey} workspaceId={workspace.currentId} copy={copy} selectedId={selectedId}
    canManage={workspace.can("node:manage")} canCreateForward={workspace.can("forward:create")}
    canUpdateForward={canUpdate} canDeleteForward={(forward) => canUpdate(forward) && workspace.can("forward:delete")} />;
}

type Editor = { type: "create" } | { type: "config"; link: LinkDetail } | { type: "binding"; linkId: number; forward?: LinkForward };
type Confirmation = { type: "rotate"; link: LinkDetail } | { type: "retire"; link: LinkDetail } | { type: "delete"; link: LinkDetail; forward: LinkForward };
function ScopedLinksWorkspace({ workspaceId, copy, canManage, selectedId, canCreateForward, canUpdateForward, canDeleteForward }: {
  workspaceId: number; copy: LinksCopy; canManage: boolean; selectedId?: number | null;
  canCreateForward: boolean; canUpdateForward: (forward: LinkForward) => boolean; canDeleteForward: (forward: LinkForward) => boolean;
}) {
  const fence = useRef(createLinksScopeFence());
  const busyRef = useRef(false);
  const readTicket = useRef<ReturnType<ReturnType<typeof createLinksScopeFence>["next"]> | null>(null);
  const [list, setList] = useState<LinkResource[] | null>(null);
  const [nodes, setNodes] = useState<UserNode[]>([]);
  const [nodesError, setNodesError] = useState(false);
  const [selected, setSelected] = useState<number | null>(() => selectedId ?? (typeof window === "undefined" ? null
    : linkIdFromSelection(new URLSearchParams(window.location.search).get("selected"))));
  const [detail, setDetail] = useState<LinkDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [readError, setReadError] = useState<LinkErrorInfo | null>(null);
  const [error, setError] = useState<LinkErrorInfo | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewEpoch, setPreviewEpoch] = useState(0);
  const [now, setNow] = useState(Date.now);
  const invalidatePreview = useCallback(() => {
    fence.current.next("preview"); setPreviewEpoch((v) => v + 1);
  }, []);

  useEffect(() => {
    fence.current.setScope(workspaceId);
    return () => { fence.current.setScope(null); };
  }, [workspaceId]);
  const reload = useCallback(async (target = selected): Promise<boolean> => {
    invalidatePreview();
    const ticket = fence.current.next("read");
    readTicket.current = ticket;
    setLoading(true);
    const [resources, nodeResult, selectedResult] = await Promise.allSettled([
      linksApi.list(workspaceId), request<UserNode[]>("/nodes", { workspaceId }),
      target === null ? Promise.resolve(null) : linksApi.detail(workspaceId, target),
    ]);
    if (!fence.current.current(ticket)) return false;
    if (nodeResult.status === "fulfilled" && Array.isArray(nodeResult.value)) { setNodes(nodeResult.value); setNodesError(false); }
    else { setNodes([]); setNodesError(true); }
    let failed: LinkErrorInfo | null = null;
    if (resources.status === "fulfilled") {
      setList(resources.value);
      if (target === null && resources.value.length) setSelected(resources.value[0].id);
    } else { failed = linkErrorInfo(resources.reason); setList(null); }
    if (selectedResult.status === "fulfilled") setDetail(selectedResult.value);
    else { failed ??= linkErrorInfo(selectedResult.reason); setDetail(null); }
    setReadError(failed); setNow(Date.now()); setLoading(false);
    if (failed?.disabled) setBlocked(true);
    return failed === null;
  }, [workspaceId, selected, invalidatePreview]);
  useEffect(() => { setDetail(null); void reload(); }, [reload]);
  useEffect(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 1_000);
    const timer = window.setInterval(() => {
      if (!busyRef.current) void reload();
    }, 15_000);
    return () => { window.clearInterval(timer); window.clearInterval(clock); };
  }, [reload, editor, confirm]);

  const run = async (operation: () => Promise<unknown>, message = copy.submitted): Promise<boolean> => {
    if (busyRef.current || !canManage || blocked) return false;
    invalidatePreview();
    busyRef.current = true; setBusy(true); setError(null); setNotice(null);
    fence.current.next("read");
    const ticket = fence.current.next("mutation");
    try {
      await operation();
      if (!fence.current.current(ticket)) return false;
      const read = await reload();
      if (!fence.current.current(ticket)) return false;
      if (read) setNotice(message);
      // A confirmed write must not be re-submitted merely because its follow-up read failed.
      return true;
    } catch (failure) {
      if (!fence.current.current(ticket)) return false;
      const info = linkErrorInfo(failure);
      // A failed deployment can still persist desired state: re-read, never fabricate a rollback.
      await reload();
      if (!fence.current.current(ticket)) return false;
      setError(info);
      if (info.disabled) setBlocked(true);
      // Link writes may persist before deployment fails. Reopen from the re-read
      // desired state rather than repeat a create or keep a stale revision CAS.
      setEditor(null);
      return false;
    } finally {
      if (fence.current.current(ticket)) { busyRef.current = false; setBusy(false); }
    }
  };
  const refresh = () => { setError(null); setNotice(null); setBlocked(false); void reload(); };
  const mutationDisabled = busy || loading || blocked || !!readError;
  const previewMaintenance = async (input: LinkMaintenancePreviewInput) => {
    // POST for authorization/CSRF, but no write lifecycle, re-read, notice or editor changes.
    if (!canManage || mutationDisabled || busyRef.current || !detail || detail.id !== selected || !readTicket.current) return null;
    const capturedRead = readTicket.current;
    const ticket = fence.current.next("preview");
    const current = () => fence.current.current(ticket) && fence.current.current(capturedRead);
    try {
      const result = await linksApi.previewMaintenance(workspaceId, detail.id, input);
      return current() && isLinkMaintenancePreviewCurrent(result, detail, Date.now()) ? result : null;
    } catch (failure) {
      if (!current()) return null;
      throw failure;
    }
  };
  const nodeLabel = (id: number) => nodes.find((n) => n.id === id)?.node_id ?? `#${id}`;
  const showError = error ?? readError;
  return <div className="space-y-5" aria-busy={busy || loading}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-[var(--muted-foreground)]">{canManage ? copy.subtitle : copy.readonly}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy || loading} onClick={refresh}>{copy.refresh}</Button>
        {canManage && <Button disabled={mutationDisabled || !!editor || !!confirm} onClick={() => { setNotice(null); setError(null); setEditor({ type: "create" }); }}>{copy.create}</Button>}
      </div>
    </div>
    {showError && <div role="alert" className="space-y-2 rounded-md border border-[var(--destructive)] p-4 text-sm">
      <p>{linkErrorMessage(showError, copy, !error)}</p><LinkErrorDetails codes={[showError.code]} copy={copy} />
      <Button variant="outline" disabled={busy || loading} onClick={refresh}>{copy.reload}</Button>
    </div>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {loading && <p role="status" className="text-sm">{copy.loading}</p>}
    {list !== null && list.length === 0 && !loading && <Card><CardContent className="pt-5">{copy.empty}</CardContent></Card>}
    {!!list?.length && <div className="grid gap-2"><label htmlFor="links-selected" className="text-sm font-medium">{copy.select}</label>
      <select id="links-selected" className={`${selectClass} max-w-xl`} value={selected ?? ""} disabled={busy || !!editor || !!confirm} onChange={(e) => { invalidatePreview(); setPreviewOpen(false); fence.current.next("read"); setDetail(null); setError(null); setNotice(null); setSelected(Number(e.target.value)); }}>
        {list.map((link) => <option key={link.id} value={link.id}>{link.name}</option>)}
      </select>
    </div>}
    {editor && canManage && !blocked && <Card>
      <CardHeader><CardTitle>{editor.type === "create" ? copy.create : editor.type === "config" ? copy.edit : editor.forward ? copy.editForward : copy.addForward}</CardTitle></CardHeader>
      <CardContent>
        {editor.type === "create" || editor.type === "config" ? <LinkConfigForm key={editor.type} copy={copy} nodes={nodes} nodesError={nodesError}
          initial={editor.type === "config" ? editor.link.config ?? undefined : undefined} busy={mutationDisabled}
          onCancel={() => setEditor(null)} onSubmit={async (input) => {
            let createdId: number | null = null;
            const ok = await run(async () => {
              if (editor.type === "config") return linksApi.updateConfig(workspaceId, editor.link.id, editor.link.desired_version, input.config);
              const created = await linksApi.create(workspaceId, input); createdId = created.id; return created;
            }, editor.type === "config" ? copy.configSaved : copy.submitted);
            if (ok) { setEditor(null); if (createdId !== null) setSelected(createdId); }
          }} /> : <LinkBindingForm key={editor.forward?.id ?? "new"} copy={copy}
          initial={editor.forward ? bindingFromForward(editor.forward) : undefined} busy={mutationDisabled}
          onCancel={() => setEditor(null)} onSubmit={async (binding) => {
            const ok = await run(() => editor.forward
              ? linksApi.updateForward(workspaceId, editor.linkId, editor.forward.id, editor.forward.config_revision, binding)
              : linksApi.createForward(workspaceId, editor.linkId, binding));
            if (ok) setEditor(null);
          }} />}
      </CardContent>
    </Card>}
    {confirm && <Card>
      <CardHeader><CardTitle>{confirm.type === "rotate" ? copy.rotate : confirm.type === "retire" ? copy.retire : copy.delete}</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm">{confirm.type === "rotate" ? copy.rotateHint : confirm.type === "retire" ? copy.retireHint : copy.deleteHint}</p>
        <p className="text-sm">{confirm.link.name} · {copy.refs}: {confirm.link.ref_count ?? copy.unknown}{confirm.type === "delete" ? ` · ${confirm.forward.name}` : ""}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy} onClick={() => setConfirm(null)}>{copy.cancel}</Button>
          <Button variant={confirm.type === "rotate" ? "default" : "destructive"} disabled={mutationDisabled} onClick={() => void (async () => {
            const ok = await run(() => confirm.type === "rotate" ? linksApi.rotateKey(workspaceId, confirm.link.id)
              : confirm.type === "retire" ? linksApi.retire(workspaceId, confirm.link.id)
              : linksApi.actionForward(workspaceId, confirm.link.id, confirm.forward.id, "delete"));
            if (ok) setConfirm(null);
          })()}>{busy ? copy.working : confirm.type === "rotate" ? copy.rotate : confirm.type === "retire" ? copy.retire : copy.delete}</Button>
        </div>
      </CardContent>
    </Card>}
    {previewOpen && detail && canManage && !readError && !blocked && <LinkMaintenancePanel invalidationEpoch={previewEpoch}
      link={detail} copy={copy} nodes={nodes} nodesError={nodesError} busy={mutationDisabled} now={now} nodeLabel={nodeLabel}
      onClose={() => { invalidatePreview(); setPreviewOpen(false); }} onPreview={previewMaintenance} />}
    {detail && !readError && <LinkDetailView link={detail} copy={copy} now={now} canManage={canManage} busy={mutationDisabled || !!editor || !!confirm}
      canCreateForward={canCreateForward} canUpdateForward={canUpdateForward} canDeleteForward={canDeleteForward}
      nodeLabel={nodeLabel} onEdit={() => setEditor({ type: "config", link: detail })}
      onPreview={previewOpen ? undefined : () => { invalidatePreview(); setPreviewOpen(true); }}
      onDeploy={() => void run(() => linksApi.deploy(workspaceId, detail.id))}
      onRotate={() => setConfirm({ type: "rotate", link: detail })} onRetire={() => setConfirm({ type: "retire", link: detail })}
      onAdd={() => setEditor({ type: "binding", linkId: detail.id })}
      onEditForward={(forward) => setEditor({ type: "binding", linkId: detail.id, forward })}
      onAction={(forward, action) => action === "delete" ? setConfirm({ type: "delete", link: detail, forward })
        : void run(() => linksApi.actionForward(workspaceId, detail.id, forward.id, action))} />}
  </div>;
}
