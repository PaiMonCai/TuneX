/**
 * Worker —— BullMQ 队列 + 10 个 cron 任务
 * 依据: worker-cross-validation-report.md §cron 任务表
 *
 * 任务名单（原版确认为 10 个）：
 *   cron_delete_tunnel_traffic   0 0 * * *        过期流量清理
 *   cron_save_traffic            *\/10 * * * *    Redis → MySQL 流量同步
 *   cron_sync_dns                *\/30 * * * * *  DNS 同步
 *   cron_update_agent            *\/5 * * * * *   Agent 版本检查
 *   cron_notify_plan_expire      套餐到期通知
 *   cron_renew_user_plan         自动续费
 *   cron_repush_waiting_tunnel   重推等待中的隧道
 *   cron_reset_expired_tunnel    重置过期隧道
 *   cron_reset_table_order       重置表排序
 *   cron_push_node_config        推送节点配置
 *
 * 全部 10 个 cron 任务均已注册调度；各 handler 当前为占位实现（仅打日志/计数），
 * 真正的业务逻辑（流量入库、DNS 同步、自动续费等）待后续迭代补齐。
 */
import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { env } from "./env.ts";
import { db } from "./db.ts";
import { redis } from "./redis.ts";

export const CRON_JOBS: Array<{ name: string; pattern?: string; everyMs?: number; desc: string }> = [
  { name: "cron_save_traffic", pattern: "*/10 * * * *", desc: "Redis → MySQL 流量同步" },
  { name: "cron_delete_tunnel_traffic", pattern: "0 0 * * *", desc: "删除过期流量记录" },
  { name: "cron_sync_dns", pattern: "*/30 * * * * *", desc: "DNS 记录同步（CF+Huawei）" },
  { name: "cron_update_agent", pattern: "*/5 * * * * *", desc: "Agent 版本检查+节点升级" },
  { name: "cron_notify_plan_expire", everyMs: 3600_000, desc: "套餐到期通知" },
  { name: "cron_renew_user_plan", everyMs: 3600_000, desc: "自动续费" },
  { name: "cron_repush_waiting_tunnel", everyMs: 60_000, desc: "重推等待中的隧道" },
  { name: "cron_reset_expired_tunnel", everyMs: 60_000, desc: "重置过期隧道" },
  { name: "cron_reset_table_order", everyMs: 86_400_000, desc: "重置表排序" },
  { name: "cron_push_node_config", everyMs: 5_000, desc: "推送节点配置" },
];

const connection = new IORedis(env.redisUrl, { maxRetriesPerRequest: null });
const queue = new Queue("tunex-cron", { connection });

const worker = new Worker(
  "tunex-cron",
  async (job: Job) => {
    const started = Date.now();
    switch (job.name) {
      case "cron_save_traffic": {
        // 待实现：Redis HINCRBYFLOAT 缓冲 → tunnel_traffic createMany
        const pending = await redis.keys("tunnel:traffic:*");
        return { pending: pending.length, note: "buffer→DB" };
      }
      case "cron_delete_tunnel_traffic": {
        // 待实现：按 TUNNEL_TRAFFIC_RETENTION_DAYS 清理
        const days = await db.systemConfig.findUnique({ where: { name: "TUNNEL_TRAFFIC_RETENTION_DAYS" } });
        return { retention_days: days?.value ?? "30" };
      }
      case "cron_push_node_config":
        return { nodes: await db.node.count(), note: "sha256 incremental push" };
      case "cron_update_agent":
        return { auto_update: await db.systemConfig.findUnique({ where: { name: "AUTO_UPDATE_AGENT" } }) };
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
  console.log(`[worker] registered ${CRON_JOBS.length} cron schedulers`);
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
