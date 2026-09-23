import { PromptAbortError } from "../../prompt";
import { PRODUCT_NAME } from "../../branding";
import { renderR2SetupCredential } from "../../selfhostSetupCopy";
import { createHash } from "node:crypto";
import { ProviderHttpError } from "../../providers/providerError";
import {
  buildR2TokenTemplateUrl,
  checkCacheRule,
  cloudflareRequest,
  createCacheRule,
  R2_CACHE_RULE,
} from "../../providers/cloudflare";
import { findZoneApex } from "../../selfhostDns";
import { UsageError } from "../shared";
import {
  approveSetup,
  offerStorageCredential,
  cleanupSetup,
  recordResource,
  recordCleanupWarning,
  setupFailure,
  storageValue,
  waitReady,
  type SetupContext,
  type ExternalStorage,
} from "./storageSetup";
import type { DeliverySelection } from "../../selfhostInstall";

export async function setupR2(
  ctx: SetupContext,
  retainVerificationCredential?: (
    token: string,
    cleanup: () => Promise<void>,
  ) => void,
): Promise<{ storage: ExternalStorage; delivery: DeliverySelection; waitUntilReady: () => Promise<void> }> {
  const { deps, parsed, plan } = ctx;
  const accountId = plan.accountId!;
  const domain = plan.downloadDomain!;
  const resources: string[] = [];
  const consoleUrl = `https://dash.cloudflare.com/${accountId}/api-tokens`;
  await offerStorageCredential(ctx, {
    sources: [{ flag: "--r2-setup-token", env: "CMPATCH_R2_SETUP_TOKEN" }],
    instructions: renderR2SetupCredential(accountId),
    url: buildR2TokenTemplateUrl({ name: `${PRODUCT_NAME} R2 setup` }),
    message: "Open Cloudflare to create an R2 setup token?",
  });
  const setupToken = await storageValue(
    deps,
    parsed,
    "--r2-setup-token",
    "CMPATCH_R2_SETUP_TOKEN",
    "R2 account setup token",
    undefined,
    true,
  );
  const api = { fetch: ctx.fetch, apiToken: setupToken };
  let setupId: string | undefined;
  let retained = false;
  let approved = false;
  // A token Cloudflare could not authenticate is a typo, not a live
  // credential whose id went missing; the revoke reminder is for the latter.
  // A 403 is a live token without the right scope, so it is not a typo.
  let rejected = false;
  const cleanup = async () => {
    if (setupId)
      await cleanupSetup(ctx, setupId, consoleUrl, () =>
        cloudflareRequest({
          fetch: deps.fetch,
          apiToken: setupToken,
          path: `/accounts/${accountId}/tokens/${setupId}`,
          method: "DELETE",
        }),
      );
    else if (!rejected)
      recordCleanupWarning(
        ctx,
        `SETUP CREDENTIAL CLEANUP REQUIRED: the token could not be identified. Revoke the disposable setup token at ${consoleUrl}.`,
      );
  };
  let step = "Verify R2 setup token and download zone";
  try {
    let verified: { id: string; status: string };
    try {
      verified = await cloudflareRequest<{ id: string; status: string }>({
        ...api,
        path: `/accounts/${accountId}/tokens/verify`,
      });
    } catch (error) {
      rejected =
        error instanceof ProviderHttpError && [400, 401].includes(error.status);
      throw error;
    }
    setupId = verified.id;
    if (!setupId || verified.status !== "active")
      throw new UsageError("The selected account token is not active.");
    const zoneName = await findZoneApex(domain, deps.dnsClient);
    if (!zoneName)
      throw new UsageError(
        "The download domain has no discoverable DNS zone. Configure its Cloudflare zone first.",
      );
    const zones = await cloudflareRequest<
      { id: string; account: { id: string }; status: string }[]
    >({
      ...api,
      path: `/zones?name=${encodeURIComponent(zoneName)}&account.id=${accountId}`,
    });
    const zone = zones.find(
      (z) => z.account.id === accountId && z.status === "active",
    );
    if (!zone)
      throw new UsageError(
        "The download zone must be active in the selected Cloudflare account. Explicit R2 selection does not bypass this requirement.",
      );
    const groups = await cloudflareRequest<{ id: string; name: string }[]>({
      ...api,
      path: `/accounts/${accountId}/tokens/permission_groups`,
    });
    const group = (name: string) => {
      const found = groups.find((g) => g.name === name);
      if (!found)
        throw new UsageError(
          `The account token API did not expose ${name}. Check the setup token template.`,
        );
      return { id: found.id };
    };
    const objectPermission = group("Workers R2 Storage Bucket Item Write");
    const purgePermission = group("Cache Purge");
    const zonePermission = group("Zone Read");
    const storageReadPermission = group("Workers R2 Storage Read");
    for (const bucket of [plan.publicBucket, plan.internalBucket]) {
      step = `Check R2 bucket ${bucket}`;
      try {
        await cloudflareRequest({
          ...api,
          path: `/accounts/${accountId}/r2/buckets/${bucket}`,
        });
        throw new UsageError(
          `R2 bucket ${bucket} already exists. Choose a new name or guided setup; its settings will not be changed.`,
        );
      } catch (error) {
        if (!(error instanceof ProviderHttpError) || error.status !== 404)
          throw error;
      }
    }
    step = "Check R2 download cache rule";
    await checkCacheRule({ ...api, zoneId: zone.id, domain, profile: R2_CACHE_RULE });
    await approveSetup(
      ctx,
      `Cloudflare account ${accountId}, zone ${zoneName}`,
    );
    approved = true;
    for (const bucket of [plan.publicBucket, plan.internalBucket]) {
      step = `Create R2 bucket ${bucket}`;
      await cloudflareRequest({
        ...api,
        path: `/accounts/${accountId}/r2/buckets`,
        method: "POST",
        body: { name: bucket },
      });
      recordResource(ctx, resources, `R2 bucket ${bucket}`);
      // Explicitly disable r2.dev; only the public bucket gets the custom domain.
      await cloudflareRequest({
        ...api,
        path: `/accounts/${accountId}/r2/buckets/${bucket}/domains/managed`,
        method: "PUT",
        body: { enabled: false },
      });
    }
    step = "Attach R2 download domain";
    await cloudflareRequest({
      ...api,
      path: `/accounts/${accountId}/r2/buckets/${plan.publicBucket}/domains/custom`,
      method: "POST",
      body: { domain, enabled: true, zoneId: zone.id, minTLS: "1.2" },
    });
    recordResource(ctx, resources, `R2 custom domain ${domain}`);
    step = "Configure R2 cache rule";
    await createCacheRule({ ...api, zoneId: zone.id, domain, profile: R2_CACHE_RULE });
    step = "Create R2 runtime token";
    const runtime = await cloudflareRequest<{ id: string; value: string }>({
      ...api,
      path: `/accounts/${accountId}/tokens`,
      method: "POST",
      body: {
        name: `Patch ${plan.publicBucket} runtime`,
        policies: [
          {
            effect: "allow",
            resources: Object.fromEntries(
              [plan.publicBucket, plan.internalBucket].map((bucket) => [
                `com.cloudflare.edge.r2.bucket.${accountId}_default_${bucket}`,
                "*",
              ]),
            ),
            permission_groups: [objectPermission],
          },
          {
            effect: "allow",
            resources: { [`com.cloudflare.api.account.zone.${zone.id}`]: "*" },
            permission_groups: [purgePermission, zonePermission],
          },
          {
            effect: "allow",
            resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
            permission_groups: [storageReadPermission],
          },
        ],
      },
    });
    if (!runtime.id || !runtime.value)
      throw new UsageError(
        "Cloudflare returned no runtime token; inspect account tokens before retrying.",
      );
    recordResource(ctx, resources, `R2 runtime token ${runtime.id}`);
    const waitUntilReady = async () => {
      await waitReady(
        ctx,
        "Wait for R2 custom domain",
        async () => {
          const result = await cloudflareRequest<{
            enabled: boolean;
            status?: { ownership?: string; ssl?: string };
          }>({
            ...api,
            path: `/accounts/${accountId}/r2/buckets/${plan.publicBucket}/domains/custom/${domain}`,
          });
          if (
            ["blocked", "error", "deactivated"].includes(
              result.status?.ownership ?? "",
            ) ||
            result.status?.ssl === "error"
          )
            throw new UsageError(
              `Cloudflare cannot activate ${domain}; inspect R2 → ${plan.publicBucket} → Settings → Custom Domains.`,
            );
          return result.enabled &&
            result.status?.ownership === "active" &&
            result.status?.ssl === "active"
            ? true
            : undefined;
        },
        180_000,
      );
    };
    // The caller owns cleanup through its verification/retry loop once retained.
    if (retainVerificationCredential) {
      retainVerificationCredential(setupToken, cleanup);
      retained = true;
    } else {
      step = "Wait for R2 custom domain";
      await waitUntilReady();
    }
    return {
      waitUntilReady,
      storage: {
        kind: "r2",
        publicBucket: plan.publicBucket,
        internalBucket: plan.internalBucket,
        region: "auto",
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        forcePathStyle: true,
        accessKeyId: runtime.id,
        secretAccessKey: createHash("sha256")
          .update(runtime.value)
          .digest("hex"),
        publicBaseUrl: `https://${domain}`,
      },
      delivery: {
        kind: "cloudflare",
        apiToken: runtime.value,
        zoneId: zone.id,
      },
    };
  } catch (error) {
    // A retryable pre-approval failure keeps the token until setup ends.
    // Prompt cancellation stays local because setupFailure preserves the abort.
    if (!approved && !(error instanceof PromptAbortError)) retained = true;
    throw setupFailure(ctx, step, error, resources, approved, approved ? undefined : cleanup);
  } finally {
    if (!retained) await cleanup();
  }
}
