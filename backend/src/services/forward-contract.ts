/**
 * V5-WP0 — canonical Forward protocol/topology contract.
 *
 * This module deliberately does NOT mirror Prisma's legacy TunnelType enum.
 * TunnelType contains historical implementation/wrapper names (wss/mtls/tunex...)
 * and "the enum contains a value" must never be interpreted as "the product
 * supports it". V5 protocols become product-visible only by being added here
 * together with their independent Gate.
 */

export const FORWARD_MODES = ["direct", "relay"] as const;
export type ForwardMode = (typeof FORWARD_MODES)[number];

export const FORWARD_PROTOCOLS = ["tcp"] as const;
export type ForwardProtocol = (typeof FORWARD_PROTOCOLS)[number];

export type ForwardTransportFamily = "stream" | "datagram";

export interface ForwardProtocolSpec {
  readonly family: ForwardTransportFamily;
  /** Compatibility value written to legacy Tunnel.tunnel_type while it exists. */
  readonly legacy_tunnel_type: string;
}

export const DEFAULT_FORWARD_PROTOCOL: ForwardProtocol = "tcp";

export const FORWARD_PROTOCOL_SPECS: Readonly<
  Record<ForwardProtocol, ForwardProtocolSpec>
> = {
  tcp: { family: "stream", legacy_tunnel_type: "tcp" },
};

export function isForwardMode(value: unknown): value is ForwardMode {
  return (
    typeof value === "string" &&
    (FORWARD_MODES as readonly string[]).includes(value)
  );
}

/**
 * Canonicalise a persisted protocol fact without deciding whether the current
 * runtime admits it. This preserves historical legacy facts (wss/tls/udp/...)
 * instead of silently relabelling them as TCP.
 */
export function protocolFactName(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_FORWARD_PROTOCOL;
  }
  if (typeof value !== "string") {
    throw new Error("invalid persisted Forward protocol: " + String(value));
  }
  const name = value.trim().toLowerCase();
  if (name === "") return DEFAULT_FORWARD_PROTOCOL;
  if (name.length > 16) {
    throw new Error("invalid persisted Forward protocol: " + name);
  }
  return name;
}

/**
 * Admission parser. Missing stays V4-compatible TCP; an explicit historical or
 * future protocol is rejected until it is added to FORWARD_PROTOCOLS and has
 * its independent Gate.
 */
export function normalizeForwardProtocol(
  value: unknown,
): ForwardProtocol | null {
  let name: string;
  try {
    name = protocolFactName(value);
  } catch {
    return null;
  }
  if ((FORWARD_PROTOCOLS as readonly string[]).includes(name)) {
    return name as ForwardProtocol;
  }
  return null;
}

/**
 * Read the persisted protocol fact. forward_protocol wins; old rows fall back
 * to legacy tunnel_type so migrations never erase what protocol they actually
 * represented. Whether that fact is executable is checked separately.
 */
export function persistedForwardProtocol(
  value: unknown,
  legacyTunnelType?: unknown,
): string {
  if (value !== undefined && value !== null && value !== "") {
    return protocolFactName(value);
  }
  return protocolFactName(legacyTunnelType);
}

export function legacyTunnelTypeForForwardProtocol(
  protocol: ForwardProtocol,
): string {
  return FORWARD_PROTOCOL_SPECS[protocol].legacy_tunnel_type;
}

export interface ForwardRuntimePlan {
  readonly topology: { readonly mode: ForwardMode };
  readonly protocol: {
    readonly name: ForwardProtocol;
    readonly family: ForwardTransportFamily;
  };
}

/**
 * WP0 contract-only RuntimePlan. It intentionally contains no sockets, ports or
 * hops yet; later WPs may add those facts without conflating topology with
 * protocol.
 */
export function buildForwardRuntimePlan(
  mode: ForwardMode,
  protocol: ForwardProtocol = DEFAULT_FORWARD_PROTOCOL,
): ForwardRuntimePlan {
  if (!isForwardMode(mode)) {
    throw new Error("unsupported Forward mode: " + String(mode));
  }
  const spec = FORWARD_PROTOCOL_SPECS[protocol];
  if (!spec) {
    throw new Error("unsupported Forward protocol: " + String(protocol));
  }
  return {
    topology: { mode },
    protocol: { name: protocol, family: spec.family },
  };
}
