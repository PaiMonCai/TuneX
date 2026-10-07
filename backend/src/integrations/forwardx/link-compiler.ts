import { z } from "zod";
import { canonicalConfigDigest, linkRuntimeId } from "./core-contract.ts";
import { checkAgentVersion } from "./agent-version.ts";
import { bindScopesOverlap } from "./bind-scope.ts";

const positive = z.number().int().positive().max(2_147_483_647);
const port = positive.max(65_535);
const rate = z.number().int().min(0).max(1_000_000_000_000).default(0);
const endpoint = z.object({
  id: positive,
  workspace_id: positive,
  connect_host: z.string().trim().min(1).max(255).refine((host) => !/[\s/\x00]/.test(host), "invalid connect host"),
  version: z.string(),
  capabilities: z.array(z.string()),
}).strict();

export const FxpLinkInputSchema = z.object({
  link_id: positive,
  workspace_id: positive,
  version: positive,
  generation: positive,
  ingress: endpoint,
  egress: endpoint,
  carrier_port: port,
  lease_expires_at: z.string().datetime({ offset: true }),
  bindings: z.array(z.object({
    forward_id: positive,
    listen_port: port,
    // Upstream FXP currently supports wildcard or loopback listeners only.
    listen_host: z.enum(["", "127.0.0.1", "::1"]).default(""),
    protocol: z.enum(["tcp", "udp", "both"]),
    target_host: z.string().trim().min(1).max(255).refine((host) => !/[\s/\x00]/.test(host), "invalid target host"),
    target_port: port,
    bytes_per_second_in: rate,
    bytes_per_second_out: rate,
    max_connections: z.number().int().min(0).max(1_000_000).default(0),
    max_connections_per_ip: z.number().int().min(0).max(1_000_000).default(0),
  }).strict()).max(500),
}).strict();

export type FxpLinkInput = z.input<typeof FxpLinkInputSchema>;
type RunnerConfig = Record<string, unknown>;
export interface FxpPlacementConfig {
  id: string;
  link_id: number;
  workspace_id: number;
  node_id: number;
  role: "ingress" | "egress";
  generation: number;
  lease_expires_at: string;
  config_digest: string;
  runner_config: RunnerConfig | null;
  runtime_ids: string[];
  ports: Array<{ protocol: "tcp" | "udp"; host: string; port: number }>;
}

/** One compiler merges every binding. A caller never writes only its own rule. */
export function compileFxpLink(input: FxpLinkInput, transportKey: string): {
  ingress: FxpPlacementConfig;
  egress: FxpPlacementConfig;
} {
  const spec = FxpLinkInputSchema.parse(input);
  if (!/^[0-9a-f]{64}$/i.test(transportKey)) throw new Error("invalid_transport_key");
  if (spec.ingress.id === spec.egress.id) throw new Error("point_to_point_requires_distinct_nodes");
  for (const node of [spec.ingress, spec.egress]) {
    if (node.workspace_id !== spec.workspace_id) throw new Error("cross_workspace_link_denied");
    if (checkAgentVersion(node.version, null)) throw new Error("agent_version_invalid");
    if (!node.capabilities.includes("forward.link.fxp.v1")) throw new Error("agent_fxp_capability_missing");
  }
  const seenRules = new Set<number>();
  const occupied: Array<{ protocol: string; host: string; port: number }> = [];
  const entries: RunnerConfig[] = [];
  const allowedBindings: RunnerConfig[] = [];
  const udpTargets: RunnerConfig[] = [];
  const ingressRuntimeIds: string[] = [];
  for (const binding of [...spec.bindings].sort((a, b) => a.forward_id - b.forward_id)) {
    if (seenRules.has(binding.forward_id)) throw new Error("duplicate_forward_binding");
    seenRules.add(binding.forward_id);
    // A single entry owns both protocol lanes, so their directional buckets and
    // admission gate share the business rule's budget.
    entries.push({ role: "entry", tunnelId: spec.link_id, ruleId: binding.forward_id,
      listenPort: binding.listen_port, udpListenPort: binding.listen_port, listenHost: binding.listen_host,
      protocol: binding.protocol, exitHost: spec.egress.connect_host, exitPort: spec.carrier_port,
      udpExitPort: spec.carrier_port, targetIp: binding.target_host, targetPort: binding.target_port,
      key: transportKey, limitIn: binding.bytes_per_second_in, limitOut: binding.bytes_per_second_out,
      maxConnections: binding.max_connections, maxIPs: binding.max_connections_per_ip });
    const protocols = binding.protocol === "both" ? ["tcp", "udp"] as const : [binding.protocol];
    for (const protocol of protocols) {
      if (occupied.some((p) => p.protocol === protocol && p.port === binding.listen_port &&
          bindScopesOverlap(p.host, binding.listen_host))) {
        throw new Error("binding_listener_conflict");
      }
      occupied.push({ protocol, host: binding.listen_host, port: binding.listen_port });
      allowedBindings.push({ ruleId: binding.forward_id, protocol,
        targetIp: binding.target_host, targetPort: binding.target_port });
      if (protocol === "udp") udpTargets.push({ ruleId: binding.forward_id,
        targetIp: binding.target_host, targetPort: binding.target_port });
      ingressRuntimeIds.push(`${linkRuntimeId({ link_id: spec.link_id, link_version: spec.version,
        placement_id: spec.ingress.id, role: "ingress", protocol })}-f${binding.forward_id}`);
    }
  }
  const entryConfig = entries.length ? { managedReload: true, role: "entry-group", tunnelId: spec.link_id, entries } : null;
  const exitConfig = { role: "exit", tunnelId: spec.link_id, listenPort: spec.carrier_port,
    udpListenPort: spec.carrier_port, protocol: "both", key: transportKey,
    managedReload: true, requireBindingAuth: true, allowedBindings, udpTargets };
  const placement = (role: "ingress" | "egress", nodeId: number, config: RunnerConfig | null,
    runtimeIds: string[], ports: FxpPlacementConfig["ports"]): FxpPlacementConfig => ({
    // Process/lease ownership is stable across immutable config versions.
    id: `tunex-link-${spec.link_id}-p${nodeId}-${role}`,
    link_id: spec.link_id, workspace_id: spec.workspace_id, node_id: nodeId, role,
    generation: spec.generation, lease_expires_at: spec.lease_expires_at,
    config_digest: canonicalConfigDigest(config), runner_config: config,
    runtime_ids: runtimeIds, ports,
  });
  return {
    ingress: placement("ingress", spec.ingress.id, entryConfig, ingressRuntimeIds,
      occupied as FxpPlacementConfig["ports"]),
    egress: placement("egress", spec.egress.id, exitConfig,
      (["tcp", "udp"] as const).map((protocol) => linkRuntimeId({ link_id: spec.link_id,
        link_version: spec.version, placement_id: spec.egress.id, role: "egress", protocol })),
      (["tcp", "udp"] as const).map((protocol) => ({ protocol, host: "", port: spec.carrier_port }))),
  };
}
