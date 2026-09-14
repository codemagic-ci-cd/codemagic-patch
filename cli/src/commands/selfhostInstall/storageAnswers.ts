import type { StorageConfig } from "../../storageConfig";
import { r2Account, deriveR2Credentials } from "../../providers/cloudflare";
import { parseGcsKey } from "../../providers/gcp";
import { type ParsedArgs } from "../selfhostSession";
import { UsageError, type CommandDeps } from "../shared";
import { askValue, notice } from "./ask";
import { supplied } from "./answers";
import { httpsUrlProblem, runtimeAccessKeyProblem } from "./storageValidation";

export async function readGcsCredentials(
  deps: CommandDeps,
  path: string,
): Promise<string> {
  const json = (await deps.readFile(path)).toString("utf8");
  parseGcsKey(json);
  return json;
}

export async function readStorage(
  deps: CommandDeps,
  parsed: ParsedArgs,
  mode: Exclude<StorageConfig["kind"], "bundled">,
  interactive: boolean,
): Promise<Exclude<StorageConfig, { kind: "bundled" }>> {
  const value = async (
    flag: string,
    env: string,
    message: string,
    secret = false,
    fallback?: string,
  ) => {
    const known = supplied(deps, parsed, { flag, env })?.value;
    if (known) return known;
    if (!interactive) {
      if (fallback !== undefined) return fallback;
      throw new UsageError(
        `External storage needs ${flag} (or ${env}). Supply the existing runtime configuration and rerun cmpatch selfhost install.`,
      );
    }
    return askValue(deps, {
      message,
      type: secret ? "password" : "text",
      ...(fallback === undefined ? {} : { initial: fallback }),
    });
  };
  const gcs = mode === "gcs";
  const publicBucket = await value(
    gcs ? "--gcs-public-bucket" : "--s3-bucket",
    gcs ? "GCS_PUBLIC_BUCKET" : "S3_BUCKET",
    "Public artifact bucket",
  );
  const internalBucket = await value(
    gcs ? "--gcs-internal-bucket" : "--s3-internal-bucket",
    gcs ? "GCS_INTERNAL_BUCKET" : "S3_INTERNAL_BUCKET",
    "Private internal bucket",
  );
  for (const bucket of [publicBucket, internalBucket])
    if (
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(bucket) ||
      bucket.includes("..")
    )
      throw new UsageError(
        "Use a valid 3–63 character bucket name with lowercase letters, digits, dots or hyphens.",
      );
  if (publicBucket === internalBucket)
    throw new UsageError("Public and internal bucket names must differ.");
  const publicBaseUrl = await value(
    "--public-base-url",
    "PUBLIC_BASE_URL",
    "Verified public download base URL (https://...)",
  );
  const urlProblem = httpsUrlProblem(publicBaseUrl);
  if (urlProblem) throw new UsageError(`--public-base-url: ${urlProblem}`);
  if (gcs) {
    let path = await value(
      "--gcs-credentials-file",
      "GCS_CREDENTIALS_FILE",
      "Service-account JSON key file path",
    );
    for (;;) {
      try {
        const credentialsJson = await readGcsCredentials(deps, path);
        return {
          kind: "gcs",
          publicBucket,
          internalBucket,
          publicBaseUrl,
          credentialsJson,
        };
      } catch (error) {
        if (!interactive) throw error;
        notice(
          deps,
          "Could not read a valid service-account JSON key from that file. Check the path and select the downloaded runtime key. Your other answers are retained.",
        );
      }
      path = await askValue(deps, {
        message: "Service-account JSON key file path",
        type: "text",
        initial: path,
      });
    }
  }
  const region = await value(
    "--s3-region",
    "S3_REGION",
    "Storage region",
    false,
    mode === "r2" ? "auto" : "us-east-1",
  );
  const endpoint = supplied(deps, parsed, {
    flag: "--s3-endpoint",
    env: "S3_ENDPOINT",
  })?.value;
  if (mode === "r2" && !endpoint)
    throw new UsageError(
      "R2 requires --s3-endpoint https://<account>.r2.cloudflarestorage.com.",
    );
  if (mode === "r2" && !r2Account(endpoint))
    throw new UsageError("R2 requires the default-jurisdiction account endpoint https://<account-id>.r2.cloudflarestorage.com.");
  if (endpoint) {
    const problem = httpsUrlProblem(endpoint);
    if (problem) throw new UsageError(`S3 endpoint: ${problem}`);
  }
  const pathStyle =
    supplied(deps, parsed, {
      flag: "--s3-force-path-style",
      env: "S3_FORCE_PATH_STYLE",
    })?.value ?? String(mode === "r2");
  if (!["true", "false"].includes(pathStyle))
    throw new UsageError("--s3-force-path-style must be true or false.");
  let derived: { id: string; secret: string } | undefined;
  const token = supplied(deps, parsed, {
    flag: "--cloudflare-api-token",
    env: "CLOUDFLARE_API_TOKEN",
  })?.value;
  if (
    mode === "r2" &&
    token &&
    !supplied(deps, parsed, {
      flag: "--s3-access-key-id",
      env: "S3_ACCESS_KEY_ID",
    })?.value &&
    !supplied(deps, parsed, {
      flag: "--s3-secret-access-key",
      env: "S3_SECRET_ACCESS_KEY",
    })?.value
  ) {
    const keys = await deriveR2Credentials(deps.fetch, endpoint ?? "", token);
    derived = { id: keys.accessKeyId, secret: keys.secretAccessKey };
  }
  const accessKeyId =
    derived?.id ??
    (await value(
      "--s3-access-key-id",
      "S3_ACCESS_KEY_ID",
      "Runtime access key ID",
    ));
  const keyProblem = runtimeAccessKeyProblem(mode, accessKeyId);
  if (keyProblem) throw new UsageError(keyProblem);
  const secretAccessKey =
    derived?.secret ??
    (await value(
      "--s3-secret-access-key",
      "S3_SECRET_ACCESS_KEY",
      "Runtime secret access key",
      true,
    ));
  return {
    kind: mode,
    publicBucket,
    internalBucket,
    publicBaseUrl,
    region,
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle: pathStyle === "true",
    accessKeyId,
    secretAccessKey,
  };
}
