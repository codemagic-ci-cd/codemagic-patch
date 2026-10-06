import { promises as fs } from "node:fs";
import path from "node:path";

import { findUnsupportedArchivePaths } from "@codemagic/patch-shared";

import { UsageError } from "./errors";
import { computePackageHashFromZipBuffer } from "./packageHash";
import {
  createZipFromDirectory,
  listArchiveFiles,
  listZipPayloadFiles,
  toPayloadPaths,
} from "./zip";

/** The file the Capacitor WebView loads first from the directory a release installs. */
const WEB_ENTRY_FILE = "index.html";

export type InspectedBundle =
  | {
      /** Relative paths of every file under the directory, in archive order. */
      archiveFiles: string[];
      kind: "directory";
      payloadPaths: string[];
      resolvedPath: string;
    }
  | {
      kind: "zip";
      /** Computed during inspection — see inspectBundleZip. */
      packageHash: string;
      payloadPaths: string[];
      resolvedPath: string;
      zipBytes: Uint8Array;
    };

/**
 * Everything that can be decided about `--bundle-path` without the network, so a
 * wrong path fails before the token is even looked at: it exists, it is the web
 * root the SDK will serve, and every path in it can be installed on a device.
 */
export async function inspectBundle(inputPath: string): Promise<InspectedBundle> {
  const resolvedPath = path.resolve(inputPath);

  let stats: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stats = await fs.stat(resolvedPath);
  } catch (error) {
    throw new UsageError(
      `bundle path was not found: ${resolvedPath}${formatErrorSuffix(error)}`,
    );
  }

  if (stats.isDirectory()) {
    return inspectBundleDirectory(resolvedPath);
  }

  if (stats.isFile()) {
    return inspectBundleZip(resolvedPath);
  }

  throw new UsageError(
    `bundle path is neither a file nor a directory: ${resolvedPath}`,
  );
}

/** The ZIP to upload, and its package hash: built from the directory, or the given archive verbatim. */
export async function readBundleZip(
  bundle: InspectedBundle,
): Promise<{ packageHash: string; zipBytes: Uint8Array }> {
  if (bundle.kind === "zip") {
    return { packageHash: bundle.packageHash, zipBytes: bundle.zipBytes };
  }

  const zipBytes = await createZipFromDirectory(
    bundle.resolvedPath,
    bundle.archiveFiles,
  );
  return { packageHash: computePackageHashFromZipBuffer(zipBytes), zipBytes };
}

async function inspectBundleDirectory(
  resolvedPath: string,
): Promise<InspectedBundle> {
  // Checked on the top level alone, before the recursive walk: a project root
  // passed by mistake would otherwise have its whole node_modules/ listed first —
  // and a Vite project root even carries an index.html, so nothing below stops it.
  const topLevel = await fs.readdir(resolvedPath);
  if (topLevel.includes("node_modules")) {
    throw new UsageError(
      `${resolvedPath} contains node_modules/, so it looks like a project root rather than built web assets. ` +
        bundlePathAdvice(),
    );
  }

  const archiveFiles = await listArchiveFiles(resolvedPath);
  if (archiveFiles.length === 0) {
    throw new UsageError(`bundle directory contains no files: ${resolvedPath}`);
  }

  const payloadPaths = toPayloadPaths(archiveFiles);
  assertWebRoot(payloadPaths, resolvedPath);
  assertInstallableArchivePaths(payloadPaths);

  return { archiveFiles, kind: "directory", payloadPaths, resolvedPath };
}

async function inspectBundleZip(resolvedPath: string): Promise<InspectedBundle> {
  const zipBytes = await fs.readFile(resolvedPath);

  let payloadPaths: string[];
  try {
    payloadPaths = listZipPayloadFiles(zipBytes);
  } catch (error) {
    throw new UsageError(
      `bundle file is not a readable ZIP archive: ${resolvedPath}${formatErrorSuffix(error)}`,
    );
  }

  // The listing above drops what the server would refuse; hashing throws on it — an
  // entry that climbs out of the archive root, an absolute path, two entries that
  // normalize to the same path. A directory cannot produce any of those, but a
  // hand-made ZIP can, and hashing it only after the confirmation would turn a bad
  // input into a late runtime error.
  let packageHash: string;
  try {
    packageHash = computePackageHashFromZipBuffer(zipBytes);
  } catch (error) {
    throw new UsageError(
      `bundle ZIP cannot be released: ${resolvedPath}${formatErrorSuffix(error)}`,
    );
  }

  assertWebRoot(payloadPaths, resolvedPath);
  assertInstallableArchivePaths(payloadPaths);

  return { kind: "zip", packageHash, payloadPaths, resolvedPath, zipBytes };
}

// A release is unpacked into a directory the SDK hands to Capacitor as the
// server base path, and the WebView then loads index.html from its root. A
// bundle without one — the parent of the web directory, a ZIP that wraps the
// assets in a folder — installs fine and boots to a blank screen.
function assertWebRoot(payloadPaths: string[], resolvedPath: string): void {
  if (payloadPaths.includes(WEB_ENTRY_FILE)) {
    return;
  }

  const [nearest] = payloadPaths
    .filter((payloadPath) => payloadPath.endsWith(`/${WEB_ENTRY_FILE}`))
    .sort((left, right) => left.split("/").length - right.split("/").length);
  const nestedHint =
    nearest === undefined
      ? ""
      : ` The nearest one is ${nearest} — the bundle must start at that folder.`;

  throw new UsageError(
    `no ${WEB_ENTRY_FILE} at the root of ${resolvedPath}.${nestedHint} ${bundlePathAdvice()}`,
  );
}

function bundlePathAdvice(): string {
  return (
    "--bundle-path must be the built web assets: the `webDir` of capacitor.config " +
    "(for example www/ or dist/), or a ZIP of that directory's contents."
  );
}

// A path past the filesystem or validator limits produces a release no device
// can extract, so it must fail here rather than in the release job.
function assertInstallableArchivePaths(payloadPaths: string[]): void {
  const unsupported = findUnsupportedArchivePaths(payloadPaths);
  const [first] = unsupported;
  if (first === undefined) {
    return;
  }

  throw new UsageError(
    `bundle contains ${unsupported.length} file path(s) no device can install: ` +
      `${first.path} (${first.reason}). Shorten the offending path(s) and rebuild.`,
  );
}

function formatErrorSuffix(error: unknown): string {
  if (!(error instanceof Error) || error.message.length === 0) {
    return "";
  }

  return ` (${error.message})`;
}
