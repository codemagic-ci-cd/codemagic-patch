import type { ApiTokenMetadata } from "../model/apiToken";
import type { App } from "../model/app";
import type { Deployment } from "../model/deployment";
import type {
  RoleBinding,
  RoleDefinition,
  RoleRef,
  TeamInvitation,
} from "../model/iam";
import type { ReleaseMetrics } from "../model/metrics";
import type { Release, ReleaseJob } from "../model/release";
import type { Team } from "../model/team";
import type {
  DeploymentTimeseries,
  TimeseriesPoint,
} from "../model/timeseries";
import type { User } from "../model/user";
import type {
  AppWithDeploymentsResponse,
  DeploymentClearResponse,
  IamInvitationCreateBody,
  IamRoleBindingCreateBody,
  IamRoleBindingUpdateBody,
  IamUserProvisionBody,
  IamUserProvisionResponse,
  InvitationCreateResponse,
  OAuthCallbackBody,
  OAuthRefreshBody,
  OAuthWebConfig,
  RefreshResponse,
  ReleaseCreationWarning,
  ReleaseLifecycleResponse,
  ReleaseListItem,
  ReleaseMetricsEntry,
  ReleaseReadResponse,
  ReleasesListResponse,
  ReleasePatchResponse,
  SessionResponse,
  SessionUser,
} from "./types";

export interface TeamWire {
  created_at: string;
  id: string;
  name: string;
  status: Team["status"];
  updated_at: string;
}

export interface AppWire {
  created_at: string;
  id: string;
  name: string;
  require_code_signing: boolean;
  team_id: string;
  updated_at: string;
}

export interface DeploymentWire {
  app_id: string;
  created_at: string;
  deployment_key: string;
  id: string;
  name: string;
  team_id: string;
  updated_at: string;
}

export interface ReleaseWire {
  app_id: string;
  created_at: string;
  created_by: string | null;
  deployment_id: string;
  failure_reason: string | null;
  failure_stage: string | null;
  fingerprint: string | null;
  id: string;
  is_mandatory: boolean;
  processing_attempt_count: number;
  processing_finished_at: string | null;
  processing_started_at: string | null;
  release_label: string;
  release_notes: string | null;
  rollback_of: string | null;
  rollout_percentage: number;
  signature: string | null;
  signature_hash_algorithm: string | null;
  status: Release["status"];
  target_binary_version: string;
  target_package_hash: string | null;
  team_id: string;
  updated_at: string;
}

export interface ReleaseJobWire {
  attempt_count: number;
  claim_generation: number;
  created_at: string;
  deployment_id: string;
  failure_reason: string | null;
  failure_stage: string | null;
  id: string;
  last_heartbeat_at: string | null;
  lease_expires_at: string | null;
  max_total_attempts: number;
  release_id: string;
  requested_by: string | null;
  status: ReleaseJob["status"];
  trigger_type: ReleaseJob["triggerType"];
  updated_at: string;
}

export interface ApiTokenWire {
  created_at: string;
  display_name: string;
  expires_at: string | null;
  id: string;
  last_used_at: string | null;
  masked_prefix: string;
}

export interface UserWire {
  created_at: string;
  display_name: string | null;
  email: string;
  id: string;
  oauth_provider: string | null;
  oauth_subject: string | null;
  status: User["status"];
  updated_at: string;
}

export interface SessionUserWire {
  created_at: string;
  display_name: string | null;
  email: string;
  id: string;
}

export interface SessionWireResponse {
  access_token: string;
  access_token_expires_at: string;
  refresh_token: string;
  refresh_token_expires_at: string;
  user: SessionUserWire;
}

export interface RefreshWireResponse {
  access_token: string;
  access_token_expires_at: string;
  refresh_token: string;
  refresh_token_expires_at: string;
}

export interface OAuthWebConfigWire {
  client_id: string;
  provider: string;
  scopes: string;
  /** Optional; absent = normal GitHub mode. */
  mode?: string;
  /** Optional; absent = github.com, "" = same-origin. */
  authorize_base_url?: string;
}

export interface RoleWire {
  display_name: string;
  id: string;
  is_system: boolean;
  key: string;
  permissions: RoleDefinition["permissions"];
}

export interface RoleRefWire {
  display_name: string;
  id: string;
  key: string;
}

export interface RoleBindingWire {
  created_at: string;
  created_by: string | null;
  id: string;
  principal_type: "user";
  role: RoleRefWire;
  scope: {
    id: string;
    type: "team";
  };
  user: {
    display_name: string | null;
    email: string;
    id: string;
  };
}

export interface InvitationWire {
  accepted_at: string | null;
  accepted_by: string | null;
  created_at: string;
  created_by: string;
  email: string | null;
  expires_at: string;
  github_handle: string | null;
  id: string;
  revoked_at: string | null;
  revoked_by: string | null;
  role: RoleRefWire;
  role_binding_id: string | null;
  status: TeamInvitation["status"];
  team_id: string;
}

export interface ReleaseMetricsRowWire {
  metrics: ReleaseMetrics;
  release_id: string;
  release_label: string;
  target_binary_version: string;
  target_package_hash: string | null;
}

export interface TeamsListWireResponse {
  teams: TeamWire[];
}

export interface TeamWireResponse {
  team: TeamWire;
}

export interface AppsListWireResponse {
  apps: AppWire[];
}

export interface AppWireResponse {
  app: AppWire;
}

export interface AppWithDeploymentsWireResponse {
  app: AppWire;
  deployments: DeploymentWire[];
}

export interface DeploymentsListWireResponse {
  deployments: DeploymentWire[];
}

export interface DeploymentWireResponse {
  deployment: DeploymentWire;
}

export interface DeploymentClearWireResponse {
  deleted_release_count: number;
  deployment: DeploymentWire;
}

export interface ReleaseListItemWire {
  job: ReleaseJobWire | null;
  metrics?: ReleaseMetrics;
  release: ReleaseWire;
}

export interface ReleasesListWireResponse {
  pagination: ReleasesListResponse["pagination"];
  releases: ReleaseListItemWire[];
}

export interface ReleaseReadWireResponse {
  job: ReleaseJobWire | null;
  release: ReleaseWire;
}

export interface ReleasePatchWireResponse {
  job: ReleaseJobWire;
  release: ReleaseWire;
  warnings?: ReleaseCreationWarningWire[];
}

export type ReleaseCreationWarningWire =
  | {
      code: "duplicate-release";
      detail: string;
    }
  | {
      code: "fingerprint-disagreement";
      detail: string;
      binary_version: string;
      stored_fingerprint: string;
      release_fingerprint: string;
    };

export interface ReleaseLifecycleWireResponse {
  job: ReleaseJobWire;
  release: ReleaseWire;
  warnings?: ReleaseCreationWarningWire[];
}

export interface DeploymentMetricsWireResponse {
  pagination: ReleasesListResponse["pagination"];
  releases: ReleaseMetricsRowWire[];
}

export interface ReleaseMetricsWireResponse {
  release: ReleaseMetricsRowWire;
}

export interface TimeseriesPointWire {
  active_devices: number;
  bucket_start: string;
  downloaded: number;
  failed: number;
  installed: number;
  success: number;
}

export interface TimeseriesSeriesWire {
  points: TimeseriesPointWire[];
  release_id: string | null;
  release_label: string | null;
  target_package_hash: string | null;
}

export interface DeploymentTimeseriesWireResponse {
  bucket: "day";
  from: string;
  series: TimeseriesSeriesWire[];
  series_truncated: boolean;
  to: string;
  totals: TimeseriesPointWire[];
}

export interface RolesListWireResponse {
  roles: RoleWire[];
}

export interface RoleBindingsListWireResponse {
  role_bindings: RoleBindingWire[];
}

export interface InvitationsListWireResponse {
  invitations: InvitationWire[];
}

export interface RoleBindingCreateWireResponse {
  role_binding: RoleBindingWire;
}

export type InvitationCreateWireResponse =
  | {
      invitation: InvitationWire;
      outcome: "pending";
    }
  | {
      invitation: InvitationWire;
      outcome: "accepted_existing_user";
      role_binding: RoleBindingWire;
    }
  | {
      invitation: null;
      outcome: "already_granted";
      role_binding: RoleBindingWire;
    };

export interface IamUserProvisionWireResponse {
  api_token: ApiTokenWire;
  role_binding: RoleBindingWire;
  token: string;
  user: IamUserProvisionResponse["user"];
}

export interface MeWireResponse {
  user: UserWire;
}

export interface ApiTokensListWireResponse {
  api_tokens: ApiTokenWire[];
}

export interface ApiTokenCreateWireResponse {
  api_token: ApiTokenWire;
  token: string;
}

export function fromTeamWire(team: TeamWire): Team {
  return {
    createdAt: team.created_at,
    id: team.id,
    name: team.name,
    status: team.status,
    updatedAt: team.updated_at,
  };
}

export function fromAppWire(app: AppWire): App {
  return {
    createdAt: app.created_at,
    id: app.id,
    name: app.name,
    requireCodeSigning: app.require_code_signing,
    teamId: app.team_id,
    updatedAt: app.updated_at,
  };
}

export function fromDeploymentWire(deployment: DeploymentWire): Deployment {
  return {
    appId: deployment.app_id,
    createdAt: deployment.created_at,
    deploymentKey: deployment.deployment_key,
    id: deployment.id,
    name: deployment.name,
    teamId: deployment.team_id,
    updatedAt: deployment.updated_at,
  };
}

export function fromReleaseWire(release: ReleaseWire): Release {
  return {
    appId: release.app_id,
    createdAt: release.created_at,
    createdBy: release.created_by,
    deploymentId: release.deployment_id,
    failureReason: release.failure_reason,
    failureStage: release.failure_stage,
    fingerprint: release.fingerprint,
    id: release.id,
    isMandatory: release.is_mandatory,
    processingAttemptCount: release.processing_attempt_count,
    processingFinishedAt: release.processing_finished_at,
    processingStartedAt: release.processing_started_at,
    releaseLabel: release.release_label,
    releaseNotes: release.release_notes,
    rollbackOf: release.rollback_of,
    rolloutPercentage: release.rollout_percentage,
    signature: release.signature,
    signatureHashAlgorithm: release.signature_hash_algorithm,
    status: release.status,
    targetBinaryVersion: release.target_binary_version,
    targetPackageHash: release.target_package_hash,
    teamId: release.team_id,
    updatedAt: release.updated_at,
  };
}

export function fromReleaseJobWire(job: ReleaseJobWire): ReleaseJob {
  return {
    attemptCount: job.attempt_count,
    claimGeneration: job.claim_generation,
    createdAt: job.created_at,
    deploymentId: job.deployment_id,
    failureReason: job.failure_reason,
    failureStage: job.failure_stage,
    id: job.id,
    lastHeartbeatAt: job.last_heartbeat_at,
    leaseExpiresAt: job.lease_expires_at,
    maxTotalAttempts: job.max_total_attempts,
    releaseId: job.release_id,
    requestedBy: job.requested_by,
    status: job.status,
    triggerType: job.trigger_type,
    updatedAt: job.updated_at,
  };
}

export function fromApiTokenWire(apiToken: ApiTokenWire): ApiTokenMetadata {
  return {
    createdAt: apiToken.created_at,
    displayName: apiToken.display_name,
    expiresAt: apiToken.expires_at,
    id: apiToken.id,
    lastUsedAt: apiToken.last_used_at,
    maskedPrefix: apiToken.masked_prefix,
  };
}

export function fromUserWire(user: UserWire): User {
  return {
    createdAt: user.created_at,
    displayName: user.display_name,
    email: user.email,
    id: user.id,
    oauthProvider: user.oauth_provider,
    oauthSubject: user.oauth_subject,
    status: user.status,
    updatedAt: user.updated_at,
  };
}

export function fromSessionUserWire(user: SessionUserWire): SessionUser {
  return {
    createdAt: user.created_at,
    displayName: user.display_name,
    email: user.email,
    id: user.id,
  };
}

export function fromSessionWire(response: SessionWireResponse): SessionResponse {
  return {
    accessToken: response.access_token,
    accessTokenExpiresAt: response.access_token_expires_at,
    refreshToken: response.refresh_token,
    refreshTokenExpiresAt: response.refresh_token_expires_at,
    user: fromSessionUserWire(response.user),
  };
}

export function fromRefreshWire(response: RefreshWireResponse): RefreshResponse {
  return {
    accessToken: response.access_token,
    accessTokenExpiresAt: response.access_token_expires_at,
    refreshToken: response.refresh_token,
    refreshTokenExpiresAt: response.refresh_token_expires_at,
  };
}

export function fromOAuthWebConfigWire(
  config: OAuthWebConfigWire,
): OAuthWebConfig {
  return {
    clientId: config.client_id,
    provider: config.provider,
    scopes: config.scopes,
    // "" is a present value (same-origin authorize) — key on undefined only.
    ...(config.mode === undefined ? {} : { mode: config.mode }),
    ...(config.authorize_base_url === undefined
      ? {}
      : { authorizeBaseUrl: config.authorize_base_url }),
  };
}

export function fromRoleWire(role: RoleWire): RoleDefinition {
  return {
    displayName: role.display_name,
    id: role.id,
    isSystem: role.is_system,
    key: role.key,
    permissions: role.permissions,
  };
}

export function fromRoleRefWire(role: RoleRefWire): RoleRef {
  return {
    displayName: role.display_name,
    id: role.id,
    key: role.key,
  };
}

export function fromRoleBindingWire(
  roleBinding: RoleBindingWire,
): RoleBinding {
  return {
    createdAt: roleBinding.created_at,
    createdBy: roleBinding.created_by,
    id: roleBinding.id,
    principalType: roleBinding.principal_type,
    role: fromRoleRefWire(roleBinding.role),
    scope: roleBinding.scope,
    user: {
      displayName: roleBinding.user.display_name,
      email: roleBinding.user.email,
      id: roleBinding.user.id,
    },
  };
}

export function fromInvitationWire(invitation: InvitationWire): TeamInvitation {
  return {
    acceptedAt: invitation.accepted_at,
    acceptedBy: invitation.accepted_by,
    createdAt: invitation.created_at,
    createdBy: invitation.created_by,
    email: invitation.email,
    expiresAt: invitation.expires_at,
    githubHandle: invitation.github_handle,
    id: invitation.id,
    revokedAt: invitation.revoked_at,
    revokedBy: invitation.revoked_by,
    role: fromRoleRefWire(invitation.role),
    roleBindingId: invitation.role_binding_id,
    status: invitation.status,
    teamId: invitation.team_id,
  };
}

export function fromReleaseMetricsRowWire(
  row: ReleaseMetricsRowWire,
): ReleaseMetricsEntry {
  return {
    metrics: row.metrics,
    releaseId: row.release_id,
    releaseLabel: row.release_label,
    targetBinaryVersion: row.target_binary_version,
    targetPackageHash: row.target_package_hash,
  };
}

export function fromDeploymentTimeseriesWire(
  response: DeploymentTimeseriesWireResponse,
): DeploymentTimeseries {
  return {
    bucket: response.bucket,
    from: response.from,
    series: response.series.map((series) => ({
      points: series.points.map(fromTimeseriesPointWire),
      releaseId: series.release_id,
      releaseLabel: series.release_label,
      targetPackageHash: series.target_package_hash,
    })),
    seriesTruncated: response.series_truncated,
    to: response.to,
    totals: response.totals.map(fromTimeseriesPointWire),
  };
}

function fromTimeseriesPointWire(point: TimeseriesPointWire): TimeseriesPoint {
  return {
    activeDevices: point.active_devices,
    bucketStart: point.bucket_start,
    downloaded: point.downloaded,
    failed: point.failed,
    installed: point.installed,
    success: point.success,
  };
}

export function fromAppWithDeploymentsWireResponse(
  response: AppWithDeploymentsWireResponse,
): AppWithDeploymentsResponse {
  return {
    app: fromAppWire(response.app),
    deployments: response.deployments.map(fromDeploymentWire),
  };
}

export function fromDeploymentClearWireResponse(
  response: DeploymentClearWireResponse,
): DeploymentClearResponse {
  return {
    deletedReleaseCount: response.deleted_release_count,
    deployment: fromDeploymentWire(response.deployment),
  };
}

export function fromReleaseListItemWire(
  item: ReleaseListItemWire,
): ReleaseListItem {
  return {
    job: item.job ? fromReleaseJobWire(item.job) : null,
    ...(item.metrics ? { metrics: item.metrics } : {}),
    release: fromReleaseWire(item.release),
  };
}

export function fromReleasesListWireResponse(
  response: ReleasesListWireResponse,
): ReleasesListResponse {
  return {
    pagination: response.pagination,
    releases: response.releases.map(fromReleaseListItemWire),
  };
}

export function fromReleaseReadWireResponse(
  response: ReleaseReadWireResponse,
): ReleaseReadResponse {
  return {
    job: response.job ? fromReleaseJobWire(response.job) : null,
    release: fromReleaseWire(response.release),
  };
}

export function fromReleasePatchWireResponse(
  response: ReleasePatchWireResponse,
): ReleasePatchResponse {
  return {
    job: fromReleaseJobWire(response.job),
    release: fromReleaseWire(response.release),
    ...(response.warnings
      ? { warnings: response.warnings.map(fromReleaseCreationWarningWire) }
      : {}),
  };
}

function fromReleaseCreationWarningWire(
  warning: ReleaseCreationWarningWire,
): ReleaseCreationWarning {
  if (warning.code === "fingerprint-disagreement") {
    return {
      binaryVersion: warning.binary_version,
      code: warning.code,
      detail: warning.detail,
      releaseFingerprint: warning.release_fingerprint,
      storedFingerprint: warning.stored_fingerprint,
    };
  }

  return {
    code: warning.code,
    detail: warning.detail,
  };
}

export function fromReleaseLifecycleWireResponse(
  response: ReleaseLifecycleWireResponse,
): ReleaseLifecycleResponse {
  return {
    job: fromReleaseJobWire(response.job),
    release: fromReleaseWire(response.release),
    ...(response.warnings
      ? { warnings: response.warnings.map(fromReleaseCreationWarningWire) }
      : {}),
  };
}

export function fromInvitationCreateWireResponse(
  response: InvitationCreateWireResponse,
): InvitationCreateResponse {
  if (response.outcome === "pending") {
    return {
      invitation: fromInvitationWire(response.invitation),
      outcome: response.outcome,
    };
  }

  return {
    invitation: response.invitation
      ? fromInvitationWire(response.invitation)
      : null,
    outcome: response.outcome,
    roleBinding: fromRoleBindingWire(response.role_binding),
  } as InvitationCreateResponse;
}

export function fromIamUserProvisionWireResponse(
  response: IamUserProvisionWireResponse,
): IamUserProvisionResponse {
  return {
    apiToken: fromApiTokenWire(response.api_token),
    roleBinding: fromRoleBindingWire(response.role_binding),
    token: response.token,
    user: response.user,
  };
}

export function fromApiTokenCreateWireResponse(
  response: ApiTokenCreateWireResponse,
) {
  return {
    apiToken: fromApiTokenWire(response.api_token),
    token: response.token,
  };
}

export function toOAuthCallbackWireBody(body: OAuthCallbackBody) {
  return {
    code: body.code,
    code_verifier: body.codeVerifier,
    provider: body.provider,
    redirect_uri: body.redirectUri,
  };
}

export function toOAuthRefreshWireBody(body: OAuthRefreshBody) {
  return {
    refresh_token: body.refreshToken,
  };
}

export function toIamRoleBindingWireBody(body: IamRoleBindingCreateBody) {
  return {
    ...(body.email !== undefined ? { email: body.email } : {}),
    role_id: body.roleId,
    team_id: body.teamId,
    ...(body.userId !== undefined ? { user_id: body.userId } : {}),
  };
}

export function toIamRoleBindingUpdateWireBody(body: IamRoleBindingUpdateBody) {
  return {
    role_id: body.roleId,
  };
}

export function toIamInvitationWireBody(body: IamInvitationCreateBody) {
  return {
    ...(body.email !== undefined ? { email: body.email } : {}),
    ...(body.githubHandle !== undefined
      ? { github_handle: body.githubHandle }
      : {}),
    ...(body.expiresInDays !== undefined
      ? { expires_in_days: body.expiresInDays }
      : {}),
    role_id: body.roleId,
    team_id: body.teamId,
  };
}

export function toIamUserProvisionWireBody(body: IamUserProvisionBody) {
  return {
    ...(body.displayName !== undefined ? { display_name: body.displayName } : {}),
    email: body.email,
    ...(body.expiresInDays !== undefined
      ? { expires_in_days: body.expiresInDays }
      : {}),
    role_id: body.roleId,
    team_id: body.teamId,
    ...(body.tokenDisplayName !== undefined
      ? { token_display_name: body.tokenDisplayName }
      : {}),
  };
}
