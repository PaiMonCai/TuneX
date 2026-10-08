/** Isolated F4 browser fixture: real UI, fixture API only, no Panel/Agent proof. */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider, getDictionary } from "@/components/providers";
import { WorkspaceContext, type WorkspaceContextValue } from "@/components/workspace/workspace-context";
import { api, setActiveWorkspace } from "@/lib/api";
import { withForwardRuntimeCapabilities, type ForwardCapabilities } from "@/lib/forward-native-both";
import { forwardListText } from "../forward-list-model";
import { ForwardCreateDialog } from "../forward-create-dialog";
import { ForwardEditDialog } from "../forward-edit-dialog";
import { ForwardProtocolBadge } from "../forward-protocol-badge";
import { ForwardDiagnoseReportView } from "../forward-diagnose";
import { ForwardTopologyPanel } from "../forward-topology";
import { copiedForwardCreateDraft, emptyForwardCreateDraft } from "../forward-create-model";
import { forwardCopyCreateInput } from "../forward-copy";
import { forwardPolicyDraftValues } from "@/lib/forward-policy";
import { forwardProtocolFields } from "@/lib/forward-protocol";
import { useI18n } from "@/components/providers";
import type { NodeBinding, PortForward, UserNode } from "@/lib/types";
import { nativeBothFixtureRule, nativeBothFixtureReport, nativeBothFixtureTopology } from "./forward-native-both-fixtures";

function Harness() {
  const { t, locale } = useI18n();
  const [workspace, setWorkspace] = useState(5);
  const [version, setVersion] = useState(0);
  const [nodes, setNodes] = useState<UserNode[]>([]);
  const [capabilities, setCapabilities] = useState<ForwardCapabilities | null>(null);
  const [create, setCreate] = useState(false);
  const [edit, setEdit] = useState(false);
  const [draft, setDraft] = useState(() => ({ ...emptyForwardCreateDraft("direct"), name: "native loopback", ingressId: "11", targetHost: "127.0.0.1", targetPort: "9000" }));
  const [rule, setRule] = useState(nativeBothFixtureRule());
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  setActiveWorkspace(workspace);
  useEffect(() => {
    let cancelled = false;
    setCapabilities(null); setNodes([]); setCreate(false); setEdit(false);
    void api.forwards.capabilities().then((value) => { if (!cancelled) setCapabilities(value); }).catch(() => {});
    void api.nodes.list().then((rows) => withForwardRuntimeCapabilities(rows, api.nodes.diagnostics))
      .then((rows) => { if (!cancelled) setNodes(rows); }).catch(() => {});
    return () => { cancelled = true; };
  }, [workspace, version]);
  const context = { currentId: workspace, loading: false, permissionsLoading: false, permissions: null,
    can: () => true, canForward: () => true } as unknown as WorkspaceContextValue;
  const binding = { id: 1, ingress_node_id: 11, egress_node_id: 12, egress_node: nodes.find((n) => n.id === 12),
    used_by_forward_count: 1, unbind_blocked: true, created_at: "2026-10-08T00:00:00Z" } as NodeBinding;
  async function submit() {
    setBusy(true);
    try {
      const input = { ...forwardPolicyDraftValues(draft), ...forwardCopyCreateInput(draft),
        ...forwardProtocolFields(draft.protocol, draft.tlsCertPath, draft.tlsKeyPath) };
      const row = await api.forwards.create(input); setRule(row); setMessage(`created ${row.protocol}`); setCreate(false);
    } catch (error) { setMessage(error instanceof Error ? error.message : "fixture request failed"); }
    finally { setBusy(false); }
  }
  async function scenario(next: Record<string, unknown>) {
    await fetch("/__test/scenario", { method: "POST", body: JSON.stringify(next) });
    setVersion((value) => value + 1);
  }
  return <WorkspaceContext.Provider value={context}><main>
    <h1>F4 native both browser contract fixture</h1>
    <p>No real Panel, Agent or production traffic. Fixture business ID: {rule.id}</p>
    <div id="fixture-controls">
      <button onClick={() => { setDraft({ ...draft, protocol: "tcp", mode: "direct", middleNodeId: "" }); setCreate(true); }}>Create DIRECT fixture</button>
      <button onClick={() => { setDraft({ ...draft, protocol: "tcp", mode: "relay", ingressId: "11", egressId: "12", middleNodeId: "" }); setCreate(true); }}>Create RELAY fixture</button>
      <button onClick={() => { setDraft({ ...copiedForwardCreateDraft(nativeBothFixtureRule(), " copy") }); setCreate(true); }}>Copy existing both fixture</button>
      <button onClick={() => { setRule(nativeBothFixtureRule()); setEdit(true); }}>Edit existing both fixture</button>
      <button onClick={() => { setRule(nativeBothFixtureRule({ protocol: "tcp" })); setEdit(true); }}>Edit TCP fixture</button>
      <button onClick={() => void scenario({ enabled: false })}>Flag off</button>
      <button onClick={() => void scenario({ enabled: true })}>Flag on</button>
      <button onClick={() => void scenario({ native: false })}>Separate TCP UDP only</button>
      <button onClick={() => void scenario({ native: true })}>Native advertised</button>
      <button onClick={() => void scenario({ fresh: false })}>Stale native report</button>
      <button onClick={() => void scenario({ malformed: true })}>Malformed flag</button>
      <button onClick={() => void scenario({ delay: true })}>Delay scope facts</button>
      <button onClick={() => setWorkspace((value) => value === 5 ? 6 : 5)}>Switch fixture workspace</button>
      <button onClick={() => void scenario({ enabled: true, native: true, fresh: true, malformed: false, delay: false })}>Reset fixture gates</button>
    </div>
    <p data-testid="fixture-scope">Workspace {workspace}</p>
    <p data-testid="fixture-gates">{capabilities === null ? "flag unknown" : capabilities.native_both_enabled ? "flag on" : "flag off"} · native nodes {nodes.filter((n) => n.capabilities_fresh && n.capabilities?.includes("forward.protocol.both.native.v1")).length}</p>
    <p role="status">{message}</p>
    <ForwardProtocolBadge forward={rule} />
    <ForwardCreateDialog open={create} draft={draft} onDraftChange={setDraft} ingressNodes={nodes.filter((n) => n.role === "ingress")}
      egressNodes={nodes.filter((n) => n.role === "egress")} selectedBindings={[binding]} bindingsByIngress={{ "11": [binding] }}
      capabilities={capabilities} canManageNodes={true} busy={busy} locale={locale} workspaceId={workspace} t={t}
      text={(key, params) => forwardListText(t, locale, key, params)} onOpenChange={setCreate} onCreate={() => void submit()} />
    <ForwardEditDialog open={edit} forward={rule} nodes={nodes} bindings={{ "11": [binding] }} capabilities={capabilities}
      onOpenChange={setEdit} onSaved={(row: PortForward) => { setRule(row); setMessage(`saved ${row.protocol}`); }} onReload={() => setVersion((value) => value + 1)} />
    <ForwardDiagnoseReportView report={nativeBothFixtureReport()} protocol="both" />
    <ForwardTopologyPanel state={{ status: "ok", topology: nativeBothFixtureTopology(), error: null }} />
  </main></WorkspaceContext.Provider>;
}
createRoot(document.getElementById("root")!).render(<I18nProvider locale="en" dict={getDictionary("en")}><Harness /></I18nProvider>);
