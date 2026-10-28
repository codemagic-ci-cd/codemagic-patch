import type { BinaryVersionFilter } from "../domain";

/** Query values for `binaryVersionMatchSql`: `[exact, prefix]`, null when unused. */
export function binaryVersionFilterValues(
  filter: BinaryVersionFilter | null,
): [string | null, string | null] {
  if (filter === null) {
    return [null, null];
  }
  return filter.kind === "exact" ? [filter.version, null] : [null, filter.prefix];
}

/**
 * The `metric_active_device_daily_count` key that holds the same filter's
 * count. Distinct device counts cannot be summed, so a folded day stores one
 * per filter a timeseries can ask for.
 */
export function activeDeviceFilterKey(
  filter: BinaryVersionFilter | null,
): [string, string] {
  if (filter === null) {
    return ["all", ""];
  }
  return filter.kind === "exact" ? ["exact", filter.version] : ["prefix", filter.prefix];
}

/**
 * True for every row when both values are null. A prefix matches the token
 * itself and anything below it (`1` matches `1`, `1.0`, `1.10.2`, not `10.0`).
 * Prefixes are digits and dots only, so they need no LIKE escaping.
 */
export function binaryVersionMatchSql(
  column: string,
  exactParam: string,
  prefixParam: string,
): string {
  return `((${exactParam}::text IS NULL OR ${column} = ${exactParam})
    AND (${prefixParam}::text IS NULL OR ${column} = ${prefixParam} OR ${column} LIKE ${prefixParam} || '.%'))`;
}
