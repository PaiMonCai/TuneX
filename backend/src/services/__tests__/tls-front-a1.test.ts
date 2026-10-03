/**
 * V5-WP5-A1 —— TLS 前端的**面板侧**契约。
 *
 * 契约（DEVELOPMENT.md §6.1）把「谁说话（protocol）」和「怎么保护（TLS）」拆开，
 * 并规定证书以**节点本地路径**形式流经控制面。这两条规则必须在面板侧 fail-closed：
 *
 *   · `protocol=tls` 没有证书路径 → 拒绝。下发一句「去提供 TLS」却不给证书，
 *     在节点上只有一个结局：监听起不来（或者更糟——用错证书起来）。
 *   · 非 tls 协议携带证书路径 → 拒绝。把路径挂到 tcp 上，等于在线上多出两个
 *     Agent 必须主动忽略的字段，而「Agent 会忽略它」不是契约。
 *
 * 面板**不**检查文件是否存在：证书在节点上，面板看不见。存在性由 Agent 在
 * bind 之前用 `tls.LoadX509KeyPair` 判断（见 agent/internal/forwarder/tls_test.go）。
 */
import { describe, expect, test } from "bun:test";
import {
  FORWARD_PROTOCOLS,
  FORWARD_PROTOCOL_SPECS,
  buildForwardRuntimePlan,
  legacyTunnelTypeColumn,
  legacyTunnelTypeForForwardProtocol,
  tlsPathsForProtocol,
  wireTunnelTypeForForwardProtocol,
} from "../forward-contract.ts";

const CERT = "/etc/tunex/tls/site.crt";
const KEY = "/etc/tunex/tls/site.key";

describe("tls is a protocol, not a transport", () => {
  test("tls is open and rides the stream transport", () => {
    // ws joined in V5-WP5-A2; both are stream protocols.
    expect([...FORWARD_PROTOCOLS]).toEqual(["tcp", "tls", "ws"]);
    expect(FORWARD_PROTOCOL_SPECS.tls.transport).toBe("stream");
    expect(FORWARD_PROTOCOL_SPECS.tls.legacy_tunnel_type).toBe("tls");
    // The plan shape is unchanged: a tls Forward is a stream plan like any other.
    const plan = buildForwardRuntimePlan("direct", "tls");
    expect(plan.transport).toEqual({ name: "stream", lifecycle: "connection" });
  });

  test("wss is still NOT a protocol value", () => {
    // Framing and transport security are separate dimensions; adding `wss` as a
    // protocol name is the conflation V5-WP0 removed.
    expect([...FORWARD_PROTOCOLS]).not.toContain("wss");
    expect(() => buildForwardRuntimePlan("direct", "wss" as never)).toThrow();
  });
});

describe("the legacy column is a projection, and says 'none' when it must", () => {
  test("tcp and tls still map onto legacy enum values", () => {
    expect(legacyTunnelTypeForForwardProtocol("tcp")).toBe("tcp");
    expect(legacyTunnelTypeForForwardProtocol("tls")).toBe("tls");
    expect(legacyTunnelTypeColumn("tls")).toEqual({ tunnel_type: "tls" });
  });

  /**
   * V5-WP5-A2: the legacy Prisma enum has `wss` but not `ws`. Writing `wss`
   * would assert "WebSocket over TLS" about a plain-WS tunnel — a lie in a column
   * older readers still consult — and adding `ws` to the enum is the
   * protocol-set churn §3.4 warns against. So the projection is "nothing useful
   * to say": the column is omitted and the canonical fact stands alone.
   *
   * This was found by the real API returning 500 on the first ws create: Prisma
   * rejected `tunnel_type: "ws"` because the enum has no such member.
   */
  test("a protocol the legacy enum cannot express omits the column", () => {
    expect(legacyTunnelTypeForForwardProtocol("ws")).toBeNull();
    expect(legacyTunnelTypeColumn("ws")).toEqual({});
  });

  /**
   * The WIRE echo is a different projection from the DB column: the wire
   * vocabulary can carry the protocol name itself, so it never has to be null.
   */
  test("the wire echo falls back to the protocol name when there is no legacy value", () => {
    expect(wireTunnelTypeForForwardProtocol("tcp")).toBe("tcp");
    expect(wireTunnelTypeForForwardProtocol("tls")).toBe("tls");
    expect(wireTunnelTypeForForwardProtocol("ws")).toBe("ws");
  });

  test("every protocol has a legacy decision, and the column shape matches it", () => {
    for (const protocol of FORWARD_PROTOCOLS) {
      const legacy = legacyTunnelTypeForForwardProtocol(protocol);
      const column = legacyTunnelTypeColumn(protocol);
      if (legacy === null) {
        expect(column).toEqual({});
      } else {
        expect(column).toEqual({ tunnel_type: legacy });
      }
    }
  });
});

describe("tls path rules fail closed", () => {
  test("tls with both paths is accepted, and the column shape is explicit", () => {
    const result = tlsPathsForProtocol("tls", CERT, KEY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.columns).toEqual({ tls_cert_path: CERT, tls_key_path: KEY });
  });

  test("tls without both paths is refused", () => {
    for (const [cert, key] of [
      [undefined, undefined],
      [CERT, undefined],
      [undefined, KEY],
      ["", ""],
      ["   ", KEY],
      [CERT, "  "],
    ] as const) {
      const result = tlsPathsForProtocol("tls", cert, key);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("tls");
    }
  });

  test("only tls may carry certificate paths", () => {
    for (const protocol of FORWARD_PROTOCOLS) {
      if (protocol === "tls") continue;
      expect(tlsPathsForProtocol(protocol, CERT, KEY).ok).toBe(false);
      expect(tlsPathsForProtocol(protocol, CERT, undefined).ok).toBe(false);
      // ... and a non-tls protocol with no paths is the normal case.
      const clean = tlsPathsForProtocol(protocol, undefined, undefined);
      expect(clean.ok).toBe(true);
      if (clean.ok) expect(clean.columns).toEqual({ tls_cert_path: null, tls_key_path: null });
    }
  });

  test("paths must be node-local absolute paths", () => {
    for (const bad of ["relative/site.crt", "./site.crt", "C:\\certs\\site.crt"]) {
      expect(tlsPathsForProtocol("tls", bad, KEY).ok).toBe(false);
    }
  });

  test("paths are trimmed, not silently accepted with whitespace", () => {
    const result = tlsPathsForProtocol("tls", `  ${CERT}  `, KEY);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.columns.tls_cert_path).toBe(CERT);
  });
});
