/**
 * V5-WP20-1 计费时钟（纯函数模块，**进程时区无关**）。
 *
 * 契约：`docs/v5-wp20-subscription-billing-runtime-contract.md` §3.1（计费时钟与幂等）、
 * §7.2（时间夹具：边界函数必须接受显式 `now`）、风险 R1（进程时区漂移）。
 * DoD 第 3 条：同一组断言必须在 `TZ=UTC` / `TZ=Asia/Shanghai` / `TZ=America/Los_Angeles`
 * 下**逐字相等** —— 因此本模块：
 *   1. **不读**进程时区环境变量（`TZ`），**不读**系统时钟（所有函数都要显式时间点入参）；
 *   2. **不用** `setHours` / `setDate` / `getHours` / `toISOString().slice(...)` 这类跟随进程
 *      时区的 API（它们是 F13 旧口径的成因）；
 *   3. 只从**固定时区** `Asia/Shanghai` 的 `Intl.DateTimeFormat` 派生日历分量。
 *
 * 为什么固定单区域时区（契约 §3.1.2）：`Workspace` / `CapabilityPolicy` 没有时区列，
 * per-workspace 时区会同时污染账本日标签（`tunnel_traffic.date`）、审计与 Gate；而窗口起点
 * 若跟随进程 TZ，缺失 `TZ=Asia/Shanghai` 的部署会让跨月边界整体偏移一天（R1）。
 *
 * 与 `Forwardx(参考项目，不进入git提交）/shared/billingTime.ts` 的关系：只**吸收语义**
 * （固定时区派生日历分量 + 月内日期夹取 + `maxResetDay=28` 上限避免 2 月跳变），
 * **实现独立重写、无代码复用**（契约 §2）。
 *
 * 本 WP 的边界：**只交付纯函数**。不改 `policy-service.ts` / `capability-policy.ts` 的读路径
 * （那是 WP20-6），不新增 schema、不注册 cron、不引入进程内缓存或单例时钟。
 */

/** 计费日历所属时区（契约 §3.1：单区域，不引入 per-workspace 时区）。 */
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
