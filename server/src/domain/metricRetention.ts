/**
 * Whole UTC days a day's raw `metric_event` rows are kept after it ends.
 * Older days survive only as daily aggregates, which carry every count the
 * dashboard reads but not the per-event failure detail. Fixed by design
 * (CMP-95): not configurable, and folding cannot be turned off.
 */
export const METRIC_RAW_RETENTION_DAYS = 8;

/**
 * How far ahead of the server clock an event may claim to have been emitted.
 * Anything further comes from a device clock that is wrong, and storing it
 * would park the row ahead of every fold until that date arrives.
 */
export const METRIC_FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

const UTC_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 00:00Z of the UTC day `instant` falls on. Computed on the epoch value, not
 * with Date's local-time setters, so the server's time zone never moves the
 * boundary; `floor` keeps a pre-1970 instant from a wrong device clock on its
 * own day.
 */
export function utcDay(instant: Date): Date {
  return new Date(Math.floor(instant.getTime() / UTC_DAY_MS) * UTC_DAY_MS);
}

export function addUtcDays(day: Date, days: number): Date {
  return new Date(day.getTime() + days * UTC_DAY_MS);
}

/**
 * The first UTC day still kept raw at `now`; every earlier day is due to be
 * folded. A day D therefore folds once `now` reaches D + 9 days 00:00Z, when
 * the day has ended and eight more full days have passed.
 */
export function foldCutoff(now: Date): Date {
  return addUtcDays(utcDay(now), -METRIC_RAW_RETENTION_DAYS);
}

export function isFutureMetricEvent(emittedAt: Date, receivedAt: Date): boolean {
  return emittedAt.getTime() > receivedAt.getTime() + METRIC_FUTURE_TOLERANCE_MS;
}

/**
 * True when the event is dated on or before the retention cutoff, so ingest
 * acknowledges it without storing it.
 *
 * The cutoff day is refused even while its raw rows are still kept: it is
 * folded as soon as the UTC date changes, which can happen mid-request. A
 * later day needs the date to change twice before it is folded, so an event
 * accepted here is stored before any fold can reach its day, with no
 * watermark read or lock. An event younger than 7 days at receipt, the
 * client's own limit, always falls after the cutoff.
 */
export function isExpiredMetricEvent(
  emittedAt: Date,
  receivedAt: Date,
): boolean {
  return utcDay(emittedAt).getTime() <= foldCutoff(receivedAt).getTime();
}
