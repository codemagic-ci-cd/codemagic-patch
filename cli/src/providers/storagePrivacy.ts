import type { StorageConfig } from "../storageConfig";
import { verifyR2Domains } from "../../../scripts/selfhost/lib/r2-privacy.cjs";
import { r2Account, cloudflareRequest } from "./cloudflare";

/** R2's authenticated S3 endpoint does not describe its public domain access. */
export async function verifyR2Privacy(
  storage: Extract<StorageConfig, { kind: "r2" | "s3" }>,
  fetcher: typeof fetch,
  apiToken?: string,
): Promise<void> {
  if (!apiToken)
    throw new Error(
      "R2 privacy verification requires a runtime token with Workers R2 Storage Read permission. A separate --r2-setup-token remains available for existing installations.",
    );
  const account = r2Account(storage.endpoint);
  if (!account)
    throw new Error(
      "R2 privacy verification requires a valid account S3 endpoint.",
    );
  await verifyR2Domains(storage.publicBucket, storage.internalBucket, (path) =>
    cloudflareRequest({
      fetch: fetcher,
      apiToken,
      path: `/accounts/${account}/r2/buckets/${path}`,
    }),
  );
}
