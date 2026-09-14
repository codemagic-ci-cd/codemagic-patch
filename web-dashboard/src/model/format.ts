// Shared date / number / relative-time formatting.
//
// Replaces the seven per-page `formatDate`/`formatDateTime` copies and the four
// `formatCount` copies that had diverged on three axes: locale (en-US on some
// pages, browser-default `undefined` on others), invalid-date fallback ("—" vs
// raw ISO vs an unguarded `Intl.format` that prints the literal "Invalid Date"),
// and number notation (compact "1.2K" vs grouped "1,234"). Centralizing them
// gives one locale decision and one invalid-date contract for the whole app.
//
// Locale is pinned to en-US for deterministic ordering and consistent output
// strings ("Jun 9, 2026" and "Jun 9, 2026 · 14:28", 24-hour, middot separator).

const LOCALE = "en-US";

/** Rendered when an ISO string is missing or unparseable (single app-wide fallback). */
export const INVALID_DATE_PLACEHOLDER = "—";

const DATE_FORMAT = new Intl.DateTimeFormat(LOCALE, {
  year: "numeric",
  month: "short",
  day: "numeric",
});

// 24-hour clock with a leading zero (h23 → "14:28", "02:05"), matching the
// release-detail timestamp format.
const TIME_FORMAT = new Intl.DateTimeFormat(LOCALE, {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const COUNT_FORMAT = new Intl.NumberFormat(LOCALE);

function parseIso(iso: string | null | undefined): Date | null {
  if (iso === null || iso === undefined) {
    return null;
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "Jun 9, 2026" — date only. Invalid/missing → the em-dash placeholder. */
export function formatDate(iso: string | null | undefined): string {
  const date = parseIso(iso);
  return date === null ? INVALID_DATE_PLACEHOLDER : DATE_FORMAT.format(date);
}

/** "Jun 9, 2026 · 14:28" — date + 24h time joined by a middot. */
export function formatDateTime(iso: string | null | undefined): string {
  const date = parseIso(iso);
  return date === null
    ? INVALID_DATE_PLACEHOLDER
    : `${DATE_FORMAT.format(date)} · ${TIME_FORMAT.format(date)}`;
}

/** Grouped integer ("1,234") — one notation everywhere (never compact). */
export function formatCount(value: number): string {
  return COUNT_FORMAT.format(value);
}

/**
 * Short count for tight UI (chart axes): 999 stays "999", then "1.5k",
 * "10k", "1.2M", "3B". Hover and tables keep {@link formatCount}.
 */
export function formatCompactCount(value: number): string {
  const abs = Math.abs(value);
  if (abs < 1_000) {
    return COUNT_FORMAT.format(value);
  }
  if (abs < 1_000_000) {
    return formatScaled(value, 1_000, "k");
  }
  if (abs < 1_000_000_000) {
    return formatScaled(value, 1_000_000, "M");
  }
  return formatScaled(value, 1_000_000_000, "B");
}

function formatScaled(
  value: number,
  divisor: number,
  suffix: string,
): string {
  const rounded = Math.round((value / divisor) * 10) / 10;
  const body = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${body}${suffix}`;
}

/**
 * Format a 0..1 install success rate as a percent with two decimals
 * ("99.98"), without a % suffix. `100.00` only when the rate is exactly 1 —
 * leftover failures must not round into a perfect score.
 */
export function formatSuccessRate(rate: number): string {
  if (rate >= 1) {
    return "100.00";
  }
  if (rate <= 0) {
    return "0.00";
  }
  const rounded = Math.round(rate * 10_000) / 100;
  return Math.min(rounded, 99.99).toFixed(2);
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Compact relative time ("just now", "2m ago", "3h ago",
 * "29d ago"); beyond 30 days it falls back to the absolute date so the row
 * stays unambiguous. Invalid/missing → the em-dash placeholder.
 *
 * `now` is injectable for tests; production passes the default `Date.now()`.
 */
export function formatRelativeTime(
  iso: string | null | undefined,
  now: number = Date.now(),
): string {
  const date = parseIso(iso);
  if (date === null) {
    return INVALID_DATE_PLACEHOLDER;
  }
  const deltaMs = now - date.getTime();
  // Future timestamps (clock skew, "expires in") read as imminent rather than
  // a negative "ago".
  if (deltaMs < MINUTE_MS) {
    return "just now";
  }
  if (deltaMs < HOUR_MS) {
    return `${Math.floor(deltaMs / MINUTE_MS)}m ago`;
  }
  if (deltaMs < DAY_MS) {
    return `${Math.floor(deltaMs / HOUR_MS)}h ago`;
  }
  const days = Math.floor(deltaMs / DAY_MS);
  if (days <= 30) {
    return `${days}d ago`;
  }
  return DATE_FORMAT.format(date);
}
