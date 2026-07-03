import type { FastifyInstance } from "fastify";

import { createProblem, sendProblem } from "../../app/problemDetails";
import {
  authorizeResourceAccess,
  authorizeVisibleResourceAccess,
  createDeploymentNotFoundProblem,
  createTeamNotFoundProblem,
  requireControlPlanePrincipal,
  sendPreparedJsonResponse,
} from "./routeSupport";
import {
  createDeploymentGitHubActionsLinkNotFoundProblem,
  createGitHubIntegrationNotConfiguredProblem,
  parseDeploymentGitHubActionsDispatchBody,
  parseDeploymentGitHubActionsUpsertBody,
  parseTeamGitHubIntegrationUpsertBody,
} from "./githubActionsSupport";
import type {
  ApiRoutesOptions,
  DeploymentGitHubActionsDispatchBody,
  DeploymentGitHubActionsUpsertBody,
  DeploymentParams,
  TeamGitHubIntegrationUpsertBody,
  TeamParams,
} from "./routeTypes";

export function registerGitHubActionsRoutes(
  controlPlane: FastifyInstance,
  options: ApiRoutesOptions,
): void {
  controlPlane.get<{ Params: TeamParams }>(
    "/teams/:teamId/integrations/github",
    async (request, reply) => {
      if (!options.teamGitHubIntegrationReadHandler) {
        return sendProblem(
          reply,
          createProblem({
            detail: "GitHub integration is not implemented",
            status: 501,
          }),
        );
      }

      const authorization = await authorizeVisibleResourceAccess(
        options.authorizationService,
        request.controlPlanePrincipal,
        "iam.manage",
        () =>
          options.authorizationService!.resolveTeamScope(request.params.teamId),
        createTeamNotFoundProblem({
          outcome: "not_found",
          reason: "team_not_found",
        }),
      );
      if (authorization.kind === "error") {
        return sendProblem(reply, authorization.problem);
      }

      const result = await options.teamGitHubIntegrationReadHandler(
        request.params.teamId,
      );

      if (result.outcome === "not_found") {
        return sendProblem(
          reply,
          createTeamNotFoundProblem({
            outcome: "not_found",
            reason: result.reason,
          }),
        );
      }

      if (!result.configured) {
        return { configured: false };
      }

      return {
        configured: true,
        token_last4: result.tokenLast4,
      };
    },
  );

  controlPlane.put<{ Body: TeamGitHubIntegrationUpsertBody; Params: TeamParams }>(
    "/teams/:teamId/integrations/github",
    async (request, reply) => {
      if (!options.teamGitHubIntegrationUpsertHandler) {
        return sendProblem(
          reply,
          createProblem({
            detail: "GitHub integration is not implemented",
            status: 501,
          }),
        );
      }

      const parsed = parseTeamGitHubIntegrationUpsertBody(request.body);
      if (parsed.kind === "error") {
        return sendProblem(reply, parsed.problem);
      }

      const authorization = await authorizeVisibleResourceAccess(
        options.authorizationService,
        request.controlPlanePrincipal,
        "iam.manage",
        () =>
          options.authorizationService!.resolveTeamScope(request.params.teamId),
        createTeamNotFoundProblem({
          outcome: "not_found",
          reason: "team_not_found",
        }),
      );
      if (authorization.kind === "error") {
        return sendProblem(reply, authorization.problem);
      }

      const principal = requireControlPlanePrincipal(request);
      const result = await options.teamGitHubIntegrationUpsertHandler({
        createdBy: principal.userId,
        teamId: request.params.teamId,
        token: parsed.value.token,
      });

      if (result.outcome === "not_found") {
        return sendProblem(
          reply,
          createTeamNotFoundProblem({
            outcome: "not_found",
            reason: result.reason,
          }),
        );
      }

      if (result.outcome === "failed") {
        return sendProblem(
          reply,
          createProblem({
            detail: "INTEGRATION_ENCRYPTION_KEY is not configured on the server",
            status: 503,
            typeSuffix: "integration-encryption-unconfigured",
          }),
        );
      }

      reply.status(200);
      return {
        configured: true,
        token_last4: result.tokenLast4,
      };
    },
  );

  controlPlane.delete<{ Params: TeamParams }>(
    "/teams/:teamId/integrations/github",
    async (request, reply) => {
      if (!options.teamGitHubIntegrationRevokeHandler) {
        return sendProblem(
          reply,
          createProblem({
            detail: "GitHub integration is not implemented",
            status: 501,
          }),
        );
      }

      const authorization = await authorizeVisibleResourceAccess(
        options.authorizationService,
        request.controlPlanePrincipal,
        "iam.manage",
        () =>
          options.authorizationService!.resolveTeamScope(request.params.teamId),
        createTeamNotFoundProblem({
          outcome: "not_found",
          reason: "team_not_found",
        }),
      );
      if (authorization.kind === "error") {
        return sendProblem(reply, authorization.problem);
      }

      const result = await options.teamGitHubIntegrationRevokeHandler({
        teamId: request.params.teamId,
      });

      if (result.outcome === "not_found") {
        return sendProblem(
          reply,
          createProblem({
            detail:
              result.reason === "integration_not_found"
                ? "GitHub integration is not configured for this team"
                : "team was not found",
            status: 404,
            typeSuffix: "not-found",
          }),
        );
      }

      reply.status(204);
      return reply.send();
    },
  );

  controlPlane.get<{ Params: DeploymentParams }>(
    "/deployments/:deploymentId/github-actions",
    async (request, reply) => {
      if (!options.deploymentGitHubActionsReadHandler) {
        return sendProblem(
          reply,
          createProblem({
            detail: "GitHub Actions deployment linking is not implemented",
            status: 501,
          }),
        );
      }

      const authorization = await authorizeResourceAccess(
        options.authorizationService,
        request.controlPlanePrincipal,
        "release.deploy",
        () =>
          options.authorizationService!.resolveDeploymentScope(
            request.params.deploymentId,
          ),
        createDeploymentNotFoundProblem(),
      );
      if (authorization.kind === "error") {
        return sendProblem(reply, authorization.problem);
      }

      const result = await options.deploymentGitHubActionsReadHandler(
        request.params.deploymentId,
      );

      if (result.outcome === "not_found") {
        if (result.reason === "deployment_not_found") {
          return sendProblem(reply, createDeploymentNotFoundProblem());
        }

        return sendProblem(
          reply,
          createDeploymentGitHubActionsLinkNotFoundProblem(),
        );
      }

      return {
        default_ref: result.link.defaultRef,
        deployment_id: result.link.deploymentId,
        enabled: result.link.enabled,
        owner: result.link.owner,
        repo: result.link.repo,
        workflow_file: result.link.workflowFile,
      };
    },
  );

  controlPlane.put<{ Body: DeploymentGitHubActionsUpsertBody; Params: DeploymentParams }>(
    "/deployments/:deploymentId/github-actions",
    async (request, reply) => {
      if (!options.deploymentGitHubActionsUpsertHandler) {
        return sendProblem(
          reply,
          createProblem({
            detail: "GitHub Actions deployment linking is not implemented",
            status: 501,
          }),
        );
      }

      const parsed = parseDeploymentGitHubActionsUpsertBody(request.body);
      if (parsed.kind === "error") {
        return sendProblem(reply, parsed.problem);
      }

      const authorization = await authorizeResourceAccess(
        options.authorizationService,
        request.controlPlanePrincipal,
        "release.deploy",
        () =>
          options.authorizationService!.resolveDeploymentScope(
            request.params.deploymentId,
          ),
        createDeploymentNotFoundProblem(),
      );
      if (authorization.kind === "error") {
        return sendProblem(reply, authorization.problem);
      }

      const result = await options.deploymentGitHubActionsUpsertHandler({
        defaultRef: parsed.value.defaultRef,
        deploymentId: request.params.deploymentId,
        enabled: parsed.value.enabled,
        owner: parsed.value.owner,
        repo: parsed.value.repo,
        workflowFile: parsed.value.workflowFile,
      });

      if (result.outcome === "not_found") {
        return sendProblem(reply, createDeploymentNotFoundProblem());
      }

      reply.status(200);
      return {
        default_ref: result.link.defaultRef,
        deployment_id: result.link.deploymentId,
        enabled: result.link.enabled,
        owner: result.link.owner,
        repo: result.link.repo,
        workflow_file: result.link.workflowFile,
      };
    },
  );

  controlPlane.post<{
    Body: DeploymentGitHubActionsDispatchBody;
    Params: DeploymentParams;
  }>(
    "/deployments/:deploymentId/github-actions/dispatch",
    async (request, reply) => {
      if (!options.deploymentGitHubActionsDispatchHandler) {
        return sendProblem(
          reply,
          createProblem({
            detail: "GitHub Actions dispatch is not implemented",
            status: 501,
          }),
        );
      }

      const parsed = parseDeploymentGitHubActionsDispatchBody(request.body);
      if (parsed.kind === "error") {
        return sendProblem(reply, parsed.problem);
      }

      const authorization = await authorizeResourceAccess(
        options.authorizationService,
        request.controlPlanePrincipal,
        "release.deploy",
        () =>
          options.authorizationService!.resolveDeploymentScope(
            request.params.deploymentId,
          ),
        createDeploymentNotFoundProblem(),
      );
      if (authorization.kind === "error") {
        return sendProblem(reply, authorization.problem);
      }

      const result = await options.deploymentGitHubActionsDispatchHandler({
        deploymentId: request.params.deploymentId,
        mandatory: parsed.value.mandatory,
        platform: parsed.value.platform,
        releaseNotes: parsed.value.releaseNotes,
        rolloutPercentage: parsed.value.rolloutPercentage,
        targetBinaryVersion: parsed.value.targetBinaryVersion,
      });

      if (result.outcome === "not_found") {
        if (result.reason === "deployment_not_found") {
          return sendProblem(reply, createDeploymentNotFoundProblem());
        }

        if (result.reason === "integration_not_found") {
          return sendProblem(reply, createGitHubIntegrationNotConfiguredProblem());
        }

        return sendProblem(
          reply,
          createDeploymentGitHubActionsLinkNotFoundProblem(),
        );
      }

      if (result.outcome === "failed") {
        return sendProblem(
          reply,
          createProblem({
            detail: "INTEGRATION_ENCRYPTION_KEY is not configured on the server",
            status: 503,
            typeSuffix: "integration-encryption-unconfigured",
          }),
        );
      }

      if (result.outcome === "github_error") {
        const status =
          result.reason === "unauthorized"
            ? 401
            : result.reason === "not_found"
              ? 404
              : 502;
        return sendProblem(
          reply,
          createProblem({
            detail: result.message,
            status,
            typeSuffix: "github-actions-dispatch-failed",
          }),
        );
      }

      return sendPreparedJsonResponse(reply, {
        body: {
          actions_url: result.actionsUrl,
        },
        status: 202,
      });
    },
  );
}
