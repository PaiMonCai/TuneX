import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppVariables } from "../../middlewares/auth.ts";
import type { WorkspaceAccess } from "../../services/workspace.ts";
import { createWorkspaceRolesRoutes } from "../workspace-roles.ts";
import { WorkspaceRoleError, type WorkspaceRoleManagement, type RoleManagementScope } from "../../services/workspace-role-management.ts";

function fixture(options: { authenticated?: boolean; context?: WorkspaceAccess; error?: WorkspaceRoleError } = {}) {
  const calls: { method: string; scope: RoleManagementScope; id?: number; input?: unknown }[] = [];
  function call(method: string, scope: RoleManagementScope, id?: number, input?: unknown) {
    calls.push({ method, scope, id, input });
    if (options.error) throw options.error;
  }
  const role = { id: 3, workspace_id: 10, name: "Ops", description: null, permissions: { "forward:read": true },
    created_by_id: 1, created_at: new Date(), updated_at: new Date() };
  const service: WorkspaceRoleManagement = {
    listRoles: async (scope) => { call("list", scope); return [role]; },
    createRole: async (scope, input) => { call("create", scope, undefined, input); return role; },
    updateRole: async (scope, id, input) => { call("update", scope, id, input); return role; },
    deleteRole: async (scope, id) => { call("delete", scope, id); return { ok: true }; },
    assignMemberRole: async (scope, id, input) => { call("assign", scope, id, input); return { user_id: id, workspace_id: 10,
      role: "viewer", role_id: 3, active: true }; },
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    if (options.authenticated !== false) c.set("user", { id: 1 } as NonNullable<AppVariables["user"]>);
    c.set("ip", "127.0.0.1");
    if (options.context) c.set("workspace", options.context);
    await next();
  });
  app.route("/api/workspaces", createWorkspaceRolesRoutes(service));
  const request = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => app.request(
    `/api/workspaces${path}`, { method, headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
  return { app, calls, request };
}
describe("WP10 isolated workspace roles Hono API", () => {
  test("all five endpoints delegate exact path scope and JSON body", async () => {
    const f = fixture();
    expect((await f.request("/10/roles")).status).toBe(200);
    expect((await f.request("/10/roles", "POST", { name: "Ops", permissions: {} })).status).toBe(201);
    expect((await f.request("/10/roles/3", "PATCH", { name: "Renamed" })).status).toBe(200);
    expect((await f.request("/10/roles/3", "DELETE")).status).toBe(200);
    expect((await f.request("/10/members/2/role", "PATCH", { role_id: null })).status).toBe(200);
    expect(f.calls.map((c) => c.method)).toEqual(["list", "create", "update", "delete", "assign"]);
    for (const call of f.calls) expect(call.scope).toEqual({ workspaceId: 10, actorId: 1, ip: "127.0.0.1" });
    expect(f.calls[4]!.input).toEqual({ role_id: null });
  });
  test("Bearer is denied even when user/session context exists, before invoking service", async () => {
    const f = fixture();
    for (const authorization of ["Bearer api-key", "bearer api-key", "  BeArEr api-key", "Bearer"]) {
      const response = await f.request("/10/roles", "GET", undefined, { authorization });
      expect(response.status).toBe(403);
      expect((await response.json() as { error_layer: string }).error_layer).toBe("authentication");
    }
    expect(f.calls).toHaveLength(0);
  });
  test("missing authenticated user gives 401", async () => {
    const f = fixture({ authenticated: false }); const response = await f.request("/10/roles");
    expect(response.status).toBe(401); expect(f.calls).toHaveLength(0);
  });
  test("header cannot authorize a different workspace path", async () => {
    const f = fixture(); const response = await f.request("/20/roles", "GET", undefined, { "x-workspace-id": "10" });
    expect(response.status).toBe(404); expect((await response.json() as { error_layer: string }).error_layer).toBe("resource_scope");
    expect(f.calls).toHaveLength(0);
    expect((await f.request("/10/roles", "GET", undefined, { "x-workspace-id": "10" })).status).toBe(200);
  });
  test("path must agree with upstream context and its actor", async () => {
    const base: WorkspaceAccess = { id: 10, personalWorkspaceId: 1, kind: "team", role: "owner", customRoleId: null, actorId: 1 };
    for (const context of [{ ...base, id: 20 }, { ...base, actorId: 2 }]) {
      const f = fixture({ context }); expect((await f.request("/10/roles")).status).toBe(404); expect(f.calls).toHaveLength(0);
    }
  });
  test("invalid path IDs and header IDs fail with 400, no DB service invocation", async () => {
    const f = fixture();
    for (const path of ["/0/roles", "/1e1/roles", "/NaN/roles", "/9007199254740992/roles", "/10/roles/0"]) {
      expect((await f.request(path, path.endsWith("/0") ? "DELETE" : "GET")).status).toBe(400);
    }
    expect((await f.request("/10/roles", "GET", undefined, { "x-workspace-id": "nope" })).status).toBe(400);
    expect(f.calls).toHaveLength(0);
  });
  test("malformed JSON rejects before invoking mutation service", async () => {
    const f = fixture(); const response = await f.app.request("/api/workspaces/10/roles", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect(response.status).toBe(400); expect(f.calls).toHaveLength(0);
  });
  test("domain errors retain precise status and layer in parent-mounted responses", async () => {
    for (const [status, layer] of [[403, "rbac"], [404, "resource_scope"], [409, "rbac"]] as const) {
      const f = fixture({ error: new WorkspaceRoleError(status, "Denied", layer) });
      const response = await f.request("/10/roles");
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: "Denied", code: `workspace_role_${status}`, error_layer: layer });
    }
  });
});
