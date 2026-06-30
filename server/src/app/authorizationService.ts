import type { Pool } from "pg";

import type { ControlPlanePrincipal } from "./controlPlaneAuth";
import type {
  AuthorizationResourceScope,
  AuthorizationResult,
  AppId,
  ControlPlaneAction,
  DeploymentId,
  ReleaseId,
  Team,
  TeamId,
  UserAccount,
  UserId,
} from "../domain";
import type { DatabasePool } from "../db";
import {
  mapTeamRow,
  mapUserAccountRow,
  type TeamRow,
  type UserAccountRow,
} from "../repositories/rowMappers";

export type ResourceScopeLookupResult =
  | {
      outcome: "found";
      scope: AuthorizationResourceScope;
    }
  | {
      outcome: "not_found";
    };

export type VisibleTeamsResult =
  | {
      outcome: "found";
      teams: Team[];
    }
  | {
      outcome: "account_disabled";
      reason: "user_disabled";
    }
  | {
      outcome: "not_found";
      reason: "user_not_found";
    };

export interface AuthorizationService {
  authorize(
    principal: ControlPlanePrincipal,
    action: ControlPlaneAction,
    scope: AuthorizationResourceScope,
  ): Promise<AuthorizationResult>;
  listVisibleTeams(
    principal: ControlPlanePrincipal,
  ): Promise<VisibleTeamsResult>;
  resolveAppScope(appId: string): Promise<ResourceScopeLookupResult>;
  resolveDeploymentScope(
    deploymentId: string,
  ): Promise<ResourceScopeLookupResult>;
  resolveReleaseScope(releaseId: string): Promise<ResourceScopeLookupResult>;
  resolveTeamScope(teamId: string): Promise<ResourceScopeLookupResult>;
}

interface Queryable {
  query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

export function createAuthorizationService(
  pool: DatabasePool | Pool,
): AuthorizationService {
  return {
    async authorize(principal, action, scope) {
      const user = await getUserById(pool, principal.userId as UserId);
      if (!user) {
        return {
          outcome: "not_found",
        };
      }

      if (user.status === "disabled") {
        return {
          outcome: "account_disabled",
          reason: "user_disabled",
        };
      }

      const team = await getTeamById(pool, scope.teamId);
      if (!team) {
        return {
          outcome: "not_found",
        };
      }

      if (team.status === "disabled") {
        return {
          outcome: "account_disabled",
          reason: "team_disabled",
        };
      }

      if (await hasPermission(pool, user.id, team.id, action)) {
        return {
          outcome: "authorized",
        };
      }

      return {
        outcome: "forbidden",
      };
    },

    async listVisibleTeams(principal) {
      const user = await getUserById(pool, principal.userId as UserId);
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

      const teams = await pool.query<TeamRow>(
        `
          SELECT DISTINCT t.*
          FROM team t
          JOIN membership m ON m.team_id = t.id
          JOIN role_binding rb
            ON rb.principal_type = 'user'
           AND rb.principal_id = m.user_id
           AND rb.scope_type = 'team'
           AND rb.scope_id = t.id
          JOIN role_permission rp
            ON rp.role_definition_id = rb.role_definition_id
           AND rp.action = 'team.read'
          WHERE m.user_id = $1
            AND t.status = 'active'
          ORDER BY t.created_at ASC, t.id ASC
        `,
        [user.id],
      );

      return {
        outcome: "found",
        teams: teams.rows.map(mapTeamRow),
      };
    },

    async resolveAppScope(appId) {
      const result = await pool.query<{ id: string; team_id: string }>(
        "SELECT id, team_id FROM app WHERE id = $1",
        [appId],
      );
      const row = result.rows[0];

      return row
        ? {
            outcome: "found",
            scope: {
              appId: row.id as AppId,
              teamId: row.team_id as TeamId,
              type: "app",
            },
          }
        : { outcome: "not_found" };
    },

    async resolveDeploymentScope(deploymentId) {
      const result = await pool.query<{ id: string; team_id: string }>(
        "SELECT id, team_id FROM deployment WHERE id = $1",
        [deploymentId],
      );
      const row = result.rows[0];

      return row
        ? {
            outcome: "found",
            scope: {
              deploymentId: row.id as DeploymentId,
              teamId: row.team_id as TeamId,
              type: "deployment",
            },
          }
        : { outcome: "not_found" };
    },

    async resolveReleaseScope(releaseId) {
      const result = await pool.query<{ id: string; team_id: string }>(
        "SELECT id, team_id FROM release WHERE id = $1",
        [releaseId],
      );
      const row = result.rows[0];

      return row
        ? {
            outcome: "found",
            scope: {
              releaseId: row.id as ReleaseId,
              teamId: row.team_id as TeamId,
              type: "release",
            },
          }
        : { outcome: "not_found" };
    },

    async resolveTeamScope(teamId) {
      const team = await getTeamById(pool, teamId as TeamId);

      return team
        ? {
            outcome: "found",
            scope: {
              teamId: team.id,
              type: "team",
            },
          }
        : { outcome: "not_found" };
    },
  };
}

async function getUserById(
  pool: Queryable,
  userId: UserId,
): Promise<UserAccount | null> {
  const result = await pool.query<UserAccountRow>(
    "SELECT * FROM user_account WHERE id = $1",
    [userId],
  );

  return result.rows[0] ? mapUserAccountRow(result.rows[0]) : null;
}

async function getTeamById(
  pool: Queryable,
  teamId: TeamId,
): Promise<Team | null> {
  const result = await pool.query<TeamRow>(
    "SELECT * FROM team WHERE id = $1",
    [teamId],
  );

  return result.rows[0] ? mapTeamRow(result.rows[0]) : null;
}

async function hasPermission(
  pool: Queryable,
  userId: UserId,
  teamId: TeamId,
  action: ControlPlaneAction,
): Promise<boolean> {
  const result = await pool.query<{ allowed: number }>(
    `
      SELECT 1 AS allowed
      FROM membership m
      JOIN role_binding rb
        ON rb.principal_type = 'user'
       AND rb.principal_id = m.user_id
       AND rb.scope_type = 'team'
       AND rb.scope_id = m.team_id
      JOIN role_permission rp
        ON rp.role_definition_id = rb.role_definition_id
       AND rp.action = $3
      WHERE m.user_id = $1
        AND m.team_id = $2
      LIMIT 1
    `,
    [userId, teamId, action],
  );

  return result.rows[0] !== undefined;
}
