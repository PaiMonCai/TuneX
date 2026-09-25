/**
 * Production Reconciler sink for v3 runtimes.
 *
 * This module deliberately never calls scheduler reapply helpers: those bump
 * config_revision and may choose nodes. Reconciliation is allowed to replay
 * only the already persisted topology at the same revision.
 */
import { db } from "../db.ts";
import { getOrchestrator } from "./relay-wiring.ts";
import type { ReconcileSink } from "./reconciler.ts";

function firstHost(raw: string | null): string {
  return String(raw ?? "").split(",").map((x) => x.trim()).find(Boolean) ?? "";
}

function nextHop(host: string, port: number): string {
  const h = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${h}:${port}`;
}

export function createRuntimeReconcileSink(): ReconcileSink {
  return {
    async resendSameRevision({ tunnel_id, revision }) {
      const orchestrator = getOrchestrator();
      if (!orchestrator) throw new Error("v3 orchestrator is unavailable");

      const tunnel = await db.tunnel.findUnique({
        where: { id: tunnel_id },
        include: {
          ingress_node: true,
          egress_node: true,
          egress_pool: {
            include: {
              targets: {
                where: { status: "active" },
                orderBy: { order_by: "asc" },
              },
            },
          },
        },
      });
      if (!tunnel) throw new Error(`tunnel ${tunnel_id} not found`);
      if (tunnel.desired_status !== "active") return;
      if ((tunnel.config_revision ?? 0) !== revision) {
        throw new Error(
          `revision changed while reconciling tunnel ${tunnel_id}: expected ${revision}, got ${tunnel.config_revision}`,
        );
      }
      if (!tunnel.ingress_node) {
        throw new Error(`tunnel ${tunnel_id} has no concrete ingress binding`);
      }

      if (tunnel.tunnel_mode === "direct") {
        if (!tunnel.listen_port || !tunnel.remote_host || !tunnel.remote_port) {
          throw new Error(`DIRECT tunnel ${tunnel_id} has incomplete desired config`);
        }
        const r = await orchestrator.dispatchDirect({
          tunnelId: tunnel.id,
          revision,
          ingressNode: tunnel.ingress_node,
          ingressPort: tunnel.listen_port,
          remoteHost: tunnel.remote_host,
          remotePort: tunnel.remote_port,
          listenHost: tunnel.listen_ip,
        });
        if (!r.ok) throw new Error(r.error);
        return;
      }

      if (tunnel.tunnel_mode !== "relay") {
        throw new Error(`tunnel ${tunnel_id} has unsupported mode ${String(tunnel.tunnel_mode)}`);
      }
      if (!tunnel.egress_node || !tunnel.egress_port || !tunnel.listen_port) {
        throw new Error(`RELAY tunnel ${tunnel_id} has incomplete concrete bindings`);
      }
      const targets = tunnel.egress_pool?.targets ?? [];
      if (targets.length === 0) {
        throw new Error(`RELAY tunnel ${tunnel_id} has no active egress targets`);
      }

      const egress = await orchestrator.dispatchEgress({
        tunnelId: tunnel.id,
        revision,
        egressNode: tunnel.egress_node,
        egressPort: tunnel.egress_port,
        poolId: tunnel.egress_pool_id,
        targets,
        lbStrategy: tunnel.egress_pool?.lb_strategy ?? tunnel.egress_node.lb_strategy,
      });
      if (!egress.ok) throw new Error(egress.error);

      const host = firstHost(tunnel.egress_node.connect_ip);
      if (!host) throw new Error(`egress node ${tunnel.egress_node.id} has no connect_ip`);

      const ingress = await orchestrator.dispatchIngress({
        tunnelId: tunnel.id,
        revision,
        ingressNode: tunnel.ingress_node,
        ingressPort: tunnel.listen_port,
        nextHop: nextHop(host, tunnel.egress_port),
      });
      if (!ingress.ok) throw new Error(ingress.error);
    },
  };
}
