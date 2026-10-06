import { describe, expect, test } from "bun:test";
import { ControlProtocolValidator } from "../control-protocol/validator.ts";

describe("command ACK hop endpoint contract", () => {
  test("control protocol preserves hop_local_addr in the acknowledged command", () => {
    const validator = new ControlProtocolValidator();
    const commandId = "cmd-hop-endpoint";
    const apply = {
      type: "command" as const,
      command_id: commandId,
      resource: "tunnel" as const,
      resource_id: "tunex-42-relay",
      revision: 7,
      action: "apply_tunnel" as const,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      payload: { config: { id: "tunex-42-relay" } },
    };
    const issued = validator.validateCommand(apply as never);
    expect(issued.ok).toBe(true);

    const ack = validator.validateCommand({
      ...apply,
      action: "command_ack",
      payload: {
        acked_command_id: commandId,
        ok: true,
        applied_revision: 7,
        hop_local_addr: "172.31.20.10:53121",
      },
    } as never);
    expect(ack.ok).toBe(true);
    if (ack.ok) expect(ack.command.payload.hop_local_addr).toBe("172.31.20.10:53121");
  });
});
