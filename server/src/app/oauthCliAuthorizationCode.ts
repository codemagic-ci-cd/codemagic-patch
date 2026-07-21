import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * CLI loopback authorization codes: short-TTL, single-audience, HMAC-signed
 * blobs binding the approving user to the CLI's PKCE challenge and loopback
 * port (same stateless pattern as oauthDevicePollToken.ts). Strict one-time
 * use would need a replay store; PKCE binding + the short TTL is the accepted
 * stateless trade-off.
 */

export interface CreateOAuthCliAuthorizationCodeInput {
  codeChallenge: string;
  expiresAt: Date;
  port: number;
  secret: string;
  userId: string;
}

export interface VerifyOAuthCliAuthorizationCodeInput {
  now: Date;
  secret: string;
}

export type VerifyOAuthCliAuthorizationCodeResult =
  | {
      outcome: "valid";
      codeChallenge: string;
      port: number;
      userId: string;
    }
  | {
      outcome: "expired";
    }
  | {
      outcome: "invalid";
      reason: "bad_signature" | "malformed" | "unsupported_version";
    };

interface CliAuthorizationCodePayload {
  ch: string;
  exp: number;
  port: number;
  uid: string;
  v: 1;
}

const CLI_AUTHORIZATION_CODE_PREFIX = "cp_cliac_";

export function createOAuthCliAuthorizationCode(
  input: CreateOAuthCliAuthorizationCodeInput,
): string {
  const payload: CliAuthorizationCodePayload = {
    ch: input.codeChallenge,
    exp: input.expiresAt.getTime(),
    port: input.port,
    uid: input.userId,
    v: 1,
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = sign(encodedPayload, input.secret);

  return `${CLI_AUTHORIZATION_CODE_PREFIX}${encodedPayload}.${signature}`;
}

export function verifyOAuthCliAuthorizationCode(
  code: string,
  input: VerifyOAuthCliAuthorizationCodeInput,
): VerifyOAuthCliAuthorizationCodeResult {
  if (!code.startsWith(CLI_AUTHORIZATION_CODE_PREFIX)) {
    return {
      outcome: "invalid",
      reason: "malformed",
    };
  }

  const body = code.slice(CLI_AUTHORIZATION_CODE_PREFIX.length);
  const parts = body.split(".");
  if (parts.length !== 2) {
    return {
      outcome: "invalid",
      reason: "malformed",
    };
  }

  const [encodedPayload, signature] = parts;
  if (!encodedPayload || !signature) {
    return {
      outcome: "invalid",
      reason: "malformed",
    };
  }

  if (!signatureMatches(encodedPayload, signature, input.secret)) {
    return {
      outcome: "invalid",
      reason: "bad_signature",
    };
  }

  const payload = decodePayload(encodedPayload);
  if (!payload) {
    return {
      outcome: "invalid",
      reason: "malformed",
    };
  }

  if (payload.v !== 1) {
    return {
      outcome: "invalid",
      reason: "unsupported_version",
    };
  }

  if (payload.exp <= input.now.getTime()) {
    return {
      outcome: "expired",
    };
  }

  return {
    codeChallenge: payload.ch,
    outcome: "valid",
    port: payload.port,
    userId: payload.uid,
  };
}

/**
 * RFC 7636 S256 check: BASE64URL(SHA-256(verifier)) must equal the challenge
 * the authorization code was bound to. Constant-time comparison — the
 * challenge is attacker-visible but the comparison guards the verifier.
 */
export function pkceChallengeMatches(
  codeVerifier: string,
  codeChallenge: string,
): boolean {
  const derived = createHash("sha256").update(codeVerifier).digest("base64url");
  const derivedBuffer = Buffer.from(derived);
  const challengeBuffer = Buffer.from(codeChallenge);

  return (
    derivedBuffer.length === challengeBuffer.length &&
    timingSafeEqual(derivedBuffer, challengeBuffer)
  );
}

function decodePayload(
  encodedPayload: string,
): CliAuthorizationCodePayload | null {
  try {
    const value = JSON.parse(base64UrlDecode(encodedPayload)) as unknown;
    if (
      value === null ||
      typeof value !== "object" ||
      !("ch" in value) ||
      !("exp" in value) ||
      !("port" in value) ||
      !("uid" in value) ||
      !("v" in value)
    ) {
      return null;
    }

    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate.ch !== "string" ||
      typeof candidate.exp !== "number" ||
      !Number.isInteger(candidate.exp) ||
      typeof candidate.port !== "number" ||
      !Number.isInteger(candidate.port) ||
      typeof candidate.uid !== "string" ||
      candidate.v !== 1
    ) {
      return null;
    }

    return {
      ch: candidate.ch,
      exp: candidate.exp,
      port: candidate.port,
      uid: candidate.uid,
      v: 1,
    };
  } catch {
    return null;
  }
}

function signatureMatches(
  encodedPayload: string,
  signature: string,
  secret: string,
): boolean {
  const expected = sign(encodedPayload, secret);
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signature);

  return (
    expectedBuffer.length === actualBuffer.length &&
    timingSafeEqual(expectedBuffer, actualBuffer)
  );
}

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}
