import type { FastifyInstance } from "fastify";

import { createProblem, sendProblem } from "../../app/problemDetails";
import {
  cleanupReleaseUploadArtifacts,
  parseReleaseCreationMultipartInput,
} from "./releaseUpload";
import {
  deploymentRollbackIdempotencyFingerprint,
  parseDeploymentRollbackInput,
  parseReleaseListInput,
  parseReleasePatchInput,
  parseReleasePromoteInput,
  prepareReleaseCreationResponse,
  prepareReleaseLifecycleCreateResponse,
  releaseCreationIdempotencyFingerprint,
  releasePatchAuditAction,
  releasePatchInvalidProblem,
  releasePromoteIdempotencyFingerprint,
} from "./releaseSupport";
import {
  authorizeResourceAccess,
  completeIdempotentRequestIfStarted,
  createDeploymentNotFoundProblem,
  createReleaseNotFoundProblem,
  createRequestBodyHash,
  RELEASE_MULTIPART_REQUIRED_ERROR,
  requireControlPlanePrincipal,
  sendPreparedJsonResponse,
  startIdempotentRequestIfPresent,
  writeAuditEventIfConfigured,
} from "./routeSupport";
import type {
  ApiRoutesOptions,
  DeploymentParams,
  DeploymentRollbackBody,
  ReleaseCreationParams,
  ReleaseListQuery,
  ReleasePatchBody,
  ReleasePromoteBody,
  ReleaseReadParams,
} from "./routeTypes";
import {
  toActiveJobWire,
  toReleaseJobWire,
  toReleaseMetricsWire,
  toReleaseWire,
} from "./wireSerializers";

export function registerReleaseRoutes(
  controlPlane: FastifyInstance,
  options: ApiRoutesOptions,
): void {
  controlPlane.post<{
    Body: DeploymentRollbackBody;
    Params: DeploymentParams;
  }>("/deployments/:deploymentId/rollback", async (request, reply) => {
    if (!options.deploymentRollbackHandler) {
      return sendProblem(
        reply,
        createProblem({
          detail: "deployment rollback is not implemented",
          status: 501,
        }),
      );
    }

    const input = parseDeploymentRollbackInput(
      request.params.deploymentId,
      request.body,
      requireControlPlanePrincipal(request).userId,
    );
    if (input.kind === "error") {
      return sendProblem(reply, input.problem);
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

    const idempotency = await startIdempotentRequestIfPresent(
      request,
      options.idempotencyHandler,
      createRequestBodyHash(deploymentRollbackIdempotencyFingerprint(input.value)),
    );
    if (idempotency.kind === "terminal") {
      return sendPreparedJsonResponse(reply, idempotency.response);
    }

    const result = await options.deploymentRollbackHandler(input.value);
    if (result.outcome === "created") {
      await writeAuditEventIfConfigured(
        options.auditEventWriteHandler,
        request,
        {
          action: "release.rolled_back",
          afterState: result.release as unknown as Record<string, unknown>,
          beforeState: null,
          resourceId: result.release.id,
          resourceType: "release",
          result: "success",
          teamId: result.release.teamId,
        },
      );
    }

    const response = prepareReleaseLifecycleCreateResponse(result);
    await completeIdempotentRequestIfStarted(
      options.idempotencyHandler,
      idempotency,
      response,
    );

    return sendPreparedJsonResponse(reply, response);
  });

  controlPlane.post<{ Params: ReleaseCreationParams }>(
    "/deployments/:deploymentId/releases",
    async (request, reply) => {
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

      const hasRuntimeBackedUploadPath =
        options.releaseUploadStorage !== undefined;
      const releaseUploadStorage = options.releaseUploadStorage;

      if (request.isMultipart() && !options.releaseCreationHandler) {
        return sendProblem(
          reply,
          createProblem({
            detail: "release creation is not implemented",
            status: 501,
          }),
        );
      }

      if (hasRuntimeBackedUploadPath && !request.isMultipart()) {
        return sendProblem(
          reply,
          createProblem({
            detail: RELEASE_MULTIPART_REQUIRED_ERROR,
            status: 415,
          }),
        );
      }

      if (!request.isMultipart()) {
        return sendProblem(
          reply,
          createProblem({
            detail: "release creation is not implemented",
            status: 501,
          }),
        );
      }

      const multipartInput = await parseReleaseCreationMultipartInput(
        request,
        request.params.deploymentId,
        requireControlPlanePrincipal(request).userId,
        releaseUploadStorage,
        options.releaseCreationPreflightHandler,
        options.maxUploadSizeBytes,
      );

      if (multipartInput.kind === "error") {
        return sendProblem(reply, multipartInput.problem);
      }

      const stagedReleaseUploadStorage = releaseUploadStorage;
      if (!stagedReleaseUploadStorage) {
        return sendProblem(
          reply,
          createProblem({
            detail: "release creation is not implemented",
            status: 501,
          }),
        );
      }

      if (!options.releaseCreationHandler) {
        await cleanupReleaseUploadArtifacts(
          stagedReleaseUploadStorage,
          multipartInput.stagedBundleStorageKey,
          multipartInput.stagedSourceMapStorageKey,
        );

        return sendProblem(
          reply,
          createProblem({
            detail: "release creation is not implemented",
            status: 501,
          }),
        );
      }

      const idempotency = await startIdempotentRequestIfPresent(
        request,
        options.idempotencyHandler,
        createRequestBodyHash(
          releaseCreationIdempotencyFingerprint(multipartInput.input),
        ),
      );
      if (idempotency.kind === "terminal") {
        await cleanupReleaseUploadArtifacts(
          stagedReleaseUploadStorage,
          multipartInput.stagedBundleStorageKey,
          multipartInput.stagedSourceMapStorageKey,
        );
        return sendPreparedJsonResponse(reply, idempotency.response);
      }

      const result = await options
        .releaseCreationHandler(multipartInput.input)
        .catch(async (error) => {
          await cleanupReleaseUploadArtifacts(
            stagedReleaseUploadStorage,
            multipartInput.stagedBundleStorageKey,
            multipartInput.stagedSourceMapStorageKey,
          );
          throw error;
        });

      if (result.outcome !== "created") {
        await cleanupReleaseUploadArtifacts(
          stagedReleaseUploadStorage,
          multipartInput.stagedBundleStorageKey,
          multipartInput.stagedSourceMapStorageKey,
        );
      }

      if (result.outcome === "created") {
        await writeAuditEventIfConfigured(
          options.auditEventWriteHandler,
          request,
          {
            action: "release.created",
            afterState: result.release as unknown as Record<string, unknown>,
            beforeState: null,
            resourceId: result.release.id,
            resourceType: "release",
            result: "success",
            teamId: result.release.teamId,
          },
        );
      }

      const response = prepareReleaseCreationResponse(result);
      await completeIdempotentRequestIfStarted(
        options.idempotencyHandler,
        idempotency,
        response,
      );

      return sendPreparedJsonResponse(reply, response);
    },
  );

  controlPlane.get<{
    Params: ReleaseCreationParams;
    Querystring: ReleaseListQuery;
  }>("/deployments/:deploymentId/releases", async (request, reply) => {
    const input = parseReleaseListInput(
      request.params.deploymentId,
      request.query,
    );
    if (input.kind === "error") {
      return sendProblem(reply, input.problem);
    }

    const authorization = await authorizeResourceAccess(
      options.authorizationService,
      request.controlPlanePrincipal,
      "release.view",
      () =>
        options.authorizationService!.resolveDeploymentScope(
          request.params.deploymentId,
        ),
      createDeploymentNotFoundProblem(),
    );
    if (authorization.kind === "error") {
      return sendProblem(reply, authorization.problem);
    }

    if (!options.releaseListHandler) {
      return sendProblem(
        reply,
        createProblem({
          detail: "release list is not implemented",
          status: 501,
        }),
      );
    }

    const result = await options.releaseListHandler(input.value);

    if (result.outcome === "not_found") {
      return sendProblem(reply, createDeploymentNotFoundProblem());
    }

    return {
      pagination: result.pagination,
      releases: result.releases.map((entry) => ({
        job: entry.job ? toReleaseJobWire(entry.job) : null,
        ...(entry.metrics ? { metrics: toReleaseMetricsWire(entry.metrics) } : {}),
        release: toReleaseWire(entry.release),
      })),
    };
  });

  controlPlane.get<{ Params: ReleaseReadParams }>(
    "/releases/:releaseId",
    async (request, reply) => {
      if (!options.releaseReadHandler) {
        return sendProblem(
          reply,
          createProblem({
            detail: "release lookup is not implemented",
            status: 501,
          }),
        );
      }

      const authorization = await authorizeResourceAccess(
        options.authorizationService,
        request.controlPlanePrincipal,
        "release.view",
        () =>
          options.authorizationService!.resolveReleaseScope(
            request.params.releaseId,
          ),
        createReleaseNotFoundProblem(),
      );
      if (authorization.kind === "error") {
        return sendProblem(reply, authorization.problem);
      }

      const result = await options.releaseReadHandler(
        request.params.releaseId,
      );

      if (result.outcome === "not_found") {
        return sendProblem(
          reply,
          createProblem({
            detail: "release was not found",
            extensions: {
              outcome: result.outcome,
              reason: result.reason,
            },
            status: 404,
            typeSuffix: "not-found",
          }),
        );
      }

      return {
        job: result.job ? toReleaseJobWire(result.job) : null,
        release: toReleaseWire(result.release),
      };
    },
  );

  controlPlane.post<{
    Body: ReleasePromoteBody;
    Params: ReleaseReadParams;
  }>("/releases/:releaseId/promote", async (request, reply) => {
    if (!options.releasePromoteHandler) {
      return sendProblem(
        reply,
        createProblem({
          detail: "release promote is not implemented",
          status: 501,
        }),
      );
    }

    const input = parseReleasePromoteInput(
      request.params.releaseId,
      request.body,
      requireControlPlanePrincipal(request).userId,
    );
    if (input.kind === "error") {
      return sendProblem(reply, input.problem);
    }

    const sourceAuthorization = await authorizeResourceAccess(
      options.authorizationService,
      request.controlPlanePrincipal,
      "release.view",
      () =>
        options.authorizationService!.resolveReleaseScope(
          request.params.releaseId,
        ),
      createReleaseNotFoundProblem(),
    );
    if (sourceAuthorization.kind === "error") {
      return sendProblem(reply, sourceAuthorization.problem);
    }

    const destinationAuthorization = await authorizeResourceAccess(
      options.authorizationService,
      request.controlPlanePrincipal,
      "release.deploy",
      () =>
        options.authorizationService!.resolveDeploymentScope(
          input.value.destinationDeploymentId,
        ),
      createDeploymentNotFoundProblem(),
    );
    if (destinationAuthorization.kind === "error") {
      return sendProblem(reply, destinationAuthorization.problem);
    }

    const idempotency = await startIdempotentRequestIfPresent(
      request,
      options.idempotencyHandler,
      createRequestBodyHash(releasePromoteIdempotencyFingerprint(input.value)),
    );
    if (idempotency.kind === "terminal") {
      return sendPreparedJsonResponse(reply, idempotency.response);
    }

    const result = await options.releasePromoteHandler(input.value);
    if (result.outcome === "created") {
      await writeAuditEventIfConfigured(
        options.auditEventWriteHandler,
        request,
        {
          action: "release.promoted",
          afterState: result.release as unknown as Record<string, unknown>,
          beforeState: null,
          resourceId: result.release.id,
          resourceType: "release",
          result: "success",
          teamId: result.release.teamId,
        },
      );
    }

    const response = prepareReleaseLifecycleCreateResponse(result);
    await completeIdempotentRequestIfStarted(
      options.idempotencyHandler,
      idempotency,
      response,
    );

    return sendPreparedJsonResponse(reply, response);
  });

  controlPlane.patch<{
    Body: ReleasePatchBody;
    Params: ReleaseReadParams;
  }>("/releases/:releaseId", async (request, reply) => {
    const authorization = await authorizeResourceAccess(
      options.authorizationService,
      request.controlPlanePrincipal,
      "release.deploy",
      () =>
        options.authorizationService!.resolveReleaseScope(
          request.params.releaseId,
        ),
      createReleaseNotFoundProblem(),
    );
    if (authorization.kind === "error") {
      return sendProblem(reply, authorization.problem);
    }

    const input = parseReleasePatchInput(
      request.params.releaseId,
      request.body,
      requireControlPlanePrincipal(request).userId,
    );

    if (input.kind === "error") {
      return sendProblem(reply, input.problem);
    }

    if (input.kind === "not_modified") {
      reply.status(204);
      return reply.send();
    }

    if (!options.releasePatchHandler) {
      return sendProblem(
        reply,
        createProblem({
          detail: "release patch is not implemented",
          status: 501,
        }),
      );
    }

    const result = await options.releasePatchHandler(input.value);

    if (result.outcome === "updated") {
      await writeAuditEventIfConfigured(
        options.auditEventWriteHandler,
        request,
        {
          action: releasePatchAuditAction(input.value),
          afterState: result.release as unknown as Record<string, unknown>,
          beforeState: null,
          resourceId: result.release.id,
          resourceType: "release",
          result: "success",
          teamId: result.release.teamId,
        },
      );

      return {
        job: result.job ? toReleaseJobWire(result.job) : null,
        release: toReleaseWire(result.release),
      };
    }

    if (result.outcome === "not_modified") {
      reply.status(204);
      return reply.send();
    }

    if (result.outcome === "not_found") {
      return sendProblem(
        reply,
        createProblem({
          detail: "release was not found",
          extensions: {
            outcome: result.outcome,
            reason: result.reason,
          },
          status: 404,
          typeSuffix: "not-found",
        }),
      );
    }

    if (result.outcome === "conflict") {
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
    }

    return sendProblem(
      reply,
      result.reason === "status_transition_not_allowed"
        ? createProblem({
            detail: "status transition is not allowed for this release",
            status: 400,
            typeSuffix: "invalid-status-transition",
          })
        : releasePatchInvalidProblem(result.reason),
    );
  });
}
