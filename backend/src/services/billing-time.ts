/**
 * Monthly billing boundary in the Shanghai calendar.
 *
 * The requested reset day is clamped by the configured maximum and the actual
 * month length. Invalid reset-day values fall back to day 1.
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
