import { randomUUID } from "node:crypto";

import {
  CloudFrontClient,
  CreateInvalidationCommand,
  type CreateInvalidationCommandOutput,
} from "@aws-sdk/client-cloudfront";

import { BaseUrlDeliveryAdapter } from "./base-url-delivery";
import type {
  DeliveryAdapter,
  PurgeFailure,
  PurgeOptions,
  PurgeResult,
} from "./delivery";

const CLOUDFRONT_INVALIDATION_BATCH_SIZE = 1_000;
const CLOUDFRONT_REGION = "us-east-1";

export interface CloudFrontInvalidationClient {
  send(
    command: CreateInvalidationCommand,
  ): Promise<CreateInvalidationCommandOutput>;
}

export interface CloudFrontDeliveryAdapterOptions {
  accessKeyId?: string;
  baseUrl: string;
  callerReferenceFactory?: () => string;
  client?: CloudFrontInvalidationClient;
  distributionId: string;
  secretAccessKey?: string;
}

type InvalidationBatchResult =
  | { ok: true; paths: string[] }
  | { ok: false; paths: string[]; reason: string };

/**
 * Resolves public artifact URLs through CloudFront and invalidates mutable
 * viewer paths after state changes.
 *
 * CloudFront invalidations are best-effort. SDK failures are returned as
 * PurgeFailure values and never escape this adapter.
 */
export class CloudFrontDeliveryAdapter implements DeliveryAdapter {
  private readonly callerReferenceFactory: () => string;
  private readonly client: CloudFrontInvalidationClient;
  private readonly distributionId: string;
  private readonly resolver: BaseUrlDeliveryAdapter;

  constructor(options: CloudFrontDeliveryAdapterOptions) {
    this.resolver = new BaseUrlDeliveryAdapter({ baseUrl: options.baseUrl });
    this.distributionId = options.distributionId;
    this.callerReferenceFactory =
      options.callerReferenceFactory ?? defaultCallerReference;
    this.client =
      options.client ??
      new CloudFrontClient({
        credentials:
          options.accessKeyId && options.secretAccessKey
            ? {
                accessKeyId: options.accessKeyId,
                secretAccessKey: options.secretAccessKey,
              }
            : undefined,
        region: CLOUDFRONT_REGION,
      });
  }

  resolveUrl(publicKey: string): string {
    return this.resolver.resolveUrl(publicKey);
  }

  async purge(paths: string[], options: PurgeOptions): Promise<PurgeResult> {
    const invalidationPaths =
      options.scope === "artifact-delete"
        ? this.collapseDeploymentPaths(paths)
        : paths.map((path) => this.viewerPath(path));
    const batches = chunk(
      invalidationPaths,
      CLOUDFRONT_INVALIDATION_BATCH_SIZE,
    );
    const results = await Promise.all(
      batches.map((batch) => this.invalidateBatch(batch)),
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
      requested: invalidationPaths.length,
      succeeded,
    };
  }

  private collapseDeploymentPaths(paths: string[]): string[] {
    const deploymentKeys = new Set(
      paths
        .map((path) => path.replace(/^\/+/, "").split("/", 1)[0])
        .filter((key) => key.length > 0),
    );

    return [...deploymentKeys].sort().map((deploymentKey) => {
      const deploymentRoot = this.viewerPath(`${deploymentKey}/`);
      return `${deploymentRoot}*`;
    });
  }

  private viewerPath(publicKey: string): string {
    // CloudFront invalidates viewer paths, not origin paths. Derive the path
    // from resolveUrl so a PUBLIC_BASE_URL prefix (and a GCS Origin path) stays
    // aligned. CreateInvalidation accepts nonexistent paths, so a naive
    // `/${publicKey}` would fail silently by leaving the real object cached.
    return new URL(this.resolveUrl(publicKey)).pathname;
  }

  private async invalidateBatch(
    paths: string[],
  ): Promise<InvalidationBatchResult> {
    try {
      await this.client.send(
        new CreateInvalidationCommand({
          DistributionId: this.distributionId,
          InvalidationBatch: {
            CallerReference: this.callerReferenceFactory(),
            Paths: {
              Items: paths,
              Quantity: paths.length,
            },
          },
        }),
      );
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

function defaultCallerReference(): string {
  return `codemagic-patch-${Date.now()}-${randomUUID()}`;
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}
