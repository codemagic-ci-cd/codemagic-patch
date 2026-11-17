import type { TimeseriesBucket, TimeseriesSeries } from "./types";

export interface TimeseriesReleaseIdentity {
  createdAt: Date;
  id: string;
  releaseLabel: string;
  targetPackageHash: string | null;
}

export interface AssembleDeploymentTimeseriesInput {
  releases: TimeseriesReleaseIdentity[];
  series: Array<{
    points: TimeseriesBucket[];
    targetPackageHash: string | null;
  }>;
  seriesTruncated: boolean;
  totals: TimeseriesBucket[];
}

export interface AssembledDeploymentTimeseries {
  series: TimeseriesSeries[];
  seriesTruncated: boolean;
  totals: TimeseriesBucket[];
}

/**
 * Attaches release identity to the ranked, repository-bounded hash series.
 *
 * A hash shared by several releases (same bundle re-released) is labeled by
 * its newest release, matching the dashboard's newest-first labeling in
 * `activeVersionDistribution`. Hashes matching no release keep their data
 * with a null identity. Input order is preserved so the repository's
 * in-range volume ranking reaches the wire unchanged.
 */
export function assembleDeploymentTimeseries(
  input: AssembleDeploymentTimeseriesInput,
): AssembledDeploymentTimeseries {
  const newestReleaseByHash = new Map<string, TimeseriesReleaseIdentity>();
  for (const release of input.releases) {
    if (release.targetPackageHash === null) {
      continue;
    }
    const current = newestReleaseByHash.get(release.targetPackageHash);
    if (!current || release.createdAt > current.createdAt) {
      newestReleaseByHash.set(release.targetPackageHash, release);
    }
  }

  const series = input.series.map((entry) => {
    const release =
      entry.targetPackageHash !== null
        ? newestReleaseByHash.get(entry.targetPackageHash)
        : undefined;

    return {
      points: entry.points,
      releaseId: release?.id ?? null,
      releaseLabel: release?.releaseLabel ?? null,
      targetPackageHash: entry.targetPackageHash,
    };
  });

  return {
    series,
    seriesTruncated: input.seriesTruncated,
    totals: input.totals,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DeploymentTimeseriesSummary {
  /**
   * The last UTC day fully inside [from, to) that had ended at request time,
   * with that day's distinct active devices; null when no such day exists.
   */
  lastCompleteDay: { activeDevices: number; bucketStart: Date } | null;
  /**
   * Event counts summed over the deployment-wide `totals` buckets. Active
   * devices are left out: per-day distinct counts do not add up to distinct
   * devices across the range.
   */
  totals: { downloaded: number; failed: number; installed: number; success: number };
}

/** `from` is UTC-day aligned by the route; `now` is the request time. */
export function summarizeDeploymentTimeseries(
  range: { from: Date; to: Date },
  totals: readonly TimeseriesBucket[],
  now: Date,
): DeploymentTimeseriesSummary {
  const summed = { downloaded: 0, failed: 0, installed: 0, success: 0 };
  for (const bucket of totals) {
    summed.downloaded += bucket.downloaded;
    summed.failed += bucket.failed;
    summed.installed += bucket.installed;
    summed.success += bucket.success;
  }

  const end = Math.min(range.to.getTime(), now.getTime());
  const lastStart = end - (end % DAY_MS) - DAY_MS;
  const lastCompleteDay =
    lastStart < range.from.getTime()
      ? null
      : {
          // Sparse buckets: a missing day had no active devices.
          activeDevices:
            totals.find((bucket) => bucket.bucketStart.getTime() === lastStart)
              ?.activeDevices ?? 0,
          bucketStart: new Date(lastStart),
        };

  return { lastCompleteDay, totals: summed };
}

/**
 * Running Applied total of one series per UTC day of [from, to), from 0 at
 * `from` (events before the range are not counted). Null for the null-hash
 * series: its Applied events are reverts to the embedded bundle, not
 * adoption of a release.
 */
export function cumulativeSuccess(
  range: { from: Date; to: Date },
  series: { points: readonly TimeseriesBucket[]; targetPackageHash: string | null },
): number[] | null {
  if (series.targetPackageHash === null) {
    return null;
  }

  const successByDay = new Map(
    series.points.map((point) => [point.bucketStart.getTime(), point.success]),
  );
  const cumulative: number[] = [];
  let running = 0;
  for (let day = range.from.getTime(); day < range.to.getTime(); day += DAY_MS) {
    running += successByDay.get(day) ?? 0;
    cumulative.push(running);
  }

  return cumulative;
}
