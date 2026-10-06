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
  return { ...draft, ingressId, egressId: "", bindEgressId: "" };
}

export function forwardCreateProtocolErrors(draft: ForwardCreateDraft) {
  return tlsPathFieldErrors(draft.protocol, draft.tlsCertPath, draft.tlsKeyPath);
}
