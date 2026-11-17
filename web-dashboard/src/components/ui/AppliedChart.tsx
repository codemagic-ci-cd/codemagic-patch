// Cumulative Applied take-up for one package hash, plotted with the shared
// timeseries SVG from the server's `cumulative_success` (summed from the start
// of the range); this is not Active devices and not the rollout-percentage
// policy.

import { dayChartBuckets } from "../../model/timeseries";
import type { DeploymentTimeseries } from "../../model/timeseries";
import { TimeseriesChart } from "./TimeseriesChart";

const APPLIED_COLOR = "var(--color-blue)";
const NO_APPLIED_EVENTS =
  "No Applied events in this range yet. The chart fills in once devices confirm this package.";

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

  const entry = timeseries.series.find(
    (series) => series.targetPackageHash === targetPackageHash,
  );
  const values = entry?.cumulativeSuccess ?? null;
  if (values === null) {
    return (
      <p className="text-[13px] text-fg-2">
        {entry !== undefined || timeseries.unlistedSeries === null
          ? "This server does not report Applied events over time."
          : timeseries.unlistedSeries === "no_events"
            ? NO_APPLIED_EVENTS
            : "This package is not in the busiest series for this range, so its Applied events are unavailable."}
      </p>
    );
  }

  return (
    <TimeseriesChart
      ariaLabel="Cumulative Applied events for this release"
      bucketHeading="Day"
      buckets={dayChartBuckets(timeseries.from, timeseries.to)}
      emptyMessage={NO_APPLIED_EVENTS}
      rows={[
        {
          color: APPLIED_COLOR,
          key: "applied",
          label: "Applied",
          values,
        },
      ]}
      showLegend={false}
    />
  );
}
