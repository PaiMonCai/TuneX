import type { LinkBindingInput, LinkDetail, LinkForward, LinkPlacement, LinkTargetStatus } from "@/lib/links-types";
import type { LinkErrorInfo } from "@/lib/links-api";
import type { LinksCopy } from "./links-copy";

export function linkStatusLabel(status: string, copy: LinksCopy): string {
  const labels: Record<string, string> = { draft: copy.statusDraft, pending: copy.statusPending, deploying: copy.statusDeploying,
    active: copy.statusActive, degraded: copy.statusDegraded, retired: copy.statusRetired,
    running: copy.statusRunning, passive: copy.statusPassive, error: copy.statusError,
    failed: copy.statusFailed, suspended: copy.statusSuspended, inactive: copy.statusInactive,
    retiring: copy.statusRetiring, blocked: copy.statusBlocked, policy_blocked: copy.statusPolicyBlocked, applied: copy.applied, stale: copy.stale,
    ready: copy.statusRunning, exited: copy.exited, closed: copy.closed, removed: copy.removed, mismatch: copy.mismatch, absent: copy.absent };
  return labels[status] ?? copy.unknown;
}
export function linkErrorMessage(error: LinkErrorInfo, copy: LinksCopy, reading = false): string {
  if (["protocol_change_requires_new_forward", "listen_scope_change_requires_new_forward"].includes(error.code ?? "")) return copy.protocolLocked;
  if (error.code === "link_config_requires_retirement") return copy.endpointRetire;
  if (error.code === "link_has_references") return copy.zeroRefs;
  if (error.code === "agent_fxp_targets_capability_missing") return copy.targetsCapabilityMissing;
  if (error.code === "agent_fxp_capability_missing") return copy.fxpCapabilityMissing;
  if (error.code === "link_target_set_required") return copy.targetSetRequired;
  if (error.code === "link_config_too_large") return copy.configTooLarge;
  return error.disabled ? copy.disabled : error.conflict ? copy.conflict : error.denied ? (reading ? copy.denied : copy.actionDenied)
    : reading ? copy.readFailed : copy.failed;
}
export function linkIdFromSelection(value: string | null): number | null {
  if (!value || !/^[1-9]\d{0,9}$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id <= 2_147_483_647 ? id : null;
}
/** An expired or malformed lease cannot be presented as a current running state. */
export function linkLiveState(link: LinkDetail, placement: LinkPlacement, now: number): string {
  if (link.status === "retired") return "removed";
  if (link.status === "retiring") return "unknown";
  const expiry = Date.parse(link.deployment?.lease_expires_at ?? "");
  if (!Number.isFinite(expiry)) return "unknown";
  if (expiry <= now) return "expired";
  if (link.deployment?.generation !== link.generation || placement.generation !== link.generation) return "pending";
  const observation = placement.observation;
  if (!observation) return "unknown";
  if (["stale", "unknown", "absent", "mismatch", "expired", "closed", "removed"].includes(observation.state)) return observation.state;
  if (observation.observed_generation !== link.generation) return "mismatch";
  if (observation.state === "ready") return observation.ready === true ? "ready" : "unknown";
  if (observation.ready === false && ["passive", "failed", "exited"].includes(observation.state)) return observation.state;
  return "unknown";
}
export const placementState = linkLiveState;
export function canEditLinkEndpoints(link: LinkDetail): boolean {
  return canRetireLink(link) && link.generation === 0;
}
export function canRetireLink(link: LinkDetail): boolean {
  return !["retired", "retiring"].includes(link.status) && link.ref_count === 0 && link.forwards.length === 0;
}
export function placementAckState(link: LinkDetail, p: LinkPlacement): string {
  if (p.status === "error") return "error";
  if (p.generation !== link.generation || p.applied_generation !== link.generation) return "pending";
  return p.status === "running" || p.status === "active" || p.status === "applied" ? "applied" : p.status;
}
export function bindingFromForward(forward: LinkForward): LinkBindingInput {
  const targetSet = forward.target_set ? { ...forward.target_set, targets: forward.target_set.targets.map((target) => ({ ...target })) } : undefined;
  return { name: forward.name, protocol: forward.forward_protocol, listen_port: forward.listen_port,
    listen_host: forward.listen_ip === "127.0.0.1" || forward.listen_ip === "::1" ? forward.listen_ip : "" as const,
    target_host: targetSet?.targets[0].host ?? forward.remote_host, target_port: targetSet?.targets[0].port ?? forward.remote_port,
    ...(targetSet ? { target_set: targetSet } : {}),
    bytes_per_second_in: forward.bytes_per_second_in ?? 0, bytes_per_second_out: forward.bytes_per_second_out ?? 0,
    max_connections: forward.max_connections ?? 0, max_connections_per_ip: forward.max_connections_per_ip ?? 0 };
}

/** Consume only the exit's current immutable-generation facts; never infer health from Ready or ACK. */
export function forwardTargetStatus(link: LinkDetail, forward: LinkForward, now: number): LinkTargetStatus | null {
  if (!forward.target_set || forward.config_revision !== forward.applied_revision
    || ["retired", "retiring"].includes(link.status)) return null;
  const deployment = link.deployment;
  const expiry = Date.parse(deployment?.lease_expires_at ?? "");
  if (!deployment || deployment.generation !== link.generation || !Number.isFinite(expiry) || expiry <= now) return null;
  const exits = deployment.placements.filter((p) => p.role === "egress" && p.node_id === link.config?.egress_node_id);
  if (exits.length !== 1) return null;
  const exit = exits[0];
  const observation = exit.observation;
  // The backend projects target facts only for a Ready exit; health never grants Ready.
  if (exit.generation !== link.generation || !observation || observation.observed_generation !== link.generation
    || observation.state !== "ready" || observation.ready !== true) return null;
  const status = observation.target_status?.find((status) => status.forward_id === forward.id);
  if (!status || status.states.length !== forward.target_set.targets.length) return null;
  if (status.last_checked_at === null) return status.states.every((state) => state === "unknown") ? status : null;
  const checkedAt = Date.parse(status.last_checked_at);
  // Match the backend's inclusive 60s age / +5s clock-skew bounds on every render,
  // so cached health cannot persist until the longer runtime lease expires.
  if (!Number.isFinite(checkedAt) || now - checkedAt > 60_000 || checkedAt - now > 5_000) return null;
  return status;
}

/** Every read/mutation uses a ticket; switching workspace/permissions invalidates even late errors. */
export function createLinksScopeFence() {
  let epoch = 0;
  let scope: unknown;
  let serial = 0;
  const tickets = new Map<string, number>();
  return {
    setScope(next: unknown) { if (scope !== next) { scope = next; epoch++; tickets.clear(); } },
    next(channel: string) { const id = ++serial; tickets.set(channel, id); return { epoch, channel, id }; },
    current(ticket: { epoch: number; channel: string; id: number }) {
      return ticket.epoch === epoch && tickets.get(ticket.channel) === ticket.id;
    },
  };
}
