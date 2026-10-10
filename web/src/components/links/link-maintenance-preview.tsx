"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { linkErrorInfo, type LinkErrorInfo } from "@/lib/links-api";
import { isLinkMaintenancePreviewCurrent, type LinkMaintenanceOperation, type LinkMaintenancePort,
  type LinkMaintenancePreview, type LinkMaintenancePreviewInput } from "@/lib/link-maintenance-types";
import type { LinkDetail } from "@/lib/links-types";
import type { UserNode } from "@/lib/types";
import type { LinksCopy } from "./links-copy";
import { LinkConfigForm, selectClass } from "./link-forms";
import { LinkErrorDetails } from "./link-error-details";
import { linkStatusLabel } from "./link-state";
import type { LinkMaintenanceCommitInput } from "@/lib/link-maintenance-migrations";

/** Preview reads stay independent; optional intent submission uses the parent's fenced write lifecycle. */
export function LinkMaintenancePanel({ link, copy, nodes, nodesError, busy, now, nodeLabel, onClose, onPreview, onCommit, invalidationEpoch = 0 }: {
  link: LinkDetail; copy: LinksCopy; nodes: UserNode[]; nodesError: boolean; busy: boolean; now: number;
  nodeLabel: (id: number) => string; onClose: () => void;
  onPreview: (input: LinkMaintenancePreviewInput) => Promise<LinkMaintenancePreview | null>;
  onCommit?: (input: LinkMaintenanceCommitInput) => Promise<boolean>;
  invalidationEpoch?: number;
}) {
  const id = useId();
  const sequence = useRef(0), mounted = useRef(false), pendingRef = useRef(false);
  const [operation, setOperation] = useState<LinkMaintenanceOperation>("update_endpoints");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<LinkMaintenancePreview | null>(null);
  const resultEpoch = useRef(invalidationEpoch);
  const [error, setError] = useState<LinkErrorInfo | null>(null);
  const [stale, setStale] = useState(false);
  const request = useRef<LinkMaintenancePreviewInput | null>(null);
  const commitKey = useRef<{ receipt: string; key: string } | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; sequence.current++; }; }, []);
  const invalidate = () => {
    sequence.current++; pendingRef.current = false; setPending(false); setResult(null); setError(null); setStale(false);
  };
  // Reads fence requests/results, not the user's uncontrolled endpoint draft or selected operation.
  useEffect(() => {
    sequence.current++; pendingRef.current = false; setPending(false); setResult(null); setError(null); setStale(false);
  }, [invalidationEpoch]);
  const current = result !== null && resultEpoch.current === invalidationEpoch && isLinkMaintenancePreviewCurrent(result, link, now);
  useEffect(() => {
    if (result && resultEpoch.current === invalidationEpoch && !current) { setResult(null); setStale(true); }
  }, [result, current, invalidationEpoch]);
  const submit = async (change: LinkMaintenancePreviewInput["change"]) => {
    if (busy || pendingRef.current || error?.disabled || !link.config || ["retired", "retiring"].includes(link.status)) return;
    const ticket = ++sequence.current;
    pendingRef.current = true; setPending(true); setResult(null); setError(null); setStale(false);
    try {
      const input = { expected_version: link.desired_version, expected_generation: link.generation, change };
      const preview = await onPreview(input);
      if (!mounted.current || sequence.current !== ticket) return;
      if (preview && isLinkMaintenancePreviewCurrent(preview, link, Date.now())) { resultEpoch.current = invalidationEpoch; request.current = input; setResult(preview); }
      else setStale(true);
    } catch (failure) {
      if (mounted.current && sequence.current === ticket) setError(linkErrorInfo(failure));
    } finally {
      if (mounted.current && sequence.current === ticket) { pendingRef.current = false; setPending(false); }
    }
  };
  const blocked = busy || !!error?.disabled;
  return <Card>
    <CardHeader><CardTitle>{copy.maintenancePreview}</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      <p className="text-sm">{copy.previewHint}</p>
      <div className="grid gap-2"><label htmlFor={id} className="text-sm font-medium">{copy.previewOperation}</label>
        <select id={id} className={`${selectClass} max-w-xl`} value={operation} disabled={busy} onChange={(e) => {
          invalidate(); setOperation(e.target.value as LinkMaintenanceOperation);
        }}><option value="update_endpoints">{copy.previewEndpoints}</option><option value="rotate_key">{copy.previewKey}</option></select>
      </div>
      {operation === "update_endpoints" && link.config ? <LinkConfigForm copy={copy} nodes={nodes} nodesError={nodesError}
        initial={link.config} busy={blocked || pending} submitLabel={copy.previewRun} ariaLabel={copy.previewEndpoints}
        onInputChange={invalidate} onCancel={onClose} onSubmit={(input) => submit({ type: "update_endpoints", config: input.config })} />
        : <form aria-label={copy.previewKey} onSubmit={(e) => { e.preventDefault(); void submit({ type: "rotate_key" }); }}>
          <Button type="submit" disabled={blocked || pending}>{pending ? copy.working : copy.previewRun}</Button>
        </form>}
      {pending && <p role="status">{copy.working}</p>}
      {error && <div role="alert" className="space-y-2 text-sm">
        <p>{error.code === "link_maintenance_preview_too_large" ? copy.previewTooLarge
          : error.disabled ? copy.previewDisabled : error.denied ? copy.actionDenied : error.conflict ? copy.previewConflict : copy.previewFailed}</p>
        <LinkErrorDetails codes={[error.code]} copy={copy} />
      </div>}
      {(stale || (result && resultEpoch.current === invalidationEpoch && !current)) && <p role="status" className="text-sm">{copy.previewStale}</p>}
      {result && current && <LinkMaintenanceResult preview={result} copy={copy} nodeLabel={nodeLabel} />}
      {result && current && result.submission?.supported && result.snapshot.receipt && onCommit && request.current
        && result.runtime.state === "ready" && !result.execution.blockers.includes("link_no_change") && <div className="space-y-2">
          <p>{copy.maintenancePlanNoExecution}</p><Button type="button" disabled={blocked || pending} onClick={() => {
            if (!request.current || !result.snapshot.receipt || !isLinkMaintenancePreviewCurrent(result, link, Date.now())) return;
            if (commitKey.current?.receipt !== result.snapshot.receipt) commitKey.current = { receipt: result.snapshot.receipt, key: crypto.randomUUID() };
            void onCommit({ ...request.current, receipt: result.snapshot.receipt, idempotency_key: commitKey.current.key });
          }}>{copy.maintenancePlanSave}</Button>
        </div>}
      <Button type="button" variant="outline" onClick={onClose}>{copy.previewClose}</Button>
    </CardContent>
  </Card>;
}

export function LinkMaintenanceResult({ preview, copy, nodeLabel }: {
  preview: LinkMaintenancePreview; copy: LinksCopy; nodeLabel: (id: number) => string;
}) {
  const blockerLabels = { maintenance_executor_unavailable: copy.previewNoExecutor, link_no_change: copy.previewNoChange,
    link_not_deployed: copy.previewNotDeployed, link_runtime_unconfirmed: copy.previewRuntimeUnconfirmed };
  const stageLabels = { reserve_candidate: copy.previewReserve, prepare_egress: copy.previewPrepareEgress, verify_egress: copy.previewVerifyEgress,
    cutover_ingress: copy.previewCutover, verify_ingress: copy.previewVerifyIngress, drain_old: copy.previewDrain,
    retire_old: copy.previewRetire, release_old_ports: copy.previewRelease };
  const tcpLabels = { none: copy.previewTcpNone, reconnect_required: copy.previewTcpReconnect, drain_required: copy.previewTcpDrain };
  const udpLabels = { none: copy.previewUdpNone, mapping_rebuild_required: copy.previewUdpRebuild };
  const runtimeLabels = { ready: copy.previewRuntimeReady, not_ready: copy.previewRuntimeNotReady, unknown: copy.previewRuntimeUnknown, not_deployed: copy.noDeployment };
  const { config } = preview.candidate;
  return <section aria-label={copy.previewResult} className="space-y-4 rounded-md border border-[var(--border)] p-4 text-sm">
    <h3 className="font-medium">{copy.previewResult}</h3>
    <p>{copy.previewExpiry}: <time dateTime={preview.expires_at}>{preview.expires_at}</time></p>
    <div className="space-y-2"><h4 className="font-medium">{copy.previewCandidate}</h4>
      <p>{copy.ingress}: {nodeLabel(config.ingress_node_id)} · {copy.egress}: {nodeLabel(config.egress_node_id)} · {copy.carrierPort}: {config.carrier_port}</p>
      <p>{copy.desired}: {preview.snapshot.desired_version} → {preview.candidate.version} · {copy.generation}: {preview.snapshot.generation} → {preview.candidate.generation}</p>
      <p>{copy.previewChanges}: {[...(preview.changes.ingress_changed ? [copy.ingress] : []), ...(preview.changes.egress_changed ? [copy.egress] : []),
        ...(preview.changes.carrier_port_changed ? [copy.carrierPort] : []), preview.candidate.key_action === "rotate" ? copy.previewKeyRotated : copy.previewKeyPreserved].join(" · ")}</p>
    </div>
    <p>{copy.refs}: {preview.references.total} · {copy.previewActive}: {preview.references.active} · {copy.previewSuspended}: {preview.references.suspended}</p>
    <p>{copy.previewPendingHint}</p>
    <ul className="space-y-2">{preview.references.forwards.map((f) => <li key={f.id} className="break-words">
      {f.name} · {f.protocol.toUpperCase()} · {f.desired_status === "active" ? copy.previewActive : copy.previewSuspended} · {copy.revision}: {f.config_revision}
      <br />{copy.listener}: {nodeLabel(f.listener.node_id)} / {f.listener.bind_scope}:{f.listener.port} → {nodeLabel(f.candidate_listener.node_id)} / {f.candidate_listener.bind_scope}:{f.candidate_listener.port}
    </li>)}</ul>
    <p>{runtimeLabels[preview.runtime.state]}</p>
    <ul>{preview.runtime.placements.map((p) => <li key={p.role}>{p.role === "ingress" ? copy.ingress : copy.egress}: {nodeLabel(p.node_id)} · {linkStatusLabel(p.state, copy)}</li>)}</ul>
    <p>{copy.previewLiveUnknown}</p>
    <div className="space-y-2"><h4 className="font-medium">{copy.previewImpact}</h4><p>{tcpLabels[preview.impact.tcp]}</p><p>{udpLabels[preview.impact.udp]}</p></div>
    <p>{copy.previewPortHint}</p>
    <PortList title={copy.previewHeldPorts} ports={preview.ports.held} copy={copy} nodeLabel={nodeLabel} />
    <PortList title={copy.previewCandidatePorts} ports={preview.ports.candidate} copy={copy} nodeLabel={nodeLabel} />
    <ul className="space-y-1">{preview.execution.blockers.map((code) => <li key={code}>{blockerLabels[code]}</li>)}</ul>
    <LinkErrorDetails codes={preview.execution.blockers} copy={copy} />
    <details><summary className="cursor-pointer">{copy.previewStages}</summary><ol className="mt-2 list-decimal space-y-1 pl-5">
      {preview.execution.stages.map((stage) => <li key={stage}>{stageLabels[stage]}</li>)}
    </ol></details>
  </section>;
}
function PortList({ title, ports, copy, nodeLabel }: { title: string; ports: LinkMaintenancePort[]; copy: LinksCopy; nodeLabel: (id: number) => string }) {
  return <details><summary className="cursor-pointer">{title} ({ports.length})</summary><ul className="mt-2 space-y-1">
    {ports.map((p, index) => <li key={index} className="break-words">{p.role === "ingress" ? copy.ingress : copy.egress} · {nodeLabel(p.node_id)} · {p.protocol === "unknown" ? copy.unknown : p.protocol.toUpperCase()} · {p.bind_scope}:{p.port}</li>)}
  </ul></details>;
}
