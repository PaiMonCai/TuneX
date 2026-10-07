import type { LinkDetail, LinkForward, LinkTargetHealth, LinkTargetStatus } from "@/lib/links-types";
import type { LinksCopy } from "./links-copy";
import { forwardTargetStatus } from "./link-state";

export function ForwardTargets({ link, forward, copy, now }: { link: LinkDetail; forward: LinkForward; copy: LinksCopy; now: number }) {
  const set = forward.target_set;
  const targets = set?.targets ?? [{ host: forward.remote_host, port: forward.remote_port }];
  const status = forwardTargetStatus(link, forward, now);
  const healthLabels: Record<LinkTargetHealth, string> = { unknown: copy.unknown, healthy: copy.healthHealthy,
    suspect: copy.healthSuspect, recovering: copy.healthRecovering, unhealthy: copy.healthUnhealthy };
  const strategies = { fallback: copy.strategyFallback, round_robin: copy.strategyRoundRobin, random: copy.strategyRandom };
  const reasons: Record<LinkTargetStatus["reason"], string> = { initial: copy.reasonInitial, selected: copy.reasonSelected,
    target_failed: copy.reasonTargetFailed, target_recovered: copy.reasonTargetRecovered, all_unavailable: copy.reasonAllUnavailable };
  const chosen = (protocol: "tcp" | "udp") => forward.forward_protocol !== "both" && forward.forward_protocol !== protocol
    ? copy.notApplicable : status?.[`selected_${protocol}`] == null ? copy.unknown : String(status[`selected_${protocol}`]);
  return <section aria-label={copy.targets} className="space-y-3 border-t border-[var(--border)] pt-3 text-sm">
    <h5 className="font-medium">{copy.targets}{!set ? ` · ${copy.targetsLegacy}` : ` (${targets.length})`}</h5>
    {set && <dl className="grid gap-3 sm:grid-cols-2">
      <TargetFact label={copy.targetStrategy} value={strategies[set.strategy]} />
      <TargetFact label={copy.targetProbe} value={set.probe === "none" ? copy.probeNone : forward.forward_protocol === "udp" ? copy.probeTcpAuxiliary : copy.probeTcp} />
      <TargetFact label={copy.targetFailureSeconds} value={String(set.failure_seconds)} />
      <TargetFact label={copy.targetRecoverSeconds} value={String(set.recover_seconds)} />
    </dl>}
    <dl className="grid gap-3 sm:grid-cols-2">
      <TargetFact label={copy.targetLastTcp} value={chosen("tcp")} /><TargetFact label={copy.targetLastUdp} value={chosen("udp")} />
    </dl>
    <ol className="space-y-2" aria-label={copy.targetHealth}>
      {targets.map((target, index) => {
        const health = status?.states[index] ?? "unknown";
        return <li key={index} data-target-index={index} className="rounded-md border border-[var(--border)] p-3">
          <p className="mb-2 break-all font-medium">{copy.targetIndex} {index} · {target.host.includes(":") && !target.host.startsWith("[") ? `[${target.host}]` : target.host}:{target.port}</p>
          <dl className="grid gap-3 sm:grid-cols-2">
            <TargetFact label={copy.targetHealth} value={healthLabels[health]} />
            <TargetFact label={copy.targetLastChecked} value={status?.last_checked_at ?? copy.unknown} />
            <TargetFact label={copy.targetReason} value={status ? reasons[status.reason] : copy.unknown} />
          </dl>
        </li>;
      })}
    </ol>
    <p className="text-[var(--muted-foreground)]">{copy.targetHealthHint}</p>
    {!status && <p className="text-[var(--muted-foreground)]">{copy.targetUnknownHint}</p>}
    {set?.probe === "none" && <p className="text-[var(--muted-foreground)]">{copy.targetProbeHint}</p>}
    {(forward.forward_protocol === "udp" || forward.forward_protocol === "both") && <p className="text-[var(--muted-foreground)]">{copy.udpProbeHint}</p>}
  </section>;
}
function TargetFact({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><dt className="text-[var(--muted-foreground)]">{label}</dt><dd className="break-all font-medium">{value}</dd></div>;
}
