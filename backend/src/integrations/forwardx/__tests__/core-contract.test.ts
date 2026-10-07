import { describe, expect, test } from "bun:test";

import {
  FORWARD_EXECUTION_MATRIX,
  LEGACY_COMPATIBILITY,
  NEW_LINK_AGENT_POLICY,
  admitExecutionSelection,
  canonicalConfigDigest,
  canonicalJson,
  executionMatrixEntry,
  legacyForwardSelection,
  linkRuntimeId,
  protocolPortLeaseKey,
} from "../core-contract.ts";

describe("A01 ForwardX integration contract", () => {
  test("legacy protocol facts map into four orthogonal dimensions without inventing hop encryption", () => {
    expect(legacyForwardSelection("tcp")).toEqual({
      business_protocol: "tcp",
      client_front: "plain",
      carrier: "native_private",
      driver: "native",
    });
    expect(legacyForwardSelection("tls")).toEqual({
      business_protocol: "tcp",
      client_front: "tls",
      carrier: "native_private",
      driver: "native",
    });
    expect(legacyForwardSelection("ws")).toEqual({
      business_protocol: "tcp",
      client_front: "ws",
      carrier: "native_private",
      driver: "native",
    });
    expect(legacyForwardSelection("udp")?.business_protocol).toBe("udp");
    expect(legacyForwardSelection("wss")).toBeNull();
  });

  test("planned secure carriers fail closed and never downgrade to native_private", () => {
    const wanted = {
      business_protocol: "tcp",
      client_front: "plain",
      carrier: "fxp_v1",
      driver: "fxp",
    } as const;
    const result = admitExecutionSelection(wanted, {
      version: "0.99.0",
      capabilities: ["forward.native.stream.v1"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("capability_not_released");
      expect(result.entry?.carrier).toBe("fxp_v1");
    }
    expect(NEW_LINK_AGENT_POLICY.allow_runtime_fallback).toBe(false);
  });

  test("new Link execution requires a known Agent version and explicit capabilities", () => {
    const nativeTcp = {
      business_protocol: "tcp",
      client_front: "plain",
      carrier: "native_private",
      driver: "native",
    } as const;

    expect(admitExecutionSelection(nativeTcp, { version: "unknown", capabilities: ["forward.native.stream.v1"] }))
      .toMatchObject({ ok: false, code: "agent_version_unknown" });
    expect(admitExecutionSelection(nativeTcp, { version: "0.14.0", capabilities: null }))
      .toMatchObject({ ok: false, code: "agent_capabilities_missing" });
    expect(admitExecutionSelection(nativeTcp, { version: "0.14.0", capabilities: [] }))
      .toMatchObject({ ok: false, code: "agent_capability_missing" });
    expect(admitExecutionSelection(nativeTcp, { version: "0.14.0", capabilities: ["forward.native.stream.v1"] }))
      .toMatchObject({ ok: true });
  });

  test("enum presence is not support: both/GOST/WG/m* remain planned", () => {
    const planned = FORWARD_EXECUTION_MATRIX.filter((entry) => entry.release === "planned");
    expect(planned.some((entry) => entry.business_protocol === "both")).toBe(true);
    expect(planned.some((entry) => entry.driver === "gost")).toBe(true);
    expect(planned.some((entry) => entry.driver === "wireguard")).toBe(true);
    expect(planned.every((entry) => executionMatrixEntry(entry)?.release === "planned")).toBe(true);
  });

  test("canonical digest is stable under object-key order and changes with execution facts", () => {
    const a = {
      contract_version: "tunex-forward-link/v1",
      version: 1,
      topology: { b: 2, a: 1 },
      hops: [{ index: 0, carrier: "native_private", driver: "native" }],
    };
    const b = {
      hops: [{ driver: "native", carrier: "native_private", index: 0 }],
      topology: { a: 1, b: 2 },
      version: 1,
      contract_version: "tunex-forward-link/v1",
    };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalConfigDigest(a)).toBe(canonicalConfigDigest(b));
    expect(
      canonicalConfigDigest({
        ...b,
        hops: [{ driver: "fxp", carrier: "fxp_v1", index: 0 }],
      }),
    ).not.toBe(canonicalConfigDigest(a));
  });

  test("canonicalisation refuses ambiguous/non-JSON values", () => {
    expect(() => canonicalJson({ value: undefined })).toThrow("canonical_json_unsupported_value:value");
    expect(() => canonicalJson({ value: Number.NaN })).toThrow("canonical_json_non_finite_number");
  });

  test("runtime ids are deterministic and both must split into protocol child runtimes", () => {
    expect(
      linkRuntimeId({
        link_id: 7,
        link_version: 3,
        placement_id: 11,
        role: "ingress",
        protocol: "tcp",
      }),
    ).toBe("tunex-link-7-v3-p11-ingress-tcp");
    expect(
      linkRuntimeId({
        link_id: 7,
        link_version: 3,
        placement_id: 11,
        role: "ingress",
        protocol: "udp",
      }),
    ).toBe("tunex-link-7-v3-p11-ingress-udp");
  });

  test("lease identity already separates protocol even before A04 changes the DB index", () => {
    const tcp = protocolPortLeaseKey({
      node_id: 9,
      bind_scope: "ipv4:*",
      protocol: "tcp",
      port: 443,
    });
    const udp = protocolPortLeaseKey({
      node_id: 9,
      bind_scope: "ipv4:*",
      protocol: "udp",
      port: 443,
    });
    expect(tcp).not.toBe(udp);
    expect(tcp).toContain("protocol:tcp");
    expect(udp).toContain("protocol:udp");
  });

  test("legacy migration is explicit and never re-labels plaintext as encrypted", () => {
    expect(LEGACY_COMPATIBILITY.unbound_tunnel_mode).toBe("legacy_private");
    expect(LEGACY_COMPATIBILITY.plaintext_reclassification_allowed).toBe(false);
    expect(LEGACY_COMPATIBILITY.binding_delete_deletes_link).toBe(false);
    expect(LEGACY_COMPATIBILITY.shared_runtime_writer_count).toBe(1);
  });

  test("non-native execution cannot become available without a concrete minimum Agent version", () => {
    const invalidRelease = FORWARD_EXECUTION_MATRIX.filter(
      (entry) =>
        entry.release === "available" &&
        entry.driver !== "native" &&
        entry.minimum_agent_version === null,
    );
    expect(invalidRelease).toEqual([]);
  });
});
