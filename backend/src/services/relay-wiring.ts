/**
 * Process-wide v3 orchestrator wiring.
 *
 * Production control traffic is outbound-only from Agent to Panel:
 * OutboundAgentTransport queues revisioned commands in Redis and waits for the
 * authenticated Agent polling channel to ACK them. No Panel -> Agent:9090
 * dependency and no shared AGENT_ADMIN_TOKEN are used here.
 */
import { Orchestrator } from "./orchestrator.ts";
import { OutboundAgentTransport } from "./agent-command-bus.ts";
import { db } from "../db.ts";
import { getEffectivePolicy } from "./policy-service.ts";
import type { ForwardPolicySource } from "./orchestrator.ts";

/** One revision request, intersected at delivery time; never persist effective caps. */
export const loadForwardPolicyForDispatch: ForwardPolicySource = async (tunnelId, revision) => {
  const row = await db.tunnel.findUnique({
    where: { id: tunnelId },
    select: { workspace_id: true, config_revision: true, bytes_per_second_in: true,
      bytes_per_second_out: true, max_connections: true, max_connections_per_ip: true },
  });
  if (!row) throw new Error("Forward policy source not found");
  const snapshot = await db.forwardRevision.findUnique({
    where: { tunnel_id_revision: { tunnel_id: tunnelId, revision } },
    select: { bytes_per_second_in: true, bytes_per_second_out: true, max_connections: true, max_connections_per_ip: true },
  });
  if (!snapshot && row.config_revision !== revision) throw new Error("Forward policy revision not found");
  const fresh = await getEffectivePolicy(row.workspace_id, { noCache: true });
  return { requested: snapshot ?? row, workspace: fresh.limits };
};

let singleton: Orchestrator | null = null;
let wiringError: string | null = null;

export function getOrchestrator(): Orchestrator | null {
  if (singleton) return singleton;
  if (wiringError) return null;
  try {
    singleton = new Orchestrator({
      transport: new OutboundAgentTransport(),
      loadForwardPolicy: loadForwardPolicyForDispatch,
      // Transport reachability is proven by ACK; do not probe Agent inbound.
      probeReachable: false,
    });
    return singleton;
  } catch (e) {
    wiringError = e instanceof Error ? e.message : String(e);
    return null;
  }
}

export function setOrchestrator(o: Orchestrator | null): void {
  singleton = o;
}

export function resetOrchestrator(): void {
  singleton = null;
  wiringError = null;
}
