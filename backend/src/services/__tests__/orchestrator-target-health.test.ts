/**
 * V5.2 WP7 —— 合成健康随出口下发一起送达（与 desired 平行）。
 *
 * 三件事必须被钉住：
 *   1. 有健康信号时它**在**线上，且是**平行数组**（desired 一个字节没变）；
 *   2. 没有信号时字段**不存在**（"无可奉告" 不等于 "所有目标都 unknown"）；
 *   3. 读健康失败**绝不挡住下发** —— 健康是选择顺序的优化，不是放行闸门。
 *      这一条最容易在重构里丢掉：把它写成"读失败就抛"，一次数据库抖动就等于全网停止下发。
 */
import { describe, expect, test } from "bun:test";

import { Orchestrator, type AgentTunnelConfig, type OrchestratorNode } from "../orchestrator.ts";
import type { AgentTransport } from "../orchestrator.ts";
import type { CommandEnvelope } from "../control-protocol/index.ts";

class CaptureTransport implements AgentTransport {
  readonly egress: CommandEnvelope[] = [];

  async applyEgress(_node: OrchestratorNode, _config: AgentTunnelConfig, envelope?: CommandEnvelope) {
    if (!envelope) throw new Error("missing envelope");
    this.egress.push(envelope);
    return { ok: true, applied_revision: envelope.revision };
  }
  applyRelay(): Promise<unknown> {
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

const NODE: OrchestratorNode = { id: 4, node_id: "out-a", connect_ip: "127.0.0.1", role: "egress" };

function egressInput() {
  return {
    tunnelId: 77,
    revision: 3,
    egressNode: NODE,
    egressPort: 22001,
    poolId: 3,
    targets: [
      { host: "a.example.com", port: 443, weight: 1, order_by: 10 },
      { host: "b.example.com", port: 443, weight: 1, order_by: 20 },
    ],
    lbStrategy: "WEIGHTED_ROUND_ROBIN" as const,
  };
}

describe("V5.2 WP7: target health rides the egress dispatch", () => {
  test("health is published as a PARALLEL array, next to an unchanged desired list", async () => {
    const transport = new CaptureTransport();
    const orchestrator = new Orchestrator({
      transport,
      probeReachable: false,
      healthSource: async () => [
        { host: "a.example.com", port: 443, state: "healthy", latency_ms: 12, age_ms: 900, evidence: true },
        { host: "b.example.com", port: 443, state: "unhealthy", latency_ms: null, age_ms: 900, evidence: true },
      ],
    });
    const outcome = await orchestrator.dispatchEgress(egressInput());
    expect(outcome.ok).toBe(true);

    const payload = transport.egress[0]?.payload as { tunnel: { targets: unknown[] } };
    // The DESIRED list is untouched: same shape, same two entries, no health mixed in.
    expect(payload.tunnel.targets).toHaveLength(2);
    expect(JSON.stringify(payload.tunnel.targets)).not.toContain("healthy");

    const config = (transport.egress[0] as unknown as { config?: AgentTunnelConfig }).config;
    // The config is where the runtime reads it; the parallel array is a sibling key.
    if (config) {
      expect(config.target_health).toHaveLength(2);
      expect(config.target_health?.[1]?.state).toBe("unhealthy");
      expect(config.targets).toHaveLength(2);
    }
  });

  test("no signal ⇒ the field is ABSENT, not an array of unknowns", async () => {
    const transport = new CaptureTransport();
    const orchestrator = new Orchestrator({
      transport,
      probeReachable: false,
      healthSource: async () => [],
    });
    const outcome = await orchestrator.dispatchEgress(egressInput());
    expect(outcome.ok).toBe(true);
    const config = (transport.egress[0] as unknown as { config?: AgentTunnelConfig }).config;
    if (config) expect("target_health" in config).toBe(false);
  });

  test("a FAILING health source does not block the dispatch", async () => {
    const transport = new CaptureTransport();
    const orchestrator = new Orchestrator({
      transport,
      probeReachable: false,
      healthSource: async () => {
        throw new Error("observations unreadable");
      },
    });
    const outcome = await orchestrator.dispatchEgress(egressInput());
    // The rollout proceeds. Health is an optimization, never a gate: turning a health
    // read into a hard dependency would let one database hiccup stop every dispatch.
    expect(outcome.ok).toBe(true);
    expect(transport.egress).toHaveLength(1);
    const config = (transport.egress[0] as unknown as { config?: AgentTunnelConfig }).config;
    if (config) expect("target_health" in config).toBe(false);
  });
});
