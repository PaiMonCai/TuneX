/**
 * Canonical billing calendar helpers.
 *
 * All billing boundaries are derived from the fixed Asia/Shanghai calendar and
 * explicit input timestamps, so results do not depend on the process timezone
 * or ambient system clock. Workspace policy currently has no per-workspace
 * timezone, therefore month/day windows and persisted traffic-day labels must
 * share this single calendar definition.
 */

/** Canonical billing timezone used by all billing windows and day labels. */
export const BILLING_TIME_ZONE = "Asia/Shanghai";

/** 上海墙钟日历分量（`month` 1..12、`day` 1..31、`hour` 0..23，`hourCycle: "h23"` 下午夜是 0 不是 24）。 */
export interface BillingCalendarParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** 待还原为瞬时点的墙钟（含毫秒；仅模块内部使用）。 */
interface BillingWallClock extends BillingCalendarParts {
  millisecond: number;
}

/**
 * 固定时区格式化器：**唯一**的日历分量来源。
 * `en-US-u-nu-latn` 保证数字是拉丁数码（不随 locale 变成本地数字）；`hourCycle: "h23"` 保证午夜渲染为 `00`。
 */
const CALENDAR_FORMATTER = new Intl.DateTimeFormat("en-US-u-nu-latn", {
  timeZone: BILLING_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29;
  return MONTH_LENGTHS[month - 1] ?? 31;
}

function toInstant(value: Date | number): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new RangeError("billing-time: 时间点非法（NaN/Infinity）");
  }
  return date;
}

/** 把墙钟各分量拼成 UTC 戳。不用 `Date.UTC` 直出：它对 0..99 的年份会映射到 1900+y。 */
function utcStamp(clocks: BillingWallClock): number {
  const date = new Date(
    Date.UTC(clocks.year, clocks.month - 1, clocks.day, clocks.hour, clocks.minute, clocks.second, clocks.millisecond),
  );
  date.setUTCFullYear(clocks.year);
  return date.getTime();
}

function assertWallClock(clocks: BillingWallClock): void {
  const fields = [
    clocks.year,
    clocks.month,
    clocks.day,
    clocks.hour,
    clocks.minute,
    clocks.second,
    clocks.millisecond,
  ];
  if (!fields.every((field) => Number.isInteger(field))) {
    throw new RangeError("billing-time: 日历分量必须是整数");
  }
  if (clocks.year < 1 || clocks.year > 9999) throw new RangeError("billing-time: 年份越界");
  if (clocks.month < 1 || clocks.month > 12) throw new RangeError("billing-time: 月份越界");
  if (clocks.day < 1 || clocks.day > daysInMonth(clocks.year, clocks.month)) {
    throw new RangeError("billing-time: 日越界");
  }
  if (clocks.hour < 0 || clocks.hour > 23) throw new RangeError("billing-time: 小时越界");
  if (clocks.minute < 0 || clocks.minute > 59) throw new RangeError("billing-time: 分钟越界");
  if (clocks.second < 0 || clocks.second > 59) throw new RangeError("billing-time: 秒越界");
  if (clocks.millisecond < 0 || clocks.millisecond > 999) throw new RangeError("billing-time: 毫秒越界");
}

/** 该瞬时点上的上海分区偏移（毫秒，恒为 +08:00）；由 Intl 派生，不硬编码偏移值。 */
function zoneOffsetMsAt(instantMs: number): number {
  const parts = billingCalendarParts(instantMs);
  const renderedSecondMs = utcStamp({ ...parts, millisecond: 0 });
  return renderedSecondMs - Math.floor(instantMs / 1000) * 1000;
}

/**
 * 墙钟 → 瞬时点：先按「把墙钟当 UTC」初猜，再用该点上的分区偏移校正两次收敛。
 *
 * 反例说明（为什么不能只做一次减法）：偏移本身依赖候选瞬时点，一次校正后候选点可能落到
 * 另一侧的偏移段；Asia/Shanghai 现代无夏令时（一次即收敛），但收敛循环让函数在「有 DST 的
 * 时区被误配进来」时也仍然确定。真正落在 DST 空洞/重叠里的墙钟时刻不是本模块的契约范围
 * （契约把时区冻结为 Asia/Shanghai）。
 */
function wallClockToInstant(clocks: BillingWallClock): Date {
  assertWallClock(clocks);
  const targetMs = utcStamp(clocks);
  let instantMs = targetMs - zoneOffsetMsAt(targetMs);
  for (let round = 0; round < 2; round += 1) {
    const corrected = targetMs - zoneOffsetMsAt(instantMs);
    if (corrected === instantMs) break;
    instantMs = corrected;
  }
  return new Date(instantMs);
}

/** 把 `resetDay` / `maximumResetDay` 这类「可来自 SystemConfig 字符串」的入参收敛成合法整数日。 */
function coerceResetDay(value: number | string | null | undefined): number {
  const numeric = Math.floor(Number(value));
  return Number.isFinite(numeric) && numeric >= 1 ? numeric : 1;
}

/** 上海墙钟日历分量。入参必须是显式时间点，禁止读系统时钟。 */
export function billingCalendarParts(value: Date | number): BillingCalendarParts {
  const parts = CALENDAR_FORMATTER.formatToParts(toInstant(value));
  const read = (type: "year" | "month" | "day" | "hour" | "minute" | "second"): number => {
    const numeric = Number(parts.find((part) => part.type === type)?.value);
    if (!Number.isInteger(numeric)) throw new RangeError(`billing-time: 缺少日历分量 ${type}`);
    return numeric;
  };
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

/**
 * `reference` 所在**上海自然月的月首**（当月 1 日 00:00:00.000 上海）。
 * 这是 `traffic_period="month"` 的窗口起点语义（F13 旧实现跟随进程 TZ，见 WP20-6 收敛）。
 */
export function billingMonthStart(reference: Date | number): Date {
  const { year, month } = billingCalendarParts(reference);
  return wallClockToInstant({ year, month, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 });
}

/** 结算周期键的粒度：`month` → `YYYY-MM`（月结，默认）；`day` → `YYYY-MM-DD`（日结）。 */
export type BillingPeriodGranularity = "month" | "day";

/**
 * `reference` 所在**上海自然日的日首**（当日 00:00:00.000 上海）。
 * 与 {@link billingMonthStart} 同构：`traffic_period="day"` 的窗口起点与
 * {@link billingPeriodKey}`(…, "day")` 必须同源，否则日界两侧会差一天。
 */
export function billingDayStart(reference: Date | number): Date {
  const { year, month, day } = billingCalendarParts(reference);
  return wallClockToInstant({ year, month, day, hour: 0, minute: 0, second: 0, millisecond: 0 });
}

/**
 * `reference` 所属上海自然日的**归档戳**：该日标签在 **UTC 午夜**的瞬时点。
 *
 * 这是 `tunnel_traffic.date` 的存储约定（F14：`traffic.ts#localDayKey` 出标签、
 * `traffic-archive.ts#trafficDate` 把标签拼成 UTC 午夜）。WP20-6 之前它散在三处：
 * 写入端（archive）、读取端（dashboard/tunnels 的图表窗口）、保留期端（retention）。
 * 三处各自用 `setHours`/`toISOString` 拼，于是**读取端与写入端差一天**
 * （`setHours(0,0,0,0)` 后在 UTC+8 下 `toISOString().slice(0,10)` 会回退一天）。
 *
 * 现在这三处都从这里取：读到的键与写入的戳同源，**保留期仍然按 UTC 取整**
 * （它与存储戳同口径：`date < cutoff` 且两边都是 UTC 午夜）。
 *
 * 反例（为什么不能让 `date` 改成上海午夜）：存量行的 `date` 全是 UTC 午夜，改口径要求
 * 一次全表回填 + 保留期同步改，否则同一列里会同时存在两种日界 —— 那是账本一致性问题，
 * 不是显示问题。
 */
export function billingDayKeyStamp(reference: Date | number): Date {
  return new Date(`${billingPeriodKey(reference, "day")}T00:00:00.000Z`);
}

/**
 * 上海时区下的**周期键**：`YYYY-MM` / `YYYY-MM-DD`。
 *
 * 用途：`subscription_period_settlement.period_key`（WP20-2 冻结为 `VARCHAR(16)`，值域就是这两个形状）
 * —— 它是「每个周期只结算一次」这条账本事实的**唯一键**，因此必须与窗口起点（{@link billingMonthStart}）
 * 用**同一个**固定时区派生：否则账本的「一个月」与额度的「一个月」会各自解释一次跨月。
 *
 * 为什么这个函数不在 WP20-1 交付：那时 `period_key` 的列形状还没冻结（WP20-2 才定 `VARCHAR(16)`），
 * 先冻一个没有消费者的格式等于让形状脱离使用点决策（记录在契约 §5.1「明确延期」）。
 *
 * 反例（为什么不能用 `toISOString().slice(0, 7)`）：`2026-01-31T16:00:00Z` 在上海已是 2 月 1 日，
 * UTC 口径会把它算成 `2026-01` —— 跨月那一秒的账本行会落到上一个月里。
 */
export function billingPeriodKey(
  reference: Date | number,
  granularity: BillingPeriodGranularity = "month",
): string {
  const { year, month, day } = billingCalendarParts(reference);
  const monthPart = `${year}-${String(month).padStart(2, "0")}`;
  if (granularity === "month") return monthPart;
  return `${monthPart}-${String(day).padStart(2, "0")}`;
}

/**
 * 计费月边界：`reference` 所在上海月 + `monthOffset` 的月内第 `resetDay` 日 00:00:00.000（上海）。
 *
 * 夹取规则（两条，顺序固定，均有反例测试）：
 *   1. `day = min(requested, maximumResetDay，默认 28, 该月实际天数)` —— 28 天上限避免
 *      「1 月 31 日 + 1 月 = 2 月 31 日」式的跳变（契约 §2 吸收 Forwardx 语义）；
 *   2. `requested` 非法（0 / 负数 / 空串 / `NaN` / 小数向下取整后 < 1）一律回落 **1**。
 *
 * 契约 §3.1「明确不做用户可配结算日」：产品侧固定 `resetDay=1` = 自然月月初；
 * 该参数只为实现完备性保留（`monthOffset=-1` 用来取上一周期边界）。
 */
export function billingMonthlyBoundary(
  reference: Date | number,
  resetDay: number | string | null | undefined,
  monthOffset = 0,
  maximumResetDay: number | string | null | undefined = 28,
): Date {
  if (!Number.isFinite(monthOffset)) throw new RangeError("billing-time: monthOffset 非法");
  const current = billingCalendarParts(reference);
  const totalMonths = current.year * 12 + (current.month - 1) + Math.trunc(monthOffset);
  const year = Math.floor(totalMonths / 12);
  const month = totalMonths - year * 12 + 1;
  const day = Math.min(coerceResetDay(resetDay), coerceResetDay(maximumResetDay), daysInMonth(year, month));
  return wallClockToInstant({ year, month, day, hour: 0, minute: 0, second: 0, millisecond: 0 });
}

/**
 * 按月推进并**夹取日**，保留上海墙钟的时/分/秒/毫秒。
 *
 * 为什么保留墙钟而不是保留 UTC 偏移：`started_at` 与 `expires_at` 在用户看来是同一时刻的
 * 自然月位移（如「1 月 31 日 10:30 买的月付，2 月 28 日 10:30 到期」）；若按 UTC 偏移加月，
 * 一旦时区带 DST 就会在月末凭空多/少一小时。
 * 反例：`2026-01-31 10:30 上海` + 1 月 → `2026-02-28 10:30 上海`（2026 非闰年，**夹取**而非溢出到 3 月）。
 */
export function billingAddMonthsClamped(reference: Date | number, months: number): Date {
  if (!Number.isFinite(months)) throw new RangeError("billing-time: months 非法");
  const date = toInstant(reference);
  const current = billingCalendarParts(date);
  const totalMonths = current.year * 12 + (current.month - 1) + Math.trunc(months);
  const year = Math.floor(totalMonths / 12);
  const month = totalMonths - year * 12 + 1;
  const day = Math.min(current.day, daysInMonth(year, month));
  return wallClockToInstant({
    year,
    month,
    day,
    hour: current.hour,
    minute: current.minute,
    second: current.second,
    millisecond: date.getMilliseconds(),
  });
}
