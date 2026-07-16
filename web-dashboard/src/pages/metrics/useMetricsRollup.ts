import { useMemo } from "react";

import { useDeploymentMetrics } from "../../api/hooks/metrics";
import {
  aggregateMetrics,
  successRate,
  type ReleaseMetrics,
} from "../../model/metrics";

export interface MetricsRollup {
  totals: ReleaseMetrics;
  rate: number | null;
}

function rollupFromReleases(
  releases: ReadonlyArray<{ metrics: ReleaseMetrics }>,
): MetricsRollup | null {
  if (releases.length === 0) {
    return null;
  }
  const totals = aggregateMetrics(releases.map((entry) => entry.metrics));
  return { totals, rate: successRate(totals) };
}

/** Aggregated counters for one deployment (`limit: 100`). */
export function useDeploymentMetricsRollup(deploymentId: string) {
  const query = useDeploymentMetrics(deploymentId, { limit: 100 });
  const rollup = useMemo(
    () =>
      query.data === undefined
        ? undefined
        : rollupFromReleases(query.data.releases),
    [query.data],
  );

  return { query, rollup };
}
