import { createHmac, timingSafeEqual } from "node:crypto";

export interface CreateOAuthDevicePollTokenInput {
  deviceCode: string;
  expiresAt: Date;
  intervalSeconds: number;
  provider: string;
  secret: string;
}

export interface VerifyOAuthDevicePollTokenInput {
  expectedProvider: string;
  now: Date;
  secret: string;
}

export type VerifyOAuthDevicePollTokenResult =
  | {
      outcome: "valid";
      deviceCode: string;
      intervalSeconds: number;
      provider: string;
    }
  | {
      outcome: "expired";
    }
  | {
      outcome: "invalid";
      reason:
        | "bad_signature"
        | "malformed"
        | "provider_mismatch"
        | "unsupported_version";
    };

interface PollTokenPayload {
  dc: string;
  exp: number;
  i: number;
  p: string;
  v: 1;
}

const POLL_TOKEN_PREFIX = "cp_odpt_";

export function createOAuthDevicePollToken(
  input: CreateOAuthDevicePollTokenInput,
): string {
  const payload: PollTokenPayload = {
    dc: input.deviceCode,
    exp: input.expiresAt.getTime(),
    i: input.intervalSeconds,
    p: input.provider,
    v: 1,
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = sign(encodedPayload, input.secret);

  return `${POLL_TOKEN_PREFIX}${encodedPayload}.${signature}`;
}

export function verifyOAuthDevicePollToken(
  token: string,
  input: VerifyOAuthDevicePollTokenInput,
): VerifyOAuthDevicePollTokenResult {
  if (!token.startsWith(POLL_TOKEN_PREFIX)) {
    return {
      outcome: "invalid",
      reason: "malformed",
    };
  }

  const body = token.slice(POLL_TOKEN_PREFIX.length);
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

  if (payload.p !== input.expectedProvider) {
    return {
      outcome: "invalid",
      reason: "provider_mismatch",
    };
  }

  if (payload.exp <= input.now.getTime()) {
    return {
      outcome: "expired",
    };
  }

  return {
    deviceCode: payload.dc,
    intervalSeconds: payload.i,
    outcome: "valid",
    provider: payload.p,
  };
}

function decodePayload(encodedPayload: string): PollTokenPayload | null {
  try {
    const value = JSON.parse(base64UrlDecode(encodedPayload)) as unknown;
    if (
      value === null ||
      typeof value !== "object" ||
      !("dc" in value) ||
      !("exp" in value) ||
      !("i" in value) ||
      !("p" in value) ||
      !("v" in value)
    ) {
      return null;
    }

    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate.dc !== "string" ||
      typeof candidate.exp !== "number" ||
      !Number.isInteger(candidate.exp) ||
      typeof candidate.i !== "number" ||
      !Number.isInteger(candidate.i) ||
      typeof candidate.p !== "string" ||
      candidate.v !== 1
    ) {
      return null;
    }

    return {
      dc: candidate.dc,
      exp: candidate.exp,
      i: candidate.i,
      p: candidate.p,
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
