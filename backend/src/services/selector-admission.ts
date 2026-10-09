/** Target selector admission. Source scope is a runtime fact, never a wire claim. */
import {
  decideRuntimeCapability,
  type AgentV2CapabilityFacts,
  type ManifestRejectionReason,
} from "./capability-manifest.ts";
import { loadNodeCapabilityFacts, type CapabilityFactsLoader } from "./runtime-admission.ts";

export const SELECTOR_RUNTIME_CAPABILITIES = {
  fallback: "selector_fallback",
  ip_hash: "selector_ip_hash_client_ip",
} as const;

export type SelectorStrategy = "ROUND_ROBIN" | "RANDOM" | "WEIGHTED_ROUND_ROBIN" | "FALLBACK" | "IP_HASH";
export type SelectorAdmissionReason = ManifestRejectionReason | "invalid_selector" | "selector_client_ip_required";
export interface SelectorAdmissionRequest {
  strategy: unknown;
  mode: "DIRECT" | "RELAY" | "EGRESS";
  /** Only a runtime with an implemented, trusted original-IP source may set this. */
  sourceScope?: "trusted_client_ip" | "unavailable";
}
export type SelectorAdmission =
  | { ok: true; strategy: SelectorStrategy; basis: "baseline" | "advertised" }
  | { ok: false; reason: SelectorAdmissionReason; detail: string; error_layer: "runtime_admission" };

export function normalizeSelectorStrategy(value: unknown): SelectorStrategy | null {
  if (value === null || value === undefined || value === "") return "ROUND_ROBIN";
  if (typeof value !== "string") return null;
  switch (value.trim().toUpperCase()) {
    case "":
    case "ROUND":
    case "ROUND_ROBIN": return "ROUND_ROBIN";
    case "RAND":
    case "RANDOM": return "RANDOM";
    case "WEIGHTED":
    case "WEIGHTED_ROUND":
    case "WEIGHTED_ROUND_ROBIN": return "WEIGHTED_ROUND_ROBIN";
    case "FALLBACK": return "FALLBACK";
    case "IP_HASH": return "IP_HASH";
    default: return null;
  }
}

function deny(reason: SelectorAdmissionReason, detail: string): SelectorAdmission {
  return { ok: false, reason, detail, error_layer: "runtime_admission" };
}

export function admitSelector(
  request: SelectorAdmissionRequest,
  facts: AgentV2CapabilityFacts | null | undefined,
): SelectorAdmission {
  const strategy = normalizeSelectorStrategy(request.strategy);
  if (strategy === null) return deny("invalid_selector", `未知目标选择策略 ${String(request.strategy)}`);
  // Current RELAY/EGRESS protocols do not carry the original client IP. An
  // advertised selector cannot turn the node's peer IP into that missing fact.
  if (strategy === "IP_HASH" && (request.mode !== "DIRECT" || request.sourceScope !== "trusted_client_ip")) {
    return deny("selector_client_ip_required", "IP_HASH 需要可信真实客户端 IP；当前 RELAY EGRESS 协议不透传该来源，拒绝配置或下发");
  }
  if (strategy !== "FALLBACK" && strategy !== "IP_HASH") {
    return { ok: true, strategy, basis: "baseline" };
  }
  if (facts?.capabilitiesMalformed) {
    return deny("malformed_capability_manifest", "节点的能力上报不可读，拒绝目标选择策略");
  }
  const capability = strategy === "FALLBACK" ? SELECTOR_RUNTIME_CAPABILITIES.fallback : SELECTOR_RUNTIME_CAPABILITIES.ip_hash;
  const decision = decideRuntimeCapability(facts, capability);
  return decision.supported
    ? { ok: true, strategy, basis: decision.basis }
    : deny(decision.reason, decision.detail);
}

export async function admitSelectorFromStore(
  nodeId: number,
  request: SelectorAdmissionRequest,
  load: CapabilityFactsLoader = loadNodeCapabilityFacts,
): Promise<SelectorAdmission> {
  const initial = admitSelector(request, null);
  // Baseline selectors and impossible source scopes need no storage read.
  if (initial.ok || initial.reason !== "upgrade_required") return initial;
  let facts: AgentV2CapabilityFacts | null = null;
  try { facts = await load(nodeId); } catch { /* No facts never grants a new selector. */ }
  return admitSelector(request, facts);
}

export function selectorAdmissionDetail(decision: Extract<SelectorAdmission, { ok: false }>): string {
  return `[runtime_admission:${decision.reason}:selector] ${decision.detail}`;
}
