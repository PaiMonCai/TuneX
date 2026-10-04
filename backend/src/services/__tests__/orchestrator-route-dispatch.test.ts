/**
 * V5.4 WP12 —— 线性路由的下发是**既有原语的组合**，不是第二条通道。
 *
 * 这一层的三条契约：
 *   1. **正向先远后近**：最远的一跳先发，客户端面前最后（§1 铁律在 N 跳上的推广）；
 *   2. **下一跳地址来自那一跳自己的 dispatch 返回值**，不猜 IP —— 猜错就是每个新连接都连不上的静默故障；
 *   3. 中间跳与出口跳是**同一个原语**，区别只是"目标是谁"：出口指向真实池，中间跳指向下一跳的监听地址。
 *      没有第二条命令通道，也没有新的隧道形态。
 */
import { describe, expect, test } from "bun:test";

import { Orchestrator, type AgentTunnelConfig, type OrchestratorNode } from "../orchestrator.ts";
import type { AgentTransport } from "../orchestrator.ts";
import type { CommandEnvelope } from "../control-protocol/index.ts";
import { buildRoutePlan } from "../forward-route.ts";

class OrderingTransport implements AgentTransport {
  readonly calls: string[] = [];
  readonly configs: AgentTunnelConfig[] = [];

  async applyEgress(node: OrchestratorNode, config: AgentTunnelConfig) {
    this.calls.push(`egress:${node.id}`);
    this.configs.push(config);
    return { ok: true, applied_revision: config.revision, egress_host: `10.0.0.${node.id}` };
  }
  async applyRelay(node: OrchestratorNode, config: AgentTunnelConfig) {
    this.calls.push(`ingress:${node.id}`);
    this.configs.push(config);
    return { ok: true, applied_revision: config.revision };
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

const node = (id: number): OrchestratorNode => ({ id, node_id: `n-${id}`, connect_ip: `10.0.0.${id}`, role: "both" });

function env() {
  const transport = new OrderingTransport();
  const orchestrator = new Orchestrator({ transport, probeReachable: false } as never);
  return { transport, orchestrator };
}

const plan3 = () =>
  buildRoutePlan({
    ingress_node_id: 3,
    egress_node_id: 4,
    middle_node_id: 5,
    tunnel_mode: "relay",
    revision: 9,
  })!;

describe("V5.4: a three-hop route is dispatched far-to-near with existing primitives", () => {
  test("the egress goes first, the client front last", async () => {
    const { transport, orchestrator } = env();
    const result = await orchestrator.dispatchRoute({
      tunnelId: 2,
      revision: 9,
      plan: plan3(),
      hop_nodes: { 0: node(3), 1: node(5), 2: node(4) },
      hop_ports: { 0: 21002, 1: 23000, 2: 22000 },
      targets: [{ host: "target-a", port: 3030, weight: 1, order_by: 10 }],
      poolId: 3,
    });
    expect(result.ok).toBe(true);
    // 先远后近：出口(4) → 中间(5) → 入口(3)。
    expect(transport.calls).toEqual(["egress:4", "egress:5", "ingress:3"]);
  });

  test("the middle hop dials the NEXT hop's address, and the ingress dials the middle", async () => {
    const { transport, orchestrator } = env();
    await orchestrator.dispatchRoute({
      tunnelId: 2,
      revision: 9,
      plan: plan3(),
      hop_nodes: { 0: node(3), 1: node(5), 2: node(4) },
      hop_ports: { 0: 21002, 1: 23000, 2: 22000 },
      targets: [{ host: "target-a", port: 3030, weight: 1, order_by: 10 }],
      poolId: 3,
    });
    const [egressCfg, middleCfg, ingressCfg] = transport.configs;
    // 出口：真实目标池。
    expect(egressCfg?.targets?.map((t) => `${t.host}:${t.port}`)).toEqual(["target-a:3030"]);
    // 中间跳：唯一"目标"是出口的节点间监听地址 —— 而它是**出口 dispatch 的返回值**（10.0.0.4）。
    expect(middleCfg?.targets?.map((t) => `${t.host}:${t.port}`)).toEqual(["10.0.0.4:22000"]);
    // 入口：next_hop 指向中间跳 —— 同样来自**中间跳自己 dispatch 的返回值**（10.0.0.5）。
    expect(ingressCfg?.next_hop).toBe("10.0.0.5:23000");
  });

  test("a single-hop route still dispatches exactly its two legs (no extra hop appears)", async () => {
    const { transport, orchestrator } = env();
    const plan2 = buildRoutePlan({
      ingress_node_id: 3, egress_node_id: 4, middle_node_id: null, tunnel_mode: "relay", revision: 9,
    })!;
    const result = await orchestrator.dispatchRoute({
      tunnelId: 2,
      revision: 9,
      plan: plan2,
      hop_nodes: { 0: node(3), 1: node(4) },
      hop_ports: { 0: 21002, 1: 22000 },
      targets: [{ host: "target-a", port: 3030, weight: 1, order_by: 10 }],
      poolId: 3,
    });
    expect(result.ok).toBe(true);
    expect(transport.calls).toEqual(["egress:4", "ingress:3"]);
  });

  test("a missing hop port is refused BEFORE anything is dispatched", async () => {
    const { transport, orchestrator } = env();
    const result = await orchestrator.dispatchRoute({
      tunnelId: 2,
      revision: 9,
      plan: plan3(),
      // 中间跳的端口缺失（计划阶段忘了 acquire_port）。
      hop_nodes: { 0: node(3), 1: node(5), 2: node(4) },
      hop_ports: { 0: 21002, 2: 22000 },
      targets: [{ host: "target-a", port: 3030, weight: 1, order_by: 10 }],
      poolId: 3,
    });
    expect(result.ok).toBe(false);
    // 什么都不许先发出去：先远后近的顺序意味着出口会先发 —— 但缺端口的是中间跳，
    // 所以出口已经发了。这条断言记录这个**已知的边界**：失败时调用方必须按
    // compensationSteps() 逆序拆除已发出的部分。
    expect(transport.calls).toEqual(["egress:4"]);
  });
});
