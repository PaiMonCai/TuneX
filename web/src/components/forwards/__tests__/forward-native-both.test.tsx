import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/providers";
import { getDictionary } from "@/lib/i18n";
import { forwardProductStatus } from "@/lib/forward-status";
import { FORWARD_PROTOCOL_SPECS, forwardProtocolFields, forwardProtocolLabel, forwardProtocolSupported,
  forwardTransportFor, forwardTransportLifecycle, tlsPathFieldErrors } from "@/lib/forward-protocol";
import { FORWARD_NATIVE_BOTH_CAPABILITY, nativeBothBlock, nativeBothNodeEligible,
  nativeBothTransitionAllowed, projectForwardCapabilities, withForwardRuntimeCapabilities } from "@/lib/forward-native-both";
import { forwardCopyCreateInput, forwardCopyDraft } from "../forward-copy";
import { changeForwardCreateProtocol, emptyForwardCreateDraft } from "../forward-create-model";
import { draftToPatch, mixedReplaceNote, forwardRunningState } from "../forward-edit-dialog";
import { ForwardProtocolBadge } from "../forward-protocol-badge";
import { ForwardPolicyFields } from "../forward-policy-fields";
import { ForwardPathPreview } from "../forward-path-preview";
import { buildForwardPathPreview } from "../forward-path-model";
import { ForwardDiagnoseReportView } from "../forward-diagnose";
import { ForwardTopologyPanel } from "../forward-topology";
import { handleMock } from "@/mocks/handler";
import { getStore, resetStore } from "@/mocks/state";
import { mockUserNode } from "@/mocks/runtime";
import type { DiagnoseReport, NodeDiagnosticsReport, PortForward, UserNode } from "@/lib/types";
import type { ForwardTopology } from "@/lib/api/forwards";

const node = (id = 1, role: UserNode["role"] = "ingress", capabilities: string[] | null = [FORWARD_NATIVE_BOTH_CAPABILITY]) =>
  ({ id, node_id: `local-${id}`, role, accepts_new_business: true, capabilities, capabilities_fresh: true, connect_ip: "127.0.0.1" } as UserNode);
const rule = (over: Partial<PortForward> = {}) => ({ id: 40, name: "native local", protocol: "both", protocol_supported: true,
  mode: "direct", ingress_node_id: 1, egress_node_id: null, listen_port: 25000, target_host: "127.0.0.1", target_port: 9000,
  tls_cert_path: null, tls_key_path: null, config_revision: 7, applied_revision: 6, latest_revision: 7, apply_status: "pending",
  bytes_per_second_in: 1234, bytes_per_second_out: 5678, max_connections: 9, max_connections_per_ip: 2, ...over } as PortForward);
function render(content: React.ReactNode, locale: "zh" | "en" = "en") {
  return renderToStaticMarkup(<I18nProvider locale={locale} dict={getDictionary(locale)}>{content}</I18nProvider>);
}

describe("native plain Forward both contract and rollout", () => {
  test("known fact is mixed/connection_and_mapping with no legacy projection", () => {
    expect(FORWARD_PROTOCOL_SPECS.both).toEqual({ transport: "mixed", legacy_tunnel_type: null });
    expect(forwardTransportFor("both")).toBe("mixed");
    expect(forwardTransportLifecycle("both")).toBe("connection_and_mapping");
    expect(forwardProtocolSupported("both")).toBe(true);
    expect(forwardProtocolLabel("both")).toBe("TCP + UDP");
    expect(forwardProtocolSupported("wss")).toBe(false);
  });
  test("flag response requires a real boolean; malformed is unknown, not off/on", () => {
    expect(projectForwardCapabilities({ native_both_enabled: false })).toEqual({ native_both_enabled: false });
    expect(projectForwardCapabilities({ native_both_enabled: true, secret: "discard" })).toEqual({ native_both_enabled: true });
    for (const raw of [null, {}, { native_both_enabled: "true" }, { data: { native_both_enabled: true } }]) {
      expect(() => projectForwardCapabilities(raw)).toThrow();
    }
  });
  test("actual native advertisement is mandatory, never TCP plus UDP fallback", () => {
    for (const capabilities of [null, [], ["forward.protocol.tcp.v1", "forward.protocol.udp.v1"], ["forward.protocol.both.native.v2"]]) {
      expect(nativeBothNodeEligible(node(1, "ingress", capabilities), "ingress")).toBe(false);
    }
    expect(nativeBothNodeEligible(node(), "ingress")).toBe(true);
    expect(nativeBothNodeEligible({ ...node(), accepts_new_business: false }, "ingress")).toBe(false);
    expect(nativeBothNodeEligible({ ...node(), accepts_new_business: undefined }, "ingress")).toBe(false);
    expect(nativeBothNodeEligible(node(1, "egress"), "ingress")).toBe(false);
    expect(nativeBothNodeEligible({ ...node(), capabilities_fresh: false }, "ingress")).toBe(false);
    expect(nativeBothNodeEligible({ ...node(), capabilities_fresh: undefined }, "ingress")).toBe(false);
  });
  test("DIRECT needs ingress; local single-hop RELAY needs two actual eligible nodes", () => {
    const input = { capabilities: { native_both_enabled: true }, mode: "direct" as const, ingress: node() };
    expect(nativeBothBlock(input)).toBeNull();
    expect(nativeBothBlock({ ...input, capabilities: null })).toBe("flag_unknown");
    expect(nativeBothBlock({ ...input, capabilities: { native_both_enabled: false } })).toBe("flag_off");
    expect(nativeBothBlock({ ...input, mode: "relay", egress: node(2, "egress") })).toBeNull();
    expect(nativeBothBlock({ ...input, mode: "relay", egress: node(2, "egress", null) })).toBe("egress_capability");
    expect(nativeBothBlock({ ...input, mode: "relay", egress: node(1, "both") })).toBe("egress_capability");
    expect(nativeBothBlock({ ...input, middleNodeId: "6" })).toBe("path_unsupported");
  });
  test("flag rollback keeps existing both edits, but not new copies or ineligible new paths", () => {
    const input = { capabilities: { native_both_enabled: false }, mode: "direct" as const, ingress: null };
    expect(nativeBothBlock({ ...input, existingBoth: true })).toBeNull();
    expect(nativeBothBlock(input)).toBe("flag_off");
    expect(nativeBothBlock({ ...input, existingBoth: true, pathChanged: true })).toBe("ingress_capability");
    expect(nativeBothBlock({ ...input, existingBoth: true, pathChanged: true, ingress: node() })).toBeNull();
  });
  test("runtime reads have identity fencing, keep missing facts unknown and ignore node-list claims", async () => {
    const read = (id: number, caps: string[] | null) => ({ node_id: id, reachability: "online", panel: { reported: { capabilities: caps } } } as NodeDiagnosticsReport);
    const nodes = [node(1), node(2), node(3), node(4)];
    const result = await withForwardRuntimeCapabilities(nodes, async (id) => {
      if (id === 1) return read(1, [FORWARD_NATIVE_BOTH_CAPABILITY]);
      if (id === 2) return read(99, [FORWARD_NATIVE_BOTH_CAPABILITY]);
      if (id === 3) return read(3, null);
      throw new Error("not authorised");
    });
    expect(result.map((n) => n.capabilities)).toEqual([[FORWARD_NATIVE_BOTH_CAPABILITY], null, null, null]);
  });
  test("stale, unknown or incomplete diagnostics cannot enable native both", async () => {
    for (const reachability of ["offline", "unknown", undefined]) {
      const [result] = await withForwardRuntimeCapabilities([node()], async () => ({ node_id: 1, reachability,
        panel: { reported: { capabilities: [FORWARD_NATIVE_BOTH_CAPABILITY] } } } as NodeDiagnosticsReport));
      expect(nativeBothNodeEligible(result, "ingress")).toBe(false);
    }
  });
  test("detail editor receives capabilities and clears old-scope reference facts", () => {
    const source = readFileSync(new URL("../forward-detail.tsx", import.meta.url), "utf8");
    expect(source).toContain("capabilities={forwardCapabilities}");
    expect(source).toContain("setNodes([])");
    expect(source).toContain("setBindings({})");
  });
  test("copy is one create payload, same both and limits, auto-port, no stats/registry extras", () => {
    const source = rule();
    const draft = forwardCopyDraft(source, " (copy)");
    const payload = forwardCopyCreateInput(draft);
    expect(payload).toMatchObject({ protocol: "both", listen_port: null, ingress_node_id: 1,
      bytes_per_second_in: 1234, bytes_per_second_out: 5678, max_connections: 9, max_connections_per_ip: 2 });
    for (const key of ["id", "traffic", "apply_status", "config_revision", "tls_cert_path", "tls_key_path", "transport", "tcp", "udp"]) {
      expect(payload).not.toHaveProperty(key);
    }
    expect(forwardProtocolFields("both", "/bad.crt", "/bad.key")).toEqual({ protocol: "both" });
    expect(tlsPathFieldErrors("both", "/bad.crt", "")).not.toEqual({});
  });
  test("selection clears incompatible TLS and middle-hop fields, never rewrites retained both", () => {
    const draft = { ...emptyForwardCreateDraft("relay"), protocol: "tls" as const,
      tlsCertPath: "/a.crt", tlsKeyPath: "/a.key", middleNodeId: "6" };
    expect(changeForwardCreateProtocol(draft, "both")).toMatchObject({ protocol: "both", middleNodeId: "", tlsCertPath: "", tlsKeyPath: "" });
    expect(forwardCopyDraft(rule(), " copy").protocol).toBe("both");
  });
  test("single incremental patch retains limits and expected-revision caller semantics", () => {
    const source = rule();
    const draft = { ...forwardCopyDraft(source, ""), name: source.name, listenPort: "25000", protocol: "both" as const };
    expect(draftToPatch(source, draft)).toEqual({});
    expect(draftToPatch(source, { ...draft, name: "renamed", max_connections: "0" })).toEqual({ name: "renamed", max_connections: 0 });
    expect(draftToPatch(rule({ protocol: "tcp" }), draft)).toEqual({ protocol: "both" });
    expect(draftToPatch(source, { ...draft, protocol: "udp" })).toEqual({ protocol: "udp" });
    expect(nativeBothTransitionAllowed("tls", "both")).toBe(false);
    expect(nativeBothTransitionAllowed("ws", "both")).toBe(false);
    expect(nativeBothTransitionAllowed("wss", "both")).toBe(false);
  });
  test("missing ACK and failed aggregate can never inherit legacy's synced shortcut", () => {
    for (const apply_status of [null, "pending", "applying", "error"] as const) {
      const source = rule({ apply_status, applied_revision: 7 });
      expect(forwardProductStatus(source).state).not.toBe("synced");
      expect(forwardRunningState(source).state).not.toBe("synced");
    }
    expect(forwardProductStatus(rule({ apply_status: "active", applied_revision: null })).state).toBe("pending");
    expect(forwardProductStatus(rule({ apply_status: "active", applied_revision: 7 })).state).toBe("synced");
  });
});

describe("native both actual component labels", () => {
  test("both badge keeps identity, mixed label and server unsupported fact", () => {
    expect(render(<ForwardProtocolBadge forward={rule()} />)).toContain('data-transport="mixed"');
    expect(render(<ForwardProtocolBadge forward={rule()} />)).toContain('data-testid="forward-protocol-both"');
    expect(render(<ForwardProtocolBadge forward={rule()} />)).toContain("TCP + UDP");
    expect(render(<ForwardProtocolBadge forward={rule({ protocol_supported: false })} />)).toContain("forward-protocol-unsupported");
  });
  test("shared budget and full replacement copy are explicit, in both languages", () => {
    for (const locale of ["zh", "en"] as const) {
      const html = render(<ForwardPolicyFields draft={forwardCopyDraft(rule(), "")} onChange={() => {}} locale={locale} />, locale);
      expect(html).toContain("2147483647");
      expect(html).toContain(locale === "en" ? "share total/per-source-IP concurrency" : "共享总并发");
      expect(mixedReplaceNote(locale)).toContain(locale === "en" ? "fully replaces both" : "完整替换");
      expect(mixedReplaceNote(locale)).toContain(locale === "en" ? "no atomic partial" : "不支持原子部分");
    }
  });
  test("mixed path is still only a plan, not connectivity or dual-leg readiness", () => {
    const draft = { ...emptyForwardCreateDraft("direct", node()), protocol: "both" as const, targetHost: "127.0.0.1", targetPort: "9000" };
    const model = buildForwardPathPreview({ draft, ingress: node(), egress: null, scopeKey: "5:1", bindingsFacts: null });
    const html = render(<ForwardPathPreview model={model} locale="en" protocol="both" />);
    expect(model.interNodeHops).toBe(0);
    expect(html).toContain("TCP + UDP");
    expect(html).toContain("single-hop local RELAY");
    expect(html).toContain("no connectivity check");
  });
  test("TCP target success never says mixed/UDP is verified", () => {
    const report = { forward_id: 40, mode: "direct", protocol: "both", generated_at: "2026-10-08T00:00:00Z", next_step: null,
      segments: [{ segment: "ingress_to_target", method: "tcp_probe", verified: true, node_id: 1, node_key: "local-1",
        outcome: "ok", targets: [], results: [{ host: "127.0.0.1", port: 9000, status: "reachable", elapsed_ms: 2 }] }] } as DiagnoseReport;
    const html = render(<ForwardDiagnoseReportView report={report} />, "zh");
    expect(html).toContain("forward-both-probe-scope");
    expect(html).toContain("UDP 未验证");
    expect(html).not.toContain("UDP 可达");
  });
  test("mixed diagnostics keep real zero, missing mappings unknown, raw future keys, one runtime ID", () => {
    const endpoint = { node_id: 1, node_key: "local-1", runtime_id: "tunex-40-relay", running: true, revision: 7,
      diag: { protocol: "both", facts: { bytes: 120, live_connections: 0, future_fact: "retained" }, truncated: false } };
    const topology = { forward_id: 40, mode: "relay", observed_at: null, stale_segments: 0,
      segments: [{ segment: "ingress_to_egress", from: endpoint, to: { ...endpoint, node_id: 2, runtime_id: "tunex-40-egress" },
        hop: null, expected_revision: 7 }] } as ForwardTopology;
    const html = render(<ForwardTopologyPanel state={{ status: "ok", topology, error: null }} />);
    expect(html).toContain("live_connections: 0");
    expect(html).toContain("future_fact: retained");
    expect(html).toContain("live connections count TCP only");
    expect(html).toContain("missing is unreported, not zero");
    expect(html).not.toContain("live_mappings: 0");
    expect(html).not.toContain("tunex-40-tcp");
    expect(html).not.toContain("tunex-40-udp");
  });
});

describe("native both authenticated workspace mock parity", () => {
  const original = process.env.FORWARD_NATIVE_BOTH_ENABLED;
  afterEach(() => { if (original === undefined) delete process.env.FORWARD_NATIVE_BOTH_ENABLED;
    else process.env.FORWARD_NATIVE_BOTH_ENABLED = original; resetStore(); });
  const call = (method: string, path: string, body?: unknown, cookie = "tunex_session=u1") =>
    handleMock(method, path, { body, cookie, workspaceId: 1 } as never);
  function advertise(id: number) {
    const db = getStore();
    db.nodeStates.set(id, { node_id: id, capabilities: [FORWARD_NATIVE_BOTH_CAPABILITY], reported_at: new Date().toISOString(),
      tunnels: null } as import("@/lib/types").NodeStateReport);
    const n = db.nodes.find((value) => Number(value.id) === id)!;
    n.has_credential = true; n.credential_revoked = false;
    const projected = mockUserNode(db, n);
    if (!projected.accepts_new_business) throw new Error("fixture node must be admitted");
  }
  test("authenticated capability read is default off; unknown scope and anonymous stay denied", async () => {
    resetStore(); delete process.env.FORWARD_NATIVE_BOTH_ENABLED;
    expect((await call("GET", "/forwards/capabilities")).body).toEqual({ native_both_enabled: false });
    expect((await call("GET", "/forwards/capabilities", undefined, "")).status).toBe(401);
    expect((await handleMock("GET", "/forwards/capabilities", { cookie: "tunex_session=u1", workspaceId: 999 } as never)).status).toBe(404);
  });
  test("only exact server flag true enables discovery; fresh actual advertisements survive diagnostics", async () => {
    resetStore(); advertise(1);
    for (const value of ["false", "TRUE", "1", " true ", ""]) {
      process.env.FORWARD_NATIVE_BOTH_ENABLED = value;
      expect((await call("GET", "/forwards/capabilities")).body).toEqual({ native_both_enabled: false });
    }
    process.env.FORWARD_NATIVE_BOTH_ENABLED = "true";
    expect((await call("GET", "/forwards/capabilities")).body).toEqual({ native_both_enabled: true });
    const report = (await call("GET", "/nodes/1/diagnostics")).body as NodeDiagnosticsReport;
    expect(report.panel.reported?.capabilities).toEqual([FORWARD_NATIVE_BOTH_CAPABILITY]);
    const [enriched] = await withForwardRuntimeCapabilities([mockUserNode(getStore(), getStore().nodes[0]!)], async () => report);
    expect(nativeBothNodeEligible(enriched, "ingress")).toBe(true);
    getStore().nodeStates.get(1)!.reported_at = new Date(Date.now() - 120_000).toISOString();
    expect((await call("POST", "/forwards", forwardCopyCreateInput(forwardCopyDraft(rule(), "")))).status).toBe(409);
  });
  test("create needs flag plus actual capability and keeps one ID/pending without fake both ACK", async () => {
    resetStore(); const payload = forwardCopyCreateInput(forwardCopyDraft(rule(), ""));
    delete process.env.FORWARD_NATIVE_BOTH_ENABLED;
    expect((await call("POST", "/forwards", payload)).status).toBe(409);
    process.env.FORWARD_NATIVE_BOTH_ENABLED = "true";
    expect((await call("POST", "/forwards", payload)).status).toBe(409);
    advertise(1);
    const before = getStore().tunnels.length;
    const created = await call("POST", "/forwards", payload);
    expect(created.status).toBe(200);
    expect(getStore().tunnels.length).toBe(before + 1);
    expect(created.body).toMatchObject({ protocol: "both", protocol_supported: true, apply_status: "pending",
      bytes_per_second_in: 1234, bytes_per_second_out: 5678, max_connections: 9, max_connections_per_ip: 2 });
    expect((await call("POST", "/forwards", { ...payload, middle_node_id: 6 })).status).toBe(409);
    expect((await call("POST", "/forwards", { ...payload, client_source: {} })).status).toBe(400);
    expect(getStore().tunnels.find((t) => t.id === (created.body as PortForward).id)?.tunnel_type).toBeNull();
    for (const extras of [{ federated_egress_peer: "remote" }, { link_source_config: {} }, { tls_cert_path: "/a.crt", tls_key_path: "/a.key" }, { tls_cert_path: "", tls_key_path: "" }]) {
      expect((await call("POST", "/forwards", { ...payload, ...extras })).status).toBe(400);
    }
  });
  test("preview is side-effect-free; transition bumps desired, not fake applied; rollback still allows name edit", async () => {
    resetStore(); process.env.FORWARD_NATIVE_BOTH_ENABLED = "true"; advertise(1);
    const db = getStore(); const t = db.tunnels.find((value) => value.id === 1)!;
    const currentRevision = t.config_revision;
    Object.assign(t, { bytes_per_second_in: 1234, bytes_per_second_out: 5678, max_connections: 9, max_connections_per_ip: 2 });
    const preview = await call("POST", "/forwards/1/preview", { protocol: "both" });
    expect(preview.status).toBe(200);
    expect(t.forward_protocol).toBe("tcp"); expect(t.config_revision).toBe(currentRevision);
    expect(preview.body).toMatchObject({ impact: { metadata_only: false, listener_replacement: true }, candidate: { config: { protocol: "both" } } });
    const patch = await call("PATCH", "/forwards/1", { protocol: "both", expected_revision: currentRevision });
    expect(patch.status).toBe(200); expect(patch.body).toMatchObject({ protocol: "both", apply_status: "pending",
      bytes_per_second_in: 1234, bytes_per_second_out: 5678, max_connections: 9, max_connections_per_ip: 2 });
    expect(t.tunnel_type).toBeNull();
    delete process.env.FORWARD_NATIVE_BOTH_ENABLED;
    const renamed = await call("PATCH", "/forwards/1", { name: "existing native renamed" });
    expect(renamed.status).toBe(200); expect(renamed.body).toMatchObject({ protocol: "both", name: "existing native renamed" });
    expect((await call("POST", "/forwards", forwardCopyCreateInput(forwardCopyDraft(renamed.body as PortForward, " copy")))).status).toBe(409);
  });
  test("local RELAY needs actual native egress; resume/retry cannot fabricate both Ready", async () => {
    resetStore(); process.env.FORWARD_NATIVE_BOTH_ENABLED = "true"; advertise(1);
    const payload = { ...forwardCopyCreateInput(forwardCopyDraft(rule(), "")), mode: "relay", egress_node_id: 4 };
    expect((await call("POST", "/forwards", payload)).status).toBe(409);
    advertise(4);
    const created = await call("POST", "/forwards", payload);
    expect(created.status).toBe(200);
    const row = getStore().tunnels.find((t) => t.id === (created.body as PortForward).id)!;
    row.apply_status = "suspended";
    const result = await call("POST", `/forwards/${row.id}/resume`, {});
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ protocol: "both", apply_status: "pending" });
  });
  test("both retargeting previews a full listener rebuild and preserves one ID and applied fact", async () => {
    resetStore(); process.env.FORWARD_NATIVE_BOTH_ENABLED = "true"; advertise(1);
    const created = await call("POST", "/forwards", forwardCopyCreateInput(forwardCopyDraft(rule(), "")));
    const row = created.body as PortForward;
    const before = getStore().tunnels.length;
    const preview = await call("POST", `/forwards/${row.id}/preview`, { target_host: "127.0.0.2" });
    expect(preview.body).toMatchObject({ impact: { target_change: true, listener_replacement: true, runtime_change: true } });
    const saved = await call("PATCH", `/forwards/${row.id}`, { target_host: "127.0.0.2", expected_revision: row.config_revision });
    expect(saved.body).toMatchObject({ id: row.id, protocol: "both", apply_status: "pending", applied_revision: row.applied_revision });
    expect(getStore().tunnels.length).toBe(before);
  });
  test("an existing multi-hop plain rule cannot transition into native both or discard its path", async () => {
    resetStore(); process.env.FORWARD_NATIVE_BOTH_ENABLED = "true"; advertise(1); advertise(4);
    const created = await call("POST", "/forwards", { mode: "relay", name: "existing multihop", protocol: "tcp",
      ingress_node_id: 1, egress_node_id: 4, middle_node_id: 6, target_host: "127.0.0.1", target_port: 9000 });
    expect(created.status).toBe(200);
    const row = created.body as PortForward;
    const preview = await call("POST", `/forwards/${row.id}/preview`, { protocol: "both" });
    expect(preview.status).toBe(400);
    expect((preview.body as { data: { reasons: string[] } }).data.reasons).toContain("path_unsupported");
    expect((await call("GET", `/forwards/${row.id}`)).body).toMatchObject({ protocol: "tcp" });
    expect((await call("GET", `/forwards/${row.id}/topology`)).body).toMatchObject({
      segments: [{ segment: "ingress_to_middle" }, { segment: "middle_to_egress" }] });
  });
  test("flag-off existing both target/policy edits work without fresh capabilities, but new transitions do not", async () => {
    resetStore(); process.env.FORWARD_NATIVE_BOTH_ENABLED = "true"; advertise(1);
    const created = await call("POST", "/forwards", forwardCopyCreateInput(forwardCopyDraft(rule(), "")));
    const row = created.body as PortForward;
    delete process.env.FORWARD_NATIVE_BOTH_ENABLED;
    getStore().nodeStates.delete(1);
    for (const patch of [{ target_host: "127.0.0.2" }, { max_connections: 10 }]) {
      const preview = await call("POST", `/forwards/${row.id}/preview`, patch);
      expect(preview.status).toBe(200);
      expect(preview.body).toMatchObject({ impact: { metadata_only: false, listener_replacement: true } });
      const saved = await call("PATCH", `/forwards/${row.id}`, patch);
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({ protocol: "both", apply_status: "pending" });
    }
    expect((await call("POST", "/forwards/1/preview", { protocol: "both" })).status).toBe(400);
    for (const patch of [{ federated_egress_peer: "remote" }, { client_source: {} }, { middle_node_id: 6 }]) {
      expect((await call("POST", `/forwards/${row.id}/preview`, patch)).status).toBe(400);
    }
  });
});
