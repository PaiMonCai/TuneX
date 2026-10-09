import { randomUUID } from "node:crypto";
import { enqueueAgentCommand, waitAgentCommandAck } from "./agent-command-bus.ts";
import { loadNodeCapabilityFacts } from "./runtime-admission.ts";
import type { FxpPlacementConfig } from "../integrations/forwardx/link-compiler.ts";
import type { CommandEnvelope } from "./control-protocol/index.ts";

export async function sendLinkPlacement(config: FxpPlacementConfig, remove = false): Promise<void> {
  const facts = await loadNodeCapabilityFacts(config.node_id);
  const action = remove ? "remove_link" : "apply_link";
  if (!facts?.capabilities?.includes(action) || !facts.capabilities.includes("forward.link.fxp.v1")) {
    throw new Error("agent_fxp_capability_missing");
  }
  const envelope: CommandEnvelope = {
    command_id: randomUUID(), resource: "link", resource_id: config.id,
    action, revision: config.generation, issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    payload: { link_id: config.link_id, workspace_id: config.workspace_id, node_id: config.node_id,
      ...(remove ? {} : { config_digest: config.config_digest }) },
  };
  const { scope } = await enqueueAgentCommand(config.node_id, envelope, null, undefined,
    undefined, {}, undefined, remove ? null : config);
  const ack = await waitAgentCommandAck(scope, config.node_id, envelope.command_id);
  if (!ack.ok || ack.applied_revision !== config.generation) {
    // Do not leak executable output or transport material into public errors.
    throw new Error(ack.error_code && /^[a-z_]{1,64}$/.test(ack.error_code)
      ? ack.error_code : "link_apply_unconfirmed");
  }
}
