import type {
  App,
  ApiTokenMetadata,
  AuditEvent,
  Deployment,
  MetricEvent,
  OAuthAccessTokenMetadata,
  OAuthSession,
  RefreshTokenMetadata,
  Release,
  ReleaseJob,
  ReleaseTarget,
  RoleBinding,
  RoleDefinition,
  Team,
  TeamInvitation,
  UserAccount,
} from "../domain";

export interface UserAccountRow {
  id: string;
  email: string;
  display_name: string | null;
  status: UserAccount["status"];
  oauth_provider: string | null;
  oauth_subject: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ApiTokenRow {
  id: string;
  user_id: string;
  display_name: string;
  token_hash: string;
  masked_prefix: string;
  expires_at: Date | null;
  last_used_at: Date | null;
  created_at: Date;
}

export interface OAuthSessionRow {
  id: string;
  user_id: string;
  provider: string;
  subject: string;
  created_at: Date;
  revoked_at: Date | null;
}

export interface OAuthAccessTokenRow {
  id: string;
  session_id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
  last_used_at: Date | null;
  created_at: Date;
}

export interface RefreshTokenRow {
  id: string;
  session_id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
  created_at: Date;
}

export interface ReleaseRow {
  id: string;
  team_id: string;
  app_id: string;
  deployment_id: string;
  release_label: string;
  target_binary_version: string;
  fingerprint: string | null;
  target_package_hash: string | null;
  rollout_percentage: number;
  is_mandatory: boolean;
  release_notes: string | null;
  status: Release["status"];
  rollback_of: string | null;
  signature: string | null;
  signature_hash_algorithm: string | null;
  processing_started_at: Date | null;
  processing_finished_at: Date | null;
  processing_attempt_count: number;
  failure_stage: string | null;
  failure_reason: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ReleaseJobRow {
  id: string;
  release_id: string;
  deployment_id: string;
  trigger_type: ReleaseJob["triggerType"];
  status: ReleaseJob["status"];
  attempt_count: number;
  claim_generation: number;
  max_total_attempts: number;
  lease_expires_at: Date | null;
  last_heartbeat_at: Date | null;
  failure_stage: string | null;
  failure_reason: string | null;
  requested_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface TeamRow {
  id: string;
  name: string;
  status: Team["status"];
  created_at: Date;
  updated_at: Date;
}

export interface RoleDefinitionRow {
  id: string;
  team_id: string | null;
  key: string;
  display_name: string;
  is_system: boolean;
  created_at: Date;
}

export interface RoleBindingRow {
  id: string;
  principal_type: RoleBinding["principalType"];
  principal_id: string;
  role_definition_id: string;
  scope_type: RoleBinding["scopeType"];
  scope_id: string;
  created_at: Date;
  created_by: string | null;
}

export interface TeamInvitationRow {
  id: string;
  team_id: string;
  email: string | null;
  github_handle: string | null;
  oauth_provider: string | null;
  oauth_subject: string | null;
  role_definition_id: string;
  status: TeamInvitation["status"];
  created_by: string;
  created_at: Date;
  expires_at: Date;
  accepted_by: string | null;
  accepted_at: Date | null;
  role_binding_id: string | null;
  revoked_by: string | null;
  revoked_at: Date | null;
}

export interface TeamInvitationWithRoleRow extends TeamInvitationRow {
  role_key: string;
  role_display_name: string;
}

export interface TeamInvitationWithRole {
  invitation: TeamInvitation;
  role: Pick<RoleDefinition, "displayName" | "id" | "key">;
}

export interface AppRow {
  id: string;
  team_id: string;
  name: string;
  require_code_signing: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface DeploymentRow {
  id: string;
  app_id: string;
  team_id: string;
  name: string;
  deployment_key: string;
  created_at: Date;
  updated_at: Date;
}

export interface MetricEventRow {
  id: string;
  event_id: string;
  event_name: MetricEvent["eventName"];
  emitted_at: Date;
  team_id: string;
  app_id: string;
  deployment_id: string;
  deployment_key: string;
  binary_version: string | null;
  running_package_hash: string | null;
  target_package_hash: string | null;
  device_id: string;
  sdk_version: string | null;
  platform: string | null;
  attributes: Record<string, unknown> | null;
  created_at: Date;
}

export interface AuditEventRow {
  id: string;
  timestamp: Date;
  team_id: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  ip: string | null;
  user_agent: string | null;
  request_id: string | null;
  result: AuditEvent["result"];
}

export interface ReleaseTargetRow {
  id: string;
  release_id: string;
  binary_version: string;
  resolution_source: ReleaseTarget["resolutionSource"];
  fingerprint: string | null;
  reconcile_generation: number;
  status: ReleaseTarget["status"];
  job_id: string;
  created_at: Date;
}

export function mapUserAccountRow(row: UserAccountRow): UserAccount {
  return {
    createdAt: row.created_at,
    displayName: row.display_name,
    email: row.email,
    id: asBrand(row.id),
    oauthProvider: row.oauth_provider,
    oauthSubject: row.oauth_subject,
    status: row.status,
    updatedAt: row.updated_at,
  };
}

export function mapApiTokenRow(row: ApiTokenRow): ApiTokenMetadata {
  return {
    createdAt: row.created_at,
    displayName: row.display_name,
    expiresAt: row.expires_at,
    id: asBrand(row.id),
    lastUsedAt: row.last_used_at,
    maskedPrefix: row.masked_prefix,
    userId: asBrand(row.user_id),
  };
}

export function mapOAuthSessionRow(row: OAuthSessionRow): OAuthSession {
  return {
    createdAt: row.created_at,
    id: asBrand(row.id),
    provider: row.provider,
    revokedAt: row.revoked_at,
    subject: row.subject,
    userId: asBrand(row.user_id),
  };
}

export function mapOAuthAccessTokenRow(
  row: OAuthAccessTokenRow,
): OAuthAccessTokenMetadata {
  return {
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    id: asBrand(row.id),
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    sessionId: asBrand(row.session_id),
    userId: asBrand(row.user_id),
  };
}

export function mapRefreshTokenRow(row: RefreshTokenRow): RefreshTokenMetadata {
  return {
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    id: asBrand(row.id),
    revokedAt: row.revoked_at,
    sessionId: asBrand(row.session_id),
    userId: asBrand(row.user_id),
  };
}

export function mapTeamRow(row: TeamRow): Team {
  return {
    createdAt: row.created_at,
    id: asBrand(row.id),
    name: row.name,
    status: row.status,
    updatedAt: row.updated_at,
  };
}

export function mapRoleDefinitionRow(row: RoleDefinitionRow): RoleDefinition {
  return {
    createdAt: row.created_at,
    displayName: row.display_name,
    id: asBrand(row.id),
    isSystem: row.is_system,
    key: row.key,
    teamId: nullableBrand(row.team_id),
  };
}

export function mapRoleBindingRow(row: RoleBindingRow): RoleBinding {
  return {
    createdAt: row.created_at,
    createdBy: nullableBrand(row.created_by),
    id: asBrand(row.id),
    principalId: asBrand(row.principal_id),
    principalType: row.principal_type,
    roleDefinitionId: asBrand(row.role_definition_id),
    scopeId: row.scope_id,
    scopeType: row.scope_type,
  };
}

export function mapTeamInvitationRow(row: TeamInvitationRow): TeamInvitation {
  return {
    acceptedAt: row.accepted_at,
    acceptedBy: nullableBrand(row.accepted_by),
    createdAt: row.created_at,
    createdBy: asBrand(row.created_by),
    email: row.email,
    expiresAt: row.expires_at,
    githubHandle: row.github_handle,
    id: asBrand(row.id),
    oauthProvider: row.oauth_provider,
    oauthSubject: row.oauth_subject,
    revokedAt: row.revoked_at,
    revokedBy: nullableBrand(row.revoked_by),
    roleBindingId: nullableBrand(row.role_binding_id),
    roleDefinitionId: asBrand(row.role_definition_id),
    status: row.status,
    teamId: asBrand(row.team_id),
  };
}

export function mapTeamInvitationWithRoleRow(
  row: TeamInvitationWithRoleRow,
): TeamInvitationWithRole {
  const invitation = mapTeamInvitationRow(row);

  return {
    invitation,
    role: {
      displayName: row.role_display_name,
      id: invitation.roleDefinitionId,
      key: row.role_key,
    },
  };
}

export function mapAppRow(row: AppRow): App {
  return {
    createdAt: row.created_at,
    id: asBrand(row.id),
    name: row.name,
    requireCodeSigning: row.require_code_signing,
    teamId: asBrand(row.team_id),
    updatedAt: row.updated_at,
  };
}

export function mapReleaseRow(row: ReleaseRow): Release {
  return {
    appId: asBrand(row.app_id),
    createdAt: row.created_at,
    createdBy: nullableBrand(row.created_by),
    deploymentId: asBrand(row.deployment_id),
    failureReason: row.failure_reason,
    failureStage: row.failure_stage,
    fingerprint: row.fingerprint,
    id: asBrand(row.id),
    isMandatory: row.is_mandatory,
    processingAttemptCount: row.processing_attempt_count,
    processingFinishedAt: row.processing_finished_at,
    processingStartedAt: row.processing_started_at,
    releaseLabel: row.release_label,
    releaseNotes: row.release_notes,
    rollbackOf: nullableBrand(row.rollback_of),
    rolloutPercentage: row.rollout_percentage,
    signature: row.signature,
    signatureHashAlgorithm: row.signature_hash_algorithm,
    status: row.status,
    targetBinaryVersion: row.target_binary_version,
    targetPackageHash: row.target_package_hash,
    teamId: asBrand(row.team_id),
    updatedAt: row.updated_at,
  };
}

export function mapReleaseJobRow(row: ReleaseJobRow): ReleaseJob {
  return {
    attemptCount: row.attempt_count,
    claimGeneration: row.claim_generation,
    createdAt: row.created_at,
    deploymentId: asBrand(row.deployment_id),
    failureReason: row.failure_reason,
    failureStage: row.failure_stage,
    id: asBrand(row.id),
    lastHeartbeatAt: row.last_heartbeat_at,
    leaseExpiresAt: row.lease_expires_at,
    maxTotalAttempts: row.max_total_attempts,
    releaseId: asBrand(row.release_id),
    requestedBy: nullableBrand(row.requested_by),
    status: row.status,
    triggerType: row.trigger_type,
    updatedAt: row.updated_at,
  };
}

export function mapDeploymentRow(row: DeploymentRow): Deployment {
  return {
    appId: asBrand(row.app_id),
    createdAt: row.created_at,
    deploymentKey: row.deployment_key,
    id: asBrand(row.id),
    name: row.name,
    teamId: asBrand(row.team_id),
    updatedAt: row.updated_at,
  };
}

export function mapMetricEventRow(row: MetricEventRow): MetricEvent {
  return {
    appId: asBrand(row.app_id),
    attributes: row.attributes,
    binaryVersion: row.binary_version,
    createdAt: row.created_at,
    deploymentId: asBrand(row.deployment_id),
    deploymentKey: row.deployment_key,
    deviceId: row.device_id,
    emittedAt: row.emitted_at,
    eventId: row.event_id,
    eventName: row.event_name,
    id: row.id,
    platform: row.platform,
    runningPackageHash: row.running_package_hash,
    sdkVersion: row.sdk_version,
    targetPackageHash: row.target_package_hash,
    teamId: asBrand(row.team_id),
  };
}

export function mapAuditEventRow(row: AuditEventRow): AuditEvent {
  return {
    action: row.action,
    actorId: row.actor_id,
    actorType: row.actor_type,
    afterState: row.after_state,
    beforeState: row.before_state,
    id: row.id,
    ip: row.ip,
    requestId: row.request_id,
    resourceId: row.resource_id,
    resourceType: row.resource_type,
    result: row.result,
    teamId: asBrand(row.team_id),
    timestamp: row.timestamp,
    userAgent: row.user_agent,
  };
}

export function mapReleaseTargetRow(row: ReleaseTargetRow): ReleaseTarget {
  return {
    binaryVersion: row.binary_version,
    createdAt: row.created_at,
    fingerprint: row.fingerprint,
    id: asBrand(row.id),
    jobId: asBrand(row.job_id),
    reconcileGeneration: row.reconcile_generation,
    releaseId: asBrand(row.release_id),
    resolutionSource: row.resolution_source,
    status: row.status,
  };
}

function asBrand<T extends string>(value: string): T {
  return value as T;
}

function nullableBrand<T extends string>(value: string | null): T | null {
  return value === null ? null : (value as T);
}
