import { expect, test } from "bun:test";
import { effectiveWorkspaceAccess, canGrantWorkspaceBaseRole } from "../workspace-effective-access.ts";
import type { WorkspaceAccess } from "../workspace.ts";
const access: WorkspaceAccess = { id: 1, actorId: 7, role: "member", kind: "team", personalWorkspaceId: 2, customRoleId: null };
test("member projection separates creator-only mutations from workspace scope", () => {
  const view = effectiveWorkspaceAccess(access);
  expect(view.forward_mutations).toBe("own");
  expect(view.permissions["forward:update"]).toBe(true);
  expect(view.permissions["node:manage"]).toBe(false);
});
test("custom replacement projection never exposes base admin permissions", () => {
  const view = effectiveWorkspaceAccess({ ...access, role: "admin", customRoleId: 4, customPermissions: { "node:read": true } });
  expect(view.permissions["node:read"]).toBe(true);
  expect(view.permissions["forward:read"]).toBe(false);
  expect(view.permissions["member:manage"]).toBe(false);
});
test("missing role permissions fail closed in discovery", () => {
  expect(Object.values(effectiveWorkspaceAccess({ ...access, role: "admin", customRoleId: 4 }).permissions).every((v) => v === false)).toBe(true);
});
test("delegated member manager cannot mint viewer/member/admin rights via invites", () => {
  const delegated = { ...access, role: "admin" as const, customRoleId: 4, customPermissions: { "member:manage": true } };
  for (const role of ["viewer", "member", "admin"] as const) expect(canGrantWorkspaceBaseRole(delegated, role)).toBe(false);
  expect(canGrantWorkspaceBaseRole({ ...access, role: "owner" }, "admin")).toBe(true);
});
