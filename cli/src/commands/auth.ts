import type { LoginCommand, LogoutCommand } from "../commandTypes";
import { PRODUCT_NAME } from "../branding";
import { openBrowser } from "../browserOpen";
import {
  loadStoredCredential,
  removeStoredCredential,
  saveStoredCredential,
  type StoredCredential,
} from "../credentialStore";
import { generateLoginPkceMaterial } from "../loginPkce";
import { startLoopbackLoginServer } from "../loopbackLoginServer";
import { request } from "../http";
import { isRecord } from "../output";
import { HttpProblemError } from "../problem-details";
import type { PromptFn } from "../prompt";
import {
  assertHttpUrl,
  buildApiUrl,
  buildApiUrlWithQuery,
  canPromptInteractively,
  normalizeBearerToken,
  ValidationError,
  type CommandDeps,
} from "./shared";

/**
 * Wait budget for the whole browser round-trip (open → sign in → approve →
 * loopback redirect); `--timeout-seconds` overrides it.
 */
const DEFAULT_BROWSER_LOGIN_TIMEOUT_SECONDS = 300;

export interface LoginOutput {
  writeAuthorizationInstructions?: (message: string) => void;
}

export async function executeLogin(
  command: LoginCommand,
  deps: CommandDeps,
  output: LoginOutput = {},
): Promise<string> {
  command.serverUrl = assertHttpUrl(command.serverUrl);

  if (command.token !== undefined) {
    return executeTokenLogin(command, command.token, deps);
  }

  const interactivePrompt = resolveInteractivePrompt(command, deps);

  if (interactivePrompt) {
    const method = await promptAuthMethod(interactivePrompt);
    if (method === "token") {
      return executeTokenLogin(
        command,
        await promptToken(interactivePrompt),
        deps,
      );
    }
  }

  try {
    return await executeBrowserLogin(command, deps, output);
  } catch (error) {
    if (!isBrowserLoginUnsupported(error)) {
      throw error;
    }

    const guidance = "This server does not support browser sign-in.";

    if (interactivePrompt) {
      return executeTokenLogin(
        command,
        await promptToken(
          interactivePrompt,
          `${guidance} Paste a personal access token:`,
        ),
        deps,
      );
    }

    throw new ValidationError(
      `${guidance} Re-run with \`cmpatch login --server-url ${command.serverUrl} --token <token>\`.`,
    );
  }
}

/**
 * Loopback browser login (RFC 8252): probe that the server offers browser
 * sign-in at all, start the 127.0.0.1 listener, open the dashboard's
 * /cli/authorize approve page, then exchange the redirected short-lived code
 * (PKCE-bound) for the same session shape the web callback returns.
 */
async function executeBrowserLogin(
  command: LoginCommand,
  deps: CommandDeps,
  output: LoginOutput,
): Promise<string> {
  // Fail fast (and let the token fallback kick in) before opening a browser
  // when web OAuth is not configured: the web-config contract answers 404
  // there, and the sign-in page the approve flow needs would be dead anyway.
  const { dashboardOrigin } = await probeBrowserLoginSupport(command, deps);

  const pkce = generateLoginPkceMaterial();
  const server = await (deps.startLoopbackLoginServer ??
    startLoopbackLoginServer)({
    expectedState: pkce.state,
  });

  try {
    const authorizeUrl = buildApiUrlWithQuery(
      dashboardOrigin ?? command.serverUrl,
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
    const opened =
      command.noBrowser === true
        ? false
        : await Promise.race([
            (deps.openBrowser ?? openBrowser)(authorizeUrl),
            callbackPromise.then(() => true),
          ]);
    output.writeAuthorizationInstructions?.(
      renderAuthorizationInstructions(opened, authorizeUrl),
    );

    const callback = await callbackPromise;

    if (callback.kind === "timeout") {
      throw new ValidationError(
        `Timed out after ${timeoutSeconds}s waiting for the browser sign-in. Re-run \`cmpatch login\` (--timeout-seconds to wait longer), or use \`cmpatch login --token\`.`,
      );
    }

    if (callback.kind === "denied") {
      throw new ValidationError("Browser sign-in was denied.");
    }

    const session = parseSessionResponse(
      await request(
        deps.fetch,
        buildApiUrl(command.serverUrl, "/v1/auth/oauth/cli/exchange"),
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
    await saveStoredCredential(command.serverUrl, session, { env: deps.env });
    return renderLoginSuccess(session);
  } finally {
    await server.close();
  }
}

async function probeBrowserLoginSupport(
  command: LoginCommand,
  deps: CommandDeps,
): Promise<{ dashboardOrigin?: string }> {
  // The 404 an unconfigured server answers here is an HttpProblemError, which
  // the caller's isBrowserLoginUnsupported check turns into the token
  // fallback; other failures (network, 5xx) surface as themselves.
  const config = await request(
    deps.fetch,
    buildApiUrl(command.serverUrl, "/v1/auth/oauth/web-config"),
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

function resolveInteractivePrompt(
  command: LoginCommand,
  deps: CommandDeps,
): PromptFn | undefined {
  if (!canPromptInteractively(deps, command.nonInteractive === true)) {
    return undefined;
  }

  return deps.prompt;
}

async function promptAuthMethod(prompt: PromptFn): Promise<"browser" | "token"> {
  const value = await prompt({
    choices: [
      { title: "Sign in with your browser", value: "browser" },
      { title: "Paste a personal access token", value: "token" },
    ],
    message: "How would you like to sign in?",
    type: "select",
  });

  return value === "token" ? "token" : "browser";
}

async function promptToken(
  prompt: PromptFn,
  message = "Personal access token",
): Promise<string> {
  const value = await prompt({ message, type: "password" });
  return Array.isArray(value) ? value[0] : value;
}

/**
 * "No browser sign-in here": web OAuth unconfigured (web-config 404 per its
 * contract, or a pre-loopback server answering 404/501 on the exchange
 * route). Triggers the personal-access-token fallback.
 */
function isBrowserLoginUnsupported(error: unknown): boolean {
  return (
    error instanceof HttpProblemError &&
    (error.responseStatus === 501 || error.responseStatus === 404)
  );
}

async function executeTokenLogin(
  command: LoginCommand,
  token: string,
  deps: CommandDeps,
): Promise<string> {
  const normalizedToken = normalizeBearerToken(token);
  const user = parseUserProfileResponse(
    await request(
      deps.fetch,
      buildApiUrl(command.serverUrl, "/v1/users/me"),
      {
        headers: {
          authorization: `Bearer ${normalizedToken}`,
        },
        method: "GET",
      },
    ),
  );
  const credential: StoredCredential = {
    accessToken: normalizedToken,
    kind: "token",
    user,
  };
  await saveStoredCredential(command.serverUrl, credential, { env: deps.env });
  return renderLoginSuccess(credential);
}

export async function executeLogout(
  command: LogoutCommand,
  deps: CommandDeps,
): Promise<string> {
  const stored = await loadStoredCredential(command.serverUrl, { env: deps.env });

  if (!stored) {
    return `No stored ${PRODUCT_NAME} credentials found`;
  }

  // Token logins persist a personal access token with no refresh token to revoke,
  // so logout only clears the local credential.
  if (stored.kind === "token") {
    await removeStoredCredential(command.serverUrl, { env: deps.env });
    return `Logged out ${stored.user.email} (${stored.user.id})`;
  }

  let revocationError: unknown;

  try {
    await request(
      deps.fetch,
      buildApiUrl(command.serverUrl, "/v1/auth/logout"),
      {
        body: JSON.stringify({ refresh_token: stored.refreshToken }),
        headers: {
          "content-type": "application/json",
        },
        method: "POST",
      },
    );
  } catch (error) {
    if (!(error instanceof HttpProblemError && error.responseStatus === 401)) {
      revocationError = error;
    }
  } finally {
    await removeStoredCredential(command.serverUrl, { env: deps.env });
  }

  if (revocationError) {
    throw revocationError;
  }

  return `Logged out ${stored.user.email} (${stored.user.id})`;
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

function renderLoginSuccess(credential: StoredCredential): string {
  return `Logged in as ${credential.user.email} (${credential.user.id})`;
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
    "No browser here (SSH/CI)? Use `cmpatch login --token` with a personal access token instead.",
  ].join("\n");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
