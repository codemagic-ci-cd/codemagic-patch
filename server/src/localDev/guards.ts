/**
 * Boot guards for local evaluation mode. Belt-and-braces on top of the
 * structural guard (local auth is only reachable via dist/localDev/entry.js,
 * which nothing in the self-host path ever runs): enabling local auth against
 * a stock deployment requires two explicit opt-ins, because the server image
 * bakes NODE_ENV=production — a copy-pasted `command:` override alone refuses.
 *
 * The opt-in check is enforced INSIDE the adapter factories
 * (localDevAuthAdapters.ts), not just at the entrypoint, so no future caller
 * of the ServerRuntimeOptions seam can construct an auth-disabled server by
 * forgetting to check.
 */

export interface LocalDevEntryEnv {
  CODEMAGIC_PATCH_LOCAL_AUTH?: string;
  NODE_ENV?: string;
  OAUTH_CLI_AUTH_SECRET?: string;
  OAUTH_DEVICE_POLL_TOKEN_SECRET?: string;
}

/**
 * The two opt-ins every local-dev auth adapter requires. Called by the
 * adapter factories themselves at construction time.
 */
export function assertLocalAuthOptIn(env: LocalDevEntryEnv): void {
  if (env.CODEMAGIC_PATCH_LOCAL_AUTH !== "1") {
    throw new Error(
      "local evaluation auth requires CODEMAGIC_PATCH_LOCAL_AUTH=1. " +
        "It disables authentication and must only run in the local evaluation " +
        "stack (docker-compose.dev.yml) — for a real deployment, run dist/main.js.",
    );
  }

  if (env.NODE_ENV === "production") {
    throw new Error(
      "local evaluation auth refuses to start with NODE_ENV=production. " +
        "The local stack must set NODE_ENV=development explicitly (the server " +
        "image defaults to production) — for a real deployment, run dist/main.js.",
    );
  }
}

export function assertLocalDevEntryAllowed(env: LocalDevEntryEnv): void {
  assertLocalAuthOptIn(env);

  // Fail fast instead of leaving the CLI issue/exchange routes answering 501:
  // `cmpatch login` working out of the box is part of the evaluation promise.
  // Only presence is checked here — the config parser enforces the minimum
  // length (and reports it accurately) on the very next step of the
  // entrypoint.
  if (
    !env.OAUTH_CLI_AUTH_SECRET?.trim() &&
    !env.OAUTH_DEVICE_POLL_TOKEN_SECRET?.trim()
  ) {
    throw new Error(
      "OAUTH_CLI_AUTH_SECRET (or its fallback OAUTH_DEVICE_POLL_TOKEN_SECRET) " +
        "is required by the local evaluation entrypoint: CLI browser login " +
        "signs its authorization codes with it even though the identity " +
        "provider is faked.",
    );
  }
}
