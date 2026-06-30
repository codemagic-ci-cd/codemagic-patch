import type { AuthNAdapter } from "./authNAdapter";
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

export interface CreateGitHubAuthNAdapterOptions {
  allowedRedirectUris?: string[];
  apiBaseUrl?: string;
  clientId: string;
  clientSecret: string;
  fetch?: typeof globalThis.fetch;
  oauthBaseUrl?: string;
}

interface GitHubTokenResponse {
  access_token?: unknown;
  error?: unknown;
  scope?: unknown;
  token_type?: unknown;
}

export function createGitHubAuthNAdapter(
  options: CreateGitHubAuthNAdapterOptions,
): AuthNAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const oauthBaseUrl = trimTrailingSlash(
    options.oauthBaseUrl ?? DEFAULT_GITHUB_OAUTH_BASE_URL,
  );
  const apiBaseUrl = trimTrailingSlash(
    options.apiBaseUrl ?? DEFAULT_GITHUB_API_BASE_URL,
  );
  const allowedRedirectUris = options.allowedRedirectUris ?? [];

  return {
    async exchangeCode(input) {
      if (input.provider !== "github") {
        return {
          outcome: "unknown_provider",
        };
      }

      if (
        allowedRedirectUris.length > 0 &&
        !allowedRedirectUris.includes(input.redirectUri)
      ) {
        return {
          outcome: "invalid_grant",
        };
      }

      const tokenResponse = await postForm(
        fetchImpl,
        `${oauthBaseUrl}/login/oauth/access_token`,
        {
          client_id: options.clientId,
          client_secret: options.clientSecret,
          code: input.code,
          code_verifier: input.codeVerifier,
          redirect_uri: input.redirectUri,
        },
      );
      if (!tokenResponse.ok) {
        return providerError(
          `GitHub code exchange failed with HTTP ${tokenResponse.status}`,
        );
      }

      const tokenBody = await readJsonObject<GitHubTokenResponse>(tokenResponse);
      if (!tokenBody) {
        return providerError("GitHub code exchange returned invalid JSON");
      }

      if (tokenBody.error === "bad_verification_code") {
        return {
          outcome: "invalid_grant",
        };
      }

      if (typeof tokenBody.error === "string") {
        return providerError(`GitHub code exchange failed: ${tokenBody.error}`);
      }

      const accessToken =
        typeof tokenBody.access_token === "string"
          ? tokenBody.access_token
          : undefined;
      if (!accessToken) {
        return providerError("GitHub code exchange returned no access token");
      }

      if (!hasScope(tokenBody.scope, "user:email")) {
        return providerError(
          "GitHub access token is missing the user:email scope",
        );
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
      if (email.outcome === "email_scope_required") {
        return providerError(
          "GitHub denied email access despite the user:email scope",
        );
      }
      if (email.outcome === "verified_email_required") {
        return providerError(
          "GitHub account has no verified primary email address",
        );
      }
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
