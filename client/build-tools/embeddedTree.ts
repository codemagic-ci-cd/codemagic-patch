// Selects the embedded bundle tree from build output (spec §4.1, §4.2) and
// derives both embeddedPackageHash and embeddedFiles from ONE canonical entry
// set. Walking is separate from hashing (packageHash.ts) so the digest can be
// tested with fixed inputs.

import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  type Stats,
} from "node:fs";
import path from "node:path";

import { REACT_NATIVE_LAYOUTS, type EmbeddedPair, type ReactNativePlatform } from "./buildMetadata";
import { BuildToolsError } from "./errors";
import { assertSupportedNode } from "./nodeVersion";
import {
  computePackageHashV1,
  isIgnoredPackagePath,
  sortByUtf8,
  type PackageHashEntry,
} from "./packageHash";

// `ignoreBOM` keeps a leading U+FEFF in a file name: it is part of the name,
// as the CLI and server record it, not a byte-order mark to strip.
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Bytes read per `readSync` while hashing a file. */
const READ_BUFFER_SIZE = 64 * 1024;

// Open flags for hashing an entry: never follow a symlink that replaced the
// entry after the walk classified it, and never block on a FIFO. Windows
// defines neither flag; there the `fstat` check alone applies.
const OPEN_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

/**
 * Producer path limits of PROTOCOL.md › Full Bundle Archive Format: the one
 * parser rule (spec §4.3 rule 9) the walk below does not already guarantee.
 */
const MAX_PATH_BYTES = 512;
const MAX_SEGMENT_BYTES = 255;

function treeError(message: string, cause?: unknown): never {
  throw new BuildToolsError("INVALID_TREE", message, cause === undefined ? undefined : { cause });
}

function causeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function lstatOrNull(target: string): Stats | null {
  try {
    return lstatSync(target);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") {
      return null;
    }
    return treeError(`cannot read ${target}: ${causeMessage(error)}`, error);
  }
}

/**
 * Directory entry names exactly as the file system returned them (§4.1 rule
 * 7). A name that is not valid UTF-8 cannot be recorded without replacing
 * bytes, so it is an error instead of a silently different path.
 */
function readNames(directory: string): string[] {
  let raw: Buffer[];
  try {
    raw = readdirSync(directory, { encoding: "buffer" });
  } catch (error) {
    return treeError(`cannot read directory ${directory}: ${causeMessage(error)}`, error);
  }
  return raw.map((bytes) => {
    try {
      return utf8Decoder.decode(bytes);
    } catch {
      return treeError(
        `file name is not valid UTF-8 in ${directory}: ${bytes.toString("hex")} (hex)`,
      );
    }
  });
}

function assertRepresentableName(name: string, absolutePath: string): void {
  if (name.includes("\\")) {
    treeError(`file name contains a backslash, which cannot be recorded: ${absolutePath}`);
  }
  if (name.includes("\u0000")) {
    treeError(`file name contains U+0000: ${JSON.stringify(absolutePath)}`);
  }
}

/**
 * Hashes the regular file at `absolutePath` from one descriptor: opened
 * without following a symlink, checked to be a regular file, then read in
 * fixed-size blocks. What is hashed is what was checked, and a file of any
 * size is hashed without holding it in memory.
 */
function fileEntry(relativePath: string, absolutePath: string): PackageHashEntry {
  let fd: number;
  try {
    fd = openSync(absolutePath, OPEN_FLAGS);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ELOOP") {
      return treeError(`symlink in the selected tree is not supported: ${absolutePath}`, error);
    }
    return treeError(`cannot read ${absolutePath}: ${causeMessage(error)}`, error);
  }
  try {
    let stat: Stats;
    try {
      stat = fstatSync(fd);
    } catch (error) {
      return treeError(`cannot read ${absolutePath}: ${causeMessage(error)}`, error);
    }
    if (!stat.isFile()) {
      return treeError(`special file in the selected tree is not supported: ${absolutePath}`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(READ_BUFFER_SIZE);
    for (;;) {
      let bytesRead: number;
      try {
        bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      } catch (error) {
        return treeError(`cannot read ${absolutePath}: ${causeMessage(error)}`, error);
      }
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return { path: relativePath, sha256: hash.digest("hex") };
  } finally {
    closeSync(fd);
  }
}

/**
 * Walks `root/relativeDirectory` and returns one entry per regular file, with
 * `/`-joined paths relative to `root`. Applies the package_hash_v1 ignore
 * rules; an ignored directory is skipped whole. A symlink or special entry
 * (FIFO, socket, device) inside the walk is an error, never followed, even
 * under an ignored name. Directories are traversed and are not entries.
 */
export function collectTreeEntries(root: string, relativeDirectory = ""): PackageHashEntry[] {
  const entries: PackageHashEntry[] = [];

  const visit = (relativeDir: string): void => {
    const absoluteDir = relativeDir === "" ? root : path.join(root, ...relativeDir.split("/"));
    for (const name of sortByUtf8(readNames(absoluteDir))) {
      const relativePath = relativeDir === "" ? name : `${relativeDir}/${name}`;
      const absolutePath = path.join(absoluteDir, name);
      assertRepresentableName(name, absolutePath);

      const stat = lstatOrNull(absolutePath);
      if (stat === null) {
        treeError(`entry disappeared while reading the tree: ${absolutePath}`);
      }
      if (stat.isSymbolicLink()) {
        treeError(`symlink in the selected tree is not supported: ${absolutePath}`);
      }
      if (stat.isDirectory()) {
        // A top-level `__MACOSX` or a `.DS_Store` directory at any depth: the
        // ignore rules drop everything below it, so it is not walked.
        if (isIgnoredPackagePath(relativePath)) {
          continue;
        }
        visit(relativePath);
        continue;
      }
      if (!stat.isFile()) {
        treeError(`special file in the selected tree is not supported: ${absolutePath}`);
      }
      if (isIgnoredPackagePath(relativePath)) {
        continue;
      }
      entries.push(fileEntry(relativePath, absolutePath));
    }
  };

  visit(relativeDirectory);
  return entries;
}

function assertWithinPathLimits(relativePath: string): void {
  const bytes = Buffer.byteLength(relativePath, "utf8");
  if (bytes > MAX_PATH_BYTES) {
    treeError(`path is ${bytes} bytes, over the ${MAX_PATH_BYTES}-byte limit: ${relativePath}`);
  }
  for (const segment of relativePath.split("/")) {
    const segmentBytes = Buffer.byteLength(segment, "utf8");
    if (segmentBytes > MAX_SEGMENT_BYTES) {
      treeError(`path has a ${segmentBytes}-byte segment, over the ${MAX_SEGMENT_BYTES}-byte limit: ${relativePath}`);
    }
  }
}

/**
 * Hash and file list from one canonical entry set. The digest uses the
 * manifest-entry ordering of package_hash_v1; the list is sorted by UTF-8 path
 * bytes. Both come from `entries`, so they cannot describe different trees.
 */
function embeddedPairFromEntries(entries: readonly PackageHashEntry[]): EmbeddedPair {
  for (const entry of entries) assertWithinPathLimits(entry.path);
  return {
    embeddedPackageHash: computePackageHashV1(entries),
    embeddedFiles: sortByUtf8(entries.map((entry) => entry.path)),
  };
}

export type EmbeddedTree = EmbeddedPair & {
  /** The resolved payload root the tree was read from. */
  inputDirectory: string;
  entries: PackageHashEntry[];
};

/**
 * Reads the React Native embedded tree from an explicit build-output
 * directory: iOS `main.jsbundle` plus every regular file under `assets/`
 * (optional), Android `index.android.bundle` only. The input directory itself
 * may be reached through a symlink (an iOS archive's `.app`); it is resolved,
 * and symlinks inside the tree are still rejected.
 *
 * A missing bundle file is an error: deciding that a build intentionally has
 * no bundle is the caller's explicit bundle expectation, never this function's
 * guess (spec §5.2 rule 3).
 */
export function collectEmbeddedTree(
  platform: ReactNativePlatform,
  inputDirectory: string,
): EmbeddedTree {
  assertSupportedNode();
  const layout = REACT_NATIVE_LAYOUTS[platform];

  let root: string;
  try {
    root = realpathSync(path.resolve(inputDirectory));
  } catch (error) {
    return treeError(`bundle input directory cannot be resolved: ${inputDirectory}: ${causeMessage(error)}`, error);
  }
  const rootStat = lstatOrNull(root);
  if (rootStat === null || !rootStat.isDirectory()) {
    treeError(`bundle input path is not a directory: ${root}`);
  }

  const bundlePath = path.join(root, layout.bundleFileName);
  const bundleStat = lstatOrNull(bundlePath);
  if (bundleStat === null) {
    treeError(`expected bundle is missing: ${bundlePath}`);
  }
  if (bundleStat.isSymbolicLink()) {
    treeError(`symlink in the selected tree is not supported: ${bundlePath}`);
  }
  if (!bundleStat.isFile()) {
    treeError(`bundle is not a regular file: ${bundlePath}`);
  }

  const entries: PackageHashEntry[] = [fileEntry(layout.bundleFileName, bundlePath)];

  if (layout.assetsDirectory !== null) {
    const assetsPath = path.join(root, layout.assetsDirectory);
    const assetsStat = lstatOrNull(assetsPath);
    if (assetsStat !== null) {
      if (assetsStat.isSymbolicLink()) {
        treeError(`symlink in the selected tree is not supported: ${assetsPath}`);
      }
      if (!assetsStat.isDirectory()) {
        treeError(`assets entry is not a directory: ${assetsPath}`);
      }
      entries.push(...collectTreeEntries(root, layout.assetsDirectory));
    }
  }

  return { ...embeddedPairFromEntries(entries), inputDirectory: root, entries };
}
