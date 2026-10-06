import { DEFAULT_FORWARD_PROTOCOL, tlsPathFieldErrors, type ForwardProtocol } from "@/lib/forward-protocol";
import type { PortForward, UserNode } from "@/lib/types";
import { forwardCopyDraft } from "@/components/forwards/forward-copy";

export interface ForwardCreateDraft {
  mode: "direct" | "relay";
  name: string;
  protocol: ForwardProtocol;
  tlsCertPath: string;
  tlsKeyPath: string;
  ingressId: string;
  egressId: string;
  listenPort: string;
  targetHost: string;
  targetPort: string;
  bindEgressId: string;
  /**
   * 中间跳（三跳）选择；空串 = 不使用中间跳（两段）。
   *
   * 只有 relay 才有意义（DIRECT 带上 `middle_node_id` 会被后端静默落库且永不使用 ⇒
   * `multihopCreateFields()` 对 DIRECT 一律返回 `{}`，结构上不给这个错误组合）。
   * 换入口/换出口都会把它清空：入口决定第一段、出口决定第二段，两者之一的语义变了，
   * 原来那个中间跳的"两段都在"就不再成立 —— 留着它只会让用户提交一个必然 409 的请求。
   */
  middleNodeId?: string;
}

export function emptyForwardCreateDraft(mode: "direct" | "relay", ingress?: UserNode): ForwardCreateDraft {
  return {
    mode,
    name: "",
    protocol: DEFAULT_FORWARD_PROTOCOL,
    tlsCertPath: "",
    tlsKeyPath: "",
    ingressId: ingress ? String(ingress.id) : "",
    egressId: "",
    listenPort: "",
    targetHost: "",
    targetPort: "",
    bindEgressId: "",
    // 中间跳：默认不使用（两段）。
    middleNodeId: "",
  };
}

export function copiedForwardCreateDraft(forward: PortForward, copySuffix: string): ForwardCreateDraft {
  const draft = forwardCopyDraft(forward, copySuffix);
  return { ...draft, bindEgressId: "" };
}

export function changeForwardCreateProtocol(draft: ForwardCreateDraft, protocol: ForwardProtocol): ForwardCreateDraft {
  return protocol === "tls"
    ? { ...draft, protocol }
    : { ...draft, protocol, tlsCertPath: "", tlsKeyPath: "" };
}

export function changeForwardCreateIngress(draft: ForwardCreateDraft, ingressId: string): ForwardCreateDraft {
  // 换入口 ⇒ 第一段（入口→中间）的语义变了 ⇒ 中间跳必须重选。
  return { ...draft, ingressId, egressId: "", bindEgressId: "", middleNodeId: "" };
}

/**
 * 换出口。**同样清空中间跳**：第二段是「中间 → 出口」，出口变了那条绑定就不一定还在。
 * 保留选择会让用户提交一个必然 409 `binding_required` 的请求 —— 那正是本切片要消掉的体验。
 */
export function changeForwardCreateEgress(draft: ForwardCreateDraft, egressId: string): ForwardCreateDraft {
  return { ...draft, egressId, middleNodeId: "" };
}

export function forwardCreateProtocolErrors(draft: ForwardCreateDraft) {
  return tlsPathFieldErrors(draft.protocol, draft.tlsCertPath, draft.tlsKeyPath);
}
