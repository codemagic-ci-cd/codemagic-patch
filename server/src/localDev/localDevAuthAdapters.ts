/**
 * Local evaluation auth adapters — a fake identity provider for the
 * zero-prerequisite local stack (docker-compose.dev.yml). Only the identity
 * provider is faked: sessions, tokens, and registration flow through the
 * unchanged OAuth session machinery.
 *
 * Reachable only via the dedicated entrypoint (localDev/entry.ts); the stock
 * dist/main.js cannot enable these adapters. Never use them on a deployment —
 * and the factory enforces that itself: construction asserts the
 * CODEMAGIC_PATCH_LOCAL_AUTH=1 / non-production opt-ins (assertLocalAuthOptIn),
 * so no caller of the ServerRuntimeOptions seam can wire it by accident.
 *
 * The identity-level provider is "local-dev": stored on oauth_session /
 * user_account rows so evaluation sign-ins remain auditable.
 */

import type {
  AuthNAdapter,
  OAuthProviderIdentity,
} from "../app/authNAdapter";
import { canonicalizeEmail } from "../app/email";
import { assertLocalAuthOptIn, type LocalDevEntryEnv } from "./guards";

/** Identity-level provider recorded on sessions/users. */
export const LOCAL_DEV_PROVIDER = "local-dev";

/**
 * Matches the seeded admin (INITIAL_ADMIN_EMAILS in the dev compose), so the
 * first sign-in links to the seeded owner account by email and CLI-created
 * apps are immediately visible in the dashboard.
 */
export const LOCAL_DEV_ADMIN_EMAIL = "local-admin@example.com";

/** Web OAuth codes take the form `local:<email>`. */
const LOCAL_CODE_PREFIX = "local:";

export function localDevIdentity(email: string): OAuthProviderIdentity {
  // Canonicalize BEFORE deriving both fields: account emails are stored
  // canonicalized (lowercase), so a case-variant re-sign-in with a raw
  // subject would miss the exact (provider, subject) lookup and then hit
  // the canonical-email lookup's oauth_identity_conflict.
  const canonical = canonicalizeEmail(email);

  return {
    displayName: deriveDisplayName(canonical),
    email: canonical,
    emailVerified: true,
    provider: LOCAL_DEV_PROVIDER,
    subject: canonical,
  };
}

/**
 * Web OAuth (authorization-code) adapter: accepts codes of the form
 * `local:<email>` from the dashboard's local consent page. The PKCE verifier
 * is accepted but not checked — there is no secret to protect; the stack is
 * loopback-only and authentication is disabled by design.
 *
 * Construction throws unless the environment has explicitly opted in
 * (assertLocalAuthOptIn); tests pass an opted-in `env` instead of mutating
 * process.env.
 */
export function createLocalAuthNAdapter(
  env: LocalDevEntryEnv = process.env,
): AuthNAdapter {
  assertLocalAuthOptIn(env);

  return {
    async exchangeCode(input) {
      if (input.provider !== LOCAL_DEV_PROVIDER) {
        return { outcome: "unknown_provider" };
      }

      if (!input.code.startsWith(LOCAL_CODE_PREFIX)) {
        return { outcome: "invalid_grant" };
      }

      const email = decodeEmail(input.code.slice(LOCAL_CODE_PREFIX.length));
      if (!email) {
        return { outcome: "invalid_grant" };
      }

      return {
        identity: localDevIdentity(email),
        outcome: "success",
      };
    },
  };
}

function decodeEmail(encoded: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded).trim();
  } catch {
    return null;
  }

  // Light shape check only — this is an evaluation stack where arbitrary
  // emails are intentional (multi-user teams/RBAC without GitHub accounts).
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(decoded) ? decoded : null;
}

function deriveDisplayName(email: string): string {
  const localPart = email.split("@", 1)[0];
  const words = localPart
    .split(/[._+-]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));

  return words.length > 0 ? words.join(" ") : email;
}
