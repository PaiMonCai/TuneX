import { expect, test } from "bun:test";
import { LinkClientSourceSchema, persistedLinkClientSource } from "../client-source.ts";
import { compileFxpLink, FxpLinkInputSchema, type FxpLinkInput } from "../link-compiler.ts";

const disabled = { version: 1 as const, receive_proxy: false, trusted_cidrs: [], send_proxy: "off" as const };
const source = { ...disabled, receive_proxy: true, trusted_cidrs: ["192.0.2.123/24", "2001:0DB8:1234:5678::9/48"], send_proxy: "v2" as const };
const canonical = { ...source, trusted_cidrs: ["192.0.2.0/24", "2001:db8:1234::/48"] };
const targetSet = { version: 1 as const, targets: [{ host: "primary.example", port: 443 }, { host: "backup.example", port: 8443 }],
  strategy: "ip_hash" as const, failure_seconds: 10, recover_seconds: 20, probe: "tcp" as const };
const node = { workspace_id: 3, connect_host: "127.0.0.1", version: "0.0.0-dev",
  capabilities: ["forward.link.fxp.v1", "forward.targets.fxp.v1", "forward.client-source.fxp.v1"] };
function spec(): FxpLinkInput { return { link_id: 7, workspace_id: 3, version: 1, generation: 2,
  ingress: { ...node, id: 11 }, egress: { ...node, id: 12 }, carrier_port: 25000,
  lease_expires_at: "2030-01-01T00:00:00Z", bindings: [{ forward_id: 21, protocol: "tcp", listen_port: 26000,
    target_host: "primary.example", target_port: 443, target_set: structuredClone(targetSet), client_source: structuredClone(source) }] }; }

test("strict client source contract rejects incomplete, coerced, unknown and unsafe trust configs", () => {
  for (const patch of [{ version: 2 }, { receive_proxy: "true" }, { receive_proxy: false },
    { trusted_cidrs: [] }, { trusted_cidrs: ["192.0.2.0/24", "192.0.2.129/24"] },
    { trusted_cidrs: ["2001:db8::/32", "2001:0DB8::7/32"] }, { trusted_cidrs: Array(33).fill("192.0.2.0/24") }, { send_proxy: "v3" }, { extra: true },
    ...["0.0.0.0/0", "::/0", "192.0.2.1", "example.com/24", "127.1/8", "0177.0.0.1/8",
      "192.0.2.1/-1", "192.0.2.1/33", "192.0.2.1/1.0", "192.0.2.1/01", "192.0.2.1/24/1",
      "::ffff:192.0.2.1/104", "::ffff:c000:201/128", "0:0:0:0:0:ffff:c000:201/96", "::1/129", "::1%lo/128", "[::1]/128", "::gg/64", " ::1/128", "::1/128\n"].map(cidr => ({ trusted_cidrs: [cidr] }))]) {
    expect(LinkClientSourceSchema.safeParse({ ...source, ...patch }).success).toBe(false);
  }
  for (const key of Object.keys(disabled)) {
    const body: Record<string, unknown> = { ...disabled }; delete body[key];
    expect(LinkClientSourceSchema.safeParse(body).success).toBe(false);
  }
  expect(LinkClientSourceSchema.parse(disabled)).toEqual(disabled);
  expect(persistedLinkClientSource(null)).toBeUndefined();
  expect(persistedLinkClientSource(undefined)).toBeUndefined();
  expect(() => persistedLinkClientSource({})).toThrow();
});

test("CIDRs are canonical masked networks, including IPv4 tails, partial prefixes and host routes", () => {
  expect(LinkClientSourceSchema.parse(source)).toEqual(canonical);
  const vectors = [["255.255.255.255/1", "128.0.0.0/1"], ["192.0.2.129/25", "192.0.2.128/25"],
    ["192.0.2.3/32", "192.0.2.3/32"], ["2001:db8:ffff::1/33", "2001:db8:8000::/33"],
    ["FFFF::1/1", "8000::/1"], ["::1/128", "::1/128"], ["2001:db8::192.0.2.129/120", "2001:db8::c000:200/120"]];
  const parsed = LinkClientSourceSchema.parse({ ...source, trusted_cidrs: vectors.map(v => v[0]) });
  expect(parsed.trusted_cidrs).toEqual(vectors.map(v => v[1]));
  expect(LinkClientSourceSchema.parse(parsed)).toEqual(parsed);
});

test("compiler rejects any source config or IP_HASH outside TCP, and IP_HASH without explicit source", () => {
  for (const protocol of ["udp", "both"] as const) for (const config of [source, disabled]) {
    const input = spec(); input.bindings[0]!.protocol = protocol; input.bindings[0]!.client_source = config;
    expect(FxpLinkInputSchema.safeParse(input).success).toBe(false);
  }
  const input = spec(); delete input.bindings[0]!.client_source;
  expect(() => compileFxpLink(input, "ab".repeat(32))).toThrow("link_client_source_required");
  input.bindings[0]!.client_source = disabled;
  expect(FxpLinkInputSchema.parse(input).bindings[0]!.client_source).toEqual(disabled);
});

test("compiler binds canonical source config to each rule while retaining full target authorization", () => {
  const input = spec();
  input.bindings.push({ forward_id: 22, protocol: "both", listen_port: 26001, target_host: "legacy.example", target_port: 80 });
  const out = compileFxpLink(input, "ab".repeat(32));
  const runtime = { version: 1, receiveProxy: true, trustedCIDRs: canonical.trusted_cidrs, sendProxy: "v2" };
  const entries = out.ingress.runner_config!.entries as Array<Record<string, unknown>>;
  expect(entries[0]!.clientSource).toEqual(runtime); expect(entries[1]!.clientSource).toBeUndefined();
  expect(out.egress.runner_config!.clientSources).toEqual([{ ...runtime, ruleId: 21 }]);
  expect(out.egress.runner_config!.allowedBindings).toEqual([
    { ruleId: 21, protocol: "tcp", targetIp: "primary.example", targetPort: 443 },
    { ruleId: 21, protocol: "tcp", targetIp: "backup.example", targetPort: 8443 },
    { ruleId: 22, protocol: "tcp", targetIp: "legacy.example", targetPort: 80 },
    { ruleId: 22, protocol: "udp", targetIp: "legacy.example", targetPort: 80 },
  ]);
  expect((out.egress.runner_config!.targetSets as any[])[0].strategy).toBe("ip_hash");
});

test("source changes affect both digests; equivalent networks and legacy absence keep exact identity", () => {
  const input = spec(), before = compileFxpLink(input, "ab".repeat(32));
  input.bindings[0]!.client_source = canonical;
  expect(compileFxpLink(input, "ab".repeat(32))).toEqual(before);
  for (const patch of [{ send_proxy: "v1" as const }, { trusted_cidrs: ["198.51.100.0/24"] }, disabled]) {
    input.bindings[0]!.client_source = { ...canonical, ...patch };
    const after = compileFxpLink(input, "ab".repeat(32));
    expect(after.ingress.config_digest).not.toBe(before.ingress.config_digest);
    expect(after.egress.config_digest).not.toBe(before.egress.config_digest);
  }
  delete input.bindings[0]!.client_source; delete input.bindings[0]!.target_set;
  input.ingress.capabilities = ["forward.link.fxp.v1"]; input.egress.capabilities = ["forward.link.fxp.v1"];
  const legacy = compileFxpLink(input, "ab".repeat(32));
  expect(legacy.egress.runner_config!.clientSources).toBeUndefined();
  expect((legacy.ingress.runner_config!.entries as any[])[0].clientSource).toBeUndefined();
});

test("both endpoints require source capability even for disabled configs; IP_HASH also requires targets", () => {
  for (const role of ["ingress", "egress"] as const) for (const config of [source, disabled]) {
    const input = spec(); input.bindings[0]!.client_source = config;
    input[role].capabilities = ["forward.link.fxp.v1", "forward.targets.fxp.v1"];
    expect(() => compileFxpLink(input, "ab".repeat(32))).toThrow("agent_fxp_source_capability_missing");
    const missingTargets = spec(); missingTargets[role].capabilities = ["forward.link.fxp.v1", "forward.client-source.fxp.v1"];
    expect(() => compileFxpLink(missingTargets, "ab".repeat(32))).toThrow("agent_fxp_targets_capability_missing");
    delete input.bindings[0]!.target_set;
    expect(() => compileFxpLink(input, "ab".repeat(32))).toThrow("agent_fxp_source_capability_missing");
  }
});

test("source metadata participates in the existing 1 MiB preflight budget", () => {
  const input = spec();
  input.bindings = Array.from({ length: 500 }, (_, i) => ({ forward_id: i + 1, protocol: "tcp" as const,
    listen_port: 26000 + i, target_host: "pool.example", target_port: 443,
    client_source: { ...source, trusted_cidrs: Array.from({ length: 32 }, (_, c) => "2001:db8:1234:5678:abcd:1234:5678:" + (0xabcd + c).toString(16) + "/128") },
    target_set: { ...targetSet, strategy: "fallback", targets: Array.from({ length: 10 }, (_, t) => ({ host: "pool.example", port: 443 + t })) } }));
  const withoutSource = structuredClone(input);
  for (const binding of withoutSource.bindings) delete binding.client_source;
  expect(() => compileFxpLink(withoutSource, "ab".repeat(32))).not.toThrow();
  expect(() => compileFxpLink(input, "ab".repeat(32))).toThrow("link_config_too_large");
});
