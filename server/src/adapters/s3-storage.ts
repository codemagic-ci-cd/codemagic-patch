/**
 * S3StorageAdapter — S3-compatible implementation of StorageAdapter.
 *
 * Works against AWS S3 directly and S3-compatible backends (MinIO,
 * Cloudflare R2, etc.) via endpoint override + path-style addressing.
 *
 * Streaming: all uploads go through `@aws-sdk/lib-storage` `Upload`,
 * which transparently splits large bodies into multipart parts.
 *
 * Metadata: S3 lowercases user-metadata keys at storage time. Callers
 * round-tripping metadata should treat keys as lowercase on read.
 */

import { Readable } from "node:stream";

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  NotFound,
  type S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

import type {
  GetResult,
  HeadResult,
  ListOptions,
  ListResult,
  PutOptions,
  PutResult,
  StorageAdapter,
} from "./storage";

export interface S3StorageAdapterOptions {
  bucket: string;
  client: S3Client;
}

export class S3StorageAdapter implements StorageAdapter {
  private readonly bucket: string;
  private readonly client: S3Client;

  constructor(options: S3StorageAdapterOptions) {
    if (options.bucket.length === 0) {
      throw new Error("S3StorageAdapter: bucket must not be empty");
    }

    this.bucket = options.bucket;
    this.client = options.client;
  }

  async put(
    key: string,
    body: Readable | Buffer,
    options?: PutOptions,
  ): Promise<PutResult> {
    let observedSize: number | null = Buffer.isBuffer(body) ? body.length : null;

    const upload = new Upload({
      client: this.client,
      params: {
        Body: body,
        Bucket: this.bucket,
        CacheControl: options?.cacheControl,
        ContentType: options?.contentType,
        Key: key,
        Metadata: options?.metadata,
      },
    });

    if (observedSize === null) {
      upload.on("httpUploadProgress", (progress) => {
        if (typeof progress.total === "number") {
          observedSize = progress.total;
        } else if (typeof progress.loaded === "number") {
          observedSize = progress.loaded;
        }
      });
    }

    const result = await upload.done();

    return {
      etag: stripETagQuotes(result.ETag),
      size: observedSize ?? 0,
    };
  }

  async get(key: string): Promise<GetResult | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );

      const body = response.Body;
      if (!body) {
        return null;
      }

      return {
        body: toReadable(body),
        contentType: response.ContentType ?? null,
        etag: stripETagQuotes(response.ETag) ?? null,
        metadata: response.Metadata ? { ...response.Metadata } : {},
        size: typeof response.ContentLength === "number" ? response.ContentLength : null,
      };
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  async getBuffer(key: string): Promise<Buffer | null> {
    const result = await this.get(key);
    if (!result) {
      return null;
    }
    return streamToBuffer(result.body);
  }

  async head(key: string): Promise<HeadResult | null> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );

      return {
        contentType: response.ContentType ?? null,
        etag: stripETagQuotes(response.ETag) ?? null,
        lastModified: response.LastModified ?? null,
        metadata: response.Metadata ? { ...response.Metadata } : {},
        size: typeof response.ContentLength === "number" ? response.ContentLength : 0,
      };
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async list(prefix: string, options?: ListOptions): Promise<ListResult> {
    const response = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        ContinuationToken: options?.cursor,
        MaxKeys: options?.maxKeys,
        Prefix: prefix,
      }),
    );

    const keys: string[] = [];
    for (const item of response.Contents ?? []) {
      if (typeof item.Key === "string") {
        keys.push(item.Key);
      }
    }

    return {
      cursor: response.NextContinuationToken,
      isTruncated: response.IsTruncated === true,
      keys,
    };
  }

  async copy(sourceKey: string, destinationKey: string): Promise<void> {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${encodeS3CopySource(sourceKey)}`,
        Key: destinationKey,
      }),
    );
  }

  /**
   * Release underlying S3 client resources. Safe to call multiple times.
   */
  dispose(): void {
    this.client.destroy();
  }
}

function isNotFoundError(error: unknown): boolean {
  if (error instanceof NoSuchKey || error instanceof NotFound) {
    return true;
  }

  if (typeof error === "object" && error !== null) {
    const candidate = error as {
      $metadata?: { httpStatusCode?: number };
      Code?: string;
      name?: string;
    };

    if (candidate.$metadata?.httpStatusCode === 404) {
      return true;
    }

    if (candidate.name === "NoSuchKey" || candidate.name === "NotFound") {
      return true;
    }

    if (candidate.Code === "NoSuchKey" || candidate.Code === "NotFound") {
      return true;
    }
  }

  return false;
}

function stripETagQuotes(etag: string | undefined): string | undefined {
  if (etag === undefined) {
    return undefined;
  }

  return etag.replace(/^"+|"+$/g, "");
}

function encodeS3CopySource(key: string): string {
  return key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function toReadable(body: unknown): Readable {
  if (body instanceof Readable) {
    return body;
  }

  if (typeof (body as { transformToWebStream?: () => unknown }).transformToWebStream === "function") {
    const webStream = (body as { transformToWebStream: () => ReadableStream<Uint8Array> }).transformToWebStream();
    return Readable.fromWeb(webStream as Parameters<typeof Readable.fromWeb>[0]);
  }

  throw new Error("S3StorageAdapter: unsupported response body shape");
}

function streamToBuffer(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}
