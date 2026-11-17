import type { Pool } from "pg";

import type {
  ApiTokenId,
  ApiTokenMetadata,
  ControlPlaneAction,
  MembershipId,
  OAuthSessionId,
  RoleBindingId,
  RoleDefinition,
  RoleDefinitionId,
  TeamId,
  UserAccount,
  UserId,
} from "../domain";
import type { DatabasePool } from "../db";
import { canonicalizeEmail } from "../app/email";
import { withTransaction } from "../db";
import {
  insertApiTokenFromSession,
  revokeUserCredentials,
} from "./credentialGeneration";
import { isHonoredInTeam } from "../app/serviceAccount";
import {
  mapApiTokenRow,
  mapRoleBindingRow,
  mapRoleDefinitionRow,
  mapUserAccountRow,
  type RoleBindingRow,
  type RoleDefinitionRow,
  type UserAccountRow,
} from "./rowMappers";

const OWNER_ROLE_DEFINITION_ID = "role_owner";

export interface IamRoleWithPermissions {
  role: RoleDefinition;
  permissions: ControlPlaneAction[];
}

export interface IamRoleBinding {
  id: RoleBindingId;
  principalType: "user";
  user: Pick<UserAccount, "displayName" | "email" | "id" | "ownerTeamId">;
  role: Pick<RoleDefinition, "displayName" | "id" | "key">;
  scope: {
    type: "team";
    id: TeamId;
  };
  createdAt: Date;
  createdBy: UserId | null;
}

export interface GrantTeamRoleBindingInput {
  bindingId: RoleBindingId;
  createdAt: Date;
  createdBy: UserId;
  membershipId: MembershipId;
  roleId: RoleDefinitionId;
  teamId: TeamId;
  userSelector:
    | {
        type: "userId";
        userId: UserId;
      }
    | {
        type: "email";
        email: string;
      };
}

export type GrantTeamRoleBindingResult =
  | {
      membershipCreated: boolean;
      outcome: "created" | "already_exists";
      roleBinding: IamRoleBinding;
    }
  | {
      outcome: "not_found";
      reason: "role_not_found" | "team_not_found" | "user_not_found";
    }
  | {
      outcome: "account_disabled";
      reason: "team_disabled" | "user_disabled";
    }
  | {
      outcome: "role_not_supported";
    }
  | {
      /** A service account owned by another team; see app/serviceAccount.ts. */
      outcome: "service_account_other_team";
    };

export interface ProvisionUserInput {
  bindingId: RoleBindingId;
  createdAt: Date;
  /** The provisioning admin, who is also the token's issuer. */
  createdBy: UserId;
  displayName: string | null;
  email: string;
  /** The admin's session; the token is minted only while it is live. */
  issuingSessionId: OAuthSessionId;
  membershipId: MembershipId;
  roleId: RoleDefinitionId;
  teamId: TeamId;
  token: {
    displayName: string;
    expiresAt: Date | null;
    id: ApiTokenId;
    maskedPrefix: string;
    tokenHash: string;
  };
  userId: UserId;
}

export type ProvisionUserResult =
  | {
      apiToken: ApiTokenMetadata;
      membershipCreated: boolean;
      outcome: "provisioned";
      roleBinding: IamRoleBinding;
      user: UserAccount;
    }
  | {
      outcome: "user_exists";
    }
  | Exclude<TeamRoleRejection, null>
  | {
      /** The admin's session ended after it authenticated; nothing was kept. */
      outcome: "session_revoked";
    };

export interface RotateServiceAccountTokenInput {
  createdAt: Date;
  /** The rotating admin, who is also the token's issuer. */
  issuedBy: UserId;
  /** The admin's session; the token is minted only while it is live. */
  issuingSessionId: OAuthSessionId;
  teamId: TeamId;
  token: {
    /** Null names the token after the account. */
    displayName: string | null;
    expiresAt: Date | null;
    id: ApiTokenId;
    maskedPrefix: string;
    tokenHash: string;
  };
  userId: UserId;
}

export type RotateServiceAccountTokenResult =
  | {
      apiToken: ApiTokenMetadata;
      outcome: "rotated";
      revokedApiTokenCount: number;
      user: UserAccount;
    }
  | {
      /** Not a service account this team owns; an unknown id answers the same. */
      outcome: "not_found";
      reason: "user_not_found";
    }
  | {
      outcome: "account_disabled";
      reason: "user_disabled";
    }
  | {
      /** The admin's session ended after it authenticated; nothing changed. */
      outcome: "session_revoked";
    };

type TeamRoleRejection =
  | {
      outcome: "not_found";
      reason: "role_not_found" | "team_not_found";
    }
  | {
      outcome: "account_disabled";
      reason: "team_disabled";
    }
  | {
      outcome: "role_not_supported";
    }
  | null;

export type DeleteTeamRoleBindingResult =
  | {
      membershipRemoved: boolean;
      outcome: "deleted";
      roleBinding: IamRoleBinding;
    }
  | {
      outcome: "not_found";
      reason: "role_binding_not_found";
    }
  | {
      outcome: "last_owner";
    };

export interface UpdateTeamRoleBindingInput {
  bindingId: RoleBindingId;
  roleId: RoleDefinitionId;
}

export type UpdateTeamRoleBindingResult =
  | {
      outcome: "updated";
      previousRole: IamRoleBinding["role"];
      roleBinding: IamRoleBinding;
    }
  | {
      outcome: "unchanged";
      roleBinding: IamRoleBinding;
    }
  | {
      outcome: "not_found";
      reason: "role_binding_not_found" | "role_not_found";
    }
  | {
      outcome: "role_binding_exists";
      roleBinding: IamRoleBinding;
    }
  | {
      outcome: "last_owner";
    }
  | {
      outcome: "role_not_supported";
    };

export type GetTeamRoleBindingResult =
  | {
      outcome: "found";
      roleBinding: IamRoleBinding;
    }
  | {
      outcome: "not_found";
      reason: "role_binding_not_found";
    };

export type ListTeamRoleBindingsResult =
  | {
      outcome: "found";
      roleBindings: IamRoleBinding[];
    }
  | {
      outcome: "not_found";
      reason: "team_not_found";
    };

export interface IamRepository {
  deleteTeamRoleBinding(
    bindingId: RoleBindingId,
  ): Promise<DeleteTeamRoleBindingResult>;
  getTeamRoleBinding(bindingId: RoleBindingId): Promise<GetTeamRoleBindingResult>;
  grantTeamRoleBinding(
    input: GrantTeamRoleBindingInput,
  ): Promise<GrantTeamRoleBindingResult>;
  listSystemRoles(): Promise<IamRoleWithPermissions[]>;
  listTeamRoleBindings(teamId: TeamId): Promise<ListTeamRoleBindingsResult>;
  /**
   * Creates a brand-new account, grants it the team role and mints its first
   * API token, in one transaction: any refusal leaves nothing behind.
   */
  provisionUser(input: ProvisionUserInput): Promise<ProvisionUserResult>;
  /**
   * Replaces a service account's token: every earlier credential of the
   * account ends and one new token is issued, in one transaction. A refusal
   * leaves the account exactly as it was.
   */
  rotateServiceAccountToken(
    input: RotateServiceAccountTokenInput,
  ): Promise<RotateServiceAccountTokenResult>;
  updateTeamRoleBinding(
    input: UpdateTeamRoleBindingInput,
  ): Promise<UpdateTeamRoleBindingResult>;
}

interface Queryable {
  query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

interface RoleWithPermissionsRow extends RoleDefinitionRow {
  permissions: ControlPlaneAction[];
}

interface RoleBindingDetailsRow extends RoleBindingRow {
  role_display_name: string;
  role_key: string;
  user_display_name: string | null;
  user_email: string;
  user_owner_team_id: string | null;
}

export function createPostgresIamRepository(
  pool: DatabasePool | Pool,
): IamRepository {
  return {
    async deleteTeamRoleBinding(bindingId) {
      return withTransaction(pool, async (client) => {
        const existing = await getTeamRoleBindingForUpdate(client, bindingId);

        if (!existing) {
          return {
            outcome: "not_found",
            reason: "role_binding_not_found",
          };
        }

        if (
          existing.role_definition_id === OWNER_ROLE_DEFINITION_ID &&
          existing.user_status === "active" &&
          isHonoredInTeam(
            { ownerTeamId: existing.user_owner_team_id as TeamId | null },
            existing.scope_id,
          )
        ) {
          const activeOwnerBindings = await lockActiveOwnerBindings(
            client,
            existing.scope_id as TeamId,
          );

          if (activeOwnerBindings.length <= 1) {
            return {
              outcome: "last_owner",
            };
          }
        }

        await client.query("DELETE FROM role_binding WHERE id = $1", [
          bindingId,
        ]);

        const remainingBindings = await client.query<{ id: string }>(
          `
            SELECT id
            FROM role_binding
            WHERE principal_type = 'user'
              AND principal_id = $1
              AND scope_type = 'team'
              AND scope_id = $2
            LIMIT 1
          `,
          [existing.principal_id, existing.scope_id],
        );

        let membershipRemoved = false;

        if (!remainingBindings.rows[0]) {
          const deletedMembership = await client.query<{ id: string }>(
            `
              DELETE FROM membership
              WHERE team_id = $1
                AND user_id = $2
              RETURNING id
            `,
            [existing.scope_id, existing.principal_id],
          );
          membershipRemoved = deletedMembership.rows[0] !== undefined;
        }

        return {
          membershipRemoved,
          outcome: "deleted",
          roleBinding: toIamRoleBinding(existing),
        };
      });
    },

    async getTeamRoleBinding(bindingId) {
      const existing = await getTeamRoleBindingById(pool, bindingId);

      if (!existing) {
        return {
          outcome: "not_found",
          reason: "role_binding_not_found",
        };
      }

      return {
        outcome: "found",
        roleBinding: toIamRoleBinding(existing),
      };
    },

    async grantTeamRoleBinding(input) {
      return withTransaction(pool, async (client) => {
        const user = await getUserForSelector(client, input.userSelector);

        if (!user) {
          return {
            outcome: "not_found",
            reason: "user_not_found",
          };
        }

        if (user.status === "disabled") {
          return {
            outcome: "account_disabled",
            reason: "user_disabled",
          };
        }

        const rejected = await checkTeamRole(client, input.teamId, input.roleId);
        if (rejected) {
          return rejected;
        }

        // Refused for the admin's sake: the binding would grant nothing.
        if (!isHonoredInTeam(user, input.teamId)) {
          return {
            outcome: "service_account_other_team",
          };
        }

        const granted = await grantCheckedTeamRole(client, {
          ...input,
          userId: user.id,
        });

        return {
          membershipCreated: granted.membershipCreated,
          outcome: granted.bindingInserted ? "created" : "already_exists",
          roleBinding: granted.roleBinding,
        };
      });
    },

    async listSystemRoles() {
      const result = await pool.query<RoleWithPermissionsRow>(
        `
          SELECT
            rd.*,
            COALESCE(
              array_agg(rp.action ORDER BY rp.action)
                FILTER (WHERE rp.action IS NOT NULL),
              ARRAY[]::TEXT[]
            ) AS permissions
          FROM role_definition rd
          LEFT JOIN role_permission rp ON rp.role_definition_id = rd.id
          WHERE rd.team_id IS NULL
            AND rd.is_system = true
          GROUP BY rd.id
          ORDER BY rd.key ASC
        `,
      );

      return result.rows.map((row) => ({
        permissions: row.permissions,
        role: mapRoleDefinitionRow(row),
      }));
    },

    async listTeamRoleBindings(teamId) {
      const team = await pool.query<{ id: string }>(
        "SELECT id FROM team WHERE id = $1",
        [teamId],
      );

      if (!team.rows[0]) {
        return {
          outcome: "not_found",
          reason: "team_not_found",
        };
      }

      const result = await pool.query<RoleBindingDetailsRow>(
        `
          SELECT
            rb.*,
            rd.key AS role_key,
            rd.display_name AS role_display_name,
            u.email AS user_email,
            u.display_name AS user_display_name,
            u.owner_team_id AS user_owner_team_id
          FROM role_binding rb
          JOIN role_definition rd ON rd.id = rb.role_definition_id
          JOIN user_account u ON u.id = rb.principal_id
          WHERE rb.principal_type = 'user'
            AND rb.scope_type = 'team'
            AND rb.scope_id = $1
          ORDER BY u.email ASC, rd.key ASC, rb.id ASC
        `,
        [teamId],
      );

      return {
        outcome: "found",
        roleBindings: result.rows.map(toIamRoleBinding),
      };
    },

    async provisionUser(input) {
      try {
        return await withTransaction(pool, async (client) => {
          const rejected = await checkTeamRole(
            client,
            input.teamId,
            input.roleId,
          );
          if (rejected) {
            return rejected;
          }

          // Provisioning mints a usable credential, so it is limited to
          // brand-new accounts: minting one for an existing user would let a
          // team admin impersonate them across every team they belong to.
          const userRow = await client.query<UserAccountRow>(
            `
              INSERT INTO user_account (
                id,
                email,
                display_name,
                owner_team_id,
                created_at,
                updated_at
              ) VALUES ($1, $2, $3, $5, $4, $4)
              ON CONFLICT (email) DO NOTHING
              RETURNING *
            `,
            [
              input.userId,
              canonicalizeEmail(input.email),
              input.displayName,
              input.createdAt,
              input.teamId,
            ],
          );
          if (!userRow.rows[0]) {
            return {
              outcome: "user_exists",
            };
          }

          const user = mapUserAccountRow(userRow.rows[0]);
          const granted = await grantCheckedTeamRole(client, {
            ...input,
            userId: user.id,
          });
          const token = await insertApiTokenFromSession(client, {
            ...input.token,
            createdAt: input.createdAt,
            issuingSession: {
              id: input.issuingSessionId,
              userId: input.createdBy,
            },
            ownerId: user.id,
          });
          if (!token) {
            throw new IssueRefused();
          }

          return {
            apiToken: mapApiTokenRow(token),
            membershipCreated: granted.membershipCreated,
            outcome: "provisioned",
            roleBinding: granted.roleBinding,
            user,
          };
        });
      } catch (error) {
        if (error instanceof IssueRefused) {
          return {
            outcome: "session_revoked",
          };
        }

        throw error;
      }
    },

    async rotateServiceAccountToken(input) {
      try {
        return await withTransaction(pool, async (client) => {
          // The row lock orders this against identity linking, which clears
          // the ownership, and against a second rotation. Eligibility is
          // decided under it, before anything is changed.
          const target = await client.query<UserAccountRow>(
            `
              SELECT *
              FROM user_account
              WHERE id = $1
                AND owner_team_id = $2
              FOR NO KEY UPDATE
            `,
            [input.userId, input.teamId],
          );
          const row = target.rows[0];
          if (!row) {
            return {
              outcome: "not_found",
              reason: "user_not_found",
            };
          }

          if (row.status === "disabled") {
            return {
              outcome: "account_disabled",
              reason: "user_disabled",
            };
          }

          await client.query(
            `
              UPDATE user_account
              SET credential_generation = credential_generation + 1,
                  updated_at = $2
              WHERE id = $1
            `,
            [input.userId, input.createdAt],
          );
          const revoked = await revokeUserCredentials(
            client,
            input.userId,
            input.createdAt,
          );
          const token = await insertApiTokenFromSession(client, {
            ...input.token,
            createdAt: input.createdAt,
            displayName: input.token.displayName ?? `${row.email} (rotated)`,
            issuingSession: {
              id: input.issuingSessionId,
              userId: input.issuedBy,
            },
            ownerId: input.userId,
          });
          if (!token) {
            throw new IssueRefused();
          }

          return {
            apiToken: mapApiTokenRow(token),
            outcome: "rotated",
            revokedApiTokenCount: revoked.apiTokenCount,
            user: mapUserAccountRow(row),
          };
        });
      } catch (error) {
        if (error instanceof IssueRefused) {
          return {
            outcome: "session_revoked",
          };
        }

        throw error;
      }
    },

    async updateTeamRoleBinding(input) {
      return withTransaction(pool, async (client) => {
        const existing = await getTeamRoleBindingForUpdate(
          client,
          input.bindingId,
        );

        if (!existing) {
          return {
            outcome: "not_found",
            reason: "role_binding_not_found",
          };
        }

        if (existing.role_definition_id === input.roleId) {
          return {
            outcome: "unchanged",
            roleBinding: toIamRoleBinding(existing),
          };
        }

        const role = await getRoleDefinition(client, input.roleId);

        if (!role) {
          return {
            outcome: "not_found",
            reason: "role_not_found",
          };
        }

        if (!role.isSystem || role.teamId !== null) {
          return {
            outcome: "role_not_supported",
          };
        }

        const teamId = existing.scope_id as TeamId;

        if (
          existing.role_definition_id === OWNER_ROLE_DEFINITION_ID &&
          existing.user_status === "active" &&
          isHonoredInTeam(
            { ownerTeamId: existing.user_owner_team_id as TeamId | null },
            existing.scope_id,
          )
        ) {
          const activeOwnerBindings = await lockActiveOwnerBindings(
            client,
            teamId,
          );

          if (activeOwnerBindings.length <= 1) {
            return {
              outcome: "last_owner",
            };
          }
        }

        const conflicting = await getTeamRoleBindingByUnique(client, {
          roleId: input.roleId,
          teamId,
          userId: existing.principal_id as UserId,
        });

        if (conflicting) {
          return {
            outcome: "role_binding_exists",
            roleBinding: toIamRoleBinding(conflicting),
          };
        }

        await client.query(
          "UPDATE role_binding SET role_definition_id = $1 WHERE id = $2",
          [input.roleId, input.bindingId],
        );

        const updated = await getTeamRoleBindingById(client, input.bindingId);

        return {
          outcome: "updated",
          previousRole: toIamRoleBinding(existing).role,
          roleBinding: toIamRoleBinding(
            requireValue(updated, "role_binding"),
          ),
        };
      });
    },
  };
}

/**
 * Thrown to roll back a transaction whose token the guard refused. Returning
 * a refusal instead would commit what the transaction had already written.
 */
class IssueRefused extends Error {}

async function checkTeamRole(
  client: Queryable,
  teamId: TeamId,
  roleId: RoleDefinitionId,
): Promise<TeamRoleRejection> {
  const team = await client.query<{ id: string; status: string }>(
    "SELECT id, status FROM team WHERE id = $1",
    [teamId],
  );
  const teamRow = team.rows[0];

  if (!teamRow) {
    return {
      outcome: "not_found",
      reason: "team_not_found",
    };
  }

  if (teamRow.status === "disabled") {
    return {
      outcome: "account_disabled",
      reason: "team_disabled",
    };
  }

  const role = await getRoleDefinition(client, roleId);

  if (!role) {
    return {
      outcome: "not_found",
      reason: "role_not_found",
    };
  }

  if (!role.isSystem || role.teamId !== null) {
    return {
      outcome: "role_not_supported",
    };
  }

  return null;
}

/** After checkTeamRole accepted the team and role. */
async function grantCheckedTeamRole(
  client: Queryable,
  input: {
    bindingId: RoleBindingId;
    createdAt: Date;
    createdBy: UserId;
    membershipId: MembershipId;
    roleId: RoleDefinitionId;
    teamId: TeamId;
    userId: UserId;
  },
): Promise<{
  bindingInserted: boolean;
  membershipCreated: boolean;
  roleBinding: IamRoleBinding;
}> {
  const membershipCreated = await insertMembershipIfMissing(client, {
    createdAt: input.createdAt,
    id: input.membershipId,
    teamId: input.teamId,
    userId: input.userId,
  });
  const bindingInserted = await insertRoleBindingIfMissing(client, input);
  const roleBinding = await getTeamRoleBindingByUnique(client, input);

  return {
    bindingInserted,
    membershipCreated,
    roleBinding: toIamRoleBinding(requireValue(roleBinding, "role_binding")),
  };
}

async function getTeamRoleBindingById(
  pool: Queryable,
  bindingId: RoleBindingId,
): Promise<RoleBindingDetailsRow | null> {
  const result = await pool.query<RoleBindingDetailsRow>(
    `
      SELECT
        rb.*,
        rd.key AS role_key,
        rd.display_name AS role_display_name,
        u.email AS user_email,
        u.display_name AS user_display_name,
        u.owner_team_id AS user_owner_team_id
      FROM role_binding rb
      JOIN role_definition rd ON rd.id = rb.role_definition_id
      JOIN user_account u ON u.id = rb.principal_id
      WHERE rb.id = $1
        AND rb.principal_type = 'user'
        AND rb.scope_type = 'team'
    `,
    [bindingId],
  );

  return result.rows[0] ?? null;
}

async function getTeamRoleBindingForUpdate(
  pool: Queryable,
  bindingId: RoleBindingId,
): Promise<
  (RoleBindingDetailsRow & { user_status: UserAccount["status"] }) | null
> {
  const result = await pool.query<
    RoleBindingDetailsRow & { user_status: UserAccount["status"] }
  >(
    `
      SELECT
        rb.*,
        rd.key AS role_key,
        rd.display_name AS role_display_name,
        u.email AS user_email,
        u.display_name AS user_display_name,
        u.owner_team_id AS user_owner_team_id,
        u.status AS user_status
      FROM role_binding rb
      JOIN role_definition rd ON rd.id = rb.role_definition_id
      JOIN user_account u ON u.id = rb.principal_id
      WHERE rb.id = $1
        AND rb.principal_type = 'user'
        AND rb.scope_type = 'team'
      FOR UPDATE OF rb
    `,
    [bindingId],
  );

  return result.rows[0] ?? null;
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
        u.display_name AS user_display_name,
        u.owner_team_id AS user_owner_team_id
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

async function getUserForSelector(
  pool: Queryable,
  selector: GrantTeamRoleBindingInput["userSelector"],
): Promise<UserAccount | null> {
  const result = await pool.query<UserAccountRow>(
    selector.type === "email"
      ? "SELECT * FROM user_account WHERE email = $1"
      : "SELECT * FROM user_account WHERE id = $1",
    [
      selector.type === "email"
        ? canonicalizeEmail(selector.email)
        : selector.userId,
    ],
  );

  return result.rows[0] ? mapUserAccountRow(result.rows[0]) : null;
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

/**
 * The owners the last-owner guard counts: active, and honored in this team.
 * An owner binding held by another team's service account grants nothing
 * (see app/serviceAccount.ts), so it is not an owner to be left with.
 */
async function lockActiveOwnerBindings(
  pool: Queryable,
  teamId: TeamId,
): Promise<Array<{ id: string }>> {
  const result = await pool.query<{ id: string }>(
    `
      SELECT rb.id
      FROM role_binding rb
      JOIN user_account u ON u.id = rb.principal_id
      WHERE rb.principal_type = 'user'
        AND rb.role_definition_id = $1
        AND rb.scope_type = 'team'
        AND rb.scope_id = $2
        AND u.status = 'active'
        AND (u.owner_team_id IS NULL OR u.owner_team_id = rb.scope_id)
      FOR UPDATE OF rb
    `,
    [OWNER_ROLE_DEFINITION_ID, teamId],
  );

  return result.rows;
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
      ownerTeamId: row.user_owner_team_id as TeamId | null,
    },
  };
}

function requireValue<T>(value: T | null, name: string): T {
  if (!value) {
    throw new Error(`expected ${name} row to be returned`);
  }

  return value;
}
