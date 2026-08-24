import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  artifactToReleaseForm,
  parseArtifact,
  releaseFormFromParts,
  releaseFormPoliciesFromUploadPolicy,
  resolveUploadPolicy,
  type Artifact,
  type ReleaseDescriptor,
  type ReleaseSafetyPolicy,
} from "@codemagic/patch-shared";

import type { ReleaseCreateCommand } from "../commandTypes";
import { authenticatedRequest } from "../authenticatedRequest";
import { computePackageHashFromZipBuffer } from "../packageHash";
import { createProgress, type Progress } from "../progress";
import { signContentHashJwt, SIGNATURE_HASH_ALGORITHM } from "../signing";
import { writeLine } from "../output";
import { assertExplicitBinaryVersion } from "../targetBinaryVersion";
import {
  findLongNamePaths,
  findUnsupportedArchivePaths,
  formatLongNameWarning,
  formatUnsupportedPathsError,
} from "../tarLongPaths";
import {
  createZipFromDirectory,
  listArchiveFiles,
  listZipPayloadFiles,
  toPayloadPaths,
} from "../zip";
import { enforceMutationSafety } from "./mutationSafety";
import {
  interactionContextFromCommand,
  type ReleaseExecutionContext,
} from "./releaseExecution";
import { executeReleasePublication } from "./releasePublication";
import { resolveDeploymentId } from "./resolveNames";
import {
  buildApiUrl,
  ensureReadableFile,
  UsageError,
  type CommandDeps,
} from "./shared";

type SigningMetadata = {
  signature?: string;
  signatureHashAlgorithm?: string;
};

type ReleaseDryRunResult = {
  bundleGenerated?: true;
  bundlePath?: string;
  deploymentId: string;
  dryRun: true;
  fingerprint: string;
  platform?: "android" | "ios";
  publicationSafety: {
    duplicateRelease: "allow" | "block";
    fingerprintMismatch: "allow" | "block";
  };
  serverUrl: string;
  signing: {
    enabled: boolean;
    hashAlgorithm?: string;
  };
  sourcemapPath?: string;
  targetBinaryVersion: string;
  uploadSkipped: true;
};

export async function executeReleaseCreate(
  command: ReleaseCreateCommand,
  deps: CommandDeps,
  // release-react delegates here with its own progress tree already open on
  // stderr; reporting onto it (and leaving its lifecycle to the owner) is what
  // keeps one run from animating two spinners over one stream.
  sharedProgress?: Progress,
  executionContext: ReleaseExecutionContext = {
    mutationSafety: "required",
  },
): Promise<unknown> {
  if (command.artifactUpload === true) {
    return executeArtifactReleaseCreate(command, deps, executionContext);
  }

  const interactionContext = interactionContextFromCommand(command);

  if (command.targetBinaryVersion === undefined) {
    throw new UsageError("Missing required flag --target-binary-version");
  }
  const targetBinaryVersion = command.targetBinaryVersion;
  assertExplicitBinaryVersion(targetBinaryVersion);

  const sourcemapPath =
    command.sourcemapPath === undefined
      ? undefined
      : await ensureReadableFile(deps, command.sourcemapPath, "sourcemap");
  const privateKeyPath =
    command.privateKeyPath === undefined
      ? undefined
      : await ensureReadableFile(deps, command.privateKeyPath, "private key");

  const tempRoot = await fs.mkdtemp(path.join(tmpdir(), "codemagic-patch-release-"));
  const zipPath = path.join(tempRoot, "bundle.zip");
  // Opened only after the mutation guard: a spinner animating over the
  // interactive confirm prompt would corrupt both. A borrowed tree is safe
  // here because its owner passes an already-satisfied execution context.
  const ownsProgress = sharedProgress === undefined;
  const progress =
    sharedProgress ??
    createProgress({
      label: "release create",
      stderr: deps.stderr,
    });

  try {
    // Validate the bundle path before any network work or the confirm prompt
    // so a typo fails instantly (and before "Missing --yes" can mask it).
    const bundlePath = await statBundlePath(deps, command.bundlePath);

    // Path limits and the long-name compat warning belong before the confirm
    // prompt: a publisher who sees the warning only as the upload starts has
    // no abort point left.
    await checkBundlePayloadPaths(deps, bundlePath.resolvedPath, bundlePath.stats);

    const fingerprint = await resolveFingerprint(command, deps);
    const deploymentId = await resolveDeploymentId(
      command.deployment,
      command.serverUrl,
      command.token,
      deps,
      {
        nonInteractive:
          interactionContext.mode !== "interactive" ||
          interactionContext.explicitYes ||
          executionContext.mutationSafety === "already-satisfied",
      },
    );

    // Guard before the expensive bundle zip so a declined confirmation (or a
    // missing --yes) doesn't waste the archive build. Dry-run skips the guard
    // and still archives below to report what would be uploaded. Settled
    // first: a borrowed tree may still have a step in flight, and the guard's
    // note and confirm must not draw under an animating spinner.
    progress.settle();
    if (executionContext.mutationSafety === "required") {
      await enforceMutationSafety(deps, {
        commandName: "release create",
        dryRun: command.dryRun,
        fields: [
          ["serverUrl", command.serverUrl],
          ["deploymentId", deploymentId],
          ["platform", command.platform],
          ["targetBinaryVersion", targetBinaryVersion],
          ["rollout", String(command.rolloutPercentage)],
          ["mandatory", String(command.isMandatory)],
          ["disabled", String(command.disabled)],
          ["fingerprint", fingerprint],
        ],
        nonInteractive: interactionContext.mode !== "interactive",
        yes: interactionContext.explicitYes,
      });
    }

    progress.write(`Archiving ${command.bundlePath}`);
    const bundleArchivePath = await prepareBundleArchive(
      deps,
      command.bundlePath,
      zipPath,
      progress.warn,
    );

    if (command.dryRun) {
      return await buildDryRunResult(command, deps, {
        bundleArchivePath,
        deploymentId,
        fingerprint,
        privateKeyPath,
        sourcemapPath,
        targetBinaryVersion,
      });
    }

    progress.write("Uploading release");
    return await uploadReleaseArchive(
      command,
      deps,
      {
        bundleArchivePath,
        deploymentId,
        fingerprint,
        privateKeyPath,
        sourcemapPath,
        targetBinaryVersion,
      },
      progress,
    );
  } catch (error) {
    // Marks the step in flight as failed; the finally below is then a no-op,
    // so the tree is still closed exactly once on every path. A borrowed tree
    // is left alone — its owner closes it, and closes it exactly once.
    if (ownsProgress) {
      progress.fail();
    }
    throw error;
  } finally {
    if (ownsProgress) {
      progress.stop();
    }
    await fs.rm(tempRoot, { force: true, recursive: true });
  }
}

/**
 * Upload an existing `.cmpatch` artifact. Build identity comes from the descriptor;
 * the bundle (and its signature) are forwarded verbatim — never re-zipped or
 * re-signed — so the server sees the exact bytes the build produced. Flags supply
 * only the deployment target and any policy overrides.
 */
async function executeArtifactReleaseCreate(
  command: ReleaseCreateCommand,
  deps: CommandDeps,
  executionContext: ReleaseExecutionContext,
): Promise<unknown> {
  const interactionContext = interactionContextFromCommand(command);
  const artifactPath = await ensureReadableFile(
    deps,
    command.bundlePath,
    "artifact",
  );
  const bytes = await deps.readFile(artifactPath);

  let artifact: Artifact;
  try {
    artifact = parseArtifact(bytes);
  } catch (error) {
    throw new UsageError(
      `failed to read .cmpatch artifact ${artifactPath}${formatErrorSuffix(error)}`,
    );
  }
  const { descriptor } = artifact;

  // Fail fast on a corrupted artifact before we touch the network: the bundle the
  // server will hash must match what the descriptor (and any signature) committed to.
  const recomputedHash = computePackageHashFromZipBuffer(artifact.bundleZip);
  if (recomputedHash !== descriptor.packageHash) {
    throw new UsageError(
      `.cmpatch artifact failed its integrity check: the bundle hashes to ${recomputedHash}, ` +
        `but its descriptor records ${descriptor.packageHash}. The artifact may be corrupted.`,
    );
  }

  assertExplicitBinaryVersion(descriptor.targetBinaryVersion);

  // The integrity check above already parsed the bundle ZIP, so the entry
  // listing here cannot fail — and the artifact path must apply the same path
  // limits and long-name warning as the directory/ZIP paths do.
  const artifactPayloadPaths = listZipPayloadFiles(artifact.bundleZip);
  assertInstallableArchivePaths(artifactPayloadPaths);
  warnAboutLongNamePaths(deps, artifactPayloadPaths);

  const deploymentId = await resolveDeploymentId(
    command.deployment,
    command.serverUrl,
    command.token,
    deps,
    { nonInteractive: command.nonInteractive === true || command.yes === true },
  );
  const policy = resolveUploadPolicy(
    descriptor.defaults,
    command.policyOverrides ?? {},
  );
  const { uploadSettings, safetyPolicy } = releaseFormPoliciesFromUploadPolicy(
    policy,
    command.allowFingerprintMismatch === true ? "allow" : "block",
  );

  if (command.dryRun) {
    return buildArtifactDryRunResult(command, descriptor, deploymentId, safetyPolicy);
  }

  if (executionContext.mutationSafety === "required") {
    await enforceMutationSafety(deps, {
      commandName: "release create",
      // Unreachable when true (dry-run returned above), but passing it keeps
      // the missing---yes error suggesting --dry-run, which this path supports.
      dryRun: command.dryRun,
      fields: [
        ["serverUrl", command.serverUrl],
        ["deploymentId", deploymentId],
        ["platform", descriptor.platform],
        ["targetBinaryVersion", descriptor.targetBinaryVersion],
        ["rollout", String(policy.rolloutPercentage)],
        ["mandatory", String(policy.isMandatory)],
        ["disabled", String(policy.disabled)],
        ["fingerprint", descriptor.fingerprint],
      ],
      nonInteractive: interactionContext.mode !== "interactive",
      yes: interactionContext.explicitYes,
    });
  }

  // Opened only after the mutation guard: a spinner animating over the
  // interactive confirm prompt would corrupt both.
  const progress = createProgress({
    label: "release create",
    stderr: deps.stderr,
  });

  try {
    progress.write("Uploading release");
    return await executeReleasePublication(deps, {
      allowFingerprintMismatch: command.allowFingerprintMismatch === true,
      duplicateRelease: safetyPolicy.duplicateRelease,
      interaction: interactionContext,
      onPrompt: progress.settle,
      onRetry: () => progress.write("Retrying approved release"),
      upload: async ({ idempotencyKey, safetyPolicy: attemptSafetyPolicy }) => {
        return authenticatedRequest(deps, {
          init: {
            body: artifactToReleaseForm(
              artifact,
              uploadSettings,
              attemptSafetyPolicy,
            ),
            headers: {
              "idempotency-key": idempotencyKey,
            },
            method: "POST",
          },
          serverUrl: command.serverUrl,
          token: command.token,
          url: buildApiUrl(
            command.serverUrl,
            `/v1/deployments/${encodeURIComponent(deploymentId)}/releases`,
          ),
        });
      },
    });
  } catch (error) {
    progress.fail();
    throw error;
  } finally {
    progress.stop();
  }
}

function buildArtifactDryRunResult(
  command: ReleaseCreateCommand,
  descriptor: ReleaseDescriptor,
  deploymentId: string,
  // The resolved policy, not the raw flags: the artifact's baked-in defaults
  // apply when a flag is absent, and dry-run must report what upload sends.
  safetyPolicy: ReleaseSafetyPolicy,
): ReleaseDryRunResult {
  return {
    bundlePath: path.resolve(command.bundlePath),
    deploymentId,
    dryRun: true,
    fingerprint: descriptor.fingerprint,
    platform: descriptor.platform,
    publicationSafety: safetyPolicy,
    serverUrl: command.serverUrl,
    signing:
      descriptor.signature === undefined
        ? { enabled: false }
        : {
            enabled: true,
            ...(descriptor.signatureHashAlgorithm !== undefined
              ? { hashAlgorithm: descriptor.signatureHashAlgorithm }
              : {}),
          },
    ...(descriptor.sourcemapFile !== undefined
      ? { sourcemapPath: descriptor.sourcemapFile }
      : {}),
    targetBinaryVersion: descriptor.targetBinaryVersion,
    uploadSkipped: true,
  };
}

async function buildDryRunResult(
  command: ReleaseCreateCommand,
  deps: CommandDeps,
  input: {
    bundleArchivePath: string;
    deploymentId: string;
    fingerprint: string;
    privateKeyPath?: string;
    sourcemapPath?: string;
    targetBinaryVersion: string;
  },
): Promise<ReleaseDryRunResult> {
  const signingMetadata: SigningMetadata =
    input.privateKeyPath === undefined
      ? {}
      : await buildSigningMetadata(
          deps,
          input.bundleArchivePath,
          input.privateKeyPath,
        );
  const dryRunBundlePath = command.dryRunBundleGenerated
    ? command.dryRunBundlePath
    : command.dryRunBundlePath ?? path.resolve(command.bundlePath);

  return {
    ...(command.dryRunBundleGenerated ? { bundleGenerated: true } : {}),
    ...(dryRunBundlePath !== undefined ? { bundlePath: dryRunBundlePath } : {}),
    deploymentId: input.deploymentId,
    dryRun: true,
    fingerprint: input.fingerprint,
    ...(command.platform !== undefined ? { platform: command.platform } : {}),
    publicationSafety: releaseDryRunSafety(command),
    serverUrl: command.serverUrl,
    signing:
      signingMetadata.signatureHashAlgorithm === undefined
        ? { enabled: false }
        : {
            enabled: true,
            hashAlgorithm: signingMetadata.signatureHashAlgorithm,
          },
    ...(input.sourcemapPath !== undefined
      ? { sourcemapPath: input.sourcemapPath }
      : {}),
    targetBinaryVersion: input.targetBinaryVersion,
    uploadSkipped: true,
  };
}

// On the directory/ZIP path the command flags are the effective policy, so the
// shared derivation over them reports exactly what upload sends.
function releaseDryRunSafety(
  command: ReleaseCreateCommand,
): ReleaseDryRunResult["publicationSafety"] {
  return releaseFormPoliciesFromUploadPolicy(
    {
      rolloutPercentage: command.rolloutPercentage,
      isMandatory: command.isMandatory,
      disabled: command.disabled,
      noDuplicateReleaseError: command.noDuplicateReleaseError,
    },
    command.allowFingerprintMismatch === true ? "allow" : "block",
  ).safetyPolicy;
}

async function resolveFingerprint(
  command: ReleaseCreateCommand,
  deps: CommandDeps,
): Promise<string> {
  if (command.fingerprint !== undefined) {
    return command.fingerprint;
  }

  if (command.platform === undefined) {
    throw new UsageError("Missing required flag --platform");
  }

  return deps.computeFingerprint({
    platform: command.platform,
    projectRoot: command.projectRoot,
  });
}

// Cheap existence check shared by the pre-guard validation (bad inputs must
// fail before any network resolution or confirm prompt) and the archive build.
async function statBundlePath(
  deps: CommandDeps,
  inputPath: string,
): Promise<{
  resolvedPath: string;
  stats: Awaited<ReturnType<CommandDeps["stat"]>>;
}> {
  const resolvedPath = path.resolve(inputPath);

  try {
    return { resolvedPath, stats: await deps.stat(resolvedPath) };
  } catch (error) {
    throw new UsageError(
      `bundle path was not found: ${resolvedPath}${formatErrorSuffix(error)}`,
    );
  }
}

async function prepareBundleArchive(
  deps: CommandDeps,
  inputPath: string,
  zipPath: string,
  // The archive spinner is in flight here, so the warning must go through the
  // progress reporter rather than a raw stderr write.
  warn: Progress["warn"],
): Promise<string> {
  const { resolvedPath, stats } = await statBundlePath(deps, inputPath);

  if (stats.isDirectory()) {
    const files = await listArchiveFiles(resolvedPath);
    if (files.length === 0) {
      throw new UsageError(
        `bundle directory contains no files: ${resolvedPath}`,
      );
    }
    if (!files.some(isJsBundleFile)) {
      warn(
        `no recognizable JS bundle (e.g. index.android.bundle, main.jsbundle, *.hbc) found in ${resolvedPath}; uploading anyway.`,
      );
    }
    await createZipFromDirectory(resolvedPath, zipPath);
    return zipPath;
  }

  if (stats.isFile()) {
    return resolvedPath;
  }

  throw new UsageError(
    `bundle path is neither a file nor a directory: ${resolvedPath}`,
  );
}

// Payload paths decide two things before the confirm prompt: whether any path
// is unusable on device (hard error) and whether the release needs a newer SDK
// (warning). Both need the same listing, so it runs regardless of stderr.
async function checkBundlePayloadPaths(
  deps: CommandDeps,
  resolvedPath: string,
  stats: Awaited<ReturnType<CommandDeps["stat"]>>,
): Promise<void> {
  const files = stats.isDirectory()
    ? toPayloadPaths(await listArchiveFiles(resolvedPath))
    : stats.isFile()
      ? await listZipEntryFiles(deps, resolvedPath)
      : [];

  assertInstallableArchivePaths(files);
  warnAboutLongNamePaths(deps, files);
}

// A path past the filesystem or validator limits produces a release no device
// can extract, so it must fail here rather than in the release job.
function assertInstallableArchivePaths(files: string[]): void {
  const unsupported = findUnsupportedArchivePaths(files);
  if (unsupported.length > 0) {
    throw new UsageError(formatUnsupportedPathsError(unsupported));
  }
}

// Best-effort file listing of a prebuilt ZIP; an unreadable archive is left
// for the server to diagnose. deps.readFile returns a Buffer, which fflate
// accepts directly — wrapping it would copy the whole archive.
async function listZipEntryFiles(
  deps: CommandDeps,
  zipFilePath: string,
): Promise<string[]> {
  try {
    return listZipPayloadFiles(await deps.readFile(zipFilePath));
  } catch {
    return [];
  }
}

function warnAboutLongNamePaths(deps: CommandDeps, files: string[]): void {
  if (deps.stderr === undefined) {
    return;
  }

  const longNamePaths = findLongNamePaths(files);
  if (longNamePaths.length === 0) {
    return;
  }

  writeLine(deps.stderr, formatLongNameWarning(longNamePaths));
}

function isJsBundleFile(archivePath: string): boolean {
  const name = archivePath.split("/").pop() ?? archivePath;
  return (
    name.endsWith(".bundle") ||
    name.endsWith(".jsbundle") ||
    name.endsWith(".hbc")
  );
}

async function uploadReleaseArchive(
  command: ReleaseCreateCommand,
  deps: CommandDeps,
  input: {
    bundleArchivePath: string;
    deploymentId: string;
    fingerprint: string;
    privateKeyPath?: string;
    sourcemapPath?: string;
    targetBinaryVersion: string;
  },
  progress: Progress,
): Promise<unknown> {
  const signingMetadata: SigningMetadata =
    input.privateKeyPath === undefined
      ? {}
      : await buildSigningMetadata(
          deps,
          input.bundleArchivePath,
          input.privateKeyPath,
        );
  const bundleZip = await deps.readFile(input.bundleArchivePath);
  const sourcemap =
    input.sourcemapPath === undefined
      ? undefined
      : await deps.readFile(input.sourcemapPath);

  const { uploadSettings, safetyPolicy } = releaseFormPoliciesFromUploadPolicy(
    {
      rolloutPercentage: command.rolloutPercentage,
      isMandatory: command.isMandatory,
      disabled: command.disabled,
      noDuplicateReleaseError: command.noDuplicateReleaseError,
      releaseNotes: command.releaseNotes,
    },
    command.allowFingerprintMismatch === true ? "allow" : "block",
  );
  const interactionContext = interactionContextFromCommand(command);

  return executeReleasePublication(deps, {
    allowFingerprintMismatch: command.allowFingerprintMismatch === true,
    duplicateRelease: safetyPolicy.duplicateRelease,
    interaction: interactionContext,
    onPrompt: progress.settle,
    onRetry: () => progress.write("Retrying approved release"),
    upload: async ({ idempotencyKey, safetyPolicy: attemptSafetyPolicy }) => {
      const body = releaseFormFromParts(
        {
          fingerprint: input.fingerprint,
          targetBinaryVersion: input.targetBinaryVersion,
          signature: signingMetadata.signature,
          signatureHashAlgorithm: signingMetadata.signatureHashAlgorithm,
          bundleZip,
          bundleFile: path.basename(input.bundleArchivePath),
          sourcemap,
          sourcemapFile:
            input.sourcemapPath === undefined
              ? undefined
              : path.basename(input.sourcemapPath),
        },
        uploadSettings,
        attemptSafetyPolicy,
      );

      return authenticatedRequest(deps, {
        init: {
          body,
          headers: {
            "idempotency-key": idempotencyKey,
          },
          method: "POST",
        },
        serverUrl: command.serverUrl,
        token: command.token,
        url: buildApiUrl(
          command.serverUrl,
          `/v1/deployments/${encodeURIComponent(input.deploymentId)}/releases`,
        ),
      });
    },
  });
}

async function buildSigningMetadata(
  deps: CommandDeps,
  zipPath: string,
  privateKeyPath: string,
): Promise<{ signature: string; signatureHashAlgorithm: string }> {
  const zipBuffer = await deps.readFile(zipPath);
  const privateKeyPem = await deps.readFile(privateKeyPath);
  const contentHash = computePackageHashFromZipBuffer(zipBuffer);

  return {
    signature: signContentHashJwt({
      contentHash,
      privateKeyPem,
    }),
    signatureHashAlgorithm: SIGNATURE_HASH_ALGORITHM,
  };
}

function formatErrorSuffix(error: unknown): string {
  if (!(error instanceof Error) || error.message.length === 0) {
    return "";
  }

  return ` (${error.message})`;
}
