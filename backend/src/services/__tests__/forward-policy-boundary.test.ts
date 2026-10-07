import { beforeEach, expect, test } from "bun:test";
import { policyFixture as state } from "./forward-policy-offline-preload.ts";
import { createForward, deleteForward, forwardView, patchForward, previewForwardUpdate, runForwardAction } from "../forward-service.ts";

beforeEach(() => {
  state.rows = [{ id: 71, workspace_id: 7, link_resource_id: 5, name: "linked", tunnel_mode: "relay", forward_protocol: "both",
    listen_port: 23000, remote_host: "business.example", remote_port: 8080, config_revision: 3 }];
  state.mutations = 0; state.reads = [];
});
test("existing linked forwards fail closed at every legacy writer, including preview and actions", async () => {
  for (const result of [
    await patchForward(71, 7, { max_connections: 1 }), await previewForwardUpdate(71, 7, { max_connections: 1 }),
    await runForwardAction(71, "suspend", 7), await runForwardAction(71, "resume", 7),
    await runForwardAction(71, "retry", 7), await deleteForward(71, 7),
  ]) expect(result).toMatchObject({ ok: false, status: 409, code: "link_managed_forward" });
  expect(state.mutations).toBe(0);
  expect(state.reads.every((query) => query === "tunnel.findFirst")).toBe(true);
});
test("forged Link identity cannot enter create or patch even on a native row", async () => {
  expect(await createForward(1, 7, { link_resource_id: 5 } as any)).toMatchObject({ ok: false, code: "link_managed_forward" });
  state.rows[0].link_resource_id = null;
  expect(await patchForward(71, 7, { link_resource_id: 5 } as any)).toMatchObject({ ok: false, code: "link_managed_forward" });
  expect(await previewForwardUpdate(71, 7, { link_resource_id: 5 } as any)).toMatchObject({ ok: false, code: "link_managed_forward" });
  expect(state.mutations).toBe(0);
});
test("view preserves Link identity/relay target and only marks Link both supported with feature enabled", () => {
  const previous = process.env.TUNEX_FXP_LINKS_ENABLED;
  try {
    process.env.TUNEX_FXP_LINKS_ENABLED = "true";
    expect(forwardView(state.rows[0])).toMatchObject({ link_resource_id: 5, protocol: "both", protocol_supported: true,
      target_host: "business.example", target_port: 8080, max_connections: 0 });
    expect(forwardView({ ...state.rows[0], link_resource_id: null }).protocol_supported).toBe(false);
    process.env.TUNEX_FXP_LINKS_ENABLED = "false";
    expect(forwardView(state.rows[0]).protocol_supported).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.TUNEX_FXP_LINKS_ENABLED;
    else process.env.TUNEX_FXP_LINKS_ENABLED = previous;
  }
});
