import { renderCloudConnectorStorageSetup } from "../../selfhostSetupCopy";
import { r2Account, cloudflareRequest } from "../../providers/cloudflare";
import { findZoneApex, detectDnsProvider } from "../../selfhostDns";
import type { DeliverySelection } from "../../selfhostInstall";
import { UsageError } from "../shared";
import { notice } from "./ask";
import { collectCloudflare } from "./cloudflare";
import { collectCloudFrontBucketOrigin } from "./cloudfrontBucketOrigin";
import { type SetupContext, type ExternalStorage } from "./storageSetup";

export async function collectStorageDelivery(
  ctx: SetupContext,
  storage: ExternalStorage,
): Promise<DeliverySelection> {
  const { plan, deps, parsed } = ctx;
  if (plan.delivery === "none") return { kind: "none" };
  if (plan.delivery === "cloudfront")
    return collectCloudFrontBucketOrigin(ctx, storage);
  const domain = plan.downloadDomain!;
  const zone = await findZoneApex(domain, deps.dnsClient);
  const nameservers = zone ? await deps.dnsClient.resolveNs(zone) : [];
  if (detectDnsProvider(nameservers)?.name !== "Cloudflare")
    throw new UsageError(
      "The download domain must use an active Cloudflare zone for this delivery path.",
    );
  if (plan.kind !== "r2") {
    const origin =
      storage.kind === "gcs"
        ? `${storage.publicBucket}.storage.googleapis.com`
        : `${storage.publicBucket}.s3.${storage.region}.amazonaws.com`;
    notice(
      deps,
      renderCloudConnectorStorageSetup({
        zone: zone!,
        domain,
        origin,
        provider: plan.kind === "gcs" ? "Google Cloud Storage" : "Amazon S3",
      }),
    );
    if (
      (storage.kind === "s3" && (storage.endpoint || storage.forcePathStyle)) ||
      storage.publicBucket.includes(".")
    )
      throw new UsageError(
        "The ordinary Cloud Connector walkthrough requires a dot-free standard bucket endpoint. For custom endpoints/path-style mappings configure the connector and any prefix/rewrite explicitly, then supply the complete runtime configuration with --public-base-url.",
      );
  }
  return collectCloudflare(deps, parsed, {
    storageDomain: domain,
    nameserversAreCloudflare: true,
    zone,
  });
}

export async function validateR2Zone(
  ctx: SetupContext,
  storage: ExternalStorage,
  delivery: DeliverySelection,
): Promise<void> {
  if (storage.kind !== "r2") return;
  if (delivery.kind !== "cloudflare")
    throw new UsageError(
      "R2 requires Cloudflare delivery and a zone-scoped runtime purge token.",
    );
  const account = r2Account(storage.endpoint);
  if (!account)
    throw new UsageError(
      "R2 requires the selected account's default-jurisdiction endpoint https://<account-id>.r2.cloudflarestorage.com.",
    );
  const host = new URL(storage.publicBaseUrl).hostname;
  if (host.endsWith(".r2.dev") || host.endsWith(".r2.cloudflarestorage.com"))
    throw new UsageError(
      "R2 downloads require a custom domain, not r2.dev or the authenticated S3 endpoint.",
    );
  const zone = await cloudflareRequest<{
    account: { id: string };
    name: string;
    status: string;
  }>({
    fetch: ctx.fetch,
    apiToken: delivery.apiToken,
    path: `/zones/${delivery.zoneId}`,
  });
  if (
    zone.account.id !== account ||
    zone.status !== "active" ||
    !(host === zone.name || host.endsWith(`.${zone.name}`))
  )
    throw new UsageError(
      "The R2 endpoint account and active download zone must match. Check --s3-endpoint, --public-base-url and --cloudflare-zone-id.",
    );
}
