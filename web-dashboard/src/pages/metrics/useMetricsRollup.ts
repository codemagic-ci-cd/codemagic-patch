import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";

import { authenticatedRequest } from "../../api/client";
import { useDeployments } from "../../api/hooks/deployments";
import {
  metricsKeys,
  useDeploymentMetrics,
} from "../../api/hooks/metrics";
import {
  fromReleaseMetricsRowWire,
  type DeploymentMetricsWireResponse,
} from "../../api/wire";
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

/** Aggregated counters across every deployment in an app. */
export function useAppMetricsRollup(appId: string) {
  const deploymentsQuery = useDeployments(appId);
  const deploymentIds = deploymentsQuery.data?.map((entry) => entry.id) ?? [];

  const metricsQueries = useQueries({
    queries: deploymentIds.map((deploymentId) => ({
      queryKey: metricsKeys.deployment(deploymentId, { limit: 100 }),
      queryFn: async ({ signal }: { signal: AbortSignal }) =>
        authenticatedRequest<DeploymentMetricsWireResponse>({
          method: "GET",
          path: `/metrics/deployments/${encodeURIComponent(deploymentId)}?limit=100`,
          signal,
        }).then((response) => ({
          pagination: response.pagination,
          releases: response.releases.map(fromReleaseMetricsRowWire),
        })),
      enabled: deploymentsQuery.isSuccess,
    })),
  });

  const isPending =
    deploymentsQuery.isPending ||
    (deploymentIds.length > 0 && metricsQueries.some((entry) => entry.isPending));
  const isError =
    deploymentsQuery.isError || metricsQueries.some((entry) => entry.isError);
  const error =
    deploymentsQuery.error ??
    metricsQueries.find((entry) => entry.error !== null)?.error;

  const rollup = useMemo(() => {
    if (!deploymentsQuery.isSuccess) {
      return undefined;
    }
    if (deploymentIds.length === 0) {
      return null;
    }
    if (metricsQueries.some((entry) => entry.data === undefined)) {
      return undefined;
    }
    const releases = metricsQueries.flatMap(
      (entry) => entry.data?.releases ?? [],
    );
    return rollupFromReleases(releases);
  }, [deploymentIds.length, deploymentsQuery.isSuccess, metricsQueries]);

  const refetch = async () => {
    await Promise.all([
      deploymentsQuery.refetch(),
      ...metricsQueries.map((entry) => entry.refetch()),
    ]);
  };

  return {
    deploymentsQuery,
    metricsQueries,
    rollup,
    isPending,
    isError,
    error,
    refetch,
  };
}
