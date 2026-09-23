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

import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  type QueryClient,
} from "@tanstack/react-query";

import { authenticatedRequest } from "../client";
import {
  fromDeploymentTimeseriesWire,
  fromFailureCodesWire,
  fromFailureDistributionWire,
  fromFailureEventsWire,
  fromReleaseMetricsRowWire,
  type DeploymentMetricsWireResponse,
  type DeploymentTimeseriesWireResponse,
  type FailureCodesWireResponse,
  type FailureDistributionWireResponse,
  type FailureEventsWireResponse,
  type ReleaseMetricsWireResponse,
} from "../wire";
import type { FailureEventPage } from "../../model/metrics";

export interface DeploymentMetricsParams {
  limit?: number;
  offset?: number;
}

/** Query keys for the metrics domain, scoped by deployment / release. */
export const metricsKeys = {
  all: ["metrics"] as const,
  deployment: (deploymentId: string, params: DeploymentMetricsParams) =>
    [...metricsKeys.all, "deployment", deploymentId, params] as const,
  failureCodes: (kind: string, id: string, reason: string) =>
    [...metricsKeys.all, kind, id, "failures", reason] as const,
  failureDistribution: (
    kind: string,
    id: string,
    reason: string,
    code: string | null,
  ) =>
    [...metricsKeys.all, kind, id, "failures", reason, "distribution", code] as const,
  failureEvents: (kind: string, id: string, reason: string, code: string | null) =>
    [...metricsKeys.all, kind, id, "failures", reason, "events", code] as const,
  release: (releaseId: string) => [...metricsKeys.all, "release", releaseId] as const,
  timeseries: (deploymentId: string, rangeDays: number | "default" = "default") =>
    [...metricsKeys.all, "timeseries", deploymentId, rangeDays] as const,
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

/**
 * `GET /v1/metrics/deployments/:deploymentId/timeseries` (`release.view`) —
 * day-bucketed adoption series. Omitted `rangeDays` uses the server default
 * (trailing 30 days). Derivation (zero-fill, partial-bucket detection,
 * in-range totals) lives in model/timeseries.ts. `keepPreviousData` holds the
 * last range on screen while a newly selected preset loads.
 */
export function useDeploymentTimeseries(
  deploymentId: string,
  { rangeDays }: { rangeDays?: number } = {},
) {
  return useQuery({
    queryKey: metricsKeys.timeseries(deploymentId, rangeDays ?? "default"),
    queryFn: ({ signal }) =>
      fetchDeploymentTimeseries(deploymentId, rangeDays, signal),
    placeholderData: keepPreviousData,
  });
}

export function prefetchDeploymentTimeseries(
  queryClient: QueryClient,
  deploymentId: string,
  rangeDays: number,
) {
  return queryClient.prefetchQuery({
    queryKey: metricsKeys.timeseries(deploymentId, rangeDays),
    queryFn: ({ signal }) =>
      fetchDeploymentTimeseries(deploymentId, rangeDays, signal),
  });
}

function fetchDeploymentTimeseries(
  deploymentId: string,
  rangeDays: number | undefined,
  signal?: AbortSignal,
) {
  const params: Record<string, string | number | undefined> = {};
  if (rangeDays !== undefined) {
    const to = new Date();
    params.from = new Date(
      to.getTime() - rangeDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    params.to = to.toISOString();
  }
  return authenticatedRequest<DeploymentTimeseriesWireResponse>({
    method: "GET",
    path: `/metrics/deployments/${encodeURIComponent(deploymentId)}/timeseries${searchString(
      params,
    )}`,
    signal,
  }).then(fromDeploymentTimeseriesWire);
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

/** Raw events per keyset page; the deep list, so it pages in smaller bites. */
const FAILURE_EVENT_PAGE_SIZE = 25;

/** Which resource a failure drill-down is scoped to. */
export interface FailureScope {
  id: string;
  kind: "deployment" | "release";
}

/**
 * `GET /v1/metrics/{deployments|releases}/:id/failures?reason`
 * (`release.view`) — every `payload.code` under one reason, highest count
 * first.
 *
 * A plain query, not an infinite one. The code value space is the enumerable
 * set of HTTP statuses plus two sentinels (PROTOCOL.md §Metric Event `Failed`
 * Payload), so the list is bounded by the contract rather than by the data —
 * the same reason the counters return their reason breakdown whole. Disabled
 * until a reason is opened, so a visit that never drills in costs nothing.
 */
export function useFailureCodes(scope: FailureScope, reason: string | null) {
  const base = scope.kind === "deployment" ? "deployments" : "releases";

  return useQuery({
    enabled: reason !== null,
    queryKey: metricsKeys.failureCodes(scope.kind, scope.id, reason ?? ""),
    queryFn: ({ signal }) =>
      authenticatedRequest<FailureCodesWireResponse>({
        method: "GET",
        path: `/metrics/${base}/${encodeURIComponent(scope.id)}/failures${searchString(
          { reason: reason ?? "" },
        )}`,
        signal,
      }).then(fromFailureCodesWire),
  });
}

/**
 * `GET /v1/metrics/{deployments|releases}/:id/failures/distribution`
 * (`release.view`) — one code bucket's top `message` and
 * `android_previous_process_exit` values, plus the bucket total.
 *
 * A plain query, not an infinite one: the server caps each list to a handful
 * of bars and the reader never pages a chart. It aggregates the whole bucket
 * rather than the events already loaded below it, so opening it costs one
 * scan of the bucket and the bars do not move as the feed scrolls.
 *
 * `code: null` is the bucket of failures whose payload carried none. It rides
 * as an omitted parameter rather than a sentinel value: these endpoints never
 * address every code at once, so there is nothing for an absent `code` to be
 * confused with.
 */
export function useFailureDistribution(
  scope: FailureScope,
  reason: string,
  code: string | null,
) {
  const base = scope.kind === "deployment" ? "deployments" : "releases";

  return useQuery({
    queryKey: metricsKeys.failureDistribution(
      scope.kind,
      scope.id,
      reason,
      code,
    ),
    queryFn: ({ signal }) =>
      authenticatedRequest<FailureDistributionWireResponse>({
        method: "GET",
        path: `/metrics/${base}/${encodeURIComponent(scope.id)}/failures/distribution${searchString(
          { code: code ?? undefined, reason },
        )}`,
        signal,
      }).then(fromFailureDistributionWire),
  });
}

/**
 * `GET /v1/metrics/{deployments|releases}/:id/failures/events`
 * (`release.view`) — one code bucket's raw events, newest first.
 *
 * Keyset-paged rather than offset-paged. `metric_event` is written
 * continuously, so an offset shifts under the reader between requests: events
 * arriving mid-scroll would push rows across page boundaries and the feed
 * would repeat or skip them. The cursor encodes `(emitted_at, id)`, which
 * pins a boundary to a row instead of to a position.
 *
 * `code: null` travels as an omitted parameter, as in `useFailureDistribution`.
 */
export function useFailureEvents(
  scope: FailureScope,
  reason: string,
  code: string | null,
) {
  const base = scope.kind === "deployment" ? "deployments" : "releases";

  return useInfiniteQuery({
    queryKey: metricsKeys.failureEvents(scope.kind, scope.id, reason, code),
    queryFn: ({ pageParam, signal }) =>
      authenticatedRequest<FailureEventsWireResponse>({
        method: "GET",
        path: `/metrics/${base}/${encodeURIComponent(scope.id)}/failures/events${searchString(
          {
            code: code ?? undefined,
            cursor: pageParam ?? undefined,
            limit: FAILURE_EVENT_PAGE_SIZE,
            reason,
          },
        )}`,
        signal,
      }).then(fromFailureEventsWire),
    initialPageParam: null as string | null,
    getNextPageParam: nextEventCursor,
  });
}

/** The server's own cursor, or undefined once it stops issuing one. */
function nextEventCursor(lastPage: FailureEventPage): string | undefined {
  return lastPage.nextCursor ?? undefined;
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
