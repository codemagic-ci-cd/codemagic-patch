import type {
  App,
  ApiTokenMetadata,
  Deployment,
  Release,
  ReleaseJob,
  Team,
  UserAccount,
} from "../../domain";
import type {
  IamInvitationRouteModel,
  IamRoleBindingRouteModel,
  IamRoleRouteModel,
  OAuthWebConfig,
  OAuthSessionCreatedHandlerResult,
  ReleaseCreationWarning,
} from "../../app/types";
import type {
  ActiveJobWire,
  ApiTokenWire,
  AppWire,
  DeploymentWire,
  InvitationWire,
  OAuthDeviceStartWire,
  OAuthRefreshWire,
  OAuthSessionWire,
  OAuthWebConfigWire,
  ReleaseCreationWarningWire,
  ReleaseJobWire,
  ReleaseMetricsRowWire,
  ReleaseMetricsWire,
  ReleaseWire,
  RoleBindingWire,
  RoleRefWire,
  RoleWire,
  TeamWire,
  UserWire,
} from "./wireTypes";

export function toTeamWire(team: Team): TeamWire {
  return {
    created_at: team.createdAt,
    id: team.id,
    name: team.name,
    status: team.status,
    updated_at: team.updatedAt,
  };
}

export function toAppWire(app: App): AppWire {
  return {
    created_at: app.createdAt,
    id: app.id,
    name: app.name,
    require_code_signing: app.requireCodeSigning,
    team_id: app.teamId,
    updated_at: app.updatedAt,
  };
}

export function toDeploymentWire(deployment: Deployment): DeploymentWire {
  return {
    app_id: deployment.appId,
    created_at: deployment.createdAt,
    deployment_key: deployment.deploymentKey,
    id: deployment.id,
    name: deployment.name,
    team_id: deployment.teamId,
    updated_at: deployment.updatedAt,
  };
}

export function toReleaseWire(release: Release): ReleaseWire {
  return {
    app_id: release.appId,
    created_at: release.createdAt,
    created_by: release.createdBy,
    deployment_id: release.deploymentId,
    failure_reason: release.failureReason,
    failure_stage: release.failureStage,
    fingerprint: release.fingerprint,
    id: release.id,
    is_mandatory: release.isMandatory,
    processing_attempt_count: release.processingAttemptCount,
    processing_finished_at: release.processingFinishedAt,
    processing_started_at: release.processingStartedAt,
    release_label: release.releaseLabel,
    release_notes: release.releaseNotes,
    rollback_of: release.rollbackOf,
    rollout_percentage: release.rolloutPercentage,
    signature: release.signature,
    signature_hash_algorithm: release.signatureHashAlgorithm,
    status: release.status,
    target_binary_version: release.targetBinaryVersion,
    target_package_hash: release.targetPackageHash,
    team_id: release.teamId,
    updated_at: release.updatedAt,
  };
}

export function toReleaseCreationWarningWire(
  warning: ReleaseCreationWarning,
): ReleaseCreationWarningWire {
  if (warning.code === "fingerprint-disagreement") {
    return {
      binary_version: warning.binaryVersion,
      code: warning.code,
      detail: warning.detail,
      release_fingerprint: warning.releaseFingerprint,
      stored_fingerprint: warning.storedFingerprint,
    };
  }

  return {
    code: warning.code,
    detail: warning.detail,
  };
}

export function toReleaseJobWire(job: ReleaseJob): ReleaseJobWire {
  return {
    attempt_count: job.attemptCount,
    claim_generation: job.claimGeneration,
    created_at: job.createdAt,
    deployment_id: job.deploymentId,
    failure_reason: job.failureReason,
    failure_stage: job.failureStage,
    id: job.id,
    last_heartbeat_at: job.lastHeartbeatAt,
    lease_expires_at: job.leaseExpiresAt,
    max_total_attempts: job.maxTotalAttempts,
    release_id: job.releaseId,
    requested_by: job.requestedBy,
    status: job.status,
    trigger_type: job.triggerType,
    updated_at: job.updatedAt,
  };
}

export function toActiveJobWire(activeJob: {
  jobId: string;
  releaseId: string;
  sourceReleaseId?: string;
  status: "queued" | "running";
}): ActiveJobWire {
  return {
    job_id: activeJob.jobId,
    release_id: activeJob.releaseId,
    ...(activeJob.sourceReleaseId !== undefined
      ? { source_release_id: activeJob.sourceReleaseId }
      : {}),
    status: activeJob.status,
  };
}

export function toApiTokenWire(apiToken: ApiTokenMetadata): ApiTokenWire {
  return {
    created_at: apiToken.createdAt,
    display_name: apiToken.displayName,
    expires_at: apiToken.expiresAt,
    id: apiToken.id,
    last_used_at: apiToken.lastUsedAt,
    masked_prefix: apiToken.maskedPrefix,
  };
}

export function toUserWire(user: UserAccount): UserWire {
  return {
    created_at: user.createdAt,
    display_name: user.displayName,
    email: user.email,
    id: user.id,
    oauth_provider: user.oauthProvider,
    oauth_subject: user.oauthSubject,
    status: user.status,
    updated_at: user.updatedAt,
  };
}

export function toOAuthSessionWire(
  result: OAuthSessionCreatedHandlerResult,
): OAuthSessionWire {
  return {
    ...toOAuthRefreshWire(result),
    user: {
      created_at: result.user.createdAt,
      display_name: result.user.displayName,
      email: result.user.email,
      id: result.user.id,
    },
  };
}

export function toOAuthRefreshWire(result: {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}): OAuthRefreshWire {
  return {
    access_token: result.accessToken,
    access_token_expires_at: result.accessTokenExpiresAt,
    refresh_token: result.refreshToken,
    refresh_token_expires_at: result.refreshTokenExpiresAt,
  };
}

export function toOAuthWebConfigWire(
  config: OAuthWebConfig,
): OAuthWebConfigWire {
  return {
    client_id: config.clientId,
    provider: config.provider,
    scopes: config.scopes,
  };
}

export function toOAuthDeviceStartWire(
  result: {
    expiresInSeconds: number;
    intervalSeconds: number;
    pollToken: string;
    provider: string;
    userCode: string;
    verificationUri: string;
  },
): OAuthDeviceStartWire {
  return {
    expires_in_seconds: result.expiresInSeconds,
    interval_seconds: result.intervalSeconds,
    poll_token: result.pollToken,
    provider: result.provider,
    user_code: result.userCode,
    verification_uri: result.verificationUri,
  };
}

export function toRoleWire(role: IamRoleRouteModel): RoleWire {
  return {
    display_name: role.displayName,
    id: role.id,
    is_system: role.isSystem,
    key: role.key,
    permissions: role.permissions,
  };
}

function toRoleRefWire(role: {
  displayName: string;
  id: string;
  key: string;
}): RoleRefWire {
  return {
    display_name: role.displayName,
    id: role.id,
    key: role.key,
  };
}

export function toRoleBindingWire(
  roleBinding: IamRoleBindingRouteModel,
): RoleBindingWire {
  return {
    created_at: roleBinding.createdAt,
    created_by: roleBinding.createdBy,
    id: roleBinding.id,
    principal_type: roleBinding.principalType,
    role: toRoleRefWire(roleBinding.role),
    scope: {
      id: roleBinding.scope.id,
      type: roleBinding.scope.type,
    },
    user: {
      display_name: roleBinding.user.displayName,
      email: roleBinding.user.email,
      id: roleBinding.user.id,
    },
  };
}

export function toInvitationWire(
  invitation: IamInvitationRouteModel,
): InvitationWire {
  return {
    accepted_at: invitation.acceptedAt,
    accepted_by: invitation.acceptedBy,
    created_at: invitation.createdAt,
    created_by: invitation.createdBy,
    email: invitation.email,
    expires_at: invitation.expiresAt,
    github_handle: invitation.githubHandle,
    id: invitation.id,
    revoked_at: invitation.revokedAt,
    revoked_by: invitation.revokedBy,
    role: toRoleRefWire(invitation.role),
    role_binding_id: invitation.roleBindingId,
    status: invitation.status,
    team_id: invitation.teamId,
  };
}

// Identity copy on purpose: pins the wire field set so a counter added to the
// domain metrics shape is not exposed until it is added here deliberately.
export function toReleaseMetricsWire(metrics: {
  active: number;
  downloaded: number;
  failed: number;
  installed: number;
  success: number;
}): ReleaseMetricsWire {
  return {
    active: metrics.active,
    downloaded: metrics.downloaded,
    failed: metrics.failed,
    installed: metrics.installed,
    success: metrics.success,
  };
}

export function toReleaseMetricsRowWire(row: {
  metrics: {
    active: number;
    downloaded: number;
    failed: number;
    installed: number;
    success: number;
  };
  releaseId: string;
  releaseLabel: string;
  targetBinaryVersion: string;
  targetPackageHash: string | null;
}): ReleaseMetricsRowWire {
  return {
    metrics: toReleaseMetricsWire(row.metrics),
    release_id: row.releaseId,
    release_label: row.releaseLabel,
    target_binary_version: row.targetBinaryVersion,
    target_package_hash: row.targetPackageHash,
  };
}
