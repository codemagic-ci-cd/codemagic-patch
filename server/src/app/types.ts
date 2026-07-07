import type { FastifyBaseLogger } from "fastify";

import type { StorageAdapter } from "../adapters";
import type { AuthorizationService } from "./authorizationService";
import type {
  ApiTokenMetadata,
  App,
  ControlPlaneAction,
  Deployment,
  MetricEvent,
  Release,
  ReleaseJob,
  ReleaseMetrics,
  Team,
  UserAccount,
} from "../domain";
import type { ControlPlaneAuthHandler } from "./controlPlaneAuth";

export type ServerMode = "all" | "api" | "worker";

export interface WorkerReconcilePlanSummary {
  bundleInternalUpload: boolean;
  bundlePublicCopyCount: number;
  manifestCount: number;
  needsDeploymentMetaUpdate: boolean;
  patchCount: number;
}

export type WorkerReconcileHandlerResult =
  | { outcome: "succeeded"; planSummary: WorkerReconcilePlanSummary }
  | { outcome: "noop"; reason: string }
  | {
      outcome: "failed";
      reason: string;
      retryAttemptCount?: number;
      retryable: boolean;
      stage: string;
    };

export interface WorkerReconcileRouteHandler {
  (jobId: string): Promise<WorkerReconcileHandlerResult>;
}

export interface TeamCreateHandlerInput {
  name: string;
  userId?: string;
}

export type TeamCreateHandlerResult =
  | {
      outcome: "created";
      team: Team;
    }
  | {
      outcome: "conflict";
      reason: "team_name_exists";
    }
  | {
      // Never produced by the built-in handler; reserved for embedders that
      // wrap the handler with their own authorization policy.
      outcome: "forbidden";
    }
  | {
      outcome: "not_found";
      reason: "user_not_found";
    }
  | {
      outcome: "account_disabled";
      reason: "user_disabled";
    };

export interface TeamCreateRouteHandler {
  (input: TeamCreateHandlerInput): Promise<TeamCreateHandlerResult>;
}

export interface TeamListRouteHandler {
  (): Promise<{ teams: Team[] }>;
}

export type TeamReadHandlerResult =
  | {
      outcome: "found";
      team: Team;
    }
  | {
      outcome: "not_found";
      reason: "team_not_found";
    };

export interface TeamReadRouteHandler {
  (teamId: string): Promise<TeamReadHandlerResult>;
}

export interface AppCreateHandlerInput {
  name: string;
  requireCodeSigning: boolean;
  teamId: string;
}

export type AppCreateHandlerResult =
  | {
      app: App;
      deployments: Deployment[];
      outcome: "created";
    }
  | {
      outcome: "not_found";
      reason: "team_not_found";
    }
  | {
      outcome: "conflict";
      reason: "app_name_exists";
    }
  | {
      outcome: "failed";
      reason: "deployment_key_generation_exhausted";
    };

export interface AppCreateRouteHandler {
  (input: AppCreateHandlerInput): Promise<AppCreateHandlerResult>;
}

export interface AppUpdateHandlerInput {
  appId: string;
  name?: string;
  requireCodeSigning?: boolean;
}

export type AppUpdateHandlerResult =
  | {
      app: App;
      before: App;
      outcome: "updated";
    }
  | {
      outcome: "not_found";
      reason: "app_not_found";
    }
  | {
      outcome: "conflict";
      reason: "app_name_exists";
    };

export interface AppUpdateRouteHandler {
  (input: AppUpdateHandlerInput): Promise<AppUpdateHandlerResult>;
}

export interface AppTransferHandlerInput {
  appId: string;
  destinationTeamId: string;
}

export type AppTransferHandlerResult =
  | {
      app: App;
      before: App;
      deployments: Deployment[];
      outcome: "transferred";
    }
  | {
      outcome: "not_found";
      reason: "app_not_found" | "destination_team_not_found";
    }
  | {
      activeJob: {
        jobId: string;
        releaseId: string;
        status: "queued" | "running";
      };
      outcome: "conflict";
      reason: "active_release_job_exists";
    }
  | {
      outcome: "conflict";
      reason: "app_name_exists";
    }
  | {
      outcome: "invalid";
      reason: "same_team";
    };

export interface AppTransferRouteHandler {
  (input: AppTransferHandlerInput): Promise<AppTransferHandlerResult>;
}

export type AppDeleteHandlerResult =
  | {
      app: App;
      deletedDeploymentCount: number;
      deletedReleaseCount: number;
      outcome: "deleted";
    }
  | {
      activeJob: {
        jobId: string;
        releaseId: string;
        status: "queued" | "running";
      };
      outcome: "conflict";
      reason: "active_release_job_exists";
    }
  | {
      activeJob: {
        jobId: string;
        releaseId: string;
        sourceReleaseId: string;
        status: "queued" | "running";
      };
      outcome: "conflict";
      reason: "source_release_active_job_exists";
    }
  | {
      outcome: "not_found";
      reason: "app_not_found";
    };

export interface AppDeleteRouteHandler {
  (appId: string): Promise<AppDeleteHandlerResult>;
}

export type TeamAppsListHandlerResult =
  | {
      apps: App[];
      outcome: "found";
    }
  | {
      outcome: "not_found";
      reason: "team_not_found";
    };

export interface TeamAppsListRouteHandler {
  (teamId: string): Promise<TeamAppsListHandlerResult>;
}

export type AppReadHandlerResult =
  | {
      app: App;
      outcome: "found";
    }
  | {
      outcome: "not_found";
      reason: "app_not_found";
    };

export interface AppReadRouteHandler {
  (appId: string): Promise<AppReadHandlerResult>;
}

export type AppDeploymentsListHandlerResult =
  | {
      deployments: Deployment[];
      outcome: "found";
    }
  | {
      outcome: "not_found";
      reason: "app_not_found";
    };

export interface AppDeploymentsListRouteHandler {
  (appId: string): Promise<AppDeploymentsListHandlerResult>;
}

export interface DeploymentCreateHandlerInput {
  appId: string;
  name: string;
}

export type DeploymentCreateHandlerResult =
  | {
      deployment: Deployment;
      outcome: "created";
    }
  | {
      outcome: "not_found";
      reason: "app_not_found";
    }
  | {
      outcome: "conflict";
      reason: "deployment_name_exists";
    }
  | {
      outcome: "failed";
      reason: "deployment_key_generation_exhausted";
    };

export interface DeploymentCreateRouteHandler {
  (input: DeploymentCreateHandlerInput): Promise<DeploymentCreateHandlerResult>;
}

export interface DeploymentUpdateHandlerInput {
  deploymentId: string;
  name: string;
}

export type DeploymentUpdateHandlerResult =
  | {
      before: Deployment;
      deployment: Deployment;
      outcome: "updated";
    }
  | {
      outcome: "not_found";
      reason: "deployment_not_found";
    }
  | {
      outcome: "conflict";
      reason: "deployment_name_exists";
    };

export interface DeploymentUpdateRouteHandler {
  (
    input: DeploymentUpdateHandlerInput,
  ): Promise<DeploymentUpdateHandlerResult>;
}

export type DeploymentDeleteHandlerResult =
  | {
      deletedReleaseCount: number;
      deployment: Deployment;
      outcome: "deleted";
    }
  | {
      activeJob: {
        jobId: string;
        releaseId: string;
        status: "queued" | "running";
      };
      outcome: "conflict";
      reason: "active_release_job_exists";
    }
  | {
      activeJob: {
        jobId: string;
        releaseId: string;
        sourceReleaseId: string;
        status: "queued" | "running";
      };
      outcome: "conflict";
      reason: "source_release_active_job_exists";
    }
  | {
      outcome: "not_found";
      reason: "deployment_not_found";
    };

export interface DeploymentDeleteRouteHandler {
  (deploymentId: string): Promise<DeploymentDeleteHandlerResult>;
}

export type DeploymentClearHandlerResult =
  | {
      deletedReleaseCount: number;
      deployment: Deployment;
      outcome: "cleared";
      staticState?: {
        binaryVersions: string[];
        deploymentKey: string;
        packageHashes: string[];
      };
    }
  | {
      activeJob: {
        jobId: string;
        releaseId: string;
        status: "queued" | "running";
      };
      outcome: "conflict";
      reason: "active_release_job_exists";
    }
  | {
      outcome: "not_found";
      reason: "deployment_not_found";
    };

export interface DeploymentClearRouteHandler {
  (deploymentId: string): Promise<DeploymentClearHandlerResult>;
}

export type UserProfileHandlerResult =
  | {
      outcome: "found";
      user: UserAccount;
    }
  | {
      outcome: "not_found";
      reason: "user_not_found";
    };

export interface UserProfileRouteHandler {
  (userId: string): Promise<UserProfileHandlerResult>;
}

export interface ApiTokenCreateHandlerInput {
  displayName: string;
  expiresInDays?: number;
  userId: string;
}

export interface ApiTokenCreateHandlerResult {
  apiToken: ApiTokenMetadata;
  outcome: "created";
  plaintextToken: string;
}

export interface ApiTokenCreateRouteHandler {
  (input: ApiTokenCreateHandlerInput): Promise<ApiTokenCreateHandlerResult>;
}

export interface ApiTokenListRouteHandler {
  (userId: string): Promise<{ apiTokens: ApiTokenMetadata[] }>;
}

export interface ApiTokenDeleteRouteHandler {
  (
    userId: string,
    tokenId: string,
  ): Promise<
    | {
        outcome: "deleted";
      }
    | {
        outcome: "not_found";
      }
  >;
}

export interface PublicAuthAuditContext {
  ip: string | null;
  requestId: string | null;
  userAgent: string | null;
}

export interface OAuthWebConfig {
  /**
   * Base URL the dashboard prepends to the authorize path. Absent = GitHub
   * mode (github.com); "" = same-origin (the SPA's own consent route).
   */
  authorizeBaseUrl?: string;
  clientId: string;
  /** Absent = normal GitHub mode; "local-dev" switches the dashboard login. */
  mode?: string;
  provider: string;
  scopes: string;
}

export interface OAuthCallbackHandlerInput {
  code: string;
  codeVerifier: string;
  auditContext?: PublicAuthAuditContext;
  provider: string;
  redirectUri: string;
}

export interface OAuthSessionCreatedHandlerResult {
  accessToken: string;
  accessTokenExpiresAt: Date;
  outcome: "created";
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  user: {
    createdAt: Date;
    displayName: string | null;
    email: string;
    id: string;
  };
}

export type OAuthCallbackHandlerResult =
  | OAuthSessionCreatedHandlerResult
  | {
      outcome: "conflict";
      reason: "oauth_identity_conflict";
    }
  | {
      outcome: "account_disabled";
      reason: "user_disabled";
    }
  | {
      outcome: "registration_closed";
      reason: "registration_invite_only";
    }
  | {
      outcome: "auth_failed";
      reason:
        | "invalid_grant"
        | "provider_error"
        | "unknown_provider"
        | "unverified_email";
    };

export interface OAuthCallbackRouteHandler {
  (input: OAuthCallbackHandlerInput): Promise<OAuthCallbackHandlerResult>;
}

export interface OAuthDeviceStartHandlerInput {
  provider: string;
}

export type OAuthDeviceStartHandlerResult =
  | {
      expiresInSeconds: number;
      intervalSeconds: number;
      outcome: "started";
      pollToken: string;
      provider: string;
      userCode: string;
      verificationUri: string;
    }
  | {
      outcome: "auth_failed";
      reason: "provider_error" | "unknown_provider";
    };

export interface OAuthDeviceStartRouteHandler {
  (
    input: OAuthDeviceStartHandlerInput,
  ): Promise<OAuthDeviceStartHandlerResult>;
}

export interface OAuthDevicePollHandlerInput {
  auditContext?: PublicAuthAuditContext;
  pollToken: string;
  provider: string;
}

export type OAuthDevicePollHandlerResult =
  | OAuthSessionCreatedHandlerResult
  | {
      intervalSeconds: number;
      outcome: "authorization_pending";
    }
  | {
      intervalSeconds: number;
      outcome: "slow_down";
    }
  | {
      outcome: "conflict";
      reason: "oauth_identity_conflict";
    }
  | {
      outcome: "account_disabled";
      reason: "user_disabled";
    }
  | {
      outcome: "registration_closed";
      reason: "registration_invite_only";
    }
  | {
      outcome: "auth_failed";
      reason:
        | "access_denied"
        | "email_scope_required"
        | "expired_token"
        | "invalid_poll_token"
        | "provider_error"
        | "unknown_provider"
        | "verified_email_required";
    };

export interface OAuthDevicePollRouteHandler {
  (
    input: OAuthDevicePollHandlerInput,
  ): Promise<OAuthDevicePollHandlerResult>;
}

export interface OAuthRefreshHandlerInput {
  refreshToken: string;
}

export type OAuthRefreshHandlerResult =
  | {
      accessToken: string;
      accessTokenExpiresAt: Date;
      outcome: "rotated";
      refreshToken: string;
      refreshTokenExpiresAt: Date;
    }
  | {
      outcome: "authentication_failed";
    }
  | {
      outcome: "account_disabled";
      reason: "user_disabled";
    };

export interface OAuthRefreshRouteHandler {
  (input: OAuthRefreshHandlerInput): Promise<OAuthRefreshHandlerResult>;
}

export interface OAuthLogoutHandlerInput {
  refreshToken: string;
}

export interface OAuthLogoutHandlerResult {
  outcome: "logged_out";
}

export interface OAuthLogoutRouteHandler {
  (input: OAuthLogoutHandlerInput): Promise<OAuthLogoutHandlerResult>;
}

export interface IamRoleRouteModel {
  id: string;
  key: string;
  displayName: string;
  isSystem: boolean;
  permissions: ControlPlaneAction[];
}

export interface IamRoleBindingRouteModel {
  id: string;
  principalType: "user";
  user: {
    id: string;
    email: string;
    displayName: string | null;
  };
  role: {
    id: string;
    key: string;
    displayName: string;
  };
  scope: {
    type: "team";
    id: string;
  };
  createdAt: Date;
  createdBy: string | null;
}

export interface IamInvitationRouteModel {
  id: string;
  teamId: string;
  // Exactly one is set: email for email invites, githubHandle for handle invites.
  email: string | null;
  githubHandle: string | null;
  role: {
    id: string;
    key: string;
    displayName: string;
  };
  status: "pending" | "accepted" | "revoked" | "expired";
  createdAt: Date;
  expiresAt: Date;
  createdBy: string;
  acceptedAt: Date | null;
  acceptedBy: string | null;
  roleBindingId: string | null;
  revokedAt: Date | null;
  revokedBy: string | null;
}

export interface IamRoleListRouteHandler {
  (): Promise<{
    roles: IamRoleRouteModel[];
  }>;
}

export type IamRoleBindingListHandlerResult =
  | {
      outcome: "found";
      roleBindings: IamRoleBindingRouteModel[];
    }
  | {
      outcome: "not_found";
      reason: "team_not_found";
    };

export interface IamRoleBindingListRouteHandler {
  (teamId: string): Promise<IamRoleBindingListHandlerResult>;
}

export interface IamRoleBindingCreateHandlerInput {
  createdBy: string;
  roleId: string;
  teamId: string;
  userSelector:
    | {
        type: "userId";
        userId: string;
      }
    | {
        type: "email";
        email: string;
      };
}

export type IamRoleBindingCreateHandlerResult =
  | {
      membershipCreated: boolean;
      outcome: "created" | "already_exists";
      roleBinding: IamRoleBindingRouteModel;
    }
  | {
      outcome: "not_found";
      reason: "role_not_found" | "team_not_found" | "user_not_found";
    }
  | {
      outcome: "account_disabled";
      reason: "team_disabled" | "user_disabled";
    }
  | {
      outcome: "role_not_supported";
    };

export interface IamRoleBindingCreateRouteHandler {
  (
    input: IamRoleBindingCreateHandlerInput,
  ): Promise<IamRoleBindingCreateHandlerResult>;
}

export type IamRoleBindingReadHandlerResult =
  | {
      outcome: "found";
      roleBinding: IamRoleBindingRouteModel;
    }
  | {
      outcome: "not_found";
      reason: "role_binding_not_found";
    };

export interface IamRoleBindingReadRouteHandler {
  (bindingId: string): Promise<IamRoleBindingReadHandlerResult>;
}

export type IamRoleBindingDeleteHandlerResult =
  | {
      membershipRemoved: boolean;
      outcome: "deleted";
      roleBinding: IamRoleBindingRouteModel;
    }
  | {
      outcome: "not_found";
      reason: "role_binding_not_found";
    }
  | {
      outcome: "last_owner";
    };

export interface IamRoleBindingDeleteRouteHandler {
  (bindingId: string): Promise<IamRoleBindingDeleteHandlerResult>;
}

export interface IamInvitationCreateHandlerInput {
  createdBy: string;
  expiresInDays: number | null;
  roleId: string;
  target:
    | {
        type: "email";
        email: string;
      }
    | {
        type: "github_handle";
        githubHandle: string;
      };
  teamId: string;
}

export type IamInvitationCreateHandlerResult =
  | {
      created: boolean;
      outcome: "pending";
      invitation: IamInvitationRouteModel;
    }
  | {
      // The GitHub handle does not resolve to an account.
      outcome: "handle_not_found";
    }
  | {
      // GitHub handle lookup is unavailable (not configured or upstream error).
      outcome: "handle_lookup_failed";
    }
  | {
      outcome: "accepted_existing_user";
      invitation: IamInvitationRouteModel;
      membershipCreated: boolean;
      roleBinding: IamRoleBindingRouteModel;
      roleBindingCreated: boolean;
    }
  | {
      outcome: "already_granted";
      invitation: null;
      roleBinding: IamRoleBindingRouteModel;
    }
  | {
      outcome: "conflict";
      reason: "pending_invitation_role_mismatch";
      invitation: IamInvitationRouteModel;
    }
  | {
      outcome: "not_found";
      reason: "role_not_found" | "team_not_found";
    }
  | {
      outcome: "account_disabled";
      reason: "team_disabled" | "user_disabled";
    }
  | {
      outcome: "role_not_supported";
    };

export interface IamInvitationCreateRouteHandler {
  (
    input: IamInvitationCreateHandlerInput,
  ): Promise<IamInvitationCreateHandlerResult>;
}

export interface IamUserProvisionHandlerInput {
  createdBy: string;
  displayName: string | null;
  email: string;
  expiresInDays?: number;
  roleId: string;
  teamId: string;
  tokenDisplayName: string;
}

export type IamUserProvisionHandlerResult =
  | {
      outcome: "provisioned";
      apiToken: ApiTokenMetadata;
      membershipCreated: boolean;
      plaintextToken: string;
      roleBinding: IamRoleBindingRouteModel;
      roleBindingCreated: boolean;
      user: {
        created: boolean;
        email: string;
        id: string;
      };
    }
  | {
      outcome: "user_exists";
    }
  | {
      outcome: "not_found";
      reason: "role_not_found" | "team_not_found";
    }
  | {
      outcome: "account_disabled";
      reason: "team_disabled" | "user_disabled";
    }
  | {
      outcome: "role_not_supported";
    };

export interface IamUserProvisionRouteHandler {
  (
    input: IamUserProvisionHandlerInput,
  ): Promise<IamUserProvisionHandlerResult>;
}

export type IamInvitationStatusFilter =
  | "pending"
  | "accepted"
  | "revoked"
  | "expired"
  | "all";

export type IamInvitationListHandlerResult =
  | {
      outcome: "found";
      invitations: IamInvitationRouteModel[];
    }
  | {
      outcome: "not_found";
      reason: "team_not_found";
    };

export interface IamInvitationListRouteHandler {
  (
    teamId: string,
    status: IamInvitationStatusFilter,
  ): Promise<IamInvitationListHandlerResult>;
}

export type IamInvitationReadHandlerResult =
  | {
      outcome: "found";
      invitation: IamInvitationRouteModel;
    }
  | {
      outcome: "not_found";
      reason: "invitation_not_found";
    };

export interface IamInvitationReadRouteHandler {
  (invitationId: string): Promise<IamInvitationReadHandlerResult>;
}

export type IamInvitationRevokeHandlerResult =
  | {
      outcome: "revoked";
      invitation: IamInvitationRouteModel;
    }
  | {
      outcome: "conflict";
      reason: "invitation_not_pending";
      invitation: IamInvitationRouteModel;
    }
  | {
      outcome: "not_found";
      reason: "invitation_not_found";
    };

export interface IamInvitationRevokeRouteHandler {
  (invitationId: string, revokedBy: string): Promise<IamInvitationRevokeHandlerResult>;
}

export interface ReleaseCreationHandlerInput {
  bundleStorageKey: string;
  createdBy: string | null;
  deploymentId: string;
  disabled: boolean;
  fingerprint: string | null;
  isMandatory: boolean;
  jobId: string;
  noDuplicateReleaseError: boolean;
  releaseId: string;
  releaseNotes: string | null;
  rolloutPercentage: number;
  sourceMapStorageKey: string | null;
  signature: string | null;
  signatureHashAlgorithm: string | null;
  targetBinaryVersion: string;
  targetPackageHash: string | null;
}

export type ReleaseCreationWarning =
  | {
      code: "duplicate-release";
      detail: string;
    }
  | {
      code: "fingerprint-disagreement";
      detail: string;
      binaryVersion: string;
      storedFingerprint: string;
      releaseFingerprint: string;
    };

export type ReleaseCreationHandlerResult =
  | {
      job: ReleaseJob;
      outcome: "created";
      release: Release;
      warnings?: ReleaseCreationWarning[];
    }
  | {
      activeJob: {
        jobId: string;
        releaseId: string;
        status: "queued" | "running";
      };
      outcome: "conflict";
      reason: "active_release_job_exists";
    }
  | {
      outcome: "conflict";
      reason: "active_rollout_exists";
    }
  | {
      latestRelease: {
        releaseId: string;
        releaseLabel: string;
        targetPackageHash: string;
      };
      outcome: "conflict";
      reason: "duplicate_release";
    }
  | {
      outcome: "invalid";
      reason: "signature_required";
    }
  | {
      outcome: "not_found";
      reason: "deployment_not_found";
    };

export interface ReleaseCreationPreflightHandlerInput {
  deploymentId: string;
  signature: string | null;
}

export type ReleaseCreationPreflightHandlerResult =
  | {
      outcome: "accepted";
    }
  | Exclude<ReleaseCreationHandlerResult, { outcome: "created" }>;

export interface ReleaseCreationRouteHandler {
  (
    input: ReleaseCreationHandlerInput,
  ): Promise<ReleaseCreationHandlerResult>;
}

export interface ReleaseCreationPreflightRouteHandler {
  (
    input: ReleaseCreationPreflightHandlerInput,
  ): Promise<ReleaseCreationPreflightHandlerResult>;
}

export type ReleaseReadHandlerResult =
  | {
      job: ReleaseJob | null;
      outcome: "found";
      release: Release;
    }
  | {
      outcome: "not_found";
      reason: "release_not_found";
    };

export interface ReleaseReadRouteHandler {
  (releaseId: string): Promise<ReleaseReadHandlerResult>;
}

export interface ReleaseListHandlerInput {
  deploymentId: string;
  includeMetrics: boolean;
  limit: number;
  offset: number;
}

export type ReleaseListHandlerResult =
  | {
      outcome: "found";
      releases: Array<{
        release: Release;
        job: ReleaseJob | null;
        metrics?: ReleaseMetrics;
      }>;
      pagination: {
        limit: number;
        offset: number;
        total: number;
      };
    }
  | {
      outcome: "not_found";
      reason: "deployment_not_found";
    };

export interface ReleaseListRouteHandler {
  (input: ReleaseListHandlerInput): Promise<ReleaseListHandlerResult>;
}

export interface DeploymentMetricsHandlerInput {
  deploymentId: string;
  limit: number;
  offset: number;
}

export type DeploymentMetricsHandlerResult =
  | {
      outcome: "found";
      releases: Array<{
        releaseId: string;
        releaseLabel: string;
        targetBinaryVersion: string;
        targetPackageHash: string | null;
        metrics: ReleaseMetrics;
      }>;
      pagination: {
        limit: number;
        offset: number;
        total: number;
      };
    }
  | {
      outcome: "not_found";
      reason: "deployment_not_found";
    };

export interface DeploymentMetricsRouteHandler {
  (
    input: DeploymentMetricsHandlerInput,
  ): Promise<DeploymentMetricsHandlerResult>;
}

export type ReleaseMetricsReadHandlerResult =
  | {
      outcome: "found";
      release: {
        releaseId: string;
        releaseLabel: string;
        targetBinaryVersion: string;
        targetPackageHash: string | null;
        metrics: ReleaseMetrics;
      };
    }
  | {
      outcome: "not_found";
      reason: "release_not_found";
    };

export interface ReleaseMetricsReadRouteHandler {
  (releaseId: string): Promise<ReleaseMetricsReadHandlerResult>;
}

export interface ReleasePatchHandlerInput {
  createdBy: string | null;
  isMandatory?: boolean;
  jobId: string;
  releaseId: string;
  releaseNotes?: string | null;
  rolloutPercentage?: number;
  status?: "disabled" | "published";
  targetBinaryVersion?: string;
}

export type ReleasePatchHandlerResult =
  | {
      job: ReleaseJob;
      outcome: "updated";
      release: Release;
      warnings?: ReleaseCreationWarning[];
    }
  | {
      activeJob: {
        jobId: string;
        releaseId: string;
        status: "queued" | "running";
      };
      outcome: "conflict";
      reason: "active_release_job_exists";
    }
  | {
      outcome: "invalid";
      reason:
        | "release_not_patchable"
        | "rollout_percentage_decrease"
        | "signature_required"
        | "status_transition_not_allowed";
    }
  | {
      outcome: "not_found";
      reason: "release_not_found";
    }
  | {
      outcome: "not_modified";
    };

export interface ReleasePatchRouteHandler {
  (
    input: ReleasePatchHandlerInput,
  ): Promise<ReleasePatchHandlerResult>;
}

export interface ReleasePromoteHandlerInput {
  createdBy: string | null;
  destinationDeploymentId: string;
  disabled: boolean;
  isMandatory?: boolean;
  jobId: string;
  noDuplicateReleaseError: boolean;
  releaseId: string;
  releaseNotes?: string | null;
  rolloutPercentage: number;
  sourceReleaseId: string;
  targetBinaryVersion?: string;
}

export type ReleaseLifecycleCreateHandlerResult =
  | {
      job: ReleaseJob;
      outcome: "created";
      release: Release;
      warnings?: ReleaseCreationWarning[];
    }
  | {
      activeJob: {
        jobId: string;
        releaseId: string;
        status: "queued" | "running";
      };
      outcome: "conflict";
      reason: "active_release_job_exists";
    }
  | {
      outcome: "conflict";
      reason: "active_rollout_exists";
    }
  | {
      latestRelease: {
        releaseId: string;
        releaseLabel: string;
        targetPackageHash: string;
      };
      outcome: "conflict";
      reason: "duplicate_release";
    }
  | {
      outcome: "conflict";
      reason: "rollback_no_op";
    }
  | {
      outcome: "invalid";
      reason: "release_not_promotable" | "signature_required";
    }
  | {
      outcome: "not_found";
      reason:
        | "deployment_not_found"
        | "release_not_found"
        | "rollback_target_not_found";
    };

export interface ReleasePromoteRouteHandler {
  (
    input: ReleasePromoteHandlerInput,
  ): Promise<ReleaseLifecycleCreateHandlerResult>;
}

export interface DeploymentRollbackHandlerInput {
  createdBy: string | null;
  deploymentId: string;
  jobId: string;
  releaseId: string;
  targetReleaseLabel: string | null;
}

export interface DeploymentRollbackRouteHandler {
  (
    input: DeploymentRollbackHandlerInput,
  ): Promise<ReleaseLifecycleCreateHandlerResult>;
}

export interface MetricEventIngestHandlerInput {
  attributes: Record<string, unknown> | null;
  binaryVersion: string | null;
  deploymentKey: string;
  deviceId: string;
  emittedAt: Date;
  eventId: string;
  eventName: "Downloaded" | "Installed" | "Success" | "Failed" | "Active";
  id: string;
  platform: string | null;
  runningPackageHash: string | null;
  sdkVersion: string | null;
  targetPackageHash: string | null;
}

export type MetricEventIngestHandlerResult =
  | {
      event: MetricEvent;
      outcome: "created" | "duplicate";
    }
  | {
      outcome: "not_found";
      reason: "deployment_not_found";
    };

export interface MetricEventIngestRouteHandler {
  (
    input: MetricEventIngestHandlerInput,
  ): Promise<MetricEventIngestHandlerResult>;
}

export interface IdempotencyStartHandlerInput {
  bodyHash: string;
  key: string;
  method: string;
  path: string;
}

export type IdempotencyStartHandlerResult =
  | {
      outcome: "started";
    }
  | {
      body: unknown;
      outcome: "replay";
      status: number;
    }
  | {
      outcome: "in_progress";
    }
  | {
      outcome: "mismatch";
    };

export interface IdempotencyCompleteHandlerInput {
  body: unknown;
  key: string;
  status: number;
}

export interface IdempotencyHandler {
  complete(input: IdempotencyCompleteHandlerInput): Promise<void>;
  start(
    input: IdempotencyStartHandlerInput,
  ): Promise<IdempotencyStartHandlerResult>;
}

export interface AuditEventWriteHandlerInput {
  action: string;
  actorId: string | null;
  actorType: string;
  afterState: Record<string, unknown> | null;
  beforeState: Record<string, unknown> | null;
  ip: string | null;
  requestId: string | null;
  resourceId: string;
  resourceType: string;
  result: "success" | "failure";
  teamId: string;
  userAgent: string | null;
}

export interface AuditEventWriteRouteHandler {
  (input: AuditEventWriteHandlerInput): Promise<void>;
}

export interface ReadinessCheckResult {
  checks: {
    db: "ok" | "error";
  };
  ok: boolean;
}

export interface ReadinessCheckRouteHandler {
  (): Promise<ReadinessCheckResult>;
}

export interface BuildAppOptions {
  apiTokenCreateHandler?: ApiTokenCreateRouteHandler;
  apiTokenDeleteHandler?: ApiTokenDeleteRouteHandler;
  apiTokenListHandler?: ApiTokenListRouteHandler;
  appCreateHandler?: AppCreateRouteHandler;
  appDeleteHandler?: AppDeleteRouteHandler;
  appUpdateHandler?: AppUpdateRouteHandler;
  appTransferHandler?: AppTransferRouteHandler;
  deploymentClearHandler?: DeploymentClearRouteHandler;
  deploymentCreateHandler?: DeploymentCreateRouteHandler;
  deploymentDeleteHandler?: DeploymentDeleteRouteHandler;
  deploymentMetricsHandler?: DeploymentMetricsRouteHandler;
  deploymentRollbackHandler?: DeploymentRollbackRouteHandler;
  deploymentUpdateHandler?: DeploymentUpdateRouteHandler;
  iamInvitationCreateHandler?: IamInvitationCreateRouteHandler;
  iamInvitationListHandler?: IamInvitationListRouteHandler;
  iamInvitationReadHandler?: IamInvitationReadRouteHandler;
  iamInvitationRevokeHandler?: IamInvitationRevokeRouteHandler;
  iamRoleBindingCreateHandler?: IamRoleBindingCreateRouteHandler;
  iamRoleBindingDeleteHandler?: IamRoleBindingDeleteRouteHandler;
  iamRoleBindingListHandler?: IamRoleBindingListRouteHandler;
  iamRoleBindingReadHandler?: IamRoleBindingReadRouteHandler;
  iamRoleListHandler?: IamRoleListRouteHandler;
  iamUserProvisionHandler?: IamUserProvisionRouteHandler;
  appDeploymentsListHandler?: AppDeploymentsListRouteHandler;
  appReadHandler?: AppReadRouteHandler;
  auditEventWriteHandler?: AuditEventWriteRouteHandler;
  authorizationService?: AuthorizationService;
  controlPlaneAuthHandler?: ControlPlaneAuthHandler;
  idempotencyHandler?: IdempotencyHandler;
  loggerInstance?: FastifyBaseLogger;
  maxUploadSizeBytes?: number;
  metricEventIngestHandler?: MetricEventIngestRouteHandler;
  mode?: ServerMode;
  oauthCallbackHandler?: OAuthCallbackRouteHandler;
  oauthDevicePollHandler?: OAuthDevicePollRouteHandler;
  oauthDeviceStartHandler?: OAuthDeviceStartRouteHandler;
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
  teamAppsListHandler?: TeamAppsListRouteHandler;
  teamCreateHandler?: TeamCreateRouteHandler;
  teamListHandler?: TeamListRouteHandler;
  teamReadHandler?: TeamReadRouteHandler;
  userProfileHandler?: UserProfileRouteHandler;
  workerReconcileHandler?: WorkerReconcileRouteHandler;
  workerSharedSecret?: string;
}
