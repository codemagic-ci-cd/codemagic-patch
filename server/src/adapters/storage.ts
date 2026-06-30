/**
 * StorageAdapter — object storage abstraction.
 *
 * Abstracts S3, GCS, Azure Blob, or local filesystem behind a uniform
 * key-value interface. Both the API server (upload staging) and the
 * release worker (artifact publish) use this adapter.
 *
 * Design rationale (from infra-tech-spec.md and server-tech-spec.md):
 *   - All storage tiers (staging, internal, public) share one logical key
 *     space. Backends may keep that key space in one physical bucket or route
 *     private `_internal/` keys to a separate storage tier.
 *   - Keys are opaque strings; path semantics are the caller's concern.
 *   - Streaming is required — bundle ZIPs and tar.zst archives can be
 *     tens of megabytes.
 */

import type { Readable } from "node:stream";

// ---------------------------------------------------------------------------
// Core interface
// ---------------------------------------------------------------------------

export interface StorageAdapter {
  /**
   * Upload an object from a readable stream.
   * Overwrites if the key already exists (put-if-absent is NOT required
   * because worker artifacts are content-addressed or idempotent).
   */
  put(
    key: string,
    body: Readable | Buffer,
    options?: PutOptions,
  ): Promise<PutResult>;

  /**
   * Read an object as a readable stream.
   * Returns null if the key does not exist.
   */
  get(key: string): Promise<GetResult | null>;

  /**
   * Read an object fully into a Buffer.
   * Convenience wrapper; implementations may optimize for small objects.
   * Returns null if the key does not exist.
   */
  getBuffer(key: string): Promise<Buffer | null>;

  /**
   * Check whether an object exists and optionally return its metadata.
   */
  head(key: string): Promise<HeadResult | null>;

  /**
   * Delete an object. No-op if the key does not exist.
   */
  delete(key: string): Promise<void>;

  /**
   * List object keys matching a prefix.
   * Returns keys sorted lexicographically.
   * Supports pagination via cursor for backends with page-size limits.
   */
  list(prefix: string, options?: ListOptions): Promise<ListResult>;

  /**
   * Copy an object from one key to another within the logical key space.
   * Used by the worker to promote internal artifacts to public keys.
   */
  copy(sourceKey: string, destinationKey: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

export interface PutOptions {
  /** MIME content type (e.g. "application/zstd", "application/json"). */
  contentType?: string;
  /** Cache-Control header value for publicly served objects. */
  cacheControl?: string;
  /**
   * Caller-managed metadata, round-tripped through get/head.
   *
   * Maps to S3 user metadata (x-amz-meta-*), GCS custom metadata
   * (x-goog-meta-*), or Azure blob metadata. Keys and values are
   * strings; backends may lowercase keys.
   *
   * The worker stores `content_hash` here so that Phase 2 can
   * compare manifest staleness without re-downloading the body.
   */
  metadata?: Record<string, string>;
}

export interface PutResult {
  /** Storage-computed ETag (opaque, backend-specific). */
  etag?: string;
  /** Byte size written. */
  size: number;
}

export interface GetResult {
  body: Readable;
  size: number | null;
  contentType: string | null;
  etag: string | null;
  /** Caller-managed metadata, round-tripped from put(). */
  metadata: Record<string, string>;
}

export interface HeadResult {
  size: number;
  contentType: string | null;
  etag: string | null;
  lastModified: Date | null;
  /** Caller-managed metadata, round-tripped from put(). */
  metadata: Record<string, string>;
}

export interface ListOptions {
  /** Maximum number of keys to return per page. */
  maxKeys?: number;
  /** Continuation token from a previous truncated response. */
  cursor?: string;
}

export interface ListResult {
  keys: string[];
  /** If true, more keys exist beyond this page. */
  isTruncated: boolean;
  /** Pass to the next list() call to fetch the next page. */
  cursor?: string;
}
