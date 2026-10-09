"use client";

import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { LinkDetail, LinkForward, LinkForwardAction, LinkPlacement } from "@/lib/links-types";
import type { LinksCopy } from "./links-copy";
import { canEditLinkEndpoints, canRetireLink, linkStatusLabel, placementState, placementAckState } from "./link-state";
import { LinkErrorDetails } from "./link-error-details";
import { ForwardTargets } from "./link-target-details";
import { ForwardClientSource } from "./link-client-source-details";

export function LinkDetailView({ link, copy, now, canManage, busy, nodeLabel, onEdit, onDeploy, onRotate,
  onRetire, onAdd, onEditForward, onAction, canCreateForward = canManage, canUpdateForward = () => canManage, canDeleteForward = () => canManage }: {
  link: LinkDetail; copy: LinksCopy; now: number; canManage: boolean; busy: boolean;
  nodeLabel: (id: number) => string; onEdit: () => void; onDeploy: () => void; onRotate: () => void;
  onRetire: () => void; onAdd: () => void; onEditForward: (forward: LinkForward) => void;
  onAction: (forward: LinkForward, action: LinkForwardAction) => void;
  canCreateForward?: boolean; canUpdateForward?: (forward: LinkForward) => boolean; canDeleteForward?: (forward: LinkForward) => boolean;
}) {
  const mutable = canManage && !["retired", "retiring"].includes(link.status);
  const editEndpoints = canEditLinkEndpoints(link);
  const zeroRefs = canRetireLink(link);
  const expiry = Date.parse(link.deployment?.lease_expires_at ?? "");
  const leaseText = !link.deployment ? copy.noDeployment : !Number.isFinite(expiry) ? copy.leaseUnknown
    : expiry <= now ? copy.expired : link.deployment.lease_expires_at;
  return <div className="space-y-4">
    <Card>
      <CardHeader><CardTitle>{link.name} <Badge variant="outline">FXP</Badge></CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Fact label={copy.state} value={linkStatusLabel(link.status, copy)} />
          <Fact label={copy.deploymentState} value={link.deployment ? linkStatusLabel(link.deployment.status, copy) : copy.noDeployment} />
          <Fact label={copy.desired} value={String(link.desired_version)} />
          <Fact label={copy.appliedVersion} value={link.deployment?.version == null ? copy.unknown : String(link.deployment.version)} />
          <Fact label={copy.refs} value={link.ref_count === null ? copy.unknown : String(link.ref_count)} />
          <Fact label={copy.ingress} value={link.config ? nodeLabel(link.config.ingress_node_id) : copy.unknown} />
          <Fact label={copy.egress} value={link.config ? nodeLabel(link.config.egress_node_id) : copy.unknown} />
          <Fact label={copy.carrierPort} value={link.config ? String(link.config.carrier_port) : copy.unknown} />
          <Fact label={copy.generation} value={String(link.generation)} />
          <Fact label={copy.lease} value={leaseText} />
        </dl>
        {link.deployment?.status === "policy_blocked" && <div role="alert" className="space-y-2 rounded-md border border-[var(--destructive)] p-3 text-sm">
          <p>{copy.policyBlockedHint}</p><LinkErrorDetails codes={["policy_blocked"]} copy={copy} />
        </div>}
        <p className="text-sm text-[var(--muted-foreground)]">{copy.ackHint}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {link.deployment?.placements.map((p) => {
            const state = placementState(link, p, now);
            const label = state === "expired" ? copy.expired : linkStatusLabel(state, copy);
            return <div key={`${p.node_id}-${p.role}`} className="space-y-2 rounded-md border border-[var(--border)] p-3 text-sm">
              <p className="font-medium">{p.role === "ingress" ? copy.ingress : p.role === "egress" ? copy.egress : copy.unknown} · {nodeLabel(p.node_id)}</p>
              <p>{copy.appliedAck}: {placementAckState(link, p) === "passive" ? copy.passiveDesired : linkStatusLabel(placementAckState(link, p), copy)}</p>
              <p>{copy.runtimeState}: <Badge variant={["error", "failed", "mismatch", "expired"].includes(state) ? "destructive" : "outline"}>{state === "passive" ? copy.passiveLive : label}</Badge></p>
              <p>{copy.desired}: {p.generation} · {copy.applied}: {p.applied_generation ?? copy.notApplied}</p>
              <PlacementStatistics link={link} placement={p} copy={copy} now={now} />
              {placementAckState(link, p) === "passive" && <p className="text-[var(--muted-foreground)]">{copy.passiveHint}</p>}
              {p.last_error_code && <LinkErrorDetails codes={[safeCode(p.last_error_code)]} copy={copy} />}
            </div>;
          })}
        </div>
        {mutable && <>
          <p className="text-sm text-[var(--muted-foreground)]">{copy.zeroRefs}</p>
          {link.generation > 0 && <p className="text-sm text-[var(--muted-foreground)]">{copy.endpointRetire}</p>}
          {!zeroRefs && <p className="text-sm text-[var(--muted-foreground)]">{copy.rotateZeroRefs}</p>}
          <LinkErrorDetails codes={[...(link.generation > 0 ? ["link_config_requires_retirement"] : []), ...(!zeroRefs ? ["link_has_references"] : [])]} copy={copy} />
        </>}
        {mutable && <div className="flex flex-wrap gap-2">
          <Button disabled={busy} onClick={onDeploy}>{copy.deploy}</Button>
          <Button variant="outline" disabled={busy || !editEndpoints || !link.config} onClick={onEdit}>{copy.edit}</Button>
          <Button variant="outline" disabled={busy || !link.generation || !zeroRefs} onClick={onRotate}>{copy.rotate}</Button>
          <Button variant="destructive" disabled={busy || !zeroRefs} onClick={onRetire}>{copy.retire}</Button>
        </div>}
      </CardContent>
    </Card>
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
        <CardTitle>{copy.refs} ({link.forwards.length})</CardTitle>
        {mutable && canCreateForward && <Button disabled={busy} onClick={onAdd}>{copy.addForward}</Button>}
      </CardHeader>
      <CardContent className="space-y-3">
        {mutable && <p className="text-sm text-[var(--muted-foreground)]">{copy.updateHint}</p>}
        {!link.forwards.length && <p className="text-sm text-[var(--muted-foreground)]">{copy.noForwards}</p>}
        {link.forwards.map((f) => {
          const confirmed = f.applied_revision === f.config_revision;
          const status = f.apply_status === "active" && !confirmed ? "pending" : f.apply_status;
          return <article key={f.id} className="space-y-3 rounded-md border border-[var(--border)] p-4" aria-label={f.name}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="font-medium break-all">{f.name}</h4><Badge variant="outline">{f.forward_protocol.toUpperCase()}</Badge>
            </div>
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <Fact label={copy.listener} value={`${f.listen_ip ?? copy.unknown}:${f.listen_port}`} />
              <Fact label={copy.target} value={`${f.remote_host}:${f.remote_port}`} />
              <Fact label={copy.desiredState} value={f.desired_status === "active" ? copy.enabled : f.desired_status === "inactive" ? copy.suspended : copy.unknown} />
              <Fact label={copy.state} value={linkStatusLabel(status, copy)} />
              <Fact label={copy.revision} value={`${copy.desired}: ${f.config_revision} · ${copy.applied}: ${f.applied_revision ?? copy.notApplied}`} />
              <Fact label={copy.rateIn} value={String(f.bytes_per_second_in ?? 0)} />
              <Fact label={copy.rateOut} value={String(f.bytes_per_second_out ?? 0)} />
              <Fact label={copy.connections} value={String(f.max_connections ?? 0)} />
              <Fact label={copy.perIp} value={String(f.max_connections_per_ip ?? 0)} />
            </dl>
            <ForwardClientSource forward={f} copy={copy} />
            <ForwardTargets link={link} forward={f} copy={copy} now={now} />
            <ForwardTraffic traffic={f.traffic} copy={copy} now={now} />
            {mutable && <div className="flex flex-wrap gap-2">
              {canUpdateForward(f) && <Button variant="outline" size="sm" disabled={busy} onClick={() => onEditForward(f)}>{copy.editForward}</Button>}
              {canUpdateForward(f) && ["active", "inactive"].includes(f.desired_status) && <Button variant="outline" size="sm" disabled={busy} onClick={() => onAction(f, f.desired_status === "active" ? "suspend" : "resume")}>{f.desired_status === "active" ? copy.suspend : copy.resume}</Button>}
              {canUpdateForward(f) && <Button variant="outline" size="sm" disabled={busy} onClick={() => onAction(f, "retry")}>{copy.retry}</Button>}
              {canDeleteForward(f) && <Button variant="destructive" size="sm" disabled={busy} onClick={() => onAction(f, "delete")}>{copy.delete}</Button>}
            </div>}
          </article>;
        })}
      </CardContent>
    </Card>
  </div>;
}
function PlacementStatistics({ link, placement, copy, now }: {
  link: LinkDetail; placement: LinkPlacement; copy: LinksCopy; now: number;
}) {
  const observation = placement.observation;
  const expiry = Date.parse(link.deployment?.lease_expires_at ?? "");
  // Preserve the backend's identity/freshness fence even when older UI data is
  // still visible after a lease expires or the desired generation changes.
  const current = Number.isFinite(now) && Number.isFinite(expiry) && expiry > now &&
    !["retired", "retiring"].includes(link.status) && link.deployment?.generation === link.generation &&
    placement.generation === link.generation && observation != null &&
    (observation.observed_generation === link.generation || (observation.observed_generation === 0 && observation.ready === false)) &&
    (["ready", "rolled_back", "updating", "failed", "passive", "cached", "closed", "exited", "removed"].includes(observation.state) ||
      (observation.state === "mismatch" && observation.observed_generation === 0 && observation.ready === false));
  const status = current ? observation?.traffic_status : null;
  const labels = { idle: copy.statisticsIdle, collecting: copy.statisticsCollecting,
    backlogged: copy.statisticsBacklogged, blocked: copy.statisticsBlocked };
  return <section aria-label={copy.statisticsState} className="space-y-2 border-t border-[var(--border)] pt-2">
    <dl className="grid gap-3 sm:grid-cols-2">
      <Fact label={copy.statisticsState} value={status ? labels[status.state] : copy.statisticsUnknown} />
      <Fact label={copy.statisticsLastAck} value={status ? status.last_ack_at ?? copy.statisticsNoAck : copy.unknown} />
    </dl>
    <p className="text-[var(--muted-foreground)]">{copy.statisticsAckHint}</p>
    {status?.state === "backlogged" && <p role="status">{copy.statisticsBacklogHint}</p>}
    {status?.state === "blocked" && <p role="status" className="text-[var(--destructive)]">{copy.statisticsBlockedHint}</p>}
    <details className="text-[var(--muted-foreground)]">
      <summary className="cursor-pointer">{copy.statisticsDetails}</summary>
      <dl className="mt-2 grid gap-3 sm:grid-cols-2">
        <Fact label={copy.statisticsRotation} value={status ? status.rotation_supported ? copy.statisticsSupported : copy.statisticsUnsupported : copy.unknown} />
        <Fact label={copy.statisticsProducers} value={status ? String(status.producer_count) : copy.unknown} />
        <Fact label={copy.statisticsSamples} value={status ? String(status.sample_count) : copy.unknown} />
        <Fact label={copy.statisticsRules} value={status ? String(status.rule_count) : copy.unknown} />
        <Fact label={copy.statisticsSpool} value={status ? String(status.spool_bytes) : copy.unknown} />
      </dl>
    </details>
  </section>;
}
function ForwardTraffic({ traffic, copy, now }: { traffic: LinkForward["traffic"]; copy: LinksCopy; now: number }) {
  const received = Date.parse(traffic?.last_received_at ?? "");
  const note = Number.isFinite(now) && Number.isFinite(received)
    ? received > now ? copy.trafficFuture : now - received >= 60_000 ? copy.trafficStale : null : null;
  return <section aria-label={copy.trafficTotals} className="space-y-2 border-t border-[var(--border)] pt-3 text-sm">
    <h5 className="font-medium">{copy.trafficTotals}</h5>
    <p className="text-[var(--muted-foreground)]">{copy.trafficHint}</p>
    <dl className="grid gap-3 sm:grid-cols-2">
      {/* Decimal display preserves exact aggregated bytes without a lossy Number conversion. */}
      <Fact label={copy.trafficIn} value={traffic ? `${traffic.bytes_in} B` : copy.trafficNotReceived} />
      <Fact label={copy.trafficOut} value={traffic ? `${traffic.bytes_out} B` : copy.trafficNotReceived} />
      <Fact label={copy.trafficConnections} value={traffic ? traffic.connections : copy.trafficNotReceived} />
      <Fact label={copy.trafficLastReceived} value={traffic ? traffic.last_received_at : copy.trafficNotReceived} />
    </dl>
    {note && <p className="text-[var(--muted-foreground)]">{note}</p>}
  </section>;
}
function Fact({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><dt className="text-[var(--muted-foreground)]">{label}</dt><dd className="mt-1 break-all">{value}</dd></div>;
}
function safeCode(value: string): string { return /^[a-z][a-z0-9_]{0,95}$/.test(value) ? value : "link_apply_unconfirmed"; }
