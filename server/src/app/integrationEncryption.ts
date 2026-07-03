import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH_BYTES = 12;

export function parseIntegrationEncryptionKey(
  value: string | undefined,
): Buffer | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const key = Buffer.from(trimmed, "base64");
  if (key.length !== 32) {
    throw new Error(
      "INTEGRATION_ENCRYPTION_KEY must be a base64-encoded 32-byte value",
    );
  }

  return key;
}

export function encryptIntegrationSecret(
  plaintext: string,
  key: Buffer,
): string {
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

export function decryptIntegrationSecret(
  ciphertext: string,
  key: Buffer,
): string {
  const payload = Buffer.from(ciphertext, "base64");
  if (payload.length < IV_LENGTH_BYTES + 16) {
    throw new Error("integration ciphertext is too short");
  }

  const iv = payload.subarray(0, IV_LENGTH_BYTES);
  const authTag = payload.subarray(IV_LENGTH_BYTES, IV_LENGTH_BYTES + 16);
  const encrypted = payload.subarray(IV_LENGTH_BYTES + 16);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString("utf8");
}

export function integrationTokenLast4(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length === 0) {
    return "????";
  }

  return trimmed.slice(-4);
}
