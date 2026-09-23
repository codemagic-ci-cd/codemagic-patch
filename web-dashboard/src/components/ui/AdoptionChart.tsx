// Adoption-over-time chart: active devices per UTC day,
// one line per release plus a deployment-wide Total line (true distinct
// counts — not the sum of the series).
//
// Categorical palette (fixed assignment order, validated for CVD separation
// and 3:1 surface contrast): blue → orange → green → magenta. Total wears a
// neutral ink, never a series hue.

import { useMemo } from "react";

import {
  dayBucketStarts,
  timeseriesSeriesLabel,
  zeroFillPoints,
} from "../../model/timeseries";
import type { DeploymentTimeseries } from "../../model/timeseries";
import { CHIP, CHIP_TONE } from "./chip";
import { TimeseriesChart } from "./TimeseriesChart";

const SERIES_COLORS = [
  "var(--color-blue)",
  "var(--color-orange)",
  "var(--color-green)",
  "var(--color-magenta)",
] as const;
const TOTAL_COLOR = "var(--color-fg-2)";
const MAX_DRAWN_SERIES = SERIES_COLORS.length;

export function AdoptionChart({
  timeseries,
  fill = false,
}: {
  timeseries: DeploymentTimeseries;
  /** Stretch the plot to the parent. Used by the deployment overview card. */
  fill?: boolean;
}) {
  const buckets = useMemo(
    () => dayBucketStarts(timeseries.from, timeseries.to),
    [timeseries.from, timeseries.to],
  );

  const rows = useMemo(
    () => {
      const drawn = timeseries.series.slice(0, MAX_DRAWN_SERIES);
      return [
        {
          color: TOTAL_COLOR,
          key: "total",
          label: "Total",
          values: zeroFillPoints(buckets, timeseries.totals).map(
            (point) => point.activeDevices,
          ),
        },
        ...drawn.map((entry, index) => ({
          color: SERIES_COLORS[index],
          key: entry.targetPackageHash ?? `release:${entry.releaseId ?? "none"}`,
          label: timeseriesSeriesLabel(entry),
          values: zeroFillPoints(buckets, entry.points).map(
            (point) => point.activeDevices,
          ),
        })),
      ];
    },
    [buckets, timeseries.series, timeseries.totals],
  );

  const undrawnCount = timeseries.series.length - MAX_DRAWN_SERIES;

  return (
    <TimeseriesChart
      ariaLabel="Active devices per day, per release"
      emptyMessage="No active-device reports in this range yet. The chart fills in once devices run releases from this deployment."
      fill={fill}
      legendExtra={
        <>
          {undrawnCount > 0 ? (
            <span className={`${CHIP} ${CHIP_TONE.neutral}`}>
              +{undrawnCount} quieter series in Total only
            </span>
          ) : null}
          {timeseries.seriesTruncated ? (
            <span className={`${CHIP} ${CHIP_TONE.neutral}`}>top 50 series</span>
          ) : null}
        </>
      }
      rows={rows}
      timeseries={timeseries}
    />
  );
}
