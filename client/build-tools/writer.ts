// The React Native build-metadata writer (specs/build-metadata.md §5.1, §5.2).
// It computes the record for one build and owns CodemagicPatchBuild.json at
// the path the build integration passes. That one file is the only thing it
// writes, replaces or removes; the bundle files it reads are never changed.

import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  buildReactNativeRecord,
  REACT_NATIVE_LAYOUTS,
  serializeBuildMetadata,
  type EmbeddedPair,
  type ReactNativePlatform,
} from "./buildMetadata";
import { computeNativeFingerprint } from "./calculator";
import { collectEmbeddedTree } from "./embeddedTree";
import { BuildToolsError } from "./errors";

export const SKIP_BUILD_FINGERPRINT_ENV = "CODEMAGIC_PATCH_SKIP_BUILD_FINGERPRINT";

export type BundleMode = "embedded" | "metro";

export type WriteInput = {
  platform: ReactNativePlatform;
  appRoot: string;
  /** The bundle file name the integration resolved; undefined means the default. */
  bundleName?: string;
  /** Absolute path of the metadata file. */
  output: string;
} & (
  | { bundleMode: "embedded"; bundleInputDir: string }
  | { bundleMode: "metro"; bundleInputDir?: string }
);

export type WriteResult = {
  /** False when the file already held the same bytes and was left alone. */
  written: boolean;
  fingerprintMs: number;
  /** Null in metro mode, where nothing is hashed. */
  embeddedMs: number | null;
  embeddedFileCount: number | null;
  /** Metro mode only: bundle files found at the known locations, untouched. */
  leftovers: string[];
};

/** Only the exact value `1` opts out (§5.1 rule 5). */
export function isBuildMetadataOptedOut(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[SKIP_BUILD_FINGERPRINT_ENV] === "1";
}

function causeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function elapsedMs(started: number): number {
  return Math.round(performance.now() - started);
}

function assertSupportedBundleName(platform: ReactNativePlatform, bundleName: string | undefined): void {
  const expected = REACT_NATIVE_LAYOUTS[platform].bundleFileName;
  if (bundleName !== undefined && bundleName !== expected) {
    throw new BuildToolsError(
      "UNSUPPORTED_BUNDLE_NAME",
      `bundle name ${JSON.stringify(bundleName)} is not supported on ${platform}; only ${expected} is. Remove the custom ${platform === "ios" ? "BUNDLE_NAME" : "bundleAssetName"}.`,
    );
  }
}

/**
 * Default-named bundle files at the input directory and at the directory that
 * holds the metadata file (the final product on iOS). Only checked for
 * presence, never opened. An `assets` directory alone is not reported: a host
 * app may ship its own, and without a bundle it is no baseline.
 */
function findLeftoverBundleFiles(
  platform: ReactNativePlatform,
  directories: readonly (string | undefined)[],
): string[] {
  const bundleFileName = REACT_NATIVE_LAYOUTS[platform].bundleFileName;
  const seen = new Set<string>();
  const found: string[] = [];
  for (const directory of directories) {
    if (directory === undefined) continue;
    let real: string;
    try {
      real = realpathSync(directory);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    const candidate = path.join(directory, bundleFileName);
    try {
      lstatSync(candidate);
      found.push(candidate);
    } catch {
      // Absent.
    }
  }
  return found;
}

function readExisting(file: string): Buffer | null {
  try {
    return readFileSync(file);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return null;
    throw new BuildToolsError("WRITE_FAILED", `cannot read ${file}: ${causeMessage(error)}`, { cause: error });
  }
}

/**
 * Replaces `file` atomically (temporary file in the same directory, then
 * rename) unless it already holds exactly `content`, so a build system sees no
 * modification when nothing changed (§5.1 rule 2).
 */
function replaceFileIfChanged(file: string, content: string): boolean {
  const bytes = Buffer.from(content, "utf8");
  if (readExisting(file)?.equals(bytes)) {
    return false;
  }
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(temporary, bytes, { flag: "wx" });
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new BuildToolsError("WRITE_FAILED", `cannot write ${file}: ${causeMessage(error)}`, { cause: error });
  }
  return true;
}

/**
 * Removes the metadata file. Returns false when there was none. A directory at
 * that path is an error, never removed.
 */
export function removeBuildMetadata(file: string): boolean {
  try {
    rmSync(file);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return false;
    throw new BuildToolsError("WRITE_FAILED", `cannot remove ${file}: ${causeMessage(error)}`, { cause: error });
  }
  return true;
}

/**
 * Computes and writes the record for one build. Throws `BuildToolsError` and
 * leaves removing the earlier file to the caller, which also handles usage
 * errors the same way.
 */
export async function writeBuildMetadata(input: WriteInput): Promise<WriteResult> {
  const { platform } = input;
  // Checked in both modes: an unsupported name is never "no bundle" (§5.2 rule 6).
  assertSupportedBundleName(platform, input.bundleName);

  let embedded: EmbeddedPair | null = null;
  let embeddedMs: number | null = null;
  let leftovers: string[] = [];
  if (input.bundleMode === "embedded") {
    const started = performance.now();
    const tree = collectEmbeddedTree(platform, input.bundleInputDir);
    embedded = { embeddedPackageHash: tree.embeddedPackageHash, embeddedFiles: tree.embeddedFiles };
    embeddedMs = elapsedMs(started);
  } else {
    leftovers = findLeftoverBundleFiles(platform, [input.bundleInputDir, path.dirname(input.output)]);
  }

  const started = performance.now();
  const { fingerprint, engine } = await computeNativeFingerprint({ appRoot: input.appRoot, platform });
  const fingerprintMs = elapsedMs(started);

  const record = buildReactNativeRecord({ fingerprint, engine, embedded });
  const written = replaceFileIfChanged(input.output, serializeBuildMetadata(record));
  return {
    written,
    fingerprintMs,
    embeddedMs,
    embeddedFileCount: embedded?.embeddedFiles.length ?? null,
    leftovers,
  };
}
