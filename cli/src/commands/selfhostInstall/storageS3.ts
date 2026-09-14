import { PromptAbortError } from "../../prompt";
import { selectStorageIdentity } from "./storageIdentity";
import { fromIni } from "@aws-sdk/credential-providers";
import {
  awsQuery,
  awsRequest,
  s3Operation,
  s3PublicPolicy,
  s3RuntimePolicy,
  type AwsCredentials,
} from "../../providers/aws";
import { ProviderHttpError } from "../../providers/providerError";
import { UsageError } from "../shared";
import { askSelect, notice } from "./ask";
import {
  approveSetup,
  offerStorageCredential,
  cleanupSetup,
  recordResource,
  setupFailure,
  storageValue,
  suffix,
  type SetupContext,
  type ExternalStorage,
} from "./storageSetup";

export async function setupS3(ctx: SetupContext): Promise<ExternalStorage> {
  const { deps, parsed, plan } = ctx;
  const resources: string[] = [];
  let step = "Select AWS setup credentials";
  let credentials: AwsCredentials | undefined;
  let disposable = false;
  let approved = false;
  // A key AWS rejected by name is a typo, not a credential to revoke — the
  // revoke request would fail with the same typo. Anything else that stops
  // before provisioning (a timeout, clock skew) may be a live key.
  let rejected = false;
  let deferred = false;
  const source = await askSelect(deps, {
    message: "AWS setup credentials",
    choices: [
      { title: "Use a named AWS profile (including SSO)", value: "profile" },
      { title: "Paste a disposable IAM user access key", value: "disposable" },
    ],
    fallback: "profile",
    initial: 0,
  });
  try {
    if (source === "profile") {
      const profile = await selectStorageIdentity(deps, parsed, "aws");
      notice(
        deps,
        `Reading only AWS profile ${profile}. If SSO has expired, run aws sso login --profile ${profile} and retry. Existing credentials are not changed or revoked.`,
      );
      credentials = await fromIni({ profile })();
    } else {
      await offerStorageCredential(ctx, {
        sources: [
          { flag: "--aws-setup-access-key-id", env: "CMPATCH_AWS_SETUP_ACCESS_KEY_ID" },
          { flag: "--aws-setup-secret-access-key", env: "CMPATCH_AWS_SETUP_SECRET_ACCESS_KEY" },
        ],
        instructions: "Select your dedicated setup user → Security credentials → Create access key. It needs S3 bucket/policy creation, STS GetCallerIdentity, IAM user/policy/key creation and DeleteAccessKey for itself. Paste only a disposable IAM key; this key will be revoked on completion or handled failure.",
        url: "https://console.aws.amazon.com/iam/home#/users",
        message: "Open AWS IAM to create a disposable setup key?",
      });
      const accessKeyId = await storageValue(
        deps,
        parsed,
        "--aws-setup-access-key-id",
        "CMPATCH_AWS_SETUP_ACCESS_KEY_ID",
        "Disposable setup access key ID",
      );
      const secretAccessKey = await storageValue(
        deps,
        parsed,
        "--aws-setup-secret-access-key",
        "CMPATCH_AWS_SETUP_SECRET_ACCESS_KEY",
        "Disposable setup secret access key",
        undefined,
        true,
      );
      credentials = { accessKeyId, secretAccessKey };
      disposable = true;
      if (!/^AKIA[A-Z0-9]{16}$/u.test(accessKeyId))
        throw new UsageError(
          "Disposable AWS setup credentials must be a permanent IAM user key (AKIA), not an STS session.",
        );
    }
    const api = { fetch: ctx.fetch, credentials, region: plan.region };
    step = "Verify AWS identity and public-access prerequisite";
    const identity = await awsQuery<{ Account: string; Arn: string }>({
      ...api,
      service: "sts",
      action: "GetCallerIdentity",
    });
    if (!/^\d{12}$/u.test(identity.Account))
      throw new UsageError("AWS returned no valid account ID.");
    const policy = await awsRequest({
      ...api,
      service: "s3",
      method: "GET",
      url: `https://${identity.Account}.s3-control.${plan.region}.amazonaws.com/v20180820/configuration/publicAccessBlock`,
      headers: { "x-amz-account-id": identity.Account },
    });
    if (policy.ok) {
      if (
        /<(?:BlockPublicPolicy|RestrictPublicBuckets)>true<\//u.test(
          await policy.text(),
        )
      )
        throw new UsageError(
          "AWS account Block Public Access prohibits the public origin. Ask your administrator for an approved account/topology; this wizard never changes account policy. Guided setup and CloudFront do not bypass it.",
        );
    } else if (policy.status === 403)
      notice(
        deps,
        "Account public-access policy could not be read with this credential. Bucket creation cannot prove every organization restriction; a denied policy operation will stop setup.",
      );
    else if (policy.status !== 404)
      throw new ProviderHttpError(
        "Read AWS account public-access policy",
        policy.status,
      );
    await approveSetup(
      ctx,
      `AWS ${identity.Account} (${identity.Arn}), region ${plan.region}`,
    );
    for (const bucket of [plan.publicBucket, plan.internalBucket]) {
      step = `Check bucket ${bucket}`;
      // S3 us-east-1 can return success when re-creating a bucket owned by this account.
      const head = await awsRequest({
        ...api,
        service: "s3",
        method: "HEAD",
        url: `https://${bucket}.s3.${plan.region}.amazonaws.com/`,
      });
      if (head.status !== 404)
        throw new UsageError(
          `Bucket ${bucket} exists or availability is uncertain (HTTP ${head.status}). Choose a new name, or guided setup to reuse it; its policy will not be changed.`,
        );
    }
    // Nothing exists until here: a name that turns out to be taken can still
    // be tried again with another.
    approved = true;
    for (const bucket of [plan.publicBucket, plan.internalBucket]) {
      step = `Create bucket ${bucket}`;
      await s3Operation({
        ...api,
        bucket,
        method: "PUT",
        ...(plan.region === "us-east-1"
          ? {}
          : {
              body: `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${plan.region}</LocationConstraint></CreateBucketConfiguration>`,
            }),
      });
      recordResource(ctx, resources, `S3 bucket ${bucket}`);
      step = `Configure bucket protection ${bucket}`;
      const isPrivate = bucket === plan.internalBucket;
      await s3Operation({
        ...api,
        bucket,
        method: "PUT",
        query: "publicAccessBlock",
        body: `<PublicAccessBlockConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><BlockPublicAcls>true</BlockPublicAcls><IgnorePublicAcls>true</IgnorePublicAcls><BlockPublicPolicy>${isPrivate}</BlockPublicPolicy><RestrictPublicBuckets>${isPrivate}</RestrictPublicBuckets></PublicAccessBlockConfiguration>`,
      });
      if (!isPrivate)
        await s3Operation({
          ...api,
          bucket,
          method: "PUT",
          query: "policy",
          body: s3PublicPolicy(bucket),
        });
    }
    step = "Create bucket-scoped runtime IAM user";
    const userName = `cmpatch-${suffix()}`;
    await awsQuery({
      ...api,
      service: "iam",
      action: "CreateUser",
      values: { UserName: userName },
    });
    recordResource(ctx, resources, `IAM user ${userName}`);
    await awsQuery({
      ...api,
      service: "iam",
      action: "PutUserPolicy",
      values: {
        UserName: userName,
        PolicyName: "PatchStorage",
        PolicyDocument: s3RuntimePolicy(plan.publicBucket, plan.internalBucket),
      },
    });
    const { AccessKey } = await awsQuery<{
      AccessKey: { AccessKeyId: string; SecretAccessKey: string };
    }>({
      ...api,
      service: "iam",
      action: "CreateAccessKey",
      values: { UserName: userName },
    });
    if (!AccessKey?.AccessKeyId || !AccessKey.SecretAccessKey)
      throw new UsageError(
        "AWS returned no runtime access key; inspect the created IAM user.",
      );
    recordResource(
      ctx,
      resources,
      `runtime access key ${AccessKey.AccessKeyId}`,
    );
    return {
      kind: "s3",
      publicBucket: plan.publicBucket,
      internalBucket: plan.internalBucket,
      region: plan.region,
      forcePathStyle: false,
      accessKeyId: AccessKey.AccessKeyId,
      secretAccessKey: AccessKey.SecretAccessKey,
      publicBaseUrl: `https://${plan.publicBucket}.s3.${plan.region}.amazonaws.com`,
    };
  } catch (error) {
    rejected =
      error instanceof ProviderHttpError &&
      ["InvalidClientTokenId", "SignatureDoesNotMatch", "IncompleteSignature", "AuthFailure"].includes(error.code ?? "");
    const revoke = disposable && credentials && !rejected ? revokeKey(credentials) : undefined;
    deferred =
      revoke !== undefined && !approved && !(error instanceof PromptAbortError);
    throw setupFailure(ctx, step, error, resources, approved, deferred ? revoke : undefined);
  } finally {
    if (disposable && credentials && !rejected && !deferred) await revokeKey(credentials)();
  }

  function revokeKey(key: AwsCredentials): () => Promise<void> {
    return () =>
      cleanupSetup(
        ctx,
        key.accessKeyId,
        "https://console.aws.amazon.com/iam/home#/users",
        () =>
          awsQuery({
            fetch: deps.fetch,
            credentials: key,
            region: plan.region,
            service: "iam",
            action: "DeleteAccessKey",
            values: { AccessKeyId: key.accessKeyId },
          }),
      );
  }
}
