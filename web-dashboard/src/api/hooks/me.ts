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
