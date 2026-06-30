// TanStack Query bindings for the teams endpoints.
// Conventions established by this shared hooks group (deployment hooks mirror them):
//   - an exported per-domain query-key factory rooted at a single `all` key;
//   - queryFn unwraps the wire envelope so the cache stores model entities
//     (pages never see `{ teams }`-style envelopes — the layering rule);
//   - errors propagate as HttpProblemError (UI classification happens later).

import { useQuery } from "@tanstack/react-query";

import { authenticatedRequest } from "../client";
import {
  fromTeamWire,
  type TeamsListWireResponse,
  type TeamWireResponse,
} from "../wire";

/** Query keys for the teams domain. */
export const teamKeys = {
  all: ["teams"] as const,
  list: () => [...teamKeys.all, "list"] as const,
  detail: (teamId: string) => [...teamKeys.all, "detail", teamId] as const,
};

/** `GET /v1/teams` (`team.read`) — visibility-filtered to the caller's teams. */
export function useTeams() {
  return useQuery({
    queryKey: teamKeys.list(),
    queryFn: async ({ signal }) => {
      const { teams } = await authenticatedRequest<TeamsListWireResponse>({
        method: "GET",
        path: "/teams",
        signal,
      });
      return teams.map(fromTeamWire);
    },
  });
}

/**
 * Whether the caller can see more than one team. Drives single-team UI gating
 * (OSS ships a fixed `default-team`): multi-team-only affordances — the
 * Transfer-app action, the team-name breadcrumb/subtitle — stay hidden until we
 * positively know there is somewhere else to go. Returns false while the list is
 * loading or errored, the safe default for a single-team install.
 */
export function useIsMultiTeam(): boolean {
  const { data } = useTeams();
  return (data?.length ?? 0) > 1;
}

/** `GET /v1/teams/:teamId` — `not-found`/`forbidden` when not visible. */
export function useTeam(teamId: string) {
  return useQuery({
    queryKey: teamKeys.detail(teamId),
    queryFn: async ({ signal }) => {
      const { team } = await authenticatedRequest<TeamWireResponse>({
        method: "GET",
        path: `/teams/${encodeURIComponent(teamId)}`,
        signal,
      });
      return fromTeamWire(team);
    },
  });
}
