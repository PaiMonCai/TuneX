import type { NodeDiagnosticsReport, UserNode } from "./types";

/** This is a runtime prerequisite, never inferred from separate TCP/UDP support. */
export const FORWARD_NATIVE_BOTH_CAPABILITY = "forward.protocol.both.native.v1";
export interface ForwardCapabilities { native_both_enabled: boolean }

export function projectForwardCapabilities(raw: unknown): ForwardCapabilities {
  if (!raw || typeof raw !== "object" ||
      typeof (raw as ForwardCapabilities).native_both_enabled !== "boolean") {
    throw new Error("Invalid Forward capabilities response");
  }
  return { native_both_enabled: (raw as ForwardCapabilities).native_both_enabled };
}

/** Use workspace-authenticated diagnostics, not admin state or version heuristics. */
export async function withForwardRuntimeCapabilities(
  nodes: UserNode[], read: (id: UserNode["id"]) => Promise<NodeDiagnosticsReport>,
): Promise<UserNode[]> {
  return Promise.all(nodes.map(async (node) => {
    try {
      const report = await read(node.id);
      const capabilities = report.node_id === Number(node.id) && Array.isArray(report.panel.reported?.capabilities)
        ? report.panel.reported.capabilities.filter((value): value is string => typeof value === "string") : null;
      // Admission and online are orthogonal. Qualify reports using the server's
      // freshness conclusion, never a node-list online/admission shortcut.
      return { ...node, capabilities, capabilities_fresh: capabilities !== null && report.reachability === "online" };
    } catch { return { ...node, capabilities: null, capabilities_fresh: false }; }
  }));
}

export function nativeBothNodeEligible(node: UserNode | null | undefined, role: "ingress" | "egress"): boolean {
  return !!node && (node.role === role || node.role === "both") &&
    node.accepts_new_business === true &&
    node.capabilities_fresh === true &&
    node.capabilities?.includes(FORWARD_NATIVE_BOTH_CAPABILITY) === true;
}

export type NativeBothBlock = "flag_unknown" | "flag_off" | "path_unsupported" | "ingress_capability" | "egress_capability";
export function nativeBothBlock(input: {
  capabilities: ForwardCapabilities | null; mode: "direct" | "relay";
  ingress: UserNode | null | undefined; egress?: UserNode | null;
  middleNodeId?: string; existingBoth?: boolean; pathChanged?: boolean;
}): NativeBothBlock | null {
  // Existing both remains editable on rollout rollback. No silent protocol rewriting.
  if (!input.existingBoth) {
    if (input.capabilities === null) return "flag_unknown";
    if (!input.capabilities.native_both_enabled) return "flag_off";
  }
  if (input.middleNodeId?.trim()) return "path_unsupported";
  if (input.existingBoth && !input.pathChanged) return null;
  if (!nativeBothNodeEligible(input.ingress, "ingress")) return "ingress_capability";
  if (input.mode === "relay" && (!nativeBothNodeEligible(input.egress, "egress") || input.egress?.id === input.ingress?.id)) {
    return "egress_capability";
  }
  return null;
}

export function nativeBothBlockText(locale: string, reason: NativeBothBlock): string {
  const zh = locale !== "en";
  const messages: Record<NativeBothBlock, [string, string]> = {
    flag_unknown: ["暂时取不到原生 TCP + UDP 开关；不能新建或切换到 both。", "Native TCP + UDP capability is unavailable; creation and transitions to both are blocked."],
    flag_off: ["原生 TCP + UDP 尚未启用；已有 both 转发仍可编辑，不会自动改成 TCP。", "Native TCP + UDP is disabled; existing both rules remain editable without a TCP downgrade."],
    path_unsupported: ["原生 TCP + UDP 仅支持 DIRECT 或本地单跳 RELAY；请移除中间跳。", "Native TCP + UDP supports DIRECT or single-hop local RELAY only; remove the middle hop."],
    ingress_capability: ["请选择已准入且有新鲜报告实际上报 forward.protocol.both.native.v1 的入口节点；过期报告或独立 TCP/UDP 能力不能替代。", "Choose an admitted ingress with a fresh report advertising forward.protocol.both.native.v1; stale reports or separate TCP/UDP capabilities are not a substitute."],
    egress_capability: ["请选择另一台已准入且有新鲜报告实际上报 forward.protocol.both.native.v1 的本地自有出口节点。", "Choose a different admitted, self-owned local egress with a fresh report advertising forward.protocol.both.native.v1."],
  };
  return messages[reason][zh ? 0 : 1];
}

/** Only plain-protocol transitions belong to this slice; TLS/WS/legacy stay fixed. */
export function nativeBothTransitionAllowed(current: string, next: string): boolean {
  return current === next || (["tcp", "udp", "both"].includes(current) && ["tcp", "udp", "both"].includes(next));
}
