import { randomUUID } from "node:crypto";

import { S3Client } from "@aws-sdk/client-s3";
import { Storage } from "@google-cloud/storage";

import {
  BaseUrlDeliveryAdapter,
  CloudflareDeliveryAdapter,
  createNativeGcsStorageClient,
  type DeliveryAdapter,
  GcsStorageAdapter,
  type JobQueueAdapter,
  type StorageAdapter,
  InMemoryStorageAdapter,
  InProcessJobQueue,
  S3StorageAdapter,
} from "../adapters";
import {
  createDatabasePool,
  dbMigrations,
  migrateDatabase,
  type DatabasePool,
  type SqlMigration,
} from "../db";
import type {
  ApiTokenId,
  AppId,
  DeploymentId,
  MembershipId,
  ReleaseId,
  ReleaseJobId,
  RoleBindingId,
  RoleDefinitionId,
  TeamId,
  TeamInvitationId,
  UserId,
} from "../domain";
import {
  createPostgresAuditRepository,
  createPostgresIamInvitationRepository,
  createPostgresIamRepository,
  createPostgresIdempotencyRepository,
  createPostgresAuthRepository,
  createPostgresManagementRepository,
  createPostgresMetricsRepository,
  createPostgresReconcileContextRepository,
  createPostgresReleaseArtifactRepository,
  createPostgresReleaseRepository,
  createPostgresReleaseFinalizeRepository,
  createPostgresReleaseJobRepository,
  createPostgresReleaseTargetRepository,
  ZERO_RELEASE_METRICS,
  type AppDeleteStaticState,
  type AuditRepository,
  type DeploymentClearStaticState,
  type DeploymentDeleteStaticState,
  type TeamInvitationTarget,
} from "../repositories";
import type {
  ApiTokenCreateRouteHandler,
  ApiTokenDeleteRouteHandler,
  ApiTokenListRouteHandler,
  AppCreateRouteHandler,
  AppDeleteRouteHandler,
  AppDeploymentsListRouteHandler,
  AppReadRouteHandler,
  AppTransferRouteHandler,
  AppUpdateRouteHandler,
  AuditEventWriteRouteHandler,
  DeploymentClearRouteHandler,
  DeploymentCreateRouteHandler,
  DeploymentDeleteRouteHandler,
  DeploymentMetricsRouteHandler,
  DeploymentRollbackRouteHandler,
  DeploymentTimeseriesRouteHandler,
  DeploymentUpdateRouteHandler,
  IamRoleBindingCreateRouteHandler,
  IamRoleBindingDeleteRouteHandler,
  IamRoleBindingListRouteHandler,
  IamRoleBindingReadRouteHandler,
  IamRoleBindingUpdateRouteHandler,
  IamInvitationCreateRouteHandler,
  IamInvitationListRouteHandler,
  IamInvitationReadRouteHandler,
  IamInvitationRevokeRouteHandler,
  IamInvitationRouteModel,
  IamRoleListRouteHandler,
  IamUserProvisionRouteHandler,
  IdempotencyHandler,
  MetricEventIngestRouteHandler,
  OAuthCallbackRouteHandler,
  OAuthDevicePollRouteHandler,
  OAuthDeviceStartRouteHandler,
  OAuthLogoutRouteHandler,
  OAuthRefreshRouteHandler,
  OAuthWebConfig,
  ReleaseCreationPreflightRouteHandler,
  ReleaseCreationRouteHandler,
  ReleaseListRouteHandler,
  ReleaseMetricsReadRouteHandler,
  ReadinessCheckResult,
  ReleasePatchRouteHandler,
  ReleasePromoteRouteHandler,
  ReleaseReadRouteHandler,
  TeamAppsListRouteHandler,
  TeamCreateRouteHandler,
  TeamListRouteHandler,
  TeamReadRouteHandler,
  UserProfileRouteHandler,
} from "../app/types";
import type { AuthNAdapter } from "../app/authNAdapter";
import { assembleDeploymentTimeseries } from "../app/metricsTimeseries";
import { createGitHubAuthNAdapter } from "../app/githubAuthNAdapter";
import {
  createGitHubDeviceAuthAdapter,
  type OAuthDeviceAuthAdapter,
} from "../app/githubDeviceAuthAdapter";
import {
  createGitHubUserLookupService,
  type GitHubUserLookupService,
} from "../app/githubUserLookupService";
import {
  createApiTokenMaskedPrefix,
  generateApiToken,
} from "../app/apiToken";
import { getOrCreateUser } from "../app/userProvisioning";
import { canonicalizeEmail } from "../app/email";
import {
  createOAuthSessionRouteHandlers,
  type OAuthInitialAdminTeamMembershipService,
  type OAuthInvitationFulfillmentService,
  type OAuthSessionHandlerIdGenerator,
  type OAuthSignInGrantService,
} from "../app/oauthSessionHandlers";
import {
  createAuthorizationService,
  type AuthorizationService,
} from "../app/authorizationService";
import {
  createDbApiTokenControlPlaneAuth,
  type ControlPlaneAuthHandler,
} from "../app/controlPlaneAuth";
import {
  makeDeploymentMetaPublicKey,
  makeFallbackManifestPublicKey,
  makeManifestPublicKey,
  manifestSerializer,
  reconcileRelease,
  startupSweep,
  type ReconcileResult,
} from "../worker/index";
import type { RuntimeConfig } from "./config";
import { createNoopLogger, type RuntimeLogger } from "./logger";
import { createTrackedReconcileExecutor } from "./trackedReconcileExecutor";

// Self-host runs a single fixed team. The name is intentionally hard-coded
// (not configurable) so every deployment, CLI, and dashboard agree on it.
const DEFAULT_TEAM_NAME = "default-team";

export interface ServerRuntime {
  apiTokenCreateHandler?: ApiTokenCreateRouteHandler;
  apiTokenDeleteHandler?: ApiTokenDeleteRouteHandler;
  apiTokenListHandler?: ApiTokenListRouteHandler;
  appCreateHandler?: AppCreateRouteHandler;
  appDeleteHandler?: AppDeleteRouteHandler;
  appDeploymentsListHandler?: AppDeploymentsListRouteHandler;
  appReadHandler?: AppReadRouteHandler;
  appTransferHandler?: AppTransferRouteHandler;
  appUpdateHandler?: AppUpdateRouteHandler;
  auditEventWriteHandler?: AuditEventWriteRouteHandler;
  authorizationService?: AuthorizationService;
  close(): Promise<void>;
  controlPlaneAuthHandler?: ControlPlaneAuthHandler;
  deploymentClearHandler?: DeploymentClearRouteHandler;
  deploymentCreateHandler?: DeploymentCreateRouteHandler;
  deploymentDeleteHandler?: DeploymentDeleteRouteHandler;
  deploymentMetricsHandler?: DeploymentMetricsRouteHandler;
  deploymentRollbackHandler?: DeploymentRollbackRouteHandler;
  deploymentTimeseriesHandler?: DeploymentTimeseriesRouteHandler;
  deploymentUpdateHandler?: DeploymentUpdateRouteHandler;
  iamInvitationCreateHandler?: IamInvitationCreateRouteHandler;
  iamInvitationListHandler?: IamInvitationListRouteHandler;
  iamInvitationReadHandler?: IamInvitationReadRouteHandler;
  iamInvitationRevokeHandler?: IamInvitationRevokeRouteHandler;
  iamRoleBindingCreateHandler?: IamRoleBindingCreateRouteHandler;
  iamRoleBindingDeleteHandler?: IamRoleBindingDeleteRouteHandler;
  iamRoleBindingListHandler?: IamRoleBindingListRouteHandler;
  iamRoleBindingReadHandler?: IamRoleBindingReadRouteHandler;
  iamRoleBindingUpdateHandler?: IamRoleBindingUpdateRouteHandler;
  iamRoleListHandler?: IamRoleListRouteHandler;
  iamUserProvisionHandler?: IamUserProvisionRouteHandler;
  idempotencyHandler?: IdempotencyHandler;
  metricEventIngestHandler?: MetricEventIngestRouteHandler;
  oauthCallbackHandler?: OAuthCallbackRouteHandler;
  oauthDevicePollHandler?: OAuthDevicePollRouteHandler;
  oauthDeviceStartHandler?: OAuthDeviceStartRouteHandler;
  oauthLogoutHandler?: OAuthLogoutRouteHandler;
  oauthRefreshHandler?: OAuthRefreshRouteHandler;
  oauthWebConfig?: OAuthWebConfig;
  readinessCheckHandler: () => Promise<ReadinessCheckResult>;
  releaseCreationHandler?: ReleaseCreationRouteHandler;
  releaseCreationPreflightHandler?: ReleaseCreationPreflightRouteHandler;
  releaseListHandler?: ReleaseListRouteHandler;
  releaseMetricsReadHandler?: ReleaseMetricsReadRouteHandler;
  releasePatchHandler?: ReleasePatchRouteHandler;
  releasePromoteHandler?: ReleasePromoteRouteHandler;
  releaseReadHandler?: ReleaseReadRouteHandler;
  releaseUploadStorage?: StorageAdapter;
  start(): Promise<void>;
  teamAppsListHandler?: TeamAppsListRouteHandler;
  teamCreateHandler?: TeamCreateRouteHandler;
  teamListHandler?: TeamListRouteHandler;
  teamReadHandler?: TeamReadRouteHandler;
  userProfileHandler?: UserProfileRouteHandler;
  workerReconcileHandler?: (jobId: string) => Promise<ReconcileResult>;
}

export interface ManagementIdGenerator {
  createAppId(): string;
  createDeploymentId(): string;
  createDeploymentKey(): string;
  createTeamId(): string;
}

export interface ServerRuntimeOptions {
  authNAdapter?: AuthNAdapter;
  /**
   * Replaces the built-in authorization service. The factory receives the
   * runtime's database pool, so embedders can layer custom policy on top of
   * (or delegate to) `createAuthorizationService(pool)`.
   */
  authorizationService?: (pool: DatabasePool) => AuthorizationService;
  /**
   * "auto" (default) idempotently provisions the fixed single-team setup on
   * boot. "none" skips it for embedders that manage team provisioning
   * themselves; the initial-admin bootstrap-team grant becomes a no-op.
   */
  bootstrapTeam?: "auto" | "none";
  /**
   * Additional migrations appended after the built-in chain. Tracked by name
   * in the same schema_migration table, so names must be unique across both.
   */
  extraMigrations?: readonly SqlMigration[];
  githubDeviceAuthAdapter?: OAuthDeviceAuthAdapter;
  githubUserLookupService?: GitHubUserLookupService;
  /**
   * Interval for the recurring job sweep that requeues expired-lease work
   * lost to a crashed instance. The boot sweep alone recovers such jobs only
   * on the first start after their lease expires; the interval closes the
   * gap for long-lived instances. 0 disables the recurring sweep.
   */
  jobSweepIntervalMs?: number;
  logger?: RuntimeLogger;
  managementIdGenerator?: ManagementIdGenerator;
  managementRetryLimit?: number;
  oauthSessionIdGenerator?: OAuthSessionHandlerIdGenerator;
  /**
   * Replaces the post-sign-in grant hook (runs on web OAuth and device-flow
   * sign-ins). Defaults to the initial-admin bootstrap-team ownership grant.
   */
  oauthSignInGrantService?: (pool: DatabasePool) => OAuthSignInGrantService;
  /**
   * Replaces the GitHub-config-derived web OAuth config served by
   * GET /v1/auth/oauth/web-config, so embedders that inject an authNAdapter
   * can point the dashboard login at their own authorize endpoint.
   */
  oauthWebConfig?: OAuthWebConfig;
}

export async function createServerRuntime(
  config: RuntimeConfig,
  options: ServerRuntimeOptions = {},
): Promise<ServerRuntime> {
  if (
    (config.mode === "all" || config.mode === "worker") &&
    !config.workerSharedSecret
  ) {
    throw new Error(
      "WORKER_SHARED_SECRET is required when worker capabilities are enabled",
    );
  }

  const needsControlPlaneAuth = config.mode === "all" || config.mode === "api";

  if (
    needsControlPlaneAuth &&
    !config.githubOAuth &&
    !options.authNAdapter &&
    !options.githubDeviceAuthAdapter
  ) {
    throw new Error(
      "GITHUB_OAUTH_CLIENT_ID is required when control-plane auth is enabled",
    );
  }

  if (
    needsControlPlaneAuth &&
    config.registrationMode === "invite_only" &&
    config.initialAdminEmails.length === 0
  ) {
    // Booting in this state would lock the deployment out permanently: the
    // first admin cannot sign in (registration is invite-only) and no admin
    // exists to send invitations.
    throw new Error(
      "INITIAL_ADMIN_EMAILS is required when registration is invite-only: set it so the first admin can sign in via GitHub OAuth, or set REGISTRATION_MODE=open. On a deployment upgraded from a pre-OAuth install, set it to the existing admin's email — their first sign-in links the GitHub identity to the existing account.",
    );
  }

  const logger = options.logger ?? createNoopLogger();
  const pool = createRequiredPool(config);

  try {
    if (config.runMigrations) {
      await migrateDatabase(
        pool,
        options.extraMigrations?.length
          ? [...dbMigrations, ...options.extraMigrations]
          : undefined,
      );
    }

    const releaseRepository = createPostgresReleaseRepository(pool);
    const auditRepository = createPostgresAuditRepository(pool);
    const idempotencyRepository = createPostgresIdempotencyRepository(pool);
    const metricsRepository = createPostgresMetricsRepository(pool);
    const authRepository = needsControlPlaneAuth
      ? createPostgresAuthRepository(pool)
      : null;
    const iamInvitationRepository = authRepository
      ? createPostgresIamInvitationRepository(pool)
      : null;
    const controlPlaneAuthHandler = needsControlPlaneAuth
      ? createControlPlaneAuthHandler(authRepository)
      : undefined;
    const authorizationService = authRepository
      ? (options.authorizationService?.(pool) ?? createAuthorizationService(pool))
      : undefined;
    const userAuthHandlers = authRepository
      ? createUserAuthHandlers(authRepository)
      : {};
    // Device flow: an injected adapter is honored without any GitHub config
    // (local-dev entry, embedders); the GitHub-config-derived adapter remains
    // the fallback. The handlers additionally require the poll-token secret
    // (parsed independently of the GitHub config for the same reason), so an
    // injected adapter without OAUTH_DEVICE_POLL_TOKEN_SECRET still serves 501.
    const githubDeviceAuthAdapter = authRepository
      ? options.githubDeviceAuthAdapter ??
        (config.githubOAuth
          ? createGitHubDeviceAuthAdapter({
              apiBaseUrl: config.githubOAuth.apiBaseUrl,
              clientId: config.githubOAuth.clientId,
              oauthBaseUrl: config.githubOAuth.oauthBaseUrl,
              scopes: config.githubOAuth.scopes,
            })
          : undefined)
      : undefined;
    // Web OAuth (authorization-code exchange) is enabled exactly when the
    // client secret is configured; device-only config leaves the callback
    // handler undefined so the route answers 501. Injection always wins.
    const authNAdapter =
      authRepository && config.githubOAuth?.clientSecret
        ? options.authNAdapter ??
          createGitHubAuthNAdapter({
            allowedRedirectUris: config.githubOAuth.allowedRedirectUris,
            apiBaseUrl: config.githubOAuth.apiBaseUrl,
            clientId: config.githubOAuth.clientId,
            clientSecret: config.githubOAuth.clientSecret,
            oauthBaseUrl: config.githubOAuth.oauthBaseUrl,
          })
        : options.authNAdapter;
    // Handle→subject directory lookup for GitHub-handle invitations. Enabled
    // whenever GitHub OAuth is configured (self-host always is); injection wins
    // for tests. Unauthenticated public lookups — see githubUserLookupService.
    const githubUserLookupService = config.githubOAuth
      ? (options.githubUserLookupService ??
        createGitHubUserLookupService({
          apiBaseUrl: config.githubOAuth.apiBaseUrl,
        }))
      : options.githubUserLookupService;
    const managementIdGenerator =
      options.managementIdGenerator ?? createDefaultManagementIdGenerator();
    // Bootstrap-team id, resolved after migrations (see ensureBootstrapTeam
    // below). The initial-admin membership service reads it lazily at sign-in
    // time, so it is always populated before any request is served.
    let bootstrapTeamId: TeamId | null = null;
    const initialAdminEmailSet = new Set(
      config.initialAdminEmails.map((email) => canonicalizeEmail(email)),
    );
    const oauthSignInGrantService = !authRepository
      ? undefined
      : options.oauthSignInGrantService
        ? options.oauthSignInGrantService(pool)
        : initialAdminEmailSet.size > 0
          ? createInitialAdminTeamMembershipService(
              authRepository,
              initialAdminEmailSet,
              () => bootstrapTeamId,
            )
          : undefined;
    const oauthSessionHandlers =
      authRepository && (authNAdapter || githubDeviceAuthAdapter)
        ? createOAuthSessionRouteHandlers({
            accessTokenTtlSeconds: config.oauthAccessTokenTtlSeconds,
            authNAdapter,
            deviceAuthAdapter: githubDeviceAuthAdapter,
            idGenerator: options.oauthSessionIdGenerator,
            initialAdminEmails: config.initialAdminEmails,
            initialAdminTeamMembershipService: oauthSignInGrantService,
            invitationFulfillmentService: iamInvitationRepository
              ? createIamInvitationFulfillmentService(
                  iamInvitationRepository,
                  auditRepository,
                )
              : undefined,
            pollTokenSecret: config.oauthDevicePollTokenSecret,
            refreshTokenTtlDays: config.oauthRefreshTokenTtlDays,
            registrationMode: config.registrationMode,
            repository: authRepository,
          })
        : {};
    // Web OAuth is enabled exactly when the client secret is configured; the
    // public web-config route serves 404 (about:blank) otherwise. An injected
    // web config wins so embedders with an injected authNAdapter can drive
    // the dashboard login without any GitHub config.
    const oauthWebConfig: OAuthWebConfig | undefined =
      options.oauthWebConfig ??
      (config.githubOAuth?.clientSecret
        ? {
            clientId: config.githubOAuth.clientId,
            provider: "github",
            scopes: config.githubOAuth.scopes,
          }
        : undefined);
    const storage = config.mode === "api" ? null : createStorageAdapter(config);
    const delivery =
      config.mode === "api" ? null : createDeliveryAdapter(config);
    const managementRepository =
      config.mode === "all" || config.mode === "api"
        ? createPostgresManagementRepository(pool)
        : null;
    const iamRepository =
      managementRepository && authRepository
        ? createPostgresIamRepository(pool)
        : null;

    // Self-host single-team bootstrap: ensure the fixed `default-team` exists
    // (idempotently) once the schema is migrated. The id is captured so the
    // initial-admin membership service can grant ownership on sign-in.
    // Skipped when the embedder opts out via bootstrapTeam: "none"; the
    // initial-admin grant then short-circuits on the null team id.
    if (managementRepository && (options.bootstrapTeam ?? "auto") === "auto") {
      await assertSingleTeamScopeModel(pool);
      bootstrapTeamId = await ensureBootstrapTeam(
        managementRepository,
        DEFAULT_TEAM_NAME,
        logger,
      );
    }

    const managementHandlers = managementRepository
      ? createManagementHandlers(
          managementRepository,
          managementIdGenerator,
          options.managementRetryLimit ?? 3,
          authRepository,
          storage && delivery
            ? {
                clearDeploymentStaticState:
                  createDeploymentStaticStateClearer({
                    delivery,
                    logger,
                    manifestCacheControl: config.manifestCacheControl,
                    storage,
                  }),
                deleteDeploymentStaticState:
                  createDeploymentDeleteStaticStateCleaner({
                    clearDeploymentStaticState:
                      createDeploymentStaticStateClearer({
                        delivery,
                        logger,
                        manifestCacheControl: config.manifestCacheControl,
                        storage,
                      }),
                    delivery,
                    logger,
                    storage,
                  }),
                deleteAppStaticState: createAppDeleteStaticStateCleaner({
                  deleteDeploymentStaticState:
                    createDeploymentDeleteStaticStateCleaner({
                      clearDeploymentStaticState:
                        createDeploymentStaticStateClearer({
                          delivery,
                          logger,
                          manifestCacheControl: config.manifestCacheControl,
                          storage,
                        }),
                      delivery,
                      logger,
                      storage,
                    }),
                }),
              }
            : undefined,
        )
      : {};
    const iamHandlers = iamRepository ? createIamHandlers(iamRepository) : {};
    const iamUserProvisionHandlers =
      authRepository && iamRepository
        ? createIamUserProvisionHandler(authRepository, iamRepository)
        : {};
    const iamInvitationHandlers = managementRepository && iamInvitationRepository
      ? createIamInvitationHandlers(
          iamInvitationRepository,
          config.iamInvitationTtlDays,
          githubUserLookupService,
        )
      : {};
    const dependencies =
      storage && delivery
        ? {
            artifactRepository: createPostgresReleaseArtifactRepository(pool),
            contextRepository: createPostgresReconcileContextRepository(
              pool,
              config.patchWindow,
            ),
            delivery,
            finalizeRepository: createPostgresReleaseFinalizeRepository(pool),
            jobRepository: createPostgresReleaseJobRepository(pool),
            logger: {
              warn(message: string, context?: Record<string, unknown>) {
                logger.warn(context ?? {}, message);
              },
            },
            releaseRepository,
            manifestCacheControl: config.manifestCacheControl,
            stagedBundleRetention: config.stagedBundleRetention,
            storage,
            targetRepository: createPostgresReleaseTargetRepository(pool),
          }
        : null;

    const reconcileWithLifecycleLogs = async (
      jobId: ReleaseJobId,
    ): Promise<ReconcileResult> => {
      if (!dependencies) {
        throw new Error("reconcile dependencies are not available");
      }

      const startedAt = Date.now();
      logger.info({ event: "release_job.started", jobId }, "release job started");

      const result = await reconcileRelease(jobId, dependencies);
      const durationMs = Date.now() - startedAt;

      if (result.outcome === "succeeded") {
        logger.info(
          {
            durationMs,
            event: "release_job.succeeded",
            jobId,
            planSummary: result.planSummary,
          },
          "release job succeeded",
        );
      } else if (result.outcome === "noop") {
        logger.info(
          { durationMs, event: "release_job.noop", jobId, reason: result.reason },
          "release job was a noop",
        );
      } else if (result.retryable) {
        logger.warn(
          {
            attemptCount: result.retryAttemptCount,
            durationMs,
            event: "release_job.failed_retryable",
            jobId,
            reason: result.reason,
            stage: result.stage,
          },
          "release job failed and is retryable",
        );
      } else {
        logger.error(
          {
            durationMs,
            event: "release_job.failed_terminal",
            jobId,
            reason: result.reason,
            stage: result.stage,
          },
          "release job failed terminally",
        );
      }

      return result;
    };

    const executor = dependencies
      ? createTrackedReconcileExecutor(reconcileWithLifecycleLogs, {
          onBackgroundError(error, jobId) {
            logger.error(
              { err: error, event: "release_job.execution_error", jobId },
              "background reconcile failed",
            );
          },
        })
      : null;

    let queue: InProcessJobQueue | null = null;

    const runReconcile = async (
      jobId: ReleaseJobId,
    ): Promise<ReconcileResult> => {
      if (!executor) {
        throw new Error(
          "worker reconcile handler is not available in api mode",
        );
      }

      const result = await executor.execute(jobId);
      if (result.outcome === "failed" && result.retryable && queue) {
        const delayMs = computeRetryDelay(result.retryAttemptCount ?? 1);
        await queue.enqueue(jobId, { delayMs });
        logger.info(
          {
            attemptCount: result.retryAttemptCount,
            delayMs,
            event: "release_job.retry_scheduled",
            jobId,
          },
          "release job retry scheduled",
        );
      }

      return result;
    };

    const enqueueRecoveredJob = async (jobId: ReleaseJobId): Promise<void> => {
      if (queue) {
        await queue.enqueue(jobId);
        return;
      }

      executor?.executeInBackground(jobId);
    };

    const runSweepWithLogs = async (
      trigger: "interval" | "startup",
    ): Promise<void> => {
      const sweep = await startupSweep(pool, { enqueue: enqueueRecoveredJob });
      const recoveredJobCount =
        sweep.createdQueuedJobCount +
        sweep.requeuedExpiredRunningCount +
        sweep.requeuedStuckProcessingCount;
      const context = {
        createdQueuedJobCount: sweep.createdQueuedJobCount,
        event: "job_sweep.completed",
        recoveredJobCount,
        requeuedExpiredRunningCount: sweep.requeuedExpiredRunningCount,
        requeuedStuckProcessingCount: sweep.requeuedStuckProcessingCount,
        trigger,
      };

      if (recoveredJobCount > 0) {
        logger.warn(context, "job sweep recovered jobs from a prior run");
      } else if (trigger === "startup") {
        logger.info(context, "startup job sweep completed");
      }
      // Quiet interval sweeps: an empty result every interval is not signal.
    };
    const runStartupSweepWithLogs = () => runSweepWithLogs("startup");

    // The recurring sweep is what recovers a job orphaned by an instance
    // crash without waiting for the next boot: the boot sweep only ever sees
    // leases that expired before this instance started. Errors are logged
    // and the next tick retries; the sweep's lease gate keeps concurrent or
    // repeated runs safe.
    const jobSweepIntervalMs = options.jobSweepIntervalMs ?? 60_000;
    let jobSweepTimer: ReturnType<typeof setInterval> | undefined;
    const startPeriodicSweep = (): void => {
      if (jobSweepIntervalMs <= 0 || jobSweepTimer) {
        return;
      }

      jobSweepTimer = setInterval(() => {
        runSweepWithLogs("interval").catch((error: unknown) => {
          logger.error(
            { err: error, event: "job_sweep.failed", trigger: "interval" },
            "recurring job sweep failed",
          );
        });
      }, jobSweepIntervalMs);
      jobSweepTimer.unref();
    };

    if (config.mode === "all" && executor) {
      queue = new InProcessJobQueue({
        async execute(jobId) {
          await runReconcile(jobId);
        },
        onExecutionError(error, jobId) {
          logger.error(
            { err: error, event: "release_job.execution_error", jobId },
            "in-process queue execution failed",
          );
        },
        runStartupSweep: runStartupSweepWithLogs,
      });
    }

    // Concurrent probes share one in-flight check so a slow/hung database
    // holds at most one pool connection regardless of probe frequency.
    let inflightReadinessCheck: Promise<ReadinessCheckResult> | null = null;
    const runReadinessCheck = async (): Promise<ReadinessCheckResult> => {
      const db = (await checkDatabaseReady(pool, logger)) ? "ok" : "error";
      return {
        checks: { db },
        ok: db === "ok",
      } as const;
    };

    return {
      ...userAuthHandlers,
      ...oauthSessionHandlers,
      ...managementHandlers,
      ...iamHandlers,
      ...iamUserProvisionHandlers,
      ...iamInvitationHandlers,
      auditEventWriteHandler: createAuditEventWriteHandler(auditRepository),
      authorizationService,
      controlPlaneAuthHandler,
      deploymentMetricsHandler:
        config.mode === "all" || config.mode === "api"
          ? createDeploymentMetricsHandler(releaseRepository, metricsRepository)
          : undefined,
      deploymentTimeseriesHandler:
        config.mode === "all" || config.mode === "api"
          ? createDeploymentTimeseriesHandler(
              releaseRepository,
              metricsRepository,
            )
          : undefined,
      idempotencyHandler: createIdempotencyHandler(idempotencyRepository),
      oauthWebConfig,
      releaseCreationHandler:
        config.mode === "all"
          ? createReleaseCreationHandler(releaseRepository, queue)
          : undefined,
      releaseCreationPreflightHandler:
        config.mode === "all"
          ? createReleaseCreationPreflightHandler(releaseRepository)
          : undefined,
      releaseListHandler:
        config.mode === "all" || config.mode === "api"
          ? createReleaseListHandler(releaseRepository, metricsRepository)
          : undefined,
      metricEventIngestHandler:
        config.mode === "all" || config.mode === "api"
          ? createMetricEventIngestHandler(metricsRepository)
          : undefined,
      releaseMetricsReadHandler:
        config.mode === "all" || config.mode === "api"
          ? createReleaseMetricsReadHandler(releaseRepository, metricsRepository)
          : undefined,
      releasePatchHandler:
        config.mode === "all"
          ? createReleasePatchHandler(releaseRepository, queue)
          : undefined,
      releasePromoteHandler:
        config.mode === "all"
          ? createReleasePromoteHandler(releaseRepository, queue)
          : undefined,
      deploymentRollbackHandler:
        config.mode === "all"
          ? createDeploymentRollbackHandler(releaseRepository, queue)
          : undefined,
      releaseReadHandler:
        config.mode === "all" || config.mode === "api"
          ? createReleaseReadHandler(releaseRepository)
          : undefined,
      releaseUploadStorage:
        config.mode === "all" && storage ? storage : undefined,

      async close() {
        if (jobSweepTimer) {
          clearInterval(jobSweepTimer);
          jobSweepTimer = undefined;
        }
        await queue?.stop();
        await executor?.waitForIdle();
        if (storage instanceof S3StorageAdapter) {
          storage.dispose();
        }
        await pool.end();
      },

      async start() {
        if (queue) {
          await queue.start();
          startPeriodicSweep();
          return;
        }

        if (executor) {
          await runStartupSweepWithLogs();
          startPeriodicSweep();
        }
      },

      readinessCheckHandler() {
        inflightReadinessCheck ??= runReadinessCheck().finally(() => {
          inflightReadinessCheck = null;
        });
        return inflightReadinessCheck;
      },

      async workerReconcileHandler(jobId) {
        return runReconcile(jobId as ReleaseJobId);
      },
    };
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}

function createControlPlaneAuthHandler(
  authRepository: ReturnType<typeof createPostgresAuthRepository> | null,
): ControlPlaneAuthHandler {
  if (!authRepository) {
    throw new Error("auth repository is required for DB-backed auth modes");
  }

  return createDbApiTokenControlPlaneAuth(authRepository);
}

function createUserAuthHandlers(
  repository: ReturnType<typeof createPostgresAuthRepository>,
): Pick<
  ServerRuntime,
  | "apiTokenCreateHandler"
  | "apiTokenDeleteHandler"
  | "apiTokenListHandler"
  | "userProfileHandler"
> {
  return {
    async apiTokenCreateHandler(input) {
      const createdAt = new Date();
      const generated = generateApiToken();
      const expiresAt =
        input.expiresInDays === undefined
          ? null
          : new Date(
              createdAt.getTime() + input.expiresInDays * 24 * 60 * 60 * 1000,
            );
      const apiToken = await repository.createApiToken({
        createdAt,
        displayName: input.displayName,
        expiresAt,
        id: createRandomPrefixedId("tok") as ApiTokenId,
        maskedPrefix: generated.maskedPrefix,
        tokenHash: generated.tokenHash,
        userId: input.userId as UserId,
      });

      return {
        apiToken,
        outcome: "created",
        plaintextToken: generated.token,
      };
    },

    async apiTokenDeleteHandler(userId, tokenId) {
      const deleted = await repository.deleteApiTokenForUser(
        userId as UserId,
        tokenId as ApiTokenId,
      );

      return deleted
        ? {
            outcome: "deleted",
          }
        : {
            outcome: "not_found",
          };
    },

    async apiTokenListHandler(userId) {
      return {
        apiTokens: await repository.listApiTokensForUser(userId as UserId),
      };
    },

    async userProfileHandler(userId) {
      const user = await repository.getUserById(userId as UserId);

      return user
        ? {
            outcome: "found",
            user,
          }
        : {
            outcome: "not_found",
            reason: "user_not_found",
          };
    },
  };
}

function createRequiredPool(config: RuntimeConfig): DatabasePool {
  if (!config.databaseUrl) {
    throw new Error(`DATABASE_URL is required when MODE=${config.mode}`);
  }

  return createDatabasePool({
    connectionString: config.databaseUrl,
    max: config.databaseMaxConnections,
    searchPath: config.databaseSearchPath,
  });
}

function createStorageAdapter(config: RuntimeConfig): StorageAdapter {
  if (config.storageAdapter === "memory") {
    return new InMemoryStorageAdapter();
  }

  if (config.storageAdapter === "s3") {
    if (!config.s3) {
      throw new Error(
        "S3 storage adapter selected but S3 configuration is missing",
      );
    }

    const credentials =
      config.s3.accessKeyId && config.s3.secretAccessKey
        ? {
            accessKeyId: config.s3.accessKeyId,
            secretAccessKey: config.s3.secretAccessKey,
          }
        : undefined;

    const client = new S3Client({
      credentials,
      endpoint: config.s3.endpoint,
      forcePathStyle: config.s3.forcePathStyle,
      region: config.s3.region,
    });

    return new S3StorageAdapter({ bucket: config.s3.bucket, client });
  }

  if (config.storageAdapter === "gcs") {
    if (!config.gcs) {
      throw new Error(
        "GCS storage adapter selected but GCS configuration is missing",
      );
    }

    return new GcsStorageAdapter({
      internalBucket: config.gcs.internalBucket,
      publicBucket: config.gcs.publicBucket,
      storage: createNativeGcsStorageClient(new Storage()),
    });
  }

  throw new Error(
    `Unsupported storage adapter: ${config.storageAdapter satisfies never}`,
  );
}

function createDeliveryAdapter(config: RuntimeConfig): DeliveryAdapter {
  if (config.deliveryAdapter === "base-url") {
    return new BaseUrlDeliveryAdapter({
      baseUrl: config.publicBaseUrl,
    });
  }

  if (config.deliveryAdapter === "cloudflare") {
    if (!config.cloudflare) {
      throw new Error(
        "Cloudflare delivery configuration is missing; CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID are required when DELIVERY_ADAPTER=cloudflare",
      );
    }
    return new CloudflareDeliveryAdapter({
      apiBaseUrl: config.cloudflare.apiBaseUrl,
      apiToken: config.cloudflare.apiToken,
      baseUrl: config.publicBaseUrl,
      zoneId: config.cloudflare.zoneId,
    });
  }

  throw new Error(
    `Unsupported delivery adapter: ${config.deliveryAdapter satisfies never}`,
  );
}

function createDeploymentStaticStateClearer(options: {
  delivery: DeliveryAdapter;
  logger: RuntimeLogger;
  manifestCacheControl: string;
  storage: StorageAdapter;
}): (state: DeploymentClearStaticState) => Promise<void> {
  return async (state) => {
    const manifestKeys = buildDeploymentClearManifestKeys(state);
    const metaKey = makeDeploymentMetaPublicKey(state.deploymentKey);
    const clearManifest = manifestSerializer.serialize({
      isMandatory: false,
      releaseNotes: null,
      rolloutPercentage: 100,
      targetPackageHash: null,
    });

    await Promise.all([
      ...manifestKeys.map((key) =>
        options.storage.put(key, Buffer.from(clearManifest.json, "utf8"), {
          cacheControl: options.manifestCacheControl,
          contentType: "application/json",
          metadata: {
            content_hash: clearManifest.contentHash,
          },
        }),
      ),
      options.storage.delete(metaKey),
    ]);

    await options.delivery
      .purge([metaKey, ...manifestKeys])
      .then((result) => {
        if (result.failures.length > 0) {
          options.logger.warn(
            {
              deploymentKey: state.deploymentKey,
              failures: result.failures,
            },
            "deployment clear delivery cache purge completed with failures",
          );
        }
      })
      .catch((error) => {
        options.logger.warn(
          {
            deploymentKey: state.deploymentKey,
            error: error instanceof Error ? error.message : String(error),
          },
          "deployment clear delivery cache purge failed",
        );
      });
  };
}

function createDeploymentDeleteStaticStateCleaner(options: {
  clearDeploymentStaticState: (
    state: DeploymentClearStaticState,
  ) => Promise<void>;
  delivery: DeliveryAdapter;
  logger: RuntimeLogger;
  storage: StorageAdapter;
}): (state: DeploymentDeleteStaticState) => Promise<void> {
  return async (state) => {
    await options.clearDeploymentStaticState(state);

    const keys = new Set(state.artifactStorageKeys);
    for (const releaseId of state.releaseIds) {
      await collectStorageKeys(options.storage, `_internal/releases/${releaseId}/`)
        .then((internalKeys) => {
          for (const key of internalKeys) {
            keys.add(key);
          }
        })
        .catch((error) => {
          options.logger.warn(
            {
              error: error instanceof Error ? error.message : String(error),
              releaseId,
            },
            "deployment delete artifact listing failed",
          );
        });
    }

    const artifactKeys = [...keys].sort();
    const deleteFailures: Array<{ key: string; message: string }> = [];

    await Promise.all(
      artifactKeys.map((key) =>
        options.storage.delete(key).catch((error) => {
          deleteFailures.push({
            key,
            message: error instanceof Error ? error.message : String(error),
          });
        }),
      ),
    );

    if (deleteFailures.length > 0) {
      options.logger.warn(
        {
          deploymentKey: state.deploymentKey,
          failures: deleteFailures,
        },
        "deployment delete artifact cleanup completed with failures",
      );
    }

    const publicArtifactKeys = artifactKeys.filter(
      (key) => !key.startsWith("_internal/"),
    );
    if (publicArtifactKeys.length > 0) {
      await options.delivery
        .purge(publicArtifactKeys)
        .then((result) => {
          if (result.failures.length > 0) {
            options.logger.warn(
              {
                deploymentKey: state.deploymentKey,
                failures: result.failures,
              },
              "deployment delete artifact delivery cache purge completed with failures",
            );
          }
        })
        .catch((error) => {
          options.logger.warn(
            {
              deploymentKey: state.deploymentKey,
              error: error instanceof Error ? error.message : String(error),
            },
            "deployment delete artifact delivery cache purge failed",
          );
        });
    }
  };
}

function createAppDeleteStaticStateCleaner(options: {
  deleteDeploymentStaticState: (
    state: DeploymentDeleteStaticState,
  ) => Promise<void>;
}): (state: AppDeleteStaticState) => Promise<void> {
  return async (state) => {
    for (const deployment of state.deployments) {
      await options.deleteDeploymentStaticState(deployment);
    }
  };
}

async function collectStorageKeys(
  storage: StorageAdapter,
  prefix: string,
): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;

  do {
    const page = await storage.list(prefix, cursor ? { cursor } : undefined);
    keys.push(...page.keys);
    cursor = page.cursor;

    if (!page.isTruncated) {
      break;
    }
  } while (cursor);

  return keys;
}

function buildDeploymentClearManifestKeys(
  state: DeploymentClearStaticState,
): string[] {
  const keys = new Set<string>();

  for (const binaryVersion of state.binaryVersions) {
    keys.add(makeFallbackManifestPublicKey(state.deploymentKey, binaryVersion));

    for (const packageHash of state.packageHashes) {
      keys.add(
        makeManifestPublicKey(
          state.deploymentKey,
          binaryVersion,
          packageHash,
        ),
      );
    }
  }

  return [...keys].sort();
}

function createManagementHandlers(
  repository: ReturnType<typeof createPostgresManagementRepository>,
  idGenerator: ManagementIdGenerator,
  retryLimit: number,
  authRepository: ReturnType<typeof createPostgresAuthRepository> | null,
  options: {
    clearDeploymentStaticState?: (
      state: DeploymentClearStaticState,
    ) => Promise<void>;
    deleteAppStaticState?: (state: AppDeleteStaticState) => Promise<void>;
    deleteDeploymentStaticState?: (
      state: DeploymentDeleteStaticState,
    ) => Promise<void>;
  } = {},
): Pick<
  ServerRuntime,
  | "appCreateHandler"
  | "appDeleteHandler"
  | "appDeploymentsListHandler"
  | "appReadHandler"
  | "appTransferHandler"
  | "appUpdateHandler"
  | "deploymentClearHandler"
  | "deploymentCreateHandler"
  | "deploymentDeleteHandler"
  | "deploymentUpdateHandler"
  | "teamAppsListHandler"
  | "teamCreateHandler"
  | "teamListHandler"
  | "teamReadHandler"
> {
  const boundedRetryLimit = Math.max(1, retryLimit);

  return {
    async appCreateHandler(input) {
      const createdAt = new Date();

      for (let attempt = 1; attempt <= boundedRetryLimit; attempt += 1) {
        const stagingDeploymentId = idGenerator.createDeploymentId();
        const productionDeploymentId = idGenerator.createDeploymentId();
        const stagingDeploymentKey = idGenerator.createDeploymentKey();
        const productionDeploymentKey = idGenerator.createDeploymentKey();

        const result = await repository.createAppWithDefaultDeployments({
          appId: idGenerator.createAppId() as AppId,
          createdAt,
          deploymentIds: {
            production: productionDeploymentId as DeploymentId,
            staging: stagingDeploymentId as DeploymentId,
          },
          deploymentKeys: {
            production: productionDeploymentKey,
            staging: stagingDeploymentKey,
          },
          name: input.name,
          requireCodeSigning: input.requireCodeSigning,
          teamId: input.teamId as TeamId,
        });

        if (
          result.outcome === "conflict" &&
          result.reason === "app_name_exists"
        ) {
          return {
            outcome: "conflict",
            reason: result.reason,
          };
        }

        if (result.outcome === "conflict") {
          if (attempt < boundedRetryLimit) {
            continue;
          }

          return {
            outcome: "failed",
            reason: "deployment_key_generation_exhausted",
          };
        }

        return result;
      }

      return {
        outcome: "failed",
        reason: "deployment_key_generation_exhausted",
      };
    },

    async appDeploymentsListHandler(appId) {
      return repository.listDeploymentsForApp(appId as AppId);
    },

    async deploymentCreateHandler(input) {
      const createdAt = new Date();

      for (let attempt = 1; attempt <= boundedRetryLimit; attempt += 1) {
        const result = await repository.createDeployment({
          appId: input.appId as AppId,
          createdAt,
          deploymentId: idGenerator.createDeploymentId() as DeploymentId,
          deploymentKey: idGenerator.createDeploymentKey(),
          name: input.name,
        });

        if (
          result.outcome === "conflict" &&
          result.reason === "deployment_name_exists"
        ) {
          return {
            outcome: "conflict",
            reason: result.reason,
          };
        }

        if (result.outcome === "conflict") {
          if (attempt < boundedRetryLimit) {
            continue;
          }

          return {
            outcome: "failed",
            reason: "deployment_key_generation_exhausted",
          };
        }

        return result;
      }

      return {
        outcome: "failed",
        reason: "deployment_key_generation_exhausted",
      };
    },

    async appUpdateHandler(input) {
      return repository.updateApp(input.appId as AppId, {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.requireCodeSigning === undefined
          ? {}
          : { requireCodeSigning: input.requireCodeSigning }),
        updatedAt: new Date(),
      });
    },

    async appTransferHandler(input) {
      return repository.transferApp(input.appId as AppId, {
        destinationTeamId: input.destinationTeamId as TeamId,
        updatedAt: new Date(),
      });
    },

    async deploymentUpdateHandler(input) {
      return repository.updateDeployment(input.deploymentId as DeploymentId, {
        name: input.name,
        updatedAt: new Date(),
      });
    },

    ...(options.clearDeploymentStaticState
      ? {
          async deploymentClearHandler(deploymentId) {
            return repository.clearDeployment(deploymentId as DeploymentId, {
              beforeDeleteStaticState: options.clearDeploymentStaticState,
            });
          },
        }
      : {}),

    ...(options.deleteDeploymentStaticState
      ? {
          async deploymentDeleteHandler(deploymentId) {
            return repository.deleteDeployment(deploymentId as DeploymentId, {
              beforeDeleteStaticState: options.deleteDeploymentStaticState,
            });
          },
        }
      : {}),

    ...(options.deleteAppStaticState
      ? {
          async appDeleteHandler(appId) {
            return repository.deleteApp(appId as AppId, {
              beforeDeleteStaticState: options.deleteAppStaticState,
            });
          },
        }
      : {}),

    async appReadHandler(appId) {
      return repository.getAppById(appId as AppId);
    },

    async teamAppsListHandler(teamId) {
      return repository.listAppsForTeam(teamId as TeamId);
    },

    async teamCreateHandler(input) {
      if (input.userId && authRepository) {
        return authRepository.createTeamForUser({
          createdAt: new Date(),
          membershipId: createRandomPrefixedId("mem") as MembershipId,
          name: input.name,
          roleBindingId: createRandomPrefixedId("rb") as RoleBindingId,
          teamId: idGenerator.createTeamId() as TeamId,
          userId: input.userId as UserId,
        });
      }

      return repository.createTeam({
        createdAt: new Date(),
        id: idGenerator.createTeamId() as TeamId,
        name: input.name,
      });
    },

    async teamListHandler() {
      return {
        teams: await repository.listTeams(),
      };
    },

    async teamReadHandler(teamId) {
      return repository.getTeamById(teamId as TeamId);
    },
  };
}

function createIamHandlers(
  repository: ReturnType<typeof createPostgresIamRepository>,
): Pick<
  ServerRuntime,
  | "iamRoleBindingCreateHandler"
  | "iamRoleBindingDeleteHandler"
  | "iamRoleBindingListHandler"
  | "iamRoleBindingReadHandler"
  | "iamRoleBindingUpdateHandler"
  | "iamRoleListHandler"
> {
  return {
    async iamRoleBindingCreateHandler(input) {
      return repository.grantTeamRoleBinding({
        bindingId: createRandomPrefixedId("rb") as RoleBindingId,
        createdAt: new Date(),
        createdBy: input.createdBy as UserId,
        membershipId: createRandomPrefixedId("mem") as MembershipId,
        roleId: input.roleId as RoleDefinitionId,
        teamId: input.teamId as TeamId,
        userSelector:
          input.userSelector.type === "email"
            ? {
                email: input.userSelector.email,
                type: "email",
              }
            : {
                type: "userId",
                userId: input.userSelector.userId as UserId,
              },
      });
    },

    async iamRoleBindingDeleteHandler(bindingId) {
      return repository.deleteTeamRoleBinding(bindingId as RoleBindingId);
    },

    async iamRoleBindingListHandler(teamId) {
      return repository.listTeamRoleBindings(teamId as TeamId);
    },

    async iamRoleBindingReadHandler(bindingId) {
      return repository.getTeamRoleBinding(bindingId as RoleBindingId);
    },

    async iamRoleBindingUpdateHandler(input) {
      return repository.updateTeamRoleBinding({
        bindingId: input.bindingId as RoleBindingId,
        roleId: input.roleId as RoleDefinitionId,
      });
    },

    async iamRoleListHandler() {
      const roles = await repository.listSystemRoles();

      return {
        roles: roles.map(({ permissions, role }) => ({
          displayName: role.displayName,
          id: role.id,
          isSystem: role.isSystem,
          key: role.key,
          permissions,
        })),
      };
    },
  };
}

function createIamUserProvisionHandler(
  authRepository: ReturnType<typeof createPostgresAuthRepository>,
  iamRepository: ReturnType<typeof createPostgresIamRepository>,
): Pick<ServerRuntime, "iamUserProvisionHandler"> {
  return {
    async iamUserProvisionHandler(input) {
      const now = new Date();

      // 1. Create the user account. The API token is minted last (step 3), so a
      //    failed role grant never leaves an orphaned secret behind.
      const userResult = await getOrCreateUser(authRepository, {
        createdAt: now,
        displayName: input.displayName,
        email: input.email,
        id: createRandomPrefixedId("usr") as UserId,
      });
      if (!userResult.created) {
        // Provisioning mints and returns a usable credential, so it is limited to
        // brand-new accounts. Minting a token for a pre-existing user would let
        // any team admin obtain an API token that impersonates that user across
        // every team they belong to. Grant roles to existing users with
        // POST /v1/iam/role-bindings instead.
        return {
          outcome: "user_exists",
        };
      }

      // 2. Grant the team role binding. This validates that the team is active
      //    and the role exists/is supported before any token is created.
      const grant = await iamRepository.grantTeamRoleBinding({
        bindingId: createRandomPrefixedId("rb") as RoleBindingId,
        createdAt: now,
        createdBy: input.createdBy as UserId,
        membershipId: createRandomPrefixedId("mem") as MembershipId,
        roleId: input.roleId as RoleDefinitionId,
        teamId: input.teamId as TeamId,
        userSelector: {
          email: input.email,
          type: "email",
        },
      });
      if (grant.outcome === "not_found") {
        if (grant.reason === "user_not_found") {
          throw new Error(
            "provisioned user was not found when granting its role binding",
          );
        }
        return {
          outcome: "not_found",
          reason: grant.reason,
        };
      }
      if (grant.outcome === "account_disabled") {
        return {
          outcome: "account_disabled",
          reason: grant.reason,
        };
      }
      if (grant.outcome === "role_not_supported") {
        return {
          outcome: "role_not_supported",
        };
      }

      // 3. Mint the API token only after the account and role grant succeeded.
      const generated = generateApiToken();
      const expiresAt =
        input.expiresInDays === undefined
          ? null
          : new Date(
              now.getTime() + input.expiresInDays * 24 * 60 * 60 * 1000,
            );
      const apiToken = await authRepository.createApiToken({
        createdAt: now,
        displayName: input.tokenDisplayName,
        expiresAt,
        id: createRandomPrefixedId("tok") as ApiTokenId,
        maskedPrefix: createApiTokenMaskedPrefix(generated.token),
        tokenHash: generated.tokenHash,
        userId: userResult.user.id,
      });

      return {
        apiToken,
        membershipCreated: grant.membershipCreated,
        outcome: "provisioned",
        plaintextToken: generated.token,
        roleBinding: grant.roleBinding,
        roleBindingCreated: grant.outcome === "created",
        user: {
          created: userResult.created,
          email: userResult.user.email,
          id: userResult.user.id,
        },
      };
    },
  };
}

function createIamInvitationHandlers(
  repository: ReturnType<typeof createPostgresIamInvitationRepository>,
  invitationTtlDays: number,
  githubUserLookupService: GitHubUserLookupService | undefined,
): Pick<
  ServerRuntime,
  | "iamInvitationCreateHandler"
  | "iamInvitationListHandler"
  | "iamInvitationReadHandler"
  | "iamInvitationRevokeHandler"
> {
  return {
    async iamInvitationCreateHandler(input) {
      // Resolve the invitation target. Handle invites hit the GitHub directory
      // BEFORE opening the repository transaction — never hold a DB transaction
      // across a network call.
      let target: TeamInvitationTarget;
      if (input.target.type === "email") {
        target = { email: input.target.email, type: "email" };
      } else {
        if (!githubUserLookupService) {
          return { outcome: "handle_lookup_failed" };
        }
        const resolved = await githubUserLookupService.resolveHandle(
          input.target.githubHandle,
        );
        if (resolved.outcome === "not_found") {
          return { outcome: "handle_not_found" };
        }
        if (resolved.outcome !== "success") {
          return { outcome: "handle_lookup_failed" };
        }
        target = {
          handle: input.target.githubHandle,
          provider: resolved.provider,
          subject: resolved.subject,
          type: "oauth",
        };
      }

      const createdAt = new Date();
      const expiresInDays = input.expiresInDays ?? invitationTtlDays;
      const expiresAt = addDays(createdAt, expiresInDays);
      const result = await repository.createTeamInvitation({
        createdAt,
        createdBy: input.createdBy as UserId,
        expiresAt,
        id: createRandomPrefixedId("inv") as TeamInvitationId,
        membershipId: createRandomPrefixedId("mem") as MembershipId,
        roleBindingId: createRandomPrefixedId("rb") as RoleBindingId,
        roleId: input.roleId as RoleDefinitionId,
        target,
        teamId: input.teamId as TeamId,
      });

      switch (result.outcome) {
        case "created":
          return {
            created: true,
            invitation: toIamInvitationRouteModel(result.invitation),
            outcome: "pending",
          };
        case "already_exists":
          return {
            created: false,
            invitation: toIamInvitationRouteModel(result.invitation),
            outcome: "pending",
          };
        case "accepted_existing_user":
          return {
            invitation: toIamInvitationRouteModel(result.invitation),
            membershipCreated: result.membershipCreated,
            outcome: result.outcome,
            roleBinding: result.roleBinding,
            roleBindingCreated: result.roleBindingCreated,
          };
        case "conflict":
          return {
            invitation: toIamInvitationRouteModel(result.invitation),
            outcome: result.outcome,
            reason: result.reason,
          };
        case "already_granted":
        case "account_disabled":
        case "not_found":
        case "role_not_supported":
          return result;
      }
    },

    async iamInvitationListHandler(teamId, status) {
      const result = await repository.listTeamInvitations({
        now: new Date(),
        status,
        teamId: teamId as TeamId,
      });

      if (result.outcome === "found") {
        return {
          invitations: result.invitations.map(toIamInvitationRouteModel),
          outcome: "found",
        };
      }

      return result;
    },

    async iamInvitationReadHandler(invitationId) {
      const result = await repository.resolveTeamInvitation({
        invitationId: invitationId as TeamInvitationId,
        now: new Date(),
      });

      if (result.outcome === "found") {
        return {
          invitation: toIamInvitationRouteModel(result.invitation),
          outcome: "found",
        };
      }

      return result;
    },

    async iamInvitationRevokeHandler(invitationId, revokedBy) {
      const result = await repository.revokeTeamInvitation({
        invitationId: invitationId as TeamInvitationId,
        revokedAt: new Date(),
        revokedBy: revokedBy as UserId,
      });

      if (result.outcome === "revoked") {
        return {
          invitation: toIamInvitationRouteModel(result.invitation),
          outcome: result.outcome,
        };
      }

      if (result.outcome === "conflict") {
        return {
          invitation: toIamInvitationRouteModel(result.invitation),
          outcome: result.outcome,
          reason: result.reason,
        };
      }

      return result;
    },
  };
}

function createIamInvitationFulfillmentService(
  repository: ReturnType<typeof createPostgresIamInvitationRepository>,
  auditRepository: AuditRepository,
): OAuthInvitationFulfillmentService {
  return {
    async acceptPendingTeamInvitationsForUser(input) {
      const result = await repository.acceptPendingTeamInvitationsForUser({
        acceptedAt: input.acceptedAt,
        membershipId: () => createRandomPrefixedId("mem") as MembershipId,
        oauthProvider: input.oauthProvider,
        oauthSubject: input.oauthSubject,
        roleBindingId: () => createRandomPrefixedId("rb") as RoleBindingId,
        userEmail: input.userEmail,
        userId: input.userId,
      });

      for (const accepted of result.accepted) {
        const invitation = accepted.invitation.invitation;
        await auditRepository.persistAuditEvent({
          action: "iam.invitation.accepted",
          actorId: input.userId,
          actorType: "user",
          afterState: {
            invitation: toIamInvitationRouteModel(accepted.invitation),
            membershipCreated: accepted.membershipCreated,
            roleBindingCreated: accepted.roleBindingCreated,
          },
          beforeState: null,
          id: createRandomPrefixedId("ae"),
          ip: input.auditContext?.ip ?? null,
          requestId: input.auditContext?.requestId ?? null,
          resourceId: invitation.id,
          resourceType: "team_invitation",
          result: "success",
          teamId: invitation.teamId,
          timestamp: input.acceptedAt,
          userAgent: input.auditContext?.userAgent ?? null,
        });

        if (accepted.roleBindingCreated) {
          await auditRepository.persistAuditEvent({
            action: "iam.role_binding.created",
            actorId: input.userId,
            actorType: "user",
            afterState: {
              ...accepted.roleBinding,
              membershipCreated: accepted.membershipCreated,
            } as unknown as Record<string, unknown>,
            beforeState: null,
            id: createRandomPrefixedId("ae"),
            ip: input.auditContext?.ip ?? null,
            requestId: input.auditContext?.requestId ?? null,
            resourceId: accepted.roleBinding.id,
            resourceType: "role_binding",
            result: "success",
            teamId: invitation.teamId,
            timestamp: input.acceptedAt,
            userAgent: input.auditContext?.userAgent ?? null,
          });
        }
      }
    },
  };
}

function toIamInvitationRouteModel(input: {
  invitation: {
    acceptedAt: Date | null;
    acceptedBy: UserId | null;
    createdAt: Date;
    createdBy: UserId;
    email: string | null;
    expiresAt: Date;
    githubHandle: string | null;
    id: TeamInvitationId;
    revokedAt: Date | null;
    revokedBy: UserId | null;
    roleBindingId: RoleBindingId | null;
    status: IamInvitationRouteModel["status"];
    teamId: TeamId;
  };
  role: {
    displayName: string;
    id: RoleDefinitionId;
    key: string;
  };
}): IamInvitationRouteModel {
  return {
    acceptedAt: input.invitation.acceptedAt,
    acceptedBy: input.invitation.acceptedBy,
    createdAt: input.invitation.createdAt,
    createdBy: input.invitation.createdBy,
    email: input.invitation.email,
    expiresAt: input.invitation.expiresAt,
    githubHandle: input.invitation.githubHandle,
    id: input.invitation.id,
    revokedAt: input.invitation.revokedAt,
    revokedBy: input.invitation.revokedBy,
    role: {
      displayName: input.role.displayName,
      id: input.role.id,
      key: input.role.key,
    },
    roleBindingId: input.invitation.roleBindingId,
    status: input.invitation.status,
    teamId: input.invitation.teamId,
  };
}

/**
 * Idempotently ensure the self-host bootstrap team exists and return its id.
 * A team whose name already matches is reused (no-op); a unique-name conflict
 * from a concurrent boot is resolved by re-reading the team list.
 */
/**
 * The auto bootstrap is only safe on a database provisioned by this
 * single-team assembly. Role bindings outside the team/app scope model are
 * created only by multi-tenant assemblies (via extended migration bands and
 * their own entrypoints); booting the single-team assembly against such a
 * database — e.g. a lost compose override reverting a deployment's server
 * command — would create a stray bootstrap team and silently drop that
 * assembly's gating, so refuse loudly instead of proceeding.
 */
async function assertSingleTeamScopeModel(pool: DatabasePool): Promise<void> {
  let rows: Array<{ scope_type: string }>;
  try {
    const result = await pool.query<{ scope_type: string }>(
      "SELECT scope_type FROM role_binding WHERE scope_type NOT IN ('team', 'app') LIMIT 1",
    );
    rows = result.rows;
  } catch (error) {
    // Before the auth migrations there is no role_binding table and nothing
    // to conflict with (undefined_table).
    if ((error as { code?: string }).code === "42P01") {
      return;
    }
    throw error;
  }

  if (rows.length > 0) {
    throw new Error(
      `database contains role bindings outside the single-team scope model (scope_type "${rows[0].scope_type}") — it belongs to a multi-tenant server assembly. Refusing to auto-create the bootstrap team: check that the deployment runs its intended entrypoint (e.g. the compose override that sets the server command), or pass bootstrapTeam: "none" when embedding.`,
    );
  }
}

async function ensureBootstrapTeam(
  repository: ReturnType<typeof createPostgresManagementRepository>,
  name: string,
  logger: RuntimeLogger,
): Promise<TeamId> {
  const existing = (await repository.listTeams()).find(
    (team) => team.name === name,
  );
  if (existing) {
    logger.info(
      { event: "bootstrap_team.exists", teamId: existing.id, teamName: name },
      "bootstrap team already present",
    );
    return existing.id as TeamId;
  }

  // Generate the id here (not via the injected ManagementIdGenerator) so the
  // boot-time team never consumes id sequences that tests inject for explicit
  // team/app/deployment creation through the handlers.
  const result = await repository.createTeam({
    createdAt: new Date(),
    id: createRandomPrefixedId("team") as TeamId,
    name,
  });
  if (result.outcome === "created") {
    logger.info(
      { event: "bootstrap_team.created", teamId: result.team.id, teamName: name },
      "bootstrap team created",
    );
    return result.team.id as TeamId;
  }

  // Lost a creation race with a concurrent boot — the team now exists by name.
  const raced = (await repository.listTeams()).find(
    (team) => team.name === name,
  );
  if (raced) {
    return raced.id as TeamId;
  }

  throw new Error(`failed to ensure bootstrap team "${name}"`);
}

/**
 * Grants the configured initial admin(s) ownership of the bootstrap team on
 * sign-in. Idempotent (grantTeamOwnerByEmail upserts membership + owner role);
 * a no-op for non-admin emails or before the bootstrap team id resolves.
 */
function createInitialAdminTeamMembershipService(
  repository: ReturnType<typeof createPostgresAuthRepository>,
  adminEmails: Set<string>,
  getBootstrapTeamId: () => TeamId | null,
): OAuthInitialAdminTeamMembershipService {
  return {
    async ensureOwnershipForUser(input) {
      const teamId = getBootstrapTeamId();
      if (
        teamId === null ||
        !adminEmails.has(canonicalizeEmail(input.userEmail))
      ) {
        return;
      }

      await repository.grantTeamOwnerByEmail({
        createdAt: input.now,
        email: input.userEmail,
        membershipId: createRandomPrefixedId("mem") as MembershipId,
        roleBindingId: createRandomPrefixedId("rb") as RoleBindingId,
        teamId,
      });
    },
  };
}

function createDefaultManagementIdGenerator(): ManagementIdGenerator {
  return {
    createAppId() {
      return createRandomPrefixedId("app");
    },
    createDeploymentId() {
      return createRandomPrefixedId("dpl");
    },
    createDeploymentKey() {
      return createRandomPrefixedId("dep");
    },
    createTeamId() {
      return createRandomPrefixedId("team");
    },
  };
}

function createRandomPrefixedId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function createReleaseCreationHandler(
  repository: ReturnType<typeof createPostgresReleaseRepository>,
  queue: JobQueueAdapter | null,
): ReleaseCreationRouteHandler {
  return async (input) => {
    const result = await repository.createRelease({
      bundleStorageKey: input.bundleStorageKey,
      createdAt: new Date(),
      createdBy: input.createdBy as UserId | null,
      deploymentId: input.deploymentId as DeploymentId,
      fingerprint: input.fingerprint,
      isMandatory: input.isMandatory,
      jobId: input.jobId as ReleaseJobId,
      noDuplicateReleaseError: input.noDuplicateReleaseError,
      releaseId: input.releaseId as ReleaseId,
      releaseNotes: input.releaseNotes,
      rolloutPercentage: input.rolloutPercentage,
      signature: input.signature,
      signatureHashAlgorithm: input.signatureHashAlgorithm,
      sourceMapStorageKey: input.sourceMapStorageKey,
      status: input.disabled ? "disabled" : "uploaded",
      targetBinaryVersion: input.targetBinaryVersion,
      targetPackageHash: input.targetPackageHash,
    });

    if (result.outcome !== "created") {
      if (result.outcome === "not_created") {
        return {
          outcome: "not_found",
          reason: result.reason,
        };
      }

      return result;
    }

    await queue?.enqueue(result.job.id);
    return result;
  };
}

function createReleaseCreationPreflightHandler(
  repository: ReturnType<typeof createPostgresReleaseRepository>,
): ReleaseCreationPreflightRouteHandler {
  return async (input) => {
    const result = await repository.preflightCreateRelease({
      deploymentId: input.deploymentId as DeploymentId,
      signature: input.signature,
    });

    if (result.outcome === "not_created") {
      return {
        outcome: "not_found",
        reason: result.reason,
      };
    }

    return result;
  };
}

function createIdempotencyHandler(
  repository: ReturnType<typeof createPostgresIdempotencyRepository>,
): IdempotencyHandler {
  return {
    async complete(input) {
      await repository.completeRequest(input);
    },

    async start(input) {
      return repository.startRequest({
        bodyHash: input.bodyHash,
        key: input.key,
        method: input.method,
        path: input.path,
        startedAt: new Date(),
      });
    },
  };
}

function createAuditEventWriteHandler(
  repository: ReturnType<typeof createPostgresAuditRepository>,
): AuditEventWriteRouteHandler {
  return async (input) => {
    await repository.persistAuditEvent({
      action: input.action,
      actorId: input.actorId,
      actorType: input.actorType,
      afterState: input.afterState,
      beforeState: input.beforeState,
      id: createRandomPrefixedId("ae"),
      ip: input.ip,
      requestId: input.requestId,
      resourceId: input.resourceId,
      resourceType: input.resourceType,
      result: input.result,
      teamId: input.teamId as TeamId,
      timestamp: new Date(),
      userAgent: input.userAgent,
    });
  };
}

function createReleaseReadHandler(
  repository: ReturnType<typeof createPostgresReleaseRepository>,
): ReleaseReadRouteHandler {
  return async (releaseId) => {
    const result = await repository.getReleaseById(releaseId as ReleaseId);

    if (result.outcome === "not_found") {
      return result;
    }

    return result;
  };
}

function createReleaseListHandler(
  repository: ReturnType<typeof createPostgresReleaseRepository>,
  metricsRepository: ReturnType<typeof createPostgresMetricsRepository>,
): ReleaseListRouteHandler {
  return async (input) => {
    const result = await repository.listReleasesForDeployment({
      deploymentId: input.deploymentId as DeploymentId,
      limit: input.limit,
      offset: input.offset,
    });

    if (result.outcome === "found" && input.includeMetrics) {
      const metricsByHash =
        await metricsRepository.listReleaseMetricsForDeployment(
          input.deploymentId as DeploymentId,
          result.releases.map((entry) => entry.release.targetPackageHash),
        );

      return {
        ...result,
        releases: result.releases.map((entry) => ({
          ...entry,
          metrics: entry.release.targetPackageHash
            ? (metricsByHash.get(entry.release.targetPackageHash) ??
              ZERO_RELEASE_METRICS)
            : ZERO_RELEASE_METRICS,
        })),
      };
    }

    return result;
  };
}

function createDeploymentMetricsHandler(
  repository: ReturnType<typeof createPostgresReleaseRepository>,
  metricsRepository: ReturnType<typeof createPostgresMetricsRepository>,
): DeploymentMetricsRouteHandler {
  return async (input) => {
    const result = await repository.listReleasesForDeployment({
      deploymentId: input.deploymentId as DeploymentId,
      limit: input.limit,
      offset: input.offset,
    });

    if (result.outcome !== "found") {
      return {
        outcome: "not_found",
        reason: "deployment_not_found",
      };
    }

    const metricsByHash =
      await metricsRepository.listReleaseMetricsForDeployment(
        input.deploymentId as DeploymentId,
        result.releases.map((entry) => entry.release.targetPackageHash),
      );

    return {
      outcome: "found",
      pagination: result.pagination,
      releases: result.releases.map((entry) => ({
        releaseId: entry.release.id,
        releaseLabel: entry.release.releaseLabel,
        targetBinaryVersion: entry.release.targetBinaryVersion,
        targetPackageHash: entry.release.targetPackageHash,
        metrics: entry.release.targetPackageHash
          ? (metricsByHash.get(entry.release.targetPackageHash) ??
            ZERO_RELEASE_METRICS)
          : ZERO_RELEASE_METRICS,
      })),
    };
  };
}

function createDeploymentTimeseriesHandler(
  repository: ReturnType<typeof createPostgresReleaseRepository>,
  metricsRepository: ReturnType<typeof createPostgresMetricsRepository>,
): DeploymentTimeseriesRouteHandler {
  return async (input) => {
    const identities = await repository.listReleaseIdentitiesForDeployment(
      input.deploymentId as DeploymentId,
    );

    if (identities.outcome !== "found") {
      return {
        outcome: "not_found",
        reason: "deployment_not_found",
      };
    }

    const buckets = await metricsRepository.listDeploymentTimeseries(
      input.deploymentId as DeploymentId,
      {
        from: input.from,
        seriesLimit: input.seriesLimit,
        to: input.to,
      },
    );

    return {
      outcome: "found",
      ...assembleDeploymentTimeseries({
        releases: identities.releases,
        series: buckets.series,
        seriesTruncated: buckets.seriesTruncated,
        totals: buckets.totals,
      }),
    };
  };
}

function createReleaseMetricsReadHandler(
  repository: ReturnType<typeof createPostgresReleaseRepository>,
  metricsRepository: ReturnType<typeof createPostgresMetricsRepository>,
): ReleaseMetricsReadRouteHandler {
  return async (releaseId) => {
    const release = await repository.findReleaseById(releaseId as ReleaseId);

    if (!release) {
      return {
        outcome: "not_found",
        reason: "release_not_found",
      };
    }

    const metricsByHash =
      await metricsRepository.listReleaseMetricsForDeployment(
        release.deploymentId,
        [release.targetPackageHash],
      );

    return {
      outcome: "found",
      release: {
        releaseId: release.id,
        releaseLabel: release.releaseLabel,
        targetBinaryVersion: release.targetBinaryVersion,
        targetPackageHash: release.targetPackageHash,
        metrics: release.targetPackageHash
          ? (metricsByHash.get(release.targetPackageHash) ??
            ZERO_RELEASE_METRICS)
          : ZERO_RELEASE_METRICS,
      },
    };
  };
}

function createMetricEventIngestHandler(
  repository: ReturnType<typeof createPostgresMetricsRepository>,
): MetricEventIngestRouteHandler {
  return async (input) => {
    return repository.persistMetricEvent(input);
  };
}

function createReleasePatchHandler(
  repository: ReturnType<typeof createPostgresReleaseRepository>,
  queue: JobQueueAdapter | null,
): ReleasePatchRouteHandler {
  return async (input) => {
    const result = await repository.patchRelease({
      createdAt: new Date(),
      createdBy: input.createdBy as UserId | null,
      isMandatory: input.isMandatory,
      jobId: input.jobId as ReleaseJobId,
      releaseId: input.releaseId as ReleaseId,
      releaseNotes: input.releaseNotes,
      rolloutPercentage: input.rolloutPercentage,
      status: input.status,
      targetBinaryVersion: input.targetBinaryVersion,
    });

    if (result.outcome === "updated") {
      await queue?.enqueue(result.job.id);
    }

    return result;
  };
}

function createReleasePromoteHandler(
  repository: ReturnType<typeof createPostgresReleaseRepository>,
  queue: JobQueueAdapter | null,
): ReleasePromoteRouteHandler {
  return async (input) => {
    const result = await repository.promoteRelease({
      createdAt: new Date(),
      createdBy: input.createdBy as UserId | null,
      destinationDeploymentId: input.destinationDeploymentId as DeploymentId,
      disabled: input.disabled,
      isMandatory: input.isMandatory,
      jobId: input.jobId as ReleaseJobId,
      noDuplicateReleaseError: input.noDuplicateReleaseError,
      releaseId: input.releaseId as ReleaseId,
      releaseNotes: input.releaseNotes,
      rolloutPercentage: input.rolloutPercentage,
      sourceReleaseId: input.sourceReleaseId as ReleaseId,
      targetBinaryVersion: input.targetBinaryVersion,
    });

    if (result.outcome === "created") {
      await queue?.enqueue(result.job.id);
    }

    return result;
  };
}

function createDeploymentRollbackHandler(
  repository: ReturnType<typeof createPostgresReleaseRepository>,
  queue: JobQueueAdapter | null,
): DeploymentRollbackRouteHandler {
  return async (input) => {
    const result = await repository.rollbackDeployment({
      createdAt: new Date(),
      createdBy: input.createdBy as UserId | null,
      deploymentId: input.deploymentId as DeploymentId,
      jobId: input.jobId as ReleaseJobId,
      releaseId: input.releaseId as ReleaseId,
      targetReleaseLabel: input.targetReleaseLabel,
    });

    if (result.outcome === "created") {
      await queue?.enqueue(result.job.id);
    }

    return result;
  };
}

const RETRY_BACKOFF_BASE_MS = 1_000;
const RETRY_BACKOFF_MAX_MS = 60_000;
const RETRY_JITTER_RATIO = 0.2;

const READINESS_DB_CHECK_TIMEOUT_MS = 2_000;

async function checkDatabaseReady(
  pool: DatabasePool,
  logger: RuntimeLogger,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("readiness database check timed out")),
      READINESS_DB_CHECK_TIMEOUT_MS,
    );
  });

  try {
    const query = pool.query("SELECT 1");
    // Keep a rejection handler on the query so a failure after the timeout
    // wins the race does not surface as an unhandled rejection.
    query.catch(() => undefined);
    await Promise.race([query, timeout]);
    return true;
  } catch (error) {
    logger.warn(
      { err: error, event: "readiness_check.failed" },
      "readiness database check failed",
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function computeRetryDelay(attemptCount: number): number {
  const normalizedAttempt = Math.max(1, attemptCount);
  const baseDelay = Math.min(
    RETRY_BACKOFF_BASE_MS * 2 ** (normalizedAttempt - 1),
    RETRY_BACKOFF_MAX_MS,
  );
  const jitterWindow = Math.floor(baseDelay * RETRY_JITTER_RATIO);
  const jitter =
    jitterWindow > 0 ? Math.floor(Math.random() * (jitterWindow + 1)) : 0;

  return baseDelay + jitter;
}
