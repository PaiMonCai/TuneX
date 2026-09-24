/**
 * 流量保留期清理（OPS-03 / PLAN §阶段 3）
 *
 * `tunnel_traffic` 按计量日界（UTC 午夜）追加写，`(tunnel_id, date)` 唯一。
 * 保留期配置项 `TUNNEL_TRAFFIC_RETENTION_DAYS`（`config` 表，seed 默认
 * `30`）控制「多少天前的行可以删」。本模块把它变成：
 *
 *   1. {@link resolveRetentionDays}：纯函数 —— 读到的字符串 → 可用的天数；
 *      缺省 / 非数字 / <=0 / 越界一律回落到 {@link DEFAULT_RETENTION_DAYS}，
 *      **绝不**因为一条脏配置就删不掉（无限保留）或全删（0 天）。
 *   2. {@link retentionCutoff}：纯函数 —— 天数 → 删除边界时间戳
 *      （UTC 日界，与 `date` 列口径一致：删 `date < cutoff` 的行）。
 *   3. {@link deleteExpiredTraffic}：删除编排（DB 依赖可注入，便于单测）。
 *
 * ── 幂等（PLAN §阶段 3 验收「worker 幂等」）──
 * `deleteMany` 带确定性的 `date < cutoff` where 条件，重复执行结果相同：
 * 第二轮的匹配集是空集（`deleted: 0`），不存在「删两遍」「删错天」的可能。
 * cron 每天 0 点触发一次，失败由 BullMQ 重试，同样幂等。
 *
 * ── 时区口径 ──
 * 与 traffic-archive / traffic.ts 的日界口径保持一致：`tunnel_traffic.date`
 * 存的是 **UTC 午夜**，因此边界也按 UTC 午夜计算。用本地零点会把 UTC+8
 * 下的边界整体偏移 8 小时，导致临界日界的行被提前/延后删除。
 */
import type { Prisma } from "@prisma/client";

/** 保留期缺省天数：与 `prisma/seed.ts` 的 `TUNNEL_TRAFFIC_RETENTION_DAYS` 默认值一致。 */
export const DEFAULT_RETENTION_DAYS = 30;

/**
 * 保留期天数上限：防止把配置误写成天文数字（查询窗口过大）或负数。
 * 10 年足够覆盖任何合规场景；真有更长需求应先改这个常量并补测试。
 */
export const MAX_RETENTION_DAYS = 3650;

/** 解析后的保留期（含「记录不可用/不合法」状态，供调用方决定是否跳过本轮）。 */
export interface RetentionDecision {
  /** 解析出的天数（>= 1）；非法输入回落 {@link DEFAULT_RETENTION_DAYS}。 */
  days: number;
  /** 输入是否为缺省（null = 没有这一行配置）。 */
  missing: boolean;
  /** 输入是否为非法值（非数字 / <=0 / 越界 / 非整数），已回落到默认值。 */
  invalid: boolean;
}

/**
 * 把 `config` 表里的 `TUNNEL_TRAFFIC_RETENTION_DAYS` 字符串解析成天数。
 *
 * 判定（顺序固定，保证行为可预测）：
 *   1. `raw == null` → `{ missing: true, days: DEFAULT_RETENTION_DAYS }`；
 *   2. 非正整数（`"abc"` / `"1.5"` / `"-3"` / `"0"` / `"1e3"` 视为非整数）
 *      → `{ invalid: true, days: DEFAULT_RETENTION_DAYS }`；
 *   3. `> MAX_RETENTION_DAYS` → 同样回落默认值（invalid）。
 *
 * 只返回可用天数，**不抛异常**：cron 不能因为一条脏配置就每天报警。
 */
export function resolveRetentionDays(raw: string | null | undefined): RetentionDecision {
  if (raw === null || raw === undefined || String(raw).trim() === "") {
    return { days: DEFAULT_RETENTION_DAYS, missing: true, invalid: false };
  }
  const n = Number(raw);
  const valid =
    Number.isFinite(n) &&
    Number.isInteger(n) &&
    n >= 1 &&
    n <= MAX_RETENTION_DAYS;
  if (!valid) return { days: DEFAULT_RETENTION_DAYS, missing: false, invalid: true };
  return { days: n, missing: false, invalid: false };
}

/**
 * 保留期 → 删除边界（UTC 日界）。
 *
 * 语义：删除 `date < cutoff` 的行，即**恰好保留最近 `days` 个自然日**
 * （含今天）。例：`days=30, now=2026-09-30T05:00Z` → `2026-09-01T00:00:00Z`，
 * 09-01 及以后保留，08-31 及更早删除。
 *
 * 用 UTC 而不是本地时区：`tunnel_traffic.date` 由 `trafficDate()`（UTC 午夜）
 * 写入，两边必须同一口径，否则 UTC+8 环境下临界日界的行会被算错一天。
 */
export function retentionCutoff(days: number, now: Date = new Date()): Date {
  const safe = Number.isFinite(days) && days >= 1 ? Math.floor(days) : DEFAULT_RETENTION_DAYS;
  const cutoff = new Date(now.getTime());
  cutoff.setUTCHours(0, 0, 0, 0);
  cutoff.setUTCDate(cutoff.getUTCDate() - safe);
  return cutoff;
}

/** 清理依赖（默认实现见 {@link defaultTrafficRetentionDeps}，测试注入 fake）。 */
export interface TrafficRetentionDeps {
  /** 读 `config` 表里的保留期配置；返回 value 或 null。 */
  readRetentionConfig(): Promise<string | null>;
  /** 删除早于 cutoff 的行，返回删除条数。 */
  deleteBefore(cutoff: Date): Promise<number>;
}

/** 一轮清理的结果统计（worker 日志用）。 */
export interface TrafficRetentionResult {
  /** 生效的保留天数（可能是回落后的默认值）。 */
  retention_days: number;
  /** 删除边界 ISO 串（`date < cutoff` 的行被删）。 */
  cutoff: string;
  /** 实际删除的行数。 */
  deleted: number;
  /** 配置缺失时为 true。 */
  config_missing: boolean;
  /** 配置值为非法时为 true（已回落默认）。 */
  config_invalid: boolean;
}

/** 单一 where 条件构造（单独导出便于单测断言边界，不必连库）。 */
export function retentionWhere(cutoff: Date): Prisma.TunnelTrafficWhereInput {
  return { date: { lt: cutoff } };
}

/**
 * 清理过期流量行（幂等，见文件头）。
 *
 * 失败语义：DB 不可用时向上抛，由 worker 的 failed 事件记录、BullMQ 重试；
 * 不吞错——静默失败会让「保留期清理已生效」的假设长期不成立（PLAN §风险
 * 「定时任务存在占位实现」正是这类问题）。
 */
export async function deleteExpiredTraffic(
  deps: TrafficRetentionDeps,
  now: Date = new Date(),
): Promise<TrafficRetentionResult> {
  const raw = await deps.readRetentionConfig();
  const decision = resolveRetentionDays(raw);
  const cutoff = retentionCutoff(decision.days, now);
  const deleted = await deps.deleteBefore(cutoff);
  return {
    retention_days: decision.days,
    cutoff: cutoff.toISOString(),
    deleted,
    config_missing: decision.missing,
    config_invalid: decision.invalid,
  };
}

/** 生产实现：真实 Prisma（懒加载 import，避免单测引入本模块即连库）。 */
export function defaultTrafficRetentionDeps(): TrafficRetentionDeps {
  return {
    async readRetentionConfig() {
      const { db } = await import("../db.ts");
      const row = await db.systemConfig.findUnique({
        where: { name: "TUNNEL_TRAFFIC_RETENTION_DAYS" },
        select: { value: true },
      });
      return row?.value ?? null;
    },
    async deleteBefore(cutoff) {
      const { db } = await import("../db.ts");
      const res = await db.tunnelTraffic.deleteMany({ where: retentionWhere(cutoff) });
      return res.count;
    },
  };
}
