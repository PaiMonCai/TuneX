import { canWorkspaceResourceAction, type WorkspaceAccess, type WorkspaceAction, type WorkspaceResourceFamily } from "./workspace.ts";
import { WORKSPACE_PERMISSIONS } from "./workspace-permissions.ts";

/** Invitations and base-role restores are grants too: a delegated member
 * manager must not mint permissions it does not currently possess. */
export function canGrantWorkspaceBaseRole(access: WorkspaceAccess, role: "admin" | "member" | "viewer") {
  const target: WorkspaceAccess = { ...access, role, customRoleId: null, customPermissions: undefined };
  return WORKSPACE_PERMISSIONS.every((key) => {
    const [resource, action] = key.split(":");
    return !canWorkspaceResourceAction(target, action as WorkspaceAction, resource as WorkspaceResourceFamily, true)
      || canWorkspaceResourceAction(access, action as WorkspaceAction, resource as WorkspaceResourceFamily, true);
  });
}

/** This projection is UX guidance only. Every server action reauthorizes. */
export function effectiveWorkspaceAccess(access: WorkspaceAccess) {
  const permissions = Object.fromEntries(WORKSPACE_PERMISSIONS.map((key) => {
    const [resource, action] = key.split(":");
    return [key, canWorkspaceResourceAction(access, action as WorkspaceAction, resource as WorkspaceResourceFamily, true)];
  }));
  return {
    workspace_id: access.id,
    actor_id: access.actorId ?? null,
    role: access.role,
    custom_role_id: access.customRoleId,
    permissions,
    forward_mutations: access.role === "member" && access.customRoleId == null ? "own" as const : "workspace" as const,
  };
}
