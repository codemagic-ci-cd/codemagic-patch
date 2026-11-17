// Wire-shape DTOs and chart helpers for GET /v1/metrics/deployments/:id/timeseries.
// Server contract (CMP-17 design v2): UTC day buckets, sparse points (missing
// bucket = zero events), `from` bucket-aligned, the bucket containing `to`
// partial by definition. `totals` counts each device once per bucket, so it is
// NOT the sum of `series` — a device spanning two releases in one bucket
// appears once per series but once in totals. Range totals, the success rate
// and cumulative Applied come from the server, not from these helpers.

export interface TimeseriesPoint {
  activeDevices: number;
  /** UTC day start, ISO 8601. */
  bucketStart: string;
  downloaded: number;
  failed: number;
  installed: number;
  success: number;
}

export interface TimeseriesSeriesEntry {
  /**
   * Running Applied total per UTC day of the range, from the server. Null for
   * the null-hash series and from servers older than the field.
   */
  cumulativeSuccess: number[] | null;
  points: TimeseriesPoint[];
  releaseId: string | null;
  releaseLabel: string | null;
  targetPackageHash: string | null;
}

export interface DeploymentTimeseries {
  /** Versions that reported in the range, newest comparable token first. */
  binaryVersions: string[];
  bucket: "day";
  from: string;
  /** Volume-ranked by the server; capped at its 50 busiest hashes. */
  series: TimeseriesSeriesEntry[];
  seriesTruncated: boolean;
  /** The server's range totals; null from servers older than the summary. */
  summary: {
    totals: {
      downloaded: number;
      failed: number;
      installed: number;
      success: number;
      successRate: number | null;
    };
  } | null;
  to: string;
  totals: TimeseriesPoint[];
  /**
   * What a package hash missing from `series` means: no events in range, or
   * unknown because the list was truncated. Null from older servers.
   */
  unlistedSeries: "no_events" | "unavailable" | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC day starts covering [from, to); `from` is bucket-aligned by contract. */
export function dayBucketStarts(from: string, to: string): string[] {
  const start = Date.parse(from);
  const end = Date.parse(to);
  const buckets: string[] = [];

  for (let time = start; time < end; time += DAY_MS) {
    buckets.push(new Date(time).toISOString());
  }

  return buckets;
}

const ZERO_POINT: Omit<TimeseriesPoint, "bucketStart"> = {
  activeDevices: 0,
  downloaded: 0,
  failed: 0,
  installed: 0,
  success: 0,
};

/** Expands sparse points onto a full bucket axis; a missing bucket is zeros. */
export function zeroFillPoints(
  bucketStarts: string[],
  points: TimeseriesPoint[],
): TimeseriesPoint[] {
  const byBucket = new Map(points.map((point) => [point.bucketStart, point]));

  return bucketStarts.map(
    (bucketStart) => byBucket.get(bucketStart) ?? { ...ZERO_POINT, bucketStart },
  );
}

/** True when `to` cuts the bucket short — render it as provisional. */
export function isPartialBucket(bucketStart: string, to: string): boolean {
  return Date.parse(bucketStart) + DAY_MS > Date.parse(to);
}

/** One x position of a line chart. */
export interface ChartBucket {
  key: string;
  label: string;
  /** Set when the bucket covers only part of its period, saying which part. */
  partialNote?: string;
}

/** The chart buckets for [from, to); the one holding `to` is a partial day. */
export function dayChartBuckets(from: string, to: string): ChartBucket[] {
  return dayBucketStarts(from, to).map((bucketStart) => ({
    key: bucketStart,
    label: new Date(bucketStart).toLocaleDateString("en-US", {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    }),
    ...(isPartialBucket(bucketStart, to) ? { partialNote: "partial day" } : {}),
  }));
}

/**
 * Display name for a series: release label when the hash mapped to a release,
 * a shortened hash for orphaned hashes (e.g. deleted releases), and a fixed
 * name for the null-hash series (devices running the embedded binary).
 */
export function timeseriesSeriesLabel(entry: TimeseriesSeriesEntry): string {
  if (entry.releaseLabel !== null) {
    return entry.releaseLabel;
  }

  if (entry.targetPackageHash !== null) {
    return `${entry.targetPackageHash.slice(0, 8)}…`;
  }

  return "No patch (binary)";
}
