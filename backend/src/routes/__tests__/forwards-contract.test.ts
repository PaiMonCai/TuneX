import { describe, expect, test } from "bun:test";
import { ForwardCreateSchema, ForwardPatchSchema } from "../forwards.ts";

describe("Forward request contracts", () => {
  test("PATCH accepts the editable product fields and legacy name-only updates", () => {
    expect(ForwardPatchSchema.safeParse({ name: "renamed" }).success).toBe(true);
    expect(ForwardPatchSchema.safeParse({
      name: "edge",
      mode: "relay",
      ingress_node_id: 1,
      egress_node_id: 2,
      middle_node_id: 3,
      listen_port: 8443,
      target_host: "example.test",
      target_port: 443,
      tls_cert_path: "/etc/tunex/cert.pem",
      tls_key_path: "/etc/tunex/key.pem",
      federated_egress_peer: "peer-b",
      expected_revision: 7,
    }).success).toBe(true);
  });

  test("PATCH is fail-closed for unknown fields and protocol mutation", () => {
    expect(ForwardPatchSchema.safeParse({ name: "x", unknown: true }).success).toBe(false);
    expect(ForwardPatchSchema.safeParse({ protocol: "udp" }).success).toBe(false);
  });

  test("expected_revision remains optional, nullable and non-negative", () => {
    expect(ForwardPatchSchema.safeParse({ name: "x" }).success).toBe(true);
    expect(ForwardPatchSchema.safeParse({ expected_revision: null }).success).toBe(true);
    expect(ForwardPatchSchema.safeParse({ expected_revision: 0 }).success).toBe(true);
    expect(ForwardPatchSchema.safeParse({ expected_revision: -1 }).success).toBe(false);
  });

  test("create and patch agree on TLS path shape", () => {
    const createBase = {
      name: "tls",
      mode: "direct" as const,
      protocol: "tls" as const,
      ingress_node_id: 1,
      target_host: "example.test",
      target_port: 443,
    };
    expect(ForwardCreateSchema.safeParse({ ...createBase, tls_cert_path: "relative.pem" }).success).toBe(false);
    expect(ForwardPatchSchema.safeParse({ tls_cert_path: "relative.pem" }).success).toBe(false);
    expect(ForwardPatchSchema.safeParse({ tls_cert_path: "/etc/tunex/cert.pem" }).success).toBe(true);
  });
});
