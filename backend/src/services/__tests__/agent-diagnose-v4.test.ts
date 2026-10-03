/**
 * V4-WP11C — 诊断服务编排与能力闸门。
 *
 * 这里钉三件事：
 *   1. 能力未上报 / 未实现时**不发命令**，直接给出升级提示（否则节点只会回
 *      unsupported_action，面板把超时误诊成网络故障）；
 *   2. 结论与"下一步"来自真实结果，且区分 DNS / 拒绝 / 超时（不同措辞对应
 *      不同的修法）；
 *   3. 结果过关卡：只读、有界、且经脱敏层。
 */
import { describe, expect, test } from "bun:test";
import { diagnoseForward, nextStepFor, summarizeSegment, type DiagnoseDeps, type ForwardForDiagnose } from "../agent-diagnose.ts";

const relayForward: ForwardForDiagnose = {
  id: 7, mode: "relay",
  ingress_node_id: 3, ingress_node_key: "IN-A", ingress_connect_ip: "172.31.10.20",
  egress_node_id: 4, egress_node_key: "OUT-A", egress_connect_ip: "172.31.20.20", egress_port: 22001,
  remote_host: "10.9.9.9", remote_port: 8080, config_revision: 4,
  pool_targets: [{ host: "10.9.9.9", port: 8080 }],
};

function deps(over: Partial<DiagnoseDeps> = {}): DiagnoseDeps & { issued: unknown[] } {
  const issued: unknown[] = [];
  const base = {
    issued,
    loadForward: async () => relayForward,
    loadCapability: async () => ({ capabilities: ["apply_tunnel", "diagnose_tunnel"], protocolVersion: 1 }),
    loadNodeRuntimeFacts: async () => ({ reported: true, runtime_present: true, runtime_revision: 4, listener_port: 22001 }),
    issueDiagnose: async (input: { targets: { host: string; port: number }[] }) => {
      issued.push(input);
      return { ok: true as const, results: input.targets.map((t) => ({ host: t.host, port: t.port, status: "reachable", elapsed_ms: 4 })) };
    },
    now: () => new Date("2026-10-02T00:00:00Z"),
  };
  return { ...base, ...over } as DiagnoseDeps & { issued: unknown[] };
}

describe("capability gate", () => {
  test("a node that never advertised diagnose is not sent a command", async () => {
    const d = deps({ loadCapability: async () => ({ capabilities: null, protocolVersion: null }) });
    const out = await diagnoseForward(7, 11, d);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(d.issued).toHaveLength(0);
    // Facts need no command, so that segment still answers; only the probe is refused.
    const probe = out.report.segments.find((seg) => seg.method === "tcp_probe")!;
    expect(probe.outcome).toBe("unsupported");
    expect(probe.error_code).toBe("upgrade_required");
    expect(out.report.segments.find((seg) => seg.method === "node_facts")!.outcome).toBe("ok");
    expect(out.report.next_step).toContain("升级");
  });

  test("an agent that reported a short list is refused for this action only", async () => {
    const d = deps({ loadCapability: async () => ({ capabilities: ["apply_tunnel"], protocolVersion: 1 }) });
    const out = await diagnoseForward(7, 11, d);
    if (!out.ok) throw new Error("expected a report");
    expect(d.issued).toHaveLength(0);
    expect(out.report.segments.find((seg) => seg.method === "tcp_probe")!.capability!.actions).toEqual(["apply_tunnel"]);
  });

  test("relay: one dial-free facts segment plus one egress probe, and no business dial", async () => {
    const d = deps();
    const out = await diagnoseForward(7, 11, d);
    if (!out.ok) throw new Error("expected a report");
    // Only the egress→target probe is issued; the ingress→egress path is checked
    // from state facts, never dialled.
    expect(d.issued).toHaveLength(1);
    expect(out.report.segments.map((s) => s.segment)).toEqual(["ingress_to_egress", "egress_to_target"]);
    const [facts, probe] = out.report.segments;
    expect(facts.method).toBe("node_facts");
    expect(facts.verified).toBe(false);
    expect(facts.outcome).toBe("ok");
    expect(probe.method).toBe("tcp_probe");
    expect(probe.outcome).toBe("ok");
    // The report must not claim the unverified hop was proven.
    expect(JSON.stringify(out.report)).not.toContain("\"reachable\",\"host\":\"172.31.20.20");
  });

  test("relay facts: a missing runtime is a failure with actionable text", async () => {
    const d = deps({
      loadNodeRuntimeFacts: async (input: { nodeId: number }) =>
        input.nodeId === 4
          ? { reported: true, runtime_present: false, runtime_revision: null, listener_port: null }
          : { reported: true, runtime_present: true, runtime_revision: 4, listener_port: 21001 },
    });
    const out = await diagnoseForward(7, 11, d);
    if (!out.ok) throw new Error("expected a report");
    expect(out.report.segments[0].outcome).toBe("failed");
    expect(out.report.segments[0].error_code).toBe("runtime_missing");
    expect(out.report.next_step).toContain("出口节点");
  });

  test("relay facts: a node that never reported stays 'unknown', not 'ok'", async () => {
    const d = deps({
      loadNodeRuntimeFacts: async () => ({ reported: false, runtime_present: false, runtime_revision: null, listener_port: null }),
    });
    const out = await diagnoseForward(7, 11, d);
    if (!out.ok) throw new Error("expected a report");
    expect(out.report.segments[0].outcome).toBe("unknown");
    expect(out.report.segments[0].verified).toBe(false);
    expect(out.report.next_step).toContain("未验证");
    // Never presented as a working path.
    expect(out.report.next_step).not.toContain("可达");
  });
});

describe("scope and planning failures", () => {
  test("a forward outside the workspace is a 404, not a probe", async () => {
    const d = deps({ loadForward: async () => null });
    const out = await diagnoseForward(7, 11, d);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.status).toBe(404);
    expect(out.error_layer).toBe("resource_scope");
    expect(d.issued).toHaveLength(0);
  });

  test("a relay without a configured hop is still diagnosable from facts", async () => {
    // The hop address is display-only now (dialling it would hit the business
    // listener), so its absence must not block the facts check or the egress probe.
    const d = deps({ loadForward: async () => ({ ...relayForward, egress_connect_ip: null, egress_port: null }) });
    const out = await diagnoseForward(7, 11, d);
    if (!out.ok) throw new Error("expected a report");
    expect(out.report.segments[0].facts?.hop).toBeNull();
    expect(out.report.segments[0].outcome).toBe("ok");
  });

  test("a relay with no egress node at all is a 409", async () => {
    const d = deps({ loadForward: async () => ({ ...relayForward, egress_node_id: null }) });
    const out = await diagnoseForward(7, 11, d);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.status).toBe(409);
    expect(out.code).toBe("no_egress_runtime");
    expect(out.error_layer).toBe("runtime_admission");
  });
});

describe("transient failures are reported, not thrown", () => {
  test("an ACK timeout marks only that segment failed", async () => {
    const d = deps({
      issueDiagnose: async (input: { targets: { host: string; port: number }[]; resourceId: string }) =>
        input.resourceId.endsWith("-egress")
          ? { ok: false as const, error_code: "ack_timeout", error: "等待 Agent ACK 超时" }
          : { ok: true as const, results: [{ host: "172.31.20.20", port: 22001, status: "reachable", elapsed_ms: 3 }] },
    });
    const out = await diagnoseForward(7, 11, d);
    if (!out.ok) throw new Error("expected a report");
    expect(out.report.segments[0].outcome).toBe("ok");
    expect(out.report.segments[1].outcome).toBe("failed");
    expect(out.report.segments[1].error_code).toBe("ack_timeout");
    expect(out.report.next_step).toContain("未能");
  });
});

describe("next step guidance", () => {
  const segment = (over: Record<string, unknown>) => ([{
    segment: "ingress_to_target" as const, method: "tcp_probe" as const, verified: true,
    node_id: 3, node_key: "IN-A",
    capability: { advertised: true, actions: ["diagnose_tunnel"] },
    targets: [{ host: "target-a", port: 3030 }], results: [], outcome: "failed" as const, ...over,
  }]);

  test("distinguishes dns / refused / timeout advice", () => {
    const dns = nextStepFor(segment({ outcome: "unreachable", results: [{ host: "x", port: 1, status: "dns_error", elapsed_ms: 1 }] }), "direct");
    const refused = nextStepFor(segment({ outcome: "unreachable", results: [{ host: "x", port: 1, status: "refused", elapsed_ms: 1 }] }), "direct");
    const timeout = nextStepFor(segment({ outcome: "unreachable", results: [{ host: "x", port: 1, status: "timeout", elapsed_ms: 1 }] }), "direct");
    expect(dns).toContain("解析");
    expect(refused).toContain("拒绝");
    expect(timeout).toContain("超时");
    // The three must not be the same sentence: identical advice for different
    // causes is how a diagnostic becomes useless.
    expect(new Set([dns, refused, timeout]).size).toBe(3);
  });

  test("an unverified hop is never presented as confirmed reachable", () => {
    const advice = nextStepFor([{
      segment: "ingress_to_egress", method: "node_facts" as const, verified: false,
      node_id: 3, node_key: "IN-A",
      targets: [], results: [], outcome: "unknown",
    }], "relay");
    expect(advice).toContain("未验证");
    expect(advice).not.toContain("可达");
  });

  test("an all-reachable report says so without overclaiming", () => {
    const advice = nextStepFor(segment({ outcome: "ok", results: [{ host: "x", port: 1, status: "reachable", elapsed_ms: 1 }] }), "direct");
    expect(advice).toContain("可达");
    // A TCP handshake is not an application success: the text must not promise it.
    expect(advice).not.toContain("业务正常");
  });

  test("summarizeSegment is exhaustive over the status vocabulary", () => {
    expect(summarizeSegment([])).toBe("failed");
    expect(summarizeSegment([{ host: "h", port: 1, status: "reachable", elapsed_ms: 1 }])).toBe("ok");
    for (const status of ["refused", "timeout", "dns_error"]) {
      expect(summarizeSegment([{ host: "h", port: 1, status, elapsed_ms: 1 }])).toBe("unreachable");
    }
    // A mixed list reports the worst fact, never "ok".
    expect(summarizeSegment([
      { host: "a", port: 1, status: "reachable", elapsed_ms: 1 },
      { host: "b", port: 2, status: "refused", elapsed_ms: 1 },
    ])).toBe("unreachable");
  });
});

describe("results are bounded and redacted", () => {
  test("an oversized result list is truncated to the cap, and secrets never appear", async () => {
    const many = Array.from({ length: 20 }, (_v, i) => ({ host: `10.0.0.${i}`, port: 9000 + i, status: "reachable", elapsed_ms: 1 }));
    const d = deps({
      issueDiagnose: async () => ({ ok: true as const, results: [...many, { host: "x", port: 1, status: "reachable", elapsed_ms: 1, detail: "token=CANARY-1234" } as never] }),
    });
    const out = await diagnoseForward(7, 11, d);
    if (!out.ok) throw new Error("expected a report");
    for (const s of out.report.segments) expect(s.results.length).toBeLessThanOrEqual(8);
    expect(JSON.stringify(out.report)).not.toContain("CANARY-1234");
  });
});
