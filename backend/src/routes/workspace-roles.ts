/** WP10 session-only routes; mount at /api/workspaces alongside workspaceRoutes. */
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppVariables } from "../middlewares/auth.ts";
import { WorkspaceRoleError, workspaceRoleManagement,
  type RoleManagementScope, type WorkspaceRoleManagement } from "../services/workspace-role-management.ts";

type AppContext = Context<{ Variables: AppVariables }>;
function parseId(raw: string | undefined): number {
  if (!raw || !/^\d+$/.test(raw)) throw new WorkspaceRoleError(400, "非法资源 ID", "resource_scope");
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id < 1) throw new WorkspaceRoleError(400, "非法资源 ID", "resource_scope");
  return id;
}
function scopeFor(c: AppContext): RoleManagementScope {
  const user = c.get("user");
  if (!user) throw new WorkspaceRoleError(401, "Unauthorized", "authentication");
  const workspaceId = parseId(c.req.param("id"));
  const header = c.req.header("x-workspace-id");
  const context = c.get("workspace");
  // Neither a selected workspace header nor an upstream context can redirect a
  // path-scoped operation into another tenant. The service rechecks active
  // membership for this exact workspace inside the mutation transaction.
  if ((header !== undefined && parseId(header) !== workspaceId)
    || (context && (context.id !== workspaceId || (context.actorId !== undefined && context.actorId !== user.id)))) {
    throw new WorkspaceRoleError(404, "工作空间不存在", "resource_scope");
  }
  return { workspaceId, actorId: user.id, ip: c.get("ip") };
}
async function bodyFor(c: AppContext) {
  try { return await c.req.json(); }
  catch { throw new WorkspaceRoleError(400, "请求必须为合法 JSON"); }
}

/** Dependency injection deliberately avoids global module mocks in Hono tests. */
export function createWorkspaceRolesRoutes(service: WorkspaceRoleManagement = workspaceRoleManagement) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", async (c, next) => {
    try {
      if (/^\s*bearer(?:\s|$)/i.test(c.req.header("authorization") ?? "")) {
        throw new WorkspaceRoleError(403, "工作空间角色管理需要会话凭证", "authentication");
      }
      await next();
    } catch (error) {
      if (error instanceof WorkspaceRoleError) {
        return c.json({ error: error.message, code: `workspace_role_${error.status}`, error_layer: error.error_layer }, error.status);
      }
      throw error;
    }
  });
  // Hono handles exceptions before middleware can catch them; this handler is
  // restricted to our domain errors and lets the parent handle other failures.
  routes.onError((error, c) => {
    if (error instanceof WorkspaceRoleError) {
      return c.json({ error: error.message, code: `workspace_role_${error.status}`, error_layer: error.error_layer }, error.status);
    }
    throw error;
  });
  routes.get("/:id/roles", async (c) => c.json({ data: await service.listRoles(scopeFor(c)) }));
  routes.post("/:id/roles", async (c) => {
    const scope = scopeFor(c);
    return c.json({ data: await service.createRole(scope, await bodyFor(c)) }, 201);
  });
  routes.patch("/:id/roles/:roleId", async (c) => {
    const scope = scopeFor(c);
    return c.json({ data: await service.updateRole(scope, parseId(c.req.param("roleId")), await bodyFor(c)) });
  });
  routes.delete("/:id/roles/:roleId", async (c) =>
    c.json({ data: await service.deleteRole(scopeFor(c), parseId(c.req.param("roleId"))) }));
  routes.patch("/:id/members/:userId/role", async (c) => {
    const scope = scopeFor(c);
    return c.json({ data: await service.assignMemberRole(scope, parseId(c.req.param("userId")), await bodyFor(c)) });
  });
  return routes;
}
export const workspaceRolesRoutes = createWorkspaceRolesRoutes();
