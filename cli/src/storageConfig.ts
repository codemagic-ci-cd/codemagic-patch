export type StorageConfig =
  | { kind: "bundled"; storageDomain: string }
  | {
      kind: "r2" | "s3";
      publicBucket: string;
      internalBucket: string;
      region: string;
      endpoint?: string;
      forcePathStyle: boolean;
      accessKeyId: string;
      secretAccessKey: string;
      publicBaseUrl: string;
    }
  | {
      kind: "gcs";
      publicBucket: string;
      internalBucket: string;
      credentialsJson: string;
      publicBaseUrl: string;
    };

export function buildStorageEnv(
  storage: StorageConfig,
): Record<string, string> {
  if (storage.kind === "bundled")
    return { CODEMAGIC_PATCH_STORAGE_DOMAIN: storage.storageDomain };
  if (storage.publicBucket === storage.internalBucket)
    throw new Error("Public and internal buckets must differ.");
  const common = {
    SELFHOST_STORAGE_MODE: storage.kind === "r2" ? "s3" : storage.kind,
    PUBLIC_BASE_URL: storage.publicBaseUrl,
  };
  if (storage.kind === "gcs")
    return {
      ...common,
      GCS_PUBLIC_BUCKET: storage.publicBucket,
      GCS_INTERNAL_BUCKET: storage.internalBucket,
      GCS_CREDENTIALS_JSON_BASE64: Buffer.from(
        storage.credentialsJson,
      ).toString("base64"),
    };
  return {
    ...common,
    S3_BUCKET: storage.publicBucket,
    S3_INTERNAL_BUCKET: storage.internalBucket,
    S3_REGION: storage.region,
    S3_ENDPOINT: storage.endpoint ?? "",
    S3_FORCE_PATH_STYLE: String(storage.forcePathStyle),
    S3_ACCESS_KEY_ID: storage.accessKeyId,
    S3_SECRET_ACCESS_KEY: storage.secretAccessKey,
  };
}
