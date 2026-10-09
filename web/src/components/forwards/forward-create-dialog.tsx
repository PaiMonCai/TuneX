"use client";

import { Button } from "@/components/ui/button";
import { ForwardPolicyFields } from "./forward-policy-fields";
import { forwardPolicyDraftErrors } from "@/lib/forward-policy";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { listenPortHintKey, listenPortPlaceholderKey } from "@/components/forwards/forward-copy";
import { changeForwardCreateEgress, changeForwardCreateIngress, changeForwardCreateProtocol, forwardCreateProtocolErrors, type ForwardCreateDraft } from "@/components/forwards/forward-create-model";
import { buildForwardMultihopModel, buildMultihopFacts } from "@/components/forwards/forward-multihop-model";
import { ForwardMultihopSection } from "@/components/forwards/forward-multihop-select";
import { buildForwardPathPreview, forwardPathScopeKey, resolveEgressNode } from "@/components/forwards/forward-path-model";
import { ForwardPathPreview, forwardPathCopy } from "@/components/forwards/forward-path-preview";
import { FORWARD_PROTOCOLS, FORWARD_TLS_PATH_MAX, forwardProtocolLabel, forwardProtocolNote, type ForwardProtocol } from "@/lib/forward-protocol";
import type { Locale } from "@/lib/i18n";
import type { NodeBinding, UserNode } from "@/lib/types";
import { nativeBothBlock, nativeBothBlockText, type ForwardCapabilities } from "@/lib/forward-native-both";

import type { ForwardListTextKey } from "@/components/forwards/forward-list-model";
type Translate = (key: string, params?: Record<string, string | number>) => string;
type ListText = (key: ForwardListTextKey, params?: Record<string, string | number>) => string;

export function ForwardCreateDialog({ open, draft, ingressNodes, selectedBindings, egressNodes, canManageNodes,
  busy, locale, t, text, onOpenChange, onDraftChange, onCreate,
  bindingsUnavailable = false, workspaceId = null, bindingsByIngress = null, capabilities = null }: {
  open: boolean; draft: ForwardCreateDraft; ingressNodes: UserNode[]; selectedBindings: NodeBinding[];
  egressNodes: UserNode[]; canManageNodes: boolean; busy: boolean; locale: Locale;
  t: Translate; text: ListText; onOpenChange: (open: boolean) => void; onDraftChange: (draft: ForwardCreateDraft) => void;
  onCreate: () => void;
  /**
   * 绑定事实此刻**不可信**（仍在读取 / 读取失败 / 晚到）：调用方已知这件事时传 `true`。
   *
   * 为什么需要它：对话框只拿到 `selectedBindings: NodeBinding[]`，空数组在"确实没有绑定"
   * 与"取不到"两种情况下一模一样。默认 `false` = 沿用今天的语义（把空列表当权威），
   * 因此**在调用方接线之前**这一态不会被误报；一旦接线（`forward-workspace` 的
   * `bindingsFailed` 已经算出来了，只是此前仅用于 toast），"取不到"就会如实显示，
   * 而不是被说成"没有可用出口"。
   */
  bindingsUnavailable?: boolean;
  /** 预览作用域键用（建议传当前 workspace id）；缺省 `null` 时键仍是稳定的。 */
  workspaceId?: number | null;
  /**
   * **全部**来源节点的绑定事实（key = 源节点 id），中间跳判定要用第二段。
   *
   * 为什么不能只给 `selectedBindings`：那是"当前入口的绑定"，而三跳的第二段是
   * 「中间 → 出口」，它挂在**中间跳**这个来源上。`bindingsUnavailable` 为 true 时
   * 这份事实不可信（读取失败/仍在读/旧作用域），模型会如实判成"取不到"。
   */
  bindingsByIngress?: Record<string, NodeBinding[]> | null;
  capabilities?: ForwardCapabilities | null;
}) {
  const protocolErrors = forwardCreateProtocolErrors(draft);
  const protocolReady = Object.keys(protocolErrors).length === 0 && Object.keys(forwardPolicyDraftErrors(draft)).length === 0;
  const patch = (value: Partial<ForwardCreateDraft>) => onDraftChange({ ...draft, ...value });
  const copy = forwardPathCopy(locale);
  const ingress = ingressNodes.find((node) => String(node.id) === draft.ingressId) ?? null;
  // 出口名优先从**绑定事实**里取：节点列表只装入入口能力的节点，出口可能不在里面。
  const egress = resolveEgressNode({
    egressId: draft.egressId,
    bindings: bindingsUnavailable ? null : selectedBindings,
    nodes: [...ingressNodes, ...egressNodes],
  });
  // Runtime facts come from diagnostics-enriched nodes, not a stale binding projection.
  const bothBlock = nativeBothBlock({ capabilities, mode: draft.mode, ingress,
    egress: egressNodes.find((node) => String(node.id) === draft.egressId), middleNodeId: draft.middleNodeId });
  const bothBlocked = draft.protocol === "both" && bothBlock !== null;
  const boundEgressIds = new Set(selectedBindings.map((binding) => String(binding.egress_node_id)));
  const egressRelationLabel = (nodeId: string) => {
    if (bindingsUnavailable) return t("forward.pathRelationServerCheck");
    if (boundEgressIds.has(nodeId)) return t("forward.pathRelationReady");
    return canManageNodes
      ? t("forward.pathRelationWillPrepare")
      : t("forward.pathRelationNeedsPermission");
  };
  const scopeKey = forwardPathScopeKey({ workspaceId, ingressId: draft.ingressId });
  /**
   * 中间跳（三跳）模型：作用域键只跟 workspace 走（这份事实是"按来源节点分组"的，
   * 与选了哪台入口无关）；`bindingsUnavailable` 时事实整份判成取不到。
   */
  const multihopFacts = buildMultihopFacts({ workspaceId, nodes: ingressNodes, bindingsByIngress, bindingsUnavailable });
  const multihopModel = buildForwardMultihopModel({
    mode: draft.mode,
    ingressId: draft.ingressId,
    egressId: draft.egressId,
    middleNodeId: draft.middleNodeId ?? "",
    canManageNodes,
    scopeKey: multihopFacts.scopeKey,
    facts: multihopFacts,
    // 候选全集用入口能力节点（`role=both` 一定在里面）+ 第一段绑定里出现过的节点。
    nodes: ingressNodes,
  });
  const middleChosen = (draft.middleNodeId ?? "").trim() !== "" && multihopModel.applicable;
  /** 选了中间跳但此刻不能提交（缺段/取不到/同节点）⇒ 提交必须被拦，而不是撞 409。 */
  const multihopBlocked = middleChosen && multihopModel.submitBlockedReason !== null;
  const pathPreview = buildForwardPathPreview({
    draft,
    ingress,
    egress,
    scopeKey,
    // 取不到 ⇒ 传 `null` 事实（模型据此判 `unavailable`，绝不判成"没有绑定"）。
    bindingsFacts: { scopeKey, bindings: bindingsUnavailable ? null : selectedBindings },
    bindableEgressCount: egressNodes.length,
    autoSetupAllowed: canManageNodes,
    // 三跳事实来自上面那一份模型（判定只有一处实现），预览只负责画。
    middle: middleChosen
      ? {
          nodeId: (draft.middleNodeId ?? "").trim(),
          node: multihopModel.selected?.node ?? null,
          inboundBound: multihopModel.selected?.inboundBound ?? null,
          outboundBound: multihopModel.selected?.outboundBound ?? null,
        }
      : null,
  });
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{draft.mode === "relay" ? t("forward.createRelay") : t("forward.createDirect")}</DialogTitle>
        <DialogDescription>{draft.mode === "relay" ? t("forward.relayDesc") : t("forward.directDesc")}</DialogDescription>
      </DialogHeader>
      {ingressNodes.length === 0 ? <div className="rounded-md border border-[var(--border)] p-4 text-sm text-[var(--muted-foreground)]">{t("forward.noIngress")}</div> :
      <div className="flex flex-col gap-4">
        <section data-testid="forward-create-basic" className="flex flex-col gap-3 rounded-md border border-[var(--border)] p-3">
          <div>
            <div className="text-sm font-medium">{t("forward.createBasicInfo")}</div>
            <div className="mt-0.5 text-xs text-[var(--muted-foreground)]">
              {t("forward.createPathMode")}: {draft.mode === "relay" ? t("forward.relay") : t("forward.direct")}
            </div>
          </div>
          <Field label={t("common.name")}><Input value={draft.name} onChange={(e) => patch({ name: e.target.value })} placeholder="web-hk" /></Field>
          <Field label={t("forward.protocol")} hint={forwardProtocolNote(locale, draft.protocol)}>
            <Select value={draft.protocol} onValueChange={(value) => onDraftChange(changeForwardCreateProtocol(draft, value as ForwardProtocol))}>
              <SelectTrigger data-testid="forward-protocol-select"><SelectValue /></SelectTrigger>
              <SelectContent>{FORWARD_PROTOCOLS.map((value) => <SelectItem key={value} value={value} disabled={value === "both" && bothBlock !== null} data-testid={`forward-protocol-${value}`}>{forwardProtocolLabel(value)}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          {bothBlock ? <p data-testid="forward-native-both-gate" role={bothBlocked ? "alert" : undefined} className="text-xs text-[var(--muted-foreground)]">{nativeBothBlockText(locale, bothBlock)}</p> : null}
          {draft.protocol === "tls" ? <>
            <Field label={t("forward.tlsCertPath")} hint={t("forward.tlsPathsHint")} error={protocolErrors.tls_cert_path ? t(protocolErrors.tls_cert_path) : undefined}>
              <Input value={draft.tlsCertPath} maxLength={FORWARD_TLS_PATH_MAX} placeholder="/etc/tunex/tls/front.crt" data-testid="forward-tls-cert-path" required aria-invalid={protocolErrors.tls_cert_path ? true : undefined} onChange={(e) => patch({ tlsCertPath: e.target.value })} />
            </Field>
            <Field label={t("forward.tlsKeyPath")} error={protocolErrors.tls_key_path ? t(protocolErrors.tls_key_path) : undefined}>
              <Input value={draft.tlsKeyPath} maxLength={FORWARD_TLS_PATH_MAX} placeholder="/etc/tunex/tls/front.key" data-testid="forward-tls-key-path" required aria-invalid={protocolErrors.tls_key_path ? true : undefined} onChange={(e) => patch({ tlsKeyPath: e.target.value })} />
            </Field>
          </> : null}
          <Field label={t("forward.listenPort")} hint={text(listenPortHintKey(draft.listenPort))}><Input inputMode="numeric" value={draft.listenPort} onChange={(e) => patch({ listenPort: e.target.value })} placeholder={text(listenPortPlaceholderKey(draft.listenPort))} data-testid="forward-listen-port" /></Field>
        </section>

        <section data-testid="forward-create-path" className="flex flex-col gap-3 rounded-md border border-[var(--border)] p-3">
          <div>
            <div className="text-sm font-medium">{t("forward.createNetworkPath")}</div>
            <div className="mt-0.5 text-xs text-[var(--muted-foreground)]">
              {draft.mode === "relay" ? t("forward.relayDesc") : t("forward.directDesc")}
            </div>
          </div>

          <Field label={t("forward.ingressNode")}>
            <Select value={draft.ingressId} onValueChange={(value) => onDraftChange(changeForwardCreateIngress(draft, value))}>
              <SelectTrigger><SelectValue placeholder={t("forward.chooseIngress")} /></SelectTrigger>
              <SelectContent>{ingressNodes.map((node) => <SelectItem key={String(node.id)} value={String(node.id)}>{node.node_id} · {node.connect_ip ?? t("node.waiting")}</SelectItem>)}</SelectContent>
            </Select>
          </Field>

          {draft.mode === "relay" ? <Field label={t("forward.egressNode")}><div className="flex flex-col gap-2">
            <Select value={draft.egressId} onValueChange={(egressId) => onDraftChange(changeForwardCreateEgress(draft, egressId))}>
              <SelectTrigger><SelectValue placeholder={t("forward.chooseEgress")} /></SelectTrigger>
              <SelectContent>{egressNodes.map((node) => (
                <SelectItem key={String(node.id)} value={String(node.id)}>
                  {node.node_id} · {node.connect_ip ?? t("node.waiting")} · {egressRelationLabel(String(node.id))}
                </SelectItem>
              ))}</SelectContent>
            </Select>
            {egressNodes.length === 0 ? (
              <p className="text-xs text-[var(--muted-foreground)]">{t("forward.noAvailableEgress")}</p>
            ) : (
              <p className="text-xs text-[var(--muted-foreground)]" data-testid="forward-path-auto-setup-hint">
                {t("forward.pathAutoSetupHint")}
              </p>
            )}
          </div></Field> : null}

          {draft.protocol !== "both" ? <ForwardMultihopSection
            model={multihopModel}
            locale={locale}
            value={draft.middleNodeId ?? ""}
            onChange={(next) => patch({ middleNodeId: next })}
          /> : null}

          <ForwardPathPreview model={pathPreview} locale={locale} protocol={draft.protocol} />
          <p className="text-xs text-[var(--muted-foreground)]" data-testid="forward-routing-policy-note">
            {t("forward.createRoutingPolicyNote")}
          </p>
        </section>

        <section data-testid="forward-create-target" className="flex flex-col gap-3 rounded-md border border-[var(--border)] p-3">
          <div className="text-sm font-medium">{t("forward.createTargetSection")}</div>
          <Field label={t("forward.targetHost")}><Input value={draft.targetHost} onChange={(e) => patch({ targetHost: e.target.value })} placeholder="example.com" /></Field>
          <Field label={t("forward.targetPort")}><Input inputMode="numeric" value={draft.targetPort} onChange={(e) => patch({ targetPort: e.target.value })} placeholder="443" /></Field>
          <ForwardPolicyFields draft={draft} onChange={patch} locale={locale} />
        </section>
      </div>}
      <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
        <Button onClick={onCreate} disabled={busy || ingressNodes.length === 0 || !protocolReady || bothBlocked || multihopBlocked || (draft.mode === "relay" && !draft.egressId)}>{draft.mode === "relay" ? t("forward.createRelay") : t("forward.createDirect")}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: React.ReactNode }) {
  return <div className="flex flex-col gap-1.5"><Label>{label}</Label>{children}{error ? <p className="text-xs text-[var(--destructive)]">{error}</p> : null}{hint ? <p className="text-xs text-[var(--muted-foreground)]">{hint}</p> : null}</div>;
}
