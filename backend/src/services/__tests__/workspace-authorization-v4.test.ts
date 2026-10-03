/** WP10 isolated kernel + workspace access tests: no DB, Redis, or mock.module. */
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppVariables } from "../../middlewares/auth.ts";
import {
  WORKSPACE_PERMISSIONS,
  customRoleGrants,
  isEmptyCustomPermissions,
  isValidCustomPermissions,
  parseCustomPermissions,
  permissionList,
  sanitizeCustomPermissions,
} from "../workspace-permissions.ts";
import {
  actionFromCustomRole,
  canWorkspaceAction,
  canWorkspaceResourceAction,
  resolveWorkspaceAccess,
  workspacePermissionDenied,
  type WorkspaceAccess,
  type WorkspaceAccessDb,
  type WorkspaceAction,
  type WorkspaceResourceFamily,
  type WorkspaceRole,
} from "../workspace.ts";

function access(role: WorkspaceRole, patch: Partial<WorkspaceAccess> = {}): WorkspaceAccess {
  return { id: 20, role, personalWorkspaceId: 10, kind: "team", customRoleId: null, ...patch };
}

const matrix: [WorkspaceResourceFamily, WorkspaceAction, WorkspaceRole[]][] = [
  ["forward", "read", ["owner", "admin", "member", "viewer"]],
  ["forward", "create", ["owner", "admin", "member"]],
  ["forward", "update", ["owner", "admin"]],
  ["forward", "delete", ["owner", "admin"]],
  ["node", "read", ["owner", "admin", "member", "viewer"]],
  ["node", "manage", ["owner", "admin"]],
  ["member", "read", ["owner", "admin", "member", "viewer"]],
  ["member", "manage", ["owner", "admin"]],
  ["settings", "read", ["owner", "admin", "member", "viewer"]],
  ["settings", "manage", ["owner", "admin"]],
  ["audit", "read", ["owner", "admin", "member", "viewer"]],
];

describe("fixed resource-aware RBAC matrix", () => {
  for (const role of ["owner", "admin", "member", "viewer"] as const) {
    test(`${role}: independent resource/action matrix`, () => {
      for (const [resource, action, allowed] of matrix) {
        expect(canWorkspaceResourceAction(access(role), action, resource)).toBe(allowed.includes(role));
        if (resource === "forward") {
          expect(canWorkspaceResourceAction(access(role), action, "tunnel")).toBe(allowed.includes(role));
        }
      }
    });
  }

  test("member Forward mutations require explicit creator proof, including legacy aliases", () => {
    for (const resource of ["forward", "tunnel"] as const) {
      for (const action of ["update", "delete"] as const) {
        expect(canWorkspaceResourceAction(access("member"), action, resource, true)).toBe(true);
        expect(canWorkspaceResourceAction(access("member"), action, resource, false)).toBe(false);
        expect(canWorkspaceResourceAction(access("member"), action, resource)).toBe(false);
        expect(canWorkspaceResourceAction(access("viewer"), action, resource, true)).toBe(false);
        expect(canWorkspaceResourceAction(access("member"), action, resource, 1 as unknown as boolean)).toBe(false);
      }
    }
    expect(canWorkspaceResourceAction(access("member"), "manage", "node", true)).toBe(false);
    expect(canWorkspaceResourceAction(access("member"), "manage", "member", true)).toBe(false);
  });

  test("unknown identities/resources/actions and unsupported combinations deny even owner", () => {
    expect(canWorkspaceResourceAction(access("invalid" as WorkspaceRole), "read", "forward")).toBe(false);
    const invalid: [WorkspaceResourceFamily, WorkspaceAction][] = [
      ["audit", "manage"], ["audit", "create"], ["audit", "update"], ["audit", "delete"],
      ["node", "create"], ["node", "update"], ["member", "delete"], ["settings", "create"],
      ["forward", "manage"], ["tunnel", "manage"],
      ["unknown" as WorkspaceResourceFamily, "read"], ["forward", "unknown" as WorkspaceAction],
    ];
    for (const [resource, action] of invalid) {
      expect(canWorkspaceResourceAction(access("owner"), action, resource, true)).toBe(false);
      expect(actionFromCustomRole({ "audit:read": true, "node:manage": true }, action, resource)).toBe(false);
    }
  });

  test("legacy coarse helper stays compatible but is not the Node management kernel", () => {
    expect(canWorkspaceAction("member", "create")).toBe(true);
    expect(canWorkspaceAction("member", "update", true)).toBe(true);
    expect(canWorkspaceAction("member", "update")).toBe(false);
    expect(canWorkspaceAction("viewer", "read")).toBe(true);
    expect(canWorkspaceAction("viewer", "create")).toBe(false);
    expect(canWorkspaceAction("admin", "manage")).toBe(true);
    expect(canWorkspaceAction("unknown" as WorkspaceRole, "read")).toBe(false);
    expect(canWorkspaceAction("owner", "unknown" as WorkspaceAction)).toBe(false);
  });
});

describe("custom replacement and canonical legacy alias rules", () => {
  test("canonical keys and permission list output never write legacy aliases", () => {
    expect(WORKSPACE_PERMISSIONS).toHaveLength(11);
    expect(WORKSPACE_PERMISSIONS.every((key) => !key.startsWith("tunnel:"))).toBe(true);
    expect(sanitizeCustomPermissions({ "tunnel:create": true, "tunnel:delete": false, "node:read": true }))
      .toEqual({ "forward:create": true, "forward:delete": false, "node:read": true });
    expect(permissionList({ "tunnel:create": true, "forward:delete": false, "node:read": true }))
      .toEqual(["forward:create", "node:read"]);
  });

  test("canonical false outranks legacy true before and after write/read normalization", () => {
    for (const action of ["read", "create", "update", "delete"] as const) {
      const input = { [`forward:${action}`]: false, [`tunnel:${action}`]: true };
      const normalized = sanitizeCustomPermissions(input);
      expect(normalized).toEqual({ [`forward:${action}`]: false });
      for (const map of [input, normalized, JSON.parse(JSON.stringify(normalized))]) {
        expect(customRoleGrants(map, `forward:${action}`)).toBe(false);
        expect(customRoleGrants(map, `tunnel:${action}`)).toBe(false);
        expect(canWorkspaceResourceAction(access("admin", { customRoleId: 8, customPermissions: map }), action, "forward", true)).toBe(false);
      }
    }
  });

  test("canonical true outranks legacy false and absent canonical reads legacy", () => {
    for (const action of ["read", "create", "update", "delete"] as const) {
      expect(customRoleGrants({ [`forward:${action}`]: true, [`tunnel:${action}`]: false }, `forward:${action}`)).toBe(true);
      expect(customRoleGrants({ [`tunnel:${action}`]: true }, `forward:${action}`)).toBe(true);
      expect(customRoleGrants({ [`tunnel:${action}`]: true }, `tunnel:${action}`)).toBe(true);
    }
  });

  test("bound admin/member/viewer use only their custom grants, including creator", () => {
    for (const role of ["admin", "member", "viewer"] as const) {
      const bound = access(role, { customRoleId: 8, customPermissions: { "forward:delete": true } });
      expect(canWorkspaceResourceAction(bound, "delete", "forward")).toBe(true);
      expect(canWorkspaceResourceAction(bound, "delete", "tunnel")).toBe(true);
      expect(canWorkspaceResourceAction(bound, "read", "forward")).toBe(false);
      expect(canWorkspaceResourceAction(bound, "create", "forward")).toBe(false);
      expect(canWorkspaceResourceAction(bound, "update", "forward", true)).toBe(false);
      expect(canWorkspaceResourceAction(bound, "manage", "node")).toBe(false);
      expect(canWorkspaceResourceAction(bound, "read", "member")).toBe(false);
    }
  });

  test("resource keys remain independent; management never implies read", () => {
    const bound = access("viewer", { customRoleId: 8, customPermissions: { "node:manage": true, "audit:read": true } });
    expect(canWorkspaceResourceAction(bound, "manage", "node")).toBe(true);
    expect(canWorkspaceResourceAction(bound, "read", "node")).toBe(false);
    expect(canWorkspaceResourceAction(bound, "manage", "member")).toBe(false);
    expect(canWorkspaceResourceAction(bound, "read", "audit")).toBe(true);
    expect(canWorkspaceResourceAction(bound, "manage", "audit")).toBe(false);
  });

  test("bound missing/empty/malformed custom maps never restore base permissions", () => {
    const malformed = [undefined, null, [], "true", 1, true,
      { "forward:read": "true" }, { "forward:read": 1 },
      { "forward:read": true, "node:manage": null },
      { "forward:read": true, "unknown:read": false },
      Object.assign(Object.create({ "node:manage": true }), { "forward:read": true }),
      new Date(),
    ];
    for (const permissions of malformed) {
      expect(isValidCustomPermissions(permissions)).toBe(false);
      expect(parseCustomPermissions(permissions)).toEqual({});
      expect(customRoleGrants(permissions, "forward:read")).toBe(false);
      expect(canWorkspaceResourceAction(access("admin", { customRoleId: 8, customPermissions: permissions }), "read", "forward")).toBe(false);
    }
    for (const customRoleId of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(canWorkspaceResourceAction(access("admin", { customRoleId, customPermissions: { "forward:read": true } }), "read", "forward")).toBe(false);
    }
    expect(isEmptyCustomPermissions({})).toBe(true);
    expect(isEmptyCustomPermissions({ "forward:read": false })).toBe(true);
    expect(canWorkspaceResourceAction(access("admin", { customRoleId: 8, customPermissions: {} }), "manage", "node")).toBe(false);
  });

  test("prototype pollution and getters cannot act as permission grants", () => {
    expect(isValidCustomPermissions(JSON.parse('{"__proto__":{},"forward:read":true}'))).toBe(false);
    const getter = Object.defineProperty({}, "forward:read", { enumerable: true, get() { throw new Error("getter must not execute"); } });
    expect(customRoleGrants(getter, "forward:read")).toBe(false);
    const nullPrototype = Object.assign(Object.create(null), { "tunnel:read": true });
    expect(customRoleGrants(nullPrototype, "forward:read")).toBe(true);
  });

  test("owner break-glass does not depend on a valid custom map", () => {
    for (const customPermissions of [undefined, null, {}, { "forward:read": false }, []]) {
      const owner = access("owner", { customRoleId: 8, customPermissions });
      for (const [resource, action] of matrix) expect(canWorkspaceResourceAction(owner, action, resource)).toBe(true);
    }
  });

  test("custom helper retains null only for absent maps, and malformed maps deny", () => {
    expect(actionFromCustomRole(null, "read", "forward")).toBeNull();
    expect(actionFromCustomRole(undefined, "read")).toBeNull();
    expect(actionFromCustomRole([], "read", "forward")).toBe(false);
    expect(actionFromCustomRole({ "tunnel:update": true }, "update", "forward")).toBe(true);
    expect(actionFromCustomRole({ "audit:read": true }, "delete", "audit")).toBe(false);
    expect(customRoleGrants({ "node:manage": true }, "node:delete")).toBe(false);
  });
});

type Member = NonNullable<Awaited<ReturnType<WorkspaceAccessDb["workspaceMember"]["findUnique"]>>>;
function member(patch: Partial<Member> = {}): Member {
  return { active: true, role: "member", role_id: null, workspace: { kind: "team" }, custom_role: null, ...patch };
}

function harness(row: Member | null, options: { personal?: number | null; authenticated?: boolean } = {}) {
  const lookups: { workspace_id: number; user_id: number }[] = [];
  const injectedDb: WorkspaceAccessDb = {
    workspace: { findUnique: async () => options.personal === null ? null : { id: options.personal ?? 10 } },
    workspaceMember: { findUnique: async ({ where }) => { lookups.push(where.workspace_id_user_id); return row; } },
  };
  return {
    lookups,
    async request(action: WorkspaceAction, resource: WorkspaceResourceFamily = "forward", headers: Record<string, string> = { "x-workspace-id": "20" }) {
      const app = new Hono<{ Variables: AppVariables }>();
      app.onError((error) => {
        if (error instanceof HTTPException) return error.getResponse();
        throw error;
      });
      app.get("/", async (c) => {
        if (options.authenticated !== false) c.set("user", { id: 7 } as AppVariables["user"]);
        return c.json(await resolveWorkspaceAccess(c, action, resource, injectedDb));
      });
      return app.request("http://localhost/", { headers });
    },
  };
}

async function expectRbacDenied(response: Response) {
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: "permission_denied", error_layer: "rbac" });
}

describe("workspace resolver: scoped custom role and middleware prefilter", () => {
  test("member update/delete prefilter passes, but actual resource authorization still needs creator", async () => {
    for (const resource of ["forward", "tunnel"] as const) {
      for (const action of ["update", "delete"] as const) {
        const h = harness(member());
        const response = await h.request(action, resource);
        expect(response.status).toBe(200);
        const selected = await response.json() as WorkspaceAccess;
        expect(selected.actorId).toBe(7);
        expect(selected.customRoleId).toBeNull();
        expect(h.lookups).toEqual([{ workspace_id: 20, user_id: 7 }]);
        expect(canWorkspaceResourceAction(selected, action, resource, false)).toBe(false);
        expect(canWorkspaceResourceAction(selected, action, resource, true)).toBe(true);
      }
    }
  });

  test("viewer mutations and member Node/Workspace management deny before any resource write", async () => {
    await expectRbacDenied(await harness(member({ role: "viewer" })).request("update"));
    await expectRbacDenied(await harness(member()).request("manage", "node"));
    await expectRbacDenied(await harness(member()).request("manage", "member"));
    await expectRbacDenied(await harness(member()).request("manage", "settings"));
  });

  test("valid custom role replaces admin and returns normalized permissions plus actor ID", async () => {
    const h = harness(member({ role: "admin", role_id: 8, custom_role: { id: 8, workspace_id: 20, permissions: { "tunnel:read": true, "forward:update": false } } }));
    const response = await h.request("read");
    expect(response.status).toBe(200);
    const selected = await response.json() as WorkspaceAccess;
    expect(selected).toMatchObject({ actorId: 7, id: 20, customRoleId: 8, customPermissions: { "forward:read": true, "forward:update": false } });
    await expectRbacDenied(await h.request("update"));
    await expectRbacDenied(await h.request("manage", "node"));
  });

  test("custom viewer explicit update/delete does not require base-member creator", async () => {
    const h = harness(member({ role: "viewer", role_id: 8, custom_role: { id: 8, workspace_id: 20, permissions: { "forward:update": true, "forward:delete": true } } }));
    for (const action of ["update", "delete"] as const) {
      const response = await h.request(action);
      expect(response.status).toBe(200);
      expect(canWorkspaceResourceAction(await response.json() as WorkspaceAccess, action, "forward", false)).toBe(true);
    }
  });

  test("canonical false denies custom admin even if legacy true", async () => {
    await expectRbacDenied(await harness(member({ role: "admin", role_id: 8, custom_role: { id: 8, workspace_id: 20, permissions: { "forward:read": false, "tunnel:read": true } } })).request("read"));
  });

  test("dangling, mismatched, cross-workspace and malformed roles fail closed for all nonowners", async () => {
    const references: Member["custom_role"][] = [
      null,
      { id: 9, workspace_id: 20, permissions: { "forward:read": true } },
      { id: 8, workspace_id: 21, permissions: { "forward:read": true } },
      { id: 8, workspace_id: 20, permissions: null },
      { id: 8, workspace_id: 20, permissions: [] },
      { id: 8, workspace_id: 20, permissions: { "forward:read": true, "node:manage": "true" } },
      { id: 8, workspace_id: 20, permissions: { "forward:read": true, "unknown:read": true } },
    ];
    for (const role of ["admin", "member", "viewer"] as const) {
      for (const custom_role of references) {
        await expectRbacDenied(await harness(member({ role, role_id: 8, custom_role })).request("read"));
      }
    }
  });

  test("owner resolver survives dangling/cross-workspace/malformed custom role", async () => {
    for (const custom_role of [null, { id: 8, workspace_id: 21, permissions: { "forward:read": false } }, { id: 8, workspace_id: 20, permissions: [] }]) {
      expect((await harness(member({ role: "owner", role_id: 8, custom_role })).request("manage", "node")).status).toBe(200);
    }
  });

  test("missing header selects personal; explicit invalid ID never falls back", async () => {
    const h = harness(member({ role: "owner", workspace: { kind: "personal" } }));
    const response = await h.request("read", "forward", {});
    expect(response.status).toBe(200);
    expect((await response.json() as WorkspaceAccess).id).toBe(10);
    expect(h.lookups).toEqual([{ workspace_id: 10, user_id: 7 }]);
    for (const id of ["", "0", "-1", "1.5", "invalid", "9007199254740993"]) {
      expect((await h.request("read", "forward", { "x-workspace-id": id })).status).toBe(400);
    }
    expect(h.lookups).toHaveLength(1);
  });

  test("revoked membership and cross-workspace ID return 404, never personal fallback", async () => {
    const absent = harness(null);
    expect((await absent.request("read")).status).toBe(404);
    expect(absent.lookups).toEqual([{ workspace_id: 20, user_id: 7 }]);
    expect((await harness(member({ active: false })).request("read")).status).toBe(404);
  });

  test("Bearer account-wide credential is personal-only, even owner or custom grant", async () => {
    const h = harness(member({ role: "owner" }));
    await expectRbacDenied(await h.request("read", "forward", { "x-workspace-id": "20", authorization: "bEaReR legacy-account-key" }));
    expect(h.lookups).toHaveLength(0);
    expect((await h.request("read", "forward", { authorization: "Bearer legacy-account-key" })).status).toBe(200);
    expect(h.lookups).toEqual([{ workspace_id: 10, user_id: 7 }]);
  });

  test("unauthenticated identity and missing personal workspace are not granted access", async () => {
    const unauthenticated = harness(member({ role: "owner" }), { authenticated: false });
    expect((await unauthenticated.request("read")).status).toBe(401);
    expect(unauthenticated.lookups).toHaveLength(0);
    expect((await harness(member({ role: "owner" }), { personal: null }).request("read")).status).toBe(403);
  });

  test("structured HTTPException carries error/code/error_layer at the response boundary", async () => {
    const error = workspacePermissionDenied("test denial");
    expect(error.status).toBe(403);
    expect(error.message).toBe("test denial");
    expect(await error.getResponse().json()).toEqual({ error: "test denial", code: "permission_denied", error_layer: "rbac" });
  });
});
