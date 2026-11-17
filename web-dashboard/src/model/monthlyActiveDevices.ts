// Logic for the Monthly active devices chart. The server counts whole UTC days
// once a day, so the newest month usually covers part of the month, and a month
// can also start late. These helpers say which.
//
// Every date is a UTC calendar value. A date-only string parses as UTC midnight,
// which is still the previous day west of Greenwich, so the labels format in UTC
// rather than through model/format.ts, whose formatDate uses the local timezone.

export interface MonthlyActiveDevicesMonth {
  activeDevices: number;
  /** When counting began in this month across the server, UTC, `YYYY-MM-DD`. */
  firstDay: string;
  /** UTC calendar month, `YYYY-MM`. */
  month: string;
}

import type { ChartBucket } from "./timeseries";

export interface MonthlyActiveDevices {
  /** Last UTC day the figures can include, `YYYY-MM-DD`; null before the server's first count. */
  dataThrough: string | null;
  /** Newest first. */
  months: MonthlyActiveDevicesMonth[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** "2026-10" → "Oct 2026". */
export function formatMonthLabel(month: string): string {
  return new Date(`${month}-01`).toLocaleDateString("en-US", {
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  });
}

function formatDayLabel(day: string): string {
  return new Date(day).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/** Whether the counted days stop inside `month`, short of its last day. */
export function isMonthInProgress(month: string, dataThrough: string): boolean {
  if (!dataThrough.startsWith(month)) {
    return false;
  }
  const nextDay = new Date(Date.parse(dataThrough) + DAY_MS).toISOString();
  return nextDay.startsWith(month);
}

/** Whether the first counted day comes after the month's first day. */
export function coverageStartsLate(row: MonthlyActiveDevicesMonth): boolean {
  return row.firstDay > `${row.month}-01`;
}

/** "through Oct 25", "from Oct 3", or both; null when the whole month is covered. */
export function describeMonthCoverage(
  row: MonthlyActiveDevicesMonth,
  dataThrough: string | null,
): string | null {
  const notes: string[] = [];
  if (coverageStartsLate(row)) {
    notes.push(`from ${formatDayLabel(row.firstDay)}`);
  }
  if (dataThrough !== null && isMonthInProgress(row.month, dataThrough)) {
    notes.push(`through ${formatDayLabel(dataThrough)}`);
  }
  return notes.length === 0 ? null : notes.join(" ");
}

export interface MonthlyActiveDevicesChart {
  buckets: ChartBucket[];
  /** Estimated devices, one per bucket. */
  values: number[];
}

/**
 * The months the chart draws, oldest first: from the oldest month returned
 * through the month `dataThrough` falls in. Every deployment is counted daily,
 * so a month in between with no entry had no Active devices and is zero. Months
 * before the oldest entry are left out: nothing says counting had started.
 */
export function monthlyActiveDevicesChart({
  dataThrough,
  months,
}: MonthlyActiveDevices): MonthlyActiveDevicesChart {
  if (dataThrough === null || months.length === 0) {
    return { buckets: [], values: [] };
  }

  const byMonth = new Map(months.map((row) => [row.month, row]));
  const throughMonth = dataThrough.slice(0, 7);
  const newest = months[0].month > throughMonth ? months[0].month : throughMonth;
  const buckets: ChartBucket[] = [];
  const values: number[] = [];
  for (
    let month = months[months.length - 1].month;
    month <= newest;
    month = nextMonth(month)
  ) {
    const row = byMonth.get(month) ?? {
      activeDevices: 0,
      firstDay: `${month}-01`,
      month,
    };
    const coverage = describeMonthCoverage(row, dataThrough);
    buckets.push({
      key: month,
      label: formatMonthLabel(month),
      ...(coverage === null ? {} : { partialNote: coverage }),
    });
    values.push(row.activeDevices);
  }
  return { buckets, values };
}

function nextMonth(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber, 1)).toISOString().slice(0, 7);
}
