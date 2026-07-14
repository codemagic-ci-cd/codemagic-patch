import type { Pool } from "pg";

import type {
  ControlPlaneAction,
  MembershipId,
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
  user: Pick<UserAccount, "displayName" | "email" | "id">;
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
    };

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
          existing.user_status === "active"
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

        const team = await client.query<{ id: string; status: string }>(
          "SELECT id, status FROM team WHERE id = $1",
          [input.teamId],
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

        const membershipCreated = await insertMembershipIfMissing(client, {
          createdAt: input.createdAt,
          id: input.membershipId,
          teamId: input.teamId,
          userId: user.id,
        });
        const bindingInserted = await insertRoleBindingIfMissing(client, {
          bindingId: input.bindingId,
          createdAt: input.createdAt,
          createdBy: input.createdBy,
          roleId: input.roleId,
          teamId: input.teamId,
          userId: user.id,
        });
        const roleBinding = await getTeamRoleBindingByUnique(client, {
          roleId: input.roleId,
          teamId: input.teamId,
          userId: user.id,
        });

        return {
          membershipCreated,
          outcome: bindingInserted ? "created" : "already_exists",
          roleBinding: toIamRoleBinding(
            requireValue(roleBinding, "role_binding"),
          ),
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
            u.display_name AS user_display_name
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
          existing.user_status === "active"
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
        u.display_name AS user_display_name
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
    },
  };
}

function requireValue<T>(value: T | null, name: string): T {
  if (!value) {
    throw new Error(`expected ${name} row to be returned`);
  }

  return value;
}
