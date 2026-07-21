// Web OAuth flow glue: runtime provider config, the provider
// authorize redirect (PKCE + state via auth/pkce), the /auth/callback code
// exchange, and best-effort logout. Framework-free — AuthProvider and the
// login/callback pages consume these helpers and never touch fetch.
//
// Web-config 404 contract: an unconfigured server answers
// `GET /v1/auth/oauth/web-config` with a 404 problem typed `about:blank`.
// `fetchWebConfig` lets the typed HttpProblemError propagate; the login page
// classifies it with the `webConfigRequest` flag (`classifyWebConfigError`)
// so the 404 maps to `configuration-error`, not resource `not-found`.

import { request } from "../api/client";
import { classifyProblem, HttpProblemError } from "../api/problem";
import {
  fromOAuthWebConfigWire,
  fromSessionWire,
  toOAuthCallbackWireBody,
  toOAuthRefreshWireBody,
  type OAuthWebConfigWire,
  type SessionWireResponse,
} from "../api/wire";
import { clearSession, getRefreshToken, setSession } from "./credentialStore";
import {
  consumePkce,
  createCodeChallenge,
  generateCodeVerifier,
  generateState,
  stashPkce,
} from "./pkce";
import type { ProblemBehavior } from "../api/problem";
import type {
  OAuthCallbackBody,
  OAuthRefreshBody,
  OAuthWebConfig,
  OAuthWebConfigProvider,
  SessionUser,
} from "../api/types";

/**
 * Web-config `mode` value reported by the local evaluation stack. The login
 * page relabels, the app shell shows the persistent banner, and the local
 * consent route only renders when this matches (inert everywhere else).
 */
export const LOCAL_DEV_MODE = "local-dev";

export function isLocalDevMode(config: OAuthWebConfig): boolean {
  return config.mode === LOCAL_DEV_MODE;
}

/**
 * `GET /v1/auth/oauth/web-config` (public, no bearer). Errors propagate as
 * HttpProblemError for the login page to classify (`classifyWebConfigError`);
 * caching the config for the session is the caller's concern.
 */
export function fetchWebConfig(): Promise<OAuthWebConfig> {
  return request<OAuthWebConfigWire>({
    method: "GET",
    path: "/auth/oauth/web-config",
  }).then(fromOAuthWebConfigWire);
}

/**
 * `classifyProblem` bound to the web-config contract: the suffix-less 404
 * becomes `configuration-error` (web OAuth unconfigured) instead of
 * resource `not-found`.
 */
export function classifyWebConfigError(
  error: HttpProblemError,
): ProblemBehavior {
  return classifyProblem(error, { webConfigRequest: true });
}

export interface AuthorizeUrlParams {
  state: string;
  codeChallenge: string;
}

/**
 * Authorize URL for one provider entry (S256 challenge; client_id/scope from
 * the entry). The entry's `authorizeEndpoint` is used verbatim — an absolute
 * URL for external providers, a same-origin absolute path in local-dev mode —
 * and the per-flow query is appended. The `scope` param is omitted when the
 * entry's `scopes` is empty (Bitbucket: scopes live on the OAuth consumer).
 */
export function buildAuthorizeUrl(
  provider: OAuthWebConfigProvider,
  { state, codeChallenge }: AuthorizeUrlParams,
): string {
  const endpoint = provider.authorizeEndpoint.replace(/\/+$/, "");
  const query = new URLSearchParams({
    client_id: provider.clientId,
    // REQUIRED by the OAuth 2.0 spec (and enforced by Bitbucket); GitHub
    // merely tolerates its absence.
    response_type: "code",
    ...(provider.scopes === "" ? {} : { scope: provider.scopes }),
    redirect_uri: callbackRedirectUri(),
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  });
  return `${endpoint}?${query.toString()}`;
}

/**
 * Generates the PKCE verifier + CSRF state, stashes them (with the optional
 * in-app `returnTo`) for the callback, and returns the authorize URL — the
 * caller assigns it to `window.location.href`.
 */
export async function startLogin(
  provider: OAuthWebConfigProvider,
  returnTo?: string,
): Promise<string> {
  const codeVerifier = generateCodeVerifier();
  const state = generateState();
  const codeChallenge = await createCodeChallenge(codeVerifier);
  stashPkce({
    state,
    codeVerifier,
    // The provider that built this authorize URL travels with the flow; the
    // callback echoes it into the exchange body (web-config isn't cached
    // across the full-page authorize redirect).
    provider: provider.provider,
    ...(returnTo !== undefined ? { returnTo } : {}),
  });
  return buildAuthorizeUrl(provider, { state, codeChallenge });
}

/**
 * Missing/corrupt/mismatched PKCE stash on the callback (edge case).
 * The callback page maps this to "Invalid sign-in state, try again."
 */
export class InvalidSignInStateError extends Error {
  constructor() {
    super("Invalid sign-in state, try again");
    this.name = "InvalidSignInStateError";
  }
}

/**
 * A callback-exchange problem enriched with the flow's provider (from the
 * PKCE stash) so the callback page can render provider-aware copy — the
 * HttpProblemError itself has no way to know which button started the flow.
 */
export class CallbackProblemError extends Error {
  readonly problem: HttpProblemError;
  readonly provider: string;

  constructor(problem: HttpProblemError, provider: string) {
    super(problem.message);
    this.name = "CallbackProblemError";
    this.problem = problem;
    this.provider = provider;
  }
}

/** "github" → "GitHub"; unknown providers get a capitalized fallback. */
export function providerDisplayName(provider: string): string {
  switch (provider) {
    case "github":
      return "GitHub";
    case "bitbucket":
      return "Bitbucket";
    case LOCAL_DEV_MODE:
      return "Local";
    default:
      return provider.charAt(0).toUpperCase() + provider.slice(1);
  }
}

export interface CallbackExchangeInput {
  code: string;
  state: string;
}

export interface CallbackExchangeResult {
  user: SessionUser;
  /** In-app path stashed by `startLogin`; the callback page routes there (default `/`). */
  returnTo?: string;
}

/**
 * `POST /v1/auth/oauth/callback` (public): validates `state` against the
 * single-use PKCE stash (consumed even on failure — a verifier is never
 * replayable), exchanges the code, installs the session, and returns the
 * signed-in user plus the stashed `returnTo`. Exchange problems
 * (401/403/409/501/503) propagate as CallbackProblemError (the underlying
 * HttpProblemError plus the flow's provider for provider-aware copy).
 */
export async function exchangeCallback({
  code,
  state,
}: CallbackExchangeInput): Promise<CallbackExchangeResult> {
  const pkce = consumePkce(state);
  if (pkce === null) {
    throw new InvalidSignInStateError();
  }

  // Stashed by startLogin from the provider entry that started this flow;
  // pre-provider stashes (in-flight during an upgrade) default to github.
  const provider = pkce.provider ?? "github";
  let payload;
  try {
    payload = await request<SessionWireResponse>({
      method: "POST",
      path: "/auth/oauth/callback",
      body: toOAuthCallbackWireBody({
        provider,
        code,
        redirectUri: callbackRedirectUri(),
        codeVerifier: pkce.codeVerifier,
      } satisfies OAuthCallbackBody),
    }).then(fromSessionWire);
  } catch (error) {
    if (error instanceof HttpProblemError) {
      throw new CallbackProblemError(error, provider);
    }
    throw error;
  }

  setSession(payload);

  return pkce.returnTo !== undefined
    ? { user: payload.user, returnTo: pkce.returnTo }
    : { user: payload.user };
}

/**
 * Best-effort revoke: `POST /v1/auth/logout` with the stored
 * refresh token, swallowing every server/network error — the local session
 * is ALWAYS cleared, even when the server already invalidated the token.
 */
export async function logoutSession(): Promise<void> {
  const refreshToken = getRefreshToken();

  try {
    if (refreshToken !== null) {
      await request<void>({
        method: "POST",
        path: "/auth/logout",
        body: toOAuthRefreshWireBody({
          refreshToken: refreshToken.token,
        } satisfies OAuthRefreshBody),
      });
    }
  } catch {
    // Server-side revoke is advisory only; local sign-out proceeds.
  } finally {
    clearSession();
  }
}

/**
 * The callback redirect URI is always `<origin>/auth/callback`. Exported as
 * the single source of the value: the local consent page validates the
 * incoming `redirect_uri` against exactly what `buildAuthorizeUrl` sends.
 */
export function callbackRedirectUri(): string {
  return `${window.location.origin}/auth/callback`;
}
