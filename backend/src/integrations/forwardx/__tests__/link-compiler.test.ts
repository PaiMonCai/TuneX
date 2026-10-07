import { expect, test } from "bun:test";
import { compileFxpLink, type FxpLinkInput } from "../link-compiler.ts";

const key = "a".repeat(64);
function input(): FxpLinkInput {
  const node = { workspace_id: 3, connect_host: "127.0.0.1", version: "0.0.0-dev", capabilities: ["forward.link.fxp.v1"] };
  return { link_id: 7, workspace_id: 3, version: 1, generation: 1,
    ingress: { ...node, id: 11 }, egress: { ...node, id: 12 }, carrier_port: 25000,
    lease_expires_at: "2030-01-01T00:00:00Z", bindings: [
      { forward_id: 21, protocol: "both", listen_port: 26000, target_host: "127.0.0.1", target_port: 27000 },
      { forward_id: 22, protocol: "tcp", listen_port: 26001, target_host: "127.0.0.1", target_port: 27001 },
    ] };
}
test("two bindings merge into one deployment, both has concrete children, exit is target-bound", () => {
  const out = compileFxpLink(input(), key);
  expect(out.ingress.runner_config?.entries).toHaveLength(2);
  expect(out.ingress.runner_config?.managedReload).toBe(true);
  expect((out.ingress.runner_config?.entries as Array<Record<string, unknown>>)[0]).toMatchObject({ protocol: "both" });
  expect(out.ingress.runtime_ids).toHaveLength(3);
  expect(out.egress.runner_config).toMatchObject({ requireBindingAuth: true, managedReload: true });
  expect(out.egress.runner_config?.allowedBindings).toHaveLength(3);
  expect(out.egress.runner_config?.udpTargets).toEqual([{ ruleId: 21, targetIp: "127.0.0.1", targetPort: 27000 }]);
});
test("delete A preserves B, zero bindings preserve carrier with passive ingress", () => {
  const spec = input();
  const before = compileFxpLink(spec, key);
  spec.bindings = spec.bindings.filter((b) => b.forward_id === 22);
  spec.generation++;
  const after = compileFxpLink(spec, key);
  expect(after.ingress.id).toBe(before.ingress.id);
  expect(after.ingress.runner_config?.entries).toHaveLength(1);
  spec.bindings = [];
  const empty = compileFxpLink(spec, key);
  expect(empty.ingress.runner_config).toBeNull();
  expect(empty.egress.runner_config?.allowedBindings).toEqual([]);
  expect(empty.egress.ports).toHaveLength(2);
});
test("permissions, capabilities, duplicate rules and same-protocol port conflicts fail closed", () => {
  const cross = input(); cross.egress.workspace_id = 4;
  expect(() => compileFxpLink(cross, key)).toThrow("cross_workspace");
  const old = input(); old.egress.capabilities = [];
  expect(() => compileFxpLink(old, key)).toThrow("capability_missing");
  const conflict = input(); conflict.bindings[1]!.listen_port = 26000;
  expect(() => compileFxpLink(conflict, key)).toThrow("listener_conflict");
  const duplicate = input(); duplicate.bindings[1]!.forward_id = 21;
  expect(() => compileFxpLink(duplicate, key)).toThrow("duplicate_forward");
});
test("config digest is deterministic without making generation a second config writer", () => {
  const a = input(), b = input(); b.bindings.reverse(); b.generation++;
  expect(compileFxpLink(a, key).ingress.config_digest).toBe(compileFxpLink(b, key).ingress.config_digest);
  b.bindings[0]!.target_port++;
  expect(compileFxpLink(a, key).ingress.config_digest).not.toBe(compileFxpLink(b, key).ingress.config_digest);
});
