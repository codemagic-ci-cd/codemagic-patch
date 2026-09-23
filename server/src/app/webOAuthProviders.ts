import type { AuthNAdapter } from "./authNAdapter";
import { createBitbucketAuthNAdapter } from "./bitbucketAuthNAdapter";
import {
  DEFAULT_BITBUCKET_API_BASE_URL,
  DEFAULT_BITBUCKET_OAUTH_BASE_URL,
} from "./bitbucketApi";
import { createGitHubAuthNAdapter } from "./githubAuthNAdapter";
import {
  DEFAULT_GITHUB_API_BASE_URL,
  DEFAULT_GITHUB_OAUTH_BASE_URL,
} from "./githubApi";
import { createGitlabAuthNAdapter } from "./gitlabAuthNAdapter";
import {
  DEFAULT_GITLAB_OAUTH_BASE_URL,
  defaultGitlabApiBaseUrl,
} from "./gitlabApi";

export type WebOAuthProviderId = "github" | "bitbucket" | "gitlab";

/**
 * One configured web (authorization-code) sign-in provider. `clientSecret`
 * is always present: every provider is web-flow only, so a secret-less
 * config could serve nothing and env parsing fails fast without one.
 */
export interface WebOAuthProviderConfig {
  allowedRedirectUris?: string[];
  apiBaseUrl: string;
  clientId: string;
  clientSecret: string;
  oauthBaseUrl: string;
  provider: WebOAuthProviderId;
  /** "" = no authorize-URL scope param (e.g. Bitbucket: consumer-side scopes). */
  scopes: string;
}

/**
 * Everything the runtime needs to know about a provider beyond its adapter:
 * which env variables configure it and the defaults behind them. Adding a
 * provider is one entry here plus its adapter module.
 */
export interface WebOAuthProviderDescriptor {
  /**
   * Builds the adapter for a resolved config. Adapters differ in token
   * endpoint, client authentication and email resolution, so they stay
   * per provider.
   */
  createAdapter: (config: WebOAuthProviderConfig) => AuthNAdapter;
  /** Appended to `oauthBaseUrl` to form the web-config authorize endpoint. */
  authorizePath: string;
  /** REST origin default, derived from the (trimmed) OAuth base URL. */
  defaultApiBaseUrl: (oauthBaseUrl: string) => string;
  defaultOAuthBaseUrl: string;
  /**
   * Default authorize-URL scopes. Undefined = scopes are not configurable
   * (no `<PREFIX>_OAUTH_SCOPES`) and the authorize URL carries none.
   */
  defaultScopes?: string;
  /**
   * Env variable prefix: `<PREFIX>_OAUTH_CLIENT_ID`, `_OAUTH_CLIENT_SECRET`,
   * `_OAUTH_BASE_URL`, `_OAUTH_SCOPES`, `_OAUTH_ALLOWED_REDIRECT_URIS` and
   * `<PREFIX>_API_BASE_URL`.
   */
  envPrefix: string;
  provider: WebOAuthProviderId;
}

/** Registration order is the dashboard login-button order. */
export const WEB_OAUTH_PROVIDERS: readonly WebOAuthProviderDescriptor[] = [
  {
    authorizePath: "/login/oauth/authorize",
    createAdapter: createGitHubAuthNAdapter,
    defaultApiBaseUrl: () => DEFAULT_GITHUB_API_BASE_URL,
    defaultOAuthBaseUrl: DEFAULT_GITHUB_OAUTH_BASE_URL,
    defaultScopes: "read:user user:email",
    envPrefix: "GITHUB",
    provider: "github",
  },
  {
    authorizePath: "/site/oauth2/authorize",
    createAdapter: createBitbucketAuthNAdapter,
    defaultApiBaseUrl: () => DEFAULT_BITBUCKET_API_BASE_URL,
    defaultOAuthBaseUrl: DEFAULT_BITBUCKET_OAUTH_BASE_URL,
    // Bitbucket scopes live on the OAuth consumer, not the authorize URL.
    envPrefix: "BITBUCKET",
    provider: "bitbucket",
  },
  {
    authorizePath: "/oauth/authorize",
    createAdapter: createGitlabAuthNAdapter,
    // Self-hosted GitLab works with a single variable: the REST origin
    // follows the OAuth base URL unless GITLAB_API_BASE_URL overrides it.
    defaultApiBaseUrl: defaultGitlabApiBaseUrl,
    defaultOAuthBaseUrl: DEFAULT_GITLAB_OAUTH_BASE_URL,
    defaultScopes: "read_user",
    envPrefix: "GITLAB",
    provider: "gitlab",
  },
];

export function webOAuthProviderDescriptor(
  provider: WebOAuthProviderId,
): WebOAuthProviderDescriptor {
  const descriptor = WEB_OAUTH_PROVIDERS.find(
    (candidate) => candidate.provider === provider,
  );
  if (!descriptor) {
    throw new Error(`unknown web OAuth provider: ${provider}`);
  }

  return descriptor;
}
