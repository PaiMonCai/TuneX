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

let singleton: Orchestrator | null = null;
let wiringError: string | null = null;

export function getOrchestrator(): Orchestrator | null {
  if (singleton) return singleton;
  if (wiringError) return null;
  try {
    singleton = new Orchestrator({
      transport: new OutboundAgentTransport(),
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
