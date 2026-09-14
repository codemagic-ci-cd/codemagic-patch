"use strict";

const { randomUUID } = require("node:crypto");
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");
const { Storage } = require("@google-cloud/storage");
const { r2Account, verifyR2Privacy } = require("./r2-privacy.cjs");
const { resolveS3ProbeUrls } = require("./resolve-s3-probe-urls.cjs");

async function verifyStorage(env = process.env, { fetch: fetcher = fetch, s3RequestHandler } = {}) {
  const id = randomUUID();
  const publicKey = `.cmpatch-check/${id}`;
  const internalKey = `_internal/.cmpatch-check/${id}`;
  const content = Buffer.from(`cmpatch-${id}`);
  const gcs = env.STORAGE_ADAPTER === "gcs";
  const publicBucket = gcs ? env.GCS_PUBLIC_BUCKET : env.S3_BUCKET;
  const internalBucket =
    (gcs ? env.GCS_INTERNAL_BUCKET : env.S3_INTERNAL_BUCKET) || publicBucket;
  if (!publicBucket || !env.PUBLIC_BASE_URL)
    throw new Error(
      "Storage verification requires a bucket and PUBLIC_BASE_URL",
    );
  const s3 = gcs
    ? null
    : new S3Client({
        region: env.S3_REGION || "us-east-1",
        endpoint: env.S3_ENDPOINT || undefined,
        forcePathStyle:
          env.S3_FORCE_PATH_STYLE === "true" || env.S3_FORCE_PATH_STYLE === "1",
        ...(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
          ? {
              credentials: {
                accessKeyId: env.S3_ACCESS_KEY_ID,
                secretAccessKey: env.S3_SECRET_ACCESS_KEY,
              },
            }
          : {}),
        maxAttempts: 2,
        ...(s3RequestHandler ? { requestHandler: s3RequestHandler } : {}),
      });
  const storage = gcs ? new Storage() : null;
  const fetchAnonymous = (url) =>
    fetcher(url, { redirect: "error", signal: AbortSignal.timeout(15000) });
  const created = [];
  let cleanupFailed = false;
  try {
    for (const [bucket, key] of [
      [publicBucket, publicKey],
      [internalBucket, internalKey],
    ]) {
      created.push([bucket, key]);
      if (gcs) {
        const file = storage.bucket(bucket).file(key);
        await file.save(content, { resumable: false });
        const [read] = await file.download();
        if (!read.equals(content))
          throw new Error(`Runtime read/write content mismatch in ${bucket}`);
      } else {
        await s3.send(
          new PutObjectCommand({ Bucket: bucket, Key: key, Body: content }),
        );
        const read = await s3.send(
          new GetObjectCommand({ Bucket: bucket, Key: key }),
        );
        if (
          !Buffer.from(await read.Body.transformToByteArray()).equals(content)
        )
          throw new Error(`Runtime read/write content mismatch in ${bucket}`);
      }
    }
    const account = !gcs && r2Account(env.S3_ENDPOINT);
    if (account) {
      await verifyR2Privacy({ account, publicBucket, internalBucket, apiToken: env.CLOUDFLARE_API_TOKEN, fetch: fetcher });
    } else {
      const probes = gcs
        ? {
            internalUrl: `https://storage.googleapis.com/${internalBucket}/${internalKey}`,
            listUrls: [publicBucket, internalBucket].map(
              (bucket) =>
                `https://storage.googleapis.com/storage/v1/b/${bucket}/o?maxResults=1`,
            ),
          }
        : await resolveS3ProbeUrls({
            bucket: publicBucket,
            internalBucket,
            internalKey,
            endpoint: env.S3_ENDPOINT,
            region: env.S3_REGION || "us-east-1",
            forcePathStyle: env.S3_FORCE_PATH_STYLE,
          });
      for (const url of [probes.internalUrl, ...probes.listUrls]) {
        const response = await fetchAnonymous(url);
        await response.body?.cancel();
        if (response.status !== 401 && response.status !== 403)
          throw new Error(
            response.ok
              ? "Anonymous internal access or listing was not denied. Remove public internal-object/listing access in the storage console."
              : `Could not verify anonymous internal access or listing denial (HTTP ${response.status}).`,
          );
      }
    }
    const base = env.PUBLIC_BASE_URL.replace(/\/$/, "");
    const response = await fetchAnonymous(`${base}/${publicKey}`);
    if (
      !response.ok ||
      !Buffer.from(await response.arrayBuffer()).equals(content)
    )
      throw new Error(
        "PUBLIC_BASE_URL did not return the uploaded probe. Check public-read policy, DNS/TLS and CDN origin mapping.",
      );
    const privateResponse = await fetchAnonymous(`${base}/${internalKey}`);
    await privateResponse.body?.cancel();
    if (![401, 403, 404].includes(privateResponse.status))
      throw new Error("PUBLIC_BASE_URL did not deny the internal probe.");
    console.log(
      `Storage checked: runtime read/write, final public download, provider-specific privacy (${publicBucket}, ${internalBucket}).`,
    );
  } finally {
    for (const [bucket, key] of created) {
      try {
        if (gcs)
          await storage
            .bucket(bucket)
            .file(key)
            .delete({ ignoreNotFound: true });
        else
          await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      } catch {
        cleanupFailed = true;
        console.error(
          `Remove leftover probe ${bucket}/${key} in the storage console.`,
        );
      }
    }
    s3?.destroy();
  }
  if (cleanupFailed)
    throw new Error(
      "Storage probe cleanup failed; remove the listed objects before retrying.",
    );
}

if (require.main === module) {
  // Bound the entire operation, including SDK retries. Forced timeout cannot guarantee cleanup.
  const timeout = setTimeout(() => {
    console.error(
      "Storage verification timed out. Inspect .cmpatch-check/ and _internal/.cmpatch-check/ in the configured buckets for leftover probes, correct connectivity and rerun install.sh.",
    );
    process.exit(1);
  }, 120000);
  verifyStorage()
    .catch((error) => {
      // Provider error text can contain signed requests; emit the safe classification only.
      console.error(
        `Storage verification failed (${error.name || "Error"}). Check runtime bucket permissions, public delivery and private-bucket/listing policy. Correct the saved configuration and rerun install.sh; storage credentials are replaced manually.`,
      );
      if (error.constructor === Error) console.error(error.message);
      process.exitCode = 1;
    })
    .finally(() => clearTimeout(timeout));
}
module.exports = { verifyStorage };
