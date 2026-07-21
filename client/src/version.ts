// Binary-version precedence comparison for the store-update hint.
//
// `binary_version` tokens are path-safe strings, not required to be semver.
// To surface a store-update hint *only when a strictly higher binary version
// exists*, we compare any consistent numeric-dotted
// scheme (semver, `MAJOR.MINOR`, calver such as `2024.06`) by parsing each
// dot-separated segment as a number. Genuinely opaque tokens (`latest`,
// hashes, malformed forms) are incomparable and never trigger a hint.
//
// This algorithm is mirrored on the server in
// `server/src/worker/binaryVersionPrecedence.ts`. Keep the two implementations
// in sync.

// A token is comparable iff it is a numeric-dotted release with optional
// semver-style prerelease and build identifiers. Leading zeros are allowed in
// numeric release segments (calver `2024.06`). Empty / double-dot identifiers
// (`1.0.0-`, `1.0.0-alpha..1`) and non-numeric leads (`latest`, `v2`) do not
// match, so they parse as incomparable.
const VERSION_PATTERN =
  /^\d+(?:\.\d+)*(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

interface ParsedVersion {
  release: string[];
  prerelease: string[];
}

function parseVersion(value: string): ParsedVersion | null {
  if (!VERSION_PATTERN.test(value)) {
    return null;
  }

  // Build metadata never affects precedence (semver §10).
  const withoutBuild = value.split("+", 1)[0] ?? "";

  // `main` is purely numeric-dotted, so the first `-` unambiguously starts the
  // prerelease.
  const hyphenIndex = withoutBuild.indexOf("-");
  const main =
    hyphenIndex === -1 ? withoutBuild : withoutBuild.slice(0, hyphenIndex);
  const prereleaseRaw =
    hyphenIndex === -1 ? "" : withoutBuild.slice(hyphenIndex + 1);

  return {
    release: main.split("."),
    prerelease: prereleaseRaw === "" ? [] : prereleaseRaw.split("."),
  };
}

// Compare two all-digit identifiers numerically without `Number()`, so leading
// zeros and digit runs longer than `Number.MAX_SAFE_INTEGER` stay correct:
// strip leading zeros, then order by length and finally lexically.
function compareNumericIdentifier(left: string, right: string): number {
  const leftTrimmed = left.replace(/^0+(?=\d)/, "");
  const rightTrimmed = right.replace(/^0+(?=\d)/, "");
  if (leftTrimmed.length !== rightTrimmed.length) {
    return leftTrimmed.length < rightTrimmed.length ? -1 : 1;
  }
  if (leftTrimmed === rightTrimmed) {
    return 0;
  }
  return leftTrimmed < rightTrimmed ? -1 : 1;
}

function compareRelease(left: string[], right: string[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    // Missing trailing segments are treated as 0 (`1.2` == `1.2.0`).
    const diff = compareNumericIdentifier(left[index] ?? "0", right[index] ?? "0");
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

const NUMERIC_IDENTIFIER_PATTERN = /^\d+$/;

// Semver §11 prerelease precedence: a version with a prerelease is lower than
// one without; identifiers are compared numerically when both are numeric,
// otherwise lexically; numeric identifiers rank below alphanumeric ones; a
// longer identifier set wins when all preceding identifiers are equal.
function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) {
    return 0;
  }
  if (left.length === 0) {
    return 1;
  }
  if (right.length === 0) {
    return -1;
  }

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) {
      return -1;
    }
    if (rightPart === undefined) {
      return 1;
    }

    const leftIsNumeric = NUMERIC_IDENTIFIER_PATTERN.test(leftPart);
    const rightIsNumeric = NUMERIC_IDENTIFIER_PATTERN.test(rightPart);
    if (leftIsNumeric && rightIsNumeric) {
      const diff = compareNumericIdentifier(leftPart, rightPart);
      if (diff !== 0) {
        return diff;
      }
      continue;
    }
    if (leftIsNumeric) {
      return -1;
    }
    if (rightIsNumeric) {
      return 1;
    }
    if (leftPart !== rightPart) {
      return leftPart < rightPart ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Compare two binary-version tokens by precedence.
 *
 * Returns `-1` / `0` / `1` when both tokens are comparable numeric-dotted
 * versions, or `null` when either token is opaque (not a numeric-dotted
 * version) and so cannot be ordered.
 */
export function compareBinaryVersionPrecedence(
  left: string,
  right: string,
): number | null {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);
  if (parsedLeft === null || parsedRight === null) {
    return null;
  }

  const releaseDiff = compareRelease(parsedLeft.release, parsedRight.release);
  if (releaseDiff !== 0) {
    return releaseDiff;
  }
  return comparePrerelease(parsedLeft.prerelease, parsedRight.prerelease);
}
