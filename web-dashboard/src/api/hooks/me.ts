// TanStack Query binding for the identity (whoami) endpoint.
// Hooks layer: pages consume hooks only — transport, silent refresh, and
// problem parsing live in api/client.ts; HttpProblemError propagates untouched
// (the UI classifies it later via classifyProblem).

import { useQuery } from "@tanstack/react-query";

import { authenticatedRequest } from "../client";
import { fromUserWire, type MeWireResponse } from "../wire";

/** Query keys for the current-user identity. */
export const meKeys = {
  all: ["me"] as const,
};

/**
 * Identity-level provider the local evaluation stack's fake identity provider
 * records on every account (server: localDevAuthAdapters.LOCAL_DEV_PROVIDER) —
 * the audit-trail contract dashboard-local-login-smoke.sh asserts.
 */
const LOCAL_DEV_PROVIDER = "local-dev";

/**
 * `GET /v1/users/me` — the full `User` entity backing the account menu
 * and Profile page. The `displayName ?? email` fallback is the UI's job.
 */
export function useMe() {
  return useQuery({
    queryKey: meKeys.all,
    queryFn: async ({ signal }) => {
      const { user } = await authenticatedRequest<MeWireResponse>({
        method: "GET",
        path: "/users/me",
        signal,
      });
      return fromUserWire(user);
    },
  });
}

/**
 * True only when the signed-in account was created by the local evaluation
 * stack's fake identity provider. Loading/error resolve to false — advisory
 * chrome only (banner, sticky offsets), never a gate.
 *
 * Derived from the already-cached whoami query (the shell fetches it for
 * RBAC on every boot) so shell chrome costs no extra request — unlike the
 * public web-config endpoint, which is a login-flow concern and 404s on
 * self-hosts without web OAuth configured.
 */
export function useIsLocalDevSession(): boolean {
  const meQuery = useMe();

  return meQuery.data?.oauthProvider === LOCAL_DEV_PROVIDER;
}
