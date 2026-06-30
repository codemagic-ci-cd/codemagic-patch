// TanStack Query bindings for the apps endpoints.
// Conventions as established in teams.ts. Request bodies keep the server's
// snake_case wire casing (`team_id`, `require_code_signing`) — see api/types.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { authenticatedRequest, createIdempotencyKey } from "../client";
import type {
  AppCreateBody,
  AppTransferBody,
  AppUpdateBody,
} from "../types";
import {
  fromAppWire,
  fromAppWithDeploymentsWireResponse,
  type AppWithDeploymentsWireResponse,
  type AppWireResponse,
  type AppsListWireResponse,
} from "../wire";
import { deploymentKeys } from "./deployments";

/** Query keys for the apps domain, scoped by team (lists) and app id (details). */
export const appKeys = {
  all: ["apps"] as const,
  list: (teamId: string) => [...appKeys.all, "list", teamId] as const,
  detail: (appId: string) => [...appKeys.all, "detail", appId] as const,
};

/** `GET /v1/teams/:teamId/apps` (`app.read`). */
export function useApps(teamId: string) {
  return useQuery({
    queryKey: appKeys.list(teamId),
    queryFn: async ({ signal }) => {
      const { apps } = await authenticatedRequest<AppsListWireResponse>({
        method: "GET",
        path: `/teams/${encodeURIComponent(teamId)}/apps`,
        signal,
      });
      return apps.map(fromAppWire);
    },
  });
}

/** `GET /v1/apps/:appId` (`app.read`). */
export function useApp(appId: string) {
  return useQuery({
    queryKey: appKeys.detail(appId),
    queryFn: async ({ signal }) => {
      const { app } = await authenticatedRequest<AppWireResponse>({
        method: "GET",
        path: `/apps/${encodeURIComponent(appId)}`,
        signal,
      });
      return fromAppWire(app);
    },
  });
}

/**
 * `POST /v1/apps` (`app.create`) — returns the full envelope because the
 * UI surfaces the auto-created Staging + Production deployments alongside
 * the app. 409 `app-conflict` propagates for inline display.
 */
export function useCreateApp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: AppCreateBody) =>
      authenticatedRequest<AppWithDeploymentsWireResponse>({
        method: "POST",
        path: "/apps",
        body,
        idempotencyKey: createIdempotencyKey(),
      }).then(fromAppWithDeploymentsWireResponse),
    onSuccess: async ({ app }) => {
      await queryClient.invalidateQueries({
        queryKey: appKeys.list(app.teamId),
      });
    },
  });
}

export interface AppUpdateVariables {
  appId: string;
  /** At least one of `name` / `require_code_signing`. */
  body: AppUpdateBody;
}

/**
 * `PATCH /v1/apps/:appId` (`app.manage`) — plain rename/settings patch.
 * The optimistic code-signing toggle is layered on top by the UI;
 * this hook only invalidates on success.
 */
export function useUpdateApp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ appId, body }: AppUpdateVariables) => {
      const { app } = await authenticatedRequest<AppWireResponse>({
        method: "PATCH",
        path: `/apps/${encodeURIComponent(appId)}`,
        body,
      });
      return fromAppWire(app);
    },
    onSuccess: async (app) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: appKeys.detail(app.id) }),
        queryClient.invalidateQueries({ queryKey: appKeys.list(app.teamId) }),
      ]);
    },
  });
}

export interface AppDeleteVariables {
  appId: string;
  /** Needed for list invalidation — `DELETE` returns 204 with no body. */
  teamId: string;
}

/** `DELETE /v1/apps/:appId` (`app.manage`) — 409 `active-release-job` propagates. */
export function useDeleteApp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ appId }: AppDeleteVariables) =>
      authenticatedRequest<void>({
        method: "DELETE",
        path: `/apps/${encodeURIComponent(appId)}`,
      }),
    onSuccess: async (_data, { appId, teamId }) => {
      // The app is gone: drop its cached detail + deployment list instead of
      // invalidating them (a refetch would just 404), then refresh the team list.
      queryClient.removeQueries({ queryKey: appKeys.detail(appId) });
      queryClient.removeQueries({ queryKey: deploymentKeys.list(appId) });
      await queryClient.invalidateQueries({ queryKey: appKeys.list(teamId) });
    },
  });
}

export interface AppTransferVariables {
  appId: string;
  /** Destination team as `{ team_id }`; same-team transfer is a server 400. */
  body: AppTransferBody;
}

/**
 * `POST /v1/apps/:appId/transfer` (`app.manage` + destination
 * `app.create`) — the server REQUIRES the Idempotency-Key on this endpoint.
 */
export function useTransferApp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ appId, body }: AppTransferVariables) =>
      authenticatedRequest<AppWithDeploymentsWireResponse>({
        method: "POST",
        path: `/apps/${encodeURIComponent(appId)}/transfer`,
        body,
        idempotencyKey: createIdempotencyKey(),
      }).then(fromAppWithDeploymentsWireResponse),
    onSuccess: async ({ app }) => {
      // The app left the source team's list and joined the destination's,
      // and its deployments carry the new teamId. The source team id is not
      // in the response, so invalidate the whole apps domain.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: appKeys.all }),
        queryClient.invalidateQueries({ queryKey: deploymentKeys.list(app.id) }),
      ]);
    },
  });
}
