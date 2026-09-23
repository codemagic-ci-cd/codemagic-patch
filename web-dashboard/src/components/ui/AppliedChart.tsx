// Cumulative Applied take-up for one package hash, plotted with the shared
// timeseries SVG. Day buckets are summed left to right; this is not Active
// devices and not the rollout-percentage policy.

import { cumulativeAppliedCountsForHash } from "../../model/timeseries";
import type { DeploymentTimeseries } from "../../model/timeseries";
import { TimeseriesChart } from "./TimeseriesChart";

const APPLIED_COLOR = "var(--color-blue)";

export function AppliedChart({
  targetPackageHash,
  timeseries,
}: {
  targetPackageHash: string | null;
  timeseries: DeploymentTimeseries;
}) {
  if (targetPackageHash === null) {
    return (
      <p className="text-[13px] text-fg-2">
        This release has no package hash yet, so Applied events cannot be
        charted.
      </p>
    );
  }

  const values = cumulativeAppliedCountsForHash(
    timeseries,
    targetPackageHash,
  );
  if (values === null) {
    return (
      <p className="text-[13px] text-fg-2">
        {timeseries.seriesTruncated
          ? "This package is not in the busiest series for this range."
          : "No Applied events in this range yet. The chart fills in once devices confirm this package."}
      </p>
    );
  }

  return (
    <TimeseriesChart
      ariaLabel="Cumulative Applied events for this release"
      emptyMessage="No Applied events in this range yet. The chart fills in once devices confirm this package."
      rows={[
        {
          color: APPLIED_COLOR,
          key: "applied",
          label: "Applied",
          values,
        },
      ]}
      showLegend={false}
      timeseries={timeseries}
    />
  );
}
