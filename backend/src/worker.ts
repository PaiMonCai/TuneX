/**
 * Worker —— BullMQ 队列 + cron 调度器
 * 依据: worker-cross-validation-report.md §cron 任务表 + PLAN §阶段 3
 *
 * ============================================================
 * 任务名单与真实状态（2026-09-25 收尾）
 * ============================================================
 * 已实现（注册调度，handler 有真实业务逻辑）：
 *   cron_save_traffic           每 10 分钟      Redis → MySQL 流量归档（OPS-01/OPS-03，幂等）
 *   cron_delete_tunnel_traffic  每日 0 点        过期流量清理（OPS-03，按
 *                                                TUNNEL_TRAFFIC_RETENTION_DAYS，幂等，
 *                                                见 services/traffic-retention.ts）
 *   cron_check_node_offline     每 10s         离线检测（消费 dc:* 标记，防抖到点置 inactive）
 *   cron_latency_history        每小时 :15     观测档案：小时桶聚合 + 过期清理（V5-WP19-B，
 *                                               先聚合后清理，幂等，见 services/latency-history.ts）
 *   cron_settle_billing         每小时 :45     订阅周期结算（V5-WP20-3：先占位后执行，唯一键
 *                                               是幂等闸门，崩在中间的 pending 由下一轮接管续跑。
 *                                               只记账、不扣款、不做权限判定，
 *                                               见 services/subscription-billing.ts）
 *
 * WP15 已删除：
 *   cron_push_node_config       每 5s          旧 Agent 的 gost 配置推送（Fernet 加密 + Socket.IO
 *                                                emit）。DIRECT 改由 v3 runtime 承载后，节点通过
 *                                                `/api/internal/node/state` 上报、由 orchestrator
 *                                                下发 revisioned apply 命令（§7.16 执行要求 1/4：
 *                                                不为旧 Agent 保留第二套配置生成路径）。
 *
 * 未实现（**已从 CRON_JOBS 移除，不再占位调度**）：
 *   cron_sync_dns               DNS 记录同步（CF+Huawei）——无任何实现，上游原版的
 *                                DNS provider 凭据/模型均未迁移进来
 *   cron_update_agent           Agent 版本检查 + 节点升级——无实现；仅剩一个
 *                                AUTO_UPDATE_AGENT 配置读取，不构成能力
 *   cron_notify_plan_expire    套餐到期通知——无实现（商业化模块，默认关闭）
 *   cron_renew_user_plan        自动续费——无实现（商业化模块，默认关闭）
 *   cron_repush_waiting_tunnel  重推等待中的隧道——无实现；「等待中」这一状态
 *                                在当前 schema/agent ACK 模型里不存在，
 *                                端口冲突反馈走 socket/listen-events.ts
 *   cron_reset_expired_tunnel   重置过期隧道——无实现；无「隧道过期」概念
 *                                （到期的是策略/额度，由 policy-service 判定）
 *   cron_reset_table_order      重置表排序——无实现，且无实际业务需求
 *
 * 为什么要移除而不是保留占位：PLAN §2 与 §9 明确要求「只注册已实现的 worker 任务，
 * 未实现任务要停调度并给出明确状态」。保留占位调度会让看板显示 11 个任务在跑，
 * 而其中 7 个永远只回一句 `note: cron handler not yet implemented`，
 * 既误导运维也无法证明能力。将来实现其中任何一项时：
 *   ① 在 services/ 写实现（含纯函数 + deps 注入 + 单测）；
 *   ② 回到本文件的 CRON_JOBS 与 switch 各加一行；
 *   ③ 更新本注释块与 PLAN.md 的 OPS-01 行。
 *
 * ── V4-WP3 的改动 ──
 * `cron_reconcile_v3` 的**第一步**改为 `resumeRollouts`：把 Normal/Pre-Comp 表
 * 里仍处于活跃相位的 rollout 捞起来按断点续跑（§3.5「恢复面」）。它放在对账
 * 之前而非之后，是因为对账只做同 revision 重发/缺失补发，而跨阶段推进与回退
 * 归 rollout——若顺序反了，「已被 rollout 推进到 CUTOVER」的对账项会被按旧
 * revision 重发，把已切走的节点拉回旧配置。
 */
import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { env } from "./env.ts";
import { db } from "./db.ts";
import { defaultOfflineDeps, runOfflineCheck } from "./socket/offline-detector.ts";
import { defaultRolloutResumeDeps, resumeRollouts } from "./services/forward-rollout-recovery.ts";
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
  // V5-WP20-3（契约 §5 的 WP20-3 行：每小时）。刻意错开 :15 的观测档案与整点归档，
  // 让「三件事用同一分钟」不会被误读成同一件事；周期结算本身与它们无共享资源。
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
        // OPS-01/OPS-03：Redis 流量缓冲 → MySQL 归档（幂等，见 services/traffic-archive.ts）。
        // 幂等三层防线：SETNX 占位锁 + (tunnel_id, date) 唯一索引 + 读走即删。
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
        // OPS-03：按 TUNNEL_TRAFFIC_RETENTION_DAYS 删除过期的 tunnel_traffic 行
        // （见 services/traffic-retention.ts）。删除条件 `date < cutoff` 是确定性的，
        // 因此重复执行幂等：第二轮匹配集为空。配置缺省/非法时回落默认 30 天
        // （结果里带 config_missing / config_invalid 标记，便于运维发现脏配置）。
        const r = await deleteExpiredTraffic(defaultTrafficRetentionDeps());
        if (r.deleted > 0 || r.config_missing || r.config_invalid) {
          console.log("[worker] cron_delete_tunnel_traffic:", JSON.stringify(r));
        }
        return r;
      }
      case "cron_latency_history": {
        // V5-WP19-B：观测档案的**先聚合、后清理**（顺序是硬约束，见
        // services/latency-history.ts 的 runLatencyHistoryMaintenance）：
        //   · rollup：把 ≥1h 前**已结束**的整点小时按 (节点, 目标, 口径) 聚合进桶表
        //     （`create` + 唯一冲突跳过 ⇒ 只追加、幂等）；
        //   · prune：原始样本 >24h、桶 >30d 按索引删（保留期走 system_config，脏值回落默认）。
        // 反过来会在"原始行已删、桶还没建"的窗口里永久丢一段历史（原始样本不可恢复）。
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
          errors: r.errors,
        };
        if (r.flipped > 0 || r.errors > 0) {
          console.log("[worker] cron_check_node_offline:", JSON.stringify(summary));
        }
        return summary;
      }
      case "cron_reconcile_v3": {
        // WP3 §3.5：rollout 续跑是本轮 reconcile 的**第一步**，失败不影响后续
        // 对账。理由：reconciler 只处理「同 revision 重发 / 缺失 runtime 补发」，
        // 跨阶段推进与补偿归 rollout；若把 rollout 排在 reconcile 之后，一次
        // 五阶段滚动中 reconcile 会先看到 `applied_revision < config_revision`
        // 并按旧 revision 重发一遍——多余但不致命，却让「谁在下发」变混。
        //
        // 只在 transport 可用时才跑：`resumeRollouts` 每一步都要 Agent 往返，
        // 没有 orchestrator 时逐条失败只是把日志刷满（这一轮已经由
        // `no_transport` 记账了）。
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
          // 续跑失败绝不阻断本轮 reconcile：§13.3.5 的失败分流已经在 rollout 行里，
          // 下一轮会自然重试。
          console.error("[worker] rollout resume failed:", e instanceof Error ? e.message : e);
        }

        // Same-revision only: sink reads the already persisted ingress/egress
        // bindings and never chooses a new node/port. Offline nodes therefore
        // produce findings instead of automatic migration.
        const deps = defaultReconcileDeps();
        deps.sink = createRuntimeReconcileSink();
        // V5.3 WP10: evaluate automatic failover AFTER the rollout resume above and
        // after this tick's repairs. Order matters: a node that is merely behind gets
        // repaired by the resend path first, and only what remains broken is considered
        // for a migration. The sweep is fail-closed internally — with no
        // FAILOVER_POLICY configured it does nothing at all.
        deps.failoverSweep = async () => {
          const { runFailoverSweep } = await import("./services/failover-loop.ts");
          const r = await runFailoverSweep({
            // EVERY level is printed, not just warn/error.
            //
            // V5.3 round 11: filtering to warn/error hid exactly the information needed to
            // diagnose an automatic failover that did not happen — the outcome
            // (`moved` / `waiting_lease` / `aborted:<reason>`) is reported at INFO, because a
            // correct decision that waits is not a warning. The result was a gate failure with
            // no trace anywhere, and a debugging round spent on guessing.
            log: (e) => {
              const line = `[worker] failover: ${e.message} ${e.detail ? JSON.stringify(e.detail) : ""}`;
              if (e.level === "error") console.error(line);
              else if (e.level === "warn") console.warn(line);
              else console.log(line);
            },
          });
          if (r.evaluated > 0) {
            console.log("[worker] failover sweep:", JSON.stringify({ evaluated: r.evaluated, moved: r.moved, held: r.held }));
          }
          return { evaluated: r.evaluated, moved: r.moved, held: r.held };
        };
        // V5.5 WP16：联邦的周期收口。顺序在**本地 reconcile 之后**：先修好本机能修的东西，
        // 再处理跨面板的到期/停服/对账。每一拍都返回可打印的汇总 —— 上一阶段反复学到的
        // 教训是"决策不留痕的机制与从未运行过的机制无法区分"。
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
          // 联邦失败绝不阻断本地 reconcile（与之对称：本地失败也不该让联邦停摆）。
          console.error("[worker] federation reconcile failed:", e instanceof Error ? e.message : e);
        }

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
          // V5.3 round 14: finding DETAILS, not just the count.
          //
          // Second time this gap cost a round: `failed: 1` says a dispatch was attempted and
          // threw, and the reason lived only inside a finding nobody printed. A count tells you
          // something happened; only the detail tells you what.
          for (const f of r.findings) {
            if (f.severity === "error" || f.code === "resend_skipped") {
              console.log(
                "[worker] reconcile finding:",
                JSON.stringify({ code: f.code, tunnel_id: f.tunnel_id, node_id: f.node_id, detail: f.detail }),
              );
            }
          }
        }
        return { ...summary, federation: federationSummary };
      }
      case "cron_settle_billing": {
        // V5-WP20-3（契约 §3.1/§3.2.4/§3.5.3，DoD 4/5）：订阅周期结算。
        //
        // 幂等 = 先占位后执行，**不是**「再查一遍」：闸门是
        // `subscription_period_settlement UNIQUE(plan_subscription_id, period_key)` 这个 DB 唯一键；
        // 崩在「占位之后、执行之前」的 `pending` 由下一轮按 O4 的超时（SystemConfig
        // `BILLING_SETTLEMENT_TAKEOVER_MINUTES`，缺省 10 分钟）接管续跑。
        //
        // 这一拍**只记账**：不扣款、不发放、不做任何额度/权限判定（契约 §3.2.4/§3.5.3，
        // DoD 1/2）。续期的扣款 + 发放（purchase 发放的唯一写入点）由 WP20-4 接进
        // `deps.executePeriod`；在那之前 `auto_renew=true` 的订阅会被**留在 pending** 等接管，
        // 而不是假装结算完成 —— 「绝不默认扣款续期」在代码里就是这个形状。
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
        return { note: "cron handler not yet implemented", ms: Date.now() - started };
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
  // 等待依赖就绪
  for (let i = 0; i < 30; i++) {
    try {
      await db.$queryRaw`SELECT 1`;
      await connection.ping();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  // V5.5 WP15：联邦的依赖接线（停服钩子 / 撤销钩子 / 端口钩子）必须在任何一拍
  // 联邦 reconcile 之前完成 —— 否则"到期停服"会因为没有停服钩子而变成一次静默失败。
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
