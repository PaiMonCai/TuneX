/**
 * V4-WP11C — Support Bundle 的**负向**测试。
 *
 * 每个用例都是"如果这条漏了会怎样"：产物会离开控制面（下载、贴工单、发邮件），
 * 泄漏不可撤回。因此断言写的是**产物里不得出现机密**，而不是"等于某个字段值"。
 */
import { describe, expect, test } from "bun:test";
import {
  BUNDLE_MAX_AUDIT,
  BUNDLE_MAX_BYTES,
  BUNDLE_MAX_FORWARDS,
  collectSupportBundle,
  finalizeBundle,
  type BundleNodeRow,
  type SupportBundleDeps,
} from "../support-bundle.ts";

function node(over: Partial<BundleNodeRow> = {}): BundleNodeRow {
  return {
    id: 3, node_id: "hk-in-01", agent_id: "81879c3a-7bc5-4be7-84cf-e4ac2dc2849c",
    role: "ingress", lifecycle: "active", status: "active", last_seen_at: new Date("2026-10-02T00:00:00Z"),
    port_range_min: 21000, port_range_max: 21099, lb_strategy: "round",
    group: { id: 9, name: "HK-IN" }, has_credential: true, credential_revoked: false,
    ...over,
  };
}

function deps(over: Partial<SupportBundleDeps> = {}): SupportBundleDeps {
  return {
    loadNode: async () => node(),
    loadStateReport: async () => ({
      version: "0.13.22", role: "INGRESS", control_protocol_version: 1,
      capabilities: ["apply_tunnel", "diagnose_tunnel"], reported_revision: 4, known_revision: 4,
      runtime_counts: { direct: 1, total: 2 }, host_metrics: { cpu_count: 8 },
      used_ports: [21001], error_count: 0, last_error: null, reported_at: new Date("2026-10-02T00:00:00Z"),
    }),
    loadForwards: async () => ([{
      id: 7, name: "fwd-a", mode: "direct", listen_port: 21001, target_host: "target-a", target_port: 3030,
      desired_status: "active", apply_status: "active", config_revision: 4, applied_revision: 4,
      apply_error_code: null, apply_error: null, ingress_node_id: 3, egress_node_id: null,
    }]),
    loadRollouts: async () => ([{
      id: 11, tunnel_id: 7, revision: 4, phase: "done", strategy: "target_hot_swap",
      last_error_code: null, updated_at: new Date("2026-10-02T00:00:00Z"),
    }]),
    loadAudit: async () => ([{
      id: 21, action: "node.lifecycle_changed", resource_type: "node", resource_id: "3",
      actor_user_id: 2, created_at: new Date("2026-10-02T00:00:00Z"),
    }]),
    panelVersion: "test",
    now: () => new Date("2026-10-02T00:00:00Z"),
    ...over,
  };
}

describe("whitelist collection", () => {
  test("includes the facts an operator needs to triage", async () => {
    const out = await collectSupportBundle(3, 11, deps(), { forwards: true, audit: true });
    if (!out.ok) throw new Error("expected a bundle");
    expect(out.bundle.node.agent_id).toBe("81879c3a-7bc5-4be7-84cf-e4ac2dc2849c");
    expect(out.bundle.state_report?.capabilities).toEqual(["apply_tunnel", "diagnose_tunnel"]);
    expect(out.bundle.forwards).toHaveLength(1);
    expect(out.bundle.rollouts).toHaveLength(1);
    expect(out.bundle.audit).toHaveLength(1);
    expect(out.bundle.panel_version).toBe("test");
  });

  test("never carries credential material, even if a collector hands it over", async () => {
    // A future collector that forgets to project: the redaction layer must still
    // remove the value. This is the defence the whitelist cannot provide.
    const out = await collectSupportBundle(3, 11, deps({
      // The collector hands over an extra field it was never asked for.
      loadNode: async () => ({ ...node(), node_credential_hash: "deadbeef".repeat(8) } as unknown as BundleNodeRow),
    }), { forwards: true, audit: true });
    if (!out.ok) throw new Error("expected a bundle");
    expect(out.json).not.toContain("deadbeefdeadbeef");
    // The state/structure facts survive: a bundle that says nothing is not evidence.
    expect(out.json).toContain("hk-in-01");
    expect(out.json).toContain("21001");
  });

  test("reports 'no report yet' instead of failing", async () => {
    const out = await collectSupportBundle(3, 11, deps({ loadStateReport: async () => null }), { forwards: true, audit: true });
    if (!out.ok) throw new Error("expected a bundle");
    expect(out.bundle.state_report).toBeNull();
    expect(out.bundle.notes.join(" ")).toContain("尚未上报");
  });

  test("a node outside the workspace is a 404, and no other section is read", async () => {
    let forwardsRead = false;
    const out = await collectSupportBundle(3, 11, deps({
      loadNode: async () => null,
      loadForwards: async () => { forwardsRead = true; return []; },
    }), { forwards: true, audit: true });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.status).toBe(404);
    expect(out.error_layer).toBe("resource_scope");
    expect(forwardsRead).toBe(false);
  });
});

describe("bounds are explicit, never silent", () => {
  test("oversized sections are truncated AND marked", async () => {
    const many = Array.from({ length: BUNDLE_MAX_FORWARDS + 10 }, (_v, i) => ({
      id: i + 1, name: `f${i}`, mode: "direct", listen_port: 21000 + i, target_host: "t", target_port: 1,
      desired_status: "active", apply_status: "active", config_revision: 1, applied_revision: 1,
      apply_error_code: null, apply_error: null, ingress_node_id: 3, egress_node_id: null,
    }));
    const out = await collectSupportBundle(3, 11, deps({ loadForwards: async () => many }), { forwards: true, audit: true });
    if (!out.ok) throw new Error("expected a bundle");
    expect(out.bundle.forwards).toHaveLength(BUNDLE_MAX_FORWARDS);
    expect(out.bundle.truncated?.forwards).toBe(true);
    expect(out.bundle.notes.join(" ")).toContain("已截断");
  });

  test("audit truncation is visible in the same way", async () => {
    const many = Array.from({ length: BUNDLE_MAX_AUDIT + 5 }, (_v, i) => ({
      id: i, action: "node.updated", resource_type: "node", resource_id: "3", actor_user_id: 2,
      created_at: new Date(),
    }));
    const out = await collectSupportBundle(3, 11, deps({ loadAudit: async () => many }), { forwards: true, audit: true });
    if (!out.ok) throw new Error("expected a bundle");
    expect(out.bundle.audit).toHaveLength(BUNDLE_MAX_AUDIT);
    expect(out.bundle.truncated?.audit).toBe(true);
  });

  test("an enormous bundle is capped in bytes and says what it dropped", () => {
    // Long *fields* are already shortened by the redaction layer, so the byte cap
    // is exercised with many short entries instead: this is the guard that
    // protects the export even if a collector ignores its own section cap.
    const huge = {
      schema_version: 1 as const, generated_at: "t", panel_version: null,
      node: node(), state_report: null,
      // Under the redaction layer's item cap, but each entry carries several long
      // fields: ~200 × 3KB after per-field truncation ≈ 600KB, over the byte cap.
      forwards: Array.from({ length: 200 }, (_v, i) => ({
        id: i, name: "n".repeat(1500), mode: "direct", listen_port: 21000 + (i % 100),
        target_host: "t".repeat(1500), target_port: 1, desired_status: "active", apply_status: "active",
        config_revision: 1, applied_revision: 1, apply_error_code: null, apply_error: "e".repeat(1500),
        ingress_node_id: 3, egress_node_id: null,
      })),
      rollouts: [], audit: [], truncated: null, notes: [],
    };
    const out = finalizeBundle(huge);
    if (!out.ok) throw new Error("expected a bundle");
    expect(out.bytes).toBeLessThanOrEqual(BUNDLE_MAX_BYTES);
    expect(out.bundle.notes.join(" ")).toContain("字节上限");
    expect(out.bundle.forwards).toEqual([]);
    // The facts a reader needs for triage survive the trim.
    expect(out.bundle.node.node_id).toBe("hk-in-01");
  });

  test("per-field truncation in the redaction layer already bounds long values", () => {
    // Documented interplay: a bundle of long strings never reaches the byte cap,
    // because each string is bounded first. Both bounds are deliberate.
    const long = {
      schema_version: 1 as const, generated_at: "t", panel_version: null,
      node: node({ node_id: "n".repeat(5000) }), state_report: null,
      forwards: [], rollouts: [], audit: [], truncated: null, notes: [],
    };
    const out = finalizeBundle(long);
    if (!out.ok) throw new Error("expected a bundle");
    expect(out.bundle.node.node_id.length).toBeLessThan(5000);
    expect(out.bundle.node.node_id).toContain("[truncated]");
    expect(out.bytes).toBeLessThanOrEqual(BUNDLE_MAX_BYTES);
  });

  test("an empty collection is not an error and is not marked truncated", async () => {
    const out = await collectSupportBundle(3, 11, deps({
      loadForwards: async () => [], loadRollouts: async () => [], loadAudit: async () => [],
    }), { forwards: true, audit: true });
    if (!out.ok) throw new Error("expected a bundle");
    expect(out.bundle.truncated).toBeNull();
    expect(out.bundle.forwards).toEqual([]);
  });
});

describe("only known secrets are removed by value", () => {
  test("a known credential is removed wherever it appears", async () => {
    const secret = "NODE-CRED-2f8a1c9e";
    const out = await collectSupportBundle(3, 11, deps(), { forwards: true, audit: true });
    if (!out.ok) throw new Error("expected a bundle");
    const withSecret = finalizeBundle(
      { ...out.bundle, notes: [`credential was ${secret}`] },
      { knownSecrets: [secret] },
    );
    if (!withSecret.ok) throw new Error("expected a bundle");
    expect(withSecret.json).not.toContain(secret);
  });
});

describe("cross-resource sections are permission-scoped", () => {
  test("a node-only reader gets no forward or audit detail, and is told why", async () => {
    let forwardsRead = false;
    let auditRead = false;
    const out = await collectSupportBundle(3, 11, deps({
      loadForwards: async () => { forwardsRead = true; return []; },
      loadAudit: async () => { auditRead = true; return []; },
    }), { forwards: false, audit: false });
    if (!out.ok) throw new Error("expected a bundle");
    // The collectors must not even run: reading then dropping is how a leak
    // becomes a timing side channel.
    expect(forwardsRead).toBe(false);
    expect(auditRead).toBe(false);
    expect(out.bundle.forwards).toEqual([]);
    expect(out.bundle.audit).toEqual([]);
    expect(out.bundle.notes.join(" ")).toContain("forward:read");
    expect(out.bundle.notes.join(" ")).toContain("audit:read");
    // The node's own facts are still there — that is what node:read authorizes.
    expect(out.bundle.node.node_id).toBe("hk-in-01");
  });
});

describe("the agent's own facts are a section, and their absence is explained", () => {
  const facts = {
    version: "0.13.22", role: "INGRESS", agent_id: "agent-x", node_id: "hk-in-01",
    runtime: { tunnel_count: 1, truncated: false, ports_total: 1, listen_ports: [21001], tunnels: [
      { id: "a", mode: "DIRECT", ingress_port: 21001, revision: 4, crosses_node: false },
    ] },
    state_dir: {
      path: "/var/lib/tunex-agent/desired-lkg.json", configured: true, dir_exists: true,
      cache_present: true, cache_valid: true,
    },
    process: {
      uptime_seconds: 60, started_at: "2026-10-03T00:00:00Z", go_version: "go1.27.1", os: "linux",
      arch: "amd64", cpu_count: 8, gomaxprocs: 8, goroutines: 10, heap_bytes: 100,
    },
    shutting_down: false,
  };

  test("a reachable node contributes its self report", async () => {
    const out = await collectSupportBundle(3, 11, deps({
      loadAgentFacts: async () => ({ ok: true as const, facts }),
    }), { forwards: true, audit: true });
    if (!out.ok) throw new Error("expected a bundle");
    expect(out.bundle.agent_facts?.runtime.tunnels[0].id).toBe("a");
    expect(out.bundle.agent_facts?.state_dir.cache_valid).toBe(true);
    expect(out.json).toContain("0.13.22");
  });

  test("an offline node still produces a bundle, and says why the section is missing", async () => {
    const out = await collectSupportBundle(3, 11, deps({
      loadAgentFacts: async () => ({ ok: false as const, error_code: "offline", message: "节点未在线" }),
    }), { forwards: true, audit: true });
    if (!out.ok) throw new Error("expected a bundle");
    // The panel-side facts must survive: a bundle for a dead node is exactly when
    // an operator needs it most.
    expect(out.bundle.node.node_id).toBe("hk-in-01");
    expect(out.bundle.forwards).toHaveLength(1);
    expect(out.bundle.agent_facts).toBeUndefined();
    expect(out.bundle.agent_facts_error?.error_code).toBe("offline");
    expect(out.bundle.notes.join(" ")).toContain("未包含节点自述事实");
  });

  test("a throwing collector cannot break the artefact", async () => {
    const out = await collectSupportBundle(3, 11, deps({
      loadAgentFacts: async () => { throw new Error("agent exploded"); },
    }), { forwards: true, audit: true });
    if (!out.ok) throw new Error("expected a bundle");
    expect(out.bundle.agent_facts_error?.error_code).toBe("agent_facts_failed");
    expect(out.bundle.node.node_id).toBe("hk-in-01");
  });
});
