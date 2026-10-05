/**
 * V5.1b WP5-B2 —— 面板侧把"配对入口地址"带给 datagram 出口腿。
 *
 * 契约：`docs/v5-1b-datagram-contract-draft.md` §9.1（2026-10-05 冻结）/ §12。
 *
 * 这一层的三条契约：
 *   1. **地址只推导一次**：`dispatchFactsFromRow` 是"隧道行 → 下发事实"的唯一入口，
 *      `hop_peer` 在那里推导，而不是在 6 个下发点各推一遍（那正是两条腿会指向不同地址的成因）；
 *   2. **缺了就拒绝**：datagram 的跳没有握手，出口无法自证对面是谁 —— 面板宁可在自己这层
 *      拒绝并点名缺了哪个字段，也不要把一份出口必然拒绝的配置发出去；
 *   3. **只给 datagram 带**：流协议的跳是裸 TCP，`hop_peer` 在那里是一个没人读的字段，
 *      而"没人读的字段"是漂移的开始。
 */
import { describe, expect, test } from "bun:test";

import { Orchestrator, type AgentTunnelConfig, type OrchestratorNode } from "../orchestrator.ts";
import type { AgentTransport } from "../orchestrator.ts";
import { datagramHopPeerFor, dispatchFactsFromRow } from "../forward-contract.ts";

describe("V5.1b WP5-B2: dispatch facts carry the datagram exit's attestation address", () => {
  test("udp: the address comes from the INGRESS node, picked the same way next_hop is", () => {
    const facts = dispatchFactsFromRow({
      forward_protocol: "udp",
      tunnel_type: "udp",
      // `connect_ip` is a comma-separated candidate list; both legs of the hop must
      // take the SAME first entry, which is why this helper is shared.
      ingress_node: { connect_ip: " 10.0.0.3 , 10.0.0.9 " },
    });
    expect(facts?.protocol).toBe("udp");
    expect(facts?.hopPeer).toBe("10.0.0.3");
  });

  test("stream protocols never carry it: the field would be a fact nobody reads", () => {
    for (const protocol of ["tcp", "tls", "ws"] as const) {
      const facts = dispatchFactsFromRow({
        forward_protocol: protocol,
        tunnel_type: protocol,
        tls_cert_path: "/etc/tunex/tls/a.crt",
        tls_key_path: "/etc/tunex/tls/a.key",
        ingress_node: { connect_ip: "10.0.0.3" },
      });
      expect(facts?.hopPeer).toBeUndefined();
    }
  });

  test("a udp row with no readable ingress address still yields facts (the refusal belongs to dispatchEgress)", () => {
    // The ingress leg of the same tunnel does not need hopPeer, so blanking the
    // facts here would refuse a leg that is perfectly dispatchable — and it would
    // report the refusal under the wrong reason.
    const facts = dispatchFactsFromRow({ forward_protocol: "udp", tunnel_type: "udp", ingress_node: null });
    expect(facts).not.toBeNull();
    expect(facts?.hopPeer).toBeUndefined();
  });
});

class RecordingTransport implements AgentTransport {
  readonly configs: AgentTunnelConfig[] = [];

  async applyEgress(_node: OrchestratorNode, config: AgentTunnelConfig) {
    this.configs.push(config);
    return { ok: true, applied_revision: config.revision, egress_host: "10.0.0.4" };
  }
  async applyRelay(): Promise<unknown> {
    throw new Error("unused");
  }
  applyDirect(): Promise<unknown> {
    throw new Error("unused");
  }
  removeTunnel(): Promise<unknown> {
    throw new Error("unused");
  }
  async isReachable(): Promise<boolean> {
    return true;
  }
}

function env() {
  const transport = new RecordingTransport();
  const orchestrator = new Orchestrator({ transport, probeReachable: false } as never);
  return { transport, orchestrator };
}

const egressNode: OrchestratorNode = { id: 4, node_id: "n-4", connect_ip: "10.0.0.4", role: "egress" };

const egressInput = (over: Partial<Parameters<Orchestrator["dispatchEgress"]>[0]> = {}) => ({
  tunnelId: 51,
  revision: 7,
  egressNode,
  egressPort: 22001,
  poolId: 3,
  targets: [{ host: "10.9.0.1", port: 5353, weight: 1, order_by: 10 }],
  protocol: "udp" as const,
  ...over,
});

describe("V5.1b WP5-B2: a datagram exit without an attested ingress is refused before it is sent", () => {
  test("udp without hop_peer is refused with a code that names the missing fact", async () => {
    const { transport, orchestrator } = env();
    const outcome = await orchestrator.dispatchEgress(egressInput());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error_code).toBe("datagram_hop_peer_missing");
      expect(outcome.error).toContain("hop_peer");
    }
    // The important half: nothing was sent. A config the exit would refuse must not
    // leave the panel believing it dispatched something.
    expect(transport.configs).toHaveLength(0);
  });

  test("udp with hop_peer carries it onto the wire", async () => {
    const { transport, orchestrator } = env();
    const outcome = await orchestrator.dispatchEgress(egressInput({ hopPeer: "10.0.0.3" }));
    expect(outcome.ok).toBe(true);
    expect(transport.configs).toHaveLength(1);
    expect(transport.configs[0]!.hop_peer).toBe("10.0.0.3");
    expect(transport.configs[0]!.protocol).toBe("udp");
  });

  test("a stream egress never emits hop_peer, even if one is passed in", async () => {
    const { transport, orchestrator } = env();
    const outcome = await orchestrator.dispatchEgress(egressInput({ protocol: "tcp", hopPeer: "10.0.0.3" }));
    expect(outcome.ok).toBe(true);
    expect(transport.configs[0]!.hop_peer).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */

/**
 * V5.1b WP5-B2（契约 §12.5 回填第 8 条）：出口取证的地址**优先用入口上报的跳端点**。
 *
 * 为什么不是 `connect_ip`：多宿节点上跳的源地址由内核按路由选，可能是面板不知道的那张网。
 * 真拓扑实测：入口从出口网地址发出、面板却告诉出口接受它的入口网地址 ⇒ 出口把每个跳报文
 * 都当陌生来源丢弃（`ingress packets_in=1` / `egress drops=1, packets_in=0`）。
 */
describe("V5.1b WP5-B2: the exit attests the address the ingress REPORTED using", () => {
  const reportWithEndpoint = (id: string, endpoint: string) => [
    { id: "tunex-2-egress", diag: { hop_local_addr: "10.9.9.9:1111" } },
    { id, diag: { hop_local_addr: endpoint } },
  ];

  test("the reported hop endpoint wins over connect_ip, and only its ADDRESS is used", () => {
    expect(
      datagramHopPeerFor({
        ingressRuntimeId: "tunex-42-relay",
        // The panel-known address is the WRONG one on a multi-homed node.
        ingressConnectIp: "172.31.10.20",
        ingressReportedTunnels: reportWithEndpoint("tunex-42-relay", "172.31.20.10:53121"),
      }),
    ).toBe("172.31.20.10");
  });

  test("the port is stripped, never pinned: an ingress restart must not change the exit's config", () => {
    const first = datagramHopPeerFor({
      ingressRuntimeId: "tunex-42-relay",
      ingressConnectIp: null,
      ingressReportedTunnels: reportWithEndpoint("tunex-42-relay", "172.31.20.10:53121"),
    });
    const afterRestart = datagramHopPeerFor({
      ingressRuntimeId: "tunex-42-relay",
      ingressConnectIp: null,
      // Same ingress, new runtime → new ephemeral port, same address.
      ingressReportedTunnels: reportWithEndpoint("tunex-42-relay", "172.31.20.10:60999"),
    });
    expect(afterRestart).toBe(first);
  });

  test("an IPv6 endpoint keeps its address and loses the bracket", () => {
    expect(
      datagramHopPeerFor({
        ingressRuntimeId: "tunex-42-relay",
        ingressConnectIp: null,
        ingressReportedTunnels: reportWithEndpoint("tunex-42-relay", "[fd00::10]:53121"),
      }),
    ).toBe("fd00::10");
  });

  test("no report yet (or no matching leg) falls back to connect_ip", () => {
    expect(
      datagramHopPeerFor({ ingressRuntimeId: "tunex-42-relay", ingressConnectIp: "172.31.10.20", ingressReportedTunnels: [] }),
    ).toBe("172.31.10.20");
    expect(
      datagramHopPeerFor({
        ingressRuntimeId: "tunex-42-relay",
        ingressConnectIp: "172.31.10.20",
        // A report that only knows about OTHER tunnels must not be mistaken for this one.
        ingressReportedTunnels: [{ id: "tunex-7-relay", diag: { hop_local_addr: "172.31.20.99:1" } }],
      }),
    ).toBe("172.31.10.20");
  });

  test("a leg whose diag has no endpoint yet also falls back", () => {
    expect(
      datagramHopPeerFor({
        ingressRuntimeId: "tunex-42-relay",
        ingressConnectIp: "172.31.10.20",
        ingressReportedTunnels: [{ id: "tunex-42-relay", diag: null }],
      }),
    ).toBe("172.31.10.20");
  });
});
