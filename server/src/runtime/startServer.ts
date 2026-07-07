import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { pino } from "pino";

import { buildApp } from "../app/buildApp";
import type { RuntimeConfig } from "./config";
import {
  createServerRuntime,
  type ServerRuntime,
  type ServerRuntimeOptions,
} from "./createServerRuntime";

export interface StartServerOptions
  extends Omit<ServerRuntimeOptions, "logger"> {
  /**
   * Wrap or replace runtime route handlers before the HTTP app is assembled.
   * Lets embedders decorate handlers (e.g. with extra validation or policy)
   * without re-implementing the runtime-to-app wiring.
   */
  decorateRuntime?: (runtime: ServerRuntime) => ServerRuntime;
  /** pino-compatible logger shared by HTTP and runtime logging. */
  loggerInstance?: FastifyBaseLogger;
}

export async function startServer(
  config: RuntimeConfig,
  options: StartServerOptions = {},
): Promise<FastifyInstance> {
  // There is exactly one shared logger: injected, or created here.
  // LOGGER=false silences it via pino's "silent" level.
  const {
    decorateRuntime,
    loggerInstance: providedLoggerInstance,
    ...runtimeOptions
  } = options;
  const loggerInstance =
    providedLoggerInstance ?? pino({ level: config.logger ? "info" : "silent" });
  const baseRuntime = await createServerRuntime(config, {
    ...runtimeOptions,
    logger: loggerInstance,
  });
  const runtime = decorateRuntime ? decorateRuntime(baseRuntime) : baseRuntime;
  const app = buildApp({
    apiTokenCreateHandler: runtime.apiTokenCreateHandler,
    apiTokenDeleteHandler: runtime.apiTokenDeleteHandler,
    apiTokenListHandler: runtime.apiTokenListHandler,
    appCreateHandler: runtime.appCreateHandler,
    appDeleteHandler: runtime.appDeleteHandler,
    appDeploymentsListHandler: runtime.appDeploymentsListHandler,
    appReadHandler: runtime.appReadHandler,
    appTransferHandler: runtime.appTransferHandler,
    appUpdateHandler: runtime.appUpdateHandler,
    auditEventWriteHandler: runtime.auditEventWriteHandler,
    authorizationService: runtime.authorizationService,
    controlPlaneAuthHandler: runtime.controlPlaneAuthHandler,
    deploymentClearHandler: runtime.deploymentClearHandler,
    deploymentCreateHandler: runtime.deploymentCreateHandler,
    deploymentDeleteHandler: runtime.deploymentDeleteHandler,
    deploymentMetricsHandler: runtime.deploymentMetricsHandler,
    deploymentRollbackHandler: runtime.deploymentRollbackHandler,
    deploymentUpdateHandler: runtime.deploymentUpdateHandler,
    iamInvitationCreateHandler: runtime.iamInvitationCreateHandler,
    iamInvitationListHandler: runtime.iamInvitationListHandler,
    iamInvitationReadHandler: runtime.iamInvitationReadHandler,
    iamInvitationRevokeHandler: runtime.iamInvitationRevokeHandler,
    iamRoleBindingCreateHandler: runtime.iamRoleBindingCreateHandler,
    iamRoleBindingDeleteHandler: runtime.iamRoleBindingDeleteHandler,
    iamRoleBindingListHandler: runtime.iamRoleBindingListHandler,
    iamRoleBindingReadHandler: runtime.iamRoleBindingReadHandler,
    iamRoleListHandler: runtime.iamRoleListHandler,
    iamUserProvisionHandler: runtime.iamUserProvisionHandler,
    idempotencyHandler: runtime.idempotencyHandler,
    loggerInstance,
    maxUploadSizeBytes: config.maxUploadSizeBytes,
    metricEventIngestHandler: runtime.metricEventIngestHandler,
    mode: config.mode,
    oauthCallbackHandler: runtime.oauthCallbackHandler,
    oauthDevicePollHandler: runtime.oauthDevicePollHandler,
    oauthDeviceStartHandler: runtime.oauthDeviceStartHandler,
    oauthLogoutHandler: runtime.oauthLogoutHandler,
    oauthRefreshHandler: runtime.oauthRefreshHandler,
    oauthWebConfig: runtime.oauthWebConfig,
    readinessCheckHandler: runtime.readinessCheckHandler,
    releaseCreationHandler: runtime.releaseCreationHandler,
    releaseCreationPreflightHandler: runtime.releaseCreationPreflightHandler,
    releaseListHandler: runtime.releaseListHandler,
    releaseMetricsReadHandler: runtime.releaseMetricsReadHandler,
    releasePatchHandler: runtime.releasePatchHandler,
    releasePromoteHandler: runtime.releasePromoteHandler,
    releaseReadHandler: runtime.releaseReadHandler,
    releaseUploadStorage: runtime.releaseUploadStorage,
    teamAppsListHandler: runtime.teamAppsListHandler,
    teamCreateHandler: runtime.teamCreateHandler,
    teamListHandler: runtime.teamListHandler,
    teamReadHandler: runtime.teamReadHandler,
    userProfileHandler: runtime.userProfileHandler,
    workerReconcileHandler: runtime.workerReconcileHandler,
    workerSharedSecret: config.workerSharedSecret,
  });

  try {
    app.addHook("onClose", async () => {
      await runtime.close();
    });

    await runtime.start();

    const address = await app.listen({
      host: config.host,
      port: config.port,
    });

    app.log.info({ address, mode: config.mode }, "server listening");

    return app;
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
}
