import { describe, expect, test } from "bun:test";
import { capabilityFactsFromStoredV2, type AgentV2CapabilityFacts } from "../capability-manifest.ts";
import { admitSelector, admitSelectorFromStore, SELECTOR_RUNTIME_CAPABILITIES } from "../selector-admission.ts";

function facts(runtime: string[]): AgentV2CapabilityFacts {
  return {
    protocolVersion: 2, capabilities: ["apply_tunnel"], capabilitiesMalformed: false, manifestMalformed: false,
    manifest: { schema_version: 2, protocols: ["tcp", "udp"], transports: ["stream", "datagram"], runtime, diagnostics: [] },
  };
}

describe("selector capability and original client-IP admission", () => {
  test("historical selectors keep the compatibility baseline", async () => {
    for (const strategy of [null, "round", "rand", "weighted_round", "WEIGHTED_ROUND_ROBIN"]) {
      const result = await admitSelectorFromStore(2, { strategy, mode: "EGRESS" }, async () => { throw new Error("must not read"); });
      expect(result.ok).toBe(true);
    }
    expect(admitSelector({ strategy: "unexpected", mode: "EGRESS" }, null)).toMatchObject({ ok: false, reason: "invalid_selector" });
  });

  test("fallback requires current explicit capability, never version guessing", async () => {
    const request = { strategy: "fallback", mode: "EGRESS" as const };
    expect(admitSelector(request, null)).toMatchObject({ ok: false, reason: "upgrade_required" });
    expect(admitSelector(request, facts([]))).toMatchObject({ ok: false, reason: "runtime_feature_not_supported" });
    expect(admitSelector(request, facts([SELECTOR_RUNTIME_CAPABILITIES.fallback]))).toMatchObject({ ok: true, strategy: "FALLBACK" });
    expect(await admitSelectorFromStore(2, request, async () => { throw new Error("unreadable"); })).toMatchObject({ ok: false });
    const stale = capabilityFactsFromStoredV2({
      control_protocol_version: 2, capabilities: ["apply_tunnel"], capability_manifest: facts([SELECTOR_RUNTIME_CAPABILITIES.fallback]).manifest,
      reported_at: new Date(1000), credential_rotated_at: new Date(2000),
    });
    expect(admitSelector(request, stale)).toMatchObject({ ok: false, reason: "upgrade_required" });
    expect(admitSelector(request, { ...facts([]), manifestMalformed: true })).toMatchObject({ ok: false, reason: "malformed_capability_manifest" });
  });

  test("advertising IP_HASH cannot manufacture a missing original source", async () => {
    const advertised = facts([SELECTOR_RUNTIME_CAPABILITIES.ip_hash]);
    for (const mode of ["RELAY", "EGRESS"] as const) {
      // Even an incorrectly supplied source-scope claim cannot widen legacy relay admission.
      expect(admitSelector({ strategy: "IP_HASH", mode, sourceScope: "trusted_client_ip" }, advertised))
        .toMatchObject({ ok: false, reason: "selector_client_ip_required" });
    }
    expect(await admitSelectorFromStore(2, { strategy: "ip_hash", mode: "EGRESS" }, async () => { throw new Error("must not read"); }))
      .toMatchObject({ ok: false, reason: "selector_client_ip_required" });
    expect(admitSelector({ strategy: "IP_HASH", mode: "DIRECT" }, advertised)).toMatchObject({ ok: false, reason: "selector_client_ip_required" });
    expect(admitSelector({ strategy: "IP_HASH", mode: "DIRECT", sourceScope: "trusted_client_ip" }, null)).toMatchObject({ ok: false, reason: "upgrade_required" });
    expect(admitSelector({ strategy: "IP_HASH", mode: "DIRECT", sourceScope: "trusted_client_ip" }, advertised))
      .toMatchObject({ ok: true, strategy: "IP_HASH" });
  });
});
