// Per-team RBAC resolution for the current user. The inference rule:
// `GET /v1/iam/role-bindings?teamId=` matched against
// `useMe().id`, binding `role.key` → `Role`, RBAC gating via the
// `can(role, action)` matrix in model/permissions.ts (reused, not redefined).
// Non-`iam.manage` members get 403 `forbidden` from the list endpoint
// (expected — see api/hooks/iam.ts): they are viewer-or-developer, and the
// matrix separates those two only on `release.deploy` (incl. deployment
// clear), so the hook optimistically reports "developer" with confidence
// "inferred". The server stays the final authority: the UI may render
// controls a viewer cannot use, and calls `downgradeToViewer()` on the first
// denied mutation so subsequent renders gate as viewer. Downgrades live in a module-level Set keyed
// by teamId behind `useSyncExternalStore` (the credentialStore pattern) —
// chosen over `queryClient.setQueryData` because it needs no query-key or
// cache lifecycle and survives re-renders/remounts for the tab session. The
// session scope is accepted: a stale downgrade clears on reload, and the
// matrix is UI gating only. 404/other bindings failures → no-access
// (role null, can() === false); callers surface those states.

import { useCallback, useSyncExternalStore } from "react";

import { useRoleBindings } from "../api/hooks/iam";
import { useMe } from "../api/hooks/me";
import { classifyProblem, HttpProblemError } from "../api/problem";
import { can as roleCan } from "../model/permissions";
import type { ControlPlaneAction, Role } from "../model/permissions";

/** How the resolved role was obtained — "inferred" marks the 403 fallback. */
export type RoleConfidence = "exact" | "inferred";

export interface TeamRoleResult {
  /** Resolved role; null while loading and for no-access/unknown-role cases. */
  role: Role | null;
  /** True while either the identity or the bindings query is in flight. */
  isLoading: boolean;
  /**
   * "exact" when read from a role binding (and for the null-role states);
   * "inferred" when the bindings 403 fallback produced the role.
   */
  confidence: RoleConfidence;
  /** Matrix lookup bound to the resolved role; false while `role` is null. */
  can(action: ControlPlaneAction): boolean;
  /**
   * Call when the server denies a mutation with 403 `forbidden` for an
   * inferred-developer user: subsequent renders gate this team as viewer.
   */
  downgradeToViewer(): void;
}

// --- Inferred-downgrade store (module singleton, per-tab session scope) ----

const downgradedTeamIds = new Set<string>();
const downgradeListeners = new Set<() => void>();

function subscribeToDowngrades(listener: () => void): () => void {
  downgradeListeners.add(listener);
  return () => {
    downgradeListeners.delete(listener);
  };
}

function markTeamDowngraded(teamId: string): void {
  if (downgradedTeamIds.has(teamId)) {
    return;
  }
  downgradedTeamIds.add(teamId);
  for (const listener of downgradeListeners) {
    listener();
  }
}

/** Test-only: forget every inferred downgrade between cases. */
export function resetDowngradedTeams(): void {
  if (downgradedTeamIds.size === 0) {
    return;
  }
  downgradedTeamIds.clear();
  for (const listener of downgradeListeners) {
    listener();
  }
}

// ---------------------------------------------------------------------------

const ROLE_KEYS: ReadonlySet<string> = new Set<Role>([
  "viewer",
  "developer",
  "admin",
  "owner",
]);

/** Narrows a binding's `role.key` (wire `string`) to the matrix `Role`. */
function asRole(key: string): Role | null {
  return ROLE_KEYS.has(key) ? (key as Role) : null;
}

function isForbidden(error: unknown): boolean {
  return (
    error instanceof HttpProblemError && classifyProblem(error) === "forbidden"
  );
}

/**
 * Resolves the current user's role in `teamId` and exposes matrix-bound
 * gating. Exact when the bindings list is readable; on 403 `forbidden` the
 * viewer-or-developer fallback applies (see module header).
 */
export function useTeamRole(teamId: string): TeamRoleResult {
  const meQuery = useMe();
  const bindingsQuery = useRoleBindings(teamId);
  const isDowngraded = useSyncExternalStore(subscribeToDowngrades, () =>
    downgradedTeamIds.has(teamId),
  );

  const isLoading = meQuery.isPending || bindingsQuery.isPending;
  const meId = meQuery.data?.id;

  let role: Role | null = null;
  let confidence: RoleConfidence = "exact";
  if (!isLoading) {
    if (bindingsQuery.isError) {
      if (isForbidden(bindingsQuery.error)) {
        role = isDowngraded ? "viewer" : "developer";
        confidence = "inferred";
      }
      // 404/other failures: no-access — role stays null, callers handle.
    } else if (meId !== undefined && bindingsQuery.data !== undefined) {
      const binding = bindingsQuery.data.find(
        (entry) => entry.user.id === meId,
      );
      role = binding === undefined ? null : asRole(binding.role.key);
    }
  }

  const resolvedRole = role;
  const can = useCallback(
    (action: ControlPlaneAction) =>
      resolvedRole !== null && roleCan(resolvedRole, action),
    [resolvedRole],
  );
  const downgradeToViewer = useCallback(() => {
    markTeamDowngraded(teamId);
  }, [teamId]);

  return { role, isLoading, confidence, can, downgradeToViewer };
}
