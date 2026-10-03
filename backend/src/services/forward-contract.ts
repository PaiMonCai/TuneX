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
 * Missing protocol means the V4-compatible TCP default. Any explicit unknown
 * value is rejected instead of falling through to a legacy TunnelType.
 */
export function normalizeForwardProtocol(
  value: unknown,
): ForwardProtocol | null {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_FORWARD_PROTOCOL;
  }
  if (
    typeof value === "string" &&
    (FORWARD_PROTOCOLS as readonly string[]).includes(value)
  ) {
    return value as ForwardProtocol;
  }
  return null;
}

/**
 * Read a persisted canonical value. NULL is tolerated only as the
 * expand-and-contract compatibility state and means the V4 TCP baseline.
 * A non-null unknown value is corruption and fails closed.
 */
export function persistedForwardProtocol(value: unknown): ForwardProtocol {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_FORWARD_PROTOCOL;
  }
  const parsed = normalizeForwardProtocol(value);
  if (parsed === null) {
    throw new Error("unsupported persisted Forward protocol: " + String(value));
  }
  return parsed;
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
