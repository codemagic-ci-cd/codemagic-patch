import type { AuthNAdapter } from "./authNAdapter";
import {
  DEFAULT_BITBUCKET_API_BASE_URL,
  DEFAULT_BITBUCKET_OAUTH_BASE_URL,
  fetchBitbucketUser,
  fetchBitbucketVerifiedPrimaryEmail,
  hasBitbucketEmailScope,
  postFormWithBasicAuth,
} from "./bitbucketApi";
import { providerError, readJsonObject, trimTrailingSlash } from "./githubApi";

export interface CreateBitbucketAuthNAdapterOptions {
  apiBaseUrl?: string;
  clientId: string;
  clientSecret: string;
  fetch?: typeof globalThis.fetch;
  oauthBaseUrl?: string;
}

interface BitbucketTokenResponse {
  access_token?: unknown;
  error?: unknown;
  error_description?: unknown;
  /** Granted-scope report since 2026-05-04 (renamed from `scopes`). */
  scope?: unknown;
  /** Legacy pre-2026-05-04 field name; still read as a fallback. */
  scopes?: unknown;
  token_type?: unknown;
}

/**
 * Web (authorization-code) sign-in against Bitbucket Cloud. Redirect-URI
 * allowlisting lives in the dispatching registry (authNAdapterRegistry); this
 * adapter keeps only the provider guard as defense in depth.
 */
export function createBitbucketAuthNAdapter(
  options: CreateBitbucketAuthNAdapterOptions,
): AuthNAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const oauthBaseUrl = trimTrailingSlash(
    options.oauthBaseUrl ?? DEFAULT_BITBUCKET_OAUTH_BASE_URL,
  );
  const apiBaseUrl = trimTrailingSlash(
    options.apiBaseUrl ?? DEFAULT_BITBUCKET_API_BASE_URL,
  );

  return {
    async exchangeCode(input) {
      if (input.provider !== "bitbucket") {
        return {
          outcome: "unknown_provider",
        };
      }

      // Client auth is HTTP Basic; redirect_uri/code_verifier ride along per
      // RFC 6749/7636 (servers must ignore unrecognized parameters).
      const tokenResponse = await postFormWithBasicAuth(
        fetchImpl,
        `${oauthBaseUrl}/site/oauth2/access_token`,
        {
          clientId: options.clientId,
          clientSecret: options.clientSecret,
        },
        {
          code: input.code,
          code_verifier: input.codeVerifier,
          grant_type: "authorization_code",
          redirect_uri: input.redirectUri,
        },
      );

      // Bitbucket reports grant failures as HTTP 400 with an `error` body
      // (unlike GitHub's 200 + error). Read the body before keying on status.
      const tokenBody =
        await readJsonObject<BitbucketTokenResponse>(tokenResponse);

      if (tokenBody?.error === "invalid_grant") {
        return {
          outcome: "invalid_grant",
        };
      }

      if (typeof tokenBody?.error === "string") {
        return providerError(
          `Bitbucket code exchange failed: ${tokenBody.error}`,
        );
      }

      if (!tokenResponse.ok) {
        return providerError(
          `Bitbucket code exchange failed with HTTP ${tokenResponse.status}`,
        );
      }

      if (!tokenBody) {
        return providerError("Bitbucket code exchange returned invalid JSON");
      }

      const accessToken =
        typeof tokenBody.access_token === "string"
          ? tokenBody.access_token
          : undefined;
      if (!accessToken) {
        return providerError("Bitbucket code exchange returned no access token");
      }

      if (!hasBitbucketEmailScope(tokenBody.scope ?? tokenBody.scopes)) {
        return providerError(
          "Bitbucket access token is missing the email (or account) scope — add it to the OAuth consumer",
        );
      }

      const user = await fetchBitbucketUser(fetchImpl, apiBaseUrl, accessToken);
      if (user.outcome !== "success") {
        return user;
      }

      const email = await fetchBitbucketVerifiedPrimaryEmail(
        fetchImpl,
        apiBaseUrl,
        accessToken,
      );
      if (email.outcome === "email_scope_required") {
        return providerError(
          "Bitbucket denied email access despite the granted scopes",
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
          provider: "bitbucket",
          subject: user.subject,
        },
        outcome: "success",
      };
    },
  };
}
