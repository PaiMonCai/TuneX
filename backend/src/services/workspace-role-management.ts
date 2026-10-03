/** WP10 workspace custom roles: scoped, transactional, non-escalating management.
 * Runtime dependencies are loaded lazily so isolated tests need no DB/Redis mocks.
 */
import type { Prisma } from "@prisma/client";
import type { WorkspaceAccess, WorkspaceAction, WorkspaceResourceFamily } from "./workspace.ts";
import { WORKSPACE_PERMISSIONS, isValidCustomPermissions, parseCustomPermissions } from "./workspace-permissions.ts";

export const ROLE_PERMISSION_KEYS = WORKSPACE_PERMISSIONS;
export type RolePermission = (typeof ROLE_PERMISSION_KEYS)[number];
export type RolePermissionMap = Partial<Record<RolePermission, boolean>>;
type BaseRole = WorkspaceAccess["role"];
export interface RoleManagementScope { workspaceId: number; actorId: number; ip?: string }
export class WorkspaceRoleError extends Error {
  constructor(public readonly status: 400 | 401 | 403 | 404 | 409, message: string,
    public readonly error_layer: "authentication" | "rbac" | "resource_scope" = "rbac") {
    super(message);
  }
}
export interface WorkspaceRoleDependencies {
  transaction: <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
  can: (access: WorkspaceAccess, action: WorkspaceAction, resource: WorkspaceResourceFamily,
    isCreator?: boolean) => boolean | Promise<boolean>;
}
const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
const record = (input: unknown): input is Record<string, unknown> =>
  input !== null && typeof input === "object" && !Array.isArray(input);

/** Requests are strict; canonical false wins over legacy true and is retained. */
export function normalizeRolePermissions(input: unknown): RolePermissionMap {
  if (!isValidCustomPermissions(input)) throw new WorkspaceRoleError(400, "未知权限键或非布尔权限值");
  return parseCustomPermissions(input) as RolePermissionMap;
}
function validateId(id: number) {
  if (!Number.isSafeInteger(id) || id < 1) throw new WorkspaceRoleError(400, "非法资源 ID", "resource_scope");
}
function parseRoleInput(input: unknown, partial: boolean) {
  if (!record(input) || Object.keys(input).some((key) => !["name", "description", "permissions"].includes(key))) {
    throw new WorkspaceRoleError(400, "角色请求不合法");
  }
  const result: { name?: string; description?: string | null; permissions?: RolePermissionMap } = {};
  if (own(input, "name")) {
    if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 60) {
      throw new WorkspaceRoleError(400, "角色名称必须为 1–60 个字符");
    }
    result.name = input.name.trim();
  }
  if (own(input, "description")) {
    if (input.description !== null && (typeof input.description !== "string" || input.description.length > 255)) {
      throw new WorkspaceRoleError(400, "角色描述必须为不超过 255 个字符的字符串或 null");
    }
    result.description = input.description as string | null;
  }
  if (own(input, "permissions")) result.permissions = normalizeRolePermissions(input.permissions);
  if ((!partial && (!result.name || !result.permissions)) || !Object.keys(result).length) {
    throw new WorkspaceRoleError(400, "角色名称和权限不能为空");
  }
  return result;
}
function parseAssignment(input: unknown): { role_id: number | null } | { role: Exclude<BaseRole, "owner"> } {
  if (!record(input) || Object.keys(input).length !== 1) throw new WorkspaceRoleError(400, "指定 role_id 或基础 role");
  if (own(input, "role_id")) {
    if (input.role_id === null) return { role_id: null };
    if (typeof input.role_id !== "number") throw new WorkspaceRoleError(400, "非法角色 ID");
    validateId(input.role_id);
    return { role_id: input.role_id };
  }
  if (input.role === "admin" || input.role === "member" || input.role === "viewer") return { role: input.role };
  throw new WorkspaceRoleError(400, "基础角色必须为 admin/member/viewer");
}

const defaultDependencies: WorkspaceRoleDependencies = {
  transaction: async (work) => {
    const { db } = await import("../db.ts");
    return db.$transaction(work);
  },
  can: async (access, action, resource, isCreator) => {
    const { canWorkspaceResourceAction } = await import("./workspace.ts");
    return canWorkspaceResourceAction(access, action, resource, isCreator);
  },
};
const memberInclude = { workspace: { select: { kind: true } },
  custom_role: { select: { id: true, workspace_id: true, permissions: true } } } as const;
type Member = Prisma.WorkspaceMemberGetPayload<{ include: typeof memberInclude }>;

function accessFor(member: Member): WorkspaceAccess {
  const validRole = member.custom_role?.workspace_id === member.workspace_id
    && member.custom_role.id === member.role_id ? member.custom_role : null;
  return {
    id: member.workspace_id, actorId: member.user_id, role: member.role,
    personalWorkspaceId: member.workspace_id, kind: member.workspace.kind,
    customRoleId: member.role_id, customPermissions: validRole?.permissions ?? null,
  };
}
function publicRole(role: { id: number; workspace_id: number; name: string; description: string | null;
  permissions: unknown; created_by_id: number; created_at: Date; updated_at: Date }) {
  // A damaged stored map must not grant anything in a read projection.
  let permissions: RolePermissionMap = {};
  try { permissions = normalizeRolePermissions(role.permissions); } catch { /* fail closed */ }
  return { ...role, permissions };
}

export function createWorkspaceRoleManagement(overrides: Partial<WorkspaceRoleDependencies> = {}) {
  const deps = { ...defaultDependencies, ...overrides };
  async function transaction<T>(scope: RoleManagementScope, action: "read" | "manage",
    work: (tx: Prisma.TransactionClient, actor: WorkspaceAccess) => Promise<T>): Promise<T> {
    validateId(scope.workspaceId); validateId(scope.actorId);
    try {
      return await deps.transaction(async (tx) => {
        // Serialize role/member mutations, including role deletion vs assignment.
        // The membership and permission reads below occur after this lock, not in the route.
        await tx.$queryRaw`SELECT id FROM workspace WHERE id = ${scope.workspaceId} FOR UPDATE`;
        const member = await tx.workspaceMember.findUnique({
          where: { workspace_id_user_id: { workspace_id: scope.workspaceId, user_id: scope.actorId } },
          include: memberInclude,
        });
        if (!member?.active) throw new WorkspaceRoleError(404, "工作空间不存在", "resource_scope");
        const actor = accessFor(member);
        if (!await deps.can(actor, action, "member")) throw new WorkspaceRoleError(403, "无权管理工作空间角色");
        return work(tx, actor);
      });
    } catch (error) {
      if ((error as { code?: string })?.code === "P2002") throw new WorkspaceRoleError(409, "角色名称已存在");
      throw error;
    }
  }
  async function assertSubset(actor: WorkspaceAccess, permissions: RolePermissionMap) {
    for (const key of ROLE_PERMISSION_KEYS) {
      if (permissions[key] !== true) continue;
      const [resource, action] = key.split(":");
      if (!await deps.can(actor, action as WorkspaceAction, resource as WorkspaceResourceFamily)) {
        throw new WorkspaceRoleError(403, `不能授予超出本人权限的 ${key}`);
      }
    }
  }
  async function assertEditable(actor: WorkspaceAccess, permissions: unknown) {
    let canonical: RolePermissionMap;
    try { canonical = normalizeRolePermissions(permissions); }
    catch {
      if (actor.role === "owner") return; // break-glass repair of corrupt stored JSON
      throw new WorkspaceRoleError(403, "不能管理损坏的角色权限");
    }
    await assertSubset(actor, canonical);
  }
  async function loadRole(tx: Prisma.TransactionClient, scope: RoleManagementScope, roleId: number) {
    validateId(roleId);
    const role = await tx.workspaceCustomRole.findFirst({ where: { id: roleId, workspace_id: scope.workspaceId } });
    if (!role) throw new WorkspaceRoleError(404, "角色不存在", "resource_scope");
    return role;
  }
  async function audit(tx: Prisma.TransactionClient, scope: RoleManagementScope, action: string,
    resourceType: string, id: number) {
    // Do not copy body, headers, credentials or token into metadata.
    await tx.auditEvent.create({ data: { workspace_id: scope.workspaceId, actor_user_id: scope.actorId,
      action, resource_type: resourceType, resource_id: String(id), ip: scope.ip ?? null } });
  }
  return {
    listRoles: (scope: RoleManagementScope) => transaction(scope, "read", async (tx) => {
      const roles = await tx.workspaceCustomRole.findMany({ where: { workspace_id: scope.workspaceId }, orderBy: { id: "asc" } });
      return roles.map(publicRole);
    }),
    createRole: (scope: RoleManagementScope, input: unknown) => {
      const data = parseRoleInput(input, false);
      return transaction(scope, "manage", async (tx, actor) => {
        await assertSubset(actor, data.permissions!);
        const role = await tx.workspaceCustomRole.create({ data: { workspace_id: scope.workspaceId,
          created_by_id: scope.actorId, name: data.name!, description: data.description ?? null,
          permissions: data.permissions! } });
        await audit(tx, scope, "role.created", "workspace_custom_role", role.id);
        return publicRole(role);
      });
    },
    updateRole: (scope: RoleManagementScope, roleId: number, input: unknown) => {
      const data = parseRoleInput(input, true);
      return transaction(scope, "manage", async (tx, actor) => {
        const role = await loadRole(tx, scope, roleId);
        await assertEditable(actor, role.permissions);
        if (data.permissions) await assertSubset(actor, data.permissions);
        if (await tx.workspaceMember.count({ where: { role_id: role.id, role: "owner" } })) {
          throw new WorkspaceRoleError(403, "不能影响 owner 角色");
        }
        const permissions = data.permissions ?? normalizeRolePermissions(role.permissions);
        const updated = await tx.workspaceCustomRole.update({ where: { id: role.id }, data: { ...data, permissions } });
        await audit(tx, scope, "role.updated", "workspace_custom_role", role.id);
        return publicRole(updated);
      });
    },
    deleteRole: (scope: RoleManagementScope, roleId: number) => transaction(scope, "manage", async (tx, actor) => {
      const role = await loadRole(tx, scope, roleId);
      await assertEditable(actor, role.permissions);
      // No active filter: SetNull would silently restore even inactive members' base rights.
      if (await tx.workspaceMember.count({ where: { role_id: role.id } })) {
        throw new WorkspaceRoleError(409, "角色仍被成员绑定，请先显式调整成员角色");
      }
      await tx.workspaceCustomRole.delete({ where: { id: role.id } });
      await audit(tx, scope, "role.deleted", "workspace_custom_role", role.id);
      return { ok: true };
    }),
    assignMemberRole: (scope: RoleManagementScope, userId: number, input: unknown) => {
      validateId(userId);
      const assignment = parseAssignment(input);
      return transaction(scope, "manage", async (tx, actor) => {
        const target = await tx.workspaceMember.findUnique({
          where: { workspace_id_user_id: { workspace_id: scope.workspaceId, user_id: userId } },
          include: memberInclude,
        });
        if (!target) throw new WorkspaceRoleError(404, "成员不存在", "resource_scope");
        if (target.role === "owner") throw new WorkspaceRoleError(403, "不能更改 owner 角色");
        const data = "role" in assignment ? { role: assignment.role, role_id: null }
          : { role_id: assignment.role_id };
        if ("role_id" in assignment && assignment.role_id !== null) {
          const role = await loadRole(tx, scope, assignment.role_id);
          await assertEditable(actor, role.permissions);
        } else {
          // Resetting custom role (including role_id:null) can restore broad base rights.
          // isCreator=true accounts for member's own-forward update/delete capabilities.
          const candidate = { ...accessFor(target), role: "role" in assignment ? assignment.role : target.role,
            customRoleId: null, customPermissions: null };
          const permissions: RolePermissionMap = {};
          for (const key of ROLE_PERMISSION_KEYS) {
            const [resource, action] = key.split(":");
            if (await deps.can(candidate, action as WorkspaceAction, resource as WorkspaceResourceFamily, true)) {
              permissions[key] = true;
            }
          }
          await assertSubset(actor, permissions);
        }
        const changed = await tx.workspaceMember.update({ where: { id: target.id }, data,
          select: { user_id: true, workspace_id: true, role: true, role_id: true, active: true } });
        await audit(tx, scope, "member.role_assigned", "workspace_member", userId);
        return changed;
      });
    },
  };
}
export type WorkspaceRoleManagement = ReturnType<typeof createWorkspaceRoleManagement>;
export const workspaceRoleManagement = createWorkspaceRoleManagement();
