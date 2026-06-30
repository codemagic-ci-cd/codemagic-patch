import type { Pool } from "pg";

import { canonicalizeEmail } from "../app/email";
import type { DatabasePool } from "../db";
import { withTransaction } from "../db";
import type {
  MembershipId,
  RoleBindingId,
  RoleDefinition,
  RoleDefinitionId,
  TeamId,
  TeamInvitationId,
  TeamInvitationStatus,
  UserAccount,
  UserId,
} from "../domain";
import type { IamRoleBinding } from "./iamRepository";
import {
  mapRoleBindingRow,
  mapRoleDefinitionRow,
  mapTeamInvitationWithRoleRow,
  mapUserAccountRow,
  type RoleBindingRow,
  type RoleDefinitionRow,
  type TeamInvitationWithRole,
  type TeamInvitationWithRoleRow,
  type UserAccountRow,
} from "./rowMappers";

export type TeamInvitationStatusFilter = TeamInvitationStatus | "all";

// An invitation targets EITHER a verified email or an immutable GitHub OAuth
// identity (handle resolved to `subject` at invite time). Mirrors the
// email|userId selector pattern used for role bindings.
export type TeamInvitationTarget =
  | {
      type: "email";
      email: string;
    }
  | {
      type: "oauth";
      handle: string;
      provider: string;
      subject: string;
    };

export interface CreateTeamInvitationInput {
  createdAt: Date;
  createdBy: UserId;
  expiresAt: Date;
  id: TeamInvitationId;
  membershipId: MembershipId;
  roleBindingId: RoleBindingId;
  roleId: RoleDefinitionId;
  target: TeamInvitationTarget;
  teamId: TeamId;
}

export type CreateTeamInvitationResult =
  | {
      outcome: "created" | "already_exists";
      invitation: TeamInvitationWithRole;
    }
  | {
      outcome: "conflict";
      reason: "pending_invitation_role_mismatch";
      invitation: TeamInvitationWithRole;
    }
  | {
      outcome: "accepted_existing_user";
      invitation: TeamInvitationWithRole;
      membershipCreated: boolean;
      roleBinding: IamRoleBinding;
      roleBindingCreated: boolean;
    }
  | {
      outcome: "already_granted";
      invitation: null;
      roleBinding: IamRoleBinding;
    }
  | {
      outcome: "not_found";
      reason: "role_not_found" | "team_not_found";
    }
  | {
      outcome: "account_disabled";
      reason: "team_disabled" | "user_disabled";
    }
  | {
      outcome: "role_not_supported";
    };

export interface ListTeamInvitationsInput {
  now: Date;
  status: TeamInvitationStatusFilter;
  teamId: TeamId;
}

export type ListTeamInvitationsResult =
  | {
      outcome: "found";
      invitations: TeamInvitationWithRole[];
    }
  | {
      outcome: "not_found";
      reason: "team_not_found";
    };

export interface ResolveTeamInvitationInput {
  invitationId: TeamInvitationId;
  now: Date;
}

export type ResolveTeamInvitationResult =
  | {
      outcome: "found";
      invitation: TeamInvitationWithRole;
    }
  | {
      outcome: "not_found";
      reason: "invitation_not_found";
    };

export interface RevokeTeamInvitationInput {
  invitationId: TeamInvitationId;
  revokedAt: Date;
  revokedBy: UserId;
}

export type RevokeTeamInvitationResult =
  | {
      outcome: "revoked";
      invitation: TeamInvitationWithRole;
    }
  | {
      outcome: "conflict";
      reason: "invitation_not_pending";
      invitation: TeamInvitationWithRole;
    }
  | {
      outcome: "not_found";
      reason: "invitation_not_found";
    };

export interface AcceptPendingTeamInvitationsForUserInput {
  acceptedAt: Date;
  membershipId: () => MembershipId;
  // The signing-in user's OAuth identity — matches handle-based invitations.
  // Always present for OAuth sign-in (the only path that accepts invitations).
  oauthProvider: string;
  oauthSubject: string;
  roleBindingId: () => RoleBindingId;
  userEmail: string;
  userId: UserId;
}

export interface AcceptedTeamInvitationGrant {
  invitation: TeamInvitationWithRole;
  membershipCreated: boolean;
  roleBinding: IamRoleBinding;
  roleBindingCreated: boolean;
}

export interface SkippedTeamInvitation {
  invitation: TeamInvitationWithRole["invitation"];
  reason: "role_not_supported" | "team_disabled" | "team_not_found";
}

export interface AcceptPendingTeamInvitationsForUserResult {
  accepted: AcceptedTeamInvitationGrant[];
  expired: TeamInvitationWithRole[];
  skipped: SkippedTeamInvitation[];
}

export interface IamInvitationRepository {
  acceptPendingTeamInvitationsForUser(
    input: AcceptPendingTeamInvitationsForUserInput,
  ): Promise<AcceptPendingTeamInvitationsForUserResult>;
  createTeamInvitation(
    input: CreateTeamInvitationInput,
  ): Promise<CreateTeamInvitationResult>;
  listTeamInvitations(
    input: ListTeamInvitationsInput,
  ): Promise<ListTeamInvitationsResult>;
  resolveTeamInvitation(
    input: ResolveTeamInvitationInput,
  ): Promise<ResolveTeamInvitationResult>;
  revokeTeamInvitation(
    input: RevokeTeamInvitationInput,
  ): Promise<RevokeTeamInvitationResult>;
}

interface Queryable {
  query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

interface RoleBindingDetailsRow extends RoleBindingRow {
  role_display_name: string;
  role_key: string;
  user_display_name: string | null;
  user_email: string;
}

interface TeamRow {
  id: string;
  status: "active" | "disabled";
}

export function createPostgresIamInvitationRepository(
  pool: DatabasePool | Pool,
): IamInvitationRepository {
  return {
    async acceptPendingTeamInvitationsForUser(input) {
      return withTransaction(pool, async (client) => {
        const match: UserInvitationMatch = {
          email: canonicalizeEmail(input.userEmail),
          oauthProvider: input.oauthProvider,
          oauthSubject: input.oauthSubject,
        };
        const expired = await markExpiredPendingForUser(client, {
          match,
          now: input.acceptedAt,
        });
        const pending = await getPendingInvitationsForUserForUpdate(
          client,
          match,
        );
        const accepted: AcceptedTeamInvitationGrant[] = [];
        const skipped: SkippedTeamInvitation[] = [];

        for (const invitation of pending) {
          const team = await getTeam(client, invitation.invitation.teamId);
          if (!team) {
            skipped.push({
              invitation: invitation.invitation,
              reason: "team_not_found",
            });
            continue;
          }

          if (team.status === "disabled") {
            skipped.push({
              invitation: invitation.invitation,
              reason: "team_disabled",
            });
            continue;
          }

          const role = await getRoleDefinition(
            client,
            invitation.invitation.roleDefinitionId,
          );
          if (!isSupportedSystemRole(role)) {
            skipped.push({
              invitation: invitation.invitation,
              reason: "role_not_supported",
            });
            continue;
          }

          const grant = await grantAcceptedInvitationRole(client, {
            createdAt: input.acceptedAt,
            createdBy: invitation.invitation.createdBy,
            membershipId: input.membershipId,
            roleBindingId: input.roleBindingId,
            roleId: invitation.invitation.roleDefinitionId,
            teamId: invitation.invitation.teamId,
            userId: input.userId,
          });
          const acceptedInvitation = await markInvitationAccepted(client, {
            acceptedAt: input.acceptedAt,
            acceptedBy: input.userId,
            invitationId: invitation.invitation.id,
            roleBindingId: grant.roleBinding.id,
          });

          accepted.push({
            invitation: requireValue(acceptedInvitation, "team_invitation"),
            membershipCreated: grant.membershipCreated,
            roleBinding: grant.roleBinding,
            roleBindingCreated: grant.roleBindingCreated,
          });
        }

        return {
          accepted,
          expired,
          skipped,
        };
      });
    },

    async createTeamInvitation(input) {
      return withTransaction(pool, async (client) => {
        const target = normalizeTarget(input.target);
        await markExpiredPendingByTeamTarget(client, {
          now: input.createdAt,
          target,
          teamId: input.teamId,
        });

        const team = await getTeam(client, input.teamId);
        if (!team) {
          return {
            outcome: "not_found",
            reason: "team_not_found",
          };
        }

        if (team.status === "disabled") {
          return {
            outcome: "account_disabled",
            reason: "team_disabled",
          };
        }

        const role = await getRoleDefinition(client, input.roleId);
        if (!role) {
          return {
            outcome: "not_found",
            reason: "role_not_found",
          };
        }

        if (!isSupportedSystemRole(role)) {
          return {
            outcome: "role_not_supported",
          };
        }

        const pending = await getPendingInvitationForTeamTargetForUpdate(
          client,
          {
            target,
            teamId: input.teamId,
          },
        );
        if (pending) {
          if (pending.invitation.roleDefinitionId === input.roleId) {
            return {
              invitation: pending,
              outcome: "already_exists",
            };
          }

          return {
            invitation: pending,
            outcome: "conflict",
            reason: "pending_invitation_role_mismatch",
          };
        }

        const user = await getUserForTarget(client, target);
        if (user?.status === "disabled") {
          return {
            outcome: "account_disabled",
            reason: "user_disabled",
          };
        }

        if (user) {
          const existingRoleBinding = await getTeamRoleBindingByUnique(client, {
            roleId: input.roleId,
            teamId: input.teamId,
            userId: user.id,
          });
          if (existingRoleBinding) {
            return {
              invitation: null,
              outcome: "already_granted",
              roleBinding: toIamRoleBinding(existingRoleBinding),
            };
          }

          const membershipCreated = await insertMembershipIfMissing(client, {
            createdAt: input.createdAt,
            id: input.membershipId,
            teamId: input.teamId,
            userId: user.id,
          });
          const roleBindingCreated = await insertRoleBindingIfMissing(client, {
            bindingId: input.roleBindingId,
            createdAt: input.createdAt,
            createdBy: input.createdBy,
            roleId: input.roleId,
            teamId: input.teamId,
            userId: user.id,
          });
          const roleBinding = requireValue(
            await getTeamRoleBindingByUnique(client, {
              roleId: input.roleId,
              teamId: input.teamId,
              userId: user.id,
            }),
            "role_binding",
          );
          const iamRoleBinding = toIamRoleBinding(roleBinding);
          const invitation = await insertAcceptedInvitation(client, {
            acceptedAt: input.createdAt,
            acceptedBy: user.id,
            createdAt: input.createdAt,
            createdBy: input.createdBy,
            expiresAt: input.expiresAt,
            id: input.id,
            roleBindingId: iamRoleBinding.id,
            roleId: input.roleId,
            target,
            teamId: input.teamId,
          });

          return {
            invitation,
            membershipCreated,
            outcome: "accepted_existing_user",
            roleBinding: iamRoleBinding,
            roleBindingCreated,
          };
        }

        return {
          invitation: await insertPendingInvitation(client, {
            createdAt: input.createdAt,
            createdBy: input.createdBy,
            expiresAt: input.expiresAt,
            id: input.id,
            roleId: input.roleId,
            target,
            teamId: input.teamId,
          }),
          outcome: "created",
        };
      });
    },

    async listTeamInvitations(input) {
      return withTransaction(pool, async (client) => {
        const team = await getTeam(client, input.teamId);
        if (!team) {
          return {
            outcome: "not_found",
            reason: "team_not_found",
          };
        }

        await markExpiredPendingForTeam(client, {
          now: input.now,
          teamId: input.teamId,
        });

        return {
          invitations: await listInvitationsForTeam(client, input),
          outcome: "found",
        };
      });
    },

    async resolveTeamInvitation(input) {
      return withTransaction(pool, async (client) => {
        const invitation = await getInvitationByIdForUpdate(
          client,
          input.invitationId,
        );

        if (!invitation) {
          return {
            outcome: "not_found",
            reason: "invitation_not_found",
          };
        }

        if (
          invitation.invitation.status === "pending" &&
          invitation.invitation.expiresAt <= input.now
        ) {
          const expired = await markInvitationExpired(client, input.invitationId);
          return {
            invitation: requireValue(expired, "team_invitation"),
            outcome: "found",
          };
        }

        return {
          invitation,
          outcome: "found",
        };
      });
    },

    async revokeTeamInvitation(input) {
      return withTransaction(pool, async (client) => {
        const invitation = await getInvitationByIdForUpdate(
          client,
          input.invitationId,
        );

        if (!invitation) {
          return {
            outcome: "not_found",
            reason: "invitation_not_found",
          };
        }

        if (
          invitation.invitation.status === "pending" &&
          invitation.invitation.expiresAt <= input.revokedAt
        ) {
          const expired = await markInvitationExpired(
            client,
            input.invitationId,
          );
          return {
            invitation: requireValue(expired, "team_invitation"),
            outcome: "conflict",
            reason: "invitation_not_pending",
          };
        }

        if (invitation.invitation.status !== "pending") {
          return {
            invitation,
            outcome: "conflict",
            reason: "invitation_not_pending",
          };
        }

        const revoked = await markInvitationRevoked(client, input);
        return {
          invitation: requireValue(revoked, "team_invitation"),
          outcome: "revoked",
        };
      });
    },
  };
}

// Email is canonicalized; the OAuth target is already an immutable id pair.
function normalizeTarget(target: TeamInvitationTarget): TeamInvitationTarget {
  if (target.type === "email") {
    return { email: canonicalizeEmail(target.email), type: "email" };
  }

  return target;
}

interface TargetColumns {
  email: string | null;
  githubHandle: string | null;
  oauthProvider: string | null;
  oauthSubject: string | null;
}

function targetColumns(target: TeamInvitationTarget): TargetColumns {
  if (target.type === "email") {
    return {
      email: target.email,
      githubHandle: null,
      oauthProvider: null,
      oauthSubject: null,
    };
  }

  return {
    email: null,
    githubHandle: target.handle,
    oauthProvider: target.provider,
    oauthSubject: target.subject,
  };
}

// The signing-in user's identity, used to find every pending invitation they
// satisfy — by email or by OAuth identity (handle-based invitations).
interface UserInvitationMatch {
  email: string;
  oauthProvider: string;
  oauthSubject: string;
}

async function getTeam(pool: Queryable, teamId: TeamId): Promise<TeamRow | null> {
  const result = await pool.query<TeamRow>(
    "SELECT id, status FROM team WHERE id = $1",
    [teamId],
  );

  return result.rows[0] ?? null;
}

async function getUserByEmail(
  pool: Queryable,
  email: string,
): Promise<UserAccount | null> {
  const result = await pool.query<UserAccountRow>(
    "SELECT * FROM user_account WHERE email = $1",
    [email],
  );

  return result.rows[0] ? mapUserAccountRow(result.rows[0]) : null;
}

async function getUserByOAuthIdentity(
  pool: Queryable,
  provider: string,
  subject: string,
): Promise<UserAccount | null> {
  const result = await pool.query<UserAccountRow>(
    `
      SELECT *
      FROM user_account
      WHERE oauth_provider = $1
        AND oauth_subject = $2
    `,
    [provider, subject],
  );

  return result.rows[0] ? mapUserAccountRow(result.rows[0]) : null;
}

// Finds an already-registered account for the invitation target: by email, or
// by the GitHub identity the handle resolved to. When found, the invite grants
// the role immediately instead of leaving a pending row.
async function getUserForTarget(
  pool: Queryable,
  target: TeamInvitationTarget,
): Promise<UserAccount | null> {
  if (target.type === "email") {
    return getUserByEmail(pool, target.email);
  }

  return getUserByOAuthIdentity(pool, target.provider, target.subject);
}

async function getRoleDefinition(
  pool: Queryable,
  roleId: RoleDefinitionId,
): Promise<RoleDefinition | null> {
  const result = await pool.query<RoleDefinitionRow>(
    "SELECT * FROM role_definition WHERE id = $1",
    [roleId],
  );

  return result.rows[0] ? mapRoleDefinitionRow(result.rows[0]) : null;
}

function isSupportedSystemRole(role: RoleDefinition | null): role is RoleDefinition {
  return role !== null && role.isSystem && role.teamId === null;
}

async function getPendingInvitationForTeamTargetForUpdate(
  pool: Queryable,
  input: {
    target: TeamInvitationTarget;
    teamId: TeamId;
  },
): Promise<TeamInvitationWithRole | null> {
  const columns = targetColumns(input.target);
  const result = await pool.query<TeamInvitationWithRoleRow>(
    `
      SELECT
        ti.*,
        rd.key AS role_key,
        rd.display_name AS role_display_name
      FROM team_invitation ti
      JOIN role_definition rd ON rd.id = ti.role_definition_id
      WHERE ti.team_id = $1
        AND ti.status = 'pending'
        AND (
          ($2::text IS NOT NULL AND ti.email = $2)
          OR (
            $3::text IS NOT NULL
            AND ti.oauth_provider = $3
            AND ti.oauth_subject = $4
          )
        )
      FOR UPDATE OF ti
    `,
    [input.teamId, columns.email, columns.oauthProvider, columns.oauthSubject],
  );

  return result.rows[0] ? mapTeamInvitationWithRoleRow(result.rows[0]) : null;
}

// Matches every pending invitation the signing-in user satisfies — by email or
// by GitHub identity — so handle- and email-based invites accept together.
async function getPendingInvitationsForUserForUpdate(
  pool: Queryable,
  match: UserInvitationMatch,
): Promise<TeamInvitationWithRole[]> {
  const result = await pool.query<TeamInvitationWithRoleRow>(
    `
      SELECT
        ti.*,
        rd.key AS role_key,
        rd.display_name AS role_display_name
      FROM team_invitation ti
      JOIN role_definition rd ON rd.id = ti.role_definition_id
      WHERE ti.status = 'pending'
        AND (
          ti.email = $1
          OR (ti.oauth_provider = $2 AND ti.oauth_subject = $3)
        )
      ORDER BY ti.created_at ASC, ti.id ASC
      FOR UPDATE OF ti
    `,
    [match.email, match.oauthProvider, match.oauthSubject],
  );

  return result.rows.map(mapTeamInvitationWithRoleRow);
}

async function getInvitationByIdForUpdate(
  pool: Queryable,
  invitationId: TeamInvitationId,
): Promise<TeamInvitationWithRole | null> {
  const result = await pool.query<TeamInvitationWithRoleRow>(
    `
      SELECT
        ti.*,
        rd.key AS role_key,
        rd.display_name AS role_display_name
      FROM team_invitation ti
      JOIN role_definition rd ON rd.id = ti.role_definition_id
      WHERE ti.id = $1
      FOR UPDATE OF ti
    `,
    [invitationId],
  );

  return result.rows[0] ? mapTeamInvitationWithRoleRow(result.rows[0]) : null;
}

async function insertPendingInvitation(
  pool: Queryable,
  input: {
    createdAt: Date;
    createdBy: UserId;
    expiresAt: Date;
    id: TeamInvitationId;
    roleId: RoleDefinitionId;
    target: TeamInvitationTarget;
    teamId: TeamId;
  },
): Promise<TeamInvitationWithRole> {
  const columns = targetColumns(input.target);
  const result = await pool.query<TeamInvitationWithRoleRow>(
    `
      WITH inserted AS (
        INSERT INTO team_invitation (
          id,
          team_id,
          email,
          github_handle,
          oauth_provider,
          oauth_subject,
          role_definition_id,
          status,
          created_by,
          created_at,
          expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $10)
        RETURNING *
      )
      SELECT
        inserted.*,
        rd.key AS role_key,
        rd.display_name AS role_display_name
      FROM inserted
      JOIN role_definition rd ON rd.id = inserted.role_definition_id
    `,
    [
      input.id,
      input.teamId,
      columns.email,
      columns.githubHandle,
      columns.oauthProvider,
      columns.oauthSubject,
      input.roleId,
      input.createdBy,
      input.createdAt,
      input.expiresAt,
    ],
  );

  return mapTeamInvitationWithRoleRow(
    requireValue(result.rows[0] ?? null, "team_invitation"),
  );
}

async function insertAcceptedInvitation(
  pool: Queryable,
  input: {
    acceptedAt: Date;
    acceptedBy: UserId;
    createdAt: Date;
    createdBy: UserId;
    expiresAt: Date;
    id: TeamInvitationId;
    roleBindingId: RoleBindingId;
    roleId: RoleDefinitionId;
    target: TeamInvitationTarget;
    teamId: TeamId;
  },
): Promise<TeamInvitationWithRole> {
  const columns = targetColumns(input.target);
  const result = await pool.query<TeamInvitationWithRoleRow>(
    `
      WITH inserted AS (
        INSERT INTO team_invitation (
          id,
          team_id,
          email,
          github_handle,
          oauth_provider,
          oauth_subject,
          role_definition_id,
          status,
          created_by,
          created_at,
          expires_at,
          accepted_by,
          accepted_at,
          role_binding_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'accepted', $8, $9, $10, $11, $12, $13)
        RETURNING *
      )
      SELECT
        inserted.*,
        rd.key AS role_key,
        rd.display_name AS role_display_name
      FROM inserted
      JOIN role_definition rd ON rd.id = inserted.role_definition_id
    `,
    [
      input.id,
      input.teamId,
      columns.email,
      columns.githubHandle,
      columns.oauthProvider,
      columns.oauthSubject,
      input.roleId,
      input.createdBy,
      input.createdAt,
      input.expiresAt,
      input.acceptedBy,
      input.acceptedAt,
      input.roleBindingId,
    ],
  );

  return mapTeamInvitationWithRoleRow(
    requireValue(result.rows[0] ?? null, "team_invitation"),
  );
}

async function listInvitationsForTeam(
  pool: Queryable,
  input: ListTeamInvitationsInput,
): Promise<TeamInvitationWithRole[]> {
  const values: unknown[] = [input.teamId];
  const statusPredicate =
    input.status === "all" ? "" : "AND ti.status = $2";
  if (input.status !== "all") {
    values.push(input.status);
  }

  const result = await pool.query<TeamInvitationWithRoleRow>(
    `
      SELECT
        ti.*,
        rd.key AS role_key,
        rd.display_name AS role_display_name
      FROM team_invitation ti
      JOIN role_definition rd ON rd.id = ti.role_definition_id
      WHERE ti.team_id = $1
        ${statusPredicate}
      ORDER BY ti.created_at ASC, ti.id ASC
    `,
    values,
  );

  return result.rows.map(mapTeamInvitationWithRoleRow);
}

async function markExpiredPendingByTeamTarget(
  pool: Queryable,
  input: {
    now: Date;
    target: TeamInvitationTarget;
    teamId: TeamId;
  },
): Promise<void> {
  const columns = targetColumns(input.target);
  await pool.query(
    `
      UPDATE team_invitation
      SET status = 'expired'
      WHERE team_id = $1
        AND status = 'pending'
        AND expires_at <= $2
        AND (
          ($3::text IS NOT NULL AND email = $3)
          OR (
            $4::text IS NOT NULL
            AND oauth_provider = $4
            AND oauth_subject = $5
          )
        )
    `,
    [
      input.teamId,
      input.now,
      columns.email,
      columns.oauthProvider,
      columns.oauthSubject,
    ],
  );
}

async function markExpiredPendingForTeam(
  pool: Queryable,
  input: {
    now: Date;
    teamId: TeamId;
  },
): Promise<void> {
  await pool.query(
    `
      UPDATE team_invitation
      SET status = 'expired'
      WHERE team_id = $1
        AND status = 'pending'
        AND expires_at <= $2
    `,
    [input.teamId, input.now],
  );
}

async function markExpiredPendingForUser(
  pool: Queryable,
  input: {
    match: UserInvitationMatch;
    now: Date;
  },
): Promise<TeamInvitationWithRole[]> {
  const result = await pool.query<TeamInvitationWithRoleRow>(
    `
      WITH expired AS (
        UPDATE team_invitation
        SET status = 'expired'
        WHERE status = 'pending'
          AND expires_at <= $4
          AND (
            email = $1
            OR (oauth_provider = $2 AND oauth_subject = $3)
          )
        RETURNING *
      )
      SELECT
        expired.*,
        rd.key AS role_key,
        rd.display_name AS role_display_name
      FROM expired
      JOIN role_definition rd ON rd.id = expired.role_definition_id
      ORDER BY expired.created_at ASC, expired.id ASC
    `,
    [
      input.match.email,
      input.match.oauthProvider,
      input.match.oauthSubject,
      input.now,
    ],
  );

  return result.rows.map(mapTeamInvitationWithRoleRow);
}

async function markInvitationExpired(
  pool: Queryable,
  invitationId: TeamInvitationId,
): Promise<TeamInvitationWithRole | null> {
  const result = await pool.query<TeamInvitationWithRoleRow>(
    `
      WITH expired AS (
        UPDATE team_invitation
        SET status = 'expired'
        WHERE id = $1
          AND status = 'pending'
        RETURNING *
      )
      SELECT
        expired.*,
        rd.key AS role_key,
        rd.display_name AS role_display_name
      FROM expired
      JOIN role_definition rd ON rd.id = expired.role_definition_id
    `,
    [invitationId],
  );

  return result.rows[0] ? mapTeamInvitationWithRoleRow(result.rows[0]) : null;
}

async function markInvitationRevoked(
  pool: Queryable,
  input: RevokeTeamInvitationInput,
): Promise<TeamInvitationWithRole | null> {
  const result = await pool.query<TeamInvitationWithRoleRow>(
    `
      WITH revoked AS (
        UPDATE team_invitation
        SET
          status = 'revoked',
          revoked_by = $2,
          revoked_at = $3
        WHERE id = $1
          AND status = 'pending'
        RETURNING *
      )
      SELECT
        revoked.*,
        rd.key AS role_key,
        rd.display_name AS role_display_name
      FROM revoked
      JOIN role_definition rd ON rd.id = revoked.role_definition_id
    `,
    [input.invitationId, input.revokedBy, input.revokedAt],
  );

  return result.rows[0] ? mapTeamInvitationWithRoleRow(result.rows[0]) : null;
}

async function markInvitationAccepted(
  pool: Queryable,
  input: {
    acceptedAt: Date;
    acceptedBy: UserId;
    invitationId: TeamInvitationId;
    roleBindingId: RoleBindingId;
  },
): Promise<TeamInvitationWithRole | null> {
  const result = await pool.query<TeamInvitationWithRoleRow>(
    `
      WITH accepted AS (
        UPDATE team_invitation
        SET
          status = 'accepted',
          accepted_by = $2,
          accepted_at = $3,
          role_binding_id = $4
        WHERE id = $1
          AND status = 'pending'
        RETURNING *
      )
      SELECT
        accepted.*,
        rd.key AS role_key,
        rd.display_name AS role_display_name
      FROM accepted
      JOIN role_definition rd ON rd.id = accepted.role_definition_id
    `,
    [
      input.invitationId,
      input.acceptedBy,
      input.acceptedAt,
      input.roleBindingId,
    ],
  );

  return result.rows[0] ? mapTeamInvitationWithRoleRow(result.rows[0]) : null;
}

async function grantAcceptedInvitationRole(
  pool: Queryable,
  input: {
    createdAt: Date;
    createdBy: UserId;
    membershipId: () => MembershipId;
    roleBindingId: () => RoleBindingId;
    roleId: RoleDefinitionId;
    teamId: TeamId;
    userId: UserId;
  },
): Promise<{
  membershipCreated: boolean;
  roleBinding: IamRoleBinding;
  roleBindingCreated: boolean;
}> {
  const membershipCreated = await insertMembershipIfMissing(pool, {
    createdAt: input.createdAt,
    id: input.membershipId(),
    teamId: input.teamId,
    userId: input.userId,
  });
  const existing = await getTeamRoleBindingByUnique(pool, {
    roleId: input.roleId,
    teamId: input.teamId,
    userId: input.userId,
  });

  if (existing) {
    return {
      membershipCreated,
      roleBinding: toIamRoleBinding(existing),
      roleBindingCreated: false,
    };
  }

  const roleBindingId = input.roleBindingId();
  const roleBindingCreated = await insertRoleBindingIfMissing(pool, {
    bindingId: roleBindingId,
    createdAt: input.createdAt,
    createdBy: input.createdBy,
    roleId: input.roleId,
    teamId: input.teamId,
    userId: input.userId,
  });
  const roleBinding = requireValue(
    await getTeamRoleBindingByUnique(pool, {
      roleId: input.roleId,
      teamId: input.teamId,
      userId: input.userId,
    }),
    "role_binding",
  );

  return {
    membershipCreated,
    roleBinding: toIamRoleBinding(roleBinding),
    roleBindingCreated,
  };
}

async function insertMembershipIfMissing(
  pool: Queryable,
  input: {
    createdAt: Date;
    id: MembershipId;
    teamId: TeamId;
    userId: UserId;
  },
): Promise<boolean> {
  const result = await pool.query<{ id: string }>(
    `
      INSERT INTO membership (id, team_id, user_id, created_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (team_id, user_id) DO NOTHING
      RETURNING id
    `,
    [input.id, input.teamId, input.userId, input.createdAt],
  );

  return result.rows[0] !== undefined;
}

async function insertRoleBindingIfMissing(
  pool: Queryable,
  input: {
    bindingId: RoleBindingId;
    createdAt: Date;
    createdBy: UserId;
    roleId: RoleDefinitionId;
    teamId: TeamId;
    userId: UserId;
  },
): Promise<boolean> {
  const result = await pool.query<{ id: string }>(
    `
      INSERT INTO role_binding (
        id,
        principal_type,
        principal_id,
        role_definition_id,
        scope_type,
        scope_id,
        created_at,
        created_by
      ) VALUES ($1, 'user', $2, $3, 'team', $4, $5, $6)
      ON CONFLICT (
        principal_type,
        principal_id,
        role_definition_id,
        scope_type,
        scope_id
      ) DO NOTHING
      RETURNING id
    `,
    [
      input.bindingId,
      input.userId,
      input.roleId,
      input.teamId,
      input.createdAt,
      input.createdBy,
    ],
  );

  return result.rows[0] !== undefined;
}

async function getTeamRoleBindingByUnique(
  pool: Queryable,
  input: {
    roleId: RoleDefinitionId;
    teamId: TeamId;
    userId: UserId;
  },
): Promise<RoleBindingDetailsRow | null> {
  const result = await pool.query<RoleBindingDetailsRow>(
    `
      SELECT
        rb.*,
        rd.key AS role_key,
        rd.display_name AS role_display_name,
        u.email AS user_email,
        u.display_name AS user_display_name
      FROM role_binding rb
      JOIN role_definition rd ON rd.id = rb.role_definition_id
      JOIN user_account u ON u.id = rb.principal_id
      WHERE rb.principal_type = 'user'
        AND rb.principal_id = $1
        AND rb.role_definition_id = $2
        AND rb.scope_type = 'team'
        AND rb.scope_id = $3
    `,
    [input.userId, input.roleId, input.teamId],
  );

  return result.rows[0] ?? null;
}

function toIamRoleBinding(row: RoleBindingDetailsRow): IamRoleBinding {
  const binding = mapRoleBindingRow(row);

  return {
    createdAt: binding.createdAt,
    createdBy: binding.createdBy,
    id: binding.id,
    principalType: binding.principalType,
    role: {
      displayName: row.role_display_name,
      id: binding.roleDefinitionId,
      key: row.role_key,
    },
    scope: {
      id: binding.scopeId as TeamId,
      type: "team",
    },
    user: {
      displayName: row.user_display_name,
      email: row.user_email,
      id: binding.principalId,
    },
  };
}

function requireValue<T>(value: T | null, name: string): T {
  if (!value) {
    throw new Error(`expected ${name} row to be returned`);
  }

  return value;
}
