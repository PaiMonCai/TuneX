/**
 * V5-WP0 protocol/topology contract guards.
 *
 * Legacy TunnelType values do not become product support merely because they
 * already exist in Prisma.
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FORWARD_PROTOCOL,
  FORWARD_MODES,
  FORWARD_PROTOCOLS,
  FORWARD_TRANSPORTS,
  buildForwardRuntimePlan,
  legacyTunnelTypeForForwardProtocol,
  normalizeForwardProtocol,
  normalizeForwardTransport,
  persistedForwardProtocol,
  protocolFactName,
} from "../forward-contract.ts";

describe("V5-WP0 Forward protocol contract", () => {
  test("mode and protocol are orthogonal dimensions", () => {
    expect(FORWARD_MODES).toEqual(["direct", "relay"]);
    expect(FORWARD_PROTOCOLS).toEqual(["tcp"]);
    expect(FORWARD_TRANSPORTS).toEqual(["stream"]);
    expect(buildForwardRuntimePlan("direct", "tcp")).toEqual({
      topology: { mode: "direct" },
      protocol: { name: "tcp" },
      transport: { name: "stream", lifecycle: "connection" },
    });
    expect(buildForwardRuntimePlan("relay", "tcp")).toEqual({
      topology: { mode: "relay" },
      protocol: { name: "tcp" },
      transport: { name: "stream", lifecycle: "connection" },
    });
  });

  test("transport is derived and unknown transport fails closed", () => {
    expect(normalizeForwardTransport("stream")).toBe("stream");
    expect(normalizeForwardTransport("datagram")).toBeNull();
    expect(normalizeForwardTransport("carrier-pigeon")).toBeNull();
  });

  test("V4 omission remains TCP-compatible", () => {
    expect(DEFAULT_FORWARD_PROTOCOL).toBe("tcp");
    expect(normalizeForwardProtocol(undefined)).toBe("tcp");
    expect(normalizeForwardProtocol(null)).toBe("tcp");
    expect(persistedForwardProtocol(null)).toBe("tcp");
  });

  test("legacy enum presence does not advertise product support", () => {
    for (const legacy of ["udp", "wss", "tls", "quic", "mtcp", "tunex"]) {
      expect(normalizeForwardProtocol(legacy)).toBeNull();
    }
  });

  test("historical protocol facts are preserved without being admitted", () => {
    expect(persistedForwardProtocol(null, "WSS")).toBe("wss");
    expect(persistedForwardProtocol(" TLS ", "tcp")).toBe("tls");
    expect(protocolFactName(" QUIC ")).toBe("quic");
    expect(normalizeForwardProtocol("wss")).toBeNull();
    expect(normalizeForwardProtocol("quic")).toBeNull();
  });

  test("malformed persisted values still fail closed", () => {
    expect(() => persistedForwardProtocol({ bad: true })).toThrow(
      "invalid persisted Forward protocol",
    );
  });

  test("legacy projection is explicit and one-way", () => {
    expect(legacyTunnelTypeForForwardProtocol("tcp")).toBe("tcp");
  });
});
