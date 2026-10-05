/**
 * Production Reconciler sink for v3 runtimes.
 *
 * This module deliberately never calls scheduler reapply helpers: those bump
 * config_revision and may choose nodes. Reconciliation is allowed to replay
 * only the already persisted topology at the same revision.
 *
 * ── 为什么「同 revision 重发成功」必须落库（V4-F2 Gate 缺陷 1）──
 * 维护（§13.4.2 maintenance）期间保存的 desired 不会走 rollout：`patchForward`
 * 的 VALIDATE 被 `lifecycleAcceptsBusiness()` 拒绝，返回 `blocked`，**一条
 * `forward_rollout` 行都不会建**。退出维护后能把 runtime 推到最新 desired 的
 * 通道只有 reconcile 的同-revision 重发。若这里只 dispatch 不记账，就会出现
 * 「真实面已生效（Agent `reported_revision` 追平 `config_revision`、TCP 已切
 * 到新 target），面板 `tunnel.applied_revision` 永远停在旧值」：reconciler 每
 * 30 s 再判一次 `revision_behind` 并重复下发同一 revision，永不静默，
 * `/api/tunnels/:id` 的 `sync_pending` 投影也随之长期失真。
 *
 * 因此 ACK 成功后必须把「已确认应用的 revision」写回 tunnel 行。写入走
 * {@link ReconcileSinkLedger.markApplied} 的 **CAS**（`config_revision` 仍等于
 * 本次重发的 revision、且 `applied_revision` 落后于它时才推进）。三条不变量：
 *   1. **不写 `config_revision`**：期望版本只属于编排器（§7.12 禁 reconciler
 *      抬高 revision）。CAS 的 where 已经要求它等于本次重发值，写入列里没有它。
 *   2. **不写 port / node / binding**：本 sink 只记账，§7.12 的
 *      `change_port` / `switch_node` 禁令在此体现为「这些列根本不在 data 里」。
 *   3. **并发编辑不会被打脏**：CAS 未命中（`count=0`）说明 desired 已被别人推进
 *      （或已有别的写入者记过账），本轮 dispatch 结果按过期丢弃，下一轮按新
 *      revision 重新收敛。
 *
 * ── 依赖姿态 ──
 * `ledger` / `orchestrator` / `now` 全部可注入，默认实现懒加载 Prisma 与
 * relay-wiring：只 import 本模块的单测不会连库（与 `reconciler.ts` 的
 * `defaultReconcileDeps`、`forward-rollout-recovery.ts` 的
 * `defaultRolloutResumeDeps` 同口径）。
 */
import type { Orchestrator, OrchestratorNode } from "./orchestrator.ts";
import { dispatchFactsFromRow, persistedForwardProtocol } from "./forward-contract.ts";
import type { ReconcileSink } from "./reconciler.ts";
import type { RuntimeUseChecker } from "./forward-rollout-exec.ts";
import type { RuntimeUseDenied } from "./forward-capability.ts";

/* ================================================================== */
/* DB 投影                                                             */
/* ================================================================== */

/** 目标池 target（`EgressTarget` 的投影，字段名与 orchestrator 入参一致）。 */
export interface SinkEgressTarget {
  host: string;
  port: number;
  weight?: number;
  order_by?: number;
}

/**
 * sink 读取的 tunnel 行投影。
 *
 * 只声明实际消费的列，因此替身不必实现整张表；生产实现把 Prisma 行
 * `as unknown as SinkTunnel` 收窄（与 `reconciler.ts` 的 `DesiredTunnel` 同一
 * 手法：投影形状由消费方定义，DB 侧多出来的列不参与语义）。
 */
export interface SinkTunnel {
  id: number;
  workspace_id: number;
  user_id: number;
  tunnel_type?: string;
  /**
   * Canonical protocol fact (V5-WP0). It must be present on the projection: this
   * sink issues real commands, and `admitPersistedProtocol` fails closed when the
   * row carries no protocol fact at all (a forgotten `select` must not be read as
   * a V4 "protocol omitted" payload).
   */
  forward_protocol?: string | null;
  /** V5-WP5-A1: the tls front's paths travel with the row, like the protocol. */
  tls_cert_path?: string | null;
  tls_key_path?: string | null;
  desired_status: string | null;
  config_revision: number | null;
  applied_revision: number | null;
  apply_status: string | null;
  apply_error_code: string | null;
  apply_error: string | null;
  last_applied_at: Date | null;
  tunnel_mode: "direct" | "relay" | null;
  listen_port: number | null;
  listen_ip: string | null;
  remote_host: string | null;
  remote_port: number | null;
  egress_port: number | null;
  egress_pool_id: number | null;
  ingress_node: (OrchestratorNode & { node_group_id: number }) | null;
  egress_node: (OrchestratorNode & { node_group_id: number; lb_strategy?: string | null }) | null;
  /** V5.4：三跳路由的中间节点；null = 单跳。 */
  middle_node_id?: number | null;
  middle_node?: (OrchestratorNode & { node_group_id: number }) | null;
  /** 物理端口仍以 NodePortLease 为唯一真相；middle listener 从这里恢复。 */
  port_leases?: Array<{ node_id: number; port: number; status: string }>;
  egress_pool: { lb_strategy?: string | null; targets: SinkEgressTarget[] } | null;
}

/** sink 需要的最小 DB 面（Prisma 子集；替身只实现这两个方法）。 */
export interface ReconcileSinkDb {
  tunnel: {
    findUnique(args: unknown): Promise<unknown>;
    updateMany(args: unknown): Promise<unknown>;
  };
}

/**
 * sink 的 IO 接缝：读 desired 行 + **CAS 推进 applied 记账**。
 *
 * `markApplied` 返回 `false` 表示 CAS 未命中（desired 已改变或已被别的写入者
 * 记账）。这不是错误——本轮下发结果自然过期，下一轮按新的 `config_revision`
 * 收敛即可，所以 sink 不因此抛错（抛错会被 reconciler 记成 `failed`，把一次
 * 正常的并发编辑伪装成下发故障）。
 */
export interface ReconcileSinkLedger {
  loadTunnel(tunnelId: number): Promise<SinkTunnel | null>;
  markApplied(input: { tunnelId: number; revision: number; at: Date }): Promise<boolean>;
  /** Denial only records an explanation; never deletes applied runtime/leases. */
  markBlocked?(input: { tunnelId: number; revision: number; denied: RuntimeUseDenied }): Promise<void>;
}

function firstHost(raw: string | null): string {
  return String(raw ?? "").split(",").map((x) => x.trim()).find(Boolean) ?? "";
}

function nextHop(host: string, port: number): string {
  const h = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${h}:${port}`;
}

/* ================================================================== */
/* 生产 ledger（懒加载 Prisma）                                          */
/* ================================================================== */

/** 懒加载 Prisma，避免「只 import 本模块」的单测连库。 */
async function prismaDb(): Promise<ReconcileSinkDb> {
  const { db } = await import("../db.ts");
  return db as unknown as ReconcileSinkDb;
}

/**
 * 建一个 ledger。测试可传入替身 db（`tunnel.findUnique` / `tunnel.updateMany`）。
 *
 * `markApplied` 的 where 是本修复的**并发正确性核心**：
 * `config_revision = 本次重发的 revision` 保证「重发期间用户又编辑过」时不会
 * 把旧版本的 ACK 记到新 desired 头上；`OR [applied_revision = null,
 * applied_revision < revision]` 是幂等闸门——`NULL` 必须显式列出（SQL 的
 * `<` 对 NULL 求值为 NULL，只写 `lt` 会漏掉「从未 ACK」的行，
 * `reconciler.isRevisionBehind()` 恰好把 `null` 判为落后）。
 */
export function createTunnelLedger(loadDb: () => Promise<ReconcileSinkDb> = prismaDb): ReconcileSinkLedger {
  return {
    async loadTunnel(tunnelId: number): Promise<SinkTunnel | null> {
      const db = await loadDb();
      const tunnel = await db.tunnel.findUnique({
        where: { id: tunnelId },
        include: {
          ingress_node: true,
          egress_node: true,
          middle_node: true,
          port_leases: {
            where: { status: "active" },
            select: { node_id: true, port: true, status: true },
          },
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
      return (tunnel as SinkTunnel | null) ?? null;
    },

    async markBlocked({ tunnelId, revision, denied }): Promise<void> {
      const db = await loadDb();
      await db.tunnel.updateMany({
        where: { id: tunnelId, config_revision: revision },
        data: {
          apply_status: "error",
          apply_error_code: denied.reason,
          apply_error: `[${denied.error_layer}] ${denied.message}`.slice(0, 2000),
        },
      });
    },

    async markApplied({ tunnelId, revision, at }): Promise<boolean> {
      const db = await loadDb();
      const res = await db.tunnel.updateMany({
        where: {
          id: tunnelId,
          config_revision: revision,
          OR: [{ applied_revision: null }, { applied_revision: { lt: revision } }],
        },
        data: {
          applied_revision: revision,
          apply_status: "active",
          apply_error_code: null,
          apply_error: null,
          last_applied_at: at,
        },
      });
      return Number((res as { count?: number } | null)?.count ?? 0) === 1;
    },
  };
}

/* ================================================================== */
/* Sink                                                                */
/* ================================================================== */

/** 下发通道：三跳重发还需要唯一的 transit 原语。 */
export type SinkOrchestrator = Pick<
  Orchestrator,
  "dispatchDirect" | "dispatchEgress" | "dispatchIngress" | "dispatchTransit"
>;

export interface RuntimeReconcileSinkDeps {
  ledger?: ReconcileSinkLedger;
  /** 控制面接线；返回 null = 未接线（抛错让 reconciler 记 `failed`）。 */
  orchestrator?: () => SinkOrchestrator | null;
  now?: () => Date;
  /** Production defaults to the real latest grant/policy/traffic check. */
  runtimeUse?: RuntimeUseChecker;
}

/** 懒加载 relay-wiring：顶层 import 会连带 eager 建 Redis/Prisma 连接。 */
async function lazyOrchestrator(): Promise<SinkOrchestrator | null> {
  const { getOrchestrator } = await import("./relay-wiring.ts");
  return getOrchestrator();
}

export function createRuntimeReconcileSink(deps: RuntimeReconcileSinkDeps = {}): ReconcileSink {
  const ledger = deps.ledger ?? createTunnelLedger();
  const injectedOrchestrator = deps.orchestrator;
  const now = deps.now ?? (() => new Date());
  const runtimeUse: RuntimeUseChecker = deps.runtimeUse ?? (async (workspaceId, resource) => {
    const { checkForwardRuntimeUse } = await import("./forward-capability.ts");
    return checkForwardRuntimeUse(workspaceId, resource);
  });
  const assertRuntimeUse = async (tunnel: SinkTunnel, revision: number) => {
    const validId = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
    const invalidScope = !validId(tunnel.workspace_id) || !validId(tunnel.user_id) ||
      !validId(tunnel.ingress_node?.node_group_id) ||
      (tunnel.tunnel_mode === "relay" && !validId(tunnel.egress_node?.node_group_id)) ||
      (tunnel.middle_node_id != null && !validId(tunnel.middle_node?.node_group_id));
    const denied: RuntimeUseDenied | null = invalidScope
      ? { code: "forbidden", reason: "scope_revoked", error_layer: "resource_scope", message: "转发归属或实际节点组已失效" }
      : await runtimeUse(tunnel.workspace_id, {
          user_id: tunnel.user_id,
          in_node_group_id: tunnel.ingress_node!.node_group_id,
          out_node_group_id: tunnel.tunnel_mode === "relay" ? tunnel.egress_node!.node_group_id : null,
          // The canonical fact, not the legacy column: a ws row's legacy column
          // defaults to 'wss', and the policy would refuse the Forward's own
          // protocol (V5-G1A.7).
          protocol: persistedForwardProtocol(tunnel.forward_protocol, tunnel.tunnel_type),
        });
    if (denied) {
      await ledger.markBlocked?.({ tunnelId: tunnel.id, revision, denied });
      throw new Error(`[${denied.reason}:${denied.error_layer}] ${denied.message}`);
    }
  };

  return {
    async resendSameRevision({ tunnel_id, revision }) {
      // 注入优先（测试/替身）；未注入才走进程级 relay-wiring 单例。
      const orchestrator = injectedOrchestrator ? injectedOrchestrator() : await lazyOrchestrator();
      if (!orchestrator) throw new Error("v3 orchestrator is unavailable");

      const tunnel = await ledger.loadTunnel(tunnel_id);
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
        // V5-WP4/G0: this path dispatches real commands, so it must admit the
        // persisted protocol like every other one. Without it a historical
        // non-TCP Forward (wss/udp/...) would be replayed as TCP here — the
        // orchestrator defaults an absent protocol to tcp — and the panel would
        // report a successful reconcile of a Forward it must not run.
        const facts = dispatchFactsFromRow({
          forward_protocol: tunnel.forward_protocol,
          tunnel_type: tunnel.tunnel_type,
          tls_cert_path: tunnel.tls_cert_path,
          tls_key_path: tunnel.tls_key_path,
          // V5.1b WP5-B2: the reconcile replay is a SECOND delivery path for the
          // same fact — a replayed datagram exit must carry the same attestation
          // address the original dispatch did (the repo has paid for this lesson
          // three times over: protocol, certificate paths, health).
          ingress_node: tunnel.ingress_node,
        });
        if (facts === null) {
          throw new Error(
            `tunnel ${tunnel_id} uses a protocol the current runtime has not opened (or is missing its required configuration); refusing to replay it`,
          );
        }
        await assertRuntimeUse(tunnel, revision);
        const r = await orchestrator.dispatchDirect({
          tunnelId: tunnel.id,
          revision,
          ingressNode: tunnel.ingress_node,
          ingressPort: tunnel.listen_port,
          remoteHost: tunnel.remote_host,
          remotePort: tunnel.remote_port,
          listenHost: tunnel.listen_ip,
          protocol: facts.protocol,
          tlsCertPath: facts.tlsCertPath,
          tlsKeyPath: facts.tlsKeyPath,
        });
        if (!r.ok) throw new Error(r.error);
        // ACK 已确认这个 revision 在 Agent 上生效 ⇒ 记账（见文件头「缺陷 1」）。
        await ledger.markApplied({ tunnelId: tunnel.id, revision, at: now() });
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

      // Same rule as the DIRECT branch above: the replay carries the persisted
      // protocol, so a historical non-TCP Forward cannot be reconciled as TCP.
      const relayFacts = dispatchFactsFromRow({
        forward_protocol: tunnel.forward_protocol,
        tunnel_type: tunnel.tunnel_type,
        tls_cert_path: tunnel.tls_cert_path,
        tls_key_path: tunnel.tls_key_path,
        ingress_node: tunnel.ingress_node,
      });
      if (relayFacts === null) {
        throw new Error(
          `tunnel ${tunnel_id} uses a protocol the current runtime has not opened (or is missing its required configuration); refusing to replay it`,
        );
      }
      await assertRuntimeUse(tunnel, revision);
      const egress = await orchestrator.dispatchEgress({
        tunnelId: tunnel.id,
        revision,
        egressNode: tunnel.egress_node,
        egressPort: tunnel.egress_port,
        poolId: tunnel.egress_pool_id,
        targets,
        lbStrategy: tunnel.egress_pool?.lb_strategy ?? tunnel.egress_node.lb_strategy,
        protocol: relayFacts.protocol,
        hopPeer: relayFacts.hopPeer,
      });
      if (!egress.ok) throw new Error(egress.error);

      const host = firstHost(tunnel.egress_node.connect_ip);
      if (!host) throw new Error(`egress node ${tunnel.egress_node.id} has no connect_ip`);

      let ingressNextHop = nextHop(host, tunnel.egress_port);
      if (tunnel.middle_node_id != null) {
        if (!tunnel.middle_node) {
          throw new Error(`RELAY tunnel ${tunnel_id} middle node ${tunnel.middle_node_id} is missing`);
        }
        const middleLeases = (tunnel.port_leases ?? []).filter(
          (lease) => lease.node_id === tunnel.middle_node_id && lease.status === "active",
        );
        if (middleLeases.length !== 1) {
          throw new Error(
            `RELAY tunnel ${tunnel_id} middle node ${tunnel.middle_node_id} active lease count=${middleLeases.length}`,
          );
        }
        const middlePort = middleLeases[0]!.port;
        // 正向仍是先远后近：final egress ACK → middle ACK → ingress ACK。
        // 只有三条腿都确认后，下面的 CAS 才能把 applied_revision 记成成功。
        const transit = await orchestrator.dispatchTransit({
          tunnelId: tunnel.id,
          revision,
          node: tunnel.middle_node,
          port: middlePort,
          nextHop: nextHop(host, tunnel.egress_port),
          protocol: relayFacts.protocol,
        });
        if (!transit.ok) throw new Error(transit.error);
        ingressNextHop = nextHop(transit.host, middlePort);
      }

      await assertRuntimeUse(tunnel, revision);
      const ingress = await orchestrator.dispatchIngress({
        tunnelId: tunnel.id,
        revision,
        ingressNode: tunnel.ingress_node,
        ingressPort: tunnel.listen_port,
        nextHop: ingressNextHop,
        protocol: relayFacts.protocol,
        tlsCertPath: relayFacts.tlsCertPath,
        tlsKeyPath: relayFacts.tlsKeyPath,
      });
      if (!ingress.ok) throw new Error(ingress.error);

      // RELAY 要**所有实际腿都 ACK** 才算这个 revision 应用成功：单跳是
      // egress+ingress，三跳则是 egress+middle+ingress。任何半途失败都不记账，
      // 下一轮仍以同 revision 幂等重发。
      await ledger.markApplied({ tunnelId: tunnel.id, revision, at: now() });
    },
  };
}
