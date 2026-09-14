import { PromptAbortError } from "../../prompt";
import { selectStorageIdentity } from "./storageIdentity";
import { renderGcpSetupCredential } from "../../selfhostSetupCopy";
import {
  gcpRequest,
  gcsAccessToken,
  grantGcsBucket,
  parseGcsKey,
} from "../../providers/gcp";
import { ProviderHttpError } from "../../providers/providerError";
import { UsageError } from "../shared";
import { askSelect, notice } from "./ask";
import {
  approveSetup,
  offerStorageCredential,
  cleanupSetup,
  recordResource,
  recordCleanupWarning,
  setupFailure,
  storageValue,
  suffix,
  waitReady,
  type SetupContext,
  type ExternalStorage,
} from "./storageSetup";

export async function setupGcs(ctx: SetupContext): Promise<ExternalStorage> {
  const { deps, parsed, plan } = ctx;
  const project = plan.project!;
  const resources: string[] = [];
  let step = "Select GCP setup credentials";
  let token: string | undefined;
  let disposable: ReturnType<typeof parseGcsKey> | undefined;
  let approved = false;
  let deferred = false;
  const source = await askSelect(deps, {
    message: "GCP setup credentials",
    choices: [
      { title: "Use an existing gcloud login", value: "gcloud" },
      {
        title: "Use a disposable service-account JSON key file",
        value: "disposable",
      },
    ],
    fallback: "gcloud",
    initial: 0,
  });
  try {
    if (source === "gcloud") {
      const account = await selectStorageIdentity(deps, parsed, "gcloud");
      if (!/^[^\s@]+@[^\s@]+$/u.test(account))
        throw new UsageError(
          "Enter the email of the gcloud account to select.",
        );
      notice(
        deps,
        `Using gcloud account ${account} for project ${project}. No default account/project will be changed. If login expired, run gcloud auth login first.`,
      );
      let output = "";
      const result = await deps.runProcess({
        command: "gcloud",
        args: [
          "auth",
          "print-access-token",
          `--account=${account}`,
          `--project=${project}`,
          "--quiet",
        ],
        env: deps.env,
        onOutput: (chunk) => {
          output += chunk;
        },
      });
      if (result.exitCode !== 0 || !/^[\w.~-]+$/u.test(output.trim()))
        throw new UsageError(
          "Could not obtain a token from the selected gcloud account. Run gcloud auth login, then select that account and retry.",
        );
      token = output.trim();
    } else {
      await offerStorageCredential(ctx, {
        sources: [{ flag: "--gcp-setup-credentials-file", env: "CMPATCH_GCP_SETUP_CREDENTIALS_FILE" }],
        instructions: renderGcpSetupCredential(project),
        url: `https://console.cloud.google.com/iam-admin/serviceaccounts?project=${project}`,
        message: "Open GCP to create a disposable setup key?",
      });
      const file = await storageValue(
        deps,
        parsed,
        "--gcp-setup-credentials-file",
        "CMPATCH_GCP_SETUP_CREDENTIALS_FILE",
        "Disposable setup service-account JSON file",
      );
      const json = (await deps.readFile(file)).toString("utf8");
      disposable = parseGcsKey(json);
      if (!disposable.private_key_id)
        throw new UsageError(
          "The disposable GCP key needs private_key_id so it can be revoked.",
        );
      token = await gcsAccessToken({
        fetch: ctx.fetch,
        credentialsJson: json,
        now: deps.now(),
      });
    }
    const api = { fetch: ctx.fetch, token };
    step = "Check GCP project and organization prerequisites";
    const info = await gcpRequest<{ projectId: string; name?: string }>({
      ...api,
      url: `https://cloudresourcemanager.googleapis.com/v1/projects/${project}`,
    });
    for (const constraint of [
      "storage.publicAccessPrevention",
      "iam.disableServiceAccountKeyCreation",
      "iam.managed.disableServiceAccountKeyCreation",
    ]) {
      try {
        const policy = await gcpRequest<{
          booleanPolicy?: { enforced?: boolean };
        }>({
          ...api,
          url: `https://cloudresourcemanager.googleapis.com/v1/projects/${project}:getEffectiveOrgPolicy`,
          method: "POST",
          body: { constraint: `constraints/${constraint}` },
        });
        if (policy.booleanPolicy?.enforced)
          throw new UsageError(
            `GCP policy ${constraint} is enforced. Obtain an administrator-approved exception${constraint.includes("KeyCreation") ? " or use an existing runtime key with guided setup" : "; guided setup and an existing key cannot bypass public-access prevention"}.`,
          );
      } catch (error) {
        if (
          error instanceof ProviderHttpError &&
          [403, 404].includes(error.status)
        )
          notice(
            deps,
            `Could not inspect ${constraint}; setup cannot prove all organization policies before making requests. A denied operation will stop setup.`,
          );
        else throw error;
      }
    }
    for (const bucket of [plan.publicBucket, plan.internalBucket]) {
      step = `Check GCS bucket ${bucket}`;
      try {
        await gcpRequest({
          ...api,
          url: `https://storage.googleapis.com/storage/v1/b/${bucket}`,
        });
        throw new UsageError(
          `GCS bucket ${bucket} already exists. Choose a new name or guided setup; its settings will not be changed.`,
        );
      } catch (error) {
        if (!(error instanceof ProviderHttpError) || error.status !== 404)
          throw error;
      }
    }
    await approveSetup(
      ctx,
      `GCP project ${info.projectId} (${info.name ?? project}), location ${plan.region}`,
    );
    approved = true;
    for (const bucket of [plan.publicBucket, plan.internalBucket]) {
      step = `Create GCS bucket ${bucket}`;
      await gcpRequest({
        ...api,
        url: `https://storage.googleapis.com/storage/v1/b?project=${project}`,
        method: "POST",
        body: {
          name: bucket,
          location: plan.region,
          iamConfiguration: {
            uniformBucketLevelAccess: { enabled: true },
            publicAccessPrevention:
              bucket === plan.internalBucket ? "enforced" : "inherited",
          },
        },
      });
      recordResource(ctx, resources, `GCS bucket ${bucket}`);
    }
    step = "Create runtime service account";
    const accountId = `cmpatch-${suffix()}`;
    const account = await gcpRequest<{ email: string; name: string }>({
      ...api,
      url: `https://iam.googleapis.com/v1/projects/${project}/serviceAccounts`,
      method: "POST",
      body: {
        accountId,
        serviceAccount: { displayName: "Patch storage runtime" },
      },
    });
    if (!account.email?.endsWith(".iam.gserviceaccount.com"))
      throw new UsageError("GCP returned no runtime service-account email.");
    recordResource(ctx, resources, `service account ${account.email}`);
    const accountPath = `https://iam.googleapis.com/v1/projects/${project}/serviceAccounts/${encodeURIComponent(account.email)}`;
    // Not stoppable: it runs inside provisioning, before the runtime key
    // exists, so there is no correction menu to return to.
    await waitReady(
      ctx,
      "Service-account propagation",
      async () => {
        try {
          await gcpRequest({ ...api, url: accountPath });
          return true;
        } catch (error) {
          if (error instanceof ProviderHttpError && error.status === 404)
            return undefined;
          throw error;
        }
      },
      120_000,
      { stoppable: false },
    );
    step = "Grant bucket-scoped runtime access";
    for (const bucket of [plan.publicBucket, plan.internalBucket])
      await grantGcsBucket({
        ...api,
        bucket,
        email: account.email,
        publicRead: bucket === plan.publicBucket,
      });
    step = "Create runtime service-account key";
    const key = await gcpRequest<{ name: string; privateKeyData: string }>({
      ...api,
      url: `${accountPath}/keys`,
      method: "POST",
      body: {
        privateKeyType: "TYPE_GOOGLE_CREDENTIALS_FILE",
        keyAlgorithm: "KEY_ALG_RSA_2048",
      },
    });
    if (!key.privateKeyData)
      throw new UsageError(
        "GCP returned no runtime key. Check service-account-key creation policy; the console cannot bypass it.",
      );
    recordResource(ctx, resources, key.name);
    const credentialsJson = Buffer.from(key.privateKeyData, "base64").toString(
      "utf8",
    );
    parseGcsKey(credentialsJson);
    return {
      kind: "gcs",
      publicBucket: plan.publicBucket,
      internalBucket: plan.internalBucket,
      credentialsJson,
      publicBaseUrl: `https://storage.googleapis.com/${plan.publicBucket}`,
    };
  } catch (error) {
    deferred =
      disposable?.private_key_id !== undefined &&
      token !== undefined &&
      !approved &&
      !(error instanceof PromptAbortError);
    throw setupFailure(ctx, step, error, resources, approved, deferred ? revokeKey : undefined);
  } finally {
    if (deferred) {
      // The caller revokes when storage setup ends.
    } else if (disposable?.private_key_id && token) await revokeKey();
    else if (disposable)
      recordCleanupWarning(
        ctx,
        `SETUP CREDENTIAL CLEANUP REQUIRED: could not authenticate to revoke key ${disposable.private_key_id ?? "unknown"}. Revoke it at https://console.cloud.google.com/iam-admin/serviceaccounts?project=${disposable.project_id}`,
      );
  }

  async function revokeKey(): Promise<void> {
    const key = disposable!;
    await cleanupSetup(
      ctx,
      key.private_key_id!,
      `https://console.cloud.google.com/iam-admin/serviceaccounts?project=${key.project_id}`,
      () =>
        gcpRequest({
          fetch: deps.fetch,
          token: token!,
          method: "DELETE",
          url: `https://iam.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(key.client_email)}/keys/${encodeURIComponent(key.private_key_id!)}`,
        }),
    );
  }
}
