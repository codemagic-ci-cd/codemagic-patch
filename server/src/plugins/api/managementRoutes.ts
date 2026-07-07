import type { FastifyInstance } from "fastify";

import { createProblem, sendProblem } from "../../app/problemDetails";
import {
  parseAppCreateInput,
  parseAppTransferInput,
  parseAppUpdateInput,
  parseDeploymentCreateInput,
  parseDeploymentUpdateInput,
  parseTeamCreateInput,
  prepareAppCreateResponse,
  prepareAppDeleteResponse,
  prepareAppTransferResponse,
  prepareAppUpdateResponse,
  prepareDeploymentCreateResponse,
  prepareDeploymentDeleteResponse,
  prepareDeploymentUpdateResponse,
} from "./managementSupport";
import {
  authorizeResourceAccess,
  completeIdempotentRequestIfStarted,
  createAccountDisabledProblem,
  createAppNotFoundProblem,
  createDeploymentNotFoundProblem,
  createManagementNotEnabledProblem,
  createRequestBodyHash,
  createTeamNotFoundProblem,
  listVisibleTeamsForPrincipal,
  parseIdempotencyKey,
  requireControlPlanePrincipal,
  sendPreparedJsonResponse,
  startIdempotentRequestIfPresent,
  writeAuditEventIfConfigured,
} from "./routeSupport";
import { singleFieldValidationProblem } from "./routeValidation";
import type {
  ApiRoutesOptions,
  AppCreateBody,
  AppParams,
  AppTransferBody,
  AppUpdateBody,
  DeploymentCreateBody,
  DeploymentParams,
  DeploymentUpdateBody,
  TeamCreateBody,
  TeamParams,
} from "./routeTypes";
import {
  toActiveJobWire,
  toAppWire,
  toDeploymentWire,
  toTeamWire,
} from "./wireSerializers";

export function registerManagementRoutes(
  controlPlane: FastifyInstance,
  options: ApiRoutesOptions,
): void {
  controlPlane.post<{ Body: TeamCreateBody }>(
    "/teams",
    async (request, reply) => {
      if (!options.teamCreateHandler) {
        return sendProblem(reply, createManagementNotEnabledProblem());
      }

      const input = parseTeamCreateInput(request.body);
      if (input.kind === "error") {
        return sendProblem(reply, input.problem);
      }

      const userId =
        options.authorizationService === undefined
          ? undefined
          : requireControlPlanePrincipal(request).userId;
      const result = await options.teamCreateHandler({
        ...input.value,
        ...(userId ? { userId } : {}),
      });

      if (result.outcome === "created") {
        await writeAuditEventIfConfigured(
          options.auditEventWriteHandler,
          request,
          {
            action: "team.created",
            afterState: result.team as unknown as Record<string, unknown>,
            beforeState: null,
            resourceId: result.team.id,
            resourceType: "team",
            result: "success",
            teamId: result.team.id,
          },
        );

        reply.status(201);
        return {
          team: toTeamWire(result.team),
        };
      }

      if (result.outcome === "not_found") {
        return sendProblem(
          reply,
          createProblem({
            detail: "user was not found",
            extensions: {
              outcome: result.outcome,
              reason: result.reason,
            },
            status: 404,
            typeSuffix: "not-found",
          }),
        );
      }

      if (result.outcome === "account_disabled") {
        return sendProblem(
          reply,
          createAccountDisabledProblem(result.reason),
        );
      }

      if (result.outcome === "forbidden") {
        return sendProblem(
          reply,
          createProblem({
            detail: "principal is not authorized to create teams",
            status: 403,
            typeSuffix: "forbidden",
          }),
        );
      }

      return sendProblem(
        reply,
        createProblem({
          detail: "team name already exists",
          status: 409,
          typeSuffix: "team-conflict",
        }),
      );
    },
  );

  controlPlane.get("/teams", async (request, reply) => {
    if (!options.teamListHandler) {
      return sendProblem(reply, createManagementNotEnabledProblem());
    }

    const visibleTeams = await listVisibleTeamsForPrincipal(
      options.authorizationService,
      request.controlPlanePrincipal,
    );
    if (visibleTeams.kind === "error") {
      return sendProblem(reply, visibleTeams.problem);
    }

    if (visibleTeams.kind === "success") {
      return {
        teams: visibleTeams.teams.map(toTeamWire),
      };
    }

    const result = await options.teamListHandler();
    return {
      teams: result.teams.map(toTeamWire),
    };
  });

  controlPlane.get<{ Params: TeamParams }>(
    "/teams/:teamId",
    async (request, reply) => {
      if (!options.teamReadHandler) {
        return sendProblem(reply, createManagementNotEnabledProblem());
      }

      const authorization = await authorizeResourceAccess(
        options.authorizationService,
        request.controlPlanePrincipal,
        "team.read",
        () =>
          options.authorizationService!.resolveTeamScope(
            request.params.teamId,
          ),
        createTeamNotFoundProblem({
          outcome: "not_found",
          reason: "team_not_found",
        }),
      );
      if (authorization.kind === "error") {
        return sendProblem(reply, authorization.problem);
      }

      const result = await options.teamReadHandler(request.params.teamId);

      if (result.outcome === "found") {
        return {
          team: toTeamWire(result.team),
        };
      }

      return sendProblem(reply, createTeamNotFoundProblem(result));
    },
  );

  controlPlane.post<{ Body: AppCreateBody }>(
    "/apps",
    async (request, reply) => {
      if (!options.appCreateHandler) {
        return sendProblem(reply, createManagementNotEnabledProblem());
      }

      const input = parseAppCreateInput(request.body);
      if (input.kind === "error") {
        return sendProblem(reply, input.problem);
      }

      const authorization = await authorizeResourceAccess(
        options.authorizationService,
        request.controlPlanePrincipal,
        "app.create",
        () =>
          options.authorizationService!.resolveTeamScope(
            input.value.teamId,
          ),
        createTeamNotFoundProblem({
          outcome: "not_found",
          reason: "team_not_found",
        }),
      );
      if (authorization.kind === "error") {
        return sendProblem(reply, authorization.problem);
      }

      const idempotency = await startIdempotentRequestIfPresent(
        request,
        options.idempotencyHandler,
        createRequestBodyHash(input.value),
      );
      if (idempotency.kind === "terminal") {
        return sendPreparedJsonResponse(reply, idempotency.response);
      }

      const result = await options.appCreateHandler(input.value);
      if (result.outcome === "created") {
        await writeAuditEventIfConfigured(
          options.auditEventWriteHandler,
          request,
          {
            action: "app.created",
            afterState: result.app as unknown as Record<string, unknown>,
            beforeState: null,
            resourceId: result.app.id,
            resourceType: "app",
            result: "success",
            teamId: result.app.teamId,
          },
        );
      }

      const response = prepareAppCreateResponse(result);

      await completeIdempotentRequestIfStarted(
        options.idempotencyHandler,
        idempotency,
        response,
      );

      return sendPreparedJsonResponse(reply, response);
    },
  );

  controlPlane.get<{ Params: TeamParams }>(
    "/teams/:teamId/apps",
    async (request, reply) => {
      if (!options.teamAppsListHandler) {
        return sendProblem(reply, createManagementNotEnabledProblem());
      }

      const authorization = await authorizeResourceAccess(
        options.authorizationService,
        request.controlPlanePrincipal,
        "app.read",
        () =>
          options.authorizationService!.resolveTeamScope(
            request.params.teamId,
          ),
        createTeamNotFoundProblem({
          outcome: "not_found",
          reason: "team_not_found",
        }),
      );
      if (authorization.kind === "error") {
        return sendProblem(reply, authorization.problem);
      }

      const result = await options.teamAppsListHandler(
        request.params.teamId,
      );

      if (result.outcome === "found") {
        return {
          apps: result.apps.map(toAppWire),
        };
      }

      return sendProblem(reply, createTeamNotFoundProblem(result));
    },
  );

  controlPlane.get<{ Params: AppParams }>(
    "/apps/:appId",
    async (request, reply) => {
      if (!options.appReadHandler) {
        return sendProblem(reply, createManagementNotEnabledProblem());
      }

      const authorization = await authorizeResourceAccess(
        options.authorizationService,
        request.controlPlanePrincipal,
        "app.read",
        () =>
          options.authorizationService!.resolveAppScope(
            request.params.appId,
          ),
        createAppNotFoundProblem({
          outcome: "not_found",
          reason: "app_not_found",
        }),
      );
      if (authorization.kind === "error") {
        return sendProblem(reply, authorization.problem);
      }

      const result = await options.appReadHandler(request.params.appId);

      if (result.outcome === "found") {
        return {
          app: toAppWire(result.app),
        };
      }

      return sendProblem(reply, createAppNotFoundProblem(result));
    },
  );

  controlPlane.patch<{
    Body: AppUpdateBody;
    Params: AppParams;
  }>("/apps/:appId", async (request, reply) => {
    if (!options.appUpdateHandler) {
      return sendProblem(reply, createManagementNotEnabledProblem());
    }

    const input = parseAppUpdateInput(request.params.appId, request.body);
    if (input.kind === "error") {
      return sendProblem(reply, input.problem);
    }

    const authorization = await authorizeResourceAccess(
      options.authorizationService,
      request.controlPlanePrincipal,
      "app.manage",
      () =>
        options.authorizationService!.resolveAppScope(
          request.params.appId,
        ),
      createAppNotFoundProblem({
        outcome: "not_found",
        reason: "app_not_found",
      }),
    );
    if (authorization.kind === "error") {
      return sendProblem(reply, authorization.problem);
    }

    const result = await options.appUpdateHandler(input.value);
    if (result.outcome === "updated") {
      await writeAuditEventIfConfigured(
        options.auditEventWriteHandler,
        request,
        {
          action: "app.updated",
          afterState: result.app as unknown as Record<string, unknown>,
          beforeState: result.before as unknown as Record<string, unknown>,
          resourceId: result.app.id,
          resourceType: "app",
          result: "success",
          teamId: result.app.teamId,
        },
      );
    }

    return sendPreparedJsonResponse(
      reply,
      prepareAppUpdateResponse(result),
    );
  });

  controlPlane.post<{
    Body: AppTransferBody;
    Params: AppParams;
  }>("/apps/:appId/transfer", async (request, reply) => {
    if (!options.appTransferHandler) {
      return sendProblem(reply, createManagementNotEnabledProblem());
    }

    const input = parseAppTransferInput(request.params.appId, request.body);
    if (input.kind === "error") {
      return sendProblem(reply, input.problem);
    }

    const idempotencyKey = parseIdempotencyKey(
      request.headers["idempotency-key"],
    );
    if (idempotencyKey.kind === "error") {
      return sendProblem(reply, idempotencyKey.problem);
    }
    if (idempotencyKey.key === null) {
      return sendProblem(
        reply,
        singleFieldValidationProblem(
          "Idempotency-Key is required",
          "Idempotency-Key",
          "required",
        ),
      );
    }

    const sourceAuthorization = await authorizeResourceAccess(
      options.authorizationService,
      request.controlPlanePrincipal,
      "app.manage",
      () =>
        options.authorizationService!.resolveAppScope(
          request.params.appId,
        ),
      createAppNotFoundProblem({
        outcome: "not_found",
        reason: "app_not_found",
      }),
    );
    if (sourceAuthorization.kind === "error") {
      return sendProblem(reply, sourceAuthorization.problem);
    }

    const destinationAuthorization = await authorizeResourceAccess(
      options.authorizationService,
      request.controlPlanePrincipal,
      "app.create",
      () =>
        options.authorizationService!.resolveTeamScope(
          input.value.destinationTeamId,
        ),
      createTeamNotFoundProblem({
        outcome: "not_found",
        reason: "team_not_found",
      }),
    );
    if (destinationAuthorization.kind === "error") {
      return sendProblem(reply, destinationAuthorization.problem);
    }

    const idempotency = await startIdempotentRequestIfPresent(
      request,
      options.idempotencyHandler,
      createRequestBodyHash(input.value),
    );
    if (idempotency.kind === "terminal") {
      return sendPreparedJsonResponse(reply, idempotency.response);
    }

    const result = await options.appTransferHandler(input.value);
    if (result.outcome === "transferred") {
      const transferState = {
        destinationTeamId: result.app.teamId,
        sourceTeamId: result.before.teamId,
      };
      const beforeState = {
        app: result.before,
        ...transferState,
      };
      const afterState = {
        app: result.app,
        deployments: result.deployments,
        ...transferState,
      };

      await writeAuditEventIfConfigured(
        options.auditEventWriteHandler,
        request,
        {
          action: "app.transferred_out",
          afterState: afterState as unknown as Record<string, unknown>,
          beforeState: beforeState as unknown as Record<string, unknown>,
          resourceId: result.app.id,
          resourceType: "app",
          result: "success",
          teamId: result.before.teamId,
        },
      );
      await writeAuditEventIfConfigured(
        options.auditEventWriteHandler,
        request,
        {
          action: "app.transferred_in",
          afterState: afterState as unknown as Record<string, unknown>,
          beforeState: beforeState as unknown as Record<string, unknown>,
          resourceId: result.app.id,
          resourceType: "app",
          result: "success",
          teamId: result.app.teamId,
        },
      );
    }

    const response = prepareAppTransferResponse(result);
    await completeIdempotentRequestIfStarted(
      options.idempotencyHandler,
      idempotency,
      response,
    );

    return sendPreparedJsonResponse(reply, response);
  });

  controlPlane.delete<{ Params: AppParams }>(
    "/apps/:appId",
    async (request, reply) => {
      if (!options.appDeleteHandler) {
        return sendProblem(reply, createManagementNotEnabledProblem());
      }

      const authorization = await authorizeResourceAccess(
        options.authorizationService,
        request.controlPlanePrincipal,
        "app.manage",
        () =>
          options.authorizationService!.resolveAppScope(
            request.params.appId,
          ),
        createAppNotFoundProblem({
          outcome: "not_found",
          reason: "app_not_found",
        }),
      );
      if (authorization.kind === "error") {
        return sendProblem(reply, authorization.problem);
      }

      const result = await options.appDeleteHandler(request.params.appId);

      if (result.outcome === "deleted") {
        await writeAuditEventIfConfigured(
          options.auditEventWriteHandler,
          request,
          {
            action: "app.deleted",
            afterState: {
              deletedDeploymentCount: result.deletedDeploymentCount,
              deletedReleaseCount: result.deletedReleaseCount,
            },
            beforeState: result.app as unknown as Record<string, unknown>,
            resourceId: result.app.id,
            resourceType: "app",
            result: "success",
            teamId: result.app.teamId,
          },
        );

        reply.status(204);
        return reply.send();
      }

      return sendPreparedJsonResponse(
        reply,
        prepareAppDeleteResponse(result),
      );
    },
  );

  controlPlane.post<{
    Body: DeploymentCreateBody;
    Params: AppParams;
  }>("/apps/:appId/deployments", async (request, reply) => {
    if (!options.deploymentCreateHandler) {
      return sendProblem(reply, createManagementNotEnabledProblem());
    }

    const input = parseDeploymentCreateInput(
      request.params.appId,
      request.body,
    );
    if (input.kind === "error") {
      return sendProblem(reply, input.problem);
    }

    const authorization = await authorizeResourceAccess(
      options.authorizationService,
      request.controlPlanePrincipal,
      "app.create",
      () =>
        options.authorizationService!.resolveAppScope(
          request.params.appId,
        ),
      createAppNotFoundProblem({
        outcome: "not_found",
        reason: "app_not_found",
      }),
    );
    if (authorization.kind === "error") {
      return sendProblem(reply, authorization.problem);
    }

    const idempotency = await startIdempotentRequestIfPresent(
      request,
      options.idempotencyHandler,
      createRequestBodyHash(input.value),
    );
    if (idempotency.kind === "terminal") {
      return sendPreparedJsonResponse(reply, idempotency.response);
    }

    const result = await options.deploymentCreateHandler(input.value);
    if (result.outcome === "created") {
      await writeAuditEventIfConfigured(
        options.auditEventWriteHandler,
        request,
        {
          action: "deployment.created",
          afterState: result.deployment as unknown as Record<string, unknown>,
          beforeState: null,
          resourceId: result.deployment.id,
          resourceType: "deployment",
          result: "success",
          teamId: result.deployment.teamId,
        },
      );
    }

    const response = prepareDeploymentCreateResponse(result);
    await completeIdempotentRequestIfStarted(
      options.idempotencyHandler,
      idempotency,
      response,
    );

    return sendPreparedJsonResponse(reply, response);
  });

  controlPlane.get<{ Params: AppParams }>(
    "/apps/:appId/deployments",
    async (request, reply) => {
      if (!options.appDeploymentsListHandler) {
        return sendProblem(reply, createManagementNotEnabledProblem());
      }

      const authorization = await authorizeResourceAccess(
        options.authorizationService,
        request.controlPlanePrincipal,
        "app.read",
        () =>
          options.authorizationService!.resolveAppScope(
            request.params.appId,
          ),
        createAppNotFoundProblem({
          outcome: "not_found",
          reason: "app_not_found",
        }),
      );
      if (authorization.kind === "error") {
        return sendProblem(reply, authorization.problem);
      }

      const result = await options.appDeploymentsListHandler(
        request.params.appId,
      );

      if (result.outcome === "found") {
        return {
          deployments: result.deployments.map(toDeploymentWire),
        };
      }

      return sendProblem(reply, createAppNotFoundProblem(result));
    },
  );

  controlPlane.patch<{
    Body: DeploymentUpdateBody;
    Params: DeploymentParams;
  }>("/deployments/:deploymentId", async (request, reply) => {
    if (!options.deploymentUpdateHandler) {
      return sendProblem(reply, createManagementNotEnabledProblem());
    }

    const input = parseDeploymentUpdateInput(
      request.params.deploymentId,
      request.body,
    );
    if (input.kind === "error") {
      return sendProblem(reply, input.problem);
    }

    const authorization = await authorizeResourceAccess(
      options.authorizationService,
      request.controlPlanePrincipal,
      "app.manage",
      () =>
        options.authorizationService!.resolveDeploymentScope(
          request.params.deploymentId,
        ),
      createDeploymentNotFoundProblem(),
    );
    if (authorization.kind === "error") {
      return sendProblem(reply, authorization.problem);
    }

    const result = await options.deploymentUpdateHandler(input.value);
    if (result.outcome === "updated") {
      await writeAuditEventIfConfigured(
        options.auditEventWriteHandler,
        request,
        {
          action: "deployment.updated",
          afterState: result.deployment as unknown as Record<string, unknown>,
          beforeState: result.before as unknown as Record<string, unknown>,
          resourceId: result.deployment.id,
          resourceType: "deployment",
          result: "success",
          teamId: result.deployment.teamId,
        },
      );
    }

    return sendPreparedJsonResponse(
      reply,
      prepareDeploymentUpdateResponse(result),
    );
  });

  controlPlane.delete<{ Params: DeploymentParams }>(
    "/deployments/:deploymentId",
    async (request, reply) => {
      if (!options.deploymentDeleteHandler) {
        return sendProblem(reply, createManagementNotEnabledProblem());
      }

      const authorization = await authorizeResourceAccess(
        options.authorizationService,
        request.controlPlanePrincipal,
        "app.manage",
        () =>
          options.authorizationService!.resolveDeploymentScope(
            request.params.deploymentId,
          ),
        createDeploymentNotFoundProblem(),
      );
      if (authorization.kind === "error") {
        return sendProblem(reply, authorization.problem);
      }

      const result = await options.deploymentDeleteHandler(
        request.params.deploymentId,
      );

      if (result.outcome === "deleted") {
        await writeAuditEventIfConfigured(
          options.auditEventWriteHandler,
          request,
          {
            action: "deployment.deleted",
            afterState: {
              deletedReleaseCount: result.deletedReleaseCount,
            },
            beforeState: result.deployment as unknown as Record<
              string,
              unknown
            >,
            resourceId: result.deployment.id,
            resourceType: "deployment",
            result: "success",
            teamId: result.deployment.teamId,
          },
        );

        reply.status(204);
        return reply.send();
      }

      return sendPreparedJsonResponse(
        reply,
        prepareDeploymentDeleteResponse(result),
      );
    },
  );

  controlPlane.post<{ Params: DeploymentParams }>(
    "/deployments/:deploymentId/clear",
    async (request, reply) => {
      if (!options.deploymentClearHandler) {
        return sendProblem(reply, createManagementNotEnabledProblem());
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

      const result = await options.deploymentClearHandler(
        request.params.deploymentId,
      );

      if (result.outcome === "cleared") {
        await writeAuditEventIfConfigured(
          options.auditEventWriteHandler,
          request,
          {
            action: "deployment.cleared",
            afterState: {
              deletedReleaseCount: result.deletedReleaseCount,
            },
            beforeState: null,
            resourceId: result.deployment.id,
            resourceType: "deployment",
            result: "success",
            teamId: result.deployment.teamId,
          },
        );

        return {
          deleted_release_count: result.deletedReleaseCount,
          deployment: toDeploymentWire(result.deployment),
        };
      }

      if (result.outcome === "not_found") {
        return sendProblem(reply, createDeploymentNotFoundProblem());
      }

      return sendProblem(
        reply,
        createProblem({
          detail:
            "deployment already has an active queued or running release job",
          extensions: {
            active_job: toActiveJobWire(result.activeJob),
          },
          status: 409,
          typeSuffix: "active-release-job",
        }),
      );
    },
  );
}
