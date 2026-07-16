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
