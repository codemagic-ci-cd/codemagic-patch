import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  artifactToReleaseForm,
  parseArtifact,
  releaseFormFromParts,
  resolveUploadPolicy,
  type Artifact,
  type ReleaseDescriptor,
} from "@codemagic/patch-shared";

import type { ReleaseCreateCommand } from "../commandTypes";
import { authenticatedRequest } from "../authenticatedRequest";
import { computePackageHashFromZipBuffer } from "../packageHash";
import { signContentHashJwt, SIGNATURE_HASH_ALGORITHM } from "../signing";
import { writeLine } from "../output";
import { assertExplicitBinaryVersion } from "../targetBinaryVersion";
import { createZipFromDirectory, listArchiveFiles } from "../zip";
import { enforceMutationSafety } from "./mutationSafety";
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
): Promise<unknown> {
  if (command.artifactUpload === true) {
    return executeArtifactReleaseCreate(command, deps);
  }

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

  try {
    const bundleArchivePath = await prepareBundleArchive(
      deps,
      command.bundlePath,
      zipPath,
    );
    const fingerprint = await resolveFingerprint(command, deps);
    const deploymentId = await resolveDeploymentId(
      command.deployment,
      command.serverUrl,
      command.token,
      deps,
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

    enforceMutationSafety(deps, {
      commandName: "release create",
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
      nonInteractive: command.nonInteractive === true,
      yes: command.yes === true,
    });

    return await uploadReleaseArchive(command, deps, {
      bundleArchivePath,
      deploymentId,
      fingerprint,
      privateKeyPath,
      sourcemapPath,
      targetBinaryVersion,
    });
  } finally {
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
): Promise<unknown> {
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

  const deploymentId = await resolveDeploymentId(
    command.deployment,
    command.serverUrl,
    command.token,
    deps,
  );
  const policy = resolveUploadPolicy(
    descriptor.defaults,
    command.policyOverrides ?? {},
  );

  if (command.dryRun) {
    return buildArtifactDryRunResult(command, descriptor, deploymentId);
  }

  enforceMutationSafety(deps, {
    commandName: "release create",
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
    nonInteractive: command.nonInteractive === true,
    yes: command.yes === true,
  });

  return authenticatedRequest(deps, {
    init: {
      body: artifactToReleaseForm(artifact, policy),
      headers: {
        "idempotency-key": deps.randomUUID(),
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
}

function buildArtifactDryRunResult(
  command: ReleaseCreateCommand,
  descriptor: ReleaseDescriptor,
  deploymentId: string,
): ReleaseDryRunResult {
  return {
    bundlePath: path.resolve(command.bundlePath),
    deploymentId,
    dryRun: true,
    fingerprint: descriptor.fingerprint,
    platform: descriptor.platform,
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

async function prepareBundleArchive(
  deps: CommandDeps,
  inputPath: string,
  zipPath: string,
): Promise<string> {
  const resolvedPath = path.resolve(inputPath);
  let stats: Awaited<ReturnType<CommandDeps["stat"]>>;

  try {
    stats = await deps.stat(resolvedPath);
  } catch (error) {
    throw new UsageError(
      `bundle path was not found: ${resolvedPath}${formatErrorSuffix(error)}`,
    );
  }

  if (stats.isDirectory()) {
    const files = await listArchiveFiles(resolvedPath);
    if (files.length === 0) {
      throw new UsageError(
        `bundle directory contains no files: ${resolvedPath}`,
      );
    }
    if (!files.some(isJsBundleFile) && deps.stderr !== undefined) {
      writeLine(
        deps.stderr,
        `Warning: no recognizable JS bundle (e.g. index.android.bundle, main.jsbundle, *.hbc) found in ${resolvedPath}; uploading anyway.`,
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
    {
      rolloutPercentage: command.rolloutPercentage,
      isMandatory: command.isMandatory,
      disabled: command.disabled,
      noDuplicateReleaseError: command.noDuplicateReleaseError,
      releaseNotes: command.releaseNotes,
    },
  );

  return authenticatedRequest(deps, {
    init: {
      body,
      headers: {
        "idempotency-key": deps.randomUUID(),
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
