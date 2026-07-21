import type { StorageAdapter } from "../../adapters";
import type { AuthorizationService } from "../../app/authorizationService";
import type { ControlPlaneAuthHandler } from "../../app/controlPlaneAuth";
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
  IamInvitationCreateRouteHandler,
  IamInvitationListRouteHandler,
  IamInvitationReadRouteHandler,
  IamInvitationRevokeRouteHandler,
  IamRoleBindingCreateRouteHandler,
  IamRoleBindingDeleteRouteHandler,
  IamRoleBindingListRouteHandler,
  IamRoleBindingReadRouteHandler,
  IamRoleBindingUpdateRouteHandler,
  IamRoleListRouteHandler,
  IamUserProvisionRouteHandler,
  IdempotencyHandler,
  MetricEventIngestRouteHandler,
  OAuthCallbackRouteHandler,
  OAuthCliAuthorizationIssueRouteHandler,
  OAuthCliExchangeRouteHandler,
  OAuthLogoutRouteHandler,
  OAuthRefreshRouteHandler,
  OAuthWebConfig,
  ReadinessCheckRouteHandler,
  ReleaseCreationPreflightRouteHandler,
  ReleaseCreationRouteHandler,
  ReleaseListRouteHandler,
  ReleaseMetricsReadRouteHandler,
  ReleasePatchRouteHandler,
  ReleasePromoteRouteHandler,
  ReleaseReadRouteHandler,
  TeamAppsListRouteHandler,
  TeamCreateRouteHandler,
  TeamListRouteHandler,
  TeamReadRouteHandler,
  UserProfileRouteHandler,
} from "../../app/types";

export interface ReleaseCreationParams {
  deploymentId: string;
}

export interface PaginationQuery {
  limit?: unknown;
  offset?: unknown;
}

export interface ReleaseListQuery extends PaginationQuery {
  include?: unknown;
}

export interface TimeseriesRangeQuery {
  from?: unknown;
  series_limit?: unknown;
  to?: unknown;
}

export interface TeamParams {
  teamId: string;
}

export interface AppParams {
  appId: string;
}

export interface DeploymentParams {
  deploymentId: string;
}

export interface ReleaseReadParams {
  releaseId: string;
}

export interface TeamCreateBody {
  name?: unknown;
}

export interface AppCreateBody {
  name?: unknown;
  require_code_signing?: unknown;
  team_id?: unknown;
}

export interface AppUpdateBody {
  name?: unknown;
  require_code_signing?: unknown;
}

export interface AppTransferBody {
  team_id?: unknown;
}

export interface DeploymentCreateBody {
  name?: unknown;
}

export interface DeploymentUpdateBody {
  name?: unknown;
}

export interface ReleasePatchBody {
  is_mandatory?: boolean;
  release_notes?: string | null;
  rollout_percentage?: number;
  status?: string;
  target_binary_version?: string;
}

export interface ReleasePromoteBody {
  destination_deployment_id?: unknown;
  disabled?: unknown;
  is_mandatory?: unknown;
  no_duplicate_release_error?: unknown;
  release_notes?: unknown;
  rollout_percentage?: unknown;
  target_binary_version?: unknown;
}

export interface DeploymentRollbackBody {
  target_release_label?: unknown;
}

export interface ApiTokenCreateBody {
  display_name?: unknown;
  expires_in_days?: unknown;
}

export interface OAuthCallbackBody {
  code?: unknown;
  code_verifier?: unknown;
  provider?: unknown;
  redirect_uri?: unknown;
}

export interface OAuthCliAuthorizationIssueBody {
  code_challenge?: unknown;
  port?: unknown;
}

export interface OAuthCliExchangeBody {
  code?: unknown;
  code_verifier?: unknown;
}

export interface OAuthRefreshBody {
  refresh_token?: unknown;
}

export interface MetricEventBatchRequestBody {
  events?: unknown;
}

export interface ApiTokenParams {
  tokenId: string;
}

export interface IamRoleBindingListQuery {
  team_id?: unknown;
}

export interface IamRoleBindingBody {
  email?: unknown;
  role_id?: unknown;
  team_id?: unknown;
  user_id?: unknown;
}

export interface IamRoleBindingUpdateBody {
  role_id?: unknown;
}

export interface IamRoleBindingParams {
  bindingId: string;
}

export interface IamInvitationListQuery {
  status?: unknown;
  team_id?: unknown;
}

export interface IamInvitationBody {
  email?: unknown;
  expires_in_days?: unknown;
  github_handle?: unknown;
  role_id?: unknown;
  team_id?: unknown;
}

export interface IamInvitationParams {
  invitationId: string;
}

export interface IamUserProvisionBody {
  display_name?: unknown;
  email?: unknown;
  expires_in_days?: unknown;
  role_id?: unknown;
  team_id?: unknown;
  token_display_name?: unknown;
}

export interface ApiRoutesOptions {
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
  controlPlaneAuthHandler: ControlPlaneAuthHandler;
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
  maxUploadSizeBytes: number;
  metricEventIngestHandler?: MetricEventIngestRouteHandler;
  mode: "all" | "api";
  oauthCallbackHandler?: OAuthCallbackRouteHandler;
  oauthCliAuthorizationIssueHandler?: OAuthCliAuthorizationIssueRouteHandler;
  oauthCliExchangeHandler?: OAuthCliExchangeRouteHandler;
  oauthLogoutHandler?: OAuthLogoutRouteHandler;
  oauthRefreshHandler?: OAuthRefreshRouteHandler;
  oauthWebConfig?: OAuthWebConfig;
  readinessCheckHandler?: ReadinessCheckRouteHandler;
  releaseCreationHandler?: ReleaseCreationRouteHandler;
  releaseCreationPreflightHandler?: ReleaseCreationPreflightRouteHandler;
  releaseListHandler?: ReleaseListRouteHandler;
  releaseMetricsReadHandler?: ReleaseMetricsReadRouteHandler;
  releasePatchHandler?: ReleasePatchRouteHandler;
  releasePromoteHandler?: ReleasePromoteRouteHandler;
  releaseReadHandler?: ReleaseReadRouteHandler;
  releaseUploadStorage?: StorageAdapter;
  /**
   * Client download origin (`CodemagicPatchDownloadBaseUrl`). Served by
   * `GET /v1/sdk-config`.
   */
  sdkConfig?: {
    downloadBaseUrl: string;
  };
  teamAppsListHandler?: TeamAppsListRouteHandler;
  teamCreateHandler?: TeamCreateRouteHandler;
  teamListHandler?: TeamListRouteHandler;
  teamReadHandler?: TeamReadRouteHandler;
  userProfileHandler?: UserProfileRouteHandler;
}
