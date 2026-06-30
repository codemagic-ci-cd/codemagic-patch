/**
 * InMemoryStorageAdapter — in-memory implementation for testing.
 *
 * Stores all objects as Buffers in a Map. Suitable for unit and
 * integration tests where real object storage is not needed.
 */

import { Readable } from "node:stream";

import type {
  GetResult,
  HeadResult,
  ListOptions,
  ListResult,
  PutOptions,
  PutResult,
  StorageAdapter,
} from "./storage";

interface StoredObject {
  body: Buffer;
  contentType: string | null;
  cacheControl: string | null;
  metadata: Record<string, string>;
  lastModified: Date;
}

export class InMemoryStorageAdapter implements StorageAdapter {
  private readonly store = new Map<string, StoredObject>();

  // -- Inspection helpers (for tests) -------------------------------------

  /** Returns all stored keys, sorted lexicographically. */
  keys(): string[] {
    return [...this.store.keys()].sort();
  }

  /** Returns true if the store is empty. */
  isEmpty(): boolean {
    return this.store.size === 0;
  }

  /** Clear all stored objects. */
  clear(): void {
    this.store.clear();
  }

  /** Get raw buffer for a key (test helper, bypasses streaming). */
  getRawBuffer(key: string): Buffer | undefined {
    return this.store.get(key)?.body;
  }

  /** Get metadata for a key (test helper). */
  getMetadata(key: string): Record<string, string> | undefined {
    return this.store.get(key)?.metadata;
  }

  /** Get Cache-Control for a key (test helper). */
  getCacheControl(key: string): string | null | undefined {
    return this.store.get(key)?.cacheControl;
  }

  // -- StorageAdapter implementation --------------------------------------

  async put(
    key: string,
    body: Readable | Buffer,
    options?: PutOptions,
  ): Promise<PutResult> {
    const buffer = Buffer.isBuffer(body) ? body : await streamToBuffer(body);

    this.store.set(key, {
      body: buffer,
      cacheControl: options?.cacheControl ?? null,
      contentType: options?.contentType ?? null,
      lastModified: new Date(),
      metadata: options?.metadata ? { ...options.metadata } : {},
    });

    return { size: buffer.length };
  }

  async get(key: string): Promise<GetResult | null> {
    const obj = this.store.get(key);
    if (!obj) return null;

    return {
      body: Readable.from(obj.body),
      contentType: obj.contentType,
      etag: null,
      metadata: { ...obj.metadata },
      size: obj.body.length,
    };
  }

  async getBuffer(key: string): Promise<Buffer | null> {
    const obj = this.store.get(key);
    return obj?.body ?? null;
  }

  async head(key: string): Promise<HeadResult | null> {
    const obj = this.store.get(key);
    if (!obj) return null;

    return {
      contentType: obj.contentType,
      etag: null,
      lastModified: obj.lastModified,
      metadata: { ...obj.metadata },
      size: obj.body.length,
    };
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(prefix: string, options?: ListOptions): Promise<ListResult> {
    const allKeys: string[] = [];
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        allKeys.push(key);
      }
    }
    allKeys.sort();

    // Simulate pagination
    const maxKeys = options?.maxKeys ?? allKeys.length;
    const startIndex = options?.cursor ? parseInt(options.cursor, 10) : 0;
    const page = allKeys.slice(startIndex, startIndex + maxKeys);
    const nextIndex = startIndex + maxKeys;
    const isTruncated = nextIndex < allKeys.length;

    return {
      cursor: isTruncated ? String(nextIndex) : undefined,
      isTruncated,
      keys: page,
    };
  }

  async copy(sourceKey: string, destinationKey: string): Promise<void> {
    const obj = this.store.get(sourceKey);
    if (!obj) {
      throw new Error(`InMemoryStorageAdapter.copy: source key not found: ${sourceKey}`);
    }

    this.store.set(destinationKey, {
      ...obj,
      body: Buffer.from(obj.body),
      lastModified: new Date(),
      metadata: { ...obj.metadata },
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function streamToBuffer(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}
