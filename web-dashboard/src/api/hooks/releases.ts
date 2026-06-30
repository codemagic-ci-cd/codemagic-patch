// TanStack Query bindings for the release lifecycle endpoints.
// Conventions as established in teams.ts. Release envelopes carry more
// than one meaningful field (`{ release, job }`, `{ releases, pagination }`),
// so they are returned as-is per that convention — job-terminal logic lives
// in model/release.ts.
// List design: `useInfiniteQuery` over offset pages — the offset IS the
// pageParam, so the "Load more" table calls fetchNextPage()
// and invalidation refetches every loaded page in order.
// Lifecycle mutations are NOT optimistic (the worker job is asynchronous —
// the UI reconciles via refetch/poll, optimistic vs async); they
// invalidate the affected deployment's list + the release detail key.

import {
  artifactToReleaseForm,
  type Artifact,
  type UploadPolicy,
} from "@codemagic/patch-shared";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";

import { isTerminalJobStatus } from "../../model/release";
import {
  authenticatedMultipartRequest,
  authenticatedRequest,
  createIdempotencyKey,
} from "../client";
import type {
  DeploymentRollbackBody,
  ReleasePatchBody,
  ReleasePromoteBody,
  ReleasesListResponse,
  ReleasePatchResponse,
} from "../types";
import {
  fromReleaseLifecycleWireResponse,
  fromReleasePatchWireResponse,
  fromReleaseReadWireResponse,
  fromReleasesListWireResponse,
  type ReleaseLifecycleWireResponse,
  type ReleasePatchWireResponse,
  type ReleaseReadWireResponse,
  type ReleasesListWireResponse,
} from "../wire";

/** Server default page size (`limit` accepts 1–100). */
export const RELEASE_LIST_PAGE_SIZE = 50;
/** Job-panel poll cadence (a few seconds). */
export const RELEASE_POLL_INTERVAL_MS = 3_000;

export interface ReleaseListParams {
  includeMetrics: boolean;
  limit: number;
}

/** Query keys for the releases domain, lists scoped by owning deployment. */
export const releaseKeys = {
  all: ["releases"] as const,
  /** Prefix over every deployment's history — fallback invalidation target. */
  lists: () => [...releaseKeys.all, "list"] as const,
  /** Prefix over every page-size/include variant of one deployment's history. */
  deploymentList: (deploymentId: string) =>
    [...releaseKeys.lists(), deploymentId] as const,
  list: (deploymentId: string, params: ReleaseListParams) =>
    [...releaseKeys.deploymentList(deploymentId), params] as const,
  detail: (releaseId: string) => [...releaseKeys.all, "detail", releaseId] as const,
};

export interface UseReleasesOptions {
  /** Page size, 1–100 (server default 50). */
  limit?: number;
  /** Append `include=metrics` so rows carry counters (default true — the history table needs them). */
  includeMetrics?: boolean;
}

/**
 * `GET /v1/deployments/:deploymentId/releases?include=metrics&limit&offset`
 * (`release.view`) → pages of `{ releases: [{ release, job, metrics? }],
 * pagination }`.
 *
 * Infinite query: `offset` is managed internally as the pageParam (starts at
 * 0, advances by the rows actually received); render `data.pages` flattened
 * and wire "Load more" to `fetchNextPage()`/`hasNextPage`.
 */
export function useReleases(
  deploymentId: string,
  { limit = RELEASE_LIST_PAGE_SIZE, includeMetrics = true }: UseReleasesOptions = {},
) {
  return useInfiniteQuery({
    queryKey: releaseKeys.list(deploymentId, { includeMetrics, limit }),
    queryFn: ({ pageParam, signal }) =>
      authenticatedRequest<ReleasesListWireResponse>({
        method: "GET",
        path: `/deployments/${encodeURIComponent(deploymentId)}/releases${searchString(
          {
            include: includeMetrics ? "metrics" : undefined,
            limit,
            offset: pageParam,
          },
        )}`,
        signal,
      }).then(fromReleasesListWireResponse),
    initialPageParam: 0,
    getNextPageParam: nextOffset,
  });
}

/** Next offset = rows loaded so far; undefined (no further page) once `total` is reached. */
function nextOffset(lastPage: ReleasesListResponse): number | undefined {
  const loaded = lastPage.pagination.offset + lastPage.releases.length;
  return lastPage.releases.length > 0 && loaded < lastPage.pagination.total
    ? loaded
    : undefined;
}

export interface UseReleaseOptions {
  /**
   * Auto-poll (~3s) until the worker job is terminal — `succeeded`, `failed`,
   * and `dead_letter` ARE terminal (model/release.ts), so polling always
   * stops; a job-less release stops immediately.
   */
  poll?: boolean;
}

/** `GET /v1/releases/:releaseId` (`release.view`) → `{ release, job }`. */
export function useRelease(
  releaseId: string,
  { poll = false }: UseReleaseOptions = {},
) {
  return useQuery({
    queryKey: releaseKeys.detail(releaseId),
    queryFn: ({ signal }) =>
      authenticatedRequest<ReleaseReadWireResponse>({
        method: "GET",
        path: `/releases/${encodeURIComponent(releaseId)}`,
        signal,
      }).then(fromReleaseReadWireResponse),
    refetchInterval: poll
      ? (query) => {
          const data = query.state.data;
          if (data === undefined) {
            return RELEASE_POLL_INTERVAL_MS;
          }
          if (data.job === null || isTerminalJobStatus(data.job.status)) {
            return false;
          }
          return RELEASE_POLL_INTERVAL_MS;
        }
      : false,
  });
}

/** Metadata patch — `status` is excluded at the type level (the status action owns it). */
export type ReleaseMetadataPatch = Omit<ReleasePatchBody, "status">;

export interface PatchReleaseMetadataVariables {
  releaseId: string;
  body: ReleaseMetadataPatch;
}

/**
 * `PATCH /v1/releases/:releaseId` with metadata fields only
 * (`release.deploy`: `rollout_percentage` increase-only / `is_mandatory` /
 * `release_notes` / `target_binary_version` — never combined with `status`).
 * Resolves `undefined` when the server answers 204 (empty/no-op patch).
 */
export function usePatchReleaseMetadata() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ releaseId, body }: PatchReleaseMetadataVariables) =>
      authenticatedRequest<ReleasePatchWireResponse | undefined>({
        method: "PATCH",
        path: `/releases/${encodeURIComponent(releaseId)}`,
        body: body satisfies ReleasePatchBody,
      }).then((response) =>
        response === undefined ? undefined : fromReleasePatchWireResponse(response),
      ),
    onSuccess: (data, { releaseId }) =>
      invalidatePatchedRelease(queryClient, releaseId, data),
  });
}

export interface PatchReleaseStatusVariables {
  releaseId: string;
  /** Sent ALONE — combining it with edits → 400 `status-transition-conflict`. */
  status: "disabled" | "published";
}

/** `PATCH /v1/releases/:releaseId { status }` — the dedicated disable/enable action (`release.deploy`). */
export function usePatchReleaseStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ releaseId, status }: PatchReleaseStatusVariables) =>
      authenticatedRequest<ReleasePatchWireResponse | undefined>({
        method: "PATCH",
        path: `/releases/${encodeURIComponent(releaseId)}`,
        body: { status } satisfies ReleasePatchBody,
      }).then((response) =>
        response === undefined ? undefined : fromReleasePatchWireResponse(response),
      ),
    onSuccess: (data, { releaseId }) =>
      invalidatePatchedRelease(queryClient, releaseId, data),
  });
}

export interface CreateReleaseFromArtifactVariables {
  deploymentId: string;
  /** Parsed `.cmpatch` (descriptor + verbatim bundle + optional sourcemap). */
  artifact: Artifact;
  /** Upload policy, seeded from the artifact's defaults and edited in the form. */
  policy: UploadPolicy;
}

/**
 * `POST /v1/deployments/:deploymentId/releases` as multipart (`release.deploy`),
 * uploading a parsed `.cmpatch` artifact: the bundle (and any signature) go up
 * verbatim via {@link artifactToReleaseForm} — the same body the CLI sends, so
 * the server/worker pipeline is untouched. Returns 201 `{ release, job }`.
 */
export function useCreateReleaseFromArtifact() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      deploymentId,
      artifact,
      policy,
    }: CreateReleaseFromArtifactVariables) =>
      authenticatedMultipartRequest<ReleaseLifecycleWireResponse>({
        method: "POST",
        path: `/deployments/${encodeURIComponent(deploymentId)}/releases`,
        body: artifactToReleaseForm(artifact, policy),
        idempotencyKey: createIdempotencyKey(),
      }).then(fromReleaseLifecycleWireResponse),
    onSuccess: async (_data, { deploymentId }) => {
      await queryClient.invalidateQueries({
        queryKey: releaseKeys.deploymentList(deploymentId),
      });
    },
  });
}

export interface PromoteReleaseVariables {
  releaseId: string;
  /**
   * Must carry `destination_deployment_id`; after a 409 `duplicate-release`
   * the UI resubmits the same body plus `no_duplicate_release_error: true`
   * (Promote anyway).
   */
  body: ReleasePromoteBody;
}

/**
 * `POST /v1/releases/:releaseId/promote` (`release.view` on source +
 * `release.deploy` on destination) → 201 `{ release, job, warnings? }`.
 */
export function usePromoteRelease() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ releaseId, body }: PromoteReleaseVariables) =>
      authenticatedRequest<ReleaseLifecycleWireResponse>({
        method: "POST",
        path: `/releases/${encodeURIComponent(releaseId)}/promote`,
        body,
        idempotencyKey: createIdempotencyKey(),
      }).then(fromReleaseLifecycleWireResponse),
    onSuccess: async (_data, { body }) => {
      // The new release lands in the DESTINATION deployment's history.
      await queryClient.invalidateQueries({
        queryKey: releaseKeys.deploymentList(body.destination_deployment_id),
      });
    },
  });
}

export interface RollbackDeploymentVariables {
  deploymentId: string;
  /** Omit to target the release immediately before the latest. */
  targetReleaseLabel?: string;
}

/** `POST /v1/deployments/:deploymentId/rollback` (`release.deploy`) → 201 `{ release, job }`. */
export function useRollbackDeployment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ deploymentId, targetReleaseLabel }: RollbackDeploymentVariables) => {
      const body: DeploymentRollbackBody =
        targetReleaseLabel === undefined
          ? {}
          : { target_release_label: targetReleaseLabel };
      return authenticatedRequest<ReleaseLifecycleWireResponse>({
        method: "POST",
        path: `/deployments/${encodeURIComponent(deploymentId)}/rollback`,
        body,
        idempotencyKey: createIdempotencyKey(),
      }).then(fromReleaseLifecycleWireResponse);
    },
    onSuccess: async (_data, { deploymentId }) => {
      await queryClient.invalidateQueries({
        queryKey: releaseKeys.deploymentList(deploymentId),
      });
    },
  });
}

/**
 * Shared PATCH invalidation: the detail key always; the list scoped to the
 * release's deployment when the response body is present, falling back to
 * every release list on a 204 (no body → deployment unknown from variables).
 */
function invalidatePatchedRelease(
  queryClient: QueryClient,
  releaseId: string,
  data: ReleasePatchResponse | undefined,
): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({
      queryKey:
        data !== undefined
          ? releaseKeys.deploymentList(data.release.deploymentId)
          : releaseKeys.lists(),
    }),
    queryClient.invalidateQueries({ queryKey: releaseKeys.detail(releaseId) }),
  ]);
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
