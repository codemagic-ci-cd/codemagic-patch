import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import { dispatchWorkflow } from "../app/githubActionsService";
import {
  decryptIntegrationSecret,
  encryptIntegrationSecret,
  integrationTokenLast4,
} from "../app/integrationEncryption";
import type {
  DeploymentGitHubActionsDispatchRouteHandler,
  DeploymentGitHubActionsReadRouteHandler,
  DeploymentGitHubActionsUpsertRouteHandler,
  TeamGitHubIntegrationReadRouteHandler,
  TeamGitHubIntegrationRevokeRouteHandler,
  TeamGitHubIntegrationUpsertRouteHandler,
} from "../app/types";
import type { DeploymentId, TeamId, UserId } from "../domain";
import {
  createPostgresGitHubIntegrationRepository,
  type GitHubIntegrationRepository,
} from "../repositories/githubIntegrationRepository";

interface DeploymentTeamRow {
  id: string;
  team_id: string;
}

export function createGitHubIntegrationHandlers(options: {
  apiBaseUrl?: string;
  encryptionKey?: Buffer;
  fetch?: typeof globalThis.fetch;
  pool: Pool;
  repository?: GitHubIntegrationRepository;
}): {
  deploymentGitHubActionsDispatchHandler: DeploymentGitHubActionsDispatchRouteHandler;
  deploymentGitHubActionsReadHandler: DeploymentGitHubActionsReadRouteHandler;
  deploymentGitHubActionsUpsertHandler: DeploymentGitHubActionsUpsertRouteHandler;
  teamGitHubIntegrationReadHandler: TeamGitHubIntegrationReadRouteHandler;
  teamGitHubIntegrationRevokeHandler: TeamGitHubIntegrationRevokeRouteHandler;
  teamGitHubIntegrationUpsertHandler: TeamGitHubIntegrationUpsertRouteHandler;
} {
  const repository =
    options.repository ?? createPostgresGitHubIntegrationRepository(options.pool);

  async function getDeploymentTeamId(
    deploymentId: string,
  ): Promise<string | null> {
    const result = await options.pool.query<DeploymentTeamRow>(
      `SELECT id, team_id FROM deployment WHERE id = $1`,
      [deploymentId],
    );
    return result.rows[0]?.team_id ?? null;
  }

  async function teamExists(teamId: string): Promise<boolean> {
    const result = await options.pool.query<{ id: string }>(
      `SELECT id FROM team WHERE id = $1`,
      [teamId],
    );
    return result.rows.length > 0;
  }

  return {
    async teamGitHubIntegrationReadHandler(teamId) {
      if (!(await teamExists(teamId))) {
        return {
          outcome: "not_found",
          reason: "team_not_found",
        };
      }

      const integration = await repository.getActiveTeamIntegration(
        teamId as TeamId,
      );
      if (!integration) {
        return {
          configured: false,
          outcome: "found",
        };
      }

      return {
        configured: true,
        outcome: "found",
        tokenLast4: integration.tokenLast4,
      };
    },

    async teamGitHubIntegrationUpsertHandler(input) {
      if (!(await teamExists(input.teamId))) {
        return {
          outcome: "not_found",
          reason: "team_not_found",
        };
      }

      if (!options.encryptionKey) {
        return {
          outcome: "failed",
          reason: "integration_encryption_unconfigured",
        };
      }

      const createdAt = new Date();
      const integration = await repository.upsertTeamIntegration({
        createdAt,
        createdBy: input.createdBy as UserId,
        id: randomUUID(),
        teamId: input.teamId as TeamId,
        tokenCiphertext: encryptIntegrationSecret(
          input.token,
          options.encryptionKey,
        ),
        tokenLast4: integrationTokenLast4(input.token),
      });

      return {
        outcome: "updated",
        tokenLast4: integration.tokenLast4,
      };
    },

    async teamGitHubIntegrationRevokeHandler(input) {
      if (!(await teamExists(input.teamId))) {
        return {
          outcome: "not_found",
          reason: "team_not_found",
        };
      }

      const revoked = await repository.revokeTeamIntegration(
        input.teamId as TeamId,
        new Date(),
      );
      if (!revoked) {
        return {
          outcome: "not_found",
          reason: "integration_not_found",
        };
      }

      return { outcome: "revoked" };
    },

    async deploymentGitHubActionsReadHandler(deploymentId) {
      const teamId = await getDeploymentTeamId(deploymentId);
      if (!teamId) {
        return {
          outcome: "not_found",
          reason: "deployment_not_found",
        };
      }

      const link = await repository.getDeploymentLink(deploymentId as DeploymentId);
      if (!link) {
        return {
          outcome: "not_found",
          reason: "link_not_found",
        };
      }

      return {
        link: {
          defaultRef: link.defaultRef,
          deploymentId: link.deploymentId,
          enabled: link.enabled,
          owner: link.owner,
          repo: link.repo,
          workflowFile: link.workflowFile,
        },
        outcome: "found",
      };
    },

    async deploymentGitHubActionsUpsertHandler(input) {
      const teamId = await getDeploymentTeamId(input.deploymentId);
      if (!teamId) {
        return {
          outcome: "not_found",
          reason: "deployment_not_found",
        };
      }

      const link = await repository.upsertDeploymentLink({
        defaultRef: input.defaultRef,
        deploymentId: input.deploymentId as DeploymentId,
        enabled: input.enabled,
        owner: input.owner,
        repo: input.repo,
        workflowFile: input.workflowFile,
      });

      return {
        link: {
          defaultRef: link.defaultRef,
          deploymentId: link.deploymentId,
          enabled: link.enabled,
          owner: link.owner,
          repo: link.repo,
          workflowFile: link.workflowFile,
        },
        outcome: "updated",
      };
    },

    async deploymentGitHubActionsDispatchHandler(input) {
      const teamId = await getDeploymentTeamId(input.deploymentId);
      if (!teamId) {
        return {
          outcome: "not_found",
          reason: "deployment_not_found",
        };
      }

      const integration = await repository.getActiveTeamIntegration(
        teamId as TeamId,
      );
      if (!integration) {
        return {
          outcome: "not_found",
          reason: "integration_not_found",
        };
      }

      const link = await repository.getDeploymentLink(
        input.deploymentId as DeploymentId,
      );
      if (!link) {
        return {
          outcome: "not_found",
          reason: "link_not_found",
        };
      }

      if (!link.enabled) {
        return {
          outcome: "not_found",
          reason: "link_disabled",
        };
      }

      if (!options.encryptionKey) {
        return {
          outcome: "failed",
          reason: "integration_encryption_unconfigured",
        };
      }

      const accessToken = decryptIntegrationSecret(
        integration.tokenCiphertext,
        options.encryptionKey,
      );

      const dispatchInputs: Record<string, string | boolean> = {
        platform: input.platform,
      };

      if (input.releaseNotes !== undefined) {
        dispatchInputs.release_notes = input.releaseNotes;
      }
      if (input.targetBinaryVersion !== undefined) {
        dispatchInputs.target_binary_version = input.targetBinaryVersion;
      }
      if (input.rolloutPercentage !== undefined && input.rolloutPercentage !== 100) {
        dispatchInputs.rollout_percentage = String(input.rolloutPercentage);
      }
      if (input.mandatory === true) {
        dispatchInputs.mandatory = true;
      }

      const dispatched = await dispatchWorkflow({
        accessToken,
        apiBaseUrl: options.apiBaseUrl,
        defaultRef: link.defaultRef,
        fetch: options.fetch,
        inputs: dispatchInputs,
        owner: link.owner,
        repo: link.repo,
        workflowFile: link.workflowFile,
      });

      if (dispatched.outcome === "success") {
        return {
          actionsUrl: dispatched.actionsUrl,
          outcome: "dispatched",
        };
      }

      return {
        message: dispatched.message,
        outcome: "github_error",
        reason: dispatched.outcome,
      };
    },
  };
}
