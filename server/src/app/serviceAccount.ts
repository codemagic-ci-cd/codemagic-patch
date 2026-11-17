import type { UserAccount } from "../domain";

/**
 * A service account (an account one team owns, `ownerTeamId`) is honored in
 * its owner team only. Its token is issued by that team's admins, so access
 * anywhere else would give them a reach they do not have.
 *
 * The rule is applied where permissions are decided, not where role bindings
 * are written: a binding outside the owner team grants nothing, however it
 * got there. The two SQL-only decision points carry the same condition:
 * `listVisibleTeams` and the managed `hasInstancePermission`.
 */
export function isHonoredInTeam(
  user: Pick<UserAccount, "ownerTeamId">,
  teamId: string,
): boolean {
  return user.ownerTeamId === null || user.ownerTeamId === teamId;
}
