import { expect, test } from "bun:test";
import { LinkTargetSetSchema, persistedLinkTargetSet } from "../target-set.ts";
import { compileFxpLink, type FxpLinkInput } from "../link-compiler.ts";

const targetSet = { version: 1 as const, targets: [{ host: "primary.example", port: 443 }, { host: "backup.example", port: 8443 }],
  strategy: "fallback" as const, failure_seconds: 10, recover_seconds: 20, probe: "tcp" as const };
const node = { workspace_id: 3, connect_host: "127.0.0.1", version: "0.0.0-dev", capabilities: ["forward.link.fxp.v1", "forward.targets.fxp.v1"] };
function spec(): FxpLinkInput { return { link_id: 7, workspace_id: 3, version: 1, generation: 2,
  ingress: { ...node, id: 11 }, egress: { ...node, id: 12 }, carrier_port: 25000,
  lease_expires_at: "2030-01-01T00:00:00Z", bindings: [{ forward_id: 21, protocol: "both", listen_port: 26000,
    target_host: "primary.example", target_port: 443, target_set: structuredClone(targetSet) }] }; }
test("ordered complete target sets compile into protocol-scoped exit authorization", () => {
  const compiled = compileFxpLink(spec(), "ab".repeat(32));
  expect(compiled.egress.runner_config!.allowedBindings).toEqual([
    { ruleId: 21, protocol: "tcp", targetIp: "primary.example", targetPort: 443 },
    { ruleId: 21, protocol: "tcp", targetIp: "backup.example", targetPort: 8443 },
    { ruleId: 21, protocol: "udp", targetIp: "primary.example", targetPort: 443 },
    { ruleId: 21, protocol: "udp", targetIp: "backup.example", targetPort: 8443 },
  ]);
  expect(compiled.egress.runner_config!.targetSets).toEqual([{ version: 1, ruleId: 21, protocol: "both",
    targets: targetSet.targets, strategy: "fallback", failureSeconds: 10, recoverSeconds: 20, probe: "tcp" }]);
});
test("backup-only edits change config identity while order and legacy behavior remain explicit", () => {
  const a = spec(), before = compileFxpLink(a, "ab".repeat(32));
  a.bindings[0]!.target_set!.targets[1]!.port++;
  const after = compileFxpLink(a, "ab".repeat(32));
  expect(after.egress.config_digest).not.toBe(before.egress.config_digest);
  expect(after.ingress.config_digest).not.toBe(before.ingress.config_digest);
  delete a.bindings[0]!.target_set;
  const legacy = compileFxpLink(a, "ab".repeat(32));
  expect(legacy.egress.runner_config!.targetSets).toBeUndefined();
  expect(legacy.egress.runner_config!.allowedBindings).toHaveLength(2);
  expect(persistedLinkTargetSet(null)).toBeUndefined();
  expect(() => persistedLinkTargetSet({})).toThrow();
});
test("unknown/legacy nodes cannot silently run a target set", () => {
  for (const role of ["ingress", "egress"] as const) {
    const input = spec(); input[role].capabilities = ["forward.link.fxp.v1"];
    expect(() => compileFxpLink(input, "ab".repeat(32))).toThrow("agent_fxp_targets_capability_missing");
  }
  const input = spec(); input.bindings[0]!.target_host = "foreign.example";
  expect(() => compileFxpLink(input, "ab".repeat(32))).toThrow("target_set_first_mismatch");
});
test("target sets reject duplicate, malformed, oversize, unknown strategy and unbounded windows", () => {
  for (const patch of [{ targets: [] }, { targets: Array.from({ length: 11 }, (_, i) => ({ host: `t${i}`, port: 80 })) },
    { targets: [{ host: "PRIMARY.example", port: 443 }, { host: "primary.example", port: 443 }] },
    { targets: [{ host: "bad/host", port: 80 }] }, { targets: [{ host: "ok", port: 0 }] },
    { targets: [{ host: "host\\path", port: 80 }] }, { targets: [{ host: "host:80", port: 80 }] },
    { targets: [{ host: "[::1]", port: 80 }] },
    { failure_seconds: 9 }, { recover_seconds: 3601 }, { strategy: "ip_hash" }, { probe: "udp" }, { version: 2 }, { key: "unused" }]) {
    expect(LinkTargetSetSchema.safeParse({ ...targetSet, ...patch }).success).toBe(false);
  }
  expect(LinkTargetSetSchema.parse({ ...targetSet, probe: "none" }).probe).toBe("none");
  expect(LinkTargetSetSchema.parse({ ...targetSet, targets: [{ host: "2001:db8::1", port: 443 }] }).targets[0]!.host).toBe("2001:db8::1");
});

test("oversize complete authorization is rejected before runner admission", () => {
  const input = spec();
  input.bindings = Array.from({ length: 500 }, (_, i) => ({ forward_id: i + 1, protocol: "both" as const,
    listen_port: 26000 + i, target_host: "a".repeat(250), target_port: 443,
    target_set: { ...targetSet, targets: Array.from({ length: 10 }, (_, t) => ({ host: "a".repeat(250), port: 443 + t })) } }));
  expect(() => compileFxpLink(input, "ab".repeat(32))).toThrow("link_config_too_large");
});
