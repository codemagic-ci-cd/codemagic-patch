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
