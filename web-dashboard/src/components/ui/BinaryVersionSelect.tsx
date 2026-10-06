// Binary-version filter menu. Exact versions come from the timeseries
// response (versions that reported in the range); `1.x` / `1.0.x` group rows
// are derived from them. "Binary version" is the term the release table uses.

import { useState } from "react";

import { useDeploymentTimeseries } from "../../api/hooks/metrics";
import {
  binaryVersionFilterMatches,
  binaryVersionFilterValue,
  binaryVersionOptions,
  type BinaryVersionFilter,
} from "../../model/binaryVersionFilter";
import { INPUT_STATE } from "./form";

const SELECT = [
  "select appearance-none w-auto min-w-[9.5rem] rounded-control border bg-surface",
  "py-1 pl-2.5 pr-[38px] text-[13px] font-semibold text-fg [font-family:inherit]",
  "[transition:.15s] focus:outline-none",
  INPUT_STATE.normal,
].join(" ");

export function BinaryVersionSelect({
  onChange,
  value,
  versions,
}: {
  onChange: (filter: BinaryVersionFilter | null) => void;
  value: BinaryVersionFilter | null;
  versions: readonly string[];
}) {
  if (versions.length === 0) {
    return null;
  }

  const options = binaryVersionOptions(versions, value);

  return (
    <label className="flex items-center gap-2 text-[12px] font-semibold text-fg-2">
      Binary version
      <select
        className={SELECT}
        value={value === null ? "" : binaryVersionFilterValue(value)}
        onChange={(event) => {
          const option = options.find(
            (candidate) => candidate.value === event.target.value,
          );
          onChange(option?.filter ?? null);
        }}
      >
        <option value="">All versions</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export interface BinaryVersionFilterState {
  filter: BinaryVersionFilter | null;
  setFilter: (filter: BinaryVersionFilter | null) => void;
}

/** Unfiltered, for charts that do not offer the menu. */
export const NO_BINARY_VERSION_FILTER: BinaryVersionFilterState = {
  filter: null,
  setFilter: () => {},
};

/** Filter selection that resets when the deployment changes in place. */
export function useBinaryVersionFilter(
  deploymentId: string,
): BinaryVersionFilterState {
  const [filter, setFilter] = useState<BinaryVersionFilter | null>(null);
  const [seenDeploymentId, setSeenDeploymentId] = useState(deploymentId);
  const deploymentChanged = seenDeploymentId !== deploymentId;

  if (deploymentChanged) {
    setSeenDeploymentId(deploymentId);
    setFilter(null);
  }

  return { filter: deploymentChanged ? null : filter, setFilter };
}

/**
 * Adoption timeseries for the current filter. Clears the filter once a
 * settled response no longer lists anything it matches (for example after
 * switching to a shorter range).
 */
export function useAdoptionTimeseries(
  deploymentId: string,
  { filter, setFilter }: BinaryVersionFilterState,
  { rangeDays }: { rangeDays?: number } = {},
) {
  const timeseriesQuery = useDeploymentTimeseries(deploymentId, {
    binaryVersion: filter,
    rangeDays,
  });
  const versions = timeseriesQuery.data?.binaryVersions;
  const versionsSettled =
    timeseriesQuery.isSuccess && !timeseriesQuery.isPlaceholderData;

  if (
    filter !== null &&
    versionsSettled &&
    versions !== undefined &&
    !binaryVersionFilterMatches(filter, versions)
  ) {
    setFilter(null);
  }

  return timeseriesQuery;
}
