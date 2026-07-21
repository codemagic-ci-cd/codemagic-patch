import { createHash, randomBytes } from "node:crypto";

/**
 * PKCE (RFC 7636) + CSRF-state material for the loopback browser login —
 * the Node twin of the dashboard's WebCrypto helpers in
 * web-dashboard/src/auth/pkce.ts.
 */

export interface LoginPkceMaterial {
  /** BASE64URL(SHA-256(codeVerifier)) — sent on the /cli/authorize URL. */
  codeChallenge: string;
  /** 64 random bytes → 86 base64url chars, inside RFC 7636's 43–128 bounds. */
  codeVerifier: string;
  /** CSRF state echoed back by the loopback redirect. */
  state: string;
}

export function generateLoginPkceMaterial(): LoginPkceMaterial {
  const codeVerifier = randomBytes(64).toString("base64url");

  return {
    codeChallenge: createHash("sha256").update(codeVerifier).digest("base64url"),
    codeVerifier,
    state: randomBytes(32).toString("base64url"),
  };
}
