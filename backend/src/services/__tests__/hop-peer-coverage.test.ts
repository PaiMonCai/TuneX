import { describe, expect, test } from "bun:test";
import { Orchestrator, type AgentTransport, type AgentTunnelConfig, type OrchestratorNode } from "../orchestrator.ts";

class RecordingTransport implements AgentTransport {
  readonly configs: AgentTunnelConfig[] = [];
  async applyEgress(_node: OrchestratorNode, config: AgentTunnelConfig) {
    this.configs.push(config);
    return { ok: true, applied_revision: config.revision, egress_host: "10.0.0.4" };
  }
  async applyRelay(): Promise<unknown> { throw new Error("unused"); }
  applyDirect(): Promise<unknown> { throw new Error("unused"); }
  removeTunnel(): Promise<unknown> { throw new Error("unused"); }
  async isReachable(): Promise<boolean> { return true; }
}

const node: OrchestratorNode = { id: 4, node_id: "n-4", connect_ip: "10.0.0.4", role: "egress" };

describe("datagram egress safety boundary", () => {
  test("UDP refuses dispatch without an attested hop peer", async () => {
    const transport = new RecordingTransport();
    const orchestrator = new Orchestrator({ transport, probeReachable: false } as never);
    const result = await orchestrator.dispatchEgress({
      tunnelId: 51,
      revision: 7,
      egressNode: node,
      egressPort: 22001,
      poolId: 3,
      targets: [{ host: "10.9.0.1", port: 5353, weight: 1, order_by: 10 }],
      protocol: "udp",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error_code).toBe("datagram_hop_peer_missing");
    expect(transport.configs).toHaveLength(0);
  });

  test("UDP sends the attested peer when present", async () => {
    const transport = new RecordingTransport();
    const orchestrator = new Orchestrator({ transport, probeReachable: false } as never);
    const result = await orchestrator.dispatchEgress({
      tunnelId: 51,
      revision: 7,
      egressNode: node,
      egressPort: 22001,
      poolId: 3,
      targets: [{ host: "10.9.0.1", port: 5353, weight: 1, order_by: 10 }],
      protocol: "udp",
      hopPeer: "10.0.0.3",
    });
    expect(result.ok).toBe(true);
    expect(transport.configs[0]?.hop_peer).toBe("10.0.0.3");
  });
});
