/**
 * WP20-1 的「同一组断言」金样本生成器（**测试专用**，不进生产路径）。
 *
 * 为什么单独一个文件：DoD 第 3 条要求同一组断言在三个进程时区下**逐字相等**。测试文件
 * 在本进程调用一次，再用 `Bun.spawnSync` 在 `TZ=UTC` / `TZ=Asia/Shanghai` /
 * `TZ=America/Los_Angeles` 三个子进程里各调用一次，逐字比较输出；被两边调用的逻辑必须
 * 与被测模块一样**不依赖进程时区**，所以这里只允许调用 `billing-time.ts` 的纯函数。
 *
 * 覆盖的输入刻意压在「进程 TZ 会算错」的点上：UTC 日与上海日不同的时刻、月首/月末边界、
 * 闰年 2 月、以及 `resetDay` 夹取。
 */
import {
  BILLING_TIME_ZONE,
  billingAddMonthsClamped,
  billingCalendarParts,
  billingDayStart,
  billingMonthStart,
  billingMonthlyBoundary,
  billingPeriodKey,
} from "../../billing-time.ts";

/** 金样本输入（毫秒时间戳以 ISO 字符串给出，避免读系统时钟）。 */
export const CANONICAL_INSTANTS: readonly string[] = [
  "2026-01-01T00:00:00.000Z", // 上海 2026-01-01 08:00
  "2026-01-31T15:59:59.999Z", // 上海 2026-01-31 23:59:59.999（UTC 仍在 31 日）
  "2026-01-31T16:00:00.000Z", // 上海 2026-02-01 00:00（UTC 日界与上海日界错开）
  "2026-02-28T15:59:59.999Z",
  "2026-02-28T16:00:00.000Z", // 上海 2026-03-01 00:00
  "2026-12-31T16:00:00.000Z", // 上海 2027-01-01 00:00（跨年）
  "2028-01-31T02:30:00.000Z", // 上海 2028-01-31 10:30（闰年、月内 31 日）
];

/** 每个瞬时点上的可判定输出（全部是字符串/数字，便于逐字比较）。 */
export interface CanonicalRow {
  instant: string;
  parts: string;
  month_start: string;
  day_start: string;
  period_key_month: string;
  period_key_day: string;
  boundary_reset1: string;
  boundary_prev_month: string;
  boundary_reset31_capped: string;
  boundary_reset31_uncapped: string;
  plus_one_month: string;
  plus_twelve_months: string;
  minus_one_month: string;
}

/** 生成金样本。**纯函数**：同一输入在任何进程时区下必须给出逐字相同的输出。 */
export function canonicalRows(): CanonicalRow[] {
  return CANONICAL_INSTANTS.map((instant) => {
    const at = new Date(instant);
    const parts = billingCalendarParts(at);
    return {
      instant,
      parts: [parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second].join("-"),
      month_start: billingMonthStart(at).toISOString(),
      // V5-WP20-3 新增：结算周期键与日首也必须进程时区无关（它们进账本唯一键，漂移 = 跨月错账）。
      day_start: billingDayStart(at).toISOString(),
      period_key_month: billingPeriodKey(at, "month"),
      period_key_day: billingPeriodKey(at, "day"),
      boundary_reset1: billingMonthlyBoundary(at, 1).toISOString(),
      boundary_prev_month: billingMonthlyBoundary(at, 1, -1).toISOString(),
      boundary_reset31_capped: billingMonthlyBoundary(at, 31).toISOString(),
      boundary_reset31_uncapped: billingMonthlyBoundary(at, 31, 0, 31).toISOString(),
      plus_one_month: billingAddMonthsClamped(at, 1).toISOString(),
      plus_twelve_months: billingAddMonthsClamped(at, 12).toISOString(),
      minus_one_month: billingAddMonthsClamped(at, -1).toISOString(),
    };
  });
}

/** 供子进程打印的稳定文本（`BILLING_TIME_ZONE` 也进样本，防止有人把它改成本地时区）。 */
export function canonicalText(): string {
  return JSON.stringify({ timeZone: BILLING_TIME_ZONE, rows: canonicalRows() });
}
