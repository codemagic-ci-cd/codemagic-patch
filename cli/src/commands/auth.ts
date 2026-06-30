import type { LoginCommand, LogoutCommand } from "../commandTypes";
import { PRODUCT_NAME } from "../branding";
import {
  loadStoredCredential,
  removeStoredCredential,
  saveStoredCredential,
  type StoredCredential,
} from "../credentialStore";
import { request } from "../http";
import { isRecord } from "../output";
import { HttpProblemError } from "../problem-details";
import type { PromptFn } from "../prompt";
import {
  assertHttpUrl,
  buildApiUrl,
  normalizeBearerToken,
  ValidationError,
  type CommandDeps,
} from "./shared";

const GITHUB_PROVIDER = "github";

type DeviceStartResponse = {
  expiresInSeconds: number;
  intervalSeconds: number;
  pollToken: string;
  provider: typeof GITHUB_PROVIDER;
  userCode: string;
  verificationUri: string;
};

type DevicePollResponse =
  | {
      intervalSeconds: number;
      outcome: "authorization_pending" | "slow_down";
    }
  | StoredCredential;

export interface LoginOutput {
  writeDeviceAuthorizationInstructions?: (message: string) => void;
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
    return await executeDeviceLogin(command, deps, output);
  } catch (error) {
    if (!isDeviceLoginUnsupported(error)) {
      throw error;
    }

    const guidance = "This server does not support GitHub device login.";

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

async function executeDeviceLogin(
  command: LoginCommand,
  deps: CommandDeps,
  output: LoginOutput,
): Promise<string> {
  const started = parseDeviceStartResponse(
    await request(
      deps.fetch,
      buildApiUrl(command.serverUrl, "/v1/auth/oauth/device/start"),
      {
        body: JSON.stringify({ provider: GITHUB_PROVIDER }),
        headers: {
          "content-type": "application/json",
        },
        method: "POST",
      },
    ),
  );
  output.writeDeviceAuthorizationInstructions?.(
    renderDeviceAuthorizationInstructions(started),
  );
  const timeoutSeconds = command.timeoutSeconds ?? started.expiresInSeconds;
  const deadlineMs = deps.now() + timeoutSeconds * 1000;
  let intervalSeconds = started.intervalSeconds;

  while (true) {
    const remainingMs = deadlineMs - deps.now();
    const intervalMs = intervalSeconds * 1000;

    if (remainingMs < intervalMs) {
      throw new ValidationError("Timed out waiting for GitHub device authorization");
    }

    await deps.sleep(intervalMs);

    const poll = parseDevicePollResponse(
      await request(
        deps.fetch,
        buildApiUrl(command.serverUrl, "/v1/auth/oauth/device/poll"),
        {
          body: JSON.stringify({
            poll_token: started.pollToken,
            provider: GITHUB_PROVIDER,
          }),
          headers: {
            "content-type": "application/json",
          },
          method: "POST",
        },
      ),
    );

    if ("accessToken" in poll) {
      await saveStoredCredential(command.serverUrl, poll, { env: deps.env });
      return renderLoginSuccess(poll);
    }

    intervalSeconds = poll.intervalSeconds;

    if (deps.now() >= deadlineMs) {
      throw new ValidationError("Timed out waiting for GitHub device authorization");
    }
  }
}

function resolveInteractivePrompt(
  command: LoginCommand,
  deps: CommandDeps,
): PromptFn | undefined {
  if (command.nonInteractive === true || deps.stdin?.isTTY !== true) {
    return undefined;
  }

  return deps.prompt;
}

async function promptAuthMethod(prompt: PromptFn): Promise<"device" | "token"> {
  const value = await prompt({
    choices: [
      { title: "GitHub device login", value: "device" },
      { title: "Paste a personal access token", value: "token" },
    ],
    message: "How would you like to sign in?",
    type: "select",
  });

  return value === "token" ? "token" : "device";
}

async function promptToken(
  prompt: PromptFn,
  message = "Personal access token",
): Promise<string> {
  const value = await prompt({ message, type: "password" });
  return Array.isArray(value) ? value[0] : value;
}

function isDeviceLoginUnsupported(error: unknown): boolean {
  return error instanceof HttpProblemError && error.responseStatus === 501;
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

function parseDeviceStartResponse(value: unknown): DeviceStartResponse {
  if (!isRecord(value)) {
    throw new Error("OAuth device start returned an invalid response");
  }

  const expiresInSeconds = value.expires_in_seconds;
  const intervalSeconds = value.interval_seconds;
  const pollToken = value.poll_token;
  const provider = value.provider;
  const userCode = value.user_code;
  const verificationUri = value.verification_uri;

  if (
    provider !== GITHUB_PROVIDER ||
    !isPositiveNumber(expiresInSeconds) ||
    !isPositiveNumber(intervalSeconds) ||
    !isNonEmptyString(pollToken) ||
    !isNonEmptyString(userCode) ||
    !isNonEmptyString(verificationUri)
  ) {
    throw new Error("OAuth device start returned an invalid response");
  }

  return {
    expiresInSeconds,
    intervalSeconds,
    pollToken,
    provider,
    userCode,
    verificationUri,
  };
}

function parseDevicePollResponse(value: unknown): DevicePollResponse {
  if (!isRecord(value)) {
    throw new Error("OAuth device poll returned an invalid response");
  }

  if (
    (value.outcome === "authorization_pending" || value.outcome === "slow_down") &&
    isPositiveNumber(value.interval_seconds)
  ) {
    return {
      intervalSeconds: value.interval_seconds,
      outcome: value.outcome,
    };
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

  throw new Error("OAuth device poll returned an invalid response");
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

function renderDeviceAuthorizationInstructions(
  started: DeviceStartResponse,
): string {
  return [
    "Complete GitHub device authorization:",
    `Open: ${started.verificationUri}`,
    `Code: ${started.userCode}`,
  ].join("\n");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
