import { createHash, randomBytes } from "node:crypto";

export const API_TOKEN_PREFIX = "cm_pat_";
export const API_TOKEN_RANDOM_BYTE_LENGTH = 32;
export const API_TOKEN_HASH_DOMAIN = "codemagic_patch_api_token:v1:";

export interface GeneratedApiToken {
  maskedPrefix: string;
  token: string;
  tokenHash: string;
}

export function generateApiToken(): GeneratedApiToken {
  const token = `${API_TOKEN_PREFIX}${randomBytes(API_TOKEN_RANDOM_BYTE_LENGTH).toString("base64url")}`;

  return {
    maskedPrefix: createApiTokenMaskedPrefix(token),
    token,
    tokenHash: hashApiToken(token),
  };
}

export function hashApiToken(token: string): string {
  return createHash("sha256")
    .update(`${API_TOKEN_HASH_DOMAIN}${token}`, "utf8")
    .digest("hex");
}

export function createApiTokenMaskedPrefix(token: string): string {
  return `${token.slice(0, API_TOKEN_PREFIX.length + 2)}...`;
}
