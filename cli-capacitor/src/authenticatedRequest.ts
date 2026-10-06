// Ported from cli/src/authenticatedRequest.ts (@codemagic/patch-cli 0.4.0): the same
// precedence (--token, then CODEMAGIC_PATCH_TOKEN, then the stored sign-in), the same
// one-shot refresh of an expired browser session, the same clearing of a stored
// credential the server no longer accepts. Two differences. With nothing to
// authenticate with, this fails here — naming the ways to fix it — instead of sending
// a request the server can only answer with 401; `assertCanAuthenticate` lets a
// command learn that before it asks the user anything. And the messages name this
// CLI's `login`. See cli-capacitor-tech-spec › Provenance.

import { buildApiUrl, normalizeBearerToken, TOKEN_ENV } from "./api";
import { CLI_NAME, PRODUCT_NAME } from "./branding";
import {
  loadStoredCredential,
  removeStoredCredential,
  saveStoredCredential,
  type OAuthStoredCredential,
  type StoredCredential,
} from "./credentials";
import { UsageError, ValidationError } from "./errors";
import { request } from "./http";
import { isRecord } from "./output";
import { getProblemTypeSuffix, HttpProblemError } from "./problem-details";

type RequestInitLike = NonNullable<Parameters<typeof globalThis.fetch>[1]>;

export type AuthenticatedRequestInit = Omit<RequestInitLike, "headers"> & {
  headers?: Record<string, string>;
};

export interface AuthenticatedRequestDeps {
  env: Record<string, string | undefined>;
  fetch: typeof globalThis.fetch;
  sleep: (milliseconds: number) => Promise<void>;
}

export interface ApiTarget {
  serverUrl: string;
  /** The `--token` flag, when given. It outranks everything else. */
  token?: string;
}

type AuthSource =
  | {
      accessToken: string;
      kind: "explicit";
    }
  | {
      credential: StoredCredential;
      kind: "stored";
    };

type RefreshResponse = {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
};

/** Fails — without touching the network — when there is nothing to authenticate with. */
export async function assertCanAuthenticate(
  deps: AuthenticatedRequestDeps,
  target: ApiTarget,
): Promise<void> {
  await resolveAuthSource(deps, target);
}

export async function authenticatedRequest(
  deps: AuthenticatedRequestDeps,
  target: ApiTarget,
  pathname: string,
  init: AuthenticatedRequestInit = {},
): Promise<unknown> {
  const authSource = await resolveAuthSource(deps, target);

  try {
    return await performAuthenticatedRequest(
      deps,
      target,
      pathname,
      init,
      accessTokenForSource(authSource),
    );
  } catch (error) {
    if (authSource.kind !== "stored" || !isAuthenticationRequired(error)) {
      throw error;
    }

    // Token logins persist a personal access token with no refresh token, so a
    // 401 means the token was revoked or expired — clear it and ask to re-login.
    if (authSource.credential.kind === "token") {
      await removeStoredCredential(target.serverUrl, { env: deps.env });
      throw new ValidationError(
        `Stored ${PRODUCT_NAME} token was rejected. Run \`${CLI_NAME} login --server-url ${target.serverUrl} --token <token>\` to sign in again.`,
      );
    }

    let refreshed: StoredCredential;
    try {
      refreshed = await refreshStoredCredential(
        deps,
        target,
        authSource.credential,
      );
    } catch (refreshError) {
      if (!isAuthenticationRequired(refreshError)) {
        throw refreshError;
      }

      // The server rotates refresh tokens, and two runs of this CLI can overlap (a
      // terminal and a CI step, two jobs on one machine): if another process refreshed
      // this session between our read and our refresh, ours was the consumed token.
      // What that process stored is the live session — use it rather than deleting it.
      const current = await loadStoredCredential(target.serverUrl, { env: deps.env });
      if (
        current?.kind === "oauth" &&
        current.refreshToken !== authSource.credential.refreshToken
      ) {
        return performAuthenticatedRequest(
          deps,
          target,
          pathname,
          init,
          current.accessToken,
        );
      }

      await removeStoredCredential(target.serverUrl, { env: deps.env });
      throw new ValidationError(
        `Stored ${PRODUCT_NAME} session expired or was revoked. Run \`${CLI_NAME} login --server-url ${target.serverUrl}\` to sign in again.`,
      );
    }

    return performAuthenticatedRequest(
      deps,
      target,
      pathname,
      init,
      refreshed.accessToken,
    );
  }
}

async function performAuthenticatedRequest(
  deps: AuthenticatedRequestDeps,
  target: ApiTarget,
  pathname: string,
  init: AuthenticatedRequestInit,
  accessToken: string,
): Promise<unknown> {
  try {
    return await request(
      deps.fetch,
      buildApiUrl(target.serverUrl, pathname),
      {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          authorization: `Bearer ${accessToken}`,
        },
      },
      { sleep: deps.sleep },
    );
  } catch (error) {
    // Re-thrown with the server URL attached so the error report can say which
    // server rejected the request.
    if (error instanceof HttpProblemError) {
      throw new HttpProblemError(
        error.problem,
        error.responseStatus,
        target.serverUrl,
      );
    }
    throw error;
  }
}

async function resolveAuthSource(
  deps: AuthenticatedRequestDeps,
  target: ApiTarget,
): Promise<AuthSource> {
  const explicitToken = resolveOptionalString(target.token);
  if (explicitToken) {
    return {
      accessToken: normalizeBearerToken(explicitToken),
      kind: "explicit",
    };
  }

  const envToken = resolveOptionalString(deps.env[TOKEN_ENV]);
  if (envToken) {
    return {
      accessToken: normalizeBearerToken(envToken),
      kind: "explicit",
    };
  }

  const stored = await loadStoredCredential(target.serverUrl, { env: deps.env });
  if (stored) {
    return {
      credential: stored,
      kind: "stored",
    };
  }

  throw new UsageError(
    [
      `Not signed in to ${target.serverUrl}.`,
      `Run \`${CLI_NAME} login --server-url ${target.serverUrl}\`, or set ${TOKEN_ENV} (or pass --token <token>) to an access token.`,
    ].join("\n"),
  );
}

async function refreshStoredCredential(
  deps: AuthenticatedRequestDeps,
  target: ApiTarget,
  credential: OAuthStoredCredential,
): Promise<StoredCredential> {
  const response = parseRefreshResponse(
    await request(
      deps.fetch,
      buildApiUrl(target.serverUrl, "/v1/auth/refresh"),
      {
        body: JSON.stringify({ refresh_token: credential.refreshToken }),
        headers: {
          "content-type": "application/json",
        },
        method: "POST",
      },
    ),
  );
  const refreshed = {
    ...credential,
    ...response,
  };

  await saveStoredCredential(target.serverUrl, refreshed, { env: deps.env });
  return refreshed;
}

function parseRefreshResponse(value: unknown): RefreshResponse {
  if (!isRecord(value)) {
    throw new Error("OAuth refresh returned an invalid response");
  }

  const accessToken = value.access_token;
  const accessTokenExpiresAt = value.access_token_expires_at;
  const refreshToken = value.refresh_token;
  const refreshTokenExpiresAt = value.refresh_token_expires_at;

  if (
    !isNonEmptyString(accessToken) ||
    !isNonEmptyString(accessTokenExpiresAt) ||
    !isNonEmptyString(refreshToken) ||
    !isNonEmptyString(refreshTokenExpiresAt)
  ) {
    throw new Error("OAuth refresh returned an invalid response");
  }

  return {
    accessToken,
    accessTokenExpiresAt,
    refreshToken,
    refreshTokenExpiresAt,
  };
}

function accessTokenForSource(authSource: AuthSource): string {
  return authSource.kind === "stored"
    ? authSource.credential.accessToken
    : authSource.accessToken;
}

function resolveOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isAuthenticationRequired(error: unknown): boolean {
  if (!(error instanceof HttpProblemError) || error.responseStatus !== 401) {
    return false;
  }

  return getProblemTypeSuffix(error.problem.type) === "authentication-required";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
