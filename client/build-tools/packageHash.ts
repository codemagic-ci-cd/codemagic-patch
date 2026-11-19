// package_hash_v1 (server/specs/codemagic_patch_package_hash.md), the SDK's own
// Node implementation for the build-metadata writer. It imports nothing from
// the CLI, the server or patch-shared: the contract is shared, the code is not
// (wiki/discussions/build-time-fingerprint.md, "Separate package-hash
// implementations, one set of vectors"). Hashing runs on fixed entries; reading a directory lives in
// embeddedTree.ts.

import { createHash } from "node:crypto";

import { BuildToolsError } from "./errors";

/** One regular file of a canonical entry set. */
export type PackageHashEntry = {
  /** Normalized relative path: `/`-separated, no empty, `.` or `..` segment. */
  path: string;
  /** Lowercase hex SHA-256 of the file bytes. */
  sha256: string;
};

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Orders two strings by their UTF-8 bytes (not UTF-16 code units). */
export function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/** Copy of `paths` sorted by UTF-8 bytes. */
export function sortByUtf8(paths: readonly string[]): string[] {
  return [...paths].sort(compareUtf8);
}

/**
 * Ignore rules of package_hash_v1: everything under a top-level `__MACOSX`
 * directory, and any path with a `.DS_Store` segment (a file of that name, or
 * anything below a directory of that name).
 */
export function isIgnoredPackagePath(relativePath: string): boolean {
  const segments = relativePath.split("/");
  return segments[0] === "__MACOSX" || segments.includes(".DS_Store");
}

/**
 * The canonicalization rules of package_hash_v1 for a path that is already
 * `/`-separated: relative, no empty, `.` or `..` segment. Throws on violation.
 */
export function assertCanonicalPackagePath(relativePath: string): void {
  if (relativePath.length === 0) {
    throw new BuildToolsError("INVALID_TREE", "package path is empty");
  }
  if (relativePath.startsWith("/")) {
    throw new BuildToolsError("INVALID_TREE", `package path is absolute: ${relativePath}`);
  }
  for (const segment of relativePath.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new BuildToolsError(
        "INVALID_TREE",
        `package path has an empty, '.' or '..' segment: ${relativePath}`,
      );
    }
  }
}

/**
 * package_hash_v1 over a canonical entry set: `<path>:<sha256>` per file,
 * sorted by UTF-8 bytes, serialized with JSON.stringify, then SHA-256.
 *
 * The entries must already be canonical: duplicate paths, non-canonical paths
 * and paths the ignore rules exclude are rejected, not silently dropped, so
 * the caller's file list and this digest cannot describe different sets.
 */
export function computePackageHashV1(entries: readonly PackageHashEntry[]): string {
  const seen = new Set<string>();
  const manifestEntries = entries.map((entry) => {
    assertCanonicalPackagePath(entry.path);
    if (isIgnoredPackagePath(entry.path)) {
      throw new BuildToolsError(
        "INVALID_TREE",
        `package path is excluded by the package_hash_v1 ignore rules: ${entry.path}`,
      );
    }
    if (seen.has(entry.path)) {
      throw new BuildToolsError("INVALID_TREE", `duplicate package path: ${entry.path}`);
    }
    seen.add(entry.path);
    if (!SHA256_HEX.test(entry.sha256)) {
      throw new BuildToolsError(
        "INVALID_TREE",
        `file digest for ${entry.path} is not 64 lowercase hex characters`,
      );
    }
    return `${entry.path}:${entry.sha256}`;
  });

  manifestEntries.sort(compareUtf8);
  return sha256Hex(Buffer.from(JSON.stringify(manifestEntries), "utf8"));
}
