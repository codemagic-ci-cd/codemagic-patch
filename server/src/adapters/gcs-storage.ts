/**
 * GcsStorageAdapter — native Google Cloud Storage implementation.
 *
 * Presents one logical StorageAdapter key space while routing private
 * `_internal/*` keys to a separate internal bucket. Public OTA artifacts stay
 * in the public bucket, so PUBLIC_BASE_URL can safely point at that bucket.
 */

import { Readable, Transform, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type {
  GetResult,
  HeadResult,
  ListOptions,
  ListResult,
  PutOptions,
  PutResult,
  StorageAdapter,
} from "./storage";

export interface GcsStorageAdapterOptions {
  publicBucket: string;
  internalBucket: string;
  storage: GcsStorageClient;
}

export interface GcsStorageClient {
  bucket(name: string): GcsBucketClient;
}

export interface GcsBucketClient {
  file(name: string): GcsFileClient;
  getFiles(
    options: GcsGetFilesOptions,
  ): Promise<[GcsFileClient[], GcsGetFilesNextQuery?]>;
}

export interface GcsFileClient {
  name: string;
  copy(destination: GcsFileClient): Promise<unknown>;
  createReadStream(): Readable;
  createWriteStream(options?: GcsWriteStreamOptions): Writable;
  delete(options?: { ignoreNotFound?: boolean }): Promise<unknown>;
  getMetadata(): Promise<[GcsFileMetadata]>;
  save(body: Buffer, options?: GcsSaveOptions): Promise<unknown>;
}

export interface GcsGetFilesOptions {
  autoPaginate: false;
  maxResults?: number;
  pageToken?: string;
  prefix?: string;
}

export interface GcsGetFilesNextQuery {
  pageToken?: string;
}

export interface GcsSaveOptions {
  metadata?: GcsWriteMetadata;
}

export interface GcsWriteStreamOptions {
  metadata?: GcsWriteMetadata;
}

export interface GcsWriteMetadata {
  cacheControl?: string;
  contentType?: string;
  metadata?: Record<string, string>;
}

export interface GcsFileMetadata {
  cacheControl?: unknown;
  contentType?: unknown;
  etag?: unknown;
  metadata?: unknown;
  size?: unknown;
  timeCreated?: unknown;
  updated?: unknown;
}

export class GcsStorageAdapter implements StorageAdapter {
  private readonly internalBucket: GcsBucketClient;
  private readonly publicBucket: GcsBucketClient;

  constructor(options: GcsStorageAdapterOptions) {
    const publicBucketName = options.publicBucket.trim();
    const internalBucketName = options.internalBucket.trim();

    if (publicBucketName.length === 0) {
      throw new Error("GcsStorageAdapter: publicBucket must not be empty");
    }

    if (internalBucketName.length === 0) {
      throw new Error("GcsStorageAdapter: internalBucket must not be empty");
    }

    if (publicBucketName === internalBucketName) {
      throw new Error(
        "GcsStorageAdapter: publicBucket and internalBucket must be different",
      );
    }

    this.publicBucket = options.storage.bucket(publicBucketName);
    this.internalBucket = options.storage.bucket(internalBucketName);
  }

  async put(
    key: string,
    body: Readable | Buffer,
    options?: PutOptions,
  ): Promise<PutResult> {
    const file = this.fileForKey(key);
    const writeOptions = makeWriteOptions(options);
    const size = Buffer.isBuffer(body)
      ? await this.putBuffer(file, body, writeOptions)
      : await this.putStream(file, body, writeOptions);
    const [metadata] = await file.getMetadata();

    return {
      etag: optionalString(metadata.etag),
      size,
    };
  }

  async get(key: string): Promise<GetResult | null> {
    const file = this.fileForKey(key);
    const metadata = await this.readMetadataOrNull(file);
    if (!metadata) {
      return null;
    }

    return {
      body: file.createReadStream(),
      contentType: optionalString(metadata.contentType) ?? null,
      etag: optionalString(metadata.etag) ?? null,
      metadata: customMetadata(metadata.metadata),
      size: optionalSize(metadata.size),
    };
  }

  async getBuffer(key: string): Promise<Buffer | null> {
    const result = await this.get(key);
    if (!result) {
      return null;
    }

    return streamToBuffer(result.body);
  }

  async head(key: string): Promise<HeadResult | null> {
    const file = this.fileForKey(key);
    const metadata = await this.readMetadataOrNull(file);
    if (!metadata) {
      return null;
    }

    return {
      contentType: optionalString(metadata.contentType) ?? null,
      etag: optionalString(metadata.etag) ?? null,
      lastModified:
        optionalDate(metadata.updated) ?? optionalDate(metadata.timeCreated),
      metadata: customMetadata(metadata.metadata),
      size: optionalSize(metadata.size) ?? 0,
    };
  }

  async delete(key: string): Promise<void> {
    try {
      await this.fileForKey(key).delete({ ignoreNotFound: true });
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }
  }

  async list(prefix: string, options?: ListOptions): Promise<ListResult> {
    const bucket = this.bucketForKey(prefix);
    const [files, nextQuery] = await bucket.getFiles({
      autoPaginate: false,
      maxResults: options?.maxKeys,
      pageToken: options?.cursor,
      prefix,
    });
    const keys = files
      .map((file) => file.name)
      .filter((name) => typeof name === "string")
      .sort();
    const cursor = nonEmptyString(nextQuery?.pageToken);

    return {
      cursor,
      isTruncated: cursor !== undefined,
      keys,
    };
  }

  async copy(sourceKey: string, destinationKey: string): Promise<void> {
    const sourceFile = this.fileForKey(sourceKey);
    const destinationFile = this.fileForKey(destinationKey);

    await sourceFile.copy(destinationFile);
  }

  private async putBuffer(
    file: GcsFileClient,
    body: Buffer,
    options: GcsSaveOptions,
  ): Promise<number> {
    await file.save(body, options);
    return body.length;
  }

  private async putStream(
    file: GcsFileClient,
    body: Readable,
    options: GcsWriteStreamOptions,
  ): Promise<number> {
    let size = 0;
    const counter = new Transform({
      transform(chunk: Buffer | string | Uint8Array, encoding, callback) {
        size += chunkByteLength(chunk, encoding);
        callback(null, chunk);
      },
    });

    await pipeline(body, counter, file.createWriteStream(options));

    return size;
  }

  private async readMetadataOrNull(
    file: GcsFileClient,
  ): Promise<GcsFileMetadata | null> {
    try {
      const [metadata] = await file.getMetadata();
      return metadata;
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  private fileForKey(key: string): GcsFileClient {
    return this.bucketForKey(key).file(key);
  }

  private bucketForKey(keyOrPrefix: string): GcsBucketClient {
    return isInternalKey(keyOrPrefix) ? this.internalBucket : this.publicBucket;
  }
}

function isInternalKey(keyOrPrefix: string): boolean {
  return keyOrPrefix === "_internal" || keyOrPrefix.startsWith("_internal/");
}

function makeWriteOptions(options: PutOptions | undefined): GcsSaveOptions {
  return {
    metadata: {
      cacheControl: options?.cacheControl,
      contentType: options?.contentType,
      metadata: options?.metadata ? { ...options.metadata } : undefined,
    },
  };
}

function customMetadata(metadata: unknown): Record<string, string> {
  if (typeof metadata !== "object" || metadata === null) {
    return {};
  }

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string") {
      result[key] = value;
    }
  }

  return result;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function chunkByteLength(
  chunk: Buffer | string | Uint8Array,
  encoding: Parameters<typeof Buffer.byteLength>[1],
): number {
  if (typeof chunk === "string") {
    return Buffer.byteLength(chunk, encoding);
  }

  return chunk.byteLength;
}

function optionalSize(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function optionalDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return value;
  }

  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }

  return null;
}

function isNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as {
    code?: number | string;
    errors?: Array<{ reason?: string }>;
    name?: string;
    response?: { statusCode?: number };
    statusCode?: number;
  };

  return (
    candidate.code === 404 ||
    candidate.code === "404" ||
    candidate.statusCode === 404 ||
    candidate.response?.statusCode === 404 ||
    candidate.name === "NotFound" ||
    candidate.errors?.some((item) => item.reason === "notFound") === true
  );
}

function streamToBuffer(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}
