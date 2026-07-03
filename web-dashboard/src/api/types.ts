// Dashboard-facing API DTOs. Most request body types already match the server
// wire shape; OAuth and IAM keep the UI-friendly camelCase input shape and are
// converted explicitly in api/wire.ts. Response types below are post-mapping
// shapes consumed by hooks/pages; server snake_case response DTOs live in
// api/wire.ts.
// Problem details ported from server/src/app/problemDetails.ts.

import type { ApiTokenMetadata } from "../model/apiToken";
import type { App } from "../model/app";
import type { Deployment } from "../model/deployment";
import type { RoleBinding, RoleDefinition, TeamInvitation } from "../model/iam";
import type { ReleaseMetrics } from "../model/metrics";
import type { Release, ReleaseJob } from "../model/release";
import type { Team } from "../model/team";
import type { User } from "../model/user";

// ---------------------------------------------------------------------------
// Request bodies (wire casing as the server parses them)
// ---------------------------------------------------------------------------

/** `POST /v1/teams` */
export interface TeamCreateBody {
  name: string;
}

/** `POST /v1/apps` */
export interface AppCreateBody {
  name: string;
  require_code_signing?: boolean;
  team_id: string;
}

/** `PATCH /v1/apps/:appId` — at least one field is required. */
export interface AppUpdateBody {
  name?: string;
  require_code_signing?: boolean;
}

/** `POST /v1/apps/:appId/transfer` — destination team; Idempotency-Key header is required. */
export interface AppTransferBody {
  team_id: string;
}

/** `POST /v1/apps/:appId/deployments` */
export interface DeploymentCreateBody {
  name: string;
}

/** `PATCH /v1/deployments/:deploymentId` */
export interface DeploymentUpdateBody {
  name: string;
}

/**
 * `PATCH /v1/releases/:releaseId` — `status` is mutually exclusive with the
 * metadata fields (combining them yields 400 `status-transition-conflict`).
 * `rollout_percentage` may only increase (1–100).
 */
export interface ReleasePatchBody {
  is_mandatory?: boolean;
  release_notes?: string | null;
  rollout_percentage?: number;
  status?: "disabled" | "published";
  target_binary_version?: string;
}

/** `POST /v1/releases/:releaseId/promote` */
export interface ReleasePromoteBody {
  destination_deployment_id: string;
  disabled?: boolean;
  is_mandatory?: boolean;
  /** Resubmit with `true` to bypass a 409 `duplicate-release`. */
  no_duplicate_release_error?: boolean;
  release_notes?: string | null;
  rollout_percentage?: number;
  target_binary_version?: string;
}

/** `POST /v1/deployments/:deploymentId/rollback` — omit the label to target the previous release. */
export interface DeploymentRollbackBody {
  target_release_label?: string;
}

/** `PUT /v1/teams/:teamId/integrations/github` */
export interface TeamGitHubIntegrationUpsertBody {
  token: string;
}

/** `PUT /v1/deployments/:deploymentId/github-actions` */
export interface DeploymentGitHubActionsUpsertBody {
  default_ref?: string;
  enabled?: boolean;
  owner: string;
  repo: string;
  workflow_file: string;
}

/** `POST /v1/deployments/:deploymentId/github-actions/dispatch` */
export interface DeploymentGitHubActionsDispatchBody {
  mandatory?: boolean;
  platform: "android" | "ios";
  release_notes?: string;
  rollout_percentage?: number;
  target_binary_version?: string;
}

export type GitHubIntegrationStatus =
  | { configured: false }
  | { configured: true; tokenLast4: string };

export interface DeploymentGitHubActionsLink {
  defaultRef: string;
  deploymentId: string;
  enabled: boolean;
  owner: string;
  repo: string;
  workflowFile: string;
}

export interface DeploymentGitHubActionsDispatchResponse {
  actionsUrl: string;
}

/** `POST /v1/auth/tokens` */
export interface ApiTokenCreateBody {
  display_name: string;
  expires_in_days?: number;
}

/** `POST /v1/auth/oauth/callback` hook input; api/wire.ts maps to snake_case. */
export interface OAuthCallbackBody {
  provider: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}

/** `POST /v1/auth/refresh` and `POST /v1/auth/logout` hook input. */
export interface OAuthRefreshBody {
  refreshToken: string;
}

/** `POST /v1/iam/role-bindings` hook input — exactly one of `userId` or `email`. */
export interface IamRoleBindingCreateBody {
  teamId: string;
  roleId: string;
  userId?: string;
  email?: string;
}

/** `PATCH /v1/iam/role-bindings/:bindingId` hook input — moves the binding to `roleId`. */
export interface IamRoleBindingUpdateBody {
  bindingId: string;
  roleId: string;
  /** Needed for list invalidation and optimistic updates. */
  teamId: string;
}

/** `POST /v1/iam/invitations` hook input. */
export interface IamInvitationCreateBody {
  teamId: string;
  // Exactly one of email | githubHandle (validated server-side).
  email?: string;
  githubHandle?: string;
  roleId: string;
  expiresInDays?: number;
}

/** `POST /v1/iam/users` hook input — provisions a user + role binding + show-once PAT. */
export interface IamUserProvisionBody {
  teamId: string;
  email: string;
  roleId: string;
  displayName?: string;
  tokenDisplayName?: string;
  expiresInDays?: number;
}

// ---------------------------------------------------------------------------
// Response envelopes — management (managementRoutes.ts)
// ---------------------------------------------------------------------------

/** `GET /v1/teams` */
export interface TeamsListResponse {
  teams: Team[];
}

/** `POST /v1/teams` (201) and `GET /v1/teams/:teamId`. */
export interface TeamResponse {
  team: Team;
}

/** `GET /v1/teams/:teamId/apps` */
export interface AppsListResponse {
  apps: App[];
}

/** `POST /v1/apps` (201) and `POST /v1/apps/:appId/transfer` (200). */
export interface AppWithDeploymentsResponse {
  app: App;
  deployments: Deployment[];
}

/** `GET /v1/apps/:appId` and `PATCH /v1/apps/:appId`. `DELETE` returns 204. */
export interface AppResponse {
  app: App;
}

/** `GET /v1/apps/:appId/deployments` */
export interface DeploymentsListResponse {
  deployments: Deployment[];
}

/** `POST /v1/apps/:appId/deployments` (201) and `PATCH /v1/deployments/:deploymentId`. `DELETE` returns 204. */
export interface DeploymentResponse {
  deployment: Deployment;
}

/** `POST /v1/deployments/:deploymentId/clear` */
export interface DeploymentClearResponse {
  deletedReleaseCount: number;
  deployment: Deployment;
}

// ---------------------------------------------------------------------------
// Response envelopes — releases (releaseRoutes.ts)
// ---------------------------------------------------------------------------

/** Pagination envelope shared by the release and metrics list endpoints. */
export interface Pagination {
  limit: number;
  offset: number;
  total: number;
}

/** Element of `GET /v1/deployments/:deploymentId/releases` — `metrics` only with `include=metrics`. */
export interface ReleaseListItem {
  release: Release;
  job: ReleaseJob | null;
  metrics?: ReleaseMetrics;
}

/** `GET /v1/deployments/:deploymentId/releases?include=metrics&limit&offset` */
export interface ReleasesListResponse {
  releases: ReleaseListItem[];
  pagination: Pagination;
}

/** `GET /v1/releases/:releaseId` */
export interface ReleaseReadResponse {
  release: Release;
  job: ReleaseJob | null;
}

/** `PATCH /v1/releases/:releaseId` (200; a no-op patch returns 204 with no body). */
export interface ReleasePatchResponse {
  release: Release;
  job: ReleaseJob;
  warnings?: ReleaseCreationWarning[];
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

/** `POST /v1/releases/:releaseId/promote` and `POST /v1/deployments/:deploymentId/rollback` (201). */
export interface ReleaseLifecycleResponse {
  release: Release;
  job: ReleaseJob;
  warnings?: ReleaseCreationWarning[];
}

// ---------------------------------------------------------------------------
// Response envelopes — metrics (metricsRoutes.ts)
// ---------------------------------------------------------------------------

/** Per-release counter element emitted by both metrics query endpoints (hash-keyed aggregation). */
export interface ReleaseMetricsEntry {
  releaseId: string;
  releaseLabel: string;
  targetBinaryVersion: string;
  targetPackageHash: string | null;
  metrics: ReleaseMetrics;
}

/** `GET /v1/metrics/deployments/:deploymentId?limit&offset` */
export interface DeploymentMetricsResponse {
  releases: ReleaseMetricsEntry[];
  pagination: Pagination;
}

/** `GET /v1/metrics/releases/:releaseId` */
export interface ReleaseMetricsResponse {
  release: ReleaseMetricsEntry;
}

// ---------------------------------------------------------------------------
// Response envelopes — IAM (iamRoutes.ts / iamSupport.ts)
// ---------------------------------------------------------------------------

/** `GET /v1/iam/roles` */
export interface RolesListResponse {
  roles: RoleDefinition[];
}

/** `GET /v1/iam/role-bindings?teamId` */
export interface RoleBindingsListResponse {
  roleBindings: RoleBinding[];
}

/** `GET /v1/iam/invitations?teamId&status` */
export interface InvitationsListResponse {
  invitations: TeamInvitation[];
}

/** `POST /v1/iam/role-bindings` — 201 when created, 200 when the binding already existed. `DELETE` returns 204. */
export interface RoleBindingCreateResponse {
  roleBinding: RoleBinding;
}

/**
 * `POST /v1/iam/invitations` — discriminated by `outcome`: `pending` (201 new /
 * 200 existing), or 200 when the email already has an account
 * (`accepted_existing_user`) or already holds the role (`already_granted`,
 * `invitation` is null). `DELETE /v1/iam/invitations/:id` returns 204.
 */
export type InvitationCreateResponse =
  | {
      invitation: TeamInvitation;
      outcome: "pending";
    }
  | {
      invitation: TeamInvitation;
      outcome: "accepted_existing_user";
      roleBinding: RoleBinding;
    }
  | {
      invitation: null;
      outcome: "already_granted";
      roleBinding: RoleBinding;
    };

export interface IamProvisionedUser {
  created: boolean;
  email: string;
  id: string;
}

/** `POST /v1/iam/users` (201) — `token` is the show-once plaintext PAT. */
export interface IamUserProvisionResponse {
  apiToken: ApiTokenMetadata;
  roleBinding: RoleBinding;
  token: string;
  user: IamProvisionedUser;
}

// ---------------------------------------------------------------------------
// Response envelopes — auth (authRoutes.ts / authSupport.ts)
// ---------------------------------------------------------------------------

/** Trimmed user embedded in session responses (NOT the full `User` from `GET /v1/users/me`). */
export interface SessionUser {
  createdAt: string;
  displayName: string | null;
  email: string;
  id: string;
}

/** `POST /v1/auth/oauth/callback` (200) — also emitted by the CLI device-poll flow. */
export interface SessionResponse {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  user: SessionUser;
}

/** `POST /v1/auth/refresh` (200) — rotated pair; no `user` field. `POST /v1/auth/logout` returns 204. */
export interface RefreshResponse {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

/** `GET /v1/users/me` */
export interface MeResponse {
  user: User;
}

/** `GET /v1/auth/tokens` */
export interface ApiTokensListResponse {
  apiTokens: ApiTokenMetadata[];
}

/** `POST /v1/auth/tokens` (201) — `token` is the show-once plaintext secret. `DELETE /v1/auth/tokens/:tokenId` returns 204. */
export interface ApiTokenCreateResponse {
  apiToken: ApiTokenMetadata;
  token: string;
}

/**
 * `GET /v1/auth/oauth/web-config` (public). When web OAuth is
 * unconfigured the server returns a 404 problem with `type: "about:blank"`
 * (no suffix) so it is distinguishable from resource `not-found`.
 */
export interface OAuthWebConfig {
  /** Echoed into the callback body; "github" on stock servers. */
  provider: string;
  clientId: string;
  scopes: string;
  /** Absent = normal GitHub mode; "local-dev" = local evaluation stack. */
  mode?: string;
  /**
   * Authorize origin override. Absent = github.com (or the build-time
   * VITE_OAUTH_AUTHORIZE_BASE_URL); "" = same-origin (the SPA's own consent
   * route) — "" is a PRESENT value, resolution must not use truthiness.
   */
  authorizeBaseUrl?: string;
}

// ---------------------------------------------------------------------------
// Problem details (RFC 9457) — ported from server/src/app/problemDetails.ts
// ---------------------------------------------------------------------------

export type ProblemTypeSuffix =
  | "account-disabled"
  | "active-release-job"
  | "authentication-required"
  | "app-conflict"
  | "duplicate-release"
  | "forbidden"
  | "idempotency-in-progress"
  | "idempotency-mismatch"
  | "deployment-conflict"
  | "invitation-conflict"
  | "invitation-not-pending"
  | "invalid-status-transition"
  | "not-found"
  | "release-conflict"
  | "role-not-supported"
  | "rollback-no-op"
  | "status-transition-conflict"
  | "team-conflict"
  | "last-owner"
  | "user-exists"
  | "validation-error";

export interface ProblemFieldError {
  field: string;
  message: string;
  reason: string;
}

/**
 * `application/problem+json` body. `type` is
 * `https://codemagic.io/patch/errors/<ProblemTypeSuffix>` or `about:blank`; the
 * index signature carries extensions (`outcome`, `reason`, `activeJob`,
 * `latestRelease`, ...).
 */
export interface ProblemDetails {
  detail: string;
  errors?: ProblemFieldError[];
  instance?: string;
  status: number;
  title: string;
  type: string;
  [key: string]: unknown;
}
