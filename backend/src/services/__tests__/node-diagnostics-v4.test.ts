/**
 * V4-WP11C — Node 级诊断的编排。
 *
 * 两个必须成立的性质：
 *   1. **离线先判活**：过期上报 → 立刻结构化 `offline`，一条命令都不下发（不能
 *      让用户对一台掉线的机器等 20 秒超时）；
 *   2. **能力未上报不下发**：老 Agent 只会回 unsupported_action，那会被读成故障。
 */
import { describe, expect, test } from "bun:test";
import {
  NODE_OFFLINE_AFTER_SECONDS,
  collectNodeDiagnostics,
  nodeNextStep,
  type NodeDiagnosticsDeps,
  type NodePanelFacts,
} from "../node-diagnostics.ts";
import type { NodeSelfFacts } from "../agent-command-bus.ts";

function panelFacts(over: Partial<NodePanelFacts> = {}): NodePanelFacts {
  return {
    id: 3, node_id: "hk-in-01", agent_id: "agent-x", role: "ingress", lifecycle: "active", status: "active",
    last_seen_at: "2026-10-03T00:00:00.000Z",
    reported: {
      version: "0.13.22", role: "INGRESS", control_protocol_version: 1,
      capabilities: ["apply_tunnel", "collect_diagnostics"],
      reported_revision: 4, known_revision: 4,
      reported_at: "2026-10-03T00:00:00.000Z", age_seconds: 5,
      last_error: null, error_count: 0,
    },
    forwards: { total: 2, active: 2, pending: 0, failed: 0, unconverged: 0 },
    ...over,
  };
}

function selfFacts(over: Partial<NodeSelfFacts> = {}): NodeSelfFacts {
  return {
    version: "0.13.22", role: "INGRESS", agent_id: "agent-x", node_id: "hk-in-01",
    runtime: { tunnel_count: 2, truncated: false, ports_total: 2, listen_ports: [21001, 21002], tunnels: [
      { id: "a", mode: "DIRECT", ingress_port: 21001, revision: 4, crosses_node: false },
      { id: "b", mode: "RELAY", ingress_port: 21002, revision: 4, crosses_node: true },
    ] },
    state_dir: {
      path: "/var/lib/tunex-agent/desired-lkg.json", configured: true, dir_exists: true,
      cache_present: true, cache_mod_time: "2026-10-03T00:00:00Z", cache_valid: true,
    },
    process: {
      uptime_seconds: 600, started_at: "2026-10-02T23:50:00Z", go_version: "go1.27.1", os: "linux",
      arch: "amd64", cpu_count: 8, gomaxprocs: 8, goroutines: 24, heap_bytes: 1024,
    },
    shutting_down: false,
    ...over,
  };
}

function deps(over: Partial<NodeDiagnosticsDeps> = {}) {
  const calls: { nodeId: number }[] = [];
  const base: NodeDiagnosticsDeps = {
    loadPanelFacts: async () => panelFacts(),
    loadCapability: async () => ({ capabilities: ["apply_tunnel", "collect_diagnostics"], protocolVersion: 1 }),
    collectAgentFacts: async (input) => {
      calls.push({ nodeId: input.nodeId });
      return { ok: true as const, facts: selfFacts() };
    },
    now: () => new Date("2026-10-03T00:00:05Z"),
  };
  return { deps: { ...base, ...over }, calls };
}

describe("an offline node is determined before anything is dispatched", () => {
  test("a stale report returns offline and sends no command", async () => {
    const { deps: d, calls } = deps({
      loadPanelFacts: async () => panelFacts({
        reported: { ...panelFacts().reported!, age_seconds: NODE_OFFLINE_AFTER_SECONDS + 30 },
      }),
    });
    const out = await collectNodeDiagnostics(3, 11, d);
    if (!out.ok) throw new Error("expected a report");
    expect(out.report.reachability).toBe("offline");
    expect(out.report.agent_facts).toBeNull();
    // The whole point: no 12-second wait for a machine that is gone.
    expect(calls).toHaveLength(0);
    expect(out.report.next_step).toContain("没有上报");
  });

  test("a node that never reported is 'unknown', not 'offline'", async () => {
    const { deps: d, calls } = deps({ loadPanelFacts: async () => panelFacts({ reported: null }) });
    const out = await collectNodeDiagnostics(3, 11, d);
    if (!out.ok) throw new Error("expected a report");
    expect(out.report.reachability).toBe("unknown");
    expect(calls).toHaveLength(0);
    expect(out.report.next_step).toContain("还没有上报");
  });

  test("a fresh report is online and is actually asked", async () => {
    const { deps: d, calls } = deps();
    const out = await collectNodeDiagnostics(3, 11, d);
    if (!out.ok) throw new Error("expected a report");
    expect(out.report.reachability).toBe("online");
    expect(calls).toHaveLength(1);
    expect(out.report.agent_facts?.process.uptime_seconds).toBe(600);
    expect(out.report.agent_facts?.state_dir.cache_valid).toBe(true);
  });
});

describe("capability negotiation gates the ask", () => {
  test("an agent that never advertised the action is not asked", async () => {
    const { deps: d, calls } = deps({ loadCapability: async () => ({ capabilities: ["apply_tunnel"], protocolVersion: 1 }) });
    const out = await collectNodeDiagnostics(3, 11, d);
    if (!out.ok) throw new Error("expected a report");
    expect(calls).toHaveLength(0);
    expect(out.report.agent_facts_error?.error_code).toBe("upgrade_required");
    expect(out.report.next_step).toContain("升级");
    // Panel-side facts are still returned: an old agent is not a blind spot.
    expect(out.report.panel.forwards.total).toBe(2);
  });

  test("a null advertisement (old agent) is refused the same way", async () => {
    const { deps: d, calls } = deps({ loadCapability: async () => ({ capabilities: null, protocolVersion: null }) });
    const out = await collectNodeDiagnostics(3, 11, d);
    if (!out.ok) throw new Error("expected a report");
    expect(calls).toHaveLength(0);
    expect(out.report.agent_facts_error?.error_code).toBe("upgrade_required");
  });
});

describe("transient failures are reported, never thrown", () => {
  test("an ACK timeout keeps the panel-side facts and explains the wait", async () => {
    const { deps: d } = deps({
      collectAgentFacts: async () => ({ ok: false as const, error_code: "ack_timeout", error: "等待 Agent ACK 超时" }),
    });
    const out = await collectNodeDiagnostics(3, 11, d);
    if (!out.ok) throw new Error("expected a report");
    expect(out.report.agent_facts).toBeNull();
    expect(out.report.agent_facts_error?.error_code).toBe("ack_timeout");
    expect(out.report.next_step).toContain("稍后重试");
    expect(out.report.panel.forwards.active).toBe(2);
  });

  test("a node outside the workspace is a 404 and nothing is read further", async () => {
    let asked = false;
    const { deps: d } = deps({
      loadPanelFacts: async () => null,
      collectAgentFacts: async () => { asked = true; return { ok: true as const, facts: selfFacts() }; },
    });
    const out = await collectNodeDiagnostics(3, 11, d);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.status).toBe(404);
    expect(out.error_layer).toBe("resource_scope");
    expect(asked).toBe(false);
  });
});

describe("next step comes from the facts", () => {
  const base = (facts: NodeSelfFacts | null, over: Partial<NodePanelFacts> = {}) => ({
    node_id: 3, node_key: "hk-in-01", generated_at: "t", reachability: "online" as const,
    agent_facts: facts, agent_facts_error: null, panel: panelFacts(over), next_step: null,
  });

  test("a draining node says so", () => {
    expect(nodeNextStep(base(selfFacts({ shutting_down: true })))).toContain("排空");
  });

  test("a missing LKG cache is called out (it breaks outage recovery)", () => {
    const facts = selfFacts();
    facts.state_dir = { ...facts.state_dir, cache_present: false, cache_valid: false };
    expect(nodeNextStep(base(facts))).toContain("已知良好状态缓存");
  });

  test("an invalid cache is distinguished from a missing one", () => {
    const facts = selfFacts();
    facts.state_dir = { ...facts.state_dir, cache_present: true, cache_valid: false };
    const advice = nodeNextStep(base(facts));
    expect(advice).toContain("未通过校验");
    expect(advice).not.toContain("还没有");
  });

  test("unconverged forwards are reported with a count", () => {
    const advice = nodeNextStep(base(selfFacts(), { forwards: { total: 3, active: 2, pending: 1, failed: 0, unconverged: 1 } }));
    expect(advice).toContain("1 条转发尚未收敛");
  });

  test("a healthy node gets no invented advice", () => {
    expect(nodeNextStep(base(selfFacts()))).toBeNull();
  });

  test("a truncated runtime list is disclosed, not silently shortened", () => {
    const facts = selfFacts();
    facts.runtime = { ...facts.runtime, truncated: true };
    expect(nodeNextStep(base(facts))).toContain("上限");
  });
});
