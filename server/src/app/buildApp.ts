import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";

import { InMemoryStorageAdapter } from "../adapters";
import {
  DEFAULT_MAX_UPLOAD_SIZE_BYTES,
  MAX_UPLOAD_SIZE_EXCEEDED_DETAIL,
} from "./upload-size";
import { createValidationProblem, sendProblem } from "./problemDetails";
import { registerDashboardStatic } from "./dashboardStatic";
import { apiRoutes } from "../plugins/api/routes";
import { workerRoutes } from "../plugins/worker/routes";
import type { BuildAppOptions } from "./types";

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const {
    apiTokenCreateHandler,
    apiTokenDeleteHandler,
    apiTokenListHandler,
    appCreateHandler,
    appDeleteHandler,
    appDeploymentsListHandler,
    appReadHandler,
    appTransferHandler,
    appUpdateHandler,
    auditEventWriteHandler,
    authorizationService,
    controlPlaneAuthHandler,
    dashboardStaticDir,
    deploymentClearHandler,
    deploymentCreateHandler,
    deploymentDeleteHandler,
    deploymentMetricsHandler,
    deploymentRollbackHandler,
    deploymentTimeseriesHandler,
    deploymentUpdateHandler,
    iamInvitationCreateHandler,
    iamInvitationListHandler,
    iamInvitationReadHandler,
    iamInvitationRevokeHandler,
    iamRoleBindingCreateHandler,
    iamRoleBindingDeleteHandler,
    iamRoleBindingListHandler,
    iamRoleBindingReadHandler,
    iamRoleBindingUpdateHandler,
    iamRoleListHandler,
    http2Cleartext = false,
    iamUserProvisionHandler,
    idempotencyHandler,
    loggerInstance,
    maxUploadSizeBytes = DEFAULT_MAX_UPLOAD_SIZE_BYTES,
    metricEventIngestHandler,
    mode = "all",
    oauthCallbackHandler,
    oauthCliAuthorizationIssueHandler,
    oauthCliExchangeHandler,
    oauthLogoutHandler,
    oauthRefreshHandler,
    oauthWebConfig,
    readinessCheckHandler,
    releaseCreationHandler,
    releaseCreationPreflightHandler,
    releaseListHandler,
    releaseMetricsReadHandler,
    releasePatchHandler,
    releasePromoteHandler,
    releaseReadHandler,
    releaseUploadStorage = releaseCreationHandler
      ? new InMemoryStorageAdapter()
      : undefined,
    sdkConfig,
    teamAppsListHandler,
    teamCreateHandler,
    teamListHandler,
    teamReadHandler,
    userProfileHandler,
    workerReconcileHandler,
    workerSharedSecret,
  } = options;

  if ((mode === "all" || mode === "worker") && !workerSharedSecret) {
    throw new Error(
      "workerSharedSecret is required when worker routes are enabled",
    );
  }

  if ((mode === "all" || mode === "api") && !controlPlaneAuthHandler) {
    throw new Error(
      "controlPlaneAuthHandler is required when control-plane routes are enabled",
    );
  }

  // The h2c instance is cast back to the default FastifyInstance shape: the
  // generics only pin the underlying Node server type, and every route and
  // plugin here works against Fastify's request/reply abstraction.
  const app = http2Cleartext
    ? (Fastify({
        bodyLimit: maxUploadSizeBytes,
        http2: true,
        // Fastify rejects passing both `logger` and `loggerInstance`.
        ...(loggerInstance ? { loggerInstance } : { logger: false }),
      }) as unknown as FastifyInstance)
    : Fastify({
        bodyLimit: maxUploadSizeBytes,
        // Fastify rejects passing both `logger` and `loggerInstance`.
        ...(loggerInstance ? { loggerInstance } : { logger: false }),
      });

  app.register(multipart, {
    limits: {
      fileSize: maxUploadSizeBytes,
    },
    throwFileSizeLimit: true,
  });

  app.setErrorHandler((error, _request, reply) => {
    if (isPayloadTooLargeError(error)) {
      reply.status(413);
      reply.type("application/problem+json");
      reply.send({
        detail: MAX_UPLOAD_SIZE_EXCEEDED_DETAIL,
        status: 413,
        title: "Payload Too Large",
        type: "about:blank",
      });
      return;
    }

    if (isMalformedJsonError(error)) {
      reply.send(
        sendProblem(
          reply,
          createValidationProblem("request body must be valid JSON"),
        ),
      );
      return;
    }

    reply.send(error);
  });

  if (mode === "all" || mode === "api") {
    app.register(apiRoutes, {
      apiTokenCreateHandler,
      apiTokenDeleteHandler,
      apiTokenListHandler,
      appCreateHandler,
      appDeleteHandler,
      appDeploymentsListHandler,
      appReadHandler,
      appTransferHandler,
      appUpdateHandler,
      auditEventWriteHandler,
      authorizationService,
      controlPlaneAuthHandler: controlPlaneAuthHandler!,
      deploymentClearHandler,
      deploymentCreateHandler,
      deploymentDeleteHandler,
      deploymentMetricsHandler,
      deploymentRollbackHandler,
      deploymentTimeseriesHandler,
      deploymentUpdateHandler,
      iamInvitationCreateHandler,
      iamInvitationListHandler,
      iamInvitationReadHandler,
      iamInvitationRevokeHandler,
      iamRoleBindingCreateHandler,
      iamRoleBindingDeleteHandler,
      iamRoleBindingListHandler,
      iamRoleBindingReadHandler,
      iamRoleBindingUpdateHandler,
      iamRoleListHandler,
      iamUserProvisionHandler,
      idempotencyHandler,
      maxUploadSizeBytes,
      metricEventIngestHandler,
      mode,
      oauthCallbackHandler,
      oauthCliAuthorizationIssueHandler,
      oauthCliExchangeHandler,
      oauthLogoutHandler,
      oauthRefreshHandler,
      oauthWebConfig,
      readinessCheckHandler,
      releaseCreationHandler,
      releaseCreationPreflightHandler,
      releaseListHandler,
      releaseMetricsReadHandler,
      releasePatchHandler,
      releasePromoteHandler,
      releaseReadHandler,
      releaseUploadStorage,
      sdkConfig,
      teamAppsListHandler,
      teamCreateHandler,
      teamListHandler,
      teamReadHandler,
      userProfileHandler,
    });
  }

  if (mode === "all" || mode === "worker") {
    app.register(workerRoutes, {
      mode,
      workerReconcileHandler,
      workerSharedSecret,
    });
  }

  if (dashboardStaticDir && (mode === "all" || mode === "api")) {
    registerDashboardStatic(app, dashboardStaticDir);
  }

  return app;
}

function isPayloadTooLargeError(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "FST_ERR_CTP_BODY_TOO_LARGE" ||
      error.code === "FST_REQ_FILE_TOO_LARGE" ||
      error.code === "FST_FILES_LIMIT" ||
      error.code === "FST_PARTS_LIMIT")
  );
}

function isMalformedJsonError(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "FST_ERR_CTP_INVALID_JSON_BODY"
  );
}
