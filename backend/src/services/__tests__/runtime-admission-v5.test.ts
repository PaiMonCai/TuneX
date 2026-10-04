/**
 * V5-WP1 —— Runtime admission（三维准入的**唯一**实现）。
 *
 * capability-manifest-v5.test.ts 钉的是单个维度的判定规则；这里钉的是「把三个
 * 维度合起来、并按节点逐一判定」这一层的性质：
 *
 *   · DIRECT 只查入口，RELAY 查两端，且**任一端不满足就整条拒绝**；
 *   · 拒绝必须点名是哪一台节点、哪一个维度（否则排障会去查错的机器）；
 *   · 判断顺序固定 action → protocol → transport（让拒绝文案落在最可行动的一条上）；
 *   · 诊断类动作只有动作维度——它没有协议维度，不能因为 manifest 沉默就被拒。
 */
import { describe, expect, test } from "bun:test";
import {
  ABSENT_V2_CAPABILITY_FACTS,
  CAPABILITY_MANIFEST_SCHEMA_VERSION,
  type AgentV2CapabilityFacts,
  type CapabilityManifest,
} from "../capability-manifest.ts";
import {
  admissionFailureDetail,
  admissionLayerLabel,
  admitAction,
  admitOnNode,
  admitRuntime,
  forwardTransportFor,
  type RuntimeAdmissionNode,
} from "../runtime-admission.ts";

const V2_ACTIONS = ["apply_tunnel", "remove_tunnel", "suspend_tunnel", "diagnose_tunnel", "collect_diagnostics"];

function fullManifest(partial: Partial<CapabilityManifest> = {}): CapabilityManifest {
  return {
    schema_version: CAPABILITY_MANIFEST_SCHEMA_VERSION,
    protocols: ["tcp"],
    transports: ["stream"],
    runtime: ["graceful_drain", "hot_reload", "lkg_restore"],
    diagnostics: ["node_snapshot", "tunnel_probe"],
    ...partial,
  };
}

function v2(partial: Partial<AgentV2CapabilityFacts> = {}): AgentV2CapabilityFacts {
  return {
    ...ABSENT_V2_CAPABILITY_FACTS,
    protocolVersion: 2,
    capabilities: V2_ACTIONS,
    manifest: fullManifest(),
    ...partial,
  };
}

const ingress = (facts: AgentV2CapabilityFacts | null): RuntimeAdmissionNode => ({ nodeId: 1, role: "ingress", facts });
const egress = (facts: AgentV2CapabilityFacts | null): RuntimeAdmissionNode => ({ nodeId: 2, role: "egress", facts });

const APPLY = { action: "apply_tunnel", protocol: "tcp" } as const;

describe("admitOnNode", () => {
  test("a fully advertised node admits the standard TCP forward", () => {
    expect(admitOnNode(ingress(v2()), APPLY)).toEqual({ ok: true });
  });

  test("an old agent (no facts at all) admits the TCP baseline", () => {
    expect(admitOnNode(ingress(null), APPLY)).toEqual({ ok: true });
  });

  test("the transport is derived from the protocol, not from the caller", () => {
    expect(forwardTransportFor("tcp")).toBe("stream");
    // A node that implements tcp but (absurdly) not stream is refused, because
    // the panel checks the transport the protocol actually needs.
    const noStream = v2({ manifest: fullManifest({ transports: [] }) });
    expect(admitOnNode(ingress(noStream), APPLY)).toMatchObject({
      ok: false,
      layer: "transport",
      reason: "transport_not_supported",
    });
  });

  test("a protocol the panel has not opened is refused even when the node advertises it", () => {
    const futuristic = v2({ manifest: fullManifest({ protocols: ["tcp", "tls", "ws", "udp", "quic"] }) });
    // `tls` (A1) and `ws` (A2) are NOT in this list any more: they are open, and
    // a node advertising them is admitted. The product gate still refuses
    // everything whose Gate has not run.
    for (const protocol of ["quic"]) {
      expect(admitOnNode(ingress(futuristic), { action: "apply_tunnel", protocol })).toMatchObject({
        ok: false,
        layer: "protocol",
        reason: "protocol_not_supported",
      });
    }
  });

  test("a missing protocol value is a caller bug, refused rather than defaulted to TCP", () => {
    // The V4 baseline default ("omitted means tcp") lives in forward-contract for
    // *persisted* facts. An admission request that states no protocol at all is
    // an internal error, and silently reading it as TCP would hide the bug.
    for (const protocol of [undefined, null, "", 42]) {
      const result = admitOnNode(ingress(v2()), { action: "apply_tunnel", protocol });
      // undefined/null normalise to the V4 default (tcp) — that is the
      // compatibility path — while a *non-string* is refused.
      if (typeof protocol === "string" || protocol === undefined || protocol === null) {
        expect(result.ok).toBe(true);
      } else {
        expect(result).toMatchObject({ ok: false, layer: "protocol" });
      }
    }
  });

  test("the action dimension is checked first, so its message wins", () => {
    const noApply = v2({ capabilities: ["remove_tunnel"], manifest: fullManifest({ protocols: [] }) });
    const result = admitOnNode(ingress(noApply), APPLY);
    expect(result).toMatchObject({ ok: false, layer: "action" });
  });

  test("a denial names the node, the dimension and a machine-readable reason", () => {
    const denied = admitOnNode(egress(v2({ manifest: fullManifest({ protocols: [] }) })), APPLY);
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.node_id).toBe(2);
    expect(denied.node_role).toBe("egress");
    expect(denied.reason).toBe("protocol_not_supported");
    expect(denied.error_layer).toBe("runtime_admission");
    expect(denied.detail).toContain("出口节点 2");
    expect(denied.body.code).toBe("protocol_not_supported");
    expect(denied.body.error_layer).toBe("runtime_admission");
    expect(admissionFailureDetail(denied)).toStartWith("[runtime_admission:protocol_not_supported:protocol]");
  });

  test("every dimension has a human label (a denial must be explainable)", () => {
    expect(admissionLayerLabel("action")).toBeTruthy();
    expect(admissionLayerLabel("protocol")).toBeTruthy();
    expect(admissionLayerLabel("transport")).toBeTruthy();
  });
});

describe("admitRuntime (RELAY: both ends)", () => {
  test("§5.2-7. one end unsupported rejects the whole forward", () => {
    const result = admitRuntime([ingress(v2()), egress(v2({ manifest: fullManifest({ protocols: [] }) }))], APPLY);
    expect(result).toMatchObject({ ok: false, node_id: 2, node_role: "egress" });
  });

  test("both ends unsupported still reports the first one deterministically", () => {
    const broken = v2({ manifest: fullManifest({ protocols: [] }) });
    const result = admitRuntime([ingress(broken), egress(broken)], APPLY);
    expect(result).toMatchObject({ ok: false, node_id: 1, node_role: "ingress" });
  });

  test("both ends advertised → admitted", () => {
    expect(admitRuntime([ingress(v2()), egress(v2())], APPLY)).toEqual({ ok: true });
  });

  test("an empty node list is a caller bug, not an admission", () => {
    expect(admitRuntime([], APPLY)).toMatchObject({ ok: false, reason: "incompatible_agent" });
  });
});

describe("admitAction (diagnostics: action dimension only)", () => {
  /**
   * §5.2-10：V4 诊断行为不退化。
   *
   * 诊断探测的是目标路径，不是一条转发 runtime，所以它**没有协议维度**。
   * 如果诊断也去查 manifest 的 protocols，一个 manifest 恰好沉默的节点就会被拒
   * 掉诊断——而它本来能正常应答，这是纯粹的功能退化。
   */
  test("a v2 agent that advertises the diagnostic action is admitted without protocol facts", () => {
    const diagnosticsOnly = v2({ manifest: fullManifest({ protocols: [], transports: [] }) });
    expect(admitAction(ingress(diagnosticsOnly), "diagnose_tunnel")).toEqual({ ok: true });
    expect(admitAction(ingress(diagnosticsOnly), "collect_diagnostics")).toEqual({ ok: true });
  });

  test("an agent that does not advertise the diagnostic action is still refused (V4 rule kept)", () => {
    const noDiagnostics = v2({ capabilities: ["apply_tunnel"] });
    expect(admitAction(ingress(noDiagnostics), "diagnose_tunnel")).toMatchObject({
      ok: false,
      layer: "action",
      reason: "upgrade_required",
    });
  });

  test("an old agent keeps the baseline actions but cannot run diagnostics it never advertised", () => {
    expect(admitAction(ingress(null), "apply_tunnel")).toEqual({ ok: true });
    expect(admitAction(ingress(null), "diagnose_tunnel")).toMatchObject({ ok: false, reason: "upgrade_required" });
  });
});
