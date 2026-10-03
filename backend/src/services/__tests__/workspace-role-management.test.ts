import { describe, expect, test } from "bun:test";
import type { Prisma } from "@prisma/client";
import { createWorkspaceRoleManagement, normalizeRolePermissions,
  type WorkspaceRoleDependencies } from "../workspace-role-management.ts";

const scope = { workspaceId: 10, actorId: 1, ip: "127.0.0.1" };
const date = new Date("2026-10-01T00:00:00Z");
type Role = { id: number; workspace_id: number; name: string; description: string | null;
  permissions: unknown; created_by_id: number; created_at: Date; updated_at: Date };
type Member = { id: number; workspace_id: number; user_id: number; role: "owner" | "admin" | "member" | "viewer";
  role_id: number | null; active: boolean; workspace: { kind: "team" } };
function fixture(actorRole: Member["role"] = "owner") {
  const roles: Role[] = [];
  const members: Member[] = [
    { id: 1, workspace_id: 10, user_id: 1, role: actorRole, role_id: null, active: true, workspace: { kind: "team" } },
    { id: 2, workspace_id: 10, user_id: 2, role: "viewer", role_id: null, active: true, workspace: { kind: "team" } },
  ];
  const events: unknown[] = [];
  const calls: string[] = [];
  function addRole(permissions: unknown, workspace_id = 10): Role {
    const role = { id: roles.length + 1, workspace_id, name: `role-${roles.length + 1}`,
      description: null, permissions, created_by_id: 1, created_at: date, updated_at: date };
    roles.push(role); return role;
  }
  const can: WorkspaceRoleDependencies["can"] = (access, action, resource, creator = false) => {
    if (access.role === "owner") return true;
    if (access.customRoleId !== null) {
      try { return normalizeRolePermissions(access.customPermissions)[`${resource}:${action}` as keyof ReturnType<typeof normalizeRolePermissions>] === true; }
      catch { return false; }
    }
    if (access.role === "admin") return true;
    if (action === "read") return true;
    return access.role === "member" && resource === "forward"
      && (action === "create" || (creator && (action === "update" || action === "delete")));
  };
  const fake = {
    $queryRaw: async () => { calls.push("lock"); return [{ id: 10 }]; },
    workspaceMember: {
      findUnique: async ({ where }: any) => {
        calls.push("membership");
        const key = where.workspace_id_user_id;
        const member = members.find((m) => m.workspace_id === key.workspace_id && m.user_id === key.user_id);
        return member ? { ...member, custom_role: roles.find((r) => r.id === member.role_id) ?? null } : null;
      },
      count: async ({ where }: any) => members.filter((m) => m.role_id === where.role_id && (where.role === undefined || m.role === where.role)).length,
      update: async ({ where, data }: any) => { calls.push("member.update"); const m = members.find((m) => m.id === where.id)!; Object.assign(m, data); return { ...m }; },
    },
    workspaceCustomRole: {
      findMany: async ({ where }: any) => roles.filter((r) => r.workspace_id === where.workspace_id),
      findFirst: async ({ where }: any) => roles.find((r) => r.id === where.id && r.workspace_id === where.workspace_id) ?? null,
      create: async ({ data }: any) => { calls.push("role.create"); const role = addRole(data.permissions, data.workspace_id); Object.assign(role, data); return role; },
      update: async ({ where, data }: any) => { calls.push("role.update"); const role = roles.find((r) => r.id === where.id)!; Object.assign(role, data); return role; },
      delete: async ({ where }: any) => { calls.push("role.delete"); const index = roles.findIndex((r) => r.id === where.id); return roles.splice(index, 1)[0]; },
    },
    auditEvent: { create: async ({ data }: any) => { events.push(data); return data; } },
  };
  let beforeTransaction: (() => void) | undefined;
  const service = createWorkspaceRoleManagement({ can, transaction: async (work) => {
    beforeTransaction?.();
    return work(fake as unknown as Prisma.TransactionClient);
  } });
  return { service, roles, members, events, calls, addRole,
    beforeTransaction: (callback: () => void) => { beforeTransaction = callback; } };
}
async function rejectsStatus(operation: () => unknown, status: number) {
  try { await operation(); throw new Error("expected rejection"); }
  catch (error) { expect((error as { status?: number }).status).toBe(status); }
}

describe("WP10 strict canonical permission maps", () => {
  test("legacy aliases normalize and explicit canonical false wins", () => {
    expect(normalizeRolePermissions({ "tunnel:read": true, "forward:read": false, "tunnel:create": true }))
      .toEqual({ "forward:read": false, "forward:create": true });
  });
  test("unknown keys, non-boolean values, arrays and null reject", () => {
    for (const input of [{ "forward:manage": true }, { "node:manage": 1 }, { "member:read": "true" }, [], null,
      { "forward:read": false, "tunnel:read": "true" }]) {
      expect(() => normalizeRolePermissions(input)).toThrow();
    }
  });
});
describe("WP10 role management transaction and authorization", () => {
  test("owner CRUD keeps canonical false and scoped audit metadata", async () => {
    const f = fixture();
    const role = await f.service.createRole(scope, { name: "  Ops  ", permissions: { "tunnel:read": true, "forward:read": false, "node:read": true } });
    expect(role.name).toBe("Ops");
    expect(role.permissions).toEqual({ "forward:read": false, "node:read": true });
    expect(f.calls.slice(0, 2)).toEqual(["lock", "membership"]);
    expect((await f.service.listRoles(scope)).length).toBe(1);
    await f.service.updateRole(scope, role.id, { description: "Safe" });
    expect(await f.service.deleteRole(scope, role.id)).toEqual({ ok: true });
    expect(f.events).toEqual([
      { workspace_id: 10, actor_user_id: 1, action: "role.created", resource_type: "workspace_custom_role", resource_id: "1", ip: "127.0.0.1" },
      { workspace_id: 10, actor_user_id: 1, action: "role.updated", resource_type: "workspace_custom_role", resource_id: "1", ip: "127.0.0.1" },
      { workspace_id: 10, actor_user_id: 1, action: "role.deleted", resource_type: "workspace_custom_role", resource_id: "1", ip: "127.0.0.1" },
    ]);
  });
  test("member/viewer read roles but cannot write", async () => {
    for (const role of ["member", "viewer"] as const) {
      const f = fixture(role); expect(await f.service.listRoles(scope)).toEqual([]);
      await rejectsStatus(() => f.service.createRole(scope, { name: "Ops", permissions: {} }), 403);
      expect(f.calls).not.toContain("role.create");
    }
  });
  test("custom replacement denies base-admin fallback and member:manage does not imply member:read", async () => {
    const f = fixture("admin");
    f.members[0]!.role_id = f.addRole({ "member:manage": true }).id;
    await rejectsStatus(() => f.service.listRoles(scope), 403);
    await f.service.createRole(scope, { name: "Delegated", permissions: { "member:manage": true } });
    await rejectsStatus(() => f.service.createRole(scope, { name: "Escalate", permissions: { "node:manage": true } }), 403);
  });
  test("role edits/deletion cannot affect a role containing rights outside actor's effective set", async () => {
    const f = fixture("admin"); f.members[0]!.role_id = f.addRole({ "member:manage": true }).id;
    const high = f.addRole({ "forward:delete": true });
    await rejectsStatus(() => f.service.updateRole(scope, high.id, { name: "Renamed" }), 403);
    await rejectsStatus(() => f.service.updateRole(scope, high.id, { permissions: {} }), 403);
    await rejectsStatus(() => f.service.deleteRole(scope, high.id), 403);
    expect(f.calls).not.toContain("role.update"); expect(f.calls).not.toContain("role.delete");
  });
  test("metadata edits also canonicalize legacy false-precedence permissions", async () => {
    const f = fixture(); const role = f.addRole({ "tunnel:read": true, "forward:read": false, "tunnel:create": true });
    const updated = await f.service.updateRole(scope, role.id, { name: "Canonical" });
    expect(updated.permissions).toEqual({ "forward:read": false, "forward:create": true });
    expect(role.permissions).toEqual(updated.permissions);
  });
  test("actor permissions and target owner status are reloaded inside the transaction", async () => {
    const f = fixture("admin"); const role = f.addRole({ "member:manage": true });
    f.members[0]!.role_id = role.id;
    f.beforeTransaction(() => { role.permissions = {}; });
    await rejectsStatus(() => f.service.createRole(scope, { name: "Ops", permissions: {} }), 403);
    const owner = fixture();
    owner.beforeTransaction(() => { owner.members[1]!.role = "owner"; });
    await rejectsStatus(() => owner.service.assignMemberRole(scope, 2, { role: "viewer" }), 403);
    expect(owner.calls).not.toContain("member.update");
  });
  test("delegated role manager can assign only custom roles within its grant set", async () => {
    const f = fixture("viewer"); const manager = f.addRole({ "member:manage": true, "forward:read": true });
    f.members[0]!.role_id = manager.id;
    const low = f.addRole({ "tunnel:read": true });
    expect((await f.service.assignMemberRole(scope, 2, { role_id: low.id })).role_id).toBe(low.id);
    const high = f.addRole({ "forward:create": true });
    await rejectsStatus(() => f.service.assignMemberRole(scope, 2, { role_id: high.id }), 403);
    expect(f.members[1]!.role_id).toBe(low.id);
  });
  test("new permissions are subset checked even on metadata-safe existing role", async () => {
    const f = fixture("admin"); f.members[0]!.role_id = f.addRole({ "member:manage": true }).id;
    const low = f.addRole({});
    await rejectsStatus(() => f.service.updateRole(scope, low.id, { permissions: { "forward:create": true } }), 403);
  });
  test("cross-workspace role reads by ID return 404", async () => {
    const f = fixture(); const foreign = f.addRole({}, 20);
    await rejectsStatus(() => f.service.updateRole(scope, foreign.id, { name: "X" }), 404);
    await rejectsStatus(() => f.service.deleteRole(scope, foreign.id), 404);
    await rejectsStatus(() => f.service.assignMemberRole(scope, 2, { role_id: foreign.id }), 404);
    expect(await f.service.listRoles(scope)).toEqual([]);
  });
  test("revocation at transaction entry rejects without writes", async () => {
    const f = fixture(); f.beforeTransaction(() => { f.members[0]!.active = false; });
    await rejectsStatus(() => f.service.createRole(scope, { name: "Ops", permissions: {} }), 404);
    expect(f.roles).toHaveLength(0); expect(f.events).toHaveLength(0);
  });
  test("suspended, missing and cross-workspace custom references fail closed", async () => {
    for (const mode of ["missing", "foreign", "corrupt"] as const) {
      const f = fixture("admin");
      f.members[0]!.role_id = mode === "missing" ? 999 : f.addRole(mode === "corrupt" ? [] : { "member:manage": true }, mode === "foreign" ? 20 : 10).id;
      await rejectsStatus(() => f.service.createRole(scope, { name: "Ops", permissions: {} }), 403);
    }
  });
  test("role deletion rejects both active and inactive bindings", async () => {
    for (const active of [true, false]) {
      const f = fixture(); const role = f.addRole({ "forward:read": true });
      f.members[1]!.role_id = role.id; f.members[1]!.active = active;
      await rejectsStatus(() => f.service.deleteRole(scope, role.id), 409);
      expect(f.members[1]!.role_id).toBe(role.id); expect(f.calls).not.toContain("role.delete");
    }
  });
  test("owner cannot be demoted, custom-bound, or have referenced custom role edited", async () => {
    const f = fixture(); const role = f.addRole({ "member:read": true });
    for (const assignment of [{ role: "viewer" }, { role_id: role.id }, { role_id: null }]) {
      await rejectsStatus(() => f.service.assignMemberRole(scope, 1, assignment), 403);
    }
    f.members[0]!.role_id = role.id;
    await rejectsStatus(() => f.service.updateRole(scope, role.id, { name: "Owner's role" }), 403);
  });
  test("base admin assignment and clearing custom role cannot restore rights actor lacks", async () => {
    const f = fixture("admin"); const delegated = f.addRole({ "member:manage": true });
    f.members[0]!.role_id = delegated.id;
    await rejectsStatus(() => f.service.assignMemberRole(scope, 2, { role: "admin" }), 403);
    f.members[1]!.role = "admin"; f.members[1]!.role_id = delegated.id;
    await rejectsStatus(() => f.service.assignMemberRole(scope, 2, { role_id: null }), 403);
    expect(f.members[1]!.role_id).toBe(delegated.id); expect(f.calls).not.toContain("member.update");
  });
  test("member base role includes creator edit/delete in the subset check", async () => {
    const f = fixture("admin"); f.members[0]!.role_id = f.addRole({ "member:manage": true,
      "forward:read": true, "forward:create": true, "node:read": true, "member:read": true,
      "settings:read": true, "audit:read": true }).id;
    await rejectsStatus(() => f.service.assignMemberRole(scope, 2, { role: "member" }), 403);
  });
  test("owner assigns custom/base roles while preserving target active state", async () => {
    const f = fixture(); const role = f.addRole({ "forward:read": true }); f.members[1]!.active = false;
    const bound = await f.service.assignMemberRole(scope, 2, { role_id: role.id });
    expect(bound.role_id).toBe(role.id); expect(bound.active).toBe(false);
    const base = await f.service.assignMemberRole(scope, 2, { role: "admin" });
    expect(base.role).toBe("admin"); expect(base.role_id).toBeNull(); expect(base.active).toBe(false);
  });
  test("nonexistent targets and malformed payloads reject", async () => {
    const f = fixture();
    await rejectsStatus(() => f.service.assignMemberRole(scope, 99, { role: "viewer" }), 404);
    for (const input of [{ role: "owner" }, { role_id: "1" }, { role_id: 0 }, { role_id: null, role: "admin" }, {}]) {
      await rejectsStatus(() => f.service.assignMemberRole(scope, 2, input), 400);
    }
    for (const input of [{ name: "X", permissions: { nope: true } }, { name: "X", permissions: { "forward:read": "true" } },
      { name: "", permissions: {} }, { name: "X", permissions: {}, token: "never-store" }]) {
      await rejectsStatus(() => f.service.createRole(scope, input), 400);
    }
    expect(f.events).toHaveLength(0);
  });
  test("duplicate role names translate database conflict to 409", async () => {
    const service = createWorkspaceRoleManagement({ transaction: async () => { throw { code: "P2002" }; } });
    await rejectsStatus(() => service.createRole(scope, { name: "Existing", permissions: {} }), 409);
  });
});
