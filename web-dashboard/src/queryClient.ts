// Single shared QueryClient, module-scope so React never
// recreates it. Defaults tuned for the dashboard:
// - retry: HttpProblemError 401/403/404 responses are deterministic — auth
//   recovery is the API client's refresh-once job, and RBAC/absence
//   don't heal on retry — so they are NEVER retried; everything else gets at
//   most one retry before surfacing through ErrorState.
// - staleTime 30s: list/detail reads tolerate short staleness because every
//   mutation invalidates its keys explicitly (api/hooks convention), and the
//   only time-critical read (release job polling) uses refetchInterval, which
//   ignores staleTime.
// - refetchOnWindowFocus off: refetching is explicit (mutations, polling,
//   user-driven Retry) so tab switches don't thrash the API.

import { QueryClient } from "@tanstack/react-query";

import { HttpProblemError } from "./api/problem";

const NEVER_RETRY_STATUSES = new Set([401, 403, 404]);

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        if (
          error instanceof HttpProblemError &&
          NEVER_RETRY_STATUSES.has(error.status)
        ) {
          return false;
        }
        return failureCount < 1;
      },
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});
