// The release-time half of cli/src/targetBinaryVersion.ts (@codemagic/patch-cli
// 0.4.0), copied unchanged. The other half — reading the version out of an Xcode or
// Gradle project — is not here: this CLI always takes --target-binary-version
// explicitly. See cli-capacitor-tech-spec › Provenance.

import { ValidationError } from "./errors";

const BINARY_VERSION_MAX_LENGTH = 128;
const PATH_SAFE_BINARY_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/;

export function isPathSafeBinaryVersion(value: string): boolean {
  return (
    value.length <= BINARY_VERSION_MAX_LENGTH &&
    PATH_SAFE_BINARY_VERSION_PATTERN.test(value)
  );
}

// Wildcard/dynamic-version segments that are path-safe but match no exact
// version: npm-style `x`/`X`, Gradle's dynamic `+`, and `*`.
const WILDCARD_VERSION_SEGMENTS = new Set(["x", "X", "*", "+"]);

/**
 * Reject range/wildcard target-binary-version tokens at release time. The
 * server matches binary versions exactly, so a value like `1.2.x`, `1.1.*`,
 * `1.2.+`, `>=1.2.0`, or a tag like `latest` matches no installed app version
 * and the update silently reaches 0 devices. `isPathSafeBinaryVersion` already
 * rejects `*`, comparison operators, and whitespace (they fall outside the
 * path-safe charset), but `1.2.x`/`1.2.+` (path-safe) and digit-less tags need
 * extra guards.
 */
export function assertExplicitBinaryVersion(value: string): void {
  const message =
    "--target-binary-version must be an exact version like 1.2.0, " +
    `not a range or wildcard (got "${value}").`;

  if (!isPathSafeBinaryVersion(value)) {
    throw new ValidationError(message);
  }

  // A real binary version always carries a digit; reject digit-less tags
  // ("latest") and unresolved identifiers that would match zero devices.
  if (!/[0-9]/u.test(value)) {
    throw new ValidationError(message);
  }

  if (
    value.split(".").some((segment) => WILDCARD_VERSION_SEGMENTS.has(segment))
  ) {
    throw new ValidationError(message);
  }
}
