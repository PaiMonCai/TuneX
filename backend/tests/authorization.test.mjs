import { test } from "node:test";
import assert from "node:assert/strict";
import { isBillingBlocked } from "../src/services/billing-access.ts";
import { isNodeGroupGranted } from "../src/services/node-group-policy.ts";
import { getEffectiveAccess, levelSatisfies, resolveAdminRoute } from "../src/permissions.ts";

test("billing disabled: every order entry and unauthenticated gateway callback is denied", () => {
  for (const [path, method] of [
    ["/api/pay/create", "POST"], ["/api/topups", "POST"],
    ["/api/plans/purchase", "POST"], ["/api/pay/123/callback", "GET"],
    ["/api/pay/123/callback", "POST"], ["/api/admin/payments", "POST"],
    ["/api/admin/topup/activity", "PATCH"],
  ]) assert.equal(isBillingBlocked(path, method, false), true, `${method} ${path}`);
});

test("billing disabled: historic reads and ordinary tunnel writes are not blocked", () => {
  for (const [path, method] of [
    ["/api/topups", "GET"], ["/api/admin/orders", "GET"],
    ["/api/payments", "GET"], ["/api/tunnels", "POST"],
    ["/api/tickets", "POST"],
  ]) assert.equal(isBillingBlocked(path, method, false), false, `${method} ${path}`);
  assert.equal(isBillingBlocked("/api/pay/123/callback", "POST", true), false);
});

test("node group access fails closed; direction and revocation take effect immediately", () => {
  const own = { id: 4, user_id: 12 };
  const shared = { id: 5, user_id: 99 };
  const grants = [{ node_group_id: 5, direction: "in", active: true }];
  assert.equal(isNodeGroupGranted(12, own, "out", []), true);
  assert.equal(isNodeGroupGranted(12, shared, "in", []), false);
  assert.equal(isNodeGroupGranted(12, shared, "in", grants), true);
  assert.equal(isNodeGroupGranted(12, shared, "out", grants), false);
  assert.equal(isNodeGroupGranted(12, shared, "in", [{ ...grants[0], active: false }]), false);
  assert.equal(isNodeGroupGranted(12, { id: 5 }, "in", grants), false);
});

test("RBAC works without billing: roles merge and writes require a write grant", () => {
  const access = getEffectiveAccess({ super_admin: false, admin_roles: [
    { permissions: { nodes: "read", tickets: "read", unknown: "write" } },
    { permissions: { nodes: "write" } },
  ] });
  assert.equal(access.get("nodes"), "write");
  assert.equal(access.get("tickets"), "read");
  assert.equal(access.has("unknown"), false);
  assert.equal(levelSatisfies(access.get("tickets"), "write"), false);
  assert.equal(resolveAdminRoute("/admin/node/1")?.key, "nodes");
});
