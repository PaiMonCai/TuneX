import { WORKSPACE_PERMISSION_KEYS } from "@/lib/workspace-permissions";
import type { EffectiveWorkspacePermissions, WorkspaceCustomRole } from "@/lib/workspace-permissions";
import type { WorkspaceRole } from "@/lib/types";
import type { MockStore, MockWorkspaceMember } from "./state";

/** In-memory contract fixture, not evidence of real backend authorization. */
export function mockBasePermissions(role: WorkspaceRole) {
  return Object.fromEntries(WORKSPACE_PERMISSION_KEYS.map((key) => [key,
    role === "owner" || role === "admin" || key.endsWith(":read") ||
    (role === "member" && key.startsWith("forward:")),
  ])) as EffectiveWorkspacePermissions["permissions"];
}
export function mockEffectivePermissions(db: MockStore, membership: MockWorkspaceMember): EffectiveWorkspacePermissions {
  const roleId = membership.role_id ?? null;
  const custom = db.workspaceRoles.find((r) => r.id === roleId && r.workspace_id === membership.workspace_id);
  const valid = custom && validMockRolePermissions(custom.permissions);
  // A bound but dangling/foreign/invalid role must yield explicit boolean false,
  // never undefined: the projection contract mirrors the backend fail-closed map.
  const permissions = membership.role === "owner" || roleId === null ? mockBasePermissions(membership.role) :
    Object.fromEntries(WORKSPACE_PERMISSION_KEYS.map((key) => [key, valid === true && custom!.permissions[key] === true])) as EffectiveWorkspacePermissions["permissions"];
  return { workspace_id: membership.workspace_id, actor_id: membership.user_id, role: membership.role,
    custom_role_id: roleId, permissions,
    forward_mutations: membership.role === "member" && roleId === null ? "own" : "workspace" };
}
export function validMockRolePermissions(value: unknown): value is WorkspaceCustomRole["permissions"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, granted]) => WORKSPACE_PERMISSION_KEYS.includes(key as typeof WORKSPACE_PERMISSION_KEYS[number]) && typeof granted === "boolean");
}
export function mockGrantSubset(actor: EffectiveWorkspacePermissions, requested: WorkspaceCustomRole["permissions"]): boolean {
  return WORKSPACE_PERMISSION_KEYS.every((key) => requested[key] !== true || actor.permissions[key] === true);
}
