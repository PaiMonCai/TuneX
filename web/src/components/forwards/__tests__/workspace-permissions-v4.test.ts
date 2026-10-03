import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { canMutateForward, createPermissionRequestFence, hasWorkspacePermission, shouldRedirectToLogin, validPermissionProjection, WORKSPACE_PERMISSION_KEYS } from "@/lib/workspace-permissions";
import type { EffectiveWorkspacePermissions } from "@/lib/workspace-permissions";
import { mockBasePermissions } from "@/mocks/workspace-permissions";
import { handleMock } from "@/mocks/handler";
import { resetStore, getStore } from "@/mocks/state";

const projection = (extra: Partial<EffectiveWorkspacePermissions> = {}): EffectiveWorkspacePermissions => ({
  workspace_id: 1, actor_id: 3, role: "member", custom_role_id: null,
  permissions: mockBasePermissions("member"), forward_mutations: "own", ...extra,
});
const call = (method: string, path: string, body?: unknown, actor = 1, workspaceId?: number) =>
  handleMock(method, path, { body, cookie: `tunex_session=u${actor}`, workspaceId });
const teamId = () => getStore().workspaces.find((w) => w.kind === "team")!.id;
beforeEach(() => resetStore());

describe("effective permission pure helpers (UX, not server authorization)", () => {
  test("missing projections and nonboolean grant values deny", () => {
    expect(hasWorkspacePermission(null, "forward:update")).toBe(false);
    expect(hasWorkspacePermission(projection({ permissions: { "forward:update": "true" } as never }), "forward:update")).toBe(false);
    expect(hasWorkspacePermission(projection(), "node:manage")).toBe(false);
  });
  test("role name cannot restore explicitly denied custom permissions", () => {
    const value = projection({ role: "admin", custom_role_id: 1, permissions: {} as never });
    expect(hasWorkspacePermission(value, "member:manage")).toBe(false);
    expect(canMutateForward(value, { creator_user_id: 3 }, "update")).toBe(false);
  });
  test("own update/delete require exact numeric creator identity", () => {
    for (const action of ["update", "delete"] as const) {
      expect(canMutateForward(projection(), { creator_user_id: 3 }, action)).toBe(true);
      for (const creator_user_id of [null, undefined, 2, "3"]) {
        expect(canMutateForward(projection(), { creator_user_id } as never, action)).toBe(false);
      }
    }
  });
  test("workspace scope does not require creator but still requires action grant", () => {
    const value = projection({ forward_mutations: "workspace" });
    expect(canMutateForward(value, {}, "update")).toBe(true);
    expect(canMutateForward({ ...value, permissions: { ...value.permissions, "forward:delete": false } }, {}, "delete")).toBe(false);
  });
  test("unknown mutation scope is fail closed", () => {
    expect(canMutateForward(projection({ forward_mutations: "unknown" as never }), { creator_user_id: 3 }, "update")).toBe(false);
  });
  test("wrong actor, workspace, null or malformed projection is rejected", () => {
    expect(validPermissionProjection(projection(), 1, 3)).toBe(true);
    expect(validPermissionProjection(projection(), 2, 3)).toBe(false);
    expect(validPermissionProjection(projection(), 1, 4)).toBe(false);
    expect(validPermissionProjection(null, 1, 3)).toBe(false);
    expect(validPermissionProjection(projection({ forward_mutations: "invalid" as never }), 1, 3)).toBe(false);
  });
  test("rapid switch and refresh reject late permission results", () => {
    const fence = createPermissionRequestFence();
    const first = fence.next(); const second = fence.next();
    expect(fence.current(first)).toBe(false); expect(fence.current(second)).toBe(true);
    const refreshed = fence.next(); expect(fence.current(second)).toBe(false); expect(fence.current(refreshed)).toBe(true);
  });
  test("403 authorization is not a login redirect; only 401 is", () => {
    expect(shouldRedirectToLogin(401)).toBe(true);
    for (const status of [200, 400, 403, 404, 409, 500]) expect(shouldRedirectToLogin(status)).toBe(false);
  });
});

describe("mock permissions and role APIs (contract fixture only)", () => {
  test("member owns mutations but not node/member management", async () => {
    const result = await call("GET", `/workspaces/${teamId()}/permissions`, undefined, 3);
    const value = result.body as EffectiveWorkspacePermissions;
    expect(result.status).toBe(200); expect(value.actor_id).toBe(3); expect(value.forward_mutations).toBe("own");
    expect(Object.keys(value.permissions)).toEqual([...WORKSPACE_PERMISSION_KEYS]);
    expect(value.permissions["forward:update"]).toBe(true); expect(value.permissions["member:manage"]).toBe(false);
  });
  test("role create/list/update/delete uses boolean maps and persists explicit false", async () => {
    const id = teamId();
    const created = await call("POST", `/workspaces/${id}/roles`, { name: "observer", description: "test", permissions: { "forward:read": true, "node:read": false } });
    expect(created.status).toBe(201); const role = created.body as { id: number };
    const rows = await call("GET", `/workspaces/${id}/roles`); expect((rows.body as unknown[]).length).toBe(1);
    const updated = await call("PATCH", `/workspaces/${id}/roles/${role.id}`, { name: "observer2", permissions: { "forward:read": false } });
    expect(updated.status).toBe(200); expect((updated.body as { permissions: unknown }).permissions).toEqual({ "forward:read": false });
    expect((await call("DELETE", `/workspaces/${id}/roles/${role.id}`)).status).toBe(200);
  });
  test("custom assignment replaces admin base permissions and supports clearing", async () => {
    const id = teamId(); const created = await call("POST", `/workspaces/${id}/roles`, { name: "forward-reader", permissions: { "forward:read": true } });
    const roleId = (created.body as { id: number }).id;
    expect((await call("PATCH", `/workspaces/${id}/members/2/role`, { role_id: roleId })).status).toBe(200);
    const effective = (await call("GET", `/workspaces/${id}/permissions`, undefined, 2)).body as EffectiveWorkspacePermissions;
    expect(effective.role).toBe("admin"); expect(effective.permissions["forward:read"]).toBe(true);
    expect(effective.permissions["node:read"]).toBe(false); expect(effective.permissions["member:manage"]).toBe(false);
    expect((await call("GET", "/nodes", undefined, 2, id)).status).toBe(403);
    expect((await call("GET", "/forwards", undefined, 2, id)).status).toBe(200);
    expect((await call("PATCH", `/workspaces/${id}/members/2/role`, { role_id: null })).status).toBe(200);
    const cleared = (await call("GET", `/workspaces/${id}/permissions`, undefined, 2)).body as EffectiveWorkspacePermissions;
    expect(cleared.custom_role_id).toBeNull(); expect(cleared.permissions["member:manage"]).toBe(true);
  });
  test("bound role cannot be deleted, and owner cannot be reassigned", async () => {
    const id = teamId(); const created = await call("POST", `/workspaces/${id}/roles`, { name: "reader", permissions: {} }); const roleId = (created.body as { id: number }).id;
    await call("PATCH", `/workspaces/${id}/members/2/role`, { role_id: roleId });
    expect((await call("DELETE", `/workspaces/${id}/roles/${roleId}`)).status).toBe(409);
    expect((await call("PATCH", `/workspaces/${id}/members/1/role`, { role: "viewer" })).status).toBe(403);
  });
  test("assignment rejects both payload forms together and foreign role IDs", async () => {
    const id = teamId();
    expect((await call("PATCH", `/workspaces/${id}/members/2/role`, { role: "member", role_id: null })).status).toBe(400);
    expect((await call("PATCH", `/workspaces/${id}/members/2/role`, { role_id: 999 })).status).toBe(404);
    expect((await call("GET", `/workspaces/${id}/permissions`, undefined, 1, 1)).status).toBe(404);
  });
  test("limited manager cannot grant outside its subset or clear into broad admin", async () => {
    const id = teamId(); const role = await call("POST", `/workspaces/${id}/roles`, { name: "manager", permissions: { "member:read": true, "member:manage": true } });
    await call("PATCH", `/workspaces/${id}/members/2/role`, { role_id: (role.body as { id: number }).id });
    expect((await call("POST", `/workspaces/${id}/roles`, { name: "escalation", permissions: { "node:manage": true } }, 2)).status).toBe(403);
    expect((await call("PATCH", `/workspaces/${id}/members/2/role`, { role_id: null }, 2)).status).toBe(403);
  });
  test("dangling or foreign custom references do not restore admin grants", async () => {
    const member = getStore().workspaceMembers.find((m) => m.user_id === 2 && m.workspace_id === teamId())!;
    member.role_id = 999;
    const value = (await call("GET", `/workspaces/${teamId()}/permissions`, undefined, 2)).body as EffectiveWorkspacePermissions;
    expect(Object.values(value.permissions).every((v) => v === false)).toBe(true);
  });
  test("Forward projection carries creator proof", async () => {
    const value = await call("GET", "/forwards");
    expect((value.body as { creator_user_id: unknown }[]).every((row) => typeof row.creator_user_id === "number")).toBe(true);
  });
});

describe("critical UI wiring", () => {
  const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
  test("provider fetches effective projection and invalidates switch/refresh privileges", () => {
    const text = source("workspace/workspace-context.tsx");
    expect(text).toContain("api.workspaces.permissions(currentId)"); expect(text).toContain("validPermissionProjection");
    expect(text).toContain('hasWorkspacePermission(permissions, "member:manage")');
    expect(text).not.toContain('current?.role === "owner"'); expect(text).toContain("permissionFence.current.next()"); expect(text).toContain("setProjection(null)");
  });
  test("list owns per-resource guards, separate node read and independent partial loads", () => {
    const text = source("forwards/forward-workspace.tsx");
    expect(text).toContain('canForward(forward, "update")'); expect(text).toContain('canForward(forward, "delete")');
    expect(text).toContain('can("forward:create")'); expect(text).toContain('can("node:read")'); expect(text).toContain('can("node:manage")');
    expect(text).toContain("summaryTask"); expect(text).toContain("nodesTask"); expect(text).toContain("setSelectedIds(new Set())");
  });
  test("detail/edit/Node controls recheck authorization", () => {
    expect(source("forwards/forward-detail.tsx")).toContain('canForward(forward, "delete")');
    expect(source("forwards/forward-edit-dialog.tsx")).toContain('canForward(forward, "update")');
    expect(source("nodes/node-workspace.tsx")).toContain("if (!canManage)");
    expect(source("workspace/workspace-members.tsx")).toContain("api.workspaces.assignRole");
    expect(source("workspace/workspace-roles.tsx")).toContain("api.workspaces.createRole");
  });
});
