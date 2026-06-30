import { createHash, randomBytes } from "node:crypto";

export const OAUTH_ACCESS_TOKEN_PREFIX = "cm_oat_";
export const OAUTH_REFRESH_TOKEN_PREFIX = "cm_ort_";
export const OAUTH_TOKEN_RANDOM_BYTE_LENGTH = 32;
export const OAUTH_ACCESS_TOKEN_HASH_DOMAIN =
  "codemagic_patch_oauth_access_token:v1:";
export const OAUTH_REFRESH_TOKEN_HASH_DOMAIN =
  "codemagic_patch_oauth_refresh_token:v1:";

export interface GeneratedOAuthToken {
  maskedPrefix: string;
  token: string;
  tokenHash: string;
}

export function generateOAuthAccessToken(): GeneratedOAuthToken {
  const token = createOAuthToken(OAUTH_ACCESS_TOKEN_PREFIX);

  return {
    maskedPrefix: createOAuthAccessTokenMaskedPrefix(token),
    token,
    tokenHash: hashOAuthAccessToken(token),
  };
}

export function generateOAuthRefreshToken(): GeneratedOAuthToken {
  const token = createOAuthToken(OAUTH_REFRESH_TOKEN_PREFIX);

  return {
    maskedPrefix: createOAuthRefreshTokenMaskedPrefix(token),
    token,
    tokenHash: hashOAuthRefreshToken(token),
  };
}

export function hashOAuthAccessToken(token: string): string {
  return hashOAuthToken(OAUTH_ACCESS_TOKEN_HASH_DOMAIN, token);
}

export function hashOAuthRefreshToken(token: string): string {
  return hashOAuthToken(OAUTH_REFRESH_TOKEN_HASH_DOMAIN, token);
}

export function createOAuthAccessTokenMaskedPrefix(token: string): string {
  return `${token.slice(0, OAUTH_ACCESS_TOKEN_PREFIX.length + 2)}...`;
}

export function createOAuthRefreshTokenMaskedPrefix(token: string): string {
  return `${token.slice(0, OAUTH_REFRESH_TOKEN_PREFIX.length + 2)}...`;
}

function createOAuthToken(prefix: string): string {
  return `${prefix}${randomBytes(OAUTH_TOKEN_RANDOM_BYTE_LENGTH).toString("base64url")}`;
}

function hashOAuthToken(domain: string, token: string): string {
  return createHash("sha256").update(`${domain}${token}`, "utf8").digest("hex");
}
