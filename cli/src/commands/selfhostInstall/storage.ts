import { createHash } from "node:crypto";
import { PromptAbortError } from "../../prompt";
import { type StorageConfig } from "../../storageConfig";
import {
  describeDomainProblem,
  type DeliverySelection,
} from "../../selfhostInstall";
import { s3PublicPolicy, s3RuntimePolicy } from "../../providers/aws";
import { httpsUrlProblem, runtimeAccessKeyProblem } from "./storageValidation";
import { buildR2TokenTemplateUrl, cloudflareRequest, deriveR2Credentials } from "../../providers/cloudflare";
import { verifyStorage } from "../../providers/storageProbes";
import { detectDnsProvider, findZoneApex } from "../../selfhostDns";
import {
  captureRemoteShell,
  pairedSshInvocation,
  quoteShellValue,
} from "../../remoteExec";
import {
  readBooleanFlag,
  readStringFlag,
  type ParsedArgs,
  type SelfhostSession,
} from "../selfhostSession";
import { DeclinedError, UsageError, type CommandDeps } from "../shared";
import {
  askChecked,
  askDomain,
  askSelect,
  askValue,
  notice,
  onSignal,
  offerBrowserOpen,
  holdUntilConfirmed,
} from "./ask";
import { deliveryFlagsComplete, readDelivery, supplied, suggestStorageDomain } from "./answers";
import {
  bucketProblem,
  offerStorageCredential,
  recoveryCommand,
  StorageSetupError,
  storageValue,
  suffix,
  WaitStoppedError,
  waitReady,
  type StoragePlan,
  type SetupContext,
  type ExternalStorage,
} from "./storageSetup";
import { readGcsCredentials, readStorage } from "./storageAnswers";
import { setupS3 } from "./storageS3";
import { setupGcs } from "./storageGcs";
import { setupR2 } from "./storageR2";
import { collectStorageDelivery, validateR2Zone } from "./storageDelivery";
import { purgeCloudFrontProbe } from "./cloudfrontBucketOrigin";
import { renderGuidedStorage } from "../../selfhostSetupCopy";

export const STORAGE_FLAGS = {
  "--storage-mode": "value",
  "--storage-setup": "value",
  "--download-domain": "value",
  "--s3-bucket": "value",
  "--s3-internal-bucket": "value",
  "--s3-region": "value",
  "--s3-endpoint": "value",
  "--s3-force-path-style": "value",
  "--s3-access-key-id": "value",
  "--s3-secret-access-key": "value",
  "--gcs-public-bucket": "value",
  "--gcs-internal-bucket": "value",
  "--gcs-credentials-file": "value",
  "--gcp-project": "value",
  "--gcs-location": "value",
  "--gcp-account": "value",
  "--gcp-setup-credentials-file": "value",
  "--cloudflare-account-id": "value",
  "--r2-setup-token": "value",
  "--aws-profile": "value",
  "--aws-setup-access-key-id": "value",
  "--aws-setup-secret-access-key": "value",
  "--public-base-url": "value",
  "--skip-storage-check": "boolean",
} as const;

export function storageMode(parsed: ParsedArgs): StorageConfig["kind"] {
  const mode = readStringFlag(parsed, "--storage-mode") ?? "bundled";
  if (!["bundled", "r2", "s3", "gcs"].includes(mode))
    throw new UsageError("--storage-mode must be bundled, r2, s3, or gcs.");
  if (
    mode !== "bundled" &&
    [
      "--storage-domain",
      "--storage-origin-domain",
      "--cloudfront-origin-verify-secret",
    ].some((f) => readStringFlag(parsed, f) !== undefined)
  )
    throw new UsageError(
      "External storage rejects bundled --storage-domain and host-origin settings. Use --download-domain or --public-base-url for downloads.",
    );
  const setup = readStringFlag(parsed, "--storage-setup");
  if (setup && !["automatic", "guided"].includes(setup))
    throw new UsageError("--storage-setup must be automatic or guided.");
  if (mode === "r2" && readBooleanFlag(parsed, "--cloudfront"))
    throw new UsageError(
      "R2 uses Cloudflare delivery; --cloudfront is not applicable.",
    );
  return mode as StorageConfig["kind"];
}
export async function requireStorageCapability(
  deps: CommandDeps,
  session: SelfhostSession,
): Promise<void> {
  const result = await captureRemoteShell({
    body: `cd ${quoteShellValue("remote path", session.remotePath)} && test "$(cat scripts/selfhost/external-storage-version 2>/dev/null)" = 1`,
    connection: pairedSshInvocation(session.sshTarget, session.identityFile),
    runProcess: deps.runProcess,
  });
  if (result.exitCode !== 0)
    throw new UsageError(
      "This source checkout does not support two-bucket external storage. Update the target checkout to a matching Patch version, then rerun cmpatch selfhost install. No storage resources have been created.",
    );
}
function hasRuntimeConfig(
  deps: CommandDeps,
  parsed: ParsedArgs,
  mode: string,
): boolean {
  const fields =
    mode === "gcs"
      ? [
          ["--gcs-public-bucket", "GCS_PUBLIC_BUCKET"],
          ["--gcs-internal-bucket", "GCS_INTERNAL_BUCKET"],
          ["--gcs-credentials-file", "GCS_CREDENTIALS_FILE"],
        ]
      : [
          ["--s3-bucket", "S3_BUCKET"],
          ["--s3-internal-bucket", "S3_INTERNAL_BUCKET"],
          ...(mode === "r2" &&
          supplied(deps, parsed, {
            flag: "--cloudflare-api-token",
            env: "CLOUDFLARE_API_TOKEN",
          })?.value
            ? []
            : [
                ["--s3-access-key-id", "S3_ACCESS_KEY_ID"],
                ["--s3-secret-access-key", "S3_SECRET_ACCESS_KEY"],
              ]),
          ...(mode === "r2" ? [["--s3-endpoint", "S3_ENDPOINT"]] : []),
        ];
  return [...fields, ["--public-base-url", "PUBLIC_BASE_URL"]].every(
    ([flag, env]) => !!supplied(deps, parsed, { flag: flag!, env })?.value,
  );
}

export async function chooseStorage(
  deps: CommandDeps,
  session: SelfhostSession,
  parsed: ParsedArgs,
  apiDomain: string,
  interactive: boolean,
): Promise<StoragePlan | null> {
  let mode = storageMode(parsed);
  const zone = await findZoneApex(apiDomain, deps.dnsClient);
  const onCloudflare =
    detectDnsProvider(zone ? await deps.dnsClient.resolveNs(zone) : [])
      ?.name === "Cloudflare";
  if (interactive && readStringFlag(parsed, "--storage-mode") === undefined) {
    mode = (await askSelect(deps, {
      message: "Where should update files be stored?",
      choices: [
        { title: "On this server (bundled MinIO)", value: "bundled" },
        ...(onCloudflare
          ? [
              {
                title: "Cloudflare R2 (Cloudflare storage and download domain)",
                value: "r2",
              },
            ]
          : []),
        { title: "Amazon S3 (your AWS account)", value: "s3" },
        { title: "Google Cloud Storage (your GCP project)", value: "gcs" },
      ],
      initial: 0,
      fallback: "bundled",
    })) as typeof mode;
    storageMode({
      ...parsed,
      flags: { ...parsed.flags, "--storage-mode": mode },
    });
  }
  if (mode === "bundled") {
    if (
      [
        "--s3-bucket",
        "--gcs-public-bucket",
        "--public-base-url",
        "--storage-setup",
      ].some((f) => parsed.flags[f] !== undefined)
    )
      throw new UsageError(
        "External storage options require --storage-mode r2, s3, or gcs.",
      );
    return null;
  }
  notice(
    deps,
    mode === "r2"
      ? "R2 needs an active Cloudflare download zone in the same account and enabled R2 billing. Artifacts use a custom domain; the second bucket remains private."
      : "Public artifact reads must be allowed by account/project/organization policy. Internal objects use a separate private bucket. CloudFront and guided setup do not bypass public-access restrictions. Setup never weakens account/organization policy.",
  );
  await requireStorageCapability(deps, session);
  const configured = hasRuntimeConfig(deps, parsed, mode);
  if (!interactive || configured) {
    const requiredValue = (flag: string, env: string) => {
      const value = supplied(deps, parsed, { flag, env })?.value;
      if (!value) throw new UsageError(`External storage needs ${flag} (or ${env}). Supply the existing runtime configuration and rerun cmpatch selfhost install.`);
      return value;
    };
    const publicBaseUrl = requiredValue("--public-base-url", "PUBLIC_BASE_URL");
    const urlProblem = httpsUrlProblem(publicBaseUrl);
    if (urlProblem) throw new UsageError(urlProblem);
    if (new URL(publicBaseUrl).hostname === apiDomain.toLowerCase())
      throw new UsageError(
        "The download hostname must differ from the API hostname.",
      );
    return {
      kind: mode,
      setup: "configured",
      publicBucket: requiredValue(mode === "gcs" ? "--gcs-public-bucket" : "--s3-bucket", mode === "gcs" ? "GCS_PUBLIC_BUCKET" : "S3_BUCKET"),
      internalBucket: requiredValue(mode === "gcs" ? "--gcs-internal-bucket" : "--s3-internal-bucket", mode === "gcs" ? "GCS_INTERNAL_BUCKET" : "S3_INTERNAL_BUCKET"),
      region: mode === "gcs" ? "" : supplied(deps, parsed, { flag: "--s3-region", env: "S3_REGION" })?.value ?? (mode === "r2" ? "auto" : "us-east-1"),
      delivery:
        mode === "r2" || readBooleanFlag(parsed, "--cloudflare")
          ? "cloudflare"
          : readBooleanFlag(parsed, "--cloudfront")
            ? "cloudfront"
            : "none",
      downloadDomain: new URL(publicBaseUrl).hostname,
    };
  }
  const selectedSetup = readStringFlag(parsed, "--storage-setup");
  if (selectedSetup && !["automatic", "guided"].includes(selectedSetup))
    throw new UsageError("--storage-setup must be automatic or guided.");
  const setup =
    selectedSetup ??
    (await askSelect(deps, {
      message: "How should storage be prepared?",
      choices: [
        {
          title: "Create new buckets and runtime credentials automatically",
          value: "automatic",
        },
        {
          title: "Guide me through the console / use existing resources",
          value: "guided",
        },
      ],
      fallback: "automatic",
      initial: 0,
    }));
  let delivery: StoragePlan["delivery"] =
    mode === "r2"
      ? "cloudflare"
      : readBooleanFlag(parsed, "--cloudflare")
        ? "cloudflare"
        : readBooleanFlag(parsed, "--cloudfront")
          ? "cloudfront"
          : "none";
  if (mode === "r2" && readBooleanFlag(parsed, "--cloudfront"))
    throw new UsageError(
      "R2 uses its Cloudflare custom-domain flow; --cloudfront is not applicable.",
    );
  if (
    mode !== "r2" &&
    !readBooleanFlag(parsed, "--cloudflare") &&
    !readBooleanFlag(parsed, "--cloudfront")
  ) {
    delivery = (await askSelect(deps, {
      message: "How should external downloads be delivered?",
      choices: [
        { title: "Direct storage (no CDN setup)", value: "none" },
        {
          title: "CloudFront (guided certificate, distribution and DNS setup)",
          value: "cloudfront",
        },
        ...(onCloudflare
          ? [
              {
                title: "Cloudflare Cloud Connector Beta (guided rules and DNS)",
                value: "cloudflare",
              },
            ]
          : []),
      ],
      fallback: "none",
      initial: 0,
    })) as typeof delivery;
  }
  const downloadDomain =
    delivery === "none"
      ? undefined
      : (readStringFlag(parsed, "--download-domain") ??
        (await askDomain(deps, {
          message: "What domain should external downloads use?",
          differentFrom: [apiDomain],
          initial: await suggestStorageDomain(deps, apiDomain),
          purpose:
            "This domain points at the storage/CDN, not at the API server.",
        })));
  if (
    downloadDomain &&
    (describeDomainProblem(downloadDomain) || downloadDomain.toLowerCase() === apiDomain.toLowerCase())
  )
    throw new UsageError(
      describeDomainProblem(downloadDomain) ??
        "The download hostname must differ from the API hostname.",
    );
  if (downloadDomain && delivery === "cloudflare") {
    const downloadZone = await findZoneApex(downloadDomain, deps.dnsClient);
    const nameservers = downloadZone
      ? await deps.dnsClient.resolveNs(downloadZone)
      : [];
    if (detectDnsProvider(nameservers)?.name !== "Cloudflare")
      throw new UsageError(
        "Set up the download hostname in an active Cloudflare DNS zone before provisioning storage.",
      );
  }
  const name = `patch-${apiDomain
    .split(".")[0]!
    .replace(/[^a-z0-9-]/gu, "")
    .slice(0, 24)}-${suffix()}`;
  const field = async (
    flag: string,
    env: string,
    message: string,
    initial: string,
    differentFrom?: string,
  ) => {
    const check = (value: string) => bucketProblem(value) ??
      (value === differentFrom ? "Public and internal buckets must differ." : null);
    const known = supplied(deps, parsed, { flag, env })?.value;
    if (known !== undefined) {
      const problem = check(known);
      if (problem) throw new UsageError(problem);
      return known;
    }
    return askChecked(deps, {
      message,
      type: "text",
      initial,
      check,
    });
  };
  notice(
    deps,
    "Suggested bucket names include a random suffix to reduce global-name collisions. You may edit them; the internal bucket must be different.",
  );
  const publicBucket = await field(
    mode === "gcs" ? "--gcs-public-bucket" : "--s3-bucket",
    mode === "gcs" ? "GCS_PUBLIC_BUCKET" : "S3_BUCKET",
    "Public artifact bucket",
    name,
  );
  const internalBucket = await field(
    mode === "gcs" ? "--gcs-internal-bucket" : "--s3-internal-bucket",
    mode === "gcs" ? "GCS_INTERNAL_BUCKET" : "S3_INTERNAL_BUCKET",
    "Private internal bucket",
    `${name}-internal`,
    publicBucket,
  );
  const regionProblem = (value: string) =>
    (mode === "s3"
      ? /^(us|eu|ap|sa|ca|me|af|il|mx)-(?!gov)[a-z]+-\d$/u
      : /^[A-Za-z0-9-]+$/u
    ).test(value)
      ? null
      : "Use a supported region/location. Automated S3 setup supports standard commercial AWS regions.";
  const region =
    mode === "r2"
      ? "auto"
      : await storageValue(
          deps,
          parsed,
          mode === "gcs" ? "--gcs-location" : "--s3-region",
          mode === "gcs" ? "GCS_LOCATION" : "S3_REGION",
          mode === "gcs"
            ? "GCS bucket location (near your server)"
            : "AWS region (near your server)",
          mode === "gcs" ? "US" : "us-east-1",
          false,
          regionProblem,
        );
  const project =
    mode === "gcs"
      ? await storageValue(
          deps,
          parsed,
          "--gcp-project",
          "GOOGLE_CLOUD_PROJECT",
          "GCP project ID",
          undefined,
          false,
          value => /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(value) ? null : "Enter a valid GCP project ID.",
        )
      : undefined;
  const accountId =
    mode === "r2"
      ? await storageValue(
          deps,
          parsed,
          "--cloudflare-account-id",
          "CLOUDFLARE_ACCOUNT_ID",
          "Cloudflare account ID (R2 → Overview → Account details)",
          undefined,
          false,
          value => /^[a-f0-9]{32}$/u.test(value) ? null : "Enter the 32-character Cloudflare account ID.",
        )
      : undefined;
  return {
    kind: mode,
    setup: setup as StoragePlan["setup"],
    publicBucket,
    internalBucket,
    region,
    project,
    accountId,
    downloadDomain,
    delivery,
  };
}

export async function prepareExternalStorage(
  deps: CommandDeps,
  session: SelfhostSession,
  parsed: ParsedArgs,
  plan: StoragePlan,
  interactive: boolean,
): Promise<{
  storage: ExternalStorage;
  delivery: DeliverySelection;
  storageWarnings: string[];
}> {
  const abort = new AbortController();
  const removeHook = onSignal(session, () => abort.abort());
  const storageWarnings: string[] = [];
  const ctx: SetupContext = {
    interactive,
    cleanupWarnings: storageWarnings,
    revokedSetupCredentials: new Set(),
    deps,
    session,
    parsed,
    plan,
    signal: abort.signal,
    fetch: (url, options) =>
      deps.fetch(url, {
        ...options,
        signal: options?.signal
          ? AbortSignal.any([abort.signal, options.signal])
          : abort.signal,
      }),
  };
  let storage: ExternalStorage | undefined;
  // Assigned by every branch below; the initial value only exists because
  // the retry loop hides that from definite-assignment analysis.
  let delivery: DeliverySelection = { kind: "none" };
  let r2ApiToken: string | undefined;
  let cleanupR2: (() => Promise<void>) | undefined;
  let waitUntilReady: (() => Promise<void>) | undefined;
  // Disposable setup credentials from attempts that failed before approval,
  // revoked once storage setup ends rather than before the retry.
  const deferredCleanups: Array<() => Promise<void>> = [];
  try {
    if (plan.setup === "automatic") {
      // Tried again on request while nothing has been created. Once
      // provisioning is approved a failure is reported and kept instead:
      // re-running would create a second set of resources. A retry asks for
      // the setup credentials again rather than reusing a flag or environment
      // value — the value may be the very thing that failed.
      let attemptCtx = ctx;
      for (;;) {
        try {
          if (plan.kind === "r2") {
            const result = await setupR2(attemptCtx, (token, cleanup) => {
              r2ApiToken = token;
              cleanupR2 = cleanup;
            });
            storage = result.storage;
            delivery = result.delivery;
            waitUntilReady = result.waitUntilReady;
          } else {
            storage = plan.kind === "s3" ? await setupS3(attemptCtx) : await setupGcs(attemptCtx);
          }
          break;
        } catch (error) {
          if (error instanceof StorageSetupError && error.cleanup)
            deferredCleanups.push(error.cleanup);
          if (
            !interactive ||
            !(error instanceof StorageSetupError) ||
            error.approved ||
            abort.signal.aborted
          )
            throw error;
          notice(deps, [
            error.message,
            "Trying again asks for the setup credentials afresh; a disposable credential from this attempt is revoked when storage setup ends.",
          ]);
          const next = await askSelect(deps, {
            message: "What would you like to do about the storage setup?",
            choices: [
              { title: "Try again with other setup credentials", value: "retry" },
              { title: "Change bucket names and retry", value: "buckets" },
              { title: "Stop here", value: "stop" },
            ],
            fallback: "stop",
            initial: 0,
          });
          if (next !== "retry" && next !== "buckets")
            throw new DeclinedError(
              "Storage setup stopped. Nothing was created, and the installer has not been started.",
            );
          if (next === "buckets") {
            const publicBucket = await askChecked(deps, {
              message: "Public artifact bucket",
              type: "text",
              initial: plan.publicBucket,
              check: bucketProblem,
            });
            const internalBucket = await askChecked(deps, {
              message: "Private internal bucket",
              type: "text",
              initial: plan.internalBucket,
              check: (value) =>
                value === publicBucket
                  ? "Public and internal buckets must differ."
                  : bucketProblem(value),
            });
            plan = { ...plan, publicBucket, internalBucket };
            ctx.plan = plan;
          }
          attemptCtx = withoutSetupCredentials({ ...attemptCtx, plan });
        }
      }
      if (plan.kind !== "r2") {
        let deliveryParsed = parsed;
        for (;;) {
          try {
            delivery = await collectStorageDelivery({ ...ctx, parsed: deliveryParsed }, storage);
            break;
          } catch (error) {
            if (!interactive || error instanceof PromptAbortError || abort.signal.aborted) throw error;
            notice(deps, `${error instanceof Error ? error.message : "CDN setup failed."} Created buckets and runtime credentials are retained.`);
            const next = await askSelect(deps, {
              message: "Continue CDN setup",
              choices: [
                { title: "Retry with the same settings", value: "retry" },
                ...(plan.delivery === "cloudflare" ? [{ title: "Replace Cloudflare runtime token", value: "credentials" }] : []),
              ],
              fallback: "retry",
              initial: 0,
            });
            if (next === "credentials") {
              const apiToken = await askValue(deps, { message: "Cloudflare API token", type: "password" });
              deliveryParsed = { ...parsed, flags: { ...parsed.flags, "--cloudflare-api-token": apiToken } };
            }
          }
        }
      }
      if (plan.delivery !== "none")
        storage.publicBaseUrl = `https://${plan.downloadDomain}`;
    } else {
      if (plan.setup === "guided") {
        const guide = renderGuidedStorage(plan);
        notice(deps, guide.buckets);
        if (plan.kind === "s3")
          notice(deps, `Public bucket policy: ${s3PublicPolicy(plan.publicBucket)}`);
        const bucketUrl = plan.kind === "r2"
          ? `https://dash.cloudflare.com/${plan.accountId}/r2/overview`
          : plan.kind === "gcs"
            ? `https://console.cloud.google.com/storage/browser?project=${plan.project}`
            : `https://s3.console.aws.amazon.com/s3/buckets?region=${plan.region}`;
        if (interactive) {
          await offerBrowserOpen(deps, {
            message: "Open the storage console to configure the buckets?",
            url: bucketUrl,
          });
          await holdUntilConfirmed(deps, {
            message: "Are both buckets and their access settings ready?",
            nudge: () => guide.buckets,
          });
        }
        const credentialUrl = plan.kind === "r2"
          ? `https://dash.cloudflare.com/${plan.accountId}/r2/api-tokens`
          : plan.kind === "gcs"
            ? `https://console.cloud.google.com/iam-admin/serviceaccounts?project=${plan.project}`
            : "https://console.aws.amazon.com/iam/home#/users";
        await offerStorageCredential(ctx, {
          sources: plan.kind === "r2"
            ? [{ flag: "--cloudflare-api-token", env: "CLOUDFLARE_API_TOKEN" }]
            : plan.kind === "gcs"
              ? [{ flag: "--gcs-credentials-file", env: "GCS_CREDENTIALS_FILE" }]
              : [
                  { flag: "--s3-access-key-id", env: "S3_ACCESS_KEY_ID" },
                  { flag: "--s3-secret-access-key", env: "S3_SECRET_ACCESS_KEY" },
                ],
          instructions: [
            ...guide.credentials,
            ...(plan.kind === "s3" ? [`Runtime IAM policy: ${s3RuntimePolicy(plan.publicBucket, plan.internalBucket)}`] : []),
          ],
          url: plan.kind === "r2"
            ? buildR2TokenTemplateUrl({ name: "Patch R2 runtime", runtime: true })
            : credentialUrl,
          message: "Open the console to create runtime storage credentials?",
        });
        notice(deps, guide.verification);
      }
      const flags = {
        ...parsed.flags,
        "--storage-mode": plan.kind,
        [plan.kind === "gcs" ? "--gcs-public-bucket" : "--s3-bucket"]:
          plan.publicBucket,
        [plan.kind === "gcs"
          ? "--gcs-internal-bucket"
          : "--s3-internal-bucket"]: plan.internalBucket,
      };
      if (plan.setup === "guided") {
        if (plan.kind === "r2")
          flags["--cloudflare-api-token"] = await storageValue(
            deps,
            parsed,
            "--cloudflare-api-token",
            "CLOUDFLARE_API_TOKEN",
            "Combined R2 runtime API token (storage, verification and cache purge)",
            undefined,
            true,
          );
        flags["--public-base-url"] ??= supplied(deps, parsed, { flag: "--public-base-url", env: "PUBLIC_BASE_URL" })?.value ?? (
          plan.delivery === "none"
            ? plan.kind === "gcs"
              ? `https://storage.googleapis.com/${plan.publicBucket}`
              : `https://${plan.publicBucket}.s3.${plan.region}.amazonaws.com`
            : `https://${plan.downloadDomain}`);
        if (plan.kind === "r2")
          flags["--s3-endpoint"] ??= supplied(deps, parsed, { flag: "--s3-endpoint", env: "S3_ENDPOINT" })?.value ??
            `https://${plan.accountId}.r2.cloudflarestorage.com`;
      }
      if (plan.kind !== "gcs") flags["--s3-region"] ??= supplied(deps, parsed, { flag: "--s3-region", env: "S3_REGION" })?.value ?? plan.region;
      for (;;) {
        try {
          storage = await readStorage(
            deps,
            { ...parsed, flags },
            plan.kind,
            interactive,
          );
          if (plan.setup === "configured" && (!interactive || plan.delivery === "none" ||
              (plan.delivery === "cloudflare" && deliveryFlagsComplete(deps, { ...parsed, flags }, "cloudflare")))) {
            delivery = readDelivery(deps, {
              ...parsed,
              flags: {
                ...flags,
                ...(plan.kind === "r2" ? { "--cloudflare": true as const } : {}),
              },
            });
            if (delivery.kind === "cloudfront") delivery.origin = "bucket";
          } else
            delivery = await collectStorageDelivery(
              { ...ctx, parsed: { ...parsed, flags } },
              storage,
            );
          break;
        } catch (error) {
          if (
            plan.kind !== "r2" ||
            !interactive ||
            error instanceof UsageError ||
            error instanceof PromptAbortError ||
            abort.signal.aborted
          )
            throw error;
          notice(
            deps,
            `${error instanceof Error ? error.message : "R2 setup could not be verified."} Your bucket and domain answers are retained.`,
          );
          const next = await askSelect(deps, {
            message: "Correct R2 runtime configuration",
            choices: [
              { title: "Retry with the same settings", value: "retry" },
              {
                title: "Replace the combined R2 runtime token",
                value: "credentials",
              },
            ],
            fallback: "retry",
            initial: 0,
          });
          if (next === "credentials") {
            flags["--cloudflare-api-token"] = await askValue(deps, {
              message:
                "Combined R2 runtime API token (storage, verification and cache purge)",
              type: "password",
            });
            // Explicitly clear old keys, including environment values, so the new token supplies both.
            flags["--s3-access-key-id"] = "";
            flags["--s3-secret-access-key"] = "";
          }
        }
      }
    }
    let cleanupWarnings: string[] = [];
    let action: string | undefined;
    for (;;) {
      try {
        if (action === "r2-verification")
          r2ApiToken = await askValue(deps, {
            message: "R2 verification token (Workers R2 Storage Read permission)",
            type: "password",
          });
        if (action === "url")
          storage.publicBaseUrl = await askChecked(deps, {
            message: "Public download base URL",
            type: "text",
            initial: storage.publicBaseUrl,
            check: httpsUrlProblem,
          });
        if (action === "credentials") {
          if (storage.kind === "r2" && delivery.kind === "cloudflare") {
            const apiToken = await askValue(deps, {
              message: "Combined R2 runtime API token (storage, verification and cache purge)",
              type: "password",
            });
            const keys = await deriveR2Credentials(ctx.fetch, storage.endpoint ?? "", apiToken);
            storage = { ...storage, ...keys };
            delivery = { ...delivery, apiToken };
          } else if (storage.kind === "gcs") {
            storage.credentialsJson = await readGcsCredentials(
              deps,
              await askValue(deps, {
                message: "Runtime service-account JSON file",
                type: "text",
              }),
            );
          } else {
            const kind = storage.kind;
            const accessKeyId = await askChecked(deps, {
              message: "Runtime access key ID",
              type: "text",
              check: (value) => runtimeAccessKeyProblem(kind, value),
            });
            const secretAccessKey = await askValue(deps, {
              message: "Runtime secret access key",
              type: "password",
            });
            storage = { ...storage, accessKeyId, secretAccessKey };
          }
        }
        if (action === "buckets") {
          const publicBucket = await askChecked(deps, {
            type: "text",
            message: "Public artifact bucket",
            initial: storage.publicBucket,
            check: bucketProblem,
          });
          const internalBucket = await askChecked(deps, {
            type: "text",
            message: "Private internal bucket",
            initial: storage.internalBucket,
            check: (value) =>
              value === publicBucket
                ? "Public and internal buckets must differ."
                : bucketProblem(value),
          });
          storage = { ...storage, publicBucket, internalBucket };
        }
        if (action === "delivery" && delivery.kind !== "none") {
          // Re-ask only the selected CDN's runtime fields, retaining the console work.
          const flags = { ...parsed.flags };
          const fields =
            delivery.kind === "cloudflare"
              ? ["--cloudflare-api-token", "--cloudflare-zone-id"]
              : [
                  "--cloudfront-distribution-id",
                  "--cloudfront-access-key-id",
                  "--cloudfront-secret-access-key",
                ];
          for (const flag of fields)
            flags[flag] = await askValue(deps, {
              message: flag.slice(2),
              type: /token|secret/u.test(flag) ? "password" : "text",
            });
          flags[
            delivery.kind === "cloudflare" ? "--cloudflare" : "--cloudfront"
          ] = true;
          const updatedDelivery = readDelivery(deps, { ...parsed, flags });
          if (storage.kind === "r2" && updatedDelivery.kind === "cloudflare" && delivery.kind === "cloudflare" &&
              storage.secretAccessKey === createHash("sha256").update(delivery.apiToken).digest("hex")) {
            const keys = await deriveR2Credentials(ctx.fetch, storage.endpoint ?? "", updatedDelivery.apiToken);
            storage = { ...storage, ...keys };
          }
          delivery = updatedDelivery;
          if (delivery.kind === "cloudfront") delivery.origin = "bucket";
        }
        cleanupWarnings = [];
        action = undefined;
        const verificationToken =
          r2ApiToken ??
          supplied(deps, parsed, {
            flag: "--r2-setup-token",
            env: "CMPATCH_R2_SETUP_TOKEN",
          })?.value ??
          (delivery.kind === "cloudflare" ? delivery.apiToken : undefined);
        await waitUntilReady?.();
        waitUntilReady = undefined;
        await validateR2Zone(ctx, storage, delivery);
        await verifyStorage({
          storage,
          now: deps.now,
          r2ApiToken: verificationToken,
          fetch: ctx.fetch,
          cleanupFetch: deps.fetch,
          cleanupWarning: (message) => {
            cleanupWarnings.push(message);
            notice(deps, message);
          },
          wait: (label, check, timeout) =>
            waitReady(ctx, label, check, timeout),
          allowPropagation: plan.setup === "automatic",
          ...(delivery.kind === "none"
            ? {}
            : {
                cdn: delivery.kind,
                purge: (url: string) =>
                  delivery.kind === "cloudflare"
                    ? cloudflareRequest({
                        fetch: ctx.fetch,
                        apiToken: delivery.apiToken,
                        path: `/zones/${delivery.zoneId}/purge_cache`,
                        method: "POST",
                        body: { files: [url] },
                      }).then(() => undefined)
                    : delivery.kind === "cloudfront"
                      ? purgeCloudFrontProbe(ctx, delivery, url)
                      : Promise.resolve(),
              }),
        });
        if (cleanupWarnings.length)
          throw new UsageError(
            "Probe cleanup needs manual action; remove the listed objects before retrying.",
          );
        break;
      } catch (error) {
        if (
          error instanceof PromptAbortError ||
          !interactive ||
          abort.signal.aborted
        )
          throw error;
        notice(
          deps,
          error instanceof WaitStoppedError
            ? error.message
            : `${error instanceof Error ? error.message : "Storage verification failed."} Correct the console configuration, then retry. Completed answers are retained.`,
        );
        action = await askSelect(deps, {
          message: "Correct external storage verification",
          choices: [
            { title: "Retry with the same settings", value: "retry" },
            ...(storage.kind === "r2" && plan.setup !== "automatic"
              ? [{ title: "Replace R2 verification token", value: "r2-verification" }]
              : []),
            { title: "Change the download base URL", value: "url" },
            { title: "Replace runtime credentials", value: "credentials" },
            { title: "Correct bucket names", value: "buckets" },
            ...(delivery.kind === "none"
              ? []
              : [{ title: "Replace CDN runtime settings", value: "delivery" }]),
            { title: "Stop here and keep what was created", value: "stop" },
          ],
          fallback: "retry",
          initial: 0,
        });
        if (action === "stop")
          throw new DeclinedError("Storage setup stopped. The resources created so far are kept.");
      }
    }
    notice(
      deps,
      `Verified ${storage.kind.toUpperCase()}: public ${storage.publicBucket}, internal ${storage.internalBucket}, download ${storage.publicBaseUrl}. Runtime write/read, delivery and privacy checks passed${delivery.kind === "none" ? "" : ", including cache hit and purge freshness"}. Deployment and release smoke checks follow.`,
    );
    return { storage, delivery, storageWarnings };
  } catch (error) {
    // Named whenever there are resources to come back to — the abort or stop
    // taken at a correction menu included. Only an automatic plan created
    // them; a guided or configured plan is told how to verify its own again.
    const rerun = storage && recoveryCommand(plan, storage);
    const recovery = !rerun
      ? ""
      : plan.setup === "automatic"
        ? `Storage resources are not rolled back. Reuse them with: ${rerun}. Keep runtime secrets in environment/file inputs.`
        : `To verify the storage again after correcting it: ${rerun}`;
    if (error instanceof PromptAbortError || error instanceof DeclinedError) {
      const lines = [...storageWarnings, recovery].filter(Boolean);
      if (lines.length) notice(deps, [...lines, "The installer has not been started."]);
      throw error;
    }
    const detail =
      error instanceof Error &&
      (error instanceof UsageError ||
        error.name === "ProviderHttpError" ||
        error.constructor === Error)
        ? error.message
        : "Storage setup failed or was cancelled.";
    throw new UsageError(
      [
        detail,
        ...storageWarnings,
        recovery,
        "The installer has not been started.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } finally {
    try {
      await cleanupR2?.();
      for (const cleanup of deferredCleanups) await cleanup();
    } finally {
      removeHook();
    }
  }
}

/** The flag and environment sources every setup credential can arrive by. */
const SETUP_CREDENTIAL_SOURCES = [
  ["--aws-profile", "AWS_PROFILE"],
  ["--aws-setup-access-key-id", "CMPATCH_AWS_SETUP_ACCESS_KEY_ID"],
  ["--aws-setup-secret-access-key", "CMPATCH_AWS_SETUP_SECRET_ACCESS_KEY"],
  ["--gcp-account", "CMPATCH_GCP_ACCOUNT"],
  ["--gcp-setup-credentials-file", "CMPATCH_GCP_SETUP_CREDENTIALS_FILE"],
  ["--r2-setup-token", "CMPATCH_R2_SETUP_TOKEN"],
] as const;

/** The same context with every setup credential unsupplied, so it is asked for. */
function withoutSetupCredentials(ctx: SetupContext): SetupContext {
  const flags = { ...ctx.parsed.flags };
  const env = { ...ctx.deps.env };
  for (const [flag, variable] of SETUP_CREDENTIAL_SOURCES) {
    delete flags[flag];
    delete env[variable];
  }
  return { ...ctx, parsed: { ...ctx.parsed, flags }, deps: { ...ctx.deps, env } };
}
