import { createHmac, randomBytes } from "node:crypto";

/**
 * Secrets and signatures per the Standard Webhooks specification
 * (`server/specs/webhooks-tech-spec.md`, Request → Signature).
 */

export const WEBHOOK_SECRET_PREFIX = "whsec_";

const SECRET_BYTES = 32;

/** `whsec_` followed by the base64 of 32 random bytes. */
export function generateWebhookSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}${randomBytes(SECRET_BYTES).toString("base64")}`;
}

export interface SignWebhookRequestInput {
  /** The exact bytes that will be sent. */
  body: string;
  /** The event id, sent as `webhook-id`. */
  id: string;
  secret: string;
  /** Unix seconds of this attempt, sent as `webhook-timestamp`. */
  timestampSeconds: number;
}

/** The `webhook-signature` header value: `v1,<base64 HMAC-SHA256>`. */
export function signWebhookRequest(input: SignWebhookRequestInput): string {
  const signedContent = `${input.id}.${input.timestampSeconds}.${input.body}`;
  const signature = createHmac("sha256", decodeWebhookSecret(input.secret))
    .update(signedContent, "utf8")
    .digest("base64");

  return `v1,${signature}`;
}

/** The signing key is the bytes behind the prefix, not the text. */
function decodeWebhookSecret(secret: string): Buffer {
  if (!secret.startsWith(WEBHOOK_SECRET_PREFIX)) {
    throw new Error("webhook secret does not start with whsec_");
  }

  return Buffer.from(secret.slice(WEBHOOK_SECRET_PREFIX.length), "base64");
}
