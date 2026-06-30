// Resolve an opaque actor user-id (release.createdBy, job triggers, etc.) to a
// human label. The release/app wire only carries the user id, but the team's
// role bindings (already fetched by useTeamRole on every team route) expose
// `{ id, email, displayName }` for each member — so this reuses that exact
// query (same key → deduped, no extra request) to build an id → label map.
//
// Resolution is best-effort: for viewer/developer roles the bindings list 403s
// (the established RBAC pattern), and authors who have since left the team
// won't be present either. Callers fall back to a shortened id in those cases.

import { useCallback, useMemo } from "react";

import { useRoleBindings } from "./iam";

/**
 * Returns a resolver mapping a user id to its display name (or email), or null
 * when the id is unknown / the bindings aren't readable. Pass `teamId` for the
 * active team; the caller supplies its own fallback (e.g. a shortened id).
 */
export function useUserLabel(
  teamId: string,
): (userId: string | null) => string | null {
  const bindingsQuery = useRoleBindings(teamId);

  const labelsById = useMemo(() => {
    const map = new Map<string, string>();
    for (const binding of bindingsQuery.data ?? []) {
      map.set(binding.user.id, binding.user.displayName ?? binding.user.email);
    }
    return map;
  }, [bindingsQuery.data]);

  return useCallback(
    (userId: string | null) =>
      userId === null ? null : (labelsById.get(userId) ?? null),
    [labelsById],
  );
}
