import { BaseUrlDeliveryAdapter } from "./base-url-delivery";
import type { DeliveryAdapter, PurgeFailure, PurgeResult } from "./delivery";

/**
 * CloudflareDeliveryAdapter — serves artifacts from a Cloudflare-fronted origin
 * and invalidates the edge cache after a release via Cloudflare's URL purge API.
 *
 * `resolveUrl` is identical to {@link BaseUrlDeliveryAdapter}: `PUBLIC_BASE_URL`
 * is the Cloudflare domain, so manifest URLs embedded for clients are already
 * the CDN URLs. `purge` maps the public storage keys to full URLs and POSTs them
 * to `/zones/{zoneId}/purge_cache`.
 *
 * Purge is best-effort per the {@link DeliveryAdapter} contract: this method
 * never throws. HTTP errors, `success: false` bodies, and network failures are
 * captured as {@link PurgeFailure}s so the caller can log/meter them.
 */

export const DEFAULT_CLOUDFLARE_API_BASE_URL =
  "https://api.cloudflare.com/client/v4";

/**
 * Lowest public Cloudflare single-file purge per-request limit. Free/Pro/
 * Business plans currently allow 100 URLs per request; Enterprise allows more.
 * Larger purge sets are split into multiple requests.
 */
const CLOUDFLARE_PURGE_URL_BATCH_SIZE = 100;

export interface CloudflareDeliveryAdapterOptions {
  /** API token scoped to Zone > Cache Purge. */
  apiToken: string;
  /** Public base URL — the Cloudflare-fronted storage origin. */
  baseUrl: string;
  /** Zone id that contains the storage domain. */
  zoneId: string;
  /** Cloudflare API base URL. Defaults to the public API. */
  apiBaseUrl?: string;
  /** Injectable fetch implementation (defaults to the global fetch). */
  fetch?: typeof globalThis.fetch;
}

type PurgeBatchResult =
  | { ok: true; paths: string[] }
  | { ok: false; paths: string[]; reason: string };

export class CloudflareDeliveryAdapter implements DeliveryAdapter {
  private readonly resolver: BaseUrlDeliveryAdapter;
  private readonly apiToken: string;
  private readonly zoneId: string;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: CloudflareDeliveryAdapterOptions) {
    this.resolver = new BaseUrlDeliveryAdapter({ baseUrl: options.baseUrl });
    this.apiToken = options.apiToken;
    this.zoneId = options.zoneId;
    this.apiBaseUrl = trimTrailingSlash(
      options.apiBaseUrl ?? DEFAULT_CLOUDFLARE_API_BASE_URL,
    );
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  resolveUrl(publicKey: string): string {
    return this.resolver.resolveUrl(publicKey);
  }

  async purge(paths: string[]): Promise<PurgeResult> {
    const batches = chunk(paths, CLOUDFLARE_PURGE_URL_BATCH_SIZE);
    const results = await Promise.all(
      batches.map((batch) => this.purgeBatch(batch)),
    );

    const failures: PurgeFailure[] = [];
    let succeeded = 0;
    for (const result of results) {
      if (result.ok) {
        succeeded += result.paths.length;
      } else {
        for (const path of result.paths) {
          failures.push({ path, reason: result.reason });
        }
      }
    }

    return {
      failures,
      requested: paths.length,
      succeeded,
    };
  }

  private async purgeBatch(paths: string[]): Promise<PurgeBatchResult> {
    const files = paths.map((path) => this.resolveUrl(path));
    const endpoint = `${this.apiBaseUrl}/zones/${this.zoneId}/purge_cache`;

    try {
      const response = await this.fetchImpl(endpoint, {
        body: JSON.stringify({ files }),
        headers: {
          authorization: `Bearer ${this.apiToken}`,
          "content-type": "application/json",
        },
        method: "POST",
      });

      // Read the body even on a non-2xx so the Cloudflare error detail (bad
      // scope, rate limit, wrong zone, …) reaches the failure reason instead of
      // a bare status code, matching the diagnostics on the success:false path.
      const body = await readJsonObject(response);

      if (!response.ok) {
        return {
          ok: false,
          paths,
          reason: `Cloudflare purge failed with HTTP ${response.status}: ${describeCloudflareErrors(
            body?.errors,
          )}`,
        };
      }

      if (!body || body.success !== true) {
        return {
          ok: false,
          paths,
          reason: `Cloudflare purge rejected: ${describeCloudflareErrors(
            body?.errors,
          )}`,
        };
      }

      return { ok: true, paths };
    } catch (error) {
      return {
        ok: false,
        paths,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

async function readJsonObject(
  response: Response,
): Promise<Record<string, unknown> | null> {
  try {
    const value = (await response.json()) as unknown;
    if (value !== null && typeof value === "object") {
      return value as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function describeCloudflareErrors(errors: unknown): string {
  if (!Array.isArray(errors) || errors.length === 0) {
    return "unknown error";
  }

  return errors
    .map((entry) => {
      if (entry !== null && typeof entry === "object") {
        const code = (entry as { code?: unknown }).code;
        const message = (entry as { message?: unknown }).message;
        if (typeof message === "string") {
          return typeof code === "number" ? `${code}: ${message}` : message;
        }
      }
      return String(entry);
    })
    .join("; ");
}
