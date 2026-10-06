// `login` and `logout`, ported from cli/src/commands/auth.ts (@codemagic/patch-cli
// 0.4.0): the same browser flow (RFC 8252 loopback redirect + PKCE), the same token
// login and the same endpoints — but a credential file of this CLI's own, so the two
// CLIs sign in and out independently. What is not here is `cmpatch`'s interactive layer: no
// "browser or token?" menu and no hidden token prompt (both come from a prompt
// library this CLI does not carry), and plain progress lines instead of a spinner.
// `login` signs in through the browser unless --token is given.
// See cli-capacitor-tech-spec › Provenance.

import {
  assertHttpUrl,
  buildApiUrl,
  buildApiUrlWithQuery,
  normalizeBearerToken,
  resolveServerUrl,
  TOKEN_ENV,
} from "./api";
import { CLI_NAME, PRODUCT_NAME } from "./branding";
import { openBrowser } from "./browserOpen";
import {
  loadStoredCredential,
  removeStoredCredential,
  saveStoredCredential,
  type StoredCredential,
} from "./credentials";
import type { CliDeps } from "./deps";
import { ValidationError } from "./errors";
import { request } from "./http";
import { generateLoginPkceMaterial } from "./loginPkce";
import { startLoopbackLoginServer } from "./loopbackLoginServer";
import { isRecord, writeLine } from "./output";
import { HttpProblemError } from "./problem-details";

/**
 * Wait budget for the whole browser round-trip (open → sign in → approve →
 * loopback redirect); `--timeout-seconds` overrides it.
 */
const DEFAULT_BROWSER_LOGIN_TIMEOUT_SECONDS = 300;

export interface LoginCommand {
  noBrowser: boolean;
  serverUrl?: string;
  timeoutSeconds?: number;
  token?: string;
}

export interface LogoutCommand {
  serverUrl?: string;
}

export async function executeLogin(
  command: LoginCommand,
  deps: CliDeps,
): Promise<void> {
  const serverUrl = resolveServerUrl(command.serverUrl, deps.env);

  const credential =
    command.token !== undefined
      ? await executeTokenLogin(serverUrl, command.token, deps)
      : await executeBrowserLoginOrExplain(serverUrl, command, deps);

  writeLine(
    deps.stdout,
    `Logged in to ${serverUrl} as ${credential.user.email} (${credential.user.id})`,
  );

  // The environment token outranks the stored sign-in on every command, so a
  // sign-in made while it is set changes nothing until it is unset.
  if ((deps.env[TOKEN_ENV] ?? "").trim().length > 0) {
    writeLine(
      deps.stderr,
      `Note: ${TOKEN_ENV} is set and takes precedence over this sign-in. Unset it to use the stored credentials.`,
    );
  }
}

async function executeBrowserLoginOrExplain(
  serverUrl: string,
  command: LoginCommand,
  deps: CliDeps,
): Promise<StoredCredential> {
  // Only the probe decides "no browser sign-in here". A 404 from the exchange, after a
  // sign-in the server plainly offered, means the code expired or was already used —
  // sending the user off to make a token for that would be wrong.
  let dashboardOrigin: string | undefined;
  try {
    ({ dashboardOrigin } = await probeBrowserLoginSupport(serverUrl, deps));
  } catch (error) {
    if (!isBrowserLoginUnsupported(error)) {
      throw error;
    }

    throw new ValidationError(
      `This server does not support browser sign-in. Re-run with \`${CLI_NAME} login --server-url ${serverUrl} --token <token>\`.`,
    );
  }

  return executeBrowserLogin(serverUrl, dashboardOrigin, command, deps);
}

/**
 * Loopback browser login (RFC 8252): probe that the server offers browser
 * sign-in at all, start the 127.0.0.1 listener, open the dashboard's
 * /cli/authorize approve page, then exchange the redirected short-lived code
 * (PKCE-bound) for the same session shape the web callback returns.
 */
async function executeBrowserLogin(
  serverUrl: string,
  dashboardOrigin: string | undefined,
  command: LoginCommand,
  deps: CliDeps,
): Promise<StoredCredential> {
  const pkce = generateLoginPkceMaterial();
  const server = await (deps.startLoopbackLoginServer ??
    startLoopbackLoginServer)({
    expectedState: pkce.state,
  });

  try {
    const authorizeUrl = buildApiUrlWithQuery(
      dashboardOrigin ?? serverUrl,
      "/cli/authorize",
      {
        code_challenge: pkce.codeChallenge,
        port: server.port,
        state: pkce.state,
      },
    );
    // The callback wait (and its deadline) starts BEFORE the browser opener:
    // openers are not guaranteed to exit promptly (xdg-open can block until
    // the browser closes), so a hung opener must neither stall a completed
    // sign-in nor escape the --timeout-seconds budget.
    const timeoutSeconds =
      command.timeoutSeconds ?? DEFAULT_BROWSER_LOGIN_TIMEOUT_SECONDS;
    const callbackPromise = server.waitForCallback(timeoutSeconds * 1000);
    const opened = command.noBrowser
      ? false
      : await Promise.race([
          (deps.openBrowser ?? openBrowser)(authorizeUrl),
          callbackPromise.then(() => true),
        ]);

    writeLine(deps.stderr, renderAuthorizationInstructions(opened, authorizeUrl));
    writeLine(
      deps.stderr,
      `Waiting for browser sign-in (times out after ${timeoutSeconds}s)`,
    );
    const callback = await callbackPromise;

    if (callback.kind === "timeout") {
      throw new ValidationError(
        `Timed out after ${timeoutSeconds}s waiting for the browser sign-in. Re-run \`${CLI_NAME} login\` (--timeout-seconds to wait longer), or use \`${CLI_NAME} login --token <token>\`.`,
      );
    }

    if (callback.kind === "denied") {
      throw new ValidationError("Browser sign-in was denied.");
    }

    const session = parseSessionResponse(
      await request(
        deps.fetch,
        buildApiUrl(serverUrl, "/v1/auth/oauth/cli/exchange"),
        {
          body: JSON.stringify({
            code: callback.code,
            code_verifier: pkce.codeVerifier,
          }),
          headers: {
            "content-type": "application/json",
          },
          method: "POST",
        },
      ),
    );
    await saveStoredCredential(serverUrl, session, { env: deps.env });
    return session;
  } finally {
    await server.close();
  }
}

async function probeBrowserLoginSupport(
  serverUrl: string,
  deps: CliDeps,
): Promise<{ dashboardOrigin?: string }> {
  // Asked before a browser is opened: on a server with web OAuth unconfigured the
  // sign-in page the approve flow needs would be dead anyway. The 404 it answers
  // here is an HttpProblemError, which the caller turns into the --token advice;
  // other failures (network, 5xx) surface as themselves.
  const config = await request(
    deps.fetch,
    buildApiUrl(serverUrl, "/v1/auth/oauth/web-config"),
    { method: "GET" },
  );

  // The dashboard usually shares the server origin; stacks that serve it
  // elsewhere (local-dev's separate dashboard container) advertise the origin
  // to open /cli/authorize on.
  const dashboardOrigin =
    isRecord(config) && typeof config.dashboard_origin === "string"
      ? config.dashboard_origin.trim()
      : "";

  return dashboardOrigin.length > 0
    ? { dashboardOrigin: assertHttpUrl(dashboardOrigin, "Dashboard URL") }
    : {};
}

/**
 * "No browser sign-in here": web OAuth unconfigured — the web-config contract
 * answers 404 (501 on a server that predates it).
 */
function isBrowserLoginUnsupported(error: unknown): boolean {
  return (
    error instanceof HttpProblemError &&
    (error.responseStatus === 501 || error.responseStatus === 404)
  );
}

async function executeTokenLogin(
  serverUrl: string,
  token: string,
  deps: CliDeps,
): Promise<StoredCredential> {
  const normalizedToken = normalizeBearerToken(token);
  // Looked up before anything is stored: a token the server rejects must not
  // become the stored credential.
  const user = parseUserProfileResponse(
    await request(deps.fetch, buildApiUrl(serverUrl, "/v1/users/me"), {
      headers: {
        authorization: `Bearer ${normalizedToken}`,
      },
      method: "GET",
    }),
  );
  const credential: StoredCredential = {
    accessToken: normalizedToken,
    kind: "token",
    user,
  };
  await saveStoredCredential(serverUrl, credential, { env: deps.env });
  return credential;
}

export async function executeLogout(
  command: LogoutCommand,
  deps: CliDeps,
): Promise<void> {
  const serverUrl = resolveServerUrl(command.serverUrl, deps.env);
  const stored = await loadStoredCredential(serverUrl, { env: deps.env });

  if (!stored) {
    writeLine(deps.stdout, `No stored ${PRODUCT_NAME} credentials found for ${serverUrl}`);
    return;
  }

  // Token logins persist a personal access token with no refresh token to revoke,
  // so logout only clears the local credential.
  if (stored.kind === "token") {
    await removeStoredCredential(serverUrl, { env: deps.env });
    writeLine(deps.stdout, `Logged out ${stored.user.email} (${stored.user.id})`);
    return;
  }

  let revocationError: unknown;

  try {
    await request(deps.fetch, buildApiUrl(serverUrl, "/v1/auth/logout"), {
      body: JSON.stringify({ refresh_token: stored.refreshToken }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });
  } catch (error) {
    // Already invalid server-side is as logged out as it gets.
    if (!(error instanceof HttpProblemError && error.responseStatus === 401)) {
      revocationError = error;
    }
  } finally {
    // Cleared even when the revocation failed: the point of logging out of
    // this machine is that the credential is no longer on it.
    await removeStoredCredential(serverUrl, { env: deps.env });
  }

  if (revocationError) {
    throw revocationError;
  }

  writeLine(deps.stdout, `Logged out ${stored.user.email} (${stored.user.id})`);
}

function parseSessionResponse(value: unknown): StoredCredential {
  if (!isRecord(value)) {
    throw new Error("CLI login exchange returned an invalid response");
  }

  const user = value.user;
  if (
    isNonEmptyString(value.access_token) &&
    isNonEmptyString(value.access_token_expires_at) &&
    isNonEmptyString(value.refresh_token) &&
    isNonEmptyString(value.refresh_token_expires_at) &&
    isRecord(user) &&
    (user.display_name === null || typeof user.display_name === "string") &&
    isNonEmptyString(user.email) &&
    isNonEmptyString(user.id)
  ) {
    return {
      accessToken: value.access_token,
      accessTokenExpiresAt: value.access_token_expires_at,
      kind: "oauth",
      refreshToken: value.refresh_token,
      refreshTokenExpiresAt: value.refresh_token_expires_at,
      user: {
        displayName: user.display_name,
        email: user.email,
        id: user.id,
      },
    };
  }

  throw new Error("CLI login exchange returned an invalid response");
}

function parseUserProfileResponse(value: unknown): StoredCredential["user"] {
  if (!isRecord(value)) {
    throw new Error("User profile lookup returned an invalid response");
  }

  const user = value.user;
  if (
    isRecord(user) &&
    (user.display_name === null || typeof user.display_name === "string") &&
    isNonEmptyString(user.email) &&
    isNonEmptyString(user.id)
  ) {
    return {
      displayName: user.display_name,
      email: user.email,
      id: user.id,
    };
  }

  throw new Error("User profile lookup returned an invalid response");
}

function renderAuthorizationInstructions(
  browserOpened: boolean,
  authorizeUrl: string,
): string {
  if (browserOpened) {
    return [
      "Complete the sign-in in your browser.",
      `If it did not open, visit: ${authorizeUrl}`,
    ].join("\n");
  }

  return [
    "Open this URL in a browser on this machine to sign in:",
    authorizeUrl,
    `No browser here (SSH/CI)? Use \`${CLI_NAME} login --token <token>\` with a personal access token instead.`,
  ].join("\n");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
