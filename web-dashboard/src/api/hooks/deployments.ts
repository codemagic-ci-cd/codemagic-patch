// TanStack Query bindings for the deployment endpoints.
// Note: there is NO `GET /v1/deployments/:id` — deployment detail
// views read their record from `useDeployments(appId)`, so the key factory
// has no `detail` entry. Conventions as established in teams.ts.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { authenticatedRequest, createIdempotencyKey } from "../client";
import type {
  DeploymentCreateBody,
  DeploymentUpdateBody,
} from "../types";
import {
  fromDeploymentClearWireResponse,
  fromDeploymentWire,
  type DeploymentClearWireResponse,
  type DeploymentWireResponse,
  type DeploymentsListWireResponse,
} from "../wire";

/** Query keys for the deployments domain, scoped by owning app. */
export const deploymentKeys = {
  all: ["deployments"] as const,
  list: (appId: string) => [...deploymentKeys.all, "list", appId] as const,
};

/**
 * `GET /v1/apps/:appId/deployments` (`app.read`) — includes each
 * `deploymentKey` (SDK config value, not a secret). Detail views select
 * their deployment from this list (no single-deployment GET exists).
 */
export function useDeployments(appId: string) {
  return useQuery({
    queryKey: deploymentKeys.list(appId),
    queryFn: async ({ signal }) => {
      const { deployments } = await authenticatedRequest<DeploymentsListWireResponse>({
        method: "GET",
        path: `/apps/${encodeURIComponent(appId)}/deployments`,
        signal,
      });
      return deployments.map(fromDeploymentWire);
    },
  });
}

export interface DeploymentCreateVariables {
  appId: string;
  body: DeploymentCreateBody;
}

/**
 * `POST /v1/apps/:appId/deployments` (`app.create`) — the returned
 * `deploymentKey` is revealed prominently after creation. 409
 * `deployment-conflict` propagates for inline display.
 */
export function useCreateDeployment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ appId, body }: DeploymentCreateVariables) => {
      const { deployment } = await authenticatedRequest<DeploymentWireResponse>({
        method: "POST",
        path: `/apps/${encodeURIComponent(appId)}/deployments`,
        body,
        idempotencyKey: createIdempotencyKey(),
      });
      return fromDeploymentWire(deployment);
    },
    onSuccess: async (deployment) => {
      await queryClient.invalidateQueries({
        queryKey: deploymentKeys.list(deployment.appId),
      });
    },
  });
}

export interface DeploymentRenameVariables {
  deploymentId: string;
  body: DeploymentUpdateBody;
}

/** `PATCH /v1/deployments/:deploymentId` (`app.manage`) — rename. */
export function useRenameDeployment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ deploymentId, body }: DeploymentRenameVariables) => {
      const { deployment } = await authenticatedRequest<DeploymentWireResponse>({
        method: "PATCH",
        path: `/deployments/${encodeURIComponent(deploymentId)}`,
        body,
      });
      return fromDeploymentWire(deployment);
    },
    onSuccess: async (deployment) => {
      await queryClient.invalidateQueries({
        queryKey: deploymentKeys.list(deployment.appId),
      });
    },
  });
}

export interface DeploymentDeleteVariables {
  deploymentId: string;
  /** Needed for list invalidation — `DELETE` returns 204 with no body. */
  appId: string;
}

/** `DELETE /v1/deployments/:deploymentId` (`app.manage`) — 409 `active-release-job` propagates. */
export function useDeleteDeployment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ deploymentId }: DeploymentDeleteVariables) =>
      authenticatedRequest<void>({
        method: "DELETE",
        path: `/deployments/${encodeURIComponent(deploymentId)}`,
      }),
    onSuccess: async (_data, { appId }) => {
      await queryClient.invalidateQueries({
        queryKey: deploymentKeys.list(appId),
      });
    },
  });
}

export interface DeploymentClearVariables {
  deploymentId: string;
}

/**
 * `POST /v1/deployments/:deploymentId/clear` (`release.deploy`) — NO
 * Idempotency-Key on this endpoint. Returns the envelope: both
 * `deletedReleaseCount` and `deployment` feed the confirmation UI. The
 * deployment's release-history/metrics caches belong to the deployment key space
 * (hooks/releases.ts, hooks/metrics.ts); callers invalidate those alongside.
 */
export function useClearDeployment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ deploymentId }: DeploymentClearVariables) =>
      authenticatedRequest<DeploymentClearWireResponse>({
        method: "POST",
        path: `/deployments/${encodeURIComponent(deploymentId)}/clear`,
      }).then(fromDeploymentClearWireResponse),
    onSuccess: async ({ deployment }) => {
      await queryClient.invalidateQueries({
        queryKey: deploymentKeys.list(deployment.appId),
      });
    },
  });
}
