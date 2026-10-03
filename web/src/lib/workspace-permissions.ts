import type { PortForward, WorkspaceRole } from "./types";

export const WORKSPACE_PERMISSION_KEYS = [
  "forward:read", "forward:create", "forward:update", "forward:delete",
  "node:read", "node:manage", "member:read", "member:manage",
  "settings:read", "settings:manage", "audit:read",
] as const;
export type WorkspacePermission = typeof WORKSPACE_PERMISSION_KEYS[number];
export interface EffectiveWorkspacePermissions {
  workspace_id: number;
  actor_id: number;
  role: WorkspaceRole;
  custom_role_id: number | null;
  permissions: Record<WorkspacePermission, boolean>;
  forward_mutations: "own" | "workspace";
}

/** Unknown, missing, stale or malformed projections never grant a permission. */
export function validPermissionProjection(
  value: EffectiveWorkspacePermissions | null,
  workspaceId: number | null,
  actorId: number | null,
): value is EffectiveWorkspacePermissions {
  return !!value && workspaceId !== null && actorId !== null &&
    value.workspace_id === workspaceId && value.actor_id === actorId &&
    (value.forward_mutations === "own" || value.forward_mutations === "workspace") &&
    !!value.permissions && typeof value.permissions === "object";
}
export function hasWorkspacePermission(value: EffectiveWorkspacePermissions | null, key: WorkspacePermission): boolean {
  return value?.permissions?.[key] === true;
}
export function canMutateForward(
  value: EffectiveWorkspacePermissions | null,
  forward: Pick<PortForward, "creator_user_id">,
  action: "update" | "delete",
): boolean {
  if (!value || !hasWorkspacePermission(value, `forward:${action}`)) return false;
  if (value.forward_mutations === "workspace") return true;
  return value.forward_mutations === "own" && Number.isInteger(value.actor_id) && value.actor_id > 0 &&
    typeof forward.creator_user_id === "number" && forward.creator_user_id === value.actor_id;
}
export const PERMISSION_DENIED = "权限不足：当前操作未获授权；请联系工作空间管理员。";
export function shouldRedirectToLogin(status: number): boolean { return status === 401; }

/** Monotonic request fence, used to discard late switch/refresh responses. */
export function createPermissionRequestFence() {
  let version = 0;
  return { next: () => ++version, current: (ticket: number) => ticket === version };
}
export interface WorkspaceCustomRole {
  id: number;
  workspace_id?: number;
  name: string;
  description: string | null;
  permissions: Partial<Record<WorkspacePermission, boolean>>;
}
export interface WorkspaceCustomRoleInput {
  name: string;
  description?: string | null;
  permissions: Partial<Record<WorkspacePermission, boolean>>;
}
export type WorkspaceMemberRoleInput = { role_id: number | null; role?: never } | { role: "admin" | "member" | "viewer"; role_id?: never };
