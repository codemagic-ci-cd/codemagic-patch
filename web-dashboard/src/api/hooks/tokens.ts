// TanStack Query bindings for the per-user API token endpoints.
// Conventions as established in teams.ts. Tokens live under the
// account (not a team), so keys carry no team scope. Create returns its
// multi-field envelope `{ apiToken, token }` as-is: `token` is the show-once
// plaintext secret, surfaced verbatim as mutation data for the
// non-dismissible secret modal and never cached in a query — the list only
// ever exposes `maskedPrefix`.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { authenticatedRequest } from "../client";
import type { ApiTokenCreateBody } from "../types";
import {
  fromApiTokenCreateWireResponse,
  fromApiTokenWire,
  type ApiTokenCreateWireResponse,
  type ApiTokensListWireResponse,
} from "../wire";

/** Query keys for the API-token domain (per-user — no team scope). */
export const apiTokenKeys = {
  all: ["api-tokens"] as const,
  list: () => [...apiTokenKeys.all, "list"] as const,
};

/** `GET /v1/auth/tokens` (user-backed) — masked prefixes only. */
export function useApiTokens() {
  return useQuery({
    queryKey: apiTokenKeys.list(),
    queryFn: async ({ signal }) => {
      const { api_tokens: apiTokens } =
        await authenticatedRequest<ApiTokensListWireResponse>({
        method: "GET",
        path: "/auth/tokens",
        signal,
      });
      return apiTokens.map(fromApiTokenWire);
    },
  });
}

/**
 * `POST /v1/auth/tokens { display_name, expires_in_days? }` → 201
 * `{ apiToken, token }`. `expires_in_days` 1–3650; omit for a non-expiring
 * token.
 */
export function useCreateApiToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ApiTokenCreateBody) =>
      authenticatedRequest<ApiTokenCreateWireResponse>({
        method: "POST",
        path: "/auth/tokens",
        body,
      }).then(fromApiTokenCreateWireResponse),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: apiTokenKeys.list() });
    },
  });
}

/** `DELETE /v1/auth/tokens/:tokenId` → 204; 404 propagates. */
export function useRevokeApiToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (tokenId: string) =>
      authenticatedRequest<void>({
        method: "DELETE",
        path: `/auth/tokens/${encodeURIComponent(tokenId)}`,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: apiTokenKeys.list() });
    },
  });
}
