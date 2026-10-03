/** Additive error classification; old machine codes remain compatible. */
export type AuthorizationErrorLayer = "authentication" | "rbac" | "resource_scope" | "capability" | "quota" | "runtime_admission";
const QUOTA = new Set(["tunnel_limit", "node_limit", "member_limit", "traffic_exhausted"]);
const CAPABILITY = new Set(["no_active_policy", "policy_expired", "protocol_not_allowed", "in_group_not_allowed", "out_group_not_allowed", "policy_denied"]);
const RUNTIME = new Set(["conflict", "invalid_state", "port_conflict", "port_unavailable", "binding_required", "node_unavailable", "node_maintenance", "node_disabled", "node_retiring", "apply_failed", "incompatible_agent"]);
export function authorizationErrorLayer(code: string, data?: unknown): AuthorizationErrorLayer | undefined {
  if (data && typeof data === "object") {
    const explicit = (data as Record<string, unknown>).error_layer;
    if (explicit === "authentication" || explicit === "rbac" || explicit === "resource_scope" || explicit === "capability" || explicit === "quota" || explicit === "runtime_admission") return explicit;
    if ("condition" in data) return "runtime_admission";
  }
  if (code === "unauthorized") return "authentication";
  if (code === "permission_denied") return "rbac";
  if (code === "not_found" || code === "scope_revoked") return "resource_scope";
  if (QUOTA.has(code)) return "quota";
  if (CAPABILITY.has(code)) return "capability";
  if (RUNTIME.has(code)) return "runtime_admission";
  return undefined;
}
