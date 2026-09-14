import { isIP } from "node:net";
import { createHash, createHmac } from "node:crypto";
import { ProviderHttpError } from "./providerError";

export type AwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};
const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const encode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** SigV4 over injected fetch; redirects must never forward signed credentials. */
export function signAwsRequest(input: {
  url: string;
  method: string;
  service: string;
  region: string;
  credentials: AwsCredentials;
  body?: string;
  headers?: Record<string, string>;
  now?: Date;
}): Record<string, string> {
  const url = new URL(input.url);
  const date = (input.now ?? new Date())
    .toISOString()
    .replace(/[:-]|\.\d{3}/gu, "");
  const day = date.slice(0, 8);
  const payloadHash = hash(input.body ?? "");
  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-date": date,
    "x-amz-content-sha256": payloadHash,
  };
  for (const [key, value] of Object.entries(input.headers ?? {}))
    headers[key.toLowerCase()] = value.trim().replace(/\s+/gu, " ");
  if (input.credentials.sessionToken)
    headers["x-amz-security-token"] = input.credentials.sessionToken;
  const names = Object.keys(headers).sort();
  const query = [...url.searchParams]
    .map(([k, v]) => [encode(k), encode(v)])
    .sort((a, b) =>
      a[0]! < b[0]!
        ? -1
        : a[0]! > b[0]!
          ? 1
          : a[1]! < b[1]!
            ? -1
            : a[1]! > b[1]!
              ? 1
              : 0,
    )
    .map((pair) => pair.join("="))
    .join("&");
  const path = url.pathname
    .split("/")
    .map((p) => encode(decodeURIComponent(p)))
    .join("/");
  const canonical = [
    input.method,
    path,
    query,
    names.map((n) => `${n}:${headers[n]}\n`).join(""),
    names.join(";"),
    payloadHash,
  ].join("\n");
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  let key: Buffer = Buffer.from(`AWS4${input.credentials.secretAccessKey}`);
  for (const part of [day, input.region, input.service, "aws4_request"])
    key = createHmac("sha256", key).update(part).digest();
  const signature = createHmac("sha256", key)
    .update(`AWS4-HMAC-SHA256\n${date}\n${scope}\n${hash(canonical)}`)
    .digest("hex");
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
  };
}

export async function awsRequest(
  input: Parameters<typeof signAwsRequest>[0] & { fetch: typeof fetch },
): Promise<Response> {
  return input.fetch(input.url, {
    method: input.method,
    headers: signAwsRequest(input),
    ...(input.body === undefined ? {} : { body: input.body }),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
}

export function s3ObjectUrl(input: {
  endpoint?: string;
  region: string;
  forcePathStyle: boolean;
  bucket: string;
  key?: string;
}): string {
  const url = new URL(
    input.endpoint ?? `https://s3.${input.region}.amazonaws.com`,
  );
  // Match the server SDK: IP endpoints cannot take a bucket subdomain, and
  // dotted bucket names do not fit HTTPS wildcard certificates.
  if (input.forcePathStyle || isIP(url.hostname.replace(/^\[|\]$/gu, "")) || (url.protocol === "https:" && input.bucket.includes(".")))
    url.pathname = `${url.pathname.replace(/\/$/u, "")}/${encode(input.bucket)}`;
  else url.hostname = `${input.bucket}.${url.hostname}`;
  if (input.key !== undefined)
    url.pathname = `${url.pathname.replace(/\/$/u, "")}/${input.key.split("/").map(encode).join("/")}`;
  return url.toString();
}

export async function awsQuery<T>(input: {
  fetch: typeof fetch;
  credentials: AwsCredentials;
  service: "iam" | "sts";
  region: string;
  action: string;
  values?: Record<string, string>;
}): Promise<T> {
  const { XMLParser } = await import("fast-xml-parser");
  const region = input.service === "iam" ? "us-east-1" : input.region;
  const url =
    input.service === "iam"
      ? "https://iam.amazonaws.com/"
      : `https://sts.${region}.amazonaws.com/`;
  const response = await awsRequest({
    ...input,
    method: "POST",
    url,
    region,
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=utf-8",
    },
    body: new URLSearchParams({
      Action: input.action,
      Version: input.service === "iam" ? "2010-05-08" : "2011-06-15",
      ...input.values,
    }).toString(),
  });
  const body = new XMLParser({ parseTagValue: false }).parse(
    await response.text(),
  );
  if (!response.ok)
    throw new ProviderHttpError(
      input.action,
      response.status,
      body.ErrorResponse?.Error?.Code,
    );
  return (body[`${input.action}Response`]?.[`${input.action}Result`] ??
    {}) as T;
}

export async function s3Operation(input: {
  fetch: typeof fetch;
  credentials: AwsCredentials;
  region: string;
  bucket: string;
  method: string;
  query?: string;
  body?: string;
}): Promise<void> {
  const response = await awsRequest({
    ...input,
    service: "s3",
    url: `https://${input.bucket}.s3.${input.region}.amazonaws.com/${input.query ? `?${input.query}` : ""}`,
    ...(input.body === undefined
      ? {}
      : {
          headers: {
            "content-md5": createHash("md5")
              .update(input.body)
              .digest("base64"),
          },
        }),
  });
  if (!response.ok)
    throw new ProviderHttpError(
      `S3 ${input.method} ${input.query || "bucket"}`,
      response.status,
    );
  await response.body?.cancel();
}

export function s3RuntimePolicy(
  publicBucket: string,
  internalBucket: string,
): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: ["s3:ListBucket", "s3:ListBucketMultipartUploads"],
        Resource: [publicBucket, internalBucket].map(
          (b) => `arn:aws:s3:::${b}`,
        ),
      },
      {
        Effect: "Allow",
        Action: [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:AbortMultipartUpload",
          "s3:ListMultipartUploadParts",
        ],
        Resource: [publicBucket, internalBucket].map(
          (b) => `arn:aws:s3:::${b}/*`,
        ),
      },
    ],
  });
}

export function s3PublicPolicy(bucket: string): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: "*",
        Action: "s3:GetObject",
        Resource: `arn:aws:s3:::${bucket}/*`,
      },
      {
        Effect: "Deny",
        Principal: "*",
        Action: "s3:GetObject",
        Resource: `arn:aws:s3:::${bucket}/_internal/*`,
      },
    ],
  });
}
