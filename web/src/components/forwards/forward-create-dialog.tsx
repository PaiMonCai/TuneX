"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { bindingUsageView, hasBindingUsage } from "@/components/forwards/forward-binding-usage";
import { listenPortHintKey, listenPortPlaceholderKey } from "@/components/forwards/forward-copy";
import { changeForwardCreateIngress, changeForwardCreateProtocol, forwardCreateProtocolErrors, type ForwardCreateDraft } from "@/components/forwards/forward-create-model";
import { FORWARD_PROTOCOLS, FORWARD_TLS_PATH_MAX, forwardProtocolLabel, forwardProtocolNote, type ForwardProtocol } from "@/lib/forward-protocol";
import type { Locale } from "@/lib/i18n";
import type { NodeBinding, UserNode } from "@/lib/types";

type Translate = (key: string, params?: Record<string, string | number>) => string;

export function ForwardCreateDialog({ open, draft, ingressNodes, selectedBindings, availableEgressNodes, canManageNodes,
  bindingBusy, busy, locale, t, text, onOpenChange, onDraftChange, onBindEgress, onCreate }: {
  open: boolean; draft: ForwardCreateDraft; ingressNodes: UserNode[]; selectedBindings: NodeBinding[];
  availableEgressNodes: UserNode[]; canManageNodes: boolean; bindingBusy: boolean; busy: boolean; locale: Locale;
  t: Translate; text: Translate; onOpenChange: (open: boolean) => void; onDraftChange: (draft: ForwardCreateDraft) => void;
  onBindEgress: () => void; onCreate: () => void;
}) {
  const protocolErrors = forwardCreateProtocolErrors(draft);
  const protocolReady = Object.keys(protocolErrors).length === 0;
  const patch = (value: Partial<ForwardCreateDraft>) => onDraftChange({ ...draft, ...value });

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{draft.mode === "relay" ? t("forward.createRelay") : t("forward.createDirect")}</DialogTitle>
        <DialogDescription>{draft.mode === "relay" ? t("forward.relayDesc") : t("forward.directDesc")}</DialogDescription>
      </DialogHeader>
      {ingressNodes.length === 0 ? <div className="rounded-md border border-[var(--border)] p-4 text-sm text-[var(--muted-foreground)]">{t("forward.noIngress")}</div> :
      <div className="flex flex-col gap-4">
        <Field label={t("common.name")}><Input value={draft.name} onChange={(e) => patch({ name: e.target.value })} placeholder="web-hk" /></Field>
        <Field label={t("forward.protocol")} hint={forwardProtocolNote(locale, draft.protocol)}>
          <Select value={draft.protocol} onValueChange={(value) => onDraftChange(changeForwardCreateProtocol(draft, value as ForwardProtocol))}>
            <SelectTrigger data-testid="forward-protocol-select"><SelectValue /></SelectTrigger>
            <SelectContent>{FORWARD_PROTOCOLS.map((value) => <SelectItem key={value} value={value} data-testid={`forward-protocol-${value}`}>{forwardProtocolLabel(value)}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        {draft.protocol === "tls" ? <>
          <Field label={t("forward.tlsCertPath")} hint={t("forward.tlsPathsHint")} error={protocolErrors.tls_cert_path ? t(protocolErrors.tls_cert_path) : undefined}>
            <Input value={draft.tlsCertPath} maxLength={FORWARD_TLS_PATH_MAX} placeholder="/etc/tunex/tls/front.crt" data-testid="forward-tls-cert-path" required aria-invalid={protocolErrors.tls_cert_path ? true : undefined} onChange={(e) => patch({ tlsCertPath: e.target.value })} />
          </Field>
          <Field label={t("forward.tlsKeyPath")} error={protocolErrors.tls_key_path ? t(protocolErrors.tls_key_path) : undefined}>
            <Input value={draft.tlsKeyPath} maxLength={FORWARD_TLS_PATH_MAX} placeholder="/etc/tunex/tls/front.key" data-testid="forward-tls-key-path" required aria-invalid={protocolErrors.tls_key_path ? true : undefined} onChange={(e) => patch({ tlsKeyPath: e.target.value })} />
          </Field>
        </> : null}
        <Field label={t("forward.ingressNode")}>
          <Select value={draft.ingressId} onValueChange={(value) => onDraftChange(changeForwardCreateIngress(draft, value))}>
            <SelectTrigger><SelectValue placeholder={t("forward.chooseIngress")} /></SelectTrigger>
            <SelectContent>{ingressNodes.map((node) => <SelectItem key={String(node.id)} value={String(node.id)}>{node.node_id} · {node.connect_ip ?? t("node.waiting")}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        {draft.mode === "relay" ? <Field label={t("forward.egressNode")}><div className="flex flex-col gap-3">
          {selectedBindings.length > 0 ? <Select value={draft.egressId} onValueChange={(egressId) => patch({ egressId })}>
            <SelectTrigger><SelectValue placeholder={t("forward.chooseEgress")} /></SelectTrigger>
            <SelectContent>{selectedBindings.map((binding) => <SelectItem key={String(binding.egress_node_id)} value={String(binding.egress_node_id)}>
              {binding.egress_node.node_id} · {binding.egress_node.connect_ip ?? t("node.waiting")}
              {hasBindingUsage(binding) ? ` · ${text("forward.bindingUsageUsed", { count: bindingUsageView(binding).used_by_forward_count })}` : ""}
            </SelectItem>)}</SelectContent>
          </Select> : <div className="rounded-md border border-dashed border-[var(--border)] p-3 text-sm text-[var(--muted-foreground)]"><div>{t("forward.noBoundEgress")}</div><div className="mt-1 text-xs">{t("forward.bindFirstHint")}</div></div>}
          {canManageNodes && availableEgressNodes.length > 0 ? <div className="rounded-md border border-[var(--border)] p-3">
            <div className="mb-2 text-xs font-medium text-[var(--muted-foreground)]">{selectedBindings.length > 0 ? t("forward.bindAnotherEgress") : t("forward.bindInline")}</div>
            <div className="flex flex-col gap-2 sm:flex-row"><Select value={draft.bindEgressId} onValueChange={(bindEgressId) => patch({ bindEgressId })}>
              <SelectTrigger className="min-w-0 flex-1"><SelectValue placeholder={t("forward.chooseUnboundEgress")} /></SelectTrigger>
              <SelectContent>{availableEgressNodes.map((node) => <SelectItem key={String(node.id)} value={String(node.id)}>{node.node_id} · {node.connect_ip ?? t("node.waiting")}</SelectItem>)}</SelectContent>
            </Select><Button type="button" variant="outline" onClick={onBindEgress} disabled={bindingBusy || !draft.bindEgressId}>{t("forward.bindAndUse")}</Button></div>
          </div> : selectedBindings.length === 0 ? <div className="text-xs text-[var(--muted-foreground)]">{t("forward.noAvailableEgress")}{" "}<Link href="/nodes" className="underline underline-offset-2">{t("common.nodes")}</Link></div> : null}
        </div></Field> : null}
        <Field label={t("forward.listenPort")} hint={text(listenPortHintKey(draft.listenPort))}><Input inputMode="numeric" value={draft.listenPort} onChange={(e) => patch({ listenPort: e.target.value })} placeholder={text(listenPortPlaceholderKey(draft.listenPort))} data-testid="forward-listen-port" /></Field>
        <Field label={t("forward.targetHost")}><Input value={draft.targetHost} onChange={(e) => patch({ targetHost: e.target.value })} placeholder="example.com" /></Field>
        <Field label={t("forward.targetPort")}><Input inputMode="numeric" value={draft.targetPort} onChange={(e) => patch({ targetPort: e.target.value })} placeholder="443" /></Field>
      </div>}
      <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
        <Button onClick={onCreate} disabled={busy || ingressNodes.length === 0 || !protocolReady || (draft.mode === "relay" && (!draft.egressId || selectedBindings.length === 0))}>{draft.mode === "relay" ? t("forward.createRelay") : t("forward.createDirect")}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: React.ReactNode }) {
  return <div className="flex flex-col gap-1.5"><Label>{label}</Label>{children}{error ? <p className="text-xs text-[var(--destructive)]">{error}</p> : null}{hint ? <p className="text-xs text-[var(--muted-foreground)]">{hint}</p> : null}</div>;
}
