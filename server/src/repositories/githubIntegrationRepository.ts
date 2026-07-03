import type { Pool } from "pg";

import { withTransaction } from "../db";
import type { DeploymentId, TeamId, UserId } from "../domain";

export interface TeamGitHubIntegration {
  createdAt: Date;
  createdBy: UserId | null;
  id: string;
  teamId: TeamId;
  tokenCiphertext: string;
  tokenLast4: string;
}

export interface DeploymentGitHubActionsLink {
  defaultRef: string;
  deploymentId: DeploymentId;
  enabled: boolean;
  owner: string;
  repo: string;
  updatedAt: Date;
  workflowFile: string;
}

export interface UpsertTeamGitHubIntegrationInput {
  createdAt: Date;
  createdBy: UserId | null;
  id: string;
  teamId: TeamId;
  tokenCiphertext: string;
  tokenLast4: string;
}

export interface UpsertDeploymentGitHubActionsInput {
  defaultRef: string;
  deploymentId: DeploymentId;
  enabled: boolean;
  owner: string;
  repo: string;
  workflowFile: string;
}

export interface GitHubIntegrationRepository {
  getActiveTeamIntegration(
    teamId: TeamId,
  ): Promise<TeamGitHubIntegration | null>;
  revokeTeamIntegration(teamId: TeamId, revokedAt: Date): Promise<boolean>;
  upsertTeamIntegration(
    input: UpsertTeamGitHubIntegrationInput,
  ): Promise<TeamGitHubIntegration>;
  getDeploymentLink(
    deploymentId: DeploymentId,
  ): Promise<DeploymentGitHubActionsLink | null>;
  upsertDeploymentLink(
    input: UpsertDeploymentGitHubActionsInput,
  ): Promise<DeploymentGitHubActionsLink>;
}

interface TeamGitHubIntegrationRow {
  created_at: Date;
  created_by: string | null;
  id: string;
  team_id: string;
  token_ciphertext: string;
  token_last4: string;
}

interface DeploymentGitHubActionsRow {
  default_ref: string;
  deployment_id: string;
  enabled: boolean;
  owner: string;
  repo: string;
  updated_at: Date;
  workflow_file: string;
}

function mapTeamIntegrationRow(
  row: TeamGitHubIntegrationRow,
): TeamGitHubIntegration {
  return {
    createdAt: row.created_at,
    createdBy: row.created_by as UserId | null,
    id: row.id,
    teamId: row.team_id as TeamId,
    tokenCiphertext: row.token_ciphertext,
    tokenLast4: row.token_last4,
  };
}

function mapDeploymentLinkRow(
  row: DeploymentGitHubActionsRow,
): DeploymentGitHubActionsLink {
  return {
    defaultRef: row.default_ref,
    deploymentId: row.deployment_id as DeploymentId,
    enabled: row.enabled,
    owner: row.owner,
    repo: row.repo,
    updatedAt: row.updated_at,
    workflowFile: row.workflow_file,
  };
}

export function createPostgresGitHubIntegrationRepository(
  pool: Pool,
): GitHubIntegrationRepository {
  return {
    async getActiveTeamIntegration(teamId) {
      const result = await pool.query<TeamGitHubIntegrationRow>(
        `
          SELECT id, team_id, token_ciphertext, token_last4, created_by, created_at
          FROM team_github_integration
          WHERE team_id = $1
            AND revoked_at IS NULL
          ORDER BY created_at DESC
          LIMIT 1
        `,
        [teamId],
      );

      const row = result.rows[0];
      return row ? mapTeamIntegrationRow(row) : null;
    },

    async revokeTeamIntegration(teamId, revokedAt) {
      const result = await pool.query(
        `
          UPDATE team_github_integration
          SET revoked_at = $2
          WHERE team_id = $1
            AND revoked_at IS NULL
        `,
        [teamId, revokedAt],
      );

      return (result.rowCount ?? 0) > 0;
    },

    async upsertTeamIntegration(input) {
      return withTransaction(pool, async (client) => {
        await client.query(
          `
            UPDATE team_github_integration
            SET revoked_at = $2
            WHERE team_id = $1
              AND revoked_at IS NULL
          `,
          [input.teamId, input.createdAt],
        );

        const inserted = await client.query<TeamGitHubIntegrationRow>(
          `
            INSERT INTO team_github_integration (
              id,
              team_id,
              token_ciphertext,
              token_last4,
              created_by,
              created_at
            ) VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id, team_id, token_ciphertext, token_last4, created_by, created_at
          `,
          [
            input.id,
            input.teamId,
            input.tokenCiphertext,
            input.tokenLast4,
            input.createdBy,
            input.createdAt,
          ],
        );

        const row = inserted.rows[0];
        if (!row) {
          throw new Error("failed to insert team github integration");
        }

        return mapTeamIntegrationRow(row);
      });
    },

    async getDeploymentLink(deploymentId) {
      const result = await pool.query<DeploymentGitHubActionsRow>(
        `
          SELECT
            deployment_id,
            owner,
            repo,
            workflow_file,
            default_ref,
            enabled,
            updated_at
          FROM deployment_github_actions
          WHERE deployment_id = $1
        `,
        [deploymentId],
      );

      const row = result.rows[0];
      return row ? mapDeploymentLinkRow(row) : null;
    },

    async upsertDeploymentLink(input) {
      const result = await pool.query<DeploymentGitHubActionsRow>(
        `
          INSERT INTO deployment_github_actions (
            deployment_id,
            owner,
            repo,
            workflow_file,
            default_ref,
            enabled,
            updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, now())
          ON CONFLICT (deployment_id) DO UPDATE
          SET
            owner = EXCLUDED.owner,
            repo = EXCLUDED.repo,
            workflow_file = EXCLUDED.workflow_file,
            default_ref = EXCLUDED.default_ref,
            enabled = EXCLUDED.enabled,
            updated_at = now()
          RETURNING
            deployment_id,
            owner,
            repo,
            workflow_file,
            default_ref,
            enabled,
            updated_at
        `,
        [
          input.deploymentId,
          input.owner,
          input.repo,
          input.workflowFile,
          input.defaultRef,
          input.enabled,
        ],
      );

      const row = result.rows[0];
      if (!row) {
        throw new Error("failed to upsert deployment github actions link");
      }

      return mapDeploymentLinkRow(row);
    },
  };
}
