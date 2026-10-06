import { describe, expect, test } from "bun:test";
import { ControlValidator } from "../control-protocol/validator.ts";

describe("command ACK hop endpoint contract", () => {
  test("control protocol preserves hop_local_addr on an acknowledged command", async () => {
    const validator = new ControlValidator();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const commandId = "cmd-hop-endpoint";

    const issued = await validator.handle(
      {
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

  test("malformed hop_local_addr is rejected at the control-protocol boundary", () => {
    const validator = new ControlValidator();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    for (const hopLocalAddr of [
      "172.31.20.10",
      "172.31.20.10:0",
      "172.31.20.10:70000",
      "[2001:db8::1]",
      " 172.31.20.10:53121",
    ]) {
      const result = validator.validate({
        command_id: `ack-${hopLocalAddr}`.slice(0, 64),
        resource: "tunnel",
        resource_id: "tunex-42-relay",
        revision: 7,
        action: "command_ack",
        expires_at: expiresAt,
        payload: {
          acked_command_id: "cmd-hop-endpoint",
          status: "applied",
          applied_revision: 7,
          hop_local_addr: hopLocalAddr,
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error_code).toBe("payload_invalid");
    }
  });

});
