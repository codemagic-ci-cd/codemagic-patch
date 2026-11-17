// TanStack Query bindings for the per-user API token endpoints.
// Conventions as established in teams.ts. Tokens live under the
// account (not a team), so keys carry no team scope. Create returns its
// multi-field envelope `{ apiToken, token }` as-is: `token` is the show-once
// plaintext secret, surfaced verbatim as mutation data for the
// non-dismissible secret modal and never cached in a query — the list only
// ever exposes `maskedPrefix`.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { clearSession } from "../../auth/credentialStore";
import { authenticatedRequest } from "../client";
import { HttpProblemError } from "../problem";
import type { ApiTokenCreateBody } from "../types";
import {
  fromApiTokenCreateWireResponse,
  fromApiTokenWire,
  type ApiTokenCreateWireResponse,
  type ApiTokensListWireResponse,
  type RevokeAllCredentialsWireResponse,
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

/**
 * `POST /v1/auth/credentials/revoke-all` → 200 with the revoked counts. Ends
 * every session (this one included) and deletes every API token of the
 * signed-in user, so success clears the stored session. A 401 means this
 * sign-in had ended before the request could be made: the client's refresh
 * was refused, or the session was revoked elsewhere (possibly by an earlier
 * revoke-all whose response was lost). The client has already cleared the
 * session by then, and nothing says revoke-all ran, so callers send the user
 * to sign in again without claiming the account-wide revocation happened.
 */
export function useRevokeAllCredentials(callbacks: {
  /** A confirmed response. The session is cleared; the route guard takes over. */
  onRevoked: () => void;
  /** A 401: the sign-in had ended before the request; nothing is known to have been revoked. */
  onSessionEnded: () => void;
}) {
  return useMutation({
    mutationFn: () =>
      authenticatedRequest<RevokeAllCredentialsWireResponse>({
        method: "POST",
        path: "/auth/credentials/revoke-all",
      }).then((response) => ({
        revokedApiTokenCount: response.revoked_api_token_count,
        revokedSessionCount: response.revoked_session_count,
      })),
    // These run even after the calling page has unmounted, which clearing
    // the session causes through the route guard; callbacks passed to
    // `mutate()` would not.
    onSuccess: () => {
      clearSession();
      callbacks.onRevoked();
    },
    onError: (error) => {
      if (isSessionEnded(error)) {
        callbacks.onSessionEnded();
      }
    },
  });
}

/** The request was refused because this sign-in had already ended. */
export function isSessionEnded(error: unknown): boolean {
  return error instanceof HttpProblemError && error.status === 401;
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
