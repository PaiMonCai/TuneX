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
 */
import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { env } from "./env.ts";
import { db } from "./db.ts";
import { defaultOfflineDeps, runOfflineCheck } from "./socket/offline-detector.ts";
import { defaultTrafficArchiveDeps, flushTrafficBuffer } from "./services/traffic-archive.ts";
import { defaultTrafficRetentionDeps, deleteExpiredTraffic } from "./services/traffic-retention.ts";
import { defaultReconcileDeps, executeReconcile } from "./services/reconciler.ts";
import { createRuntimeReconcileSink } from "./services/runtime-reconcile-sink.ts";

export const CRON_JOBS: Array<{ name: string; pattern?: string; everyMs?: number; desc: string }> = [
  { name: "cron_save_traffic", pattern: "*/10 * * * *", desc: "Redis → MySQL 流量同步（OPS-01/OPS-03，幂等）" },
  { name: "cron_delete_tunnel_traffic", pattern: "0 0 * * *", desc: "删除过期流量记录（OPS-03，按保留期，幂等）" },
  { name: "cron_check_node_offline", everyMs: 10_000, desc: "离线检测：dc:* 防抖到点置 inactive" },
  { name: "cron_reconcile_v3", everyMs: 30_000, desc: "v3 desired/runtime/lease 同 revision 对账修复" },
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
        // Same-revision only: sink reads the already persisted ingress/egress
        // bindings and never chooses a new node/port. Offline nodes therefore
        // produce findings instead of automatic migration.
        const deps = defaultReconcileDeps();
        deps.sink = createRuntimeReconcileSink();
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
  await registerSchedules();
  console.log("[worker] ready");
}

main().catch((e) => {
  console.error("[worker fatal]", e);
  process.exit(1);
});
