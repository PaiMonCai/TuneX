/**
 * v3 outbound-only Agent command bus.
 *
 * The panel never dials an Agent. Orchestrator commands are queued in Redis and
 * the authenticated Agent polls /api/internal/node/commands over its existing
 * outbound HTTP path, executes locally, then POSTs an ACK. Redis is transport
 * state only; DB desired state remains canonical and startup restore comes from
 * buildDesiredNodeSnapshot().
 */
import { db } from "../db.ts";
import { redis, scopedKey } from "../redis.ts";
import type { CommandEnvelope } from "./control-protocol/index.ts";
import {
  AgentTransportError,
  RELAY_DISPATCH_ERROR_CODES,
  type AgentTransport,
  type AgentTunnelConfig,
  type OrchestratorNode,
} from "./orchestrator.ts";

export interface QueuedAgentCommand {
  envelope: CommandEnvelope;
  config: AgentTunnelConfig | null;
  queued_at: string;
}

export interface AgentCommandAck {
  command_id: string;
  ok: boolean;
  applied_revision?: number | null;
  error_code?: string | null;
  error?: string | null;
}

const COMMAND_TTL_S = 120;
const ACK_TIMEOUT_MS = 15_000;
const ACK_POLL_MS = 100;

function queueKey(scope: number, nodeId: number): string {
  return scopedKey(scope, "agent", "command", String(nodeId), "queue");
}
function ackKey(scope: number, nodeId: number, commandId: string): string {
  return scopedKey(scope, "agent", "command", String(nodeId), "ack", commandId);
}

async function nodeScope(nodeId: number): Promise<number> {
  const node = await db.node.findUnique({
    where: { id: nodeId },
    select: { node_group: { select: { workspace_id: true } } },
  });
  if (!node) throw new AgentTransportError(
    RELAY_DISPATCH_ERROR_CODES.agent_rejected,
    `节点 ${nodeId} 不存在，拒绝下发`,
  );
  return node.node_group.workspace_id;
}

export async function enqueueAgentCommand(
  nodeId: number,
  envelope: CommandEnvelope,
  config: AgentTunnelConfig | null,
): Promise<{ scope: number }> {
  const scope = await nodeScope(nodeId);
  const item: QueuedAgentCommand = {
    envelope,
    config,
    queued_at: new Date().toISOString(),
  };
  const key = queueKey(scope, nodeId);
  const tx = redis.multi();
  tx.rpush(key, JSON.stringify(item));
  tx.expire(key, COMMAND_TTL_S);
  await tx.exec();
  return { scope };
}

export async function dequeueAgentCommand(
  scope: number,
  nodeId: number,
): Promise<QueuedAgentCommand | null> {
  const raw = await redis.lpop(queueKey(scope, nodeId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as QueuedAgentCommand;
    if (!parsed || typeof parsed !== "object" || !parsed.envelope) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function storeAgentCommandAck(
  scope: number,
  nodeId: number,
  ack: AgentCommandAck,
): Promise<void> {
  if (!ack || typeof ack.command_id !== "string" || ack.command_id.trim() === "") {
    throw new TypeError("command_id is required");
  }
  await redis.set(
    ackKey(scope, nodeId, ack.command_id),
    JSON.stringify(ack),
    "EX",
    COMMAND_TTL_S,
  );
}

export async function waitAgentCommandAck(
  scope: number,
  nodeId: number,
  commandId: string,
  timeoutMs = ACK_TIMEOUT_MS,
): Promise<AgentCommandAck> {
  const key = ackKey(scope, nodeId, commandId);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const raw = await redis.get(key);
    if (raw) {
      await redis.del(key);
      const ack = JSON.parse(raw) as AgentCommandAck;
      return ack;
    }
    await new Promise((resolve) => setTimeout(resolve, ACK_POLL_MS));
  }
  throw new AgentTransportError(
    RELAY_DISPATCH_ERROR_CODES.agent_unreachable,
    `等待 Agent ACK 超时（node=${nodeId}, command=${commandId}）`,
  );
}

/**
 * Production transport: queue command and synchronously wait for the Agent ACK.
 * No Agent address or management token is required; node identity is proven by
 * the credential on the Agent -> Panel polling endpoints.
 */
export class OutboundAgentTransport implements AgentTransport {
  private async send(
    node: OrchestratorNode,
    envelope: CommandEnvelope | undefined,
    config: AgentTunnelConfig | null,
  ): Promise<unknown> {
    if (!envelope) {
      throw new AgentTransportError(
        RELAY_DISPATCH_ERROR_CODES.ack_invalid,
        "outbound transport requires command envelope",
      );
    }
    const { scope } = await enqueueAgentCommand(node.id, envelope, config);
    const ack = await waitAgentCommandAck(scope, node.id, envelope.command_id);
    if (!ack.ok) {
      return {
        ok: false,
        error_code: ack.error_code ?? "apply_failed",
        error: ack.error ?? "agent rejected command",
      };
    }
    return { ok: true, applied_revision: ack.applied_revision ?? envelope.revision };
  }

  applyEgress(node: OrchestratorNode, config: AgentTunnelConfig, envelope?: CommandEnvelope): Promise<unknown> {
    return this.send(node, envelope, config);
  }
  applyRelay(node: OrchestratorNode, config: AgentTunnelConfig, envelope?: CommandEnvelope): Promise<unknown> {
    return this.send(node, envelope, config);
  }
  applyDirect(node: OrchestratorNode, config: AgentTunnelConfig, envelope?: CommandEnvelope): Promise<unknown> {
    return this.send(node, envelope, config);
  }
  removeTunnel(node: OrchestratorNode, _tunnelId: string, envelope?: CommandEnvelope): Promise<unknown> {
    return this.send(node, envelope, null);
  }
  async isReachable(_node: OrchestratorNode): Promise<boolean> {
    // Reachability is proven by ACK. Avoid Panel -> Agent probes entirely.
    return true;
  }
}

function hostPort(host: string, port: number): string {
  const h = host.trim();
  return h.includes(":") && !h.startsWith("[") ? `[${h}]:${port}` : `${h}:${port}`;
}
function firstConnectIp(raw: string | null): string | null {
  if (!raw) return null;
  return raw.split(",").map((s) => s.trim()).find(Boolean) ?? null;
}

/**
 * Canonical desired snapshot used by Agent startup restore.
 * Only concrete node bindings are considered; NodeGroup is never re-interpreted
 * as placement.
 */
export async function buildDesiredNodeSnapshot(nodeId: number): Promise<{ version: string; tunnels: AgentTunnelConfig[] }> {
  const rows = await db.tunnel.findMany({
    where: {
      desired_status: "active",
      OR: [{ ingress_node_id: nodeId }, { egress_node_id: nodeId }],
    },
    include: {
      egress_node: { select: { id: true, connect_ip: true } },
      egress_pool: {
        include: {
          targets: {
            where: { status: "active" },
            orderBy: { order_by: "asc" },
          },
        },
      },
    },
    orderBy: { id: "asc" },
  });

  const tunnels: AgentTunnelConfig[] = [];
  for (const t of rows) {
    const revision = t.config_revision ?? 0;
    if (revision <= 0) continue;

    if (t.ingress_node_id === nodeId && t.tunnel_mode === "direct") {
      if (!t.listen_port || !t.remote_host || !t.remote_port) continue;
      tunnels.push({
        id: `tunex-${t.id}-direct`,
        mode: "DIRECT",
        ingress_port: t.listen_port,
        egress_port: 0,
        remote_host: t.remote_host,
        remote_port: t.remote_port,
        next_hop: "",
        targets: [],
        lb_strategy: "ROUND_ROBIN",
        protocol: "tcp",
        speed_limit: 0,
        revision,
        listen_host: t.listen_ip ?? undefined,
      });
    }

    if (t.tunnel_mode === "relay" && t.egress_node_id === nodeId) {
      if (!t.egress_port) continue;
      const strategy =
        t.egress_pool?.lb_strategy === "rand" ? "RANDOM" :
        t.egress_pool?.lb_strategy === "weighted_round" ? "WEIGHTED_ROUND_ROBIN" :
        "ROUND_ROBIN";
      tunnels.push({
        id: `tunex-${t.id}-egress`,
        mode: "EGRESS",
        ingress_port: 0,
        egress_port: t.egress_port,
        remote_host: "",
        remote_port: 0,
        next_hop: "",
        targets: (t.egress_pool?.targets ?? []).map((x) => ({
          host: x.host,
          port: x.port,
          weight: x.weight,
          order: Math.trunc(x.order_by),
        })),
        lb_strategy: strategy,
        protocol: "tcp",
        speed_limit: 0,
        revision,
      });
    }

    if (t.tunnel_mode === "relay" && t.ingress_node_id === nodeId) {
      const host = firstConnectIp(t.egress_node?.connect_ip ?? null);
      if (!t.listen_port || !t.egress_port || !host) continue;
      tunnels.push({
        id: `tunex-${t.id}-relay`,
        mode: "RELAY",
        ingress_port: t.listen_port,
        egress_port: 0,
        remote_host: host,
        remote_port: t.egress_port,
        next_hop: hostPort(host, t.egress_port),
        targets: [],
        lb_strategy: "ROUND_ROBIN",
        protocol: "tcp",
        speed_limit: 0,
        revision,
        listen_host: t.listen_ip ?? undefined,
      });
    }
  }
  return { version: "tunex-v3", tunnels };
}
