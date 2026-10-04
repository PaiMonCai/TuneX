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
    // V5-WP5-A1/A2: tls and ws joined the product protocol list, each together
    // with its own Gate. This assertion is the deliberate, reviewable act of
    // opening a protocol — it must never change silently.
    expect(FORWARD_PROTOCOLS).toEqual(["tcp", "tls", "ws", "udp"]);
    expect(FORWARD_TRANSPORTS).toEqual(["stream", "datagram"]);
    // V5-WP2 补全了计划的其余事实（revision / placement / listener / upstream），
    // 所以这里不再断言"只有三个字段" —— 那正是 WP2 要改的东西。协议的判定
    // 仍然只看这三个维度。
    const direct = buildForwardRuntimePlan("direct", "tcp");
    expect({
      topology: direct.topology,
      protocol: direct.protocol,
      transport: direct.transport,
    }).toEqual({
      topology: { mode: "direct" },
      protocol: { name: "tcp" },
      transport: { name: "stream", lifecycle: "connection" },
    });
    expect(buildForwardRuntimePlan("relay", "tcp").topology).toEqual({ mode: "relay" });
    // 未提供事实时其余字段是显式的"尚未确定"，不能是未定义。
    expect(direct.revision).toBe(0);
    expect(direct.placement).toEqual({ ingress_node_id: null, egress_node_id: null, egress_pool_id: null });
    expect(direct.listener).toEqual({ host: null, port: null });
    expect(direct.upstream).toEqual({ targets: [], next_hop: null });
  });

  test("transport is derived and unknown transport fails closed", () => {
    expect(normalizeForwardTransport("stream")).toBe("stream");
    // V5.1b opened the datagram transport; it is a TRANSPORT, so it normalises as
    // one and is never a value a user picks — the protocol does that.
    expect(normalizeForwardTransport("datagram")).toBe("datagram");
    expect(normalizeForwardTransport("carrier-pigeon")).toBeNull();
    expect(normalizeForwardTransport("udp")).toBeNull();
  });

  test("V4 omission remains TCP-compatible", () => {
    expect(DEFAULT_FORWARD_PROTOCOL).toBe("tcp");
    expect(normalizeForwardProtocol(undefined)).toBe("tcp");
    expect(normalizeForwardProtocol(null)).toBe("tcp");
    expect(persistedForwardProtocol(null)).toBe("tcp");
  });

  test("legacy enum presence does not advertise product support", () => {
    // `tls` left this list in V5-WP5-A1 (it is now an open protocol with its own
    // Gate); `wss` stays out on purpose: the WS framing and the TLS transport
    // security are separate dimensions, and collapsing them into one enum name
    // is exactly what V5-WP0 undid.
    // `udp` left this list in V5.1b (WP5-B1): it is now an open protocol on its
    // own transport. Its Gate is V5-G1B, so it must not be advertised as usable
    // until that passes — but the CONTRACT knows it, which is what this list is.
    for (const legacy of ["wss", "quic", "mtcp", "tunex"]) {
      expect(normalizeForwardProtocol(legacy)).toBeNull();
    }
    // And the open ones really are admitted — the two halves of the rule stay
    // checked together, so "remove the name from the refused list" can never be
    // the only change.
    expect(normalizeForwardProtocol("tls")).toBe("tls");
    expect(normalizeForwardProtocol("ws")).toBe("ws");
    expect(normalizeForwardProtocol("udp")).toBe("udp");
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
