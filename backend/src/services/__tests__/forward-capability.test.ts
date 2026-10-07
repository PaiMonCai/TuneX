import { describe, expect, test } from "bun:test";
import { checkTunnelCreation, checkTunnelUse, type EffectivePolicy } from "../capability-policy.ts";
import { checkForwardRuntimeUse, type RuntimeUseDeps } from "../forward-capability.ts";

function policy(): EffectivePolicy {
  const limits = { max_tunnels: 1, max_nodes: 1, max_members: 1, traffic_limit: 100, traffic_period: "total" as const, bandwidth_limit: null, client_limit: null, ip_limit: null };
  return { workspace_id: 7, revision: 1, entitlements: { tunnel_types: ["tcp"], allow_custom_in_group: true, allow_custom_out_group: true, allowed_in_group_ids: null, allowed_out_group_ids: null, allow_shared_entry: false, whitelist_ips: null }, limits, ceiling: limits, active_policies: [], grace_policies: [], grace_expires_at: null, deny_scope: false, deny_reason: null };
}
const context = { trafficUsed: 0, protocol: "tcp", inGroupOwned: true, inGroupId: 10, outGroupId: null, outGroupOwned: true };

describe("WP10 capability vs count quota", () => {
  test("at max count: creation denied, existing update admitted", () => {
    expect(checkTunnelCreation(policy(), { ...context, tunnelCount: 1 }).reason).toBe("tunnel_limit");
    expect(checkTunnelUse(policy(), context).allowed).toBe(true);
  });
  test("even a lowered count ceiling does not delete or freeze existing resources", () => {
    const p = policy(); p.limits.max_tunnels = 0;
    expect(checkTunnelUse(p, context).allowed).toBe(true);
  });
  test("revoked policy still denies existing use", () => {
    const p = policy(); p.deny_scope = true; p.deny_reason = "no_active_policy";
    expect(checkTunnelUse(p, context).reason).toBe("no_active_policy");
  });
  test("traffic and protocol remain enforced independently", () => {
    expect(checkTunnelUse(policy(), { ...context, trafficUsed: 100 }).reason).toBe("traffic_exhausted");
    expect(checkTunnelUse(policy(), { ...context, protocol: "udp" }).reason).toBe("protocol_not_allowed");
  });
  test("zero runtime resource ceilings reject new and existing use", () => {
    for (const field of ["bandwidth_limit", "client_limit"] as const) {
      const p = policy(); p.limits[field] = 0;
      expect(checkTunnelCreation(p, { ...context, tunnelCount: 0 }).reason).toBe(field);
      expect(checkTunnelUse(p, context).reason).toBe(field);
    }
  });
  test("capability list alone cannot authorize shared machine ownership", () => {
    expect(checkTunnelUse(policy(), { ...context, inGroupOwned: false }).reason).toBe("in_group_not_allowed");
  });
});

function fixture() {
  const p = policy(); let grant = true; let traffic = 0; let shared = false; let policyReads = 0;
  const deps: RuntimeUseDeps = {
    policy: async () => { policyReads++; return p; }, traffic: async () => traffic,
    group: async (id) => ({ id, user_id: 9, workspace_id: shared ? 99 : 7 }),
    personalWorkspace: async () => 7,
    granted: async (_user, g, _direction, ws, personal) => g.workspace_id === ws || (ws === personal && grant),
  };
  return { p, deps, revoke: () => { grant = false; }, share: () => { shared = true; }, exhaust: () => { traffic = 100; }, reads: () => policyReads };
}
const resource = { user_id: 9, in_node_group_id: 10, out_node_group_id: null, tunnel_type: "tcp" };
describe("WP10 independent scope/use gates", () => {
  test("owned resource succeeds", async () => { const f = fixture(); expect(await checkForwardRuntimeUse(7, resource, f.deps)).toBeNull(); });
  test("revoked grant rejected before policy and business mutation", async () => {
    const f = fixture(); f.share(); f.revoke();
    expect((await checkForwardRuntimeUse(7, resource, f.deps))?.error_layer).toBe("resource_scope");
    expect(f.reads()).toBe(0);
  });
  test("team cannot inherit a personal grant", async () => {
    const f = fixture(); f.share();
    expect((await checkForwardRuntimeUse(8, resource, f.deps))?.reason).toBe("scope_revoked");
  });
  test("active grant still requires explicit shared capability", async () => {
    const f = fixture(); f.share();
    expect((await checkForwardRuntimeUse(7, resource, f.deps))?.reason).toBe("in_group_not_allowed");
    f.p.entitlements.allowed_in_group_ids = [10];
    expect(await checkForwardRuntimeUse(7, resource, f.deps)).toBeNull();
  });
  test("capability and traffic return distinct layers", async () => {
    const f = fixture(); f.p.deny_scope = true;
    expect((await checkForwardRuntimeUse(7, resource, f.deps))?.error_layer).toBe("capability");
    f.p.deny_scope = false; f.exhaust();
    expect((await checkForwardRuntimeUse(7, resource, f.deps))?.error_layer).toBe("quota");
  });
});
