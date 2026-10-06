/**
 * BullMQ worker and recurring maintenance scheduler.
 *
 * Registered jobs are the source of truth for what actually runs:
 * - traffic archive and retention;
 * - node offline detection;
 * - latency-history rollup/prune;
 * - desired/runtime/lease reconcile (including rollout resume, failover and federation closure);
 * - subscription-period settlement.
 *
 * Do not add placeholder schedules. A recurring job belongs here only when its
 * handler has real business logic and idempotency/error behavior.
 */
import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { env } from "./env.ts";
import { db } from "./db.ts";
import { defaultOfflineDeps, runOfflineCheck } from "./socket/offline-detector.ts";
import { defaultTrafficArchiveDeps, flushTrafficBuffer } from "./services/traffic-archive.ts";
import { defaultTrafficRetentionDeps, deleteExpiredTraffic } from "./services/traffic-retention.ts";
import { defaultLatencyHistoryDeps, runLatencyHistoryMaintenance } from "./services/latency-history.ts";
import { defaultReconcileDeps, executeReconcile } from "./services/reconciler.ts";
import { defaultSettlementDeps, settleDuePeriods } from "./services/subscription-billing.ts";
import { createRuntimeReconcileSink } from "./services/runtime-reconcile-sink.ts";

export const CRON_JOBS: Array<{ name: string; pattern?: string; everyMs?: number; desc: string }> = [
  { name: "cron_save_traffic", pattern: "*/10 * * * *", desc: "Redis → MySQL 流量同步（OPS-01/OPS-03，幂等）" },
  { name: "cron_delete_tunnel_traffic", pattern: "0 0 * * *", desc: "删除过期流量记录（OPS-03，按保留期，幂等）" },
  { name: "cron_latency_history", pattern: "15 * * * *", desc: "观测档案：小时桶聚合 + 过期清理（原始 24h / 桶 30d，幂等）" },
  { name: "cron_check_node_offline", everyMs: 10_000, desc: "离线检测：dc:* 防抖到点置 inactive" },
  { name: "cron_reconcile_v3", everyMs: 30_000, desc: "v3 desired/runtime/lease 同 revision 对账修复" },
  // Settlement is intentionally offset from the hourly latency rollup/archive windows.
  { name: "cron_settle_billing", pattern: "45 * * * *", desc: "订阅周期结算：占位 → 执行 → 终态，崩溃接管（幂等）" },
];

const connection = new IORedis(env.redisUrl, { maxRetriesPerRequest: null });
const queue = new Queue("tunex-cron", { connection });

const worker = new Worker(
  "tunex-cron",
  async (job: Job) => {
    const started = Date.now();
    switch (job.name) {
      case "cron_save_traffic": {
        // Redis traffic buffer → MySQL archive. SETNX + unique key + consume/delete keep it idempotent.
        const r = await flushTrafficBuffer(defaultTrafficArchiveDeps());
        const summary = {
          scanned: r.scanned,
          keys: r.keys,
          records: r.records,
          inserted: r.inserted,
          duplicates: r.duplicates,
          skipped: r.skipped,
          errors: r.errors,
        };
        if (r.inserted > 0 || r.duplicates > 0 || r.errors > 0) {
          console.log("[worker] cron_save_traffic:", JSON.stringify(summary));
        }
        return summary;
      }
      case "cron_delete_tunnel_traffic": {
        // Retention deletes rows before the deterministic cutoff; repeated runs are idempotent.
        // Missing/invalid configuration falls back to the default and remains observable in the result.
        const r = await deleteExpiredTraffic(defaultTrafficRetentionDeps());
        if (r.deleted > 0 || r.config_missing || r.config_invalid) {
          console.log("[worker] cron_delete_tunnel_traffic:", JSON.stringify(r));
        }
        return r;
      }
      case "cron_latency_history": {
        // Roll up completed hourly buckets before pruning raw samples; reversing the order can
        // permanently lose history. Unique bucket keys make the rollup idempotent.
        const r = await runLatencyHistoryMaintenance(defaultLatencyHistoryDeps());
        if (r.rollup.inserted > 0 || r.prune.deleted_samples > 0 || r.prune.deleted_buckets > 0) {
          console.log("[worker] cron_latency_history:", JSON.stringify(r));
        }
        return r;
      }
      case "cron_check_node_offline": {
        // 消费 `dc:<gid>:<nodeId>` 标记：防抖（60s）到点且无心跳 → 节点置 inactive。
        // 幂等：重复消费/多 worker 并存均不会重复翻转（updateMany where status=active）。
        const r = await runOfflineCheck(defaultOfflineDeps());
        const summary = {
          scanned: r.scanned,
          flipped: r.flipped,
          skipped: r.skippedWithinDebounce + r.skippedHeartbeatAlive,
          cleared_groups: r.clearedGroups,
          // Keep stale-report flips separate from disconnect-marker flips for operator visibility.
          flipped_stale: r.flippedStale,
          errors: r.errors,
        };
        if (r.flipped > 0 || r.flippedStale > 0 || r.errors > 0) {
          console.log("[worker] cron_check_node_offline:", JSON.stringify(summary));
        }
        return summary;
      }
      case "cron_reconcile_v3": {
        // Resume active rollouts before same-revision reconciliation. Cross-stage progress belongs
        // to the rollout state machine; reconcile only repairs the already-selected revision/runtime.
        try {
          const { resumeRollouts } = await import("./services/forward-rollout-recovery.ts");
          const { getOrchestrator } = await import("./services/relay-wiring.ts");
          const orchestrator = getOrchestrator();
          if (orchestrator) {
            const rollouts = await resumeRollouts({
              db: db as never,
              orchestrator: orchestrator as never,
            });
            if (rollouts.scanned > 0) {
              console.log("[worker] cron_reconcile_v3 rollout resume:", JSON.stringify(rollouts));
            }
          }
        } catch (e) {
          // Rollout recovery failure does not block same-revision reconciliation; the next tick retries.
          console.error("[worker] rollout resume failed:", e instanceof Error ? e.message : e);
        }

        // Same-revision only: sink reads the already persisted ingress/egress
        // bindings and never chooses a new node/port. Offline nodes therefore
        // produce findings instead of automatic migration.
        const deps = defaultReconcileDeps();
        deps.sink = createRuntimeReconcileSink();
        // Evaluate automatic failover after rollout resume and same-revision repairs.
        // Order matters: a node that is merely behind gets
        // repaired by the resend path first, and only what remains broken is considered
        // for a migration. The sweep is fail-closed internally — with no
        // FAILOVER_POLICY configured it does nothing at all.
        deps.failoverSweep = async () => {
          const { runFailoverSweep } = await import("./services/failover-loop.ts");
          const r = await runFailoverSweep({
            // Preserve every decision level: waiting/aborted failover outcomes are useful INFO,
            // not warnings, but must remain observable.
            log: (e) => {
              const line = `[worker] failover: ${e.message} ${e.detail ? JSON.stringify(e.detail) : ""}`;
              if (e.level === "error") console.error(line);
              else if (e.level === "warn") console.warn(line);
              else console.log(line);
            },
          });
          if (r.evaluated > 0) {
            console.log("[worker] failover sweep:", JSON.stringify({
              evaluated: r.evaluated,
              moved: r.moved,
              held: r.held,
              // DNS-gated failover reasons must remain visible; fail-closed without a reason is not operable.
              dns_gated: r.dns_gated.length,
              // 只在真的有被闸住的隧道时附带原因，避免每拍刷噪音；条数封顶，日志长度有界。
              ...(r.dns_gated.length > 0 ? { dns_gated_reasons: r.dns_gated.slice(0, 5) } : {}),
            }));
          }
          return { evaluated: r.evaluated, moved: r.moved, held: r.held, dns_gated: r.dns_gated.length };
        };
        const r = await executeReconcile(deps);
        const summary = {
          scanned: r.scanned,
          findings: r.findings.length,
          resent: r.resent,
          failed: r.failed,
          no_transport: r.noTransport,
          leases: r.leases,
        };
        if (r.findings.length > 0 || r.failed > 0) {
          console.log("[worker] cron_reconcile_v3:", JSON.stringify(summary));
          // Print actionable finding details, not only aggregate counts.
          for (const f of r.findings) {
            if (f.severity === "error" || f.code === "resend_skipped") {
              console.log(
                "[worker] reconcile finding:",
                JSON.stringify({ code: f.code, tunnel_id: f.tunnel_id, node_id: f.node_id, detail: f.detail }),
              );
            }
          }
        }
        // Federation closure runs only after local reconciliation so local repair gets first chance.
        let federationSummary: Record<string, number> | null = null;
        try {
          const { runFederationReconcile } = await import("./services/federation/lease.ts");
          const fed = await runFederationReconcile();
          federationSummary = {
            evaluated: fed.evaluated,
            expired: fed.expired,
            tore_down: fed.tore_down,
            teardown_failed: fed.teardown_failed,
            ports_released: fed.ports_released,
            ports_pending: fed.ports_pending,
            grants_expired: fed.grants_expired,
            placements_resent: fed.resent,
            revoked_cleaned: fed.revoked_cleaned,
            revoked_teardown_failed: fed.revoked_teardown_failed,
          };
          // 只在有事发生时打印：空闲的联邦不该刷屏，但"有事"必须留痕。
          const busy = Object.entries(federationSummary).some(([k, v]) => k !== "evaluated" && v > 0);
          if (busy) console.log("[worker] federation reconcile:", JSON.stringify(federationSummary));
        } catch (e) {
          // Federation failure must not block local reconciliation.
          console.error("[worker] federation reconcile failed:", e instanceof Error ? e.message : e);
        }


        return { ...summary, federation: federationSummary };
      }
      case "cron_settle_billing": {
        // Settlement claims a unique (subscription, period) row before execution. Stale pending
        // work can be taken over on a later tick; this worker records settlement state but does not
        // invent a successful renewal when payment/renewal execution has not completed.
        const r = await settleDuePeriods(defaultSettlementDeps());
        const summary = {
          period_key: r.period_key,
          due: r.due,
          settled: r.settled,
          skipped: r.skipped,
          deferred: r.deferred,
          failed: r.failed,
          taken_over: r.taken_over,
          truncated: r.truncated,
        };
        // 只在「有事」时打印（与 federation reconcile 同取向）：空闲的结算不该刷屏，
        // 但每个非零计数都是钱路径上的信号，必须留痕；脏配置（missing/invalid）也要可见。
        const busy =
          r.settled > 0 ||
          r.skipped > 0 ||
          r.deferred > 0 ||
          r.failed > 0 ||
          r.taken_over > 0 ||
          r.takeover_config_missing ||
          r.takeover_config_invalid ||
          r.truncated;
        if (busy) {
          console.log(
            "[worker] cron_settle_billing:",
            JSON.stringify({
              ...summary,
              takeover_minutes: r.takeover_minutes,
              takeover_config_missing: r.takeover_config_missing,
              takeover_config_invalid: r.takeover_config_invalid,
              errors: r.errors,
            }),
          );
        }
        return summary;
      }
      default:
        throw new Error(`unknown cron job: ${job.name}`);
    }
  },
  { connection, concurrency: 5 },
);

worker.on("failed", (job, err) => console.error(`[worker] job ${job?.name} failed:`, err.message));
worker.on("completed", (job) => console.log(`[worker] ${job.name} ok (${Date.now() - job.timestamp}ms since enqueue)`));

async function registerSchedules() {
  for (const j of CRON_JOBS) {
    if (j.pattern) {
      await queue.upsertJobScheduler(j.name, { pattern: j.pattern }, { name: j.name });
    } else if (j.everyMs) {
      await queue.upsertJobScheduler(j.name, { every: j.everyMs }, { name: j.name });
    }
  }
  console.log(`[worker] registered ${CRON_JOBS.length} cron schedulers: ${CRON_JOBS.map((j) => j.name).join(",")}`);
}

async function main() {
  if (env.disableWorker) {
    console.log("[worker] DISABLE_WORKER=true, exiting");
    process.exit(0);
  }
  // Wait for dependencies, but never advertise a ready worker when they stayed unavailable.
  let dependenciesReady = false;
  let lastDependencyError: unknown = null;
  for (let i = 0; i < 30; i++) {
    try {
      await db.$queryRaw`SELECT 1`;
      await connection.ping();
      dependenciesReady = true;
      break;
    } catch (error) {
      lastDependencyError = error;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (!dependenciesReady) {
    const detail = lastDependencyError instanceof Error ? lastDependencyError.message : String(lastDependencyError ?? "unknown error");
    throw new Error(`worker dependencies unavailable after startup grace period: ${detail}`);
  }
  // Federation teardown/revocation/port hooks must be wired before the first federation tick.
  try {
    const { ensureFederationWiring } = await import("./services/federation/lease.ts");
    ensureFederationWiring();
    console.log("[worker] federation wiring ready");
  } catch (e) {
    console.error("[worker] federation wiring failed:", e instanceof Error ? e.message : e);
  }
  await registerSchedules();
  console.log("[worker] ready");
}

main().catch((e) => {
  console.error("[worker fatal]", e);
  process.exit(1);
});
