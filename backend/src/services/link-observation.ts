import { parseLinkPlacements, type ReportedTrafficStatus } from "./node-state-report.ts";

interface LinkObservation {
  state: string;
  ready: boolean | null;
  observed_generation: number | null;
  traffic_status?: ReportedTrafficStatus;
}

export const LINK_OBSERVATION_FRESH_MS = 60_000;
export function linkObservation(expected: { runtime_id: string; node_id: number; role: string;
  generation: number; config_digest: string }, workspaceId: number, linkId: number,
  report: { reported_at: Date; link_placements: unknown } | null, now = new Date()): LinkObservation {
  const unknown = { state: "unknown", ready: null as boolean | null, observed_generation: null as number | null };
  if (!report) return unknown;
  const age = now.getTime() - report.reported_at.getTime();
  if (!Number.isFinite(age) || age < -5_000 || age > LINK_OBSERVATION_FRESH_MS)
    return { ...unknown, state: "stale" };
  const parsed = parseLinkPlacements(report.link_placements);
  if (!parsed.ok || parsed.placements === null) return unknown;
  const fact = parsed.placements.find((p) => p.id === expected.runtime_id && p.link_id === linkId &&
    p.workspace_id === workspaceId && p.node_id === expected.node_id && p.role === expected.role);
  if (!fact) return { ...unknown, state: "absent", ready: false };
  const observed = { observed_generation: fact.observed_generation, ready: false as boolean | null };
  if (fact.generation !== expected.generation || fact.desired_config_digest !== expected.config_digest)
    return { ...observed, state: "mismatch" };
  // Capacity belongs to this exact placement/config, including a stopped child
  // with no live observed generation. ACK cannot grant Ready or extend a lease.
  const capacity = fact.state !== "expired" && (fact.observed_generation === expected.generation ||
    (fact.observed_generation === 0 && !fact.ready)) && fact.config_digest === expected.config_digest &&
    fact.lease_expires_at && Date.parse(fact.lease_expires_at) > now.getTime() && fact.traffic_status
    ? { traffic_status: { ...fact.traffic_status } } : {};
  if (["removed", "failed", "expired", "exited", "closed"].includes(fact.state))
    return { ...observed, ...capacity, state: fact.state };
  if (!fact.lease_expires_at || Date.parse(fact.lease_expires_at) <= now.getTime())
    return { ...observed, state: "expired" };
  if (fact.state === "passive") return { ...observed, ...capacity, state: "passive" };
  if (fact.observed_generation !== expected.generation || fact.config_digest !== expected.config_digest)
    return { ...observed, ...capacity, state: "mismatch" };
  return { ...observed, ...capacity, state: fact.ready ? "ready" : fact.state, ready: fact.ready };
}
