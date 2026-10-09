import { describe, expect, test } from "bun:test";
import { Orchestrator, type AgentTransport, type AgentTunnelConfig } from "../orchestrator.ts";
import type { AgentV2CapabilityFacts } from "../capability-manifest.ts";
import { SELECTOR_RUNTIME_CAPABILITIES } from "../selector-admission.ts";

const advertised: AgentV2CapabilityFacts = {
  protocolVersion: 2, capabilities: ["apply_tunnel"], capabilitiesMalformed: false, manifestMalformed: false,
  manifest: {
    schema_version: 2, protocols: ["tcp", "udp"], transports: ["stream", "datagram"],
    runtime: Object.values(SELECTOR_RUNTIME_CAPABILITIES), diagnostics: [],
  },
};

function fixture(facts: AgentV2CapabilityFacts | null = advertised) {
  const configs: AgentTunnelConfig[] = [];
  let reads = 0;
  let healthReads = 0;
  const unused = async (): Promise<never> => { throw new Error("unexpected dispatch"); };
  const transport: AgentTransport = {
    applyEgress: async (_node, config, envelope) => { configs.push(config); return { ok: true, applied_revision: envelope?.revision }; },
    applyRelay: unused, applyDirect: unused, removeTunnel: unused,
    isReachable: async () => true,
  };
  const orchestrator = new Orchestrator({
    transport, probeReachable: false,
    loadCapabilityFacts: async () => { reads++; return facts; },
    healthSource: async () => { healthReads++; return [
      { host: "primary.example", port: 8080, state: "healthy", latency_ms: 1, age_ms: 0, evidence: true },
      { host: "backup.example", port: 8080, state: "unknown", latency_ms: null, age_ms: null, evidence: false },
    ]; },
  });
  const input = {
    tunnelId: 77, revision: 3, egressNode: { id: 2, node_id: "exit", connect_ip: "127.0.0.1", role: "egress" as const },
    egressPort: 23000, poolId: 8,
    targets: [{ host: "primary.example", port: 8080, weight: 1, order_by: 20 }, { host: "backup.example", port: 8080, weight: 3, order_by: 10 }],
    hopPeer: "127.0.0.1",
  };
  return { orchestrator, input, configs, counts: () => ({ reads, healthReads }) };
}

describe("selector gate on every orchestrator egress dispatch", () => {
  for (const protocol of ["tcp", "udp"] as const) {
    test(`IP_HASH on legacy ${protocol} relay is rejected without health reads or transport side effects`, async () => {
      const f = fixture();
      const result = await f.orchestrator.dispatchEgress({ ...f.input, protocol, lbStrategy: "IP_HASH" });
      expect(result).toMatchObject({ ok: false, error_code: "agent_rejected" });
      if (!result.ok) expect(result.error).toContain("selector_client_ip_required");
      expect(f.configs).toHaveLength(0);
      expect(f.counts()).toEqual({ reads: 0, healthReads: 0 });
    });
  }

  test("fallback is refused when current capability is absent", async () => {
    const f = fixture(null);
    const result = await f.orchestrator.dispatchEgress({ ...f.input, lbStrategy: "fallback" });
    expect(result.ok).toBe(false);
    expect(f.configs).toHaveLength(0);
  });

  test("advertised fallback preserves ordered desired targets and unified health", async () => {
    const f = fixture();
    expect((await f.orchestrator.dispatchEgress({ ...f.input, lbStrategy: "fallback" })).ok).toBe(true);
    expect(f.configs[0]!.lb_strategy).toBe("FALLBACK");
    expect(f.configs[0]!.targets?.map((t) => t.host)).toEqual(["primary.example", "backup.example"]);
    expect(f.configs[0]!.target_health?.map((t) => t.state)).toEqual(["healthy", "unknown"]);
  });
});
