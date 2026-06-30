import type { OAuthProviderIdentity } from "./authNAdapter";
import {
  DEFAULT_GITHUB_API_BASE_URL,
  DEFAULT_GITHUB_OAUTH_BASE_URL,
  fetchGitHubUser,
  fetchVerifiedPrimaryEmail,
  hasScope,
  postForm,
  providerError,
  readJsonObject,
  trimTrailingSlash,
} from "./githubApi";

export interface OAuthDeviceStartInput {
  provider: string;
}

export type OAuthDeviceStartResult =
  | {
      outcome: "started";
      deviceCode: string;
      expiresInSeconds: number;
      intervalSeconds: number;
      provider: "github";
      userCode: string;
      verificationUri: string;
    }
  | {
      outcome: "unknown_provider";
    }
  | {
      outcome: "provider_error";
      message: string;
    };

export interface OAuthDevicePollInput {
  deviceCode: string;
  intervalSeconds: number;
  provider: string;
}

export type OAuthDevicePollResult =
  | {
      outcome: "authorization_pending";
      intervalSeconds: number;
    }
  | {
      outcome: "slow_down";
      intervalSeconds: number;
    }
  | {
      outcome: "expired_token";
    }
  | {
      outcome: "access_denied";
    }
  | {
      outcome: "email_scope_required";
    }
  | {
      outcome: "verified_email_required";
    }
  | {
      outcome: "success";
      identity: OAuthProviderIdentity;
    }
  | {
      outcome: "unknown_provider";
    }
  | {
      outcome: "provider_error";
      message: string;
    };

export interface OAuthDeviceAuthAdapter {
  pollDeviceAuthorization(
    input: OAuthDevicePollInput,
  ): Promise<OAuthDevicePollResult>;
  startDeviceAuthorization(
    input: OAuthDeviceStartInput,
  ): Promise<OAuthDeviceStartResult>;
}

export interface CreateGitHubDeviceAuthAdapterOptions {
  apiBaseUrl?: string;
  clientId: string;
  fetch?: typeof globalThis.fetch;
  oauthBaseUrl?: string;
  scopes?: string;
}

interface GitHubDeviceStartResponse {
  device_code: unknown;
  expires_in: unknown;
  interval: unknown;
  user_code: unknown;
  verification_uri: unknown;
}

interface GitHubTokenResponse {
  access_token?: unknown;
  error?: unknown;
  interval?: unknown;
  scope?: unknown;
  token_type?: unknown;
}

const DEFAULT_GITHUB_SCOPES = "read:user user:email";
const GITHUB_DEVICE_GRANT_TYPE =
  "urn:ietf:params:oauth:grant-type:device_code";

export function createGitHubDeviceAuthAdapter(
  options: CreateGitHubDeviceAuthAdapterOptions,
): OAuthDeviceAuthAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const oauthBaseUrl = trimTrailingSlash(
    options.oauthBaseUrl ?? DEFAULT_GITHUB_OAUTH_BASE_URL,
  );
  const apiBaseUrl = trimTrailingSlash(
    options.apiBaseUrl ?? DEFAULT_GITHUB_API_BASE_URL,
  );
  const scopes = options.scopes ?? DEFAULT_GITHUB_SCOPES;

  return {
    async startDeviceAuthorization(input) {
      if (input.provider !== "github") {
        return {
          outcome: "unknown_provider",
        };
      }

      const response = await postForm(fetchImpl, `${oauthBaseUrl}/login/device/code`, {
        client_id: options.clientId,
        scope: scopes,
      });
      if (!response.ok) {
        return providerError(`GitHub device start failed with HTTP ${response.status}`);
      }

      const body = await readJsonObject<GitHubDeviceStartResponse>(response);
      if (!body) {
        return providerError("GitHub device start returned invalid JSON");
      }

      const parsed = parseDeviceStartResponse(body);
      if (!parsed) {
        return providerError("GitHub device start returned an invalid response");
      }

      return {
        ...parsed,
        outcome: "started",
        provider: "github",
      };
    },

    async pollDeviceAuthorization(input) {
      if (input.provider !== "github") {
        return {
          outcome: "unknown_provider",
        };
      }

      const tokenResponse = await postForm(
        fetchImpl,
        `${oauthBaseUrl}/login/oauth/access_token`,
        {
          client_id: options.clientId,
          device_code: input.deviceCode,
          grant_type: GITHUB_DEVICE_GRANT_TYPE,
        },
      );
      if (!tokenResponse.ok) {
        return providerError(
          `GitHub device poll failed with HTTP ${tokenResponse.status}`,
        );
      }

      const tokenBody = await readJsonObject<GitHubTokenResponse>(tokenResponse);
      if (!tokenBody) {
        return providerError("GitHub device poll returned invalid JSON");
      }

      const pollState = parsePollState(tokenBody, input.intervalSeconds);
      if (pollState) {
        return pollState;
      }

      const accessToken =
        typeof tokenBody.access_token === "string"
          ? tokenBody.access_token
          : undefined;
      if (!accessToken) {
        return providerError("GitHub device poll returned no access token");
      }

      if (!hasScope(tokenBody.scope, "user:email")) {
        return {
          outcome: "email_scope_required",
        };
      }

      const user = await fetchGitHubUser(fetchImpl, apiBaseUrl, accessToken);
      if (user.outcome !== "success") {
        return user;
      }

      const email = await fetchVerifiedPrimaryEmail(
        fetchImpl,
        apiBaseUrl,
        accessToken,
      );
      if (email.outcome !== "success") {
        return email;
      }

      return {
        identity: {
          displayName: user.displayName,
          email: email.email,
          emailVerified: true,
          provider: "github",
          subject: user.subject,
        },
        outcome: "success",
      };
    },
  };
}

function parseDeviceStartResponse(body: GitHubDeviceStartResponse):
  | {
      deviceCode: string;
      expiresInSeconds: number;
      intervalSeconds: number;
      userCode: string;
      verificationUri: string;
    }
  | null {
  const expiresIn = body.expires_in;
  const interval = body.interval;
  if (
    typeof body.device_code !== "string" ||
    typeof body.user_code !== "string" ||
    typeof body.verification_uri !== "string" ||
    typeof expiresIn !== "number" ||
    !Number.isInteger(expiresIn) ||
    typeof interval !== "number" ||
    !Number.isInteger(interval)
  ) {
    return null;
  }

  return {
    deviceCode: body.device_code,
    expiresInSeconds: expiresIn,
    intervalSeconds: interval,
    userCode: body.user_code,
    verificationUri: body.verification_uri,
  };
}

function parsePollState(
  body: GitHubTokenResponse,
  currentIntervalSeconds: number,
): OAuthDevicePollResult | null {
  if (body.error === "authorization_pending") {
    return {
      intervalSeconds: currentIntervalSeconds,
      outcome: "authorization_pending",
    };
  }

  if (body.error === "slow_down") {
    return {
      intervalSeconds:
        typeof body.interval === "number" && Number.isInteger(body.interval)
          ? body.interval
          : currentIntervalSeconds + 5,
      outcome: "slow_down",
    };
  }

  if (body.error === "expired_token") {
    return {
      outcome: "expired_token",
    };
  }

  if (body.error === "access_denied") {
    return {
      outcome: "access_denied",
    };
  }

  if (typeof body.error === "string") {
    return providerError(`GitHub device poll failed: ${body.error}`);
  }

  return null;
}
