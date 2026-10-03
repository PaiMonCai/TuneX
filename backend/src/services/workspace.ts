import type { Prisma } from "@prisma/client";
import { db } from "../db.ts";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import type { AppVariables } from "../middlewares/auth.ts";
import { assignDefaultPolicy } from "./policy-service.ts";
import { customRoleGrants, isValidCustomPermissions, parseCustomPermissions } from "./workspace-permissions.ts";

/** Every new account gets an owned personal workspace + free policy in the SAME transaction. */
export async function createPersonalWorkspace(tx: Prisma.TransactionClient, user: { id: number; email: string }) {
  const workspace = await tx.workspace.create({
    data: {
      slug: `personal-${user.id}`,
      name: `Personal ${user.id}`,
      kind: "personal",
      personal_user_id: user.id,
      created_by_id: user.id,
      members: { create: { user_id: user.id, role: "owner" } },
    },
  });
  await assignDefaultPolicy(tx, workspace);
  return workspace;
}

/** Idempotent seed repair for preexisting administrator accounts. */
export async function ensurePersonalWorkspace(user: { id: number; email: string }) {
  const workspace = await db.$transaction(async (tx) => {
    const ws = await tx.workspace.upsert({
      where: { personal_user_id: user.id },
      create: {
        slug: `personal-${user.id}`,
        name: `Personal ${user.id}`,
        kind: "personal",
        personal_user_id: user.id,
        created_by_id: user.id,
      },
      update: {},
    });
    await tx.workspaceMember.upsert({
      where: { workspace_id_user_id: { workspace_id: ws.id, user_id: user.id } },
      create: { workspace_id: ws.id, user_id: user.id, role: "owner" },
      update: { active: true, role: "owner" },
    });
    await assignDefaultPolicy(tx, ws);
    return ws;
  });
  return workspace;
}

export type WorkspaceAction = "read" | "create" | "update" | "delete" | "manage";
export type WorkspaceRole = "owner" | "admin" | "member" | "viewer";
export type WorkspaceResourceFamily = "forward" | "tunnel" | "node" | "member" | "settings" | "audit";

/** Compatibility only: new code must use the resource-aware kernel below. */
export function canWorkspaceAction(role: WorkspaceRole, action: WorkspaceAction, isCreator = false): boolean {
  if (!(role === "owner" || role === "admin" || role === "member" || role === "viewer")) return false;
  if (!(action === "read" || action === "create" || action === "update" || action === "delete" || action === "manage")) return false;
  if (role === "owner" || role === "admin") return true;
  if (role === "viewer") return action === "read";
  if (action === "read" || action === "create") return true;
  return isCreator === true && (action === "update" || action === "delete");
}

export interface WorkspaceAccess {
  id: number;
  role: WorkspaceRole;
  personalWorkspaceId: number;
  kind: "personal" | "team";
  /** Non-null means replacement permissions, never a fallback to the base role. */
  customRoleId: number | null;
  /** Optional for old mocks; missing permissions for a bound role deny access. */
  customPermissions?: unknown;
  actorId?: number;
}

function requiredPermission(action: WorkspaceAction, resource: WorkspaceResourceFamily): string | null {
  if (resource === "forward" || resource === "tunnel") {
    return action === "read" || action === "create" || action === "update" || action === "delete"
      ? `forward:${action}` : null;
  }
  if (resource === "node" || resource === "member" || resource === "settings") {
    return action === "read" || action === "manage" ? `${resource}:${action}` : null;
  }
  return resource === "audit" && action === "read" ? "audit:read" : null;
}

/** Legacy helper keeps its null sentinel; bound-role callers must never fall back. */
export function actionFromCustomRole(
  permissions: unknown,
  action: WorkspaceAction,
  resource: WorkspaceResourceFamily = "tunnel",
): boolean | null {
  const permission = requiredPermission(action, resource);
  if (!permission) return false;
  if (permissions === undefined || permissions === null) return null;
  return customRoleGrants(permissions, permission);
}

/**
 * Authoritative RBAC decision, independent of scope/capability/quota/admission.
 * Call only after loading a workspace-scoped resource. Forward update/delete by
 * a base member needs explicit creator proof; node/member/settings management
 * never inherits Forward create/update privileges. Owner is the break-glass role.
 */
export function canWorkspaceResourceAction(
  access: WorkspaceAccess,
  action: WorkspaceAction,
  resource: WorkspaceResourceFamily,
  isCreator = false,
): boolean {
  const permission = requiredPermission(action, resource);
  if (!permission) return false;
  if (access.role === "owner") return true;
  if (!(access.role === "admin" || access.role === "member" || access.role === "viewer")) return false;
  if (access.customRoleId != null) {
    return Number.isSafeInteger(access.customRoleId) && access.customRoleId > 0
      && customRoleGrants(access.customPermissions, permission);
  }
  if (access.role === "admin") return true;
  if (action === "read") return true;
  if (access.role === "viewer") return false;
  if (resource !== "forward" && resource !== "tunnel") return false;
  return action === "create" || (isCreator === true && (action === "update" || action === "delete"));
}

/** Keep Hono's response intact so the application error handler preserves layers. */
export function workspacePermissionDenied(message = "工作空间角色无权操作"): HTTPException {
  return new HTTPException(403, {
    message,
    res: Response.json({ error: message, code: "permission_denied", error_layer: "rbac" }, { status: 403 }),
  });
}

/** Narrow injectable database interface; tests need no process-global module mocks. */
export interface WorkspaceAccessDb {
  workspace: {
    findUnique(args: { where: { personal_user_id: number }; select: { id: true } }): Promise<{ id: number } | null>;
  };
  workspaceMember: {
    findUnique(args: {
      where: { workspace_id_user_id: { workspace_id: number; user_id: number } };
      include: { workspace: { select: { kind: true } }; custom_role: { select: { id: true; workspace_id: true; permissions: true } } };
    }): Promise<{
      active: boolean;
      role: WorkspaceRole;
      role_id: number | null;
      workspace: { kind: "personal" | "team" };
      custom_role: { id: number; workspace_id: number; permissions: unknown } | null;
    } | null>;
  };
}

/** Missing header selects personal workspace. An explicit invalid/revoked ID never falls back. */
export async function resolveWorkspaceMembership(
  c: Context<{ Variables: AppVariables }>,
  accessDb: WorkspaceAccessDb = db,
): Promise<WorkspaceAccess> {
  const user = c.get("user");
  if (!user) throw new HTTPException(401, { message: "Unauthorized" });
  const personal = await accessDb.workspace.findUnique({ where: { personal_user_id: user.id }, select: { id: true } });
  if (!personal) throw new HTTPException(403, { message: "个人空间不存在" });
  const raw = c.req.header("x-workspace-id");
  const id = raw === undefined ? personal.id : Number(raw);
  if (!Number.isSafeInteger(id) || id < 1) throw new HTTPException(400, { message: "非法工作空间 ID" });
  // Legacy user API keys are account-wide. Until scoped workspace keys are implemented,
  // they can only access their own personal workspace, never another team.
  if (id !== personal.id && c.req.header("authorization")?.toLowerCase().startsWith("bearer ")) {
    throw workspacePermissionDenied("团队空间需要工作空间凭证");
  }
  const member = await accessDb.workspaceMember.findUnique({
    where: { workspace_id_user_id: { workspace_id: id, user_id: user.id } },
    include: { workspace: { select: { kind: true } }, custom_role: { select: { id: true, workspace_id: true, permissions: true } } },
  });
  if (!member?.active) throw new HTTPException(404, { message: "工作空间不存在" });

  const customRole = member.custom_role;
  const hasCustomRole = member.role_id != null;
  // Owner keeps a recovery path. Every other bound role must be intact and scoped;
  // a broken reference must never restore base admin/member privileges.
  const validCustomRole = hasCustomRole && Number.isSafeInteger(member.role_id) && member.role_id! > 0
    && customRole?.id === member.role_id && customRole.workspace_id === id
    && isValidCustomPermissions(customRole.permissions);
  if (member.role !== "owner" && hasCustomRole && !validCustomRole) {
    throw workspacePermissionDenied("自定义工作空间角色无效");
  }
  const access: WorkspaceAccess = {
    id,
    role: member.role,
    personalWorkspaceId: personal.id,
    kind: member.workspace.kind,
    customRoleId: member.role_id ?? null,
    customPermissions: validCustomRole ? parseCustomPermissions(customRole!.permissions) : undefined,
    actorId: user.id,
  };
  return access;
}

export async function resolveWorkspaceAccess(
  c: Context<{ Variables: AppVariables }>,
  action: WorkspaceAction,
  resource: WorkspaceResourceFamily = "tunnel",
  accessDb: WorkspaceAccessDb = db,
): Promise<WorkspaceAccess> {
  const access = await resolveWorkspaceMembership(c, accessDb);
  // This is only the middleware prefilter. For a base member, update/delete must
  // be rechecked against the actual workspace-scoped Forward's creator before
  // any write or Agent command. Passing true here does NOT prove ownership.
  const creatorPrefilter = access.role === "member" && access.customRoleId == null
    && (resource === "forward" || resource === "tunnel")
    && (action === "update" || action === "delete");
  if (!canWorkspaceResourceAction(access, action, resource, creatorPrefilter)) {
    throw workspacePermissionDenied();
  }
  return access;
}
