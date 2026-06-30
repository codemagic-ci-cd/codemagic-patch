// TanStack Query bindings for the dedicated metrics read endpoints.
// Conventions as established in teams.ts: the deployment envelope
// (`{ releases, pagination }`) is multi-field and returned as-is; the release
// envelope (`{ release }`) unwraps to its `ReleaseMetricsEntry`. Counters are
// hash-keyed server-side (releases sharing a target_package_hash report
// identical counts); derivation helpers (successRate, aggregation, active-
// version distribution) live in model/metrics.ts — these hooks only fetch.
// The deployment query is also what the DeploymentTable's lazy metric cells
// call with `limit: 1`: a cell failure propagates as
// HttpProblemError so the cell renders "—" + retry without failing the table.

import { useQuery } from "@tanstack/react-query";

import { authenticatedRequest } from "../client";
import {
  fromReleaseMetricsRowWire,
  type DeploymentMetricsWireResponse,
  type ReleaseMetricsWireResponse,
} from "../wire";

export interface DeploymentMetricsParams {
  limit?: number;
  offset?: number;
}

/** Query keys for the metrics domain, scoped by deployment / release. */
export const metricsKeys = {
  all: ["metrics"] as const,
  deployment: (deploymentId: string, params: DeploymentMetricsParams) =>
    [...metricsKeys.all, "deployment", deploymentId, params] as const,
  release: (releaseId: string) => [...metricsKeys.all, "release", releaseId] as const,
};

/**
 * `GET /v1/metrics/deployments/:deploymentId?limit&offset`
 * (`release.view`) → `{ releases: [per-release counters], pagination }`.
 * Omitted params are not sent (server defaults apply).
 */
export function useDeploymentMetrics(
  deploymentId: string,
  { limit, offset }: DeploymentMetricsParams = {},
) {
  return useQuery({
    queryKey: metricsKeys.deployment(deploymentId, { limit, offset }),
    queryFn: ({ signal }) =>
      authenticatedRequest<DeploymentMetricsWireResponse>({
        method: "GET",
        path: `/metrics/deployments/${encodeURIComponent(deploymentId)}${searchString(
          { limit, offset },
        )}`,
        signal,
      }).then((response) => ({
        pagination: response.pagination,
        releases: response.releases.map(fromReleaseMetricsRowWire),
      })),
  });
}

/** `GET /v1/metrics/releases/:releaseId` (`release.view`) — unwraps to the release's counter entry. */
export function useReleaseMetrics(releaseId: string) {
  return useQuery({
    queryKey: metricsKeys.release(releaseId),
    queryFn: async ({ signal }) => {
      const { release } = await authenticatedRequest<ReleaseMetricsWireResponse>({
        method: "GET",
        path: `/metrics/releases/${encodeURIComponent(releaseId)}`,
        signal,
      });
      return fromReleaseMetricsRowWire(release);
    },
  });
}

/** Serializes defined params only; returns "" when nothing is set. */
function searchString(
  params: Record<string, string | number | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }
  const text = search.toString();
  return text.length === 0 ? "" : `?${text}`;
}
