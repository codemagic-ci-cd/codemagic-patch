// Last-visited-team persistence (the `/` route redirects to the last
// team via `localStorage lastTeamId`, else resolves one). Shared contract:
// AppShell syncs the route's `:teamId` once it confirms the caller belongs to
// it (so deep links count but stale/foreign ids do not), the `/` redirect reads
// it through teamResolution.resolveHomeTeamId (which re-validates), and an
// unvisitable id is dropped via clearLastTeamId. localStorage access is wrapped
// so blocked storage (private mode, disabled site data) degrades to "no last
// team" instead of throwing.

export const LAST_TEAM_STORAGE_KEY = "codemagic-patch.dashboard.lastTeamId";

/** Returns the persisted team id, or null when unset/unavailable. */
export function readLastTeamId(): string | null {
  try {
    const value = window.localStorage.getItem(LAST_TEAM_STORAGE_KEY);
    return value === null || value === "" ? null : value;
  } catch {
    return null;
  }
}

/** Best-effort persist; failures are silent (the `/` redirect then resolves one). */
export function writeLastTeamId(teamId: string): void {
  try {
    window.localStorage.setItem(LAST_TEAM_STORAGE_KEY, teamId);
  } catch {
    // Storage unavailable — last-team memory is simply skipped.
  }
}

/**
 * Best-effort clear; failures are silent. Drops a remembered team the caller no
 * longer belongs to (stale id after a DB reset, revoked membership, foreign
 * deep link) so the `/` redirect stops bouncing back into a dead team.
 */
export function clearLastTeamId(): void {
  try {
    window.localStorage.removeItem(LAST_TEAM_STORAGE_KEY);
  } catch {
    // Storage unavailable — nothing to clear.
  }
}
