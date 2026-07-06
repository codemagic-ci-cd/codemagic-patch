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
} from "../../app/types";

// These types describe the pre-JSON response objects. Date values are serialized
// to ISO strings by JSON.stringify at the HTTP boundary.
export interface TeamWire {
  created_at: Date;
  id: Team["id"];
  name: string;
  status: Team["status"];
  updated_at: Date;
}

export interface AppWire {
  created_at: Date;
  id: App["id"];
  name: string;
  require_code_signing: boolean;
  team_id: App["teamId"];
  updated_at: Date;
}

export interface DeploymentWire {
  app_id: Deployment["appId"];
  created_at: Date;
  deployment_key: string;
  id: Deployment["id"];
  name: string;
  team_id: Deployment["teamId"];
  updated_at: Date;
}

export interface ReleaseWire {
  app_id: Release["appId"];
  created_at: Date;
  created_by: Release["createdBy"];
  deployment_id: Release["deploymentId"];
  failure_reason: Release["failureReason"];
  failure_stage: Release["failureStage"];
  fingerprint: Release["fingerprint"];
  id: Release["id"];
  is_mandatory: boolean;
  processing_attempt_count: number;
  processing_finished_at: Release["processingFinishedAt"];
  processing_started_at: Release["processingStartedAt"];
  release_label: string;
  release_notes: Release["releaseNotes"];
  rollback_of: Release["rollbackOf"];
  rollout_percentage: number;
  signature: Release["signature"];
  signature_hash_algorithm: Release["signatureHashAlgorithm"];
  status: Release["status"];
  target_binary_version: string;
  target_package_hash: Release["targetPackageHash"];
  team_id: Release["teamId"];
  updated_at: Date;
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

export interface ReleaseJobWire {
  attempt_count: number;
  claim_generation: number;
  created_at: Date;
  deployment_id: ReleaseJob["deploymentId"];
  failure_reason: ReleaseJob["failureReason"];
  failure_stage: ReleaseJob["failureStage"];
  id: ReleaseJob["id"];
  last_heartbeat_at: ReleaseJob["lastHeartbeatAt"];
  lease_expires_at: ReleaseJob["leaseExpiresAt"];
  max_total_attempts: number;
  release_id: ReleaseJob["releaseId"];
  requested_by: ReleaseJob["requestedBy"];
  status: ReleaseJob["status"];
  trigger_type: ReleaseJob["triggerType"];
  updated_at: Date;
}

/** Conflict problem extension describing the release job blocking the request. */
export interface ActiveJobWire {
  job_id: string;
  release_id: string;
  source_release_id?: string;
  status: "queued" | "running";
}

export interface ApiTokenWire {
  created_at: ApiTokenMetadata["createdAt"];
  display_name: string;
  expires_at: ApiTokenMetadata["expiresAt"];
  id: ApiTokenMetadata["id"];
  last_used_at: ApiTokenMetadata["lastUsedAt"];
  masked_prefix: string;
}

export interface UserWire {
  created_at: UserAccount["createdAt"];
  display_name: UserAccount["displayName"];
  email: string;
  id: UserAccount["id"];
  oauth_provider: UserAccount["oauthProvider"];
  oauth_subject: UserAccount["oauthSubject"];
  status: UserAccount["status"];
  updated_at: UserAccount["updatedAt"];
}

/** Subset of the user account exposed on OAuth session creation. */
export interface OAuthSessionUserWire {
  created_at: Date;
  display_name: string | null;
  email: string;
  id: string;
}

export interface OAuthSessionWire {
  access_token: string;
  access_token_expires_at: Date;
  refresh_token: string;
  refresh_token_expires_at: Date;
  user: OAuthSessionUserWire;
}

export interface OAuthRefreshWire {
  access_token: string;
  access_token_expires_at: Date;
  refresh_token: string;
  refresh_token_expires_at: Date;
}

export interface OAuthWebConfigWire {
  client_id: string;
  provider: "github";
  scopes: string;
}

export interface OAuthDeviceStartWire {
  expires_in_seconds: number;
  interval_seconds: number;
  poll_token: string;
  provider: string;
  user_code: string;
  verification_uri: string;
}

export interface OAuthDevicePollPendingWire {
  interval_seconds: number;
  outcome: "authorization_pending" | "slow_down";
}

export interface RoleWire {
  display_name: string;
  id: string;
  is_system: boolean;
  key: string;
  permissions: IamRoleRouteModel["permissions"];
}

/** Role summary embedded in role-binding and invitation responses. */
export interface RoleRefWire {
  display_name: string;
  id: string;
  key: string;
}

export interface RoleBindingWire {
  created_at: Date;
  created_by: string | null;
  id: string;
  principal_type: IamRoleBindingRouteModel["principalType"];
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
  accepted_at: Date | null;
  accepted_by: string | null;
  created_at: Date;
  created_by: string;
  email: string | null;
  expires_at: Date;
  github_handle: string | null;
  id: string;
  revoked_at: Date | null;
  revoked_by: string | null;
  role: RoleRefWire;
  role_binding_id: string | null;
  status: IamInvitationRouteModel["status"];
  team_id: string;
}

export interface ReleaseMetricsWire {
  active: number;
  downloaded: number;
  failed: number;
  installed: number;
  success: number;
}

export interface ReleaseMetricsRowWire {
  metrics: ReleaseMetricsWire;
  release_id: string;
  release_label: string;
  target_binary_version: string;
  target_package_hash: string | null;
}
