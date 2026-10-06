/**
 * V4-WP11B — 控制协议能力协商的判定纪律。
 *
 * 这里钉的是三件容易做错、且做错方向都危险的事：
 *   1. 「Agent 从未上报」与「Agent 上报了空清单」必须区分——混同会在
 *      "升级窗口全网中断"和"向旧 Agent 发未知命令"之间二选一；
 *   2. 坏形状必须 fail-closed，不能退化成"未上报"（那会把拒绝降级成放行）；
 *   3. 能力不是授权：判定结果与 RBAC 无关，只影响能否下发。
 */
import { describe, expect, test } from "bun:test";
import {
  BASELINE_COMMAND_ACTIONS,
  CAPABILITY_MAX_ITEMS,
  CONTROL_PROTOCOL_VERSION,
  capabilityErrorBody,
  capabilityFactsFromStored,
  decideCapability,
  normalizeCapabilities,
  normalizeProtocolVersion,
} from "../agent-capability.ts";

describe("capability normalization", () => {
  test("absent stays absent, empty stays empty and they are different facts", () => {
    expect(normalizeCapabilities(undefined)).toBeNull();
    expect(normalizeCapabilities(null)).toBeNull();
    expect(normalizeCapabilities([])).toEqual([]);
  });

  test("entries are trimmed, de-duplicated and sorted deterministically", () => {
    expect(normalizeCapabilities([" remove_tunnel ", "apply_tunnel", "apply_tunnel"])).toEqual([
      "apply_tunnel",
      "remove_tunnel",
    ]);
  });

  test("bad shapes throw instead of degrading to 'never reported'", () => {
    const bad: unknown[] = [
      "apply_tunnel",
      { apply_tunnel: true },
      [1, 2],
      [""],
      ["x".repeat(65)],
      Array.from({ length: CAPABILITY_MAX_ITEMS + 1 }, (_v, i) => `action_${i}`),
    ];
    for (const value of bad) {
      expect(() => normalizeCapabilities(value)).toThrow(TypeError);
    }
  });

  test("protocol version accepts non-negative integers only", () => {
    expect(normalizeProtocolVersion(undefined)).toBeNull();
    expect(normalizeProtocolVersion(null)).toBeNull();
    expect(normalizeProtocolVersion(0)).toBe(0);
    expect(normalizeProtocolVersion(CONTROL_PROTOCOL_VERSION)).toBe(CONTROL_PROTOCOL_VERSION);
    for (const bad of [-1, 1.5, "1", Number.NaN, {}]) {
      expect(() => normalizeProtocolVersion(bad)).toThrow(TypeError);
    }
  });
});

describe("decideCapability: baseline vs advertised vs unknown", () => {
  test("a node that never reported still accepts the frozen baseline actions", () => {
    for (const action of BASELINE_COMMAND_ACTIONS) {
      expect(decideCapability(null, action)).toEqual({ supported: true, basis: "baseline" });
      expect(decideCapability({ capabilities: null, protocolVersion: null }, action)).toEqual({
        supported: true,
        basis: "baseline",
      });
    }
  });

  test("a node that never reported refuses non-baseline actions with an upgrade prompt", () => {
    const decision = decideCapability({ capabilities: null, protocolVersion: null }, "diagnose_forward");
    expect(decision.supported).toBe(false);
    if (decision.supported) return;
    expect(decision.reason).toBe("upgrade_required");
    expect(capabilityErrorBody(decision)).toMatchObject({
      code: "upgrade_required",
      error_layer: "runtime_admission",
      condition: "upgrade_required",
    });
  });

  test("an explicitly advertised action is allowed even if it is new", () => {
    const facts = { capabilities: ["diagnose_forward", "apply_tunnel"], protocolVersion: 2 };
    expect(decideCapability(facts, "diagnose_forward")).toEqual({ supported: true, basis: "advertised" });
    expect(decideCapability(facts, "apply_tunnel")).toEqual({ supported: true, basis: "advertised" });
  });

  test("an empty advertisement refuses even baseline actions (agent described itself)", () => {
    const decision = decideCapability({ capabilities: [], protocolVersion: 1 }, "apply_tunnel");
    expect(decision.supported).toBe(false);
    if (decision.supported) return;
    expect(decision.reason).toBe("incompatible_agent");
  });

  test("a non-baseline action missing from a reported list is an upgrade case", () => {
    const decision = decideCapability({ capabilities: ["apply_tunnel"], protocolVersion: 1 }, "drain_node");
    expect(decision.supported).toBe(false);
    if (decision.supported) return;
    expect(decision.reason).toBe("upgrade_required");
  });

  test("an empty or missing action name is never allowed", () => {
    for (const action of ["", "   "]) {
      const decision = decideCapability({ capabilities: ["apply_tunnel"], protocolVersion: 1 }, action);
      expect(decision.supported).toBe(false);
      if (!decision.supported) expect(decision.reason).toBe("incompatible_agent");
    }
  });

  test("an unknown node (no row at all) still only gets the baseline", () => {
    expect(decideCapability(undefined, "apply_tunnel")).toEqual({ supported: true, basis: "baseline" });
    expect(decideCapability(undefined, "diagnose_node").supported).toBe(false);
  });
});

describe("stored facts: a reinstall invalidates the previous advertisement", () => {
  const reported = new Date("2026-10-01T10:00:00Z");
  const before = new Date("2026-10-01T09:00:00Z");
  const after = new Date("2026-10-01T11:00:00Z");

  test("a report older than the current credential describes a dead process", () => {
    const facts = capabilityFactsFromStored({
      control_protocol_version: 9,
      capabilities: ["apply_tunnel", "diagnose_forward"],
      reported_at: reported,
      credential_rotated_at: after,
    });
    // Treated as "never reported": baseline actions keep working, new ones are refused.
    expect(facts).toBeNull();
    expect(decideCapability(facts, "apply_tunnel")).toEqual({ supported: true, basis: "baseline" });
    expect(decideCapability(facts, "diagnose_forward").supported).toBe(false);
  });

  test("a fresh report keeps its advertisement", () => {
    const facts = capabilityFactsFromStored({
      control_protocol_version: 9,
      capabilities: ["apply_tunnel", "diagnose_forward"],
      reported_at: reported,
      credential_rotated_at: before,
    });
    expect(facts).toEqual({ protocolVersion: 9, capabilities: ["apply_tunnel", "diagnose_forward"] });
    expect(decideCapability(facts, "diagnose_forward")).toEqual({ supported: true, basis: "advertised" });
  });

  test("a report with no credential timestamp is still usable", () => {
    const facts = capabilityFactsFromStored({
      control_protocol_version: 1,
      capabilities: ["apply_tunnel"],
      reported_at: reported,
      credential_rotated_at: null,
    });
    expect(facts?.capabilities).toEqual(["apply_tunnel"]);
  });

  test("a missing row yields no facts (baseline only), never 'supports everything'", () => {
    const facts = capabilityFactsFromStored(null);
    expect(facts).toBeNull();
    expect(decideCapability(facts, "apply_tunnel")).toEqual({ supported: true, basis: "baseline" });
    expect(decideCapability(facts, "drain_node").supported).toBe(false);
  });

  test("a malformed stored advertisement throws instead of degrading to 'never reported'", () => {
    expect(() => capabilityFactsFromStored({
      control_protocol_version: 1,
      capabilities: "apply_tunnel",
      reported_at: reported,
      credential_rotated_at: null,
    })).toThrow(TypeError);
  });

  test("the reinstall rule compares timestamps, not just their presence", () => {
    const equal = capabilityFactsFromStored({
      control_protocol_version: 1,
      capabilities: ["apply_tunnel"],
      reported_at: reported,
      credential_rotated_at: reported,
    });
    // Credential minted at the same instant as the report: the report cannot be
    // proven to come from the process holding that credential, so it is dropped.
    expect(equal).toBeNull();
  });
});
