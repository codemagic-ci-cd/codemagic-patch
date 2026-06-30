// Pure team-resolution helpers shared by the `/` landing redirect (HomeRedirect
// in router.tsx) and the team-scoped shell (AppShell). Kept free of storage and
// React so the redirect target and the "is this team mine?" check are
// unit-testable and cannot drift apart.
//
// Why this exists: a remembered team id (localStorage lastTeamId) can outlive
// the team it names — a self-host DB reset re-bootstraps `default-team` with a
// fresh random id, a membership can be revoked, or a deep link can point at a
// team the caller never joined. Trusting such an id blindly made `/` redirect
// into a dead team forever (the shell re-persisted it on arrival, so it never
// self-corrected). Both callers now validate the id against `GET /v1/teams`
// (visibility-filtered to the caller) through these helpers.

/** Structural shape of a team — only the id is needed to resolve/validate. */
export interface TeamRef {
  id: string;
}

/**
 * Where `/` should land. Prefers the remembered team when the caller still
 * belongs to it, otherwise the first visible team, otherwise null (no visible
 * team — the caller surfaces a message). The result is never an id absent from
 * `teams`, so a stale remembered id can never be redirected into.
 */
export function resolveHomeTeamId(
  teams: readonly TeamRef[],
  rememberedId: string | null,
): string | null {
  if (rememberedId !== null && teams.some((team) => team.id === rememberedId)) {
    return rememberedId;
  }
  return teams[0]?.id ?? null;
}

/** Whether a URL `teamId` is known to belong to the caller, or not yet decided. */
export type TeamRouteStatus = "pending" | "known" | "unknown";

/**
 * Classifies a URL `teamId` against the caller's visible teams. `teams ===
 * undefined` (the list is still loading or errored) is "pending": callers must
 * neither persist nor redirect on it. "known" means the caller belongs to the
 * team; "unknown" means a resolved list that excludes it (stale id, revoked
 * membership, or a foreign deep link) and should self-heal.
 */
export function classifyTeamRoute(
  teamId: string,
  teams: readonly TeamRef[] | undefined,
): TeamRouteStatus {
  if (teams === undefined) {
    return "pending";
  }
  return teams.some((team) => team.id === teamId) ? "known" : "unknown";
}
