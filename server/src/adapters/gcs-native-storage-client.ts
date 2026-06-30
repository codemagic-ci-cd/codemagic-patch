import type { Bucket, File, Storage } from "@google-cloud/storage";

import type {
  GcsBucketClient,
  GcsFileClient,
  GcsFileMetadata,
  GcsGetFilesNextQuery,
  GcsGetFilesOptions,
  GcsSaveOptions,
  GcsStorageClient,
  GcsWriteStreamOptions,
} from "./gcs-storage";

export function createNativeGcsStorageClient(
  storage: Storage,
): GcsStorageClient {
  return new NativeGcsStorageClient(storage);
}

class NativeGcsStorageClient implements GcsStorageClient {
  constructor(private readonly storage: Storage) {}

  bucket(name: string): GcsBucketClient {
    return new NativeGcsBucketClient(this.storage.bucket(name));
  }
}

class NativeGcsBucketClient implements GcsBucketClient {
  constructor(private readonly bucket: Bucket) {}

  file(name: string): GcsFileClient {
    return new NativeGcsFileClient(this.bucket.file(name));
  }

  async getFiles(
    options: GcsGetFilesOptions,
  ): Promise<[GcsFileClient[], GcsGetFilesNextQuery?]> {
    const [files, nextQuery] = await this.bucket.getFiles(options);
    const wrappedFiles = files.map((file) => new NativeGcsFileClient(file));
    const pageToken = nextQuery?.pageToken;

    if (typeof pageToken !== "string") {
      return [wrappedFiles];
    }

    return [wrappedFiles, { pageToken }];
  }
}

class NativeGcsFileClient implements GcsFileClient {
  constructor(private readonly file: File) {}

  get name(): string {
    return this.file.name;
  }

  copy(destination: GcsFileClient): Promise<unknown> {
    if (!(destination instanceof NativeGcsFileClient)) {
      throw new Error("Native GCS copy destination must be a native GCS file");
    }

    return this.file.copy(destination.file);
  }

  createReadStream() {
    return this.file.createReadStream();
  }

  createWriteStream(options?: GcsWriteStreamOptions) {
    return this.file.createWriteStream(options);
  }

  async getMetadata(): Promise<[GcsFileMetadata]> {
    const [metadata] = await this.file.getMetadata();
    return [metadata];
  }

  delete(options?: { ignoreNotFound?: boolean }): Promise<unknown> {
    return this.file.delete(options);
  }

  save(body: Buffer, options?: GcsSaveOptions): Promise<unknown> {
    return this.file.save(body, options);
  }
}
