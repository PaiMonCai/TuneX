import { describe, expect, test } from "bun:test";
import { bindScopesOverlap, leaseProtocol, normalizeBindScope, protocolsOverlap } from "../bind-scope.ts";

describe("socket protocol and bind scope boundaries", () => {
  test.each([
    [undefined, "unknown"], [null, "unknown"], ["", "unknown"], ["future", "unknown"],
    ["both", "unknown"], ["TCP", "tcp"], [" tls ", "tcp"], ["ws", "tcp"], ["UDP", "udp"],
  ] as const)("normalizes protocol %p", (value, expected) => expect(leaseProtocol(value)).toBe(expected));

  test.each([
    ["", "*"], ["*", "*"], ["0.0.0.0", "*"], ["[::]", "*"],
    ["[::ffff:127.0.0.1]", "127.0.0.1"], ["::ffff:7f00:1", "127.0.0.1"],
    ["::ffff:0.0.0.0", "*"], ["[2001:0DB8:0:0::1]", "2001:db8::1"],
    ["[fe80::1%eth0]", "fe80::1%eth0"], [" LOCALHOST. ", "localhost."],
  ])("canonicalizes scope %s", (value, expected) => expect(normalizeBindScope(value)).toBe(expected));

  test.each([
    ["127.0.0.1", "127.0.0.2", false], ["127.0.0.1", "::1", false],
    ["127.0.0.1", "::ffff:127.0.0.1", true], ["::1", "0:0:0:0:0:0:0:1", true],
    ["0.0.0.0", "::1", true], ["::", "127.0.0.1", true],
    ["localhost", "192.0.2.1", true], ["unknown.invalid", "::1", true],
    ["fe80::1%eth0", "fe80::1%eth1", true], [null, "127.0.0.1", true],
  ])("overlap %p / %p", (left, right, expected) => {
    expect(bindScopesOverlap(left, right)).toBe(expected);
    expect(bindScopesOverlap(right, left)).toBe(expected);
  });

  test("unknown protocol occupies both, while TCP aliases remain independent of UDP", () => {
    for (const left of [null, undefined, "future", "both", ""]) {
      for (const right of ["tcp", "udp"]) expect(protocolsOverlap(left, right)).toBe(true);
    }
    for (const left of ["tcp", "tls", "ws"]) {
      expect(protocolsOverlap(left, "tcp")).toBe(true);
      expect(protocolsOverlap(left, "udp")).toBe(false);
    }
  });
});
