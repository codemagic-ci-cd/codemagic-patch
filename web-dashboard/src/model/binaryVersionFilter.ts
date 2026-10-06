// Binary-version filter shared by the deployment adoption card, release
// history, and the metrics adoption chart. A group (`1.x`, `1.0.x`) matches
// the prefix token itself and every version below it, the same textual rule
// the server applies to `binary_version_prefix`.

export type BinaryVersionFilter =
  | { kind: "version"; version: string }
  | { kind: "group"; prefix: string };

export interface BinaryVersionOption {
  filter: BinaryVersionFilter;
  label: string;
  value: string;
}

const NUMERIC_RELEASE = /^\d+(?:\.\d+)*/;

export function binaryVersionFilterValue(filter: BinaryVersionFilter): string {
  return filter.kind === "version"
    ? `version:${filter.version}`
    : `group:${filter.prefix}`;
}

export function binaryVersionFilterLabel(filter: BinaryVersionFilter): string {
  return filter.kind === "version" ? filter.version : `${filter.prefix}.x`;
}

/** Query params for the timeseries and release list endpoints. */
export function binaryVersionFilterParams(
  filter: BinaryVersionFilter | null,
): { binary_version?: string; binary_version_prefix?: string } {
  if (filter === null) {
    return {};
  }
  return filter.kind === "version"
    ? { binary_version: filter.version }
    : { binary_version_prefix: filter.prefix };
}

function inGroup(version: string, prefix: string): boolean {
  return version === prefix || version.startsWith(`${prefix}.`);
}

/** Whether the filter still names something in the reported versions. */
export function binaryVersionFilterMatches(
  filter: BinaryVersionFilter,
  versions: readonly string[],
): boolean {
  return filter.kind === "version"
    ? versions.includes(filter.version)
    : versions.some((version) => inGroup(version, filter.prefix));
}

/**
 * Menu rows for `versions` (newest first). A group row sits above the first
 * version it covers. Groups that cover one version, and minor groups that
 * cover exactly what their major group does, are left out unless selected.
 */
export function binaryVersionOptions(
  versions: readonly string[],
  selected: BinaryVersionFilter | null,
): BinaryVersionOption[] {
  const coverage = new Map<string, string[]>();
  for (const version of versions) {
    const segments = version.match(NUMERIC_RELEASE)?.[0].split(".") ?? [];
    const prefixes = [
      segments.length >= 2 ? segments[0] : undefined,
      segments.length >= 3 ? `${segments[0]}.${segments[1]}` : undefined,
    ];
    for (const prefix of prefixes) {
      if (prefix !== undefined && !coverage.has(prefix)) {
        coverage.set(
          prefix,
          versions.filter((candidate) => inGroup(candidate, prefix)),
        );
      }
    }
  }

  const selectedPrefix = selected?.kind === "group" ? selected.prefix : null;
  const shownGroups = new Set<string>();
  for (const [prefix, covered] of coverage) {
    const major = prefix.split(".")[0] ?? prefix;
    const sameAsMajor =
      major !== prefix && coverage.get(major)?.length === covered.length;
    if (prefix === selectedPrefix || (covered.length >= 2 && !sameAsMajor)) {
      shownGroups.add(prefix);
    }
  }
  if (
    selectedPrefix !== null &&
    !shownGroups.has(selectedPrefix) &&
    versions.some((version) => inGroup(version, selectedPrefix))
  ) {
    shownGroups.add(selectedPrefix);
  }

  const options: BinaryVersionOption[] = [];
  const emitted = new Set<string>();
  const pushGroup = (prefix: string) => {
    if (shownGroups.has(prefix) && !emitted.has(prefix)) {
      emitted.add(prefix);
      options.push(toOption({ kind: "group", prefix }));
    }
  };
  for (const version of versions) {
    const groupPrefixes = [...shownGroups]
      .filter((prefix) => inGroup(version, prefix))
      .sort((left, right) => left.length - right.length);
    groupPrefixes.forEach(pushGroup);
    options.push(toOption({ kind: "version", version }));
  }
  return options;
}

function toOption(filter: BinaryVersionFilter): BinaryVersionOption {
  return {
    filter,
    label: binaryVersionFilterLabel(filter),
    value: binaryVersionFilterValue(filter),
  };
}
