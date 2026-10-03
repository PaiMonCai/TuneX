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
  buildForwardRuntimePlan,
  legacyTunnelTypeForForwardProtocol,
  normalizeForwardProtocol,
  persistedForwardProtocol,
} from "../forward-contract.ts";

describe("V5-WP0 Forward protocol contract", () => {
  test("mode and protocol are orthogonal dimensions", () => {
    expect(FORWARD_MODES).toEqual(["direct", "relay"]);
    expect(FORWARD_PROTOCOLS).toEqual(["tcp"]);
    expect(buildForwardRuntimePlan("direct", "tcp")).toEqual({
      topology: { mode: "direct" },
      protocol: { name: "tcp", family: "stream" },
    });
    expect(buildForwardRuntimePlan("relay", "tcp")).toEqual({
      topology: { mode: "relay" },
      protocol: { name: "tcp", family: "stream" },
    });
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

  test("legacy non-TCP rows are never reinterpreted as TCP", () => {
    expect(() => persistedForwardProtocol(null, "wss")).toThrow(
      "unsupported legacy Forward protocol",
    );
    expect(persistedForwardProtocol(null, "tcp")).toBe("tcp");
  });

  test("explicit unknown persisted values fail closed", () => {
    expect(() => persistedForwardProtocol("carrier-pigeon")).toThrow(
      "unsupported persisted Forward protocol",
    );
  });

  test("legacy projection is explicit and one-way", () => {
    expect(legacyTunnelTypeForForwardProtocol("tcp")).toBe("tcp");
  });
});
