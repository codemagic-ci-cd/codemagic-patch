import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import { UsageError } from "./commands/shared";

export const SIGNATURE_HASH_ALGORITHM = "sha256";

export function signContentHashJwt(input: {
  contentHash: string;
  privateKeyPem: Buffer | string;
}): string {
  // The JWS header below is hardcoded to RS256, so only RSA keys yield a
  // verifiable signature. Node's createSign would otherwise happily emit an
  // ECDSA/Ed25519 signature under an "alg":"RS256" header — silently
  // unverifiable on every device. Fail fast on anything but RSA.
  const privateKey = loadRsaPrivateKey(input.privateKeyPem);
  const signingInput = [
    base64UrlJson({ alg: "RS256", typ: "JWT" }),
    base64UrlJson({ contentHash: input.contentHash }),
  ].join(".");
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .end()
    .sign(privateKey);

  return `${signingInput}.${signature.toString("base64url")}`;
}

function loadRsaPrivateKey(privateKeyPem: Buffer | string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(privateKeyPem);
  } catch (error) {
    throw new UsageError(
      `--private-key could not be parsed as a private key: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (key.asymmetricKeyType !== "rsa") {
    throw new UsageError(
      `--private-key must be an RSA key (only RS256 signatures are currently verifiable). Got key type: ${
        key.asymmetricKeyType ?? "unknown"
      }.`,
    );
  }

  return key;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
