import { describe, expect, test } from "bun:test";
import { FORWARD_POLICY_CAPABILITY, FORWARD_POLICY_MAX, forwardPolicyAgentConfig, forwardPolicyCapabilitySupported,
  forwardPolicyErrors, forwardPolicyValues, hasForwardPolicy, mergeForwardPolicy, resolveForwardPolicy } from "../forward-policy.ts";

describe("Forward policy requests and workspace ceilings", () => {
  test("legacy nulls are unlimited and explicit zero cannot bypass workspace limits", () => {
    expect(forwardPolicyValues({ max_connections: null })).toEqual({ bytes_per_second_in: 0, bytes_per_second_out: 0, max_connections: 0, max_connections_per_ip: 0 });
    expect(resolveForwardPolicy({ bytes_per_second_in: 0, max_connections: 0 }, { bandwidth_limit: 8, client_limit: 3 }))
      .toEqual({ bytes_per_second_in: 1_000_000, bytes_per_second_out: 1_000_000, max_connections: 3, max_connections_per_ip: 0 });
  });
  test("requested caps survive ceiling upgrades without mutating the request", () => {
    const requested = { bytes_per_second_in: 2_000_000, bytes_per_second_out: 250_000, max_connections: 20, max_connections_per_ip: 7 };
    expect(resolveForwardPolicy(requested, { bandwidth_limit: 8, client_limit: 10, max_connections_per_ip: 3 })).toEqual({
      bytes_per_second_in: 1_000_000, bytes_per_second_out: 250_000, max_connections: 10, max_connections_per_ip: 3 });
    expect(resolveForwardPolicy(requested, { bandwidth_limit: 32, client_limit: 30 })).toEqual(requested);
    expect(requested.bytes_per_second_in).toBe(2_000_000);
  });
  test("zero workspace ceilings forbid forwarding instead of becoming runtime unlimited", () => {
    for (const field of ["bandwidth_limit", "client_limit", "max_connections_per_ip"] as const) {
      expect(() => resolveForwardPolicy({}, { [field]: 0 })).toThrow("workspace_data_plane_forbidden");
    }
    expect(resolveForwardPolicy({}, { bandwidth_limit: null, client_limit: null }).max_connections).toBe(0);
  });
  test("Mbps conversion is decimal and JSON Int range is enforced", () => {
    expect(resolveForwardPolicy({}, { bandwidth_limit: 0.001 }).bytes_per_second_in).toBe(125);
    expect(resolveForwardPolicy({}, { bandwidth_limit: 100_000 }).bytes_per_second_in).toBe(FORWARD_POLICY_MAX);
    for (const n of [-1, 0.5, NaN, Infinity, FORWARD_POLICY_MAX + 1]) {
      expect(forwardPolicyErrors({ bytes_per_second_out: n })).toHaveLength(1);
      expect(() => forwardPolicyValues({ bytes_per_second_out: n })).toThrow();
    }
    expect(forwardPolicyErrors({ bytes_per_second_out: FORWARD_POLICY_MAX })).toEqual([]);
    expect(() => resolveForwardPolicy({}, { client_limit: -1 })).toThrow();
  });
  test("undefined patch preserves requested values; zero explicitly resets", () => {
    expect(forwardPolicyValues(mergeForwardPolicy({ max_connections: 5, bytes_per_second_in: 123 }, { max_connections: 0 })))
      .toMatchObject({ max_connections: 0, bytes_per_second_in: 123 });
    // Legacy ip_limit is not a source-IP concurrency entitlement.
    expect(resolveForwardPolicy({}, { ip_limit: 2 } as any).max_connections_per_ip).toBe(0);
    expect(forwardPolicyAgentConfig({ max_connections: 4 })).toMatchObject({ policy_scope: "runtime", speed_limit: 0, max_connections: 4 });
  });
  test("nonzero effective policy requires a current capability advertisement", () => {
    expect(hasForwardPolicy(forwardPolicyAgentConfig({}, { client_limit: 1 }))).toBe(true);
    expect(hasForwardPolicy(forwardPolicyAgentConfig({}))).toBe(false);
    expect(hasForwardPolicy({ speed_limit: 1 })).toBe(true);
    expect(forwardPolicyCapabilitySupported(null)).toBe(false);
    expect(forwardPolicyCapabilitySupported({ capabilities: [FORWARD_POLICY_CAPABILITY] })).toBe(true);
    expect(forwardPolicyCapabilitySupported({ capabilities: [FORWARD_POLICY_CAPABILITY], capabilitiesMalformed: true })).toBe(false);
    expect(forwardPolicyCapabilitySupported({ manifest: { runtime: [FORWARD_POLICY_CAPABILITY] } })).toBe(true);
  });
});
