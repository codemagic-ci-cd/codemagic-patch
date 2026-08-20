"use strict";

const {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} = require("@aws-sdk/client-s3");

const INTERNAL_PROBE_KEY = "_internal/releases/does-not-exist/bundle.tar.zst";

function parseForcePathStyle(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return false;
  }

  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }

  throw new Error(
    `S3_FORCE_PATH_STYLE must be true, false, 1, or 0. Received: ${JSON.stringify(value)}`,
  );
}

function requestUrl(request) {
  const protocol = request.protocol || "https:";
  const rawHostname = request.hostname;
  if (!rawHostname) {
    throw new Error("AWS SDK resolved an S3 request without a hostname");
  }
  const hostname =
    rawHostname.includes(":") && !rawHostname.startsWith("[")
      ? `[${rawHostname}]`
      : rawHostname;
  const port = request.port ? `:${request.port}` : "";
  const url = new URL(`${protocol}//${hostname}${port}${request.path || "/"}`);

  for (const [name, rawValue] of Object.entries(request.query || {})) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      if (value !== undefined && value !== null) {
        url.searchParams.append(name, String(value));
      }
    }
  }

  return url.toString();
}

async function resolveS3ProbeUrls({
  bucket,
  endpoint,
  forcePathStyle,
  region = "us-east-1",
}) {
  if (!bucket) {
    throw new Error("S3_BUCKET is required to resolve the smoke probe URLs");
  }

  const requests = [];
  const requestHandler = {
    destroy() {},
    async handle(request) {
      requests.push(request);
      // A deterministic 403 keeps endpoint resolution and signing local while
      // avoiding any network request. The caller later fetches the captured URL
      // anonymously, which is the bucket-policy behavior the smoke must test.
      return {
        response: {
          body: Buffer.from(""),
          headers: {},
          statusCode: 403,
        },
      };
    },
  };
  const client = new S3Client({
    credentials: {
      accessKeyId: "codemagic-patch-smoke-url-only",
      secretAccessKey: "codemagic-patch-smoke-url-only",
    },
    endpoint: endpoint || undefined,
    forcePathStyle: parseForcePathStyle(forcePathStyle),
    maxAttempts: 1,
    region,
    requestHandler,
  });

  async function capture(command, label) {
    const requestIndex = requests.length;
    try {
      await client.send(command);
    } catch {
      // The synthetic 403 is expected; only the resolved request is needed.
    }
    const request = requests[requestIndex];
    if (!request) {
      throw new Error(`AWS SDK did not resolve the S3 ${label} request`);
    }
    return requestUrl(request);
  }

  try {
    const internalUrl = await capture(
      new GetObjectCommand({ Bucket: bucket, Key: INTERNAL_PROBE_KEY }),
      "GetObject",
    );
    const listUrl = await capture(
      new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }),
      "ListObjectsV2",
    );
    return { internalUrl, listUrls: [listUrl] };
  } finally {
    client.destroy();
  }
}

module.exports = {
  parseForcePathStyle,
  resolveS3ProbeUrls,
};
