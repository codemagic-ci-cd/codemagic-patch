// PKCE (RFC 7636) + CSRF-state utilities for the GitHub authorize redirect
// WebCrypto + sessionStorage only — framework-free, no fetch/React.
// GitHub OAuth Apps currently ignore code_challenge; S256 is still sent
// (harmless, provider-agnostic) while `state`, the server-held client secret,
// and server-side redirectUri validation remain the effective protections.

/** sessionStorage key for the single in-flight login stash. */
export const PKCE_STORAGE_KEY = "codemagic-patch.dashboard.pkce.v1";

export interface PkceStashEntry {
  state: string;
  codeVerifier: string;
  /** In-app path to resume after the callback completes. */
  returnTo?: string;
  /**
   * Web-config provider captured when the flow started; echoed into the
   * callback body. Absent (pre-existing stashes) = "github".
   */
  provider?: string;
}

/**
 * Base64url (RFC 4648 §5) without padding: `+`→`-`, `/`→`_`, `=` stripped.
 */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Random PKCE `code_verifier`: 64 random bytes → 86 base64url chars, within
 * RFC 7636's 43–128 length bounds and its unreserved charset (A–Z a–z 0–9 - _).
 */
export function generateCodeVerifier(): string {
  return base64UrlEncode(randomBytes(64));
}

/** Random CSRF `state`: 32 random bytes → 43 base64url chars. */
export function generateState(): string {
  return base64UrlEncode(randomBytes(32));
}

/**
 * S256 `code_challenge`: BASE64URL(SHA-256(ASCII(code_verifier))).
 * Deterministic and side-effect-free — verifiable against the RFC 7636
 * appendix-B known vector.
 */
export async function createCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64UrlEncode(new Uint8Array(digest));
}

/**
 * Persist the in-flight login's PKCE material. A single login may be in
 * flight at a time — starting a new one overwrites any previous stash.
 * Storage failures are swallowed: the callback then misses the stash and
 * surfaces "Invalid sign-in state, try again" (edge case).
 */
export function stashPkce(entry: PkceStashEntry): void {
  const storage = getSessionStorage();
  if (storage === null) {
    return;
  }
  try {
    storage.setItem(PKCE_STORAGE_KEY, JSON.stringify(entry));
  } catch {
    // Quota/security failure — degrade to the missing-stash callback path.
  }
}

/**
 * Return the stashed PKCE material for `state` and ALWAYS clear the stash —
 * a verifier must never be replayable against a second authorization code.
 * Missing stash, corrupt JSON, or a `state` mismatch → null (the callback
 * page maps null to "Invalid sign-in state, try again").
 */
export function consumePkce(
  state: string,
): { codeVerifier: string; returnTo?: string; provider?: string } | null {
  const storage = getSessionStorage();
  if (storage === null) {
    return null;
  }
  let raw: string | null;
  try {
    raw = storage.getItem(PKCE_STORAGE_KEY);
    storage.removeItem(PKCE_STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isStashEntry(parsed) || parsed.state !== state) {
    return null;
  }
  return {
    codeVerifier: parsed.codeVerifier,
    ...(typeof parsed.returnTo === "string"
      ? { returnTo: parsed.returnTo }
      : {}),
    ...(typeof parsed.provider === "string"
      ? { provider: parsed.provider }
      : {}),
  };
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * `sessionStorage` can be absent (non-browser) or throw on access
 * (storage-blocking privacy modes); treat both as "no storage".
 */
function getSessionStorage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

function isStashEntry(
  value: unknown,
): value is {
  state: string;
  codeVerifier: string;
  returnTo?: unknown;
  provider?: unknown;
} {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.state === "string" && typeof record.codeVerifier === "string"
  );
}
