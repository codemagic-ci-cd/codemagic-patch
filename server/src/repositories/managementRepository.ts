import type { Pool } from "pg";

import type {
  App,
  AppId,
  Deployment,
  DeploymentId,
  Team,
  TeamId,
} from "../domain";
import type { DatabasePool } from "../db";
import { withTransaction } from "../db";
import {
  mapAppRow,
  mapDeploymentRow,
  mapTeamRow,
  type AppRow,
  type DeploymentRow,
  type TeamRow,
} from "./rowMappers";

export interface CreateTeamInput {
  createdAt: Date;
  id: TeamId;
  name: string;
}

export type CreateTeamResult =
  | {
      outcome: "created";
      team: Team;
    }
  | {
      outcome: "conflict";
      reason: "team_name_exists";
    };

export interface CreateAppWithDefaultDeploymentsInput {
  appId: AppId;
  createdAt: Date;
  deploymentIds: {
    production: DeploymentId;
    staging: DeploymentId;
  };
  deploymentKeys: {
    production: string;
    staging: string;
  };
  name: string;
  requireCodeSigning: boolean;
  teamId: TeamId;
}

export interface CreateDeploymentInput {
  appId: AppId;
  createdAt: Date;
  deploymentId: DeploymentId;
  deploymentKey: string;
  name: string;
}

export type CreateAppWithDefaultDeploymentsResult =
  | {
      app: App;
      deployments: Deployment[];
      outcome: "created";
    }
  | {
      outcome: "conflict";
      reason:
        | "app_name_exists"
        | "deployment_key_exists"
        | "generated_id_exists";
    }
  | {
      outcome: "not_found";
      reason: "team_not_found";
    };

export type CreateDeploymentResult =
  | {
      deployment: Deployment;
      outcome: "created";
    }
  | {
      outcome: "conflict";
      reason:
        | "deployment_name_exists"
        | "deployment_key_exists"
        | "generated_id_exists";
    }
  | {
      outcome: "not_found";
      reason: "app_not_found";
    };

export interface TransferAppInput {
  destinationTeamId: TeamId;
  updatedAt: Date;
}

export type TransferAppResult =
  | {
      app: App;
      before: App;
      deployments: Deployment[];
      outcome: "transferred";
    }
  | {
      outcome: "not_found";
      reason: "app_not_found" | "destination_team_not_found";
    }
  | {
      activeJob: {
        jobId: string;
        releaseId: string;
        status: "queued" | "running";
      };
      outcome: "conflict";
      reason: "active_release_job_exists";
    }
  | {
      outcome: "conflict";
      reason: "app_name_exists";
    }
  | {
      outcome: "invalid";
      reason: "same_team";
    };

interface ActiveReleaseJob {
  jobId: string;
  releaseId: string;
  status: "queued" | "running";
}

interface SourceBundleDependentActiveJob extends ActiveReleaseJob {
  sourceReleaseId: string;
}

export interface UpdateAppInput {
  name?: string;
  requireCodeSigning?: boolean;
  updatedAt: Date;
}

export type UpdateAppResult =
  | {
      app: App;
      before: App;
      outcome: "updated";
    }
  | {
      outcome: "conflict";
      reason: "app_name_exists";
    }
  | {
      outcome: "not_found";
      reason: "app_not_found";
    };

export interface UpdateDeploymentInput {
  name: string;
  updatedAt: Date;
}

export type UpdateDeploymentResult =
  | {
      before: Deployment;
      deployment: Deployment;
      outcome: "updated";
    }
  | {
      outcome: "conflict";
      reason: "deployment_name_exists";
    }
  | {
      outcome: "not_found";
      reason: "deployment_not_found";
    };

export type ClearDeploymentResult =
  | {
      deletedReleaseCount: number;
      deployment: Deployment;
      outcome: "cleared";
      staticState: DeploymentClearStaticState;
    }
  | {
      activeJob: {
        jobId: string;
        releaseId: string;
        status: "queued" | "running";
      };
      outcome: "conflict";
      reason: "active_release_job_exists";
    }
  | {
      outcome: "not_found";
      reason: "deployment_not_found";
    };

export interface DeploymentClearStaticState {
  binaryVersions: string[];
  deploymentKey: string;
  packageHashes: string[];
}

export interface DeploymentDeleteStaticState
  extends DeploymentClearStaticState {
  artifactStorageKeys: string[];
  releaseIds: string[];
}

export interface AppDeleteStaticState {
  deployments: DeploymentDeleteStaticState[];
}

export interface ClearDeploymentOptions {
  beforeDeleteStaticState?: (
    staticState: DeploymentClearStaticState,
  ) => Promise<void>;
}

export interface DeleteDeploymentOptions {
  beforeDeleteStaticState?: (
    staticState: DeploymentDeleteStaticState,
  ) => Promise<void>;
}

export interface DeleteAppOptions {
  beforeDeleteStaticState?: (
    staticState: AppDeleteStaticState,
  ) => Promise<void>;
}

export type DeleteAppResult =
  | {
      app: App;
      deletedDeploymentCount: number;
      deletedReleaseCount: number;
      outcome: "deleted";
      staticState: AppDeleteStaticState;
    }
  | {
      activeJob: ActiveReleaseJob;
      outcome: "conflict";
      reason: "active_release_job_exists";
    }
  | {
      activeJob: SourceBundleDependentActiveJob;
      outcome: "conflict";
      reason: "source_release_active_job_exists";
    }
  | {
      outcome: "not_found";
      reason: "app_not_found";
    };

export type DeleteDeploymentResult =
  | {
      deletedReleaseCount: number;
      deployment: Deployment;
      outcome: "deleted";
      staticState: DeploymentDeleteStaticState;
    }
  | {
      activeJob: ActiveReleaseJob;
      outcome: "conflict";
      reason: "active_release_job_exists";
    }
  | {
      activeJob: SourceBundleDependentActiveJob;
      outcome: "conflict";
      reason: "source_release_active_job_exists";
    }
  | {
      outcome: "not_found";
      reason: "deployment_not_found";
    };

export type GetTeamResult =
  | {
      outcome: "found";
      team: Team;
    }
  | {
      outcome: "not_found";
      reason: "team_not_found";
    };

export type GetAppResult =
  | {
      app: App;
      outcome: "found";
    }
  | {
      outcome: "not_found";
      reason: "app_not_found";
    };

export type ListAppsForTeamResult =
  | {
      apps: App[];
      outcome: "found";
    }
  | {
      outcome: "not_found";
      reason: "team_not_found";
    };

export type ListDeploymentsForAppResult =
  | {
      deployments: Deployment[];
      outcome: "found";
    }
  | {
      outcome: "not_found";
      reason: "app_not_found";
    };

export interface ManagementRepository {
  clearDeployment(
    deploymentId: DeploymentId,
    options?: ClearDeploymentOptions,
  ): Promise<ClearDeploymentResult>;
  createAppWithDefaultDeployments(
    input: CreateAppWithDefaultDeploymentsInput,
  ): Promise<CreateAppWithDefaultDeploymentsResult>;
  createDeployment(input: CreateDeploymentInput): Promise<CreateDeploymentResult>;
  createTeam(input: CreateTeamInput): Promise<CreateTeamResult>;
  deleteApp(
    appId: AppId,
    options?: DeleteAppOptions,
  ): Promise<DeleteAppResult>;
  deleteDeployment(
    deploymentId: DeploymentId,
    options?: DeleteDeploymentOptions,
  ): Promise<DeleteDeploymentResult>;
  getAppById(appId: AppId): Promise<GetAppResult>;
  getTeamById(teamId: TeamId): Promise<GetTeamResult>;
  listAppsForTeam(teamId: TeamId): Promise<ListAppsForTeamResult>;
  listDeploymentsForApp(
    appId: AppId,
  ): Promise<ListDeploymentsForAppResult>;
  listTeams(): Promise<Team[]>;
  transferApp(
    appId: AppId,
    input: TransferAppInput,
  ): Promise<TransferAppResult>;
  updateApp(appId: AppId, input: UpdateAppInput): Promise<UpdateAppResult>;
  updateDeployment(
    deploymentId: DeploymentId,
    input: UpdateDeploymentInput,
  ): Promise<UpdateDeploymentResult>;
}

interface Queryable {
  query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

export function createPostgresManagementRepository(
  pool: DatabasePool | Pool,
): ManagementRepository {
  return {
    async createTeam(input) {
      try {
        const result = await pool.query<TeamRow>(
          `
            INSERT INTO team (id, name, created_at, updated_at)
            VALUES ($1, $2, $3, $3)
            RETURNING *
          `,
          [input.id, input.name, input.createdAt],
        );

        return {
          outcome: "created",
          team: mapTeamRow(requireRow(result.rows[0], "team")),
        };
      } catch (error) {
        if (uniqueConstraint(error) === "idx_team_name") {
          return {
            outcome: "conflict",
            reason: "team_name_exists",
          };
        }

        throw error;
      }
    },

    async listTeams() {
      const result = await pool.query<TeamRow>(
        `
          SELECT *
          FROM team
          ORDER BY created_at ASC, id ASC
        `,
      );

      return result.rows.map(mapTeamRow);
    },

    async getTeamById(teamId) {
      const result = await pool.query<TeamRow>(
        "SELECT * FROM team WHERE id = $1",
        [teamId],
      );
      const row = result.rows[0];

      if (!row) {
        return {
          outcome: "not_found",
          reason: "team_not_found",
        };
      }

      return {
        outcome: "found",
        team: mapTeamRow(row),
      };
    },

    async createAppWithDefaultDeployments(input) {
      try {
        return await withTransaction(pool, async (client) => {
          const teamExists = await existsById(client, "team", input.teamId);
          if (!teamExists) {
            return {
              outcome: "not_found",
              reason: "team_not_found",
            };
          }

          const appResult = await client.query<AppRow>(
            `
              INSERT INTO app (
                id,
                team_id,
                name,
                require_code_signing,
                created_at,
                updated_at
              ) VALUES ($1, $2, $3, $4, $5, $5)
              RETURNING *
            `,
            [
              input.appId,
              input.teamId,
              input.name,
              input.requireCodeSigning,
              input.createdAt,
            ],
          );

          const deploymentResult = await client.query<DeploymentRow>(
            `
              INSERT INTO deployment (
                id,
                app_id,
                team_id,
                name,
                deployment_key,
                created_at,
                updated_at
              ) VALUES
                ($1, $2, $3, 'Staging', $4, $5, $5),
                ($6, $2, $3, 'Production', $7, $5, $5)
              RETURNING *
            `,
            [
              input.deploymentIds.staging,
              input.appId,
              input.teamId,
              input.deploymentKeys.staging,
              input.createdAt,
              input.deploymentIds.production,
              input.deploymentKeys.production,
            ],
          );

          return {
            app: mapAppRow(requireRow(appResult.rows[0], "app")),
            deployments: orderDefaultDeployments(
              deploymentResult.rows.map(mapDeploymentRow),
            ),
            outcome: "created",
          };
        });
      } catch (error) {
        const constraint = uniqueConstraint(error);

        if (constraint === "idx_app_team_name") {
          return {
            outcome: "conflict",
            reason: "app_name_exists",
          };
        }

        if (constraint === "idx_deployment_key") {
          return {
            outcome: "conflict",
            reason: "deployment_key_exists",
          };
        }

        if (constraint === "app_pkey" || constraint === "deployment_pkey") {
          return {
            outcome: "conflict",
            reason: "generated_id_exists",
          };
        }

        throw error;
      }
    },

    async createDeployment(input) {
      try {
        const result = await withTransaction(pool, async (client) => {
          const appResult = await client.query<AppRow>(
            "SELECT * FROM app WHERE id = $1",
            [input.appId],
          );
          const app = appResult.rows[0];

          if (!app) {
            return {
              outcome: "not_found",
              reason: "app_not_found",
            } satisfies CreateDeploymentResult;
          }

          const deploymentResult = await client.query<DeploymentRow>(
            `
              INSERT INTO deployment (
                id,
                app_id,
                team_id,
                name,
                deployment_key,
                created_at,
                updated_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $6)
              RETURNING *
            `,
            [
              input.deploymentId,
              input.appId,
              app.team_id,
              input.name,
              input.deploymentKey,
              input.createdAt,
            ],
          );

          return {
            deployment: mapDeploymentRow(
              requireRow(deploymentResult.rows[0], "deployment"),
            ),
            outcome: "created",
          } satisfies CreateDeploymentResult;
        });

        return result;
      } catch (error) {
        const constraint = uniqueConstraint(error);

        if (constraint === "idx_deployment_app_name") {
          return {
            outcome: "conflict",
            reason: "deployment_name_exists",
          };
        }

        if (constraint === "idx_deployment_key") {
          return {
            outcome: "conflict",
            reason: "deployment_key_exists",
          };
        }

        if (constraint === "deployment_pkey") {
          return {
            outcome: "conflict",
            reason: "generated_id_exists",
          };
        }

        throw error;
      }
    },

    async updateApp(appId, input) {
      try {
        return await withTransaction(pool, async (client) => {
          const beforeResult = await client.query<AppRow>(
            "SELECT * FROM app WHERE id = $1 FOR UPDATE",
            [appId],
          );
          const before = beforeResult.rows[0];

          if (!before) {
            return {
              outcome: "not_found",
              reason: "app_not_found",
            } satisfies UpdateAppResult;
          }

          const updated = await client.query<AppRow>(
            `
              UPDATE app
              SET
                name = $2,
                require_code_signing = $3,
                updated_at = $4
              WHERE id = $1
              RETURNING *
            `,
            [
              appId,
              input.name ?? before.name,
              input.requireCodeSigning ?? before.require_code_signing,
              input.updatedAt,
            ],
          );

          return {
            app: mapAppRow(requireRow(updated.rows[0], "app")),
            before: mapAppRow(before),
            outcome: "updated",
          } satisfies UpdateAppResult;
        });
      } catch (error) {
        if (uniqueConstraint(error) === "idx_app_team_name") {
          return {
            outcome: "conflict",
            reason: "app_name_exists",
          };
        }

        throw error;
      }
    },

    async transferApp(appId, input) {
      try {
        return await withTransaction(pool, async (client) => {
          const beforeResult = await client.query<AppRow>(
            "SELECT * FROM app WHERE id = $1 FOR UPDATE",
            [appId],
          );
          const before = beforeResult.rows[0];

          if (!before) {
            return {
              outcome: "not_found",
              reason: "app_not_found",
            } satisfies TransferAppResult;
          }

          const destinationTeamExists = await existsById(
            client,
            "team",
            input.destinationTeamId,
          );
          if (!destinationTeamExists) {
            return {
              outcome: "not_found",
              reason: "destination_team_not_found",
            } satisfies TransferAppResult;
          }

          if (before.team_id === input.destinationTeamId) {
            return {
              outcome: "invalid",
              reason: "same_team",
            } satisfies TransferAppResult;
          }

          const activeJob = await findActiveAppJob(client, appId);
          if (activeJob) {
            return {
              activeJob,
              outcome: "conflict",
              reason: "active_release_job_exists",
            } satisfies TransferAppResult;
          }

          const appResult = await client.query<AppRow>(
            `
              UPDATE app
              SET team_id = $2,
                  updated_at = $3
              WHERE id = $1
              RETURNING *
            `,
            [appId, input.destinationTeamId, input.updatedAt],
          );

          const deploymentResult = await client.query<DeploymentRow>(
            `
              UPDATE deployment
              SET team_id = $2,
                  updated_at = $3
              WHERE app_id = $1
              RETURNING *
            `,
            [appId, input.destinationTeamId, input.updatedAt],
          );

          await client.query(
            `
              UPDATE release
              SET team_id = $2
              WHERE app_id = $1
            `,
            [appId, input.destinationTeamId],
          );

          await client.query(
            `
              UPDATE metric_event
              SET team_id = $2
              WHERE app_id = $1
            `,
            [appId, input.destinationTeamId],
          );

          return {
            app: mapAppRow(requireRow(appResult.rows[0], "app")),
            before: mapAppRow(before),
            deployments: deploymentResult.rows.map(mapDeploymentRow),
            outcome: "transferred",
          } satisfies TransferAppResult;
        });
      } catch (error) {
        if (uniqueConstraint(error) === "idx_app_team_name") {
          return {
            outcome: "conflict",
            reason: "app_name_exists",
          };
        }

        throw error;
      }
    },

    async updateDeployment(deploymentId, input) {
      try {
        return await withTransaction(pool, async (client) => {
          const beforeResult = await client.query<DeploymentRow>(
            "SELECT * FROM deployment WHERE id = $1 FOR UPDATE",
            [deploymentId],
          );
          const before = beforeResult.rows[0];

          if (!before) {
            return {
              outcome: "not_found",
              reason: "deployment_not_found",
            } satisfies UpdateDeploymentResult;
          }

          const updated = await client.query<DeploymentRow>(
            `
              UPDATE deployment
              SET
                name = $2,
                updated_at = $3
              WHERE id = $1
              RETURNING *
            `,
            [deploymentId, input.name, input.updatedAt],
          );

          return {
            before: mapDeploymentRow(before),
            deployment: mapDeploymentRow(
              requireRow(updated.rows[0], "deployment"),
            ),
            outcome: "updated",
          } satisfies UpdateDeploymentResult;
        });
      } catch (error) {
        if (uniqueConstraint(error) === "idx_deployment_app_name") {
          return {
            outcome: "conflict",
            reason: "deployment_name_exists",
          };
        }

        throw error;
      }
    },

    async deleteDeployment(deploymentId, options = {}) {
      return withTransaction(pool, async (client) => {
        const deploymentResult = await client.query<DeploymentRow>(
          "SELECT * FROM deployment WHERE id = $1 FOR UPDATE",
          [deploymentId],
        );
        const deploymentRow = deploymentResult.rows[0];

        if (!deploymentRow) {
          return {
            outcome: "not_found",
            reason: "deployment_not_found",
          };
        }

        const activeJob = await findActiveDeploymentJob(client, deploymentId);
        if (activeJob) {
          return {
            activeJob,
            outcome: "conflict",
            reason: "active_release_job_exists",
          };
        }

        const staticState = await loadDeploymentDeleteStaticState(
          client,
          deploymentRow,
        );
        const dependentJob = await findActiveSourceBundleDependentJob(
          client,
          staticState.releaseIds,
        );
        if (dependentJob) {
          return {
            activeJob: dependentJob,
            outcome: "conflict",
            reason: "source_release_active_job_exists",
          };
        }

        await options.beforeDeleteStaticState?.(staticState);

        await client.query("DELETE FROM deployment WHERE id = $1", [
          deploymentId,
        ]);

        return {
          deletedReleaseCount: staticState.releaseIds.length,
          deployment: mapDeploymentRow(deploymentRow),
          outcome: "deleted",
          staticState,
        };
      });
    },

    async deleteApp(appId, options = {}) {
      return withTransaction(pool, async (client) => {
        const appResult = await client.query<AppRow>(
          "SELECT * FROM app WHERE id = $1 FOR UPDATE",
          [appId],
        );
        const appRow = appResult.rows[0];

        if (!appRow) {
          return {
            outcome: "not_found",
            reason: "app_not_found",
          };
        }

        const activeJob = await findActiveAppJob(client, appId);
        if (activeJob) {
          return {
            activeJob,
            outcome: "conflict",
            reason: "active_release_job_exists",
          };
        }

        const deploymentResult = await client.query<DeploymentRow>(
          `
            SELECT *
            FROM deployment
            WHERE app_id = $1
            ORDER BY created_at ASC, id ASC
            FOR UPDATE
          `,
          [appId],
        );
        const deployments = await Promise.all(
          deploymentResult.rows.map((deployment) =>
            loadDeploymentDeleteStaticState(client, deployment),
          ),
        );
        const dependentJob = await findActiveSourceBundleDependentJob(
          client,
          deployments.flatMap((deployment) => deployment.releaseIds),
        );
        if (dependentJob) {
          return {
            activeJob: dependentJob,
            outcome: "conflict",
            reason: "source_release_active_job_exists",
          };
        }

        const staticState = {
          deployments,
        };
        await options.beforeDeleteStaticState?.(staticState);

        await client.query("DELETE FROM app WHERE id = $1", [appId]);

        return {
          app: mapAppRow(appRow),
          deletedDeploymentCount: deployments.length,
          deletedReleaseCount: deployments.reduce(
            (total, deployment) => total + deployment.releaseIds.length,
            0,
          ),
          outcome: "deleted",
          staticState,
        };
      });
    },

    async clearDeployment(deploymentId, options = {}) {
      return withTransaction(pool, async (client) => {
        const deploymentResult = await client.query<DeploymentRow>(
          "SELECT * FROM deployment WHERE id = $1 FOR UPDATE",
          [deploymentId],
        );
        const deploymentRow = deploymentResult.rows[0];

        if (!deploymentRow) {
          return {
            outcome: "not_found",
            reason: "deployment_not_found",
          };
        }

        const activeJob = await findActiveDeploymentJob(client, deploymentId);
        if (activeJob) {
          return {
            activeJob,
            outcome: "conflict",
            reason: "active_release_job_exists",
          };
        }

        const staticState = await loadDeploymentClearStaticState(
          client,
          deploymentRow,
        );
        await options.beforeDeleteStaticState?.(staticState);

        await client.query("DELETE FROM metric_event WHERE deployment_id = $1", [
          deploymentId,
        ]);
        await client.query(
          "DELETE FROM binary_version_fingerprint WHERE deployment_id = $1",
          [deploymentId],
        );
        const deletedReleases = await client.query<{ id: string }>(
          "DELETE FROM release WHERE deployment_id = $1 RETURNING id",
          [deploymentId],
        );

        return {
          deletedReleaseCount: deletedReleases.rows.length,
          deployment: mapDeploymentRow(deploymentRow),
          outcome: "cleared",
          staticState,
        };
      });
    },

    async listAppsForTeam(teamId) {
      const teamExists = await existsById(pool, "team", teamId);
      if (!teamExists) {
        return {
          outcome: "not_found",
          reason: "team_not_found",
        };
      }

      const result = await pool.query<AppRow>(
        `
          SELECT *
          FROM app
          WHERE team_id = $1
          ORDER BY created_at ASC, id ASC
        `,
        [teamId],
      );

      return {
        apps: result.rows.map(mapAppRow),
        outcome: "found",
      };
    },

    async getAppById(appId) {
      const result = await pool.query<AppRow>(
        "SELECT * FROM app WHERE id = $1",
        [appId],
      );
      const row = result.rows[0];

      if (!row) {
        return {
          outcome: "not_found",
          reason: "app_not_found",
        };
      }

      return {
        app: mapAppRow(row),
        outcome: "found",
      };
    },

    async listDeploymentsForApp(appId) {
      const appExists = await existsById(pool, "app", appId);
      if (!appExists) {
        return {
          outcome: "not_found",
          reason: "app_not_found",
        };
      }

      const result = await pool.query<DeploymentRow>(
        `
          SELECT *
          FROM deployment
          WHERE app_id = $1
          ORDER BY created_at ASC, id ASC
        `,
        [appId],
      );

      return {
        deployments: result.rows.map(mapDeploymentRow),
        outcome: "found",
      };
    },
  };
}

async function loadDeploymentClearStaticState(
  client: Queryable,
  deployment: DeploymentRow,
): Promise<DeploymentClearStaticState> {
  const binaryVersionResult = await client.query<{ binary_version: string }>(
    `
      SELECT DISTINCT binary_version
      FROM (
        SELECT target_binary_version AS binary_version
        FROM release
        WHERE deployment_id = $1
        UNION
        SELECT rt.binary_version
        FROM release_target rt
        JOIN release r
          ON r.id = rt.release_id
        WHERE r.deployment_id = $1
      ) known_binary_versions
      ORDER BY binary_version ASC
    `,
    [deployment.id],
  );
  const packageHashResult = await client.query<{ target_package_hash: string }>(
    `
      SELECT DISTINCT target_package_hash
      FROM release
      WHERE deployment_id = $1
        AND target_package_hash IS NOT NULL
      ORDER BY target_package_hash ASC
    `,
    [deployment.id],
  );

  return {
    binaryVersions: binaryVersionResult.rows.map((row) => row.binary_version),
    deploymentKey: deployment.deployment_key,
    packageHashes: packageHashResult.rows.map((row) => row.target_package_hash),
  };
}

async function loadDeploymentDeleteStaticState(
  client: Queryable,
  deployment: DeploymentRow,
): Promise<DeploymentDeleteStaticState> {
  const clearState = await loadDeploymentClearStaticState(client, deployment);
  const releaseResult = await client.query<{ id: string }>(
    `
      SELECT id
      FROM release
      WHERE deployment_id = $1
      ORDER BY created_at ASC, id ASC
      FOR UPDATE
    `,
    [deployment.id],
  );
  const artifactResult = await client.query<{ storage_key: string }>(
    `
      SELECT ra.storage_key
      FROM release_artifact ra
      JOIN release r
        ON r.id = ra.release_id
      WHERE r.deployment_id = $1
      ORDER BY ra.storage_key ASC
    `,
    [deployment.id],
  );

  return {
    ...clearState,
    artifactStorageKeys: artifactResult.rows.map((row) => row.storage_key),
    releaseIds: releaseResult.rows.map((row) => row.id),
  };
}

async function existsById(
  client: Queryable,
  tableName: "app" | "team",
  id: string,
): Promise<boolean> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM ${tableName} WHERE id = $1`,
    [id],
  );

  return result.rows[0] !== undefined;
}

async function findActiveDeploymentJob(
  client: Queryable,
  deploymentId: DeploymentId,
): Promise<{
  jobId: string;
  releaseId: string;
  status: "queued" | "running";
} | null> {
  const result = await client.query<{
    id: string;
    release_id: string;
    status: "queued" | "running";
  }>(
    `
      SELECT id, release_id, status
      FROM release_job
      WHERE deployment_id = $1
        AND status IN ('queued', 'running')
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `,
    [deploymentId],
  );
  const row = result.rows[0];

  return row
    ? {
        jobId: row.id,
        releaseId: row.release_id,
        status: row.status,
      }
    : null;
}

async function findActiveSourceBundleDependentJob(
  client: Queryable,
  sourceReleaseIds: string[],
): Promise<SourceBundleDependentActiveJob | null> {
  if (sourceReleaseIds.length === 0) {
    return null;
  }

  const result = await client.query<{
    id: string;
    release_id: string;
    source_bundle_release_id: string;
    status: "queued" | "running";
  }>(
    `
      SELECT
        rj.id,
        rj.release_id,
        r.source_bundle_release_id,
        rj.status
      FROM release r
      JOIN release_job rj
        ON rj.release_id = r.id
      WHERE r.source_bundle_release_id = ANY($1::text[])
        AND rj.status IN ('queued', 'running')
      ORDER BY rj.created_at ASC, rj.id ASC
      LIMIT 1
    `,
    [sourceReleaseIds],
  );
  const row = result.rows[0];

  return row
    ? {
        jobId: row.id,
        releaseId: row.release_id,
        sourceReleaseId: row.source_bundle_release_id,
        status: row.status,
      }
    : null;
}

async function findActiveAppJob(
  client: Queryable,
  appId: AppId,
): Promise<{
  jobId: string;
  releaseId: string;
  status: "queued" | "running";
} | null> {
  const result = await client.query<{
    id: string;
    release_id: string;
    status: "queued" | "running";
  }>(
    `
      SELECT rj.id, rj.release_id, rj.status
      FROM release_job rj
      JOIN deployment d
        ON d.id = rj.deployment_id
      WHERE d.app_id = $1
        AND rj.status IN ('queued', 'running')
      ORDER BY rj.created_at ASC, rj.id ASC
      LIMIT 1
    `,
    [appId],
  );
  const row = result.rows[0];

  return row
    ? {
        jobId: row.id,
        releaseId: row.release_id,
        status: row.status,
      }
    : null;
}

function orderDefaultDeployments(deployments: Deployment[]): Deployment[] {
  return [...deployments].sort((left, right) => {
    return deploymentSortRank(left.name) - deploymentSortRank(right.name);
  });
}

function deploymentSortRank(name: string): number {
  if (name === "Staging") {
    return 0;
  }

  if (name === "Production") {
    return 1;
  }

  return 2;
}

function uniqueConstraint(error: unknown): string | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    typeof error.constraint === "string"
  ) {
    return error.constraint;
  }

  return null;
}

function requireRow<T>(row: T | undefined, tableName: string): T {
  if (!row) {
    throw new Error(`Expected ${tableName} row to exist`);
  }

  return row;
}
