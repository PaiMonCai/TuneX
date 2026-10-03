/** WP10 runtime-use gate. No RBAC or creation-count semantics live here. */
import { checkTunnelUse, type EffectivePolicy } from "./capability-policy.ts";

export interface RuntimeUseResource {
  user_id: number;
  in_node_group_id: number;
  out_node_group_id: number | null;
  tunnel_type?: string;
}
export interface RuntimeUseDeps {
  policy(workspaceId: number): Promise<EffectivePolicy>;
  traffic(workspaceId: number, period: "total" | "month" | "day"): Promise<number>;
  group(id: number): Promise<{ id: number; user_id: number; workspace_id: number } | null>;
  personalWorkspace(userId: number): Promise<number | null>;
  granted(userId: number, group: { id: number; user_id: number; workspace_id: number }, direction: "in" | "out", workspaceId: number, personalWorkspaceId: number): Promise<boolean>;
}
export type RuntimeUseDenied = {
  code: "policy_denied" | "forbidden";
  reason: string;
  error_layer: "capability" | "quota" | "resource_scope";
  message: string;
};

async function defaults(): Promise<RuntimeUseDeps> {
  const [{ db }, policy, { canUseNodeGroup }] = await Promise.all([
    import("../db.ts"), import("./policy-service.ts"), import("./node-group-access.ts"),
  ]);
  return {
    policy: (id) => policy.getEffectivePolicy(id, { noCache: true }),
    traffic: (id, period) => policy.sumWorkspaceTraffic(id, period, new Date()),
    group: (id) => db.nodeGroup.findUnique({ where: { id }, select: { id: true, user_id: true, workspace_id: true } }),
    personalWorkspace: async (id) => (await db.workspace.findUnique({ where: { personal_user_id: id }, select: { id: true } }))?.id ?? null,
    granted: canUseNodeGroup,
  };
}

/** Read/delete/suspend/metadata remain available after revoke. Call immediately
 * before any new runtime-use intent (including recovery of a pending rollout). */
export async function checkForwardRuntimeUse(
  workspaceId: number,
  resource: RuntimeUseResource,
  inject?: RuntimeUseDeps,
): Promise<RuntimeUseDenied | null> {
  const deps = inject ?? await defaults();
  const [ingress, egress, personal] = await Promise.all([
    deps.group(resource.in_node_group_id),
    resource.out_node_group_id === null ? null : deps.group(resource.out_node_group_id),
    deps.personalWorkspace(resource.user_id),
  ]);
  for (const [group, direction] of [[ingress, "in"], [egress, "out"]] as const) {
    if (direction === "out" && resource.out_node_group_id === null) continue;
    if (!group || !(await deps.granted(resource.user_id, group, direction, workspaceId, personal ?? -1))) {
      return { code: "forbidden", reason: "scope_revoked", error_layer: "resource_scope", message: "节点组授权已撤销或不属于当前工作空间，请选择仍获授权的节点" };
    }
  }
  const policy = await deps.policy(workspaceId);
  const decision = checkTunnelUse(policy, {
    trafficUsed: await deps.traffic(workspaceId, policy.limits.traffic_period),
    protocol: resource.tunnel_type ?? "tcp",
    inGroupId: resource.in_node_group_id,
    inGroupOwned: ingress!.workspace_id === workspaceId,
    outGroupId: resource.out_node_group_id,
    outGroupOwned: !egress || egress.workspace_id === workspaceId,
  });
  if (decision.allowed) return null;
  return {
    code: "policy_denied", reason: decision.reason ?? "no_active_policy",
    error_layer: decision.reason === "traffic_exhausted" ? "quota" : "capability",
    message: decision.message ?? "能力策略拒绝，请联系工作空间管理员",
  };
}
