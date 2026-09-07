// TanStack Query binding for the instance status endpoint.
// `GET /v1/server/status` is `instance.read` (every signed-in account today).
// A deployment without a status handler answers 501, and that single answer
// both hides the sidebar entry and keeps the page off.

import { useQuery } from "@tanstack/react-query";

import { authenticatedRequest } from "../client";
import { HttpProblemError } from "../problem";
import { fromServerStatusWire, type ServerStatusWire } from "../wire";
import { serverStatusAvailability } from "../../model/serverStatus";

export const serverStatusKeys = {
  all: ["server-status"] as const,
  detail: () => [...serverStatusKeys.all, "detail"] as const,
};

export function isServerStatusUnavailable(error: unknown): boolean {
  return error instanceof HttpProblemError && error.status === 501;
}

/**
 * `GET /v1/server/status`. The sidebar and the page share this query, so a
 * page visit right after boot reuses the sidebar's answer; `staleTime` is
 * per caller (the sidebar only needs the 501-or-not answer, the page wants
 * fresh probes).
 */
export function useServerStatus(options: { staleTime?: number } = {}) {
  return useQuery({
    queryKey: serverStatusKeys.detail(),
    queryFn: async ({ signal }) => {
      const wire = await authenticatedRequest<ServerStatusWire>({
        method: "GET",
        path: "/server/status",
        signal,
      });
      return fromServerStatusWire(wire);
    },
    retry: (failureCount, error) =>
      !isServerStatusUnavailable(error) && failureCount < 1,
    staleTime: options.staleTime,
  });
}

const AVAILABILITY_STALE_TIME_MS = 5 * 60_000;

/** Sidebar gate: `unknown` until the first answer, `unavailable` on 501. */
export function useServerStatusAvailability() {
  const query = useServerStatus({ staleTime: AVAILABILITY_STALE_TIME_MS });
  return serverStatusAvailability({
    isPending: query.isPending,
    unavailable: query.isError && isServerStatusUnavailable(query.error),
  });
}
