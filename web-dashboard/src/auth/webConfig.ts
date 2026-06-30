// Web OAuth flow glue: runtime provider config, the GitHub
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
import { classifyProblem } from "../api/problem";
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
import type { HttpProblemError, ProblemBehavior } from "../api/problem";
import type {
  OAuthCallbackBody,
  OAuthRefreshBody,
  OAuthWebConfig,
  SessionUser,
} from "../api/types";

/** Production authorize origin; `VITE_OAUTH_AUTHORIZE_BASE_URL` overrides it for dev/E2E mocks only. */
const DEFAULT_AUTHORIZE_BASE_URL = "https://github.com";

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

/** GitHub authorize URL (S256 challenge; client_id/scope from web-config). */
export function buildAuthorizeUrl(
  config: OAuthWebConfig,
  { state, codeChallenge }: AuthorizeUrlParams,
): string {
  const base = (
    import.meta.env.VITE_OAUTH_AUTHORIZE_BASE_URL ?? DEFAULT_AUTHORIZE_BASE_URL
  ).replace(/\/+$/, "");
  const query = new URLSearchParams({
    client_id: config.clientId,
    scope: config.scopes,
    redirect_uri: callbackRedirectUri(),
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  });
  return `${base}/login/oauth/authorize?${query.toString()}`;
}

/**
 * Generates the PKCE verifier + CSRF state, stashes them (with the optional
 * in-app `returnTo`) for the callback, and returns the authorize URL — the
 * caller assigns it to `window.location.href`.
 */
export async function startLogin(
  config: OAuthWebConfig,
  returnTo?: string,
): Promise<string> {
  const codeVerifier = generateCodeVerifier();
  const state = generateState();
  const codeChallenge = await createCodeChallenge(codeVerifier);
  stashPkce({
    state,
    codeVerifier,
    ...(returnTo !== undefined ? { returnTo } : {}),
  });
  return buildAuthorizeUrl(config, { state, codeChallenge });
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
 * (401/403/409/501/503) propagate as HttpProblemError.
 */
export async function exchangeCallback({
  code,
  state,
}: CallbackExchangeInput): Promise<CallbackExchangeResult> {
  const pkce = consumePkce(state);
  if (pkce === null) {
    throw new InvalidSignInStateError();
  }

  const payload = await request<SessionWireResponse>({
    method: "POST",
    path: "/auth/oauth/callback",
    body: toOAuthCallbackWireBody({
      provider: "github",
      code,
      redirectUri: callbackRedirectUri(),
      codeVerifier: pkce.codeVerifier,
    } satisfies OAuthCallbackBody),
  }).then(fromSessionWire);

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

/** The callback redirect URI is always `<origin>/auth/callback`. */
function callbackRedirectUri(): string {
  return `${window.location.origin}/auth/callback`;
}
