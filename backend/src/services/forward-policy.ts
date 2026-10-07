/** Pure Forward policy contract. No database, scheduler or transport dependency. */
export const FORWARD_POLICY_MAX = 2147483647;
export const FORWARD_POLICY_CAPABILITY = "forward.policy.runtime.v1";
export const FORWARD_POLICY_FIELDS = [
  "bytes_per_second_in", "bytes_per_second_out", "max_connections", "max_connections_per_ip",
] as const;
export type ForwardPolicyField = (typeof FORWARD_POLICY_FIELDS)[number];
export type ForwardPolicyInput = Partial<Record<ForwardPolicyField, number | null>>;
export type ForwardPolicy = Record<ForwardPolicyField, number>;
export interface ForwardWorkspacePolicy {
  /** Existing workspace entitlement is decimal Mbps, not bytes/second. */
  bandwidth_limit?: number | null;
  /** Existing entitlement is per-tunnel concurrent clients, not distinct IPs. */
  client_limit?: number | null;
  /** Explicit per-IP ceiling only. Legacy ip_limit has unresolved semantics. */
  max_connections_per_ip?: number | null;
}

export function forwardPolicyErrors(input: ForwardPolicyInput): string[] {
  return FORWARD_POLICY_FIELDS.filter((field) => {
    const n = input[field];
    return n != null && (!Number.isInteger(n) || n < 0 || n > FORWARD_POLICY_MAX);
  }).map((field) => `${field} 必须是 0-${FORWARD_POLICY_MAX} 的整数（0 表示不设转发级上限）`);
}

/** NULL/absent persisted fields are the legacy unlimited policy. */
export function forwardPolicyValues(input: ForwardPolicyInput): ForwardPolicy {
  const errors = forwardPolicyErrors(input);
  if (errors.length) throw new Error(errors[0]);
  return Object.fromEntries(FORWARD_POLICY_FIELDS.map((field) => [field, input[field] ?? 0])) as ForwardPolicy;
}

/** Undefined patch fields preserve desired values; zero explicitly resets a cap. */
export function mergeForwardPolicy(base: ForwardPolicyInput, patch: ForwardPolicyInput): ForwardPolicyInput {
  return Object.fromEntries(FORWARD_POLICY_FIELDS.map((field) => [field,
    patch[field] !== undefined ? patch[field] : base[field],
  ]));
}

export function sameForwardPolicy(a: ForwardPolicyInput, b: ForwardPolicyInput): boolean {
  return FORWARD_POLICY_FIELDS.every((field) => (a[field] ?? 0) === (b[field] ?? 0));
}

function finiteCeiling(value: number | null | undefined, multiplier = 1): number {
  if (value == null) return 0;
  // Workspace quotas use NULL for unlimited and 0 for forbidden. They must not
  // be serialized as a Forward's zero (unlimited) runtime setting.
  if (value === 0) throw new Error("workspace_data_plane_forbidden");
  if (!Number.isFinite(value) || value < 0) throw new Error("invalid workspace data-plane ceiling");
  return Math.max(1, Math.min(FORWARD_POLICY_MAX, Math.floor(value * multiplier)));
}

export function hasForwardPolicy(input: ForwardPolicyInput & { speed_limit?: number }): boolean {
  return FORWARD_POLICY_FIELDS.some((field) => (input[field] ?? 0) !== 0) || (input.speed_limit ?? 0) !== 0;
}
export function forwardPolicyCapabilitySupported(facts: {
  capabilities?: string[] | null; capabilitiesMalformed?: boolean; manifestMalformed?: boolean;
  manifest?: { runtime: string[] } | null;
} | null): boolean {
  return !!facts && !facts.capabilitiesMalformed && !facts.manifestMalformed &&
    (facts.capabilities?.includes(FORWARD_POLICY_CAPABILITY) === true ||
      facts.manifest?.runtime.includes(FORWARD_POLICY_CAPABILITY) === true);
}

function cap(request: number, ceiling: number): number {
  return ceiling > 0 ? (request > 0 ? Math.min(request, ceiling) : ceiling) : request;
}

/**
 * Intersect Forward requests with workspace hard ceilings. Neither 0, omission,
 * nor a larger explicit request can remove a workspace cap. Scope is one runtime;
 * this helper does not claim aggregate bandwidth/concurrency across a workspace.
 */
export function resolveForwardPolicy(input: ForwardPolicyInput, workspace: ForwardWorkspacePolicy = {}): ForwardPolicy {
  const requested = forwardPolicyValues(input);
  const bandwidth = finiteCeiling(workspace.bandwidth_limit, 1_000_000 / 8);
  return {
    bytes_per_second_in: cap(requested.bytes_per_second_in, bandwidth),
    bytes_per_second_out: cap(requested.bytes_per_second_out, bandwidth),
    max_connections: cap(requested.max_connections, finiteCeiling(workspace.client_limit)),
    max_connections_per_ip: cap(requested.max_connections_per_ip, finiteCeiling(workspace.max_connections_per_ip)),
  };
}

/**
 * Main-thread delivery seam: call for every DIRECT/RELAY CLIENT ingress config
 * using freshly resolved workspace limits. Do not apply an end-user IP gate at
 * native egress/middle listeners (their peer is the previous-hop Agent).
 * UDP consumes these same concurrency fields as mapping ceilings. Legacy
 * speed_limit remains 0 because explicit direction fields carry the effective cap.
 */
export function forwardPolicyAgentConfig(input: ForwardPolicyInput, workspace: ForwardWorkspacePolicy = {}) {
  return { ...resolveForwardPolicy(input, workspace), policy_scope: "runtime" as const, speed_limit: 0 };
}
