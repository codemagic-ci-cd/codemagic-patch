import { promises as fs } from "node:fs";
import path from "node:path";

import {
  releaseFormFromParts,
  releaseFormPoliciesFromUploadPolicy,
} from "@codemagic/patch-shared";

import { resolveServerUrl } from "./api";
import {
  assertCanAuthenticate,
  authenticatedRequest,
  type ApiTarget,
} from "./authenticatedRequest";
import { assertExplicitBinaryVersion } from "./binaryVersion";
import { CLI_NAME } from "./branding";
import { inspectBundle, readBundleZip } from "./bundle";
import type { CommandOutput } from "./command";
import type { CliDeps } from "./deps";
import { UsageError } from "./errors";
import { binaryVersionFingerprint } from "./fingerprint";
import { enforceMutationSafety } from "./mutation";
import { formatBytes, writeLine, type OutputFormat } from "./output";
import { getProblemTypeSuffix, HttpProblemError } from "./problem-details";
import { releaseActionOutput } from "./releaseOutput";
import { resolveDeploymentId, type DeploymentSelector } from "./resolveNames";
import {
  loadRsaPrivateKey,
  signContentHashJwt,
  SIGNATURE_HASH_ALGORITHM,
} from "./signing";

export interface ReleaseCommand {
  bundlePath: string;
  deployment: DeploymentSelector;
  disabled: boolean;
  dryRun: boolean;
  format: OutputFormat;
  mandatory: boolean;
  noDuplicateReleaseError: boolean;
  privateKeyPath?: string;
  releaseNotes?: string;
  rolloutPercentage: number;
  serverUrl?: string;
  targetBinaryVersion: string;
  token?: string;
  yes: boolean;
}

// The keys `cmpatch release create --dry-run` reports are kept under the same
// names, so a script reading one CLI's dry run reads the other's.
type ReleaseDryRunResult = {
  bundlePath: string;
  deploymentId: string;
  dryRun: true;
  fileCount: number;
  fingerprint: string;
  packageHash: string;
  publicationSafety: {
    duplicateRelease: "allow" | "block";
    fingerprintMismatch: "allow" | "block";
  };
  serverUrl: string;
  signing: {
    enabled: boolean;
    hashAlgorithm?: string;
  };
  targetBinaryVersion: string;
  uploadSettings: {
    disabled: boolean;
    isMandatory: boolean;
    releaseNotes?: string;
    rolloutPercentage: number;
  };
  uploadSkipped: true;
  zipBytes: number;
};

export async function executeRelease(
  command: ReleaseCommand,
  deps: CliDeps,
): Promise<CommandOutput> {
  // Local inputs first, cheapest first: a typo must fail before the network is
  // touched, and before "Missing --yes" can mask it.
  assertExplicitBinaryVersion(command.targetBinaryVersion);
  const serverUrl = resolveServerUrl(command.serverUrl, deps.env);
  const bundle = await inspectBundle(command.bundlePath);
  const privateKeyPem =
    command.privateKeyPath === undefined
      ? undefined
      : await readPrivateKey(command.privateKeyPath);

  // A dry run aimed at a deployment id never talks to the server, so it needs
  // nothing to authenticate with; every other run does, and must learn that it
  // has nothing before it sends or asks anything.
  const apiTarget: ApiTarget = {
    serverUrl,
    ...(command.token !== undefined ? { token: command.token } : {}),
  };
  let target: ApiTarget | null = null;
  let deploymentId: string;
  if ("deploymentId" in command.deployment) {
    deploymentId = command.deployment.deploymentId;
    if (!command.dryRun) {
      await assertCanAuthenticate(deps, apiTarget);
      target = apiTarget;
    }
  } else {
    await assertCanAuthenticate(deps, apiTarget);
    target = apiTarget;
    deploymentId = await resolveDeploymentId(deps, target, command.deployment);
  }

  // Asked before the archive is built: a declined confirmation (or a missing
  // --yes) should not cost a full compression pass.
  await enforceMutationSafety(deps, {
    commandName: "release create",
    dryRun: command.dryRun,
    fields: [
      ["serverUrl", serverUrl],
      ["deploymentId", deploymentId],
      ["targetBinaryVersion", command.targetBinaryVersion],
      ["bundle", `${bundle.resolvedPath} (${bundle.payloadPaths.length} files)`],
      ["rollout", String(command.rolloutPercentage)],
      ["mandatory", String(command.mandatory)],
      ["disabled", String(command.disabled)],
      ["signed", String(privateKeyPem !== undefined)],
    ],
    format: command.format,
    yes: command.yes,
  });

  reportProgress(command, deps, `Archiving ${bundle.resolvedPath}`);
  const { packageHash, zipBytes: bundleZip } = await readBundleZip(bundle);
  const signature =
    privateKeyPem === undefined
      ? undefined
      : signContentHashJwt({ contentHash: packageHash, privateKeyPem });

  const fingerprint = binaryVersionFingerprint(command.targetBinaryVersion);
  // "allow", never "block": blocking asks the server to refuse a release whose
  // fingerprint differs from the one on record, and the value above is not a
  // fingerprint of anything (see fingerprint.ts). A deployment that was released
  // to with `cmpatch` before therefore gets a warning, not a refusal.
  const { uploadSettings, safetyPolicy } = releaseFormPoliciesFromUploadPolicy(
    {
      disabled: command.disabled,
      isMandatory: command.mandatory,
      noDuplicateReleaseError: command.noDuplicateReleaseError,
      releaseNotes: command.releaseNotes,
      rolloutPercentage: command.rolloutPercentage,
    },
    "allow",
  );

  if (command.dryRun || target === null) {
    return dryRunOutput({
      bundlePath: bundle.resolvedPath,
      deploymentId,
      dryRun: true,
      fileCount: bundle.payloadPaths.length,
      fingerprint,
      packageHash,
      publicationSafety: safetyPolicy,
      serverUrl,
      signing:
        signature === undefined
          ? { enabled: false }
          : { enabled: true, hashAlgorithm: SIGNATURE_HASH_ALGORITHM },
      targetBinaryVersion: command.targetBinaryVersion,
      uploadSettings,
      uploadSkipped: true,
      zipBytes: bundleZip.byteLength,
    });
  }

  reportProgress(
    command,
    deps,
    `Uploading release (${formatBytes(bundleZip.byteLength)})`,
  );
  const result = await uploadRelease(
    deps,
    target,
    deploymentId,
    releaseFormFromParts(
      {
        bundleZip,
        fingerprint,
        signature,
        signatureHashAlgorithm:
          signature === undefined ? undefined : SIGNATURE_HASH_ALGORITHM,
        targetBinaryVersion: command.targetBinaryVersion,
      },
      uploadSettings,
      safetyPolicy,
    ),
  );

  return releaseActionOutput(
    result,
    ({ id, label }) =>
      `Uploaded release ${label} (${id}) to deployment ${deploymentId} for binary version ${command.targetBinaryVersion}.`,
    ({ id }) => [
      `package hash: ${packageHash}`,
      // Accepted is not yet served: the server builds the release in the job above.
      `next:         \`${CLI_NAME} release inspect --release-id ${id} --wait\` reports when it is published`,
    ],
  );
}

async function readPrivateKey(privateKeyPath: string): Promise<Buffer> {
  const resolvedPath = path.resolve(privateKeyPath);

  let privateKeyPem: Buffer;
  try {
    privateKeyPem = await fs.readFile(resolvedPath);
  } catch (error) {
    throw new UsageError(
      `private key file could not be read: ${resolvedPath}${
        error instanceof Error ? ` (${error.message})` : ""
      }`,
    );
  }

  // Parsed now, only to reject a bad key before the confirmation prompt.
  loadRsaPrivateKey(privateKeyPem);
  return privateKeyPem;
}

async function uploadRelease(
  deps: CliDeps,
  target: ApiTarget,
  deploymentId: string,
  body: FormData,
): Promise<unknown> {
  try {
    // One key for the whole call: http.ts retries a transient failure with the
    // same request, and the key is what makes the server replay the stored
    // response instead of creating the release twice.
    return await authenticatedRequest(
      deps,
      target,
      `/v1/deployments/${encodeURIComponent(deploymentId)}/releases`,
      {
        body,
        headers: { "idempotency-key": deps.randomUUID() },
        method: "POST",
      },
    );
  } catch (error) {
    if (!(error instanceof HttpProblemError)) {
      throw error;
    }

    // A refused duplicate says what is wrong but not what to do about it. (The other
    // refusal with a flag to name, an unsigned upload, gets its hint in serverProblemHints.ts.)
    throw getProblemTypeSuffix(error.problem.type) === "duplicate-release"
      ? new HttpProblemError(
          {
            ...error.problem,
            hint: "Re-run with --no-duplicate-release-error after verifying that accepting the duplicate is intended.",
          },
          error.responseStatus,
          error.serverUrl,
        )
      : error;
  }
}

function reportProgress(
  command: ReleaseCommand,
  deps: CliDeps,
  message: string,
): void {
  if (command.format === "text") {
    writeLine(deps.stderr, message);
  }
}

function dryRunOutput(result: ReleaseDryRunResult): CommandOutput {
  return {
    fields: [
      ["server", "serverUrl"],
      ["deployment id", "deploymentId"],
      ["target binary version", "targetBinaryVersion"],
      ["bundle", "bundlePath"],
      ["files", "fileCount"],
      ["zipped bytes", "zipBytes"],
      ["package hash", "packageHash"],
      ["rollout", "uploadSettings.rolloutPercentage"],
      ["mandatory", "uploadSettings.isMandatory"],
      ["disabled", "uploadSettings.disabled"],
      ["release notes", "uploadSettings.releaseNotes"],
      ["signed", "signing.enabled"],
      ["signature algorithm", "signing.hashAlgorithm"],
      ["duplicate release", "publicationSafety.duplicateRelease"],
      // Not a fingerprint of anything — see fingerprint.ts. Shown because it is sent.
      ["fingerprint field", "fingerprint"],
      ["fingerprint mismatch", "publicationSafety.fingerprintMismatch"],
      ["dry run", "dryRun"],
      ["upload skipped", "uploadSkipped"],
    ],
    json: result,
    kind: "record",
    record: result,
    title: "Dry run — nothing was uploaded.",
  };
}
