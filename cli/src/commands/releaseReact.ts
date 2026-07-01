import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path, { resolve } from "node:path";

import { serializeArtifact } from "@codemagic/patch-shared";

import { buildArtifactFromBundleDir } from "../artifactBuild";
import { resolveBaseBytecode } from "../baseBytecode";
import type {
  BundleCommand,
  ReactBuildOptions,
  ReleaseCreateCommand,
  ReleaseReactCommand,
} from "../commandTypes";
import { readSdkDeliveryConfig } from "../sdkConfig";
import {
  isInteractiveOutput,
  writeLine,
  type WritableStream,
} from "../output";
import {
  assertExplicitBinaryVersion,
  resolveTargetBinaryVersion,
} from "../targetBinaryVersion";
import {
  detectProjectBundler,
  formatBundlerName,
  resolveNativeProjectContext,
  type NativeProjectContext,
} from "../projectAnalysis";
import { enforceMutationSafety } from "./mutationSafety";
import { executeReleaseCreate } from "./releaseCreate";
import { formatDeploymentSelector } from "./resolveNames";
import {
  ensureReadableDirectory,
  ensureReadableFile,
  type CommandDeps,
  UsageError,
  ValidationError,
} from "./shared";

type ReleaseReactDeps = CommandDeps & {
  stderr?: WritableStream;
};

type ReleaseReactProgress = {
  warn: (message: string) => void;
  write: (message: string) => void;
};

const PLATFORM_BUNDLE_FILENAMES: Record<
  ReleaseReactCommand["platform"],
  string
> = {
  android: "index.android.bundle",
  ios: "main.jsbundle",
};

// hermesc flag that compiles against a previous build's bytecode, preserving its
// layout so the server's binary diff stays small (facebook/hermes#208). Wired
// behind a constant so the exact spelling can be confirmed against the bundled
// hermesc (`hermesc -help`) during the benchmark.
const HERMES_BASE_BYTECODE_FLAG = "-base-bytecode";

type ReleaseReactContext = {
  bundler: ReleaseReactBundlerContext;
  command: ReactBuildOptions;
  nativeProject: NativeProjectContext;
  projectRoot: string;
};

type ExpoConfigVersion = {
  sourcePath: string;
  version: string;
};

type ReleaseReactBundlerContext =
  | {
      kind: "metro";
    }
  | {
      expoCommand: ResolvedExpoCommand;
      kind: "expo";
      publicConfig: ExpoPublicConfig;
    };

type BundlePlan = {
  args: string[];
  command: string;
  commandName: string;
  cwd: string;
  outputLabel: string;
  postSteps: BundlePostStep[];
};

type BundlePostStep = {
  baseBytecodePath?: string;
  bundlePath: string;
  command: ReactBuildOptions;
  kind: "hermes-compile";
  optimize?: boolean;
  projectRoot: string;
  sourcemapPath?: string;
};

type BytecodeDecision = {
  enabled: boolean;
};

type ExpoPublicConfig = {
  sourcePath: string;
  value: unknown;
};

type ResolvedExpoCommand = {
  argsPrefix: string[];
  canResolveEntryFileLocally: boolean;
  command: string;
};

export async function executeReleaseReact(
  command: ReleaseReactCommand,
  deps: ReleaseReactDeps,
): Promise<unknown> {
  const progress = createReleaseReactProgress(deps);
  progress.write("Resolving project and bundler configuration...");
  const context = await resolveReleaseReactContext(command, deps);
  const { projectRoot } = context;
  progress.write("Resolving target binary version...");
  const targetBinaryVersion = await resolveReleaseReactTargetBinaryVersion(
    deps,
    context,
  );
  // Validate before the expensive bundle build so a wildcard/range version
  // fails fast instead of after the user pays the full build cost.
  assertExplicitBinaryVersion(targetBinaryVersion);
  progress.write("Computing native fingerprint...");
  const fingerprint = await deps.computeFingerprint({
    platform: command.platform,
    projectRoot,
  });

  await enforceMutationSafety(deps, {
    commandName: "release-react",
    dryRun: command.dryRun,
    fields: [
      ["serverUrl", command.serverUrl],
      ["deployment", formatDeploymentSelector(command.deployment)],
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

  const tempRoot = await fs.mkdtemp(
    path.join(tmpdir(), "codemagic-patch-release-react-"),
  );

  try {
    const { payloadRoot, sourcemapPath } = await bundleReactIntoPayload(
      context,
      deps,
      progress,
      tempRoot,
      targetBinaryVersion,
    );

    const releaseCreateCommand: ReleaseCreateCommand = {
      bundlePath: payloadRoot,
      deployment: command.deployment,
      disabled: command.disabled,
      ...(command.dryRun ? { dryRunBundleGenerated: true } : {}),
      dryRun: command.dryRun,
      fingerprint,
      isMandatory: command.isMandatory,
      kind: "release-create",
      ...(command.nonInteractive === true ? { nonInteractive: true } : {}),
      noDuplicateReleaseError: command.noDuplicateReleaseError,
      platform: command.platform,
      privateKeyPath: command.privateKeyPath,
      projectRoot,
      releaseNotes: command.releaseNotes,
      rolloutPercentage: command.rolloutPercentage,
      serverUrl: command.serverUrl,
      sourcemapPath,
      targetBinaryVersion,
      token: command.token,
      // The release-react guard above already enforced mutation safety
      // (--yes, interactive confirm, or dry-run), so the delegated command
      // must not prompt a second time.
      yes: true,
    };

    progress.write(
      command.dryRun
        ? "Packaging release for dry run..."
        : "Packaging and uploading release...",
    );
    const result = await executeReleaseCreate(releaseCreateCommand, deps);
    progress.write(command.dryRun ? "Dry run complete." : "Release uploaded.");

    return result;
  } finally {
    await fs.rm(tempRoot, { force: true, recursive: true });
  }
}

/**
 * Build a self-describing `.cmpatch` artifact — the `bundle` command. Reuses the
 * same bundling pipeline as `release-react`, then packages the payload into an
 * artifact and writes it to disk instead of uploading. It talks to no
 * control-plane API and needs no credentials; with base-bytecode default-on it
 * does make one best-effort, unauthenticated fetch to the public delivery origin
 * (skippable with `--base-bytecode off`), degrading quietly when offline.
 */
export async function executeBundle(
  command: BundleCommand,
  deps: ReleaseReactDeps,
): Promise<unknown> {
  const progress = createReleaseReactProgress(deps);
  progress.write("Resolving project and bundler configuration...");
  const context = await resolveReleaseReactContext(command, deps);
  const { projectRoot } = context;
  progress.write("Resolving target binary version...");
  const targetBinaryVersion = await resolveReleaseReactTargetBinaryVersion(
    deps,
    context,
  );
  // Validate before the expensive bundle build so a wildcard/range version
  // fails fast instead of after the user pays the full build cost.
  assertExplicitBinaryVersion(targetBinaryVersion);
  progress.write("Computing native fingerprint...");
  const fingerprint = await deps.computeFingerprint({
    platform: command.platform,
    projectRoot,
  });
  const bytecode = await resolveBytecodeDecision(context);

  const tempRoot = await fs.mkdtemp(path.join(tmpdir(), "codemagic-patch-bundle-"));

  try {
    const { payloadRoot, sourcemapPath } = await bundleReactIntoPayload(
      context,
      deps,
      progress,
      tempRoot,
      targetBinaryVersion,
    );

    progress.write("Packaging .cmpatch artifact...");
    const artifact = await buildArtifactFromBundleDir(deps, {
      payloadRoot,
      platform: command.platform,
      targetBinaryVersion,
      fingerprint,
      bundler: context.bundler.kind,
      hermes: bytecode.enabled,
      defaults: {
        rolloutPercentage: command.rolloutPercentage,
        isMandatory: command.isMandatory,
        disabled: command.disabled,
        noDuplicateReleaseError: command.noDuplicateReleaseError,
        releaseNotes: command.releaseNotes ?? "",
      },
      createdAt: new Date().toISOString(),
      ...(command.privateKeyPath !== undefined
        ? { privateKeyPath: command.privateKeyPath }
        : {}),
      ...(sourcemapPath !== undefined ? { sourcemapPath } : {}),
    });

    const outputPath = resolveBundleOutputPath(command, projectRoot);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, serializeArtifact(artifact));
    progress.write(`Wrote ${outputPath}`);

    return {
      bundleSize: artifact.descriptor.bundleSize,
      fingerprint,
      outputPath,
      packageHash: artifact.descriptor.packageHash,
      platform: command.platform,
      signed: artifact.descriptor.signature !== undefined,
      targetBinaryVersion,
    };
  } finally {
    await fs.rm(tempRoot, { force: true, recursive: true });
  }
}

export function resolveBundleOutputPath(
  command: BundleCommand,
  projectRoot: string,
): string {
  if (command.outputPath !== undefined) {
    return resolve(command.outputPath);
  }
  const projectName = path.basename(path.resolve(projectRoot));
  return resolve(`${projectName}.${command.platform}.cmpatch`);
}

/**
 * Bundle the React Native app into `tempRoot/contents` (the verbatim release
 * payload) and return its location. Shared by `release-react` and the offline
 * `bundle` command; the caller owns the `tempRoot` lifecycle (and cleanup on
 * failure).
 */
async function bundleReactIntoPayload(
  context: ReleaseReactContext,
  deps: CommandDeps,
  progress: ReleaseReactProgress,
  tempRoot: string,
  targetBinaryVersion: string,
): Promise<{ payloadRoot: string; sourcemapPath?: string }> {
  const { command } = context;
  const payloadRoot = path.join(tempRoot, "contents");
  const bundlePath = path.join(
    payloadRoot,
    PLATFORM_BUNDLE_FILENAMES[command.platform],
  );
  const sourcemapPath =
    command.sourcemapOutputPath === undefined
      ? undefined
      : resolve(command.sourcemapOutputPath);

  await fs.mkdir(payloadRoot, { recursive: true });
  if (sourcemapPath !== undefined) {
    await fs.mkdir(path.dirname(sourcemapPath), { recursive: true });
  }

  const baseBytecodePath = await resolveBaseBytecodeForBuild(
    context,
    deps,
    progress,
    tempRoot,
    targetBinaryVersion,
  );

  const bundlePlan = await createBundlePlan({
    baseBytecodePath,
    bundlePath,
    deps,
    context,
    sourcemapPath,
  });
  await runBundlePlan(bundlePlan, deps, progress);
  progress.write("Verifying bundle output...");
  await ensureReadableFile(deps, bundlePath, bundlePlan.outputLabel);

  return { payloadRoot, sourcemapPath };
}

/**
 * Best-effort acquisition of the previous release's Hermes bytecode to compile
 * the new bundle against (`-base-bytecode`), shrinking the predecessor patch.
 * Default-on; returns `undefined` and emits at most one quiet info line whenever
 * the optimization cannot apply — it never blocks or slows a release.
 */
async function resolveBaseBytecodeForBuild(
  context: ReleaseReactContext,
  deps: CommandDeps,
  progress: ReleaseReactProgress,
  tempRoot: string,
  targetBinaryVersion: string,
): Promise<string | undefined> {
  const { command } = context;
  if (command.baseBytecode === "off") {
    return undefined;
  }

  // The base only affects Hermes bytecode; a non-Hermes (JSC) build has nothing
  // to align.
  const bytecode = await resolveBytecodeDecision(context);
  if (!bytecode.enabled) {
    return undefined;
  }

  const sdkConfig = await readSdkDeliveryConfig(deps, {
    platform: command.platform,
    projectRoot: context.projectRoot,
    ...(command.plistFile !== undefined ? { plistFile: command.plistFile } : {}),
    ...(command.plistFilePrefix !== undefined
      ? { plistFilePrefix: command.plistFilePrefix }
      : {}),
  });

  if (
    sdkConfig.downloadBaseUrl === undefined ||
    sdkConfig.deploymentKey === undefined
  ) {
    progress.write(
      "base bytecode optimization skipped: native SDK config (download base URL / deployment key) not found",
    );
    return undefined;
  }

  const resolution = await resolveBaseBytecode(deps, {
    binaryVersion: targetBinaryVersion,
    deploymentKey: sdkConfig.deploymentKey,
    downloadBaseUrl: sdkConfig.downloadBaseUrl,
    platform: command.platform,
    tempDir: tempRoot,
  }).catch((error: unknown) => ({
    // Defence in depth: resolveBaseBytecode is structurally non-throwing, but the
    // never-fail contract is load-bearing, so any unexpected throw still degrades
    // to a quiet skip rather than failing the release.
    kind: "skipped" as const,
    reason: error instanceof Error ? error.message : "unexpected error",
  }));

  if (resolution.kind === "skipped") {
    progress.write(`base bytecode optimization skipped: ${resolution.reason}`);
    return undefined;
  }

  progress.write("Aligning Hermes bytecode to the previous release...");
  return resolution.path;
}

function createReleaseReactProgress(
  deps: Pick<ReleaseReactDeps, "stderr">,
): ReleaseReactProgress {
  const interactive =
    deps.stderr !== undefined && isInteractiveOutput(deps.stderr);

  return {
    // Warnings are not gated on interactivity: they matter most in CI logs.
    warn(message) {
      if (deps.stderr !== undefined) {
        writeLine(deps.stderr, `release-react: warning: ${message}`);
      }
    },
    write(message) {
      if (interactive) {
        writeLine(deps.stderr!, `release-react: ${message}`);
      }
    },
  };
}

async function resolveReleaseReactContext(
  command: ReactBuildOptions,
  deps: CommandDeps,
): Promise<ReleaseReactContext> {
  const projectRoot = await ensureReadableDirectory(
    deps,
    command.projectRoot,
    "project root",
  );
  const nativeProject = await resolveNativeProjectContext(deps, {
    hasExplicitNativeProjectOption: hasExplicitNativeProjectOption(command),
    platform: command.platform,
    projectRoot,
  });

  const bundler =
    command.bundler === "auto"
      ? await detectProjectBundler(deps, projectRoot)
      : { kind: command.bundler, reason: "explicit --bundler" };

  if (bundler.kind === "repack" || bundler.kind === "rock") {
    throw new UsageError(
      `Detected ${formatBundlerName(bundler.kind)} project from ${bundler.reason}, but release-react currently supports Metro and Expo bundling only. Pass --bundler metro to force Metro if this project can still bundle with Metro.`,
    );
  }

  if (bundler.kind === "expo") {
    assertExpoCompatibleOptions(command);
    const expoContext = await resolveExpoContext(deps, projectRoot);
    return {
      bundler: {
        expoCommand: expoContext.expoCommand,
        kind: "expo",
        publicConfig: expoContext.publicConfig,
      },
      command,
      nativeProject,
      projectRoot,
    };
  }

  return {
    bundler: {
      kind: "metro",
    },
    command,
    nativeProject,
    projectRoot,
  };
}

function assertExpoCompatibleOptions(command: ReactBuildOptions): void {
  if (command.hermes !== "auto") {
    throw new UsageError(
      "--hermes true|false is only supported with --bundler metro; Expo uses Expo config jsEngine",
    );
  }

  if (command.extraHermesFlags.length > 0) {
    throw new UsageError("--extra-hermes-flag is only supported with --bundler metro");
  }
}

async function resolveReleaseReactTargetBinaryVersion(
  deps: CommandDeps,
  context: ReleaseReactContext,
): Promise<string> {
  const { command } = context;
  const nativeInput = createNativeTargetBinaryVersionInput(context);

  if (command.targetBinaryVersion !== undefined) {
    return await resolveTargetBinaryVersion(deps, {
      ...nativeInput,
      explicitTargetBinaryVersion: command.targetBinaryVersion,
    });
  }

  if (context.bundler.kind !== "expo") {
    return await resolveTargetBinaryVersion(deps, nativeInput);
  }

  if (context.nativeProject.kind === "present") {
    return await resolveTargetBinaryVersion(deps, nativeInput);
  }

  const expoConfigVersion = detectExpoConfigVersion(context.bundler.publicConfig);
  if (expoConfigVersion !== null) {
    return expoConfigVersion.version;
  }

  throw new ValidationError(
    `Could not detect target binary version for Expo project at ${context.projectRoot}. Set expo.version in Expo config or pass --target-binary-version explicitly.`,
  );
}

function createNativeTargetBinaryVersionInput(context: ReleaseReactContext): {
  buildConfigurationName?: string;
  gradleFile?: string;
  platform: ReleaseReactCommand["platform"];
  plistFile?: string;
  plistFilePrefix?: string;
  projectRoot: string;
  xcodeProjectFile?: string;
  xcodeTargetName?: string;
} {
  const { command, projectRoot } = context;
  return {
    platform: command.platform,
    projectRoot,
    ...(command.buildConfigurationName !== undefined
      ? { buildConfigurationName: command.buildConfigurationName }
      : {}),
    ...(command.gradleFile !== undefined
      ? { gradleFile: command.gradleFile }
      : {}),
    ...(command.plistFile !== undefined
      ? { plistFile: command.plistFile }
      : {}),
    ...(command.plistFilePrefix !== undefined
      ? { plistFilePrefix: command.plistFilePrefix }
      : {}),
    ...(command.xcodeProjectFile !== undefined
      ? { xcodeProjectFile: command.xcodeProjectFile }
      : {}),
    ...(command.xcodeTargetName !== undefined
      ? { xcodeTargetName: command.xcodeTargetName }
      : {}),
  };
}

function hasExplicitNativeProjectOption(command: ReactBuildOptions): boolean {
  if (command.platform === "android") {
    return command.gradleFile !== undefined;
  }

  return (
    command.plistFile !== undefined ||
    command.xcodeProjectFile !== undefined
  );
}

function detectExpoConfigVersion(
  publicConfig: ExpoPublicConfig,
): ExpoConfigVersion | null {
  const version = readExpoVersion(publicConfig.value);
  if (version !== null) {
    return {
      sourcePath: publicConfig.sourcePath,
      version,
    };
  }

  return null;
}

async function resolveExpoContext(
  deps: Pick<CommandDeps, "runCommand">,
  projectRoot: string,
): Promise<{
  expoCommand: ResolvedExpoCommand;
  publicConfig: ExpoPublicConfig;
}> {
  const expoCommand = await resolveExpoCommand(projectRoot);
  const publicConfig = await loadExpoPublicConfig(
    deps,
    projectRoot,
    expoCommand,
  );

  return {
    expoCommand,
    publicConfig,
  };
}

async function loadExpoPublicConfig(
  deps: Pick<CommandDeps, "runCommand">,
  projectRoot: string,
  expoCommand: ResolvedExpoCommand,
): Promise<ExpoPublicConfig> {
  const result = await deps.runCommand(
    expoCommand.command,
    [...expoCommand.argsPrefix, "config", "--type", "public", "--json"],
    {
      cwd: projectRoot,
    },
  );

  if (result.exitCode !== 0) {
    throw commandFailedError("expo config", result);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new ValidationError(
      "Could not parse Expo config output. Pass --target-binary-version explicitly.",
    );
  }

  return {
    sourcePath: "Expo config",
    value: parsed,
  };
}

function readExpoVersion(value: unknown): string | null {
  const expoConfig = readExpoConfigObject(value);
  if (expoConfig === null) {
    return null;
  }

  const version = expoConfig.version;
  if (typeof version !== "string") {
    return null;
  }

  const trimmed = version.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function shouldEmitExpoBytecode(
  value: unknown,
  platform: ReleaseReactCommand["platform"],
): boolean {
  return readExpoJsEngine(value, platform) !== "jsc";
}

function readExpoJsEngine(
  value: unknown,
  platform: ReleaseReactCommand["platform"],
): string | undefined {
  const expoConfig = readExpoConfigObject(value);
  if (expoConfig === null) {
    return undefined;
  }

  const platformConfig = expoConfig[platform];
  if (isRecord(platformConfig)) {
    const platformJsEngine = normalizeJsEngine(platformConfig.jsEngine);
    if (platformJsEngine !== undefined) {
      return platformJsEngine;
    }
  }

  return normalizeJsEngine(expoConfig.jsEngine);
}

function readExpoConfigObject(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }

  return isRecord(value.expo) ? value.expo : value;
}

function normalizeJsEngine(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}

// Intentionally looser than isRecord in ../output: arrays are accepted, and
// expo config parsing below relies on that. Do not replace with the shared guard.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function resolveBytecodeDecision(
  context: ReleaseReactContext,
): Promise<BytecodeDecision> {
  if (context.bundler.kind === "expo" && context.nativeProject.kind === "absent") {
    return {
      enabled: shouldEmitExpoBytecode(
        context.bundler.publicConfig.value,
        context.command.platform,
      ),
    };
  }

  return {
    enabled: await shouldCompileHermes(context.command, context.projectRoot, {
      allowCliOverride: context.bundler.kind === "metro",
    }),
  };
}

async function createBundlePlan(input: {
  baseBytecodePath?: string;
  bundlePath: string;
  context: ReleaseReactContext;
  deps: CommandDeps;
  sourcemapPath?: string;
}): Promise<BundlePlan> {
  return input.context.bundler.kind === "expo"
    ? await createExpoBundlePlan(input)
    : await createMetroBundlePlan(input);
}

async function createMetroBundlePlan(input: {
  baseBytecodePath?: string;
  bundlePath: string;
  context: ReleaseReactContext;
  deps: CommandDeps;
  sourcemapPath?: string;
}): Promise<BundlePlan> {
  const { command, projectRoot } = input.context;
  const reactNativeCommand = await resolveReactNativeCommand(projectRoot);
  const entryFile = command.entryFile ?? "index.js";
  const args = [
    ...reactNativeCommand.argsPrefix,
    "bundle",
    "--platform",
    command.platform,
    "--dev",
    "false",
    "--entry-file",
    entryFile,
    "--bundle-output",
    input.bundlePath,
    "--assets-dest",
    path.dirname(input.bundlePath),
  ];

  if (input.sourcemapPath !== undefined) {
    args.push("--sourcemap-output", input.sourcemapPath);
  }

  args.push(...(command.bundlerArgs ?? []));

  const bytecode = await resolveBytecodeDecision(input.context);
  const postSteps: BundlePostStep[] = bytecode.enabled
    ? [
        {
          bundlePath: input.bundlePath,
          command,
          kind: "hermes-compile",
          projectRoot,
          ...(input.baseBytecodePath !== undefined
            ? { baseBytecodePath: input.baseBytecodePath }
            : {}),
          ...(input.sourcemapPath !== undefined
            ? { sourcemapPath: input.sourcemapPath }
            : {}),
        },
      ]
    : [];

  return {
    args,
    command: reactNativeCommand.command,
    commandName: "react-native bundle",
    cwd: projectRoot,
    outputLabel: "Metro bundle output",
    postSteps,
  };
}

async function createExpoBundlePlan(input: {
  baseBytecodePath?: string;
  bundlePath: string;
  context: ReleaseReactContext;
  deps: CommandDeps;
  sourcemapPath?: string;
}): Promise<BundlePlan> {
  if (input.context.bundler.kind !== "expo") {
    throw new Error("Expo bundle plan requested for a non-Expo context");
  }

  const { command, projectRoot } = input.context;
  const expoCommand = input.context.bundler.expoCommand;
  const entryFile = await resolveExpoBundleEntryFile(
    input.context,
    input.deps,
    expoCommand,
  );
  const args = [
    ...expoCommand.argsPrefix,
    "export:embed",
    "--platform",
    command.platform,
    "--dev",
    "false",
  ];

  if (entryFile !== undefined) {
    args.push("--entry-file", entryFile);
  }

  args.push("--bundle-output", input.bundlePath);
  args.push("--assets-dest", path.dirname(input.bundlePath));

  const bytecode = await resolveBytecodeDecision(input.context);
  const baseBytecodePath = bytecode.enabled ? input.baseBytecodePath : undefined;

  // When aligning to a base, take over the Hermes step: have Expo emit a plain
  // (Hermes-ready) JS bundle and compile it ourselves so we can pass
  // -base-bytecode. Otherwise let Expo compile bytecode internally, exactly as
  // before — limiting the blast radius to releases that actually benefit.
  if (bytecode.enabled && baseBytecodePath === undefined) {
    args.push("--bytecode");
  } else if (baseBytecodePath !== undefined) {
    // Match Expo's own `--bytecode` path, which skips minification (Hermes does the
    // optimizing). A minified bundle compiles to bytecode that `-base-bytecode` can't
    // align to an Expo-native predecessor.
    args.push("--minify", "false");
  }

  if (input.sourcemapPath !== undefined) {
    args.push("--sourcemap-output", input.sourcemapPath);
  }

  args.push(...(command.bundlerArgs ?? []));

  const postSteps: BundlePostStep[] = [];
  if (baseBytecodePath !== undefined) {
    postSteps.push({
      baseBytecodePath,
      bundlePath: input.bundlePath,
      command,
      kind: "hermes-compile",
      // -O matches Expo's own Hermes compile (with `--minify false` above, the
      // output matches Expo's native bytecode).
      optimize: true,
      projectRoot,
      ...(input.sourcemapPath !== undefined
        ? { sourcemapPath: input.sourcemapPath }
        : {}),
    });
  }

  return {
    args,
    command: expoCommand.command,
    commandName: "expo export:embed",
    cwd: projectRoot,
    outputLabel: "Expo bundle output",
    postSteps,
  };
}

async function runBundlePlan(
  plan: BundlePlan,
  deps: CommandDeps,
  progress: ReleaseReactProgress,
): Promise<void> {
  progress.write(`Bundling JavaScript with ${plan.commandName}...`);
  const bundleResult = await deps.runCommand(plan.command, plan.args, {
    cwd: plan.cwd,
  });

  if (bundleResult.exitCode !== 0) {
    throw commandFailedError(plan.commandName, bundleResult);
  }

  for (const postStep of plan.postSteps) {
    switch (postStep.kind) {
      case "hermes-compile":
        progress.write("Compiling Hermes bytecode...");
        await runHermesCompile({
          bundlePath: postStep.bundlePath,
          command: postStep.command,
          deps,
          progress,
          projectRoot: postStep.projectRoot,
          ...(postStep.baseBytecodePath !== undefined
            ? { baseBytecodePath: postStep.baseBytecodePath }
            : {}),
          ...(postStep.optimize !== undefined
            ? { optimize: postStep.optimize }
            : {}),
          ...(postStep.sourcemapPath !== undefined
            ? { sourcemapPath: postStep.sourcemapPath }
            : {}),
        });
        break;
    }
  }
}

async function resolveExpoBundleEntryFile(
  context: ReleaseReactContext,
  deps: CommandDeps,
  expoCommand: ResolvedExpoCommand,
): Promise<string | undefined> {
  if (context.command.entryFile !== undefined) {
    return context.command.entryFile;
  }

  if (!expoCommand.canResolveEntryFileLocally) {
    return undefined;
  }

  return await resolveExpoEntryFile(context, deps);
}

async function resolveExpoEntryFile(
  context: ReleaseReactContext,
  deps: CommandDeps,
): Promise<string> {
  const scriptPath = await resolveExpoResolveAppEntryPath(context.projectRoot);
  const result = await deps.runCommand(
    process.execPath,
    [
      "-e",
      `require(${JSON.stringify(scriptPath)})`,
      context.projectRoot,
      context.command.platform,
      "absolute",
    ],
    {
      cwd: context.projectRoot,
    },
  );

  if (result.exitCode !== 0) {
    throw commandFailedError("expo resolveAppEntry", result);
  }

  const entryFile = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);

  if (entryFile === undefined) {
    throw new UsageError(
      `Could not resolve Expo entry file for ${context.command.platform} project at ${context.projectRoot}. Pass --entry-file explicitly.`,
    );
  }

  return entryFile;
}

async function runHermesCompile(input: {
  baseBytecodePath?: string;
  bundlePath: string;
  command: ReactBuildOptions;
  deps: CommandDeps;
  optimize?: boolean;
  progress: ReleaseReactProgress;
  projectRoot: string;
  sourcemapPath?: string;
}): Promise<void> {
  if (
    input.sourcemapPath === undefined &&
    input.command.extraHermesFlags.includes("-output-source-map")
  ) {
    throw new UsageError(
      "--extra-hermes-flag=-output-source-map requires --sourcemap-output",
    );
  }

  const hermesCommand = await resolveHermesCommand(input.projectRoot);
  const bytecodePath = `${input.bundlePath}.hbc`;
  const runHermes = (baseBytecodePath: string | undefined) =>
    input.deps.runCommand(
      hermesCommand,
      buildHermesArgs({
        baseBytecodePath,
        bundlePath: input.bundlePath,
        bytecodePath,
        extraHermesFlags: input.command.extraHermesFlags,
        optimize: input.optimize === true,
        withSourceMap: input.sourcemapPath !== undefined,
      }),
      { cwd: input.projectRoot },
    );

  let hermesResult = await runHermes(input.baseBytecodePath);

  // The base was acquired and passed, but hermesc rejected it — usually an
  // incompatible Hermes bytecode version (e.g. after an RN upgrade). Retry once
  // without the base so the release still ships, just with a normal-size patch.
  if (hermesResult.exitCode !== 0 && input.baseBytecodePath !== undefined) {
    input.progress.warn(
      "base bytecode was rejected by hermesc (likely an incompatible Hermes version); compiled without it, so this release ships a normal-size patch",
    );
    hermesResult = await runHermes(undefined);
  }

  if (hermesResult.exitCode !== 0) {
    throw commandFailedError("hermesc", hermesResult);
  }

  await fs.rename(bytecodePath, input.bundlePath);

  if (input.sourcemapPath === undefined) {
    return;
  }

  const compilerSourceMapPath = `${bytecodePath}.map`;
  const composeScriptPath = await resolveComposeSourceMapsPath(
    input.projectRoot,
  );
  const debugIdFields = await readSourceMapDebugIdFields(input.sourcemapPath);
  const composeResult = await input.deps.runCommand(
    process.execPath,
    [
      composeScriptPath,
      input.sourcemapPath,
      compilerSourceMapPath,
      "-o",
      input.sourcemapPath,
    ],
    { cwd: input.projectRoot },
  );

  if (composeResult.exitCode !== 0) {
    throw commandFailedError("compose-source-maps", composeResult);
  }

  if (Object.keys(debugIdFields).length > 0) {
    input.progress.write("Preserving source map debugId...");
    try {
      await restoreSourceMapDebugIdFields(input.sourcemapPath, debugIdFields);
    } catch (error) {
      input.progress.warn(
        `failed to preserve source map debugId; crash symbolication may not work for this release${formatErrorSuffix(error)}`,
      );
    }
  }

  await fs.rm(compilerSourceMapPath, { force: true });
}

function buildHermesArgs(input: {
  baseBytecodePath?: string;
  bundlePath: string;
  bytecodePath: string;
  extraHermesFlags: string[];
  optimize: boolean;
  withSourceMap: boolean;
}): string[] {
  // `-w` and `-max-diagnostic-width=80` are diagnostic-only and do not affect
  // the emitted bytes. `-O` and `-base-bytecode` go among the flags, before the
  // input path. With neither set (the Metro path), these args are byte-for-byte
  // identical to before this optimization existed.
  const args = ["-w", "-emit-binary", "-max-diagnostic-width=80", "-out", input.bytecodePath];

  if (input.optimize) {
    args.push("-O");
  }

  if (input.baseBytecodePath !== undefined) {
    args.push(HERMES_BASE_BYTECODE_FLAG, input.baseBytecodePath);
  }

  args.push(input.bundlePath, ...input.extraHermesFlags);

  if (input.withSourceMap) {
    args.push("-output-source-map");
  }

  return args;
}

const SOURCE_MAP_DEBUG_ID_KEYS = ["debugId", "debug_id"] as const;

async function readSourceMapDebugIdFields(
  sourcemapPath: string,
): Promise<Record<string, string>> {
  const raw = await readOptionalText(sourcemapPath);
  // Substring probe before parsing: source maps are routinely tens to
  // hundreds of MB, and most projects carry no debug id at all. False
  // positives (e.g. "debugId" inside sourcesContent) only cost a parse.
  if (
    raw === undefined ||
    !SOURCE_MAP_DEBUG_ID_KEYS.some((key) => raw.includes(`"${key}"`))
  ) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }

  if (!isRecord(parsed)) {
    return {};
  }

  const fields: Record<string, string> = {};
  for (const key of SOURCE_MAP_DEBUG_ID_KEYS) {
    const value = parsed[key];
    if (typeof value === "string") {
      fields[key] = value;
    }
  }

  return fields;
}

async function restoreSourceMapDebugIdFields(
  sourcemapPath: string,
  fields: Record<string, string>,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(sourcemapPath, "utf8"));
  } catch (error) {
    throw new Error(
      `could not read composed source map at ${sourcemapPath}${formatErrorSuffix(error)}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error(
      `compose-source-maps produced an unexpected source map at ${sourcemapPath}`,
    );
  }

  let changed = false;
  for (const [key, value] of Object.entries(fields)) {
    if (parsed[key] === undefined) {
      parsed[key] = value;
      changed = true;
    }
  }

  if (changed) {
    await fs.writeFile(sourcemapPath, JSON.stringify(parsed));
  }
}

function commandFailedError(
  commandName: string,
  result: {
    exitCode: number | null;
    signal: string | null;
    stderr: string;
    stdout: string;
  },
): Error {
  const detail = [result.stderr.trim(), result.stdout.trim()]
    .filter(Boolean)
    .join("\n");
  const status =
    result.exitCode === null
      ? `signal ${String(result.signal)}`
      : `exit code ${String(result.exitCode)}`;

  return new Error(
    `${commandName} failed with ${status}${detail ? `:\n${detail}` : ""}`,
  );
}

async function shouldCompileHermes(
  command: ReactBuildOptions,
  projectRoot: string,
  options: { allowCliOverride?: boolean } = {},
): Promise<boolean> {
  const allowCliOverride = options.allowCliOverride ?? true;

  if (allowCliOverride && command.hermes === "true") {
    return true;
  }

  if (allowCliOverride && command.hermes === "false") {
    return false;
  }

  return command.platform === "android"
    ? await detectAndroidHermesEnabled(command, projectRoot)
    : await detectIosHermesEnabled(projectRoot);
}

async function detectAndroidHermesEnabled(
  command: ReactBuildOptions,
  projectRoot: string,
): Promise<boolean> {
  const gradleProperties = await readOptionalText(
    path.join(projectRoot, "android", "gradle.properties"),
  );
  const gradlePropertiesMatch = gradleProperties?.match(
    /^\s*hermesEnabled\s*=\s*(true|false)\s*$/im,
  );

  if (gradlePropertiesMatch) {
    return gradlePropertiesMatch[1]!.toLowerCase() === "true";
  }

  const buildGradle = await readOptionalText(
    command.gradleFile === undefined
      ? path.join(projectRoot, "android", "app", "build.gradle")
      : path.isAbsolute(command.gradleFile)
        ? command.gradleFile
        : path.join(projectRoot, command.gradleFile),
  );
  const legacyMatch = buildGradle?.match(
    /\benableHermes\s*:\s*(true|false)\b/i,
  );

  if (legacyMatch) {
    return legacyMatch[1]!.toLowerCase() === "true";
  }

  return (await getReactNativeVersion(projectRoot)) >= 70;
}

async function detectIosHermesEnabled(projectRoot: string): Promise<boolean> {
  const podfileProperties = await readOptionalJson(
    path.join(projectRoot, "ios", "Podfile.properties.json"),
  );
  const expoJsEngine = normalizeJsEngine(podfileProperties?.["expo.jsEngine"]);
  if (expoJsEngine !== undefined) {
    return expoJsEngine === "hermes";
  }

  const podfile = await readOptionalText(path.join(projectRoot, "ios", "Podfile"));

  if (podfile !== undefined) {
    if (/^[^#\n]*:?\bhermes_enabled\b\s*(=>|:)\s*false\b/im.test(podfile)) {
      return false;
    }

    if (/^[^#\n]*:?\bhermes_enabled\b\s*(=>|:)\s*true\b/im.test(podfile)) {
      return true;
    }
  }

  return (await getReactNativeVersion(projectRoot)) >= 70;
}

async function getReactNativeVersion(projectRoot: string): Promise<number> {
  const packageJson = await readOptionalJson(
    path.join(projectRoot, "node_modules", "react-native", "package.json"),
  );
  const version = typeof packageJson?.version === "string" ? packageJson.version : "";
  const match = version.match(/^0\.(\d+)\./);

  return match ? Number.parseInt(match[1]!, 10) : 0;
}

async function resolveHermesCommand(projectRoot: string): Promise<string> {
  const hermesOsBin = getHermesOsBin();
  const hermesExe = process.platform === "win32" ? "hermesc.exe" : "hermesc";
  const candidates = [
    path.join(
      projectRoot,
      "node_modules",
      "react-native",
      "sdks",
      "hermesc",
      hermesOsBin,
      hermesExe,
    ),
    path.join(
      projectRoot,
      "node_modules",
      "hermes-compiler",
      "hermesc",
      hermesOsBin,
      hermesExe,
    ),
    path.join(
      projectRoot,
      "node_modules",
      "hermes-engine",
      hermesOsBin,
      hermesExe,
    ),
  ];

  for (const candidate of candidates) {
    if (await isReadableFile(candidate)) {
      return candidate;
    }
  }

  throw new UsageError(
    `Could not find hermesc under project root: ${projectRoot}`,
  );
}

async function resolveComposeSourceMapsPath(projectRoot: string): Promise<string> {
  const scriptPath = path.join(
    projectRoot,
    "node_modules",
    "react-native",
    "scripts",
    "compose-source-maps.js",
  );

  if (await isReadableFile(scriptPath)) {
    return scriptPath;
  }

  throw new UsageError(
    `Could not find react-native/scripts/compose-source-maps.js under project root: ${projectRoot}`,
  );
}

function getHermesOsBin(): string {
  if (process.platform === "darwin") {
    return "osx-bin";
  }

  if (process.platform === "win32") {
    return "win64-bin";
  }

  return "linux64-bin";
}

async function isReadableFile(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

async function readOptionalText(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

async function readOptionalJson(
  filePath: string,
): Promise<Record<string, unknown> | undefined> {
  const content = await readOptionalText(filePath);
  if (content === undefined) {
    return undefined;
  }

  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function resolveReactNativeCommand(projectRoot: string): Promise<{
  argsPrefix: string[];
  command: string;
}> {
  const requireFromProject = createRequire(
    path.join(projectRoot, "package.json"),
  );

  try {
    return {
      argsPrefix: [requireFromProject.resolve("react-native/cli.js")],
      command: process.execPath,
    };
  } catch (error) {
    if (await projectUsesPackageManager(projectRoot, "yarn")) {
      return {
        argsPrefix: ["exec", "react-native"],
        command: "yarn",
      };
    }

    if (await projectUsesPackageManager(projectRoot, "pnpm")) {
      return {
        argsPrefix: ["exec", "react-native"],
        command: "pnpm",
      };
    }

    throw new UsageError(
      `Could not resolve react-native from project root: ${projectRoot}${formatErrorSuffix(error)}`,
    );
  }
}

async function resolveExpoCommand(
  projectRoot: string,
): Promise<ResolvedExpoCommand> {
  const requireFromProject = createRequire(
    path.join(projectRoot, "package.json"),
  );

  try {
    return {
      argsPrefix: [requireFromProject.resolve("expo/bin/cli")],
      canResolveEntryFileLocally: true,
      command: process.execPath,
    };
  } catch (error) {
    const expoCliPath = await findReadableExpoCli(projectRoot);
    if (expoCliPath !== undefined) {
      return {
        argsPrefix: [expoCliPath],
        canResolveEntryFileLocally: true,
        command: process.execPath,
      };
    }

    if (await projectUsesPackageManager(projectRoot, "yarn")) {
      return {
        argsPrefix: ["exec", "expo"],
        canResolveEntryFileLocally: false,
        command: "yarn",
      };
    }

    if (await projectUsesPackageManager(projectRoot, "pnpm")) {
      return {
        argsPrefix: ["exec", "expo"],
        canResolveEntryFileLocally: false,
        command: "pnpm",
      };
    }

    throw new UsageError(
      `Could not resolve expo from project root: ${projectRoot}${formatErrorSuffix(error)}`,
    );
  }
}

async function findReadableExpoCli(
  projectRoot: string,
): Promise<string | undefined> {
  const candidates = [
    path.join(projectRoot, "node_modules", "expo", "bin", "cli"),
    path.join(projectRoot, "node_modules", "expo", "bin", "cli.js"),
  ];

  for (const candidate of candidates) {
    try {
      const stats = await fs.stat(candidate);
      if (stats.isFile()) {
        return candidate;
      }
    } catch {
      // Try the next historical Expo CLI path.
    }
  }

  return undefined;
}

async function resolveExpoResolveAppEntryPath(
  projectRoot: string,
): Promise<string> {
  const requireFromProject = createRequire(
    path.join(projectRoot, "package.json"),
  );

  try {
    return requireFromProject.resolve("expo/scripts/resolveAppEntry");
  } catch (error) {
    const candidates = [
      path.join(projectRoot, "node_modules", "expo", "scripts", "resolveAppEntry"),
      path.join(
        projectRoot,
        "node_modules",
        "expo",
        "scripts",
        "resolveAppEntry.js",
      ),
    ];

    for (const candidate of candidates) {
      if (await isReadableFile(candidate)) {
        return candidate;
      }
    }

    throw new UsageError(
      `Could not resolve expo/scripts/resolveAppEntry from project root: ${projectRoot}${formatErrorSuffix(error)}`,
    );
  }
}

async function projectUsesPackageManager(
  projectRoot: string,
  packageManager: "pnpm" | "yarn",
): Promise<boolean> {
  const packageJson = await readProjectPackageJson(projectRoot);
  const configuredPackageManager = packageJson?.packageManager;
  if (
    typeof configuredPackageManager === "string" &&
    configuredPackageManager.startsWith(`${packageManager}@`)
  ) {
    return true;
  }

  const lockfile = packageManager === "yarn" ? "yarn.lock" : "pnpm-lock.yaml";

  try {
    const stats = await fs.stat(path.join(projectRoot, lockfile));
    return stats.isFile();
  } catch {
    return false;
  }
}

async function readProjectPackageJson(
  projectRoot: string,
): Promise<Record<string, unknown> | null> {
  try {
    const content = await fs.readFile(
      path.join(projectRoot, "package.json"),
      "utf8",
    );
    const parsed = JSON.parse(content) as unknown;

    return isRecord(parsed) ? parsed : {};
  } catch {
    return null;
  }
}

function formatErrorSuffix(error: unknown): string {
  if (!(error instanceof Error) || error.message.length === 0) {
    return "";
  }

  return ` (${error.message})`;
}
