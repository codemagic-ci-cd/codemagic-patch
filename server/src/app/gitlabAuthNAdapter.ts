import type { AuthNAdapter } from "./authNAdapter";
import {
  DEFAULT_GITLAB_OAUTH_BASE_URL,
  defaultGitlabApiBaseUrl,
  fetchGitlabUser,
  fetchGitlabVerifiedPrimaryEmail,
  hasGitlabReadUserScope,
} from "./gitlabApi";
import {
  postForm,
  providerError,
  readJsonObject,
  trimTrailingSlash,
} from "./githubApi";

export interface CreateGitlabAuthNAdapterOptions {
  apiBaseUrl?: string;
  clientId: string;
  clientSecret: string;
  fetch?: typeof globalThis.fetch;
  oauthBaseUrl?: string;
}

interface GitlabTokenResponse {
  access_token?: unknown;
  error?: unknown;
  error_description?: unknown;
  scope?: unknown;
}

/**
 * Web (authorization-code) sign-in against GitLab (gitlab.com or
 * self-hosted). Redirect-URI allowlisting lives in the dispatching registry
 * (authNAdapterRegistry); this adapter keeps only the provider guard as
 * defense in depth.
 */
export function createGitlabAuthNAdapter(
  options: CreateGitlabAuthNAdapterOptions,
): AuthNAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const oauthBaseUrl = trimTrailingSlash(
    options.oauthBaseUrl ?? DEFAULT_GITLAB_OAUTH_BASE_URL,
  );
  const apiBaseUrl = trimTrailingSlash(
    options.apiBaseUrl ?? defaultGitlabApiBaseUrl(oauthBaseUrl),
  );

  return {
    async exchangeCode(input) {
      if (input.provider !== "gitlab") {
        return {
          outcome: "unknown_provider",
        };
      }

      const tokenResponse = await postForm(
        fetchImpl,
        `${oauthBaseUrl}/oauth/token`,
        {
          client_id: options.clientId,
          client_secret: options.clientSecret,
          code: input.code,
          code_verifier: input.codeVerifier,
          grant_type: "authorization_code",
          redirect_uri: input.redirectUri,
        },
      );

      // GitLab reports grant failures as HTTP 400/401 with an `error` body
      // (unlike GitHub's 200 + error). Read the body before keying on status.
      const tokenBody =
        await readJsonObject<GitlabTokenResponse>(tokenResponse);

      if (tokenBody?.error === "invalid_grant") {
        return {
          outcome: "invalid_grant",
        };
      }

      if (typeof tokenBody?.error === "string") {
        const description =
          typeof tokenBody.error_description === "string" &&
          tokenBody.error_description.length > 0
            ? `: ${tokenBody.error_description}`
            : "";
        return providerError(
          `GitLab code exchange failed: ${tokenBody.error}${description}`,
        );
      }

      if (!tokenResponse.ok) {
        return providerError(
          `GitLab code exchange failed with HTTP ${tokenResponse.status}`,
        );
      }

      if (!tokenBody) {
        return providerError("GitLab code exchange returned invalid JSON");
      }

      const accessToken =
        typeof tokenBody.access_token === "string"
          ? tokenBody.access_token
          : undefined;
      if (!accessToken) {
        return providerError("GitLab code exchange returned no access token");
      }

      if (
        typeof tokenBody.scope === "string" &&
        !hasGitlabReadUserScope(tokenBody.scope)
      ) {
        return providerError(
          "GitLab access token is missing the read_user scope — add it to the GitLab application",
        );
      }

      const user = await fetchGitlabUser(fetchImpl, apiBaseUrl, accessToken);
      if (user.outcome !== "success") {
        return user;
      }

      const email = await fetchGitlabVerifiedPrimaryEmail(
        fetchImpl,
        apiBaseUrl,
        accessToken,
        { email: user.email, confirmed: user.emailConfirmed },
      );
      if (email.outcome === "email_scope_required") {
        return providerError(
          "GitLab denied email access despite the read_user scope",
        );
      }
      if (email.outcome === "verified_email_required") {
        return {
          outcome: "verified_email_required",
        };
      }
      if (email.outcome !== "success") {
        return email;
      }

      return {
        identity: {
          displayName: user.displayName,
          email: email.email,
          emailVerified: true,
          provider: "gitlab",
          subject: user.subject,
        },
        outcome: "success",
      };
    },
  };
}
