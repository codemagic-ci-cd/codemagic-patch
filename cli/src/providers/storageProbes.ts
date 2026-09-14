import { verifyR2Privacy } from "./storagePrivacy";
import { randomUUID } from "node:crypto";
import { awsRequest, s3ObjectUrl } from "./aws";
import { gcsAccessToken } from "./gcp";
import { ProviderHttpError } from "./providerError";
import type { StorageConfig } from "../storageConfig";

export const STORAGE_PROBE_TTL_SECONDS = 3600;
const PROBE_CACHE_CONTROL = `public, max-age=0, s-maxage=${STORAGE_PROBE_TTL_SECONDS}`;

type ExternalStorage = Exclude<StorageConfig, { kind: "bundled" }>;
export type ProbeWait = <T>(
  label: string,
  check: () => Promise<T | undefined>,
  timeoutMs?: number,
) => Promise<T>;

export async function verifyStorage(input: {
  storage: ExternalStorage;
  fetch: typeof fetch;
  cleanupFetch?: typeof fetch;
  now?: () => number;
  cleanupWarning: (message: string) => void;
  wait?: ProbeWait;
  allowPropagation?: boolean;
  cdn?: "cloudflare" | "cloudfront";
  purge?: (url: string) => Promise<void>;
  r2ApiToken?: string;
}): Promise<void> {
  const { storage, fetch: fetcher } = input;
  const now = input.now ?? Date.now;
  const id = randomUUID();
  const publicKey = `.cmpatch-check/${id}.txt`;
  const internalKey = `_internal/.cmpatch-check/${id}.txt`;
  const content = `cmpatch-${id}`;
  const wait: ProbeWait =
    input.wait ??
    (async (label, check) => {
      const result = await check();
      if (result === undefined)
        throw new Error(
          `${label} is not ready. Check DNS/TLS, credentials and permissions, then retry.`,
        );
      return result;
    });
  const token =
    storage.kind === "gcs"
      ? await wait("Runtime service-account key propagation", async () => {
          try {
            return await gcsAccessToken({
              credentialsJson: storage.credentialsJson,
              fetch: fetcher,
            });
          } catch (error) {
            if (input.allowPropagation && error instanceof ProviderHttpError && error.code === "invalid_grant")
              return undefined;
            throw error;
          }
        })
      : undefined;
  const objectUrl = (bucket: string, key?: string) =>
    storage.kind === "gcs"
      ? `https://storage.googleapis.com/${bucket}${key === undefined ? "" : `/${key}`}`
      : s3ObjectUrl({
          ...storage,
          bucket,
          ...(key === undefined ? {} : { key }),
        });
  const request = async (
    method: string,
    bucket: string,
    key: string,
    body?: string,
    fetchImpl = fetcher,
  ) => {
    if (storage.kind !== "gcs")
      return awsRequest({
        url: objectUrl(bucket, key),
        method,
        service: "s3",
        region: storage.region,
        credentials: storage,
        fetch: fetchImpl,
        ...(body === undefined ? {} : { body }),
        headers: {
          "cache-control": PROBE_CACHE_CONTROL,
          "content-type": "text/plain",
        },
      });
    const url =
      method === "PUT"
        ? `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=multipart`
        : `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(key)}${method === "GET" ? "?alt=media" : ""}`;
    const boundary = `cmpatch-${id}`;
    const payload =
      body === undefined
        ? undefined
        : `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: key, cacheControl: PROBE_CACHE_CONTROL, contentType: "text/plain" })}\r\n--${boundary}\r\nContent-Type: text/plain\r\n\r\n${body}\r\n--${boundary}--\r\n`;
    return fetchImpl(url, {
      method: method === "PUT" ? "POST" : method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": `multipart/related; boundary=${boundary}`,
      },
      ...(payload === undefined ? {} : { body: payload }),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  };
  const anonymous = (url: string) =>
    fetcher(url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
  const created: [string, string][] = [];
  try {
    for (const [bucket, key] of [
      [storage.publicBucket, publicKey],
      [storage.internalBucket, internalKey],
    ] as [string, string][]) {
      created.push([bucket, key]);
      await wait(`Runtime write/read on ${bucket}`, async () => {
        const put = await request("PUT", bucket, key, content);
        if (!put.ok) {
          const code = /<Code>([\w]+)<\/Code>/u.exec(await put.text())?.[1];
          if (
            input.allowPropagation &&
            (put.status === 429 ||
              put.status >= 500 ||
              (put.status === 403 && (!code || code === "AccessDenied")))
          )
            return undefined;
          throw new ProviderHttpError(
            `Write probe ${bucket}`,
            put.status,
            code,
          );
        }
        const read = await request("GET", bucket, key);
        if (!read.ok || (await read.text()) !== content)
          throw new Error(
            `Runtime read failed in ${bucket}. Check object-read permissions.`,
          );
        return true;
      });
    }
    if (storage.kind === "r2") {
      await verifyR2Privacy(storage, fetcher, input.r2ApiToken);
    } else {
      const privateRead = await anonymous(
        objectUrl(storage.internalBucket, internalKey),
      );
      await privateRead.body?.cancel();
      if (![401, 403].includes(privateRead.status))
        throw new Error(
          privateRead.ok
            ? `Internal bucket ${storage.internalBucket} allows anonymous access. Remove public access before retrying.`
            : `Could not verify anonymous access denial for internal bucket ${storage.internalBucket} (HTTP ${privateRead.status}).`,
        );
      for (const bucket of [storage.publicBucket, storage.internalBucket]) {
        const url =
          storage.kind === "gcs"
            ? `https://storage.googleapis.com/storage/v1/b/${bucket}/o?maxResults=1`
            : `${objectUrl(bucket)}?list-type=2&max-keys=1`;
        const listing = await anonymous(url);
        await listing.body?.cancel();
        if (![401, 403].includes(listing.status))
          throw new Error(
            listing.ok
              ? `Bucket ${bucket} allows anonymous listing. Remove public listing permissions.`
              : `Could not verify anonymous listing denial for bucket ${bucket} (HTTP ${listing.status}).`,
          );
      }
    }
    const url = `${storage.publicBaseUrl.replace(/\/$/u, "")}/${publicKey}`;
    await wait(
      "Download DNS/TLS and public-object delivery",
      async () => {
        let delivered;
        try {
          delivered = await anonymous(url);
        } catch {
          return undefined;
        }
        if (!delivered.ok) {
          await delivered.body?.cancel();
          if ([401, 403].includes(delivered.status) && !input.allowPropagation)
            throw new ProviderHttpError(
              "Public download denied: check public-read policy and CDN origin/deployment in the provider console",
              delivered.status,
            );
          return undefined;
        }
        if ((await delivered.text()) !== content)
          throw new Error(
            "PUBLIC_BASE_URL returned different content; correct the CDN origin/path mapping.",
          );
        if (input.cdn === "cloudflare" && !delivered.headers.has("cf-ray"))
          throw new Error("The download is not going through Cloudflare.");
        if (input.cdn === "cloudfront" && !delivered.headers.has("x-amz-cf-id"))
          throw new Error("The download is not going through CloudFront.");
        return true;
      },
      180_000,
    );
    const internalDelivery = await anonymous(
      `${storage.publicBaseUrl.replace(/\/$/u, "")}/${internalKey}`,
    );
    await internalDelivery.body?.cancel();
    if (![401, 403, 404].includes(internalDelivery.status))
      throw new Error("The download URL does not deny internal-object access.");
    if (input.cdn && input.purge) {
      const purgeTimeoutMs = input.cdn === "cloudfront" ? 600_000 : 120_000;
      const cacheExpiresAt = await wait(
        "Cacheable probe reaches the CDN cache",
        async () => {
          const requestedAt = now();
          const hit = await anonymous(url);
          if (!hit.ok || (await hit.text()) !== content)
            throw new Error("CDN cache probe returned unexpected content.");
          const cached = input.cdn === "cloudflare"
            ? hit.headers.get("cf-cache-status") === "HIT"
            : /Hit from cloudfront/iu.test(hit.headers.get("x-cache") ?? "");
          if (!cached) return undefined;
          const age = hit.headers.get("age");
          const ttl = /(?:^|,)\s*s-maxage=(\d+)(?:\s*,|\s*$)/iu.exec(
            hit.headers.get("cache-control") ?? "",
          )?.[1];
          if (age === null || !/^\d+$/u.test(age) || ttl === undefined)
            throw new Error("CDN cache probe requires Age and Cache-Control s-maxage headers to verify purge before natural expiry.");
          // Age is rounded to seconds; expire conservatively before natural expiry.
          const expiresAt = requestedAt + (Math.min(Number(ttl), STORAGE_PROBE_TTL_SECONDS) - Number(age) - 1) * 1000;
          // Leave time for replacement, the purge request and response latency.
          if (expiresAt - now() <= purgeTimeoutMs + 60_000)
            throw new Error(`CDN cache probe expires too soon to verify purge. Respect origin Cache-Control and allow a maximum TTL of at least ${STORAGE_PROBE_TTL_SECONDS} seconds.`);
          return expiresAt;
        },
        60_000,
      );
      const assertNotExpired = () => {
        if (now() >= cacheExpiresAt)
          throw new Error("CDN cache probe expired naturally before purge could be verified. Retry verification.");
      };
      const fresh = `${content}-replacement`;
      const replace = await request(
        "PUT",
        storage.publicBucket,
        publicKey,
        fresh,
      );
      if (!replace.ok)
        throw new ProviderHttpError("Replace cached probe", replace.status);
      assertNotExpired();
      await input.purge(url);
      await wait(
        "Fresh content after cache purge",
        async () => {
          assertNotExpired();
          const response = await anonymous(url);
          const body = await response.text();
          assertNotExpired();
          return response.ok && body === fresh
            ? true
            : undefined;
        },
        purgeTimeoutMs,
      );
    }
  } finally {
    for (const [bucket, key] of created) {
      try {
        const result = await request(
          "DELETE",
          bucket,
          key,
          undefined,
          input.cleanupFetch ?? fetcher,
        );
        if (!result.ok && result.status !== 404)
          input.cleanupWarning(
            `Could not remove probe ${bucket}/${key}. Delete this object in the storage console.`,
          );
      } catch {
        input.cleanupWarning(
          `Could not remove probe ${bucket}/${key}. Delete this object in the storage console.`,
        );
      }
    }
  }
}
