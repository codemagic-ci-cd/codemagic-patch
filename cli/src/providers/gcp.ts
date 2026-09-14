import { createSign } from "node:crypto";
import { ProviderHttpError } from "./providerError";

export function parseGcsKey(json: string): {
  client_email: string;
  private_key: string;
  project_id: string;
  private_key_id?: string;
} {
  let key;
  try {
    key = JSON.parse(json);
  } catch {
    throw new Error("The GCS runtime key must be a service-account JSON file.");
  }
  if (
    !key ||
    typeof key !== "object" ||
    key.type !== "service_account" ||
    typeof key.client_email !== "string" ||
    typeof key.private_key !== "string" ||
    typeof key.project_id !== "string"
  )
    throw new Error(
      "The GCS runtime key must contain a service account email, private key and project ID.",
    );
  return key;
}

export async function gcsAccessToken(input: {
  credentialsJson: string;
  fetch: typeof fetch;
  now?: number;
}): Promise<string> {
  const key = parseGcsKey(input.credentialsJson);
  const issued = Math.floor((input.now ?? Date.now()) / 1000);
  const base64 = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${base64({ alg: "RS256", typ: "JWT" })}.${base64({ iss: key.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: "https://oauth2.googleapis.com/token", iat: issued, exp: issued + 3600 })}`;
  const jwt = `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(key.private_key, "base64url")}`;
  const response = await input.fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!response.ok) {
    const error = (await response.json()) as { error?: string };
    throw new ProviderHttpError(
      "GCP credential verification",
      response.status,
      error.error,
    );
  }
  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("GCP returned no access token.");
  return body.access_token;
}

export async function gcpRequest<T>(input: {
  fetch: typeof fetch;
  token: string;
  url: string;
  method?: string;
  body?: unknown;
}): Promise<T> {
  const response = await input.fetch(input.url, {
    method: input.method ?? "GET",
    headers: {
      authorization: `Bearer ${input.token}`,
      "content-type": "application/json",
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new ProviderHttpError(
      `GCP ${input.method ?? "GET"} ${new URL(input.url).pathname}`,
      response.status,
    );
  return response.status === 204
    ? (undefined as T)
    : ((await response.json()) as T);
}

export async function grantGcsBucket(input: {
  fetch: typeof fetch;
  token: string;
  bucket: string;
  email: string;
  publicRead: boolean;
}): Promise<void> {
  const url = `https://storage.googleapis.com/storage/v1/b/${input.bucket}/iam`;
  const policy = await gcpRequest<{
    etag: string;
    bindings?: { role: string; members: string[] }[];
  }>({ ...input, url });
  await gcpRequest({
    ...input,
    url,
    method: "PUT",
    body: {
      ...policy,
      bindings: [
        ...(policy.bindings ?? []),
        {
          role: "roles/storage.objectAdmin",
          members: [`serviceAccount:${input.email}`],
        },
        ...(input.publicRead
          ? [
              {
                role: "roles/storage.legacyObjectReader",
                members: ["allUsers"],
              },
            ]
          : []),
      ],
    },
  });
}
