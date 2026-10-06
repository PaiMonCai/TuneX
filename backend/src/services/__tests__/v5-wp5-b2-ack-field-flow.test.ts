import { describe, expect, test } from "bun:test";
import { ControlValidator } from "../control-protocol/validator.ts";

describe("command ACK hop endpoint contract", () => {
  test("control protocol preserves hop_local_addr on an acknowledged command", async () => {
    const validator = new ControlValidator();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const commandId = "cmd-hop-endpoint";

    const issued = await validator.handle(
      {
        type: "command",
        command_id: commandId,
        resource: "tunnel",
        resource_id: "tunex-42-relay",
        revision: 7,
        action: "suspend_tunnel",
        expires_at: expiresAt,
        payload: {},
      },
      async () => undefined,
    );
    expect(issued.status).toBe("applied");

    const ack = await validator.handle(
      {
        type: "command",
        command_id: "ack-hop-endpoint",
        resource: "tunnel",
        resource_id: "tunex-42-relay",
        revision: 7,
        action: "command_ack",
        expires_at: expiresAt,
        payload: {
          acked_command_id: commandId,
          status: "applied",
          applied_revision: 7,
          hop_local_addr: "172.31.20.10:53121",
        },
      },
      async () => undefined,
    );

    expect(ack.status).toBe("applied");
    expect(ack.hop_local_addr).toBe("172.31.20.10:53121");
  });
});
