import {
  loadStoredCredential,
  removeStoredCredential,
  saveStoredCredential,
  type OAuthStoredCredential,
  type StoredCredential,
} from "./credentialStore";
import { PRODUCT_NAME } from "./branding";
import { request } from "./http";
import { isRecord } from "./output";
import { HttpProblemError } from "./problem-details";
import {
  buildApiUrl,
  normalizeBearerToken,
  ValidationError,
  type CommandDeps,
} from "./commands/shared";

type RequestInitLike = NonNullable<Parameters<typeof globalThis.fetch>[1]>;

// `sleep` is optional so callers that never issue idempotent requests (and the
// auth-only unit tests) need not provide it; when present it enables the
// idempotent retry policy in `request()` (gated on the `Idempotency-Key` header).
type AuthenticatedRequestDeps = Pick<CommandDeps, "env" | "fetch"> & {
  sleep?: CommandDeps["sleep"];
};

type AuthenticatedRequestInit = Omit<RequestInitLike, "headers"> & {
  headers?: Record<string, string>;
};

export type AuthenticatedRequestOptions = {
  init?: AuthenticatedRequestInit;
  serverUrl: string;
  token?: string;
  url: string;
};

type AuthSource =
  | {
      kind: "none";
    }
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

export async function authenticatedRequest(
  deps: AuthenticatedRequestDeps,
  options: AuthenticatedRequestOptions,
): Promise<unknown> {
  const authSource = await resolveAuthSource(deps, options);

  try {
    return await performAuthenticatedRequest(
      deps,
      options,
      accessTokenForSource(authSource),
    );
  } catch (error) {
    if (authSource.kind !== "stored" || !isAuthenticationRequired(error)) {
      throw error;
    }

    // Token logins persist a personal access token with no refresh token, so a
    // 401 means the token was revoked or expired — clear it and ask to re-login.
    if (authSource.credential.kind === "token") {
      await removeStoredCredential(options.serverUrl, { env: deps.env });
      throw new ValidationError(
        `Stored ${PRODUCT_NAME} token was rejected. Run \`cmpatch login --server-url ${options.serverUrl} --token <token>\` to sign in again.`,
      );
    }

    let refreshed: StoredCredential;
    try {
      refreshed = await refreshStoredCredential(
        deps,
        options,
        authSource.credential,
      );
    } catch (refreshError) {
      if (!isAuthenticationRequired(refreshError)) {
        throw refreshError;
      }

      await removeStoredCredential(options.serverUrl, { env: deps.env });
      throw new ValidationError(
        `Stored ${PRODUCT_NAME} session expired or was revoked. Run \`cmpatch login --server-url ${options.serverUrl}\` to sign in again.`,
      );
    }

    return performAuthenticatedRequest(deps, options, refreshed.accessToken);
  }
}

async function performAuthenticatedRequest(
  deps: AuthenticatedRequestDeps,
  options: AuthenticatedRequestOptions,
  accessToken: string | undefined,
): Promise<unknown> {
  try {
    return await request(
      deps.fetch,
      options.url,
      withAuthorizationHeader(options.init, accessToken),
      deps.sleep ? { sleep: deps.sleep } : undefined,
    );
  } catch (error) {
    if (error instanceof HttpProblemError) {
      throw new HttpProblemError(
        error.problem,
        error.responseStatus,
        options.serverUrl,
      );
    }
    throw error;
  }
}

async function resolveAuthSource(
  deps: AuthenticatedRequestDeps,
  options: AuthenticatedRequestOptions,
): Promise<AuthSource> {
  const explicitToken = resolveOptionalString(options.token);
  if (explicitToken) {
    return {
      accessToken: normalizeBearerToken(explicitToken),
      kind: "explicit",
    };
  }

  const envToken = resolveOptionalString(deps.env.CODEMAGIC_PATCH_TOKEN);
  if (envToken) {
    return {
      accessToken: normalizeBearerToken(envToken),
      kind: "explicit",
    };
  }

  const stored = await loadStoredCredential(options.serverUrl, { env: deps.env });
  if (stored) {
    return {
      credential: stored,
      kind: "stored",
    };
  }

  return {
    kind: "none",
  };
}

async function refreshStoredCredential(
  deps: AuthenticatedRequestDeps,
  options: AuthenticatedRequestOptions,
  credential: OAuthStoredCredential,
): Promise<StoredCredential> {
  const response = parseRefreshResponse(
    await request(
      deps.fetch,
      buildApiUrl(options.serverUrl, "/v1/auth/refresh"),
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

  await saveStoredCredential(options.serverUrl, refreshed, { env: deps.env });
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

function accessTokenForSource(authSource: AuthSource): string | undefined {
  if (authSource.kind === "stored") {
    return authSource.credential.accessToken;
  }

  if (authSource.kind === "explicit") {
    return authSource.accessToken;
  }

  return undefined;
}

function withAuthorizationHeader(
  init: AuthenticatedRequestInit | undefined,
  accessToken: string | undefined,
): AuthenticatedRequestInit | undefined {
  const headers = {
    ...(init?.headers ?? {}),
    ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
  };

  return {
    ...init,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
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

function getProblemTypeSuffix(type: unknown): string | undefined {
  if (typeof type !== "string" || type === "about:blank") {
    return undefined;
  }

  const normalized = type.replace(/\/+$/, "");
  const slashIndex = normalized.lastIndexOf("/");

  return slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
