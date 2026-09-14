import { STORAGE_PROBE_TTL_SECONDS } from "../../providers/storageProbes";
import { applyDnsRecord } from "./dnsSetup";
import {
  buildPurgePolicy,
  checkAccessKeyId,
  checkDistributionDomain,
  checkDistributionId,
  checkSecretAccessKey,
  CONSOLE_URLS,
} from "../../providers/cloudfront";
import { awsRequest } from "../../providers/aws";
import { ProviderHttpError } from "../../providers/providerError";
import { detectDnsProvider, findZoneApex } from "../../selfhostDns";
import type { DeliverySelection } from "../../selfhostInstall";
import { supplied } from "./answers";
import { UsageError } from "../shared";
import { askChecked, notice, offerBrowserOpen } from "./ask";
import { watchAcmValidation } from "./cloudfront";
import {
  storageValue,
  type ExternalStorage,
  type SetupContext,
} from "./storageSetup";

export async function collectCloudFrontBucketOrigin(
  ctx: SetupContext,
  storage: ExternalStorage,
): Promise<DeliverySelection> {
  const { deps, parsed, plan } = ctx;
  const domain = plan.downloadDomain!;
  const hasDistribution =
    supplied(deps, parsed, { flag: "--cloudfront-distribution-id", env: "CLOUDFRONT_DISTRIBUTION_ID" }) !== undefined;
  if (!hasDistribution) {
    notice(
      deps,
      `1. At ${CONSOLE_URLS.acmRequest}, request a public certificate in us-east-1 for ${domain}. Choose DNS validation. Add the CNAME ACM supplies at your DNS provider; this wizard can check that record. Continue when ACM says Issued.`,
    );
    await offerBrowserOpen(deps, {
      message: "Open ACM for the download certificate?",
      url: CONSOLE_URLS.acmRequest,
    });
    const zone = await findZoneApex(domain, deps.dnsClient);
    const provider = detectDnsProvider(
      zone ? await deps.dnsClient.resolveNs(zone) : [],
    );
    await watchAcmValidation(deps, ctx.session, {
      storageDomain: domain,
      provider,
      zone,
    });
    const origin = new URL(
      storage.kind === "gcs"
        ? `https://storage.googleapis.com/${storage.publicBucket}`
        : storage.endpoint
          ? `${storage.endpoint.replace(/\/$/u, "")}/${storage.publicBucket}`
          : `https://${storage.publicBucket}.s3.${storage.region}.amazonaws.com`,
    );
    notice(
      deps,
      `2. At ${CONSOLE_URLS.distributionCreate}, create a distribution. ${storage.kind === "s3" && !storage.endpoint ? `Select S3 bucket ${storage.publicBucket}, Origin access: Public (no OAC).` : `Choose a custom HTTPS origin: ${origin.hostname}, Origin path: ${origin.pathname === "/" ? "(empty)" : origin.pathname}.`} Alternate domain name: ${domain}. Attach the issued ACM certificate. Redirect viewers to HTTPS; allow GET/HEAD. Use a cache policy with minimum TTL 0, maximum TTL at least ${STORAGE_PROBE_TTL_SECONDS} seconds, and no cookies or query strings in the cache key so origin Cache-Control controls expiry. Wait for Deployed. Public object access must already be allowed; CloudFront does not bypass public-access restrictions in this setup.`,
    );
    await offerBrowserOpen(deps, {
      message: "Open CloudFront to create the distribution?",
      url: CONSOLE_URLS.distributionCreate,
    });
  }
  const distributionId = await storageValue(
    deps,
    parsed,
    "--cloudfront-distribution-id",
    "CLOUDFRONT_DISTRIBUTION_ID",
    "CloudFront distribution ID",
    undefined,
    false,
    checkDistributionId,
  );
  if (!hasDistribution) {
    const distributionDomain = await askChecked(deps, {
      type: "text",
      message: "Distribution domain name (d….cloudfront.net)",
      check: checkDistributionDomain,
    });
    notice(
      deps,
      `3. At your DNS provider, set ${domain} CNAME → ${distributionDomain}. Use DNS-only if your DNS provider is Cloudflare. The final object probe checks viewer DNS/TLS and delivery after you finish the console setup.`,
    );
    await applyDnsRecord(ctx.session, { type: "CNAME", hostname: domain, value: distributionDomain });
  }
  const hasRuntimeKey = [
    { flag: "--cloudfront-access-key-id", env: "CLOUDFRONT_ACCESS_KEY_ID" },
    { flag: "--cloudfront-secret-access-key", env: "CLOUDFRONT_SECRET_ACCESS_KEY" },
  ].every((source) => supplied(deps, parsed, source)?.value);
  if (!hasRuntimeKey) {
    const account = await askChecked(deps, {
      type: "text",
      message: "AWS account ID owning this distribution (12 digits)",
      check: (value) =>
        /^\d{12}$/u.test(value) ? null : "Enter the 12-digit account ID.",
    });
    notice(
      deps,
      `4. At ${CONSOLE_URLS.iamPolicyCreate}, create this policy and attach it to a dedicated IAM user, then create an access key under its Security credentials. This key is only for runtime cache invalidation:\n${buildPurgePolicy(`arn:aws:cloudfront::${account}:distribution/${distributionId}`)}\nThe next check submits an invalidation; retain the generated runtime key.`,
    );
    await offerBrowserOpen(deps, {
      message: "Open AWS IAM to create the runtime purge policy?",
      url: CONSOLE_URLS.iamPolicyCreate,
    });
  }
  const accessKeyId = await storageValue(
    deps,
    parsed,
    "--cloudfront-access-key-id",
    "CLOUDFRONT_ACCESS_KEY_ID",
    "CloudFront runtime purge access key ID",
    undefined,
    false,
    checkAccessKeyId,
  );
  const secretAccessKey = await storageValue(
    deps,
    parsed,
    "--cloudfront-secret-access-key",
    "CLOUDFRONT_SECRET_ACCESS_KEY",
    "CloudFront runtime purge secret",
    undefined,
    true,
    checkSecretAccessKey,
  );
  return {
    kind: "cloudfront",
    origin: "bucket",
    distributionId,
    accessKeyId,
    secretAccessKey,
  };
}

export async function purgeCloudFrontProbe(
  ctx: SetupContext,
  delivery: Extract<DeliverySelection, { kind: "cloudfront" }>,
  url: string,
): Promise<void> {
  if (!delivery.accessKeyId || !delivery.secretAccessKey)
    throw new UsageError(
      "Bucket delivery verification requires a CloudFront runtime access key pair.",
    );
  const path = new URL(url).pathname;
  const body = `<InvalidationBatch xmlns="http://cloudfront.amazonaws.com/doc/2020-05-31/"><Paths><Quantity>1</Quantity><Items><Path>${path}</Path></Items></Paths><CallerReference>cmpatch-${ctx.deps.now()}-${path.split("/").pop()}</CallerReference></InvalidationBatch>`;
  const response = await awsRequest({
    fetch: ctx.fetch,
    method: "POST",
    url: `https://cloudfront.amazonaws.com/2020-05-31/distribution/${delivery.distributionId}/invalidation`,
    service: "cloudfront",
    region: "us-east-1",
    credentials: {
      accessKeyId: delivery.accessKeyId,
      secretAccessKey: delivery.secretAccessKey,
    },
    headers: { "content-type": "application/xml" },
    body,
  });
  if (!response.ok)
    throw new ProviderHttpError(
      "CloudFront probe invalidation",
      response.status,
    );
  await response.body?.cancel();
}
