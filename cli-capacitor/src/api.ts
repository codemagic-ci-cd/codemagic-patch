// Where the server is and how to address it: the URL helpers of
// cli/src/commands/shared.ts (@codemagic/patch-cli 0.4.0), unchanged, and its
// `withUnavailableFeatureMessage` (0.7.0), plus the server URL resolution. `cmpatch` reads a server URL from its project config file as
// well; this CLI has no project config, so it goes from the flag to the environment to
// the user config file (userConfig.ts). The flag and environment variable names are
// `cmpatch`'s, so a CI job configured for one works for the other.
// See cli-capacitor-tech-spec › Provenance.

import { CLI_NAME } from "./branding";
import { UsageError, ValidationError } from "./errors";
import { HttpProblemError, ServerFeatureUnavailableError } from "./problem-details";
import { readConfiguredServerUrl, UserConfigFileError } from "./userConfig";

export const SERVER_URL_ENV = "CODEMAGIC_PATCH_SERVER_URL";
export const TOKEN_ENV = "CODEMAGIC_PATCH_TOKEN";

/**
 * `--server-url`, then CODEMAGIC_PATCH_SERVER_URL, then the user config file's
 * `serverUrl`. Validated before any request.
 */
export function resolveServerUrl(
  flagValue: string | undefined,
  env: Record<string, string | undefined>,
): string {
  const named =
    resolveOptionalString(flagValue) ?? resolveOptionalString(env[SERVER_URL_ENV]);
  if (named !== undefined) {
    return assertHttpUrl(named);
  }

  // Read only now: a run that names its server must not fail over a config file it
  // has no use for — which is the way around a broken file that is added below.
  const configured = readDefaultServer(env);
  if (configured !== undefined) {
    return assertHttpUrl(configured.serverUrl, `Server URL in ${configured.configPath}`);
  }

  throw new UsageError(
    `Missing server URL. Pass --server-url <url>, set ${SERVER_URL_ENV}, or store a default with \`${CLI_NAME} config set --server-url <url>\`.`,
  );
}

function readDefaultServer(
  env: Record<string, string | undefined>,
): ReturnType<typeof readConfiguredServerUrl> {
  try {
    return readConfiguredServerUrl(env);
  } catch (error) {
    if (!(error instanceof UserConfigFileError)) {
      throw error;
    }

    throw new ValidationError(
      `${error.message}\nOr name the server with --server-url <url> or ${SERVER_URL_ENV}: with either, the file is not read.`,
    );
  }
}

export function buildApiUrl(serverUrl: string, pathname: string): string {
  const base = assertHttpUrl(serverUrl);
  const normalized = base.endsWith("/") ? base : `${base}/`;
  const url = new URL(pathname.replace(/^\//, ""), normalized);

  return url.toString();
}

export function buildApiUrlWithQuery(
  serverUrl: string,
  pathname: string,
  query: Record<string, number | string | undefined>,
): string {
  const base = assertHttpUrl(serverUrl);
  const normalized = base.endsWith("/") ? base : `${base}/`;
  const url = new URL(pathname.replace(/^\//, ""), normalized);
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      params.set(key, String(value));
    }
  }

  const queryString = params.toString();
  if (queryString.length > 0) {
    url.search = queryString;
  }

  return url.toString();
}

export function assertHttpUrl(value: string, label = "Server URL"): string {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ValidationError(
      `${label} must start with http:// or https:// (got "${value}").`,
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ValidationError(
      `${label} must start with http:// or https:// (got "${value}").`,
    );
  }

  return trimmed;
}

/**
 * Prefixes of the server's own secrets: personal access tokens (server/src/app/apiToken.ts)
 * and OAuth access and refresh tokens (server/src/app/oauthToken.ts). A value with one is
 * a credential, never a deployment key, and must never be sent to a public URL or printed.
 */
export const SERVER_CREDENTIAL_PREFIXES = ["cm_pat_", "cm_oat_", "cm_ort_"] as const;

/** Whether `value` is a token the server issued (see SERVER_CREDENTIAL_PREFIXES). */
export function isServerCredential(value: string): boolean {
  const trimmed = value.trim();
  return SERVER_CREDENTIAL_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/** Every server-issued token in a text, for redaction. */
export const SERVER_CREDENTIAL_PATTERN = /cm_(?:pat|oat|ort)_[A-Za-z0-9_-]+/g;

// Matches a non-ASCII or non-printable character, which cannot be placed in an
// HTTP header value. A stray one usually means the token was copied incorrectly
// (e.g. a homoglyph picked up from a chat or PDF), which otherwise surfaces as a
// cryptic "Cannot convert argument to a ByteString" error from fetch.
const NON_HEADER_SAFE_CHARACTER = /[^\x21-\x7e]/;

export function normalizeBearerToken(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length === 0) {
    throw new ValidationError("The access token is empty.");
  }

  if (NON_HEADER_SAFE_CHARACTER.test(trimmed)) {
    throw new ValidationError(
      "The access token contains invalid characters. It looks like it was copied incorrectly — please paste it again.",
    );
  }

  return trimmed;
}

function resolveOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The request, with a 501 answered by `unavailableMessage`: the server has the route
 * but nothing behind it (too old, or the feature is turned off), which reads as one
 * sentence about that server rather than as a failed request.
 */
export async function withUnavailableFeatureMessage<T>(request: Promise<T>, unavailableMessage: string): Promise<T> {
  try {
    return await request;
  } catch (error) {
    if (error instanceof HttpProblemError && error.responseStatus === 501) {
      throw new ServerFeatureUnavailableError(error, unavailableMessage);
    }

    throw error;
  }
}
