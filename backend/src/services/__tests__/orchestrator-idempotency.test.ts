import { describe, expect, test } from "bun:test";

import {
  Orchestrator,
  type AgentTransport,
  type OrchestratorNode,
} from "../orchestrator.ts";
import type { CommandEnvelope } from "../control-protocol/index.ts";

class CaptureTransport implements AgentTransport {
  readonly removes: CommandEnvelope[] = [];

  applyEgress(): Promise<unknown> {
    throw new Error("unused");
  }
  applyRelay(): Promise<unknown> {
    throw new Error("unused");
  }
  applyDirect(): Promise<unknown> {
    throw new Error("unused");
  }
  async removeTunnel(
    _node: OrchestratorNode,
    _tunnelId: string,
    envelope?: CommandEnvelope,
  ): Promise<unknown> {
    if (!envelope) throw new Error("missing envelope");
    this.removes.push(envelope);
    return { ok: true, applied_revision: envelope.revision };
  }
  async isReachable(): Promise<boolean> {
    return true;
  }
}

describe("Orchestrator remove command idempotency", () => {
  test("same remove intent reuses command_id; different intent on same revision gets a distinct id", async () => {
    const transport = new CaptureTransport();
    const orchestrator = new Orchestrator({ transport, probeReachable: false });
    const node: OrchestratorNode = {
      id: 7,
      node_id: "node-7",
      connect_ip: "127.0.0.1",
      role: "ingress",
    };

    const base = {
      tunnelId: 42,
      node,
      direction: "direct" as const,
      revision: 8,
    };

    const first = await orchestrator.removeTunnel({
      ...base,
      reason: "rollout 12 compensation",
    });
    const retry = await orchestrator.removeTunnel({
      ...base,
      reason: "rollout 12 compensation",
    });
    const suspend = await orchestrator.removeTunnel({
      ...base,
      reason: "manual suspend",
    });

    expect(first.ok).toBe(true);
    expect(retry.ok).toBe(true);
    expect(suspend.ok).toBe(true);
    expect(transport.removes).toHaveLength(3);

    const [a, b, c] = transport.removes.map((x) => x.command_id);
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(a.length).toBeLessThanOrEqual(64);
    expect(c.length).toBeLessThanOrEqual(64);
  });

  test("equal-revision remove with a new intent survives the local ACK round-trip", async () => {
    const transport = new CaptureTransport();
    const orchestrator = new Orchestrator({ transport, probeReachable: false });
    const node: OrchestratorNode = {
      id: 9,
      node_id: "node-9",
      connect_ip: "127.0.0.1",
      role: "ingress",
    };

    const first = await orchestrator.removeTunnel({
      tunnelId: 5,
      node,
      direction: "direct",
      revision: 4,
      reason: "cleanup A",
    });
    const second = await orchestrator.removeTunnel({
      tunnelId: 5,
      node,
      direction: "direct",
      revision: 4,
      reason: "suspend B",
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.error);
    expect(second.result.ack.error_code).toBeUndefined();
  });
});


class MalformedAckTransport extends CaptureTransport {
  constructor(private readonly response: unknown) {
    super();
  }

  override async removeTunnel(
    _node: OrchestratorNode,
    _tunnelId: string,
    envelope?: CommandEnvelope,
  ): Promise<unknown> {
    if (!envelope) throw new Error("missing envelope");
    this.removes.push(envelope);
    return this.response;
  }
}

describe("Orchestrator agent ACK contract", () => {
  const node: OrchestratorNode = {
    id: 11,
    node_id: "node-11",
    connect_ip: "127.0.0.1",
    role: "ingress",
  };

  test("an object response without explicit ok:true is rejected, not treated as legacy success", async () => {
    const orchestrator = new Orchestrator({
      transport: new MalformedAckTransport({ revision: 4, error: "old error shape" }),
      probeReachable: false,
    });

    const outcome = await orchestrator.removeTunnel({
      tunnelId: 5,
      node,
      direction: "direct",
      revision: 4,
      reason: "cleanup",
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected malformed ACK to fail");
    expect(outcome.error_code).toBe("ack_invalid");
  });

  test("an invalid applied revision is rejected as ack_invalid rather than agent_unreachable", async () => {
    const orchestrator = new Orchestrator({
      transport: new MalformedAckTransport({ ok: true, applied_revision: -1 }),
      probeReachable: false,
    });

    const outcome = await orchestrator.removeTunnel({
      tunnelId: 6,
      node,
      direction: "direct",
      revision: 4,
      reason: "cleanup",
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected malformed ACK to fail");
    expect(outcome.error_code).toBe("ack_invalid");
  });
});
