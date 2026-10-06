import type { ProblemDetails } from "../../app/problemDetails";
import type { BinaryVersionFilter } from "../../domain";
import {
  INVALID_BINARY_VERSION_ERROR,
  INVALID_BINARY_VERSION_FILTER_COMBINATION_ERROR,
  INVALID_BINARY_VERSION_PREFIX_ERROR,
} from "./routeConstants";
import { singleFieldValidationProblem } from "./routeValidation";

const BINARY_VERSION_MAX_LENGTH = 128;

// binary_version is embedded verbatim in delivery object keys and client fetch URL
// path segments ({deployment_key}/{binary_version}/...), so it is restricted to
// path-safe characters. The leading character must be alphanumeric so values
// cannot form "." / ".." segments or start with a separator. Every valid semver
// version (including prerelease and build metadata) satisfies this rule.
const BINARY_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/;

// Digits and dots only, so the value is safe inside a SQL LIKE pattern.
const BINARY_VERSION_PREFIX_PATTERN = /^\d+(?:\.\d+)*$/;

export function isValidBinaryVersion(value: string): boolean {
  return (
    value.length <= BINARY_VERSION_MAX_LENGTH &&
    BINARY_VERSION_PATTERN.test(value)
  );
}

/**
 * Reads the optional `binary_version` / `binary_version_prefix` query pair.
 * Empty values mean "no filter"; setting both is rejected.
 */
export function parseBinaryVersionFilterQuery(query: {
  binary_version?: unknown;
  binary_version_prefix?: unknown;
}):
  | { kind: "error"; problem: ProblemDetails }
  | { kind: "success"; value: BinaryVersionFilter | null } {
  const version = readQueryString(query.binary_version);
  if (version === undefined) {
    return invalid(INVALID_BINARY_VERSION_ERROR, "binary_version", "invalid_type");
  }
  if (version !== null && !isValidBinaryVersion(version)) {
    return invalid(INVALID_BINARY_VERSION_ERROR, "binary_version", "invalid_value");
  }

  const prefix = readQueryString(query.binary_version_prefix);
  if (prefix === undefined) {
    return invalid(
      INVALID_BINARY_VERSION_PREFIX_ERROR,
      "binary_version_prefix",
      "invalid_type",
    );
  }
  if (
    prefix !== null &&
    (prefix.length > BINARY_VERSION_MAX_LENGTH ||
      !BINARY_VERSION_PREFIX_PATTERN.test(prefix))
  ) {
    return invalid(
      INVALID_BINARY_VERSION_PREFIX_ERROR,
      "binary_version_prefix",
      "invalid_value",
    );
  }

  if (version !== null && prefix !== null) {
    return invalid(
      INVALID_BINARY_VERSION_FILTER_COMBINATION_ERROR,
      "binary_version_prefix",
      "invalid_combination",
    );
  }

  if (version !== null) {
    return { kind: "success", value: { kind: "exact", version } };
  }
  if (prefix !== null) {
    return { kind: "success", value: { kind: "prefix", prefix } };
  }
  return { kind: "success", value: null };
}

/** `undefined` marks a non-string (for example a repeated query param). */
function readQueryString(value: unknown): string | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  return value.length > 0 ? value : null;
}

function invalid(
  detail: string,
  field: string,
  reason: "invalid_combination" | "invalid_type" | "invalid_value",
): { kind: "error"; problem: ProblemDetails } {
  return {
    kind: "error",
    problem: singleFieldValidationProblem(detail, field, reason),
  };
}
