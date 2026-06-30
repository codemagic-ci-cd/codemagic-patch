const BINARY_VERSION_MAX_LENGTH = 128;

// binary_version is embedded verbatim in delivery object keys and client fetch URL
// path segments ({deployment_key}/{binary_version}/...), so it is restricted to
// path-safe characters. The leading character must be alphanumeric so values
// cannot form "." / ".." segments or start with a separator. Every valid semver
// version (including prerelease and build metadata) satisfies this rule.
const BINARY_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/;

export function isValidBinaryVersion(value: string): boolean {
  return (
    value.length <= BINARY_VERSION_MAX_LENGTH &&
    BINARY_VERSION_PATTERN.test(value)
  );
}
