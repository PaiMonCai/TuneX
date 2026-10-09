import { expect, test } from "bun:test";
import { ControlValidator, createCommand } from "../../../services/control-protocol/index.ts";

test("Link commands are distinct, target-bound, fenced resources with secret-free metadata", async () => {
  const validator = new ControlValidator();
  const input = { resource: "link" as const, resource_id: "tunex-link-12-p2-egress", revision: 7,
    action: "apply_link" as const, payload: { link_id: 12, workspace_id: 8, node_id: 2, config_digest: "52".repeat(32) } };
  const apply = createCommand(input);
  let calls = 0;
  const applier = async () => { calls++; return undefined; };
  expect((await validator.handle(apply, applier)).status).toBe("applied");
  const remove = createCommand({ ...input, action: "remove_link", revision: 8,
    payload: { link_id: 12, workspace_id: 8, node_id: 2 } });
  expect((await validator.handle(remove, applier)).status).toBe("applied");
  expect((await validator.handle(createCommand(input), applier)).error_code).toBe("stale_revision");
  expect(calls).toBe(2);
  expect(() => createCommand({ ...input, resource: "tunnel" })).toThrow();
  expect(() => createCommand({ ...input, payload: { ...input.payload, node_id: 0 } })).toThrow();
  expect(() => createCommand({ ...input, payload: { ...input.payload, key: "52".repeat(32) } } as never)).toThrow();
});
