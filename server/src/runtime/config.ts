import type { ServerMode } from "../app/types";
import { DEFAULT_MAX_UPLOAD_SIZE_BYTES } from "../app/upload-size";
import { DEFAULT_MANIFEST_CACHE_CONTROL } from "../worker/cachePolicy";
import { resolveDatabaseSearchPath } from "./databaseSearchPath";

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 3000;
const DEFAULT_MODE: ServerMode = "all";
const DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS = 900;
const DEFAULT_OAUTH_REFRESH_TOKEN_TTL_DAYS = 30;
const DEFAULT_IAM_INVITATION_TTL_DAYS = 14;
const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
const DEFAULT_GITHUB_OAUTH_BASE_URL = "https://github.com";
const DEFAULT_GITHUB_OAUTH_SCOPES = "read:user user:email";
const MAX_OAUTH_ACCESS_TOKEN_TTL_SECONDS = 24 * 60 * 60;
const MAX_OAUTH_REFRESH_TOKEN_TTL_DAYS = 365;
const MAX_IAM_INVITATION_TTL_DAYS = 90;
const MIN_OAUTH_DEVICE_POLL_TOKEN_SECRET_LENGTH = 32;
const MIN_WORKER_SHARED_SECRET_LENGTH = 32;

type RuntimeEnvironment = Record<string, string | undefined>;

export interface S3StorageConfig {
  accessKeyId?: string;
  bucket: string;
  endpoint?: string;
  forcePathStyle: boolean;
  region: string;
  secretAccessKey?: string;
}

export interface GcsStorageConfig {
  internalBucket: string;
  publicBucket: string;
}

export interface CloudflareDeliveryConfig {
  /** Cloudflare API base URL override; the adapter applies the default when unset. */
  apiBaseUrl?: string;
  /** API token scoped to Zone > Cache Purge. */
  apiToken: string;
  /** Zone id that contains the storage domain. */
  zoneId: string;
}

export interface GitHubOAuthConfig {
  allowedRedirectUris?: string[];
  apiBaseUrl: string;
  clientId: string;
  clientSecret?: string;
  oauthBaseUrl: string;
  scopes: string;
}

export type StagedBundleRetention = "delete" | "keep";

export type RegistrationMode = "invite_only" | "open";

export interface RuntimeConfig {
  cloudflare?: CloudflareDeliveryConfig;
  databaseMaxConnections?: number;
  databaseSearchPath: string[];
  databaseUrl?: string;
  deliveryAdapter: "base-url" | "cloudflare";
  gcs?: GcsStorageConfig;
  githubOAuth?: GitHubOAuthConfig;
  host: string;
  iamInvitationTtlDays: number;
  initialAdminEmails: string[];
  logger: boolean;
  manifestCacheControl: string;
  maxUploadSizeBytes: number;
  mode: ServerMode;
  oauthAccessTokenTtlSeconds: number;
  /**
   * Secret for signing device-flow poll tokens. Parsed independently of the
   * GitHub OAuth config so injected device adapters (local-dev entry, embedders)
   * can enable the device flow without a GitHub client id.
   */
  oauthDevicePollTokenSecret?: string;
  oauthRefreshTokenTtlDays: number;
  patchWindow: number | null;
  port: number;
  publicBaseUrl: string;
  registrationMode: RegistrationMode;
  runMigrations: boolean;
  s3?: S3StorageConfig;
  stagedBundleRetention: StagedBundleRetention;
  storageAdapter: "memory" | "s3" | "gcs";
  workerSharedSecret?: string;
}

export function resolveRuntimeConfig(
  env: RuntimeEnvironment = process.env,
): RuntimeConfig {
  const storageAdapter = resolveStorageAdapter(env.STORAGE_ADAPTER);
  const mode = resolveMode(env.MODE);
  const deliveryAdapter = resolveDeliveryAdapter(env.DELIVERY_ADAPTER);
  const githubOAuth = resolveGitHubOAuthConfig(env);

  return {
    cloudflare:
      deliveryAdapter === "cloudflare"
        ? resolveCloudflareConfig(env)
        : undefined,
    databaseMaxConnections: resolveOptionalPositiveInteger(
      env.DATABASE_MAX_CONNECTIONS,
      "DATABASE_MAX_CONNECTIONS",
    ),
    databaseSearchPath: resolveDatabaseSearchPath(env.DATABASE_SEARCH_PATH),
    databaseUrl: resolveDatabaseUrl(env.DATABASE_URL, mode),
    deliveryAdapter,
    githubOAuth,
    host: resolveHost(env.HOST),
    iamInvitationTtlDays: resolvePositiveIntegerWithDefaultAndMax(
      env.IAM_INVITATION_TTL_DAYS,
      "IAM_INVITATION_TTL_DAYS",
      DEFAULT_IAM_INVITATION_TTL_DAYS,
      MAX_IAM_INVITATION_TTL_DAYS,
    ),
    initialAdminEmails: resolveInitialAdminEmails(env.INITIAL_ADMIN_EMAILS),
    logger: resolveLogger(env.LOGGER),
    manifestCacheControl: resolveManifestCacheControl(
      env.MANIFEST_CACHE_CONTROL,
    ),
    maxUploadSizeBytes: resolveMaxUploadSize(env.MAX_UPLOAD_SIZE),
    mode,
    oauthAccessTokenTtlSeconds: resolvePositiveIntegerWithDefaultAndMax(
      env.OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      "OAUTH_ACCESS_TOKEN_TTL_SECONDS",
      DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      MAX_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
    ),
    oauthDevicePollTokenSecret: resolveOAuthDevicePollTokenSecret(
      env.OAUTH_DEVICE_POLL_TOKEN_SECRET,
      githubOAuth !== undefined,
    ),
    oauthRefreshTokenTtlDays: resolvePositiveIntegerWithDefaultAndMax(
      env.OAUTH_REFRESH_TOKEN_TTL_DAYS,
      "OAUTH_REFRESH_TOKEN_TTL_DAYS",
      DEFAULT_OAUTH_REFRESH_TOKEN_TTL_DAYS,
      MAX_OAUTH_REFRESH_TOKEN_TTL_DAYS,
    ),
    patchWindow:
      resolveOptionalPositiveInteger(env.PATCH_WINDOW, "PATCH_WINDOW") ?? null,
    port: resolvePort(env.PORT),
    publicBaseUrl: resolvePublicBaseUrl(
      env.PUBLIC_BASE_URL,
      env.HOST,
      env.PORT,
      storageAdapter,
    ),
    registrationMode: resolveRegistrationMode(env.REGISTRATION_MODE),
    runMigrations: resolveRunMigrations(env.RUN_MIGRATIONS),
    gcs: storageAdapter === "gcs" ? resolveGcsConfig(env) : undefined,
    s3: storageAdapter === "s3" ? resolveS3Config(env) : undefined,
    stagedBundleRetention: resolveStagedBundleRetention(env.UPLOAD_RETENTION),
    storageAdapter,
    workerSharedSecret: resolveWorkerSharedSecret(env.WORKER_SHARED_SECRET, mode),
  };
}

function resolveDatabaseUrl(
  value: string | undefined,
  mode: ServerMode,
): string | undefined {
  const databaseUrl = resolveOptionalString(value);

  if ((mode === "all" || mode === "api") && !databaseUrl) {
    throw new Error(`DATABASE_URL is required when MODE=${mode}`);
  }

  return databaseUrl;
}

function resolveWorkerSharedSecret(
  workerSharedSecret: string | undefined,
  mode: ServerMode,
): string | undefined {
  const secret = resolveOptionalString(workerSharedSecret);

  if (mode === "api" || !secret) {
    return secret;
  }

  if (secret.length < MIN_WORKER_SHARED_SECRET_LENGTH) {
    throw new Error(
      `WORKER_SHARED_SECRET must be at least ${MIN_WORKER_SHARED_SECRET_LENGTH} characters when worker capabilities are enabled`,
    );
  }

  return secret;
}

function resolveHost(host: string | undefined): string {
  if (host === undefined) {
    return DEFAULT_HOST;
  }

  const trimmedHost = host.trim();

  if (trimmedHost.length === 0) {
    throw new Error("HOST must not be empty");
  }

  return trimmedHost;
}

function resolveLogger(logger: string | undefined): boolean {
  return logger !== "false";
}

function resolveMode(mode: string | undefined): ServerMode {
  if (mode === undefined) {
    return DEFAULT_MODE;
  }

  if (mode === "all" || mode === "api" || mode === "worker") {
    return mode;
  }

  throw new Error(
    `MODE must be one of: all, api, worker. Received: ${JSON.stringify(mode)}`,
  );
}

function resolvePort(port: string | undefined): number {
  if (port === undefined) {
    return DEFAULT_PORT;
  }

  if (!/^\d+$/.test(port)) {
    throw new Error(
      `PORT must be a decimal integer between 0 and 65535. Received: ${port}`,
    );
  }

  const parsedPort = Number.parseInt(port, 10);

  if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
    throw new Error(
      `PORT must be a decimal integer between 0 and 65535. Received: ${port}`,
    );
  }

  return parsedPort;
}

function resolveOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmedValue = value.trim();

  return trimmedValue.length > 0 ? trimmedValue : undefined;
}

function resolveOptionalPositiveInteger(
  value: string | undefined,
  name: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!/^\d+$/.test(value)) {
    throw new Error(
      `${name} must be a positive decimal integer. Received: ${value}`,
    );
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `${name} must be a positive decimal integer. Received: ${value}`,
    );
  }

  return parsed;
}

function resolveGitHubOAuthConfig(
  env: RuntimeEnvironment,
): GitHubOAuthConfig | undefined {
  const clientId = resolveOptionalString(env.GITHUB_OAUTH_CLIENT_ID);
  if (!clientId) {
    return undefined;
  }

  return {
    allowedRedirectUris: resolveAllowedRedirectUris(
      env.GITHUB_OAUTH_ALLOWED_REDIRECT_URIS,
    ),
    apiBaseUrl: trimTrailingSlash(
      resolveOptionalString(env.GITHUB_API_BASE_URL) ??
        DEFAULT_GITHUB_API_BASE_URL,
    ),
    clientId,
    clientSecret: resolveOptionalString(env.GITHUB_OAUTH_CLIENT_SECRET),
    oauthBaseUrl: trimTrailingSlash(
      resolveOptionalString(env.GITHUB_OAUTH_BASE_URL) ??
        DEFAULT_GITHUB_OAUTH_BASE_URL,
    ),
    scopes:
      resolveOptionalString(env.GITHUB_OAUTH_SCOPES) ??
      DEFAULT_GITHUB_OAUTH_SCOPES,
  };
}

function resolveOAuthDevicePollTokenSecret(
  value: string | undefined,
  githubOAuthConfigured: boolean,
): string | undefined {
  const pollTokenSecret = resolveOptionalString(value);

  if (!pollTokenSecret) {
    if (githubOAuthConfigured) {
      throw new Error(
        "OAUTH_DEVICE_POLL_TOKEN_SECRET is required when GITHUB_OAUTH_CLIENT_ID is set",
      );
    }
    return undefined;
  }

  if (pollTokenSecret.length < MIN_OAUTH_DEVICE_POLL_TOKEN_SECRET_LENGTH) {
    throw new Error(
      `OAUTH_DEVICE_POLL_TOKEN_SECRET must be at least ${MIN_OAUTH_DEVICE_POLL_TOKEN_SECRET_LENGTH} characters`,
    );
  }

  return pollTokenSecret;
}

/**
 * Comma-separated allowlist of exact `redirectUri` values accepted by the web
 * OAuth callback. Unset (or blank) disables the allowlist check entirely, so
 * an empty parse result resolves to `undefined` rather than an empty list
 * that would reject every redirect.
 */
function resolveAllowedRedirectUris(
  value: string | undefined,
): string[] | undefined {
  const entries = parseCsvList(value);

  return entries.length > 0 ? entries : undefined;
}

function resolvePositiveIntegerWithDefaultAndMax(
  value: string | undefined,
  name: string,
  defaultValue: number,
  max: number,
): number {
  const parsed = resolveOptionalPositiveInteger(value, name) ?? defaultValue;

  if (parsed > max) {
    throw new Error(
      `${name} must be less than or equal to ${max}. Received: ${parsed}`,
    );
  }

  return parsed;
}

function resolveMaxUploadSize(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_MAX_UPLOAD_SIZE_BYTES;
  }

  const trimmedValue = value.trim().toLowerCase();
  const match = /^(\d+)(b|kb|mb|gb)?$/.exec(trimmedValue);

  if (!match) {
    throw new Error(
      `MAX_UPLOAD_SIZE must be a positive size like 209715200 or 200mb. Received: ${value}`,
    );
  }

  const amount = Number.parseInt(match[1], 10);
  const unit = match[2] ?? "b";
  const multiplier =
    unit === "gb"
      ? 1024 * 1024 * 1024
      : unit === "mb"
        ? 1024 * 1024
        : unit === "kb"
          ? 1024
          : 1;
  const resolved = amount * multiplier;

  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(
      `MAX_UPLOAD_SIZE must be a positive size like 209715200 or 200mb. Received: ${value}`,
    );
  }

  return resolved;
}

function parseCsvList(value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }

  return value
    .split(",")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/**
 * Comma-separated allowlist of emails permitted to create the first admin
 * account via GitHub OAuth even under invite-only registration. Email
 * canonicalization/matching happens later in `resolveOAuthIdentity`; here we
 * only split and trim the raw entries.
 */
function resolveInitialAdminEmails(value: string | undefined): string[] {
  return parseCsvList(value);
}

function resolveRunMigrations(runMigrations: string | undefined): boolean {
  return runMigrations !== "false";
}

function resolveManifestCacheControl(value: string | undefined): string {
  return resolveOptionalString(value) ?? DEFAULT_MANIFEST_CACHE_CONTROL;
}

function resolveRegistrationMode(value: string | undefined): RegistrationMode {
  const normalized = resolveOptionalString(value);

  if (normalized === undefined || normalized === "invite_only") {
    return "invite_only";
  }

  if (normalized === "open") {
    return "open";
  }

  throw new Error(
    `REGISTRATION_MODE must be one of: invite_only, open. Received: ${JSON.stringify(value)}`,
  );
}

function resolveStagedBundleRetention(
  value: string | undefined,
): StagedBundleRetention {
  if (value === undefined || value === "delete") {
    return "delete";
  }

  if (value === "keep") {
    return "keep";
  }

  throw new Error(
    `UPLOAD_RETENTION must be one of: delete, keep. Received: ${JSON.stringify(value)}`,
  );
}

function resolveStorageAdapter(
  storageAdapter: string | undefined,
): "memory" | "s3" | "gcs" {
  if (storageAdapter === undefined || storageAdapter === "memory") {
    return "memory";
  }

  if (storageAdapter === "s3") {
    return "s3";
  }

  if (storageAdapter === "gcs") {
    return "gcs";
  }

  throw new Error(
    `STORAGE_ADAPTER must be one of: memory, s3, gcs. Received: ${JSON.stringify(storageAdapter)}`,
  );
}

function resolveS3Config(env: RuntimeEnvironment): S3StorageConfig {
  const bucket = resolveOptionalString(env.S3_BUCKET);
  if (!bucket) {
    throw new Error("S3_BUCKET is required when STORAGE_ADAPTER=s3");
  }

  const accessKeyId = resolveOptionalString(env.S3_ACCESS_KEY_ID);
  const secretAccessKey = resolveOptionalString(env.S3_SECRET_ACCESS_KEY);

  if ((accessKeyId === undefined) !== (secretAccessKey === undefined)) {
    throw new Error(
      "S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together, or both omitted to use the default credential chain",
    );
  }

  return {
    accessKeyId,
    bucket,
    endpoint: resolveOptionalString(env.S3_ENDPOINT),
    forcePathStyle: resolveBoolean(env.S3_FORCE_PATH_STYLE, false),
    region: resolveOptionalString(env.S3_REGION) ?? "us-east-1",
    secretAccessKey,
  };
}

function resolveGcsConfig(env: RuntimeEnvironment): GcsStorageConfig {
  const publicBucket = resolveOptionalString(env.GCS_PUBLIC_BUCKET);
  if (!publicBucket) {
    throw new Error("GCS_PUBLIC_BUCKET is required when STORAGE_ADAPTER=gcs");
  }

  const internalBucket = resolveOptionalString(env.GCS_INTERNAL_BUCKET);
  if (!internalBucket) {
    throw new Error("GCS_INTERNAL_BUCKET is required when STORAGE_ADAPTER=gcs");
  }

  if (publicBucket === internalBucket) {
    throw new Error(
      "GCS_PUBLIC_BUCKET and GCS_INTERNAL_BUCKET must be different when STORAGE_ADAPTER=gcs",
    );
  }

  return {
    internalBucket,
    publicBucket,
  };
}

function resolveBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();

  if (normalized === "true" || normalized === "1") {
    return true;
  }

  if (normalized === "false" || normalized === "0") {
    return false;
  }

  throw new Error(
    `Boolean environment variable must be one of: true, false, 1, 0. Received: ${value}`,
  );
}

function resolveDeliveryAdapter(
  deliveryAdapter: string | undefined,
): "base-url" | "cloudflare" {
  if (deliveryAdapter === undefined || deliveryAdapter === "base-url") {
    return "base-url";
  }

  if (deliveryAdapter === "cloudflare") {
    return "cloudflare";
  }

  throw new Error(
    `DELIVERY_ADAPTER must be one of: base-url, cloudflare. Received: ${JSON.stringify(deliveryAdapter)}`,
  );
}

function resolveCloudflareConfig(
  env: RuntimeEnvironment,
): CloudflareDeliveryConfig {
  const apiToken = resolveOptionalString(env.CLOUDFLARE_API_TOKEN);
  if (!apiToken) {
    throw new Error(
      "CLOUDFLARE_API_TOKEN is required when DELIVERY_ADAPTER=cloudflare",
    );
  }

  const zoneId = resolveOptionalString(env.CLOUDFLARE_ZONE_ID);
  if (!zoneId) {
    throw new Error(
      "CLOUDFLARE_ZONE_ID is required when DELIVERY_ADAPTER=cloudflare",
    );
  }

  return {
    apiBaseUrl: resolveOptionalString(env.CLOUDFLARE_API_BASE_URL),
    apiToken,
    zoneId,
  };
}

function resolvePublicBaseUrl(
  publicBaseUrl: string | undefined,
  host: string | undefined,
  port: string | undefined,
  storageAdapter: "memory" | "s3" | "gcs",
): string {
  const resolved = resolveOptionalString(publicBaseUrl);
  if (resolved) {
    return trimTrailingSlash(resolved);
  }

  if (storageAdapter === "s3") {
    throw new Error(
      "PUBLIC_BASE_URL is required when STORAGE_ADAPTER=s3 because the API server does not serve OTA artifacts",
    );
  }

  if (storageAdapter === "gcs") {
    throw new Error(
      "PUBLIC_BASE_URL is required when STORAGE_ADAPTER=gcs because the API server does not serve OTA artifacts",
    );
  }

  return loopbackOrigin(host, port);
}

function loopbackOrigin(
  host: string | undefined,
  port: string | undefined,
): string {
  const fallbackHost =
    resolveHost(host) === "0.0.0.0" ? "127.0.0.1" : resolveHost(host);
  const fallbackPort = resolvePort(port);

  return `http://${fallbackHost}:${fallbackPort}`;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
