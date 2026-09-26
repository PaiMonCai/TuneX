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

/**
 * {@link createRuntimeReconcileSink} 的可注入依赖。
 *
 * 生产（`worker.ts`）不传，走模块级单例；单测显式注入替身，避免连真库、
 * 也不必去 monkey-patch ES 模块的只读导出。
 */
export interface RuntimeReconcileSinkDeps {
  db?: { tunnel: { findUnique: (args: unknown) => Promise<unknown> } };
  orchestrator?: Parameters<typeof createSink>[0]["orchestrator"];
}

export function createRuntimeReconcileSink(deps: RuntimeReconcileSinkDeps = {}): ReconcileSink {
  return createSink({
    db: deps.db ?? (db as never),
    orchestrator: deps.orchestrator ?? getOrchestrator,
  });
}

/** 真正的实现体：依赖通过参数进来，单测可整块替换。 */
function createSink({ db, orchestrator }: {
  db: { tunnel: { findUnique: (args: unknown) => Promise<unknown> } };
  orchestrator: () => ReturnType<typeof getOrchestrator>;
}): ReconcileSink {
  return {
    async resendSameRevision({ tunnel_id, revision }) {
      const orch = orchestrator();
      if (!orch) throw new Error("v3 orchestrator is unavailable");

      const tunnel = (await db.tunnel.findUnique({
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
          // S10.47：rollout 停在 degraded ⇒ 该 tunnel 的 desired topology **已知
          // 无法安全下发**（compensation 已经失败过一次，节点侧账本与
          // desired 不一致）。此时重发只会再把注定被拒的命令打给 Agent，
          // 并把它记成普通「resend 失败」，掩盖 degraded 需要人工介入的真相。
          forwardRollouts: {
            where: { phase: { in: ["degraded", "compensating"] } },
            select: { id: true, phase: true },
          },
        },
      })) as (ResendTunnelRow & Record<string, unknown>) | null;
      if (!tunnel) throw new Error(`tunnel ${tunnel_id} not found`);
      if (tunnel.desired_status !== "active") return;
      // 上面 select 的这两个 phase 是**该 tunnel 自身**的未收敛 rollout 标记：
      // reconciler 只负责「重发 desired 里已经落库的 revision」，无权把一个
      // 连补偿都失败了的 rollout 重放成 success。
      const degradedRollouts = tunnel.forwardRollouts ?? [];
      if (degradedRollouts.length > 0) {
        throw new Error(
          `tunnel ${tunnel_id} 有未收敛的 rollout（phase=${degradedRollouts
            .map((r) => `${r.phase}#${r.id}`)
            .join(",")}），本轮 reconcile 拒绝重发 revision ${revision}：degraded 需要人工介入`,
        );
      }
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
        const r = await orch.dispatchDirect({
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

      const egress = await orch.dispatchEgress({
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

      const ingress = await orch.dispatchIngress({
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

/** `resendSameRevision` 读回来的 tunnel 行形状（与真实 schema 对应）。 */
interface ResendTunnelRow {
  id: number;
  desired_status: string | null;
  config_revision: number | null;
  tunnel_mode: string | null;
  listen_port: number | null;
  listen_ip: string | null;
  remote_host: string | null;
  remote_port: number | null;
  egress_port: number | null;
  egress_pool_id: number | null;
  ingress_node: unknown;
  egress_node: unknown;
  egress_pool: { targets: unknown[]; lb_strategy: string | null } | null;
  forwardRollouts: Array<{ id: number; phase: string }>;
}
