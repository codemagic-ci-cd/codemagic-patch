// Adoption-over-time chart for the Metrics page: active devices per UTC day,
// one line per release plus a deployment-wide Total line (true distinct
// counts — not the sum of the series). Inline SVG on purpose: the dashboard
// has no chart dependency and the placeholder this replaces was already SVG.
//
// Categorical palette (fixed assignment order, validated for CVD separation
// and 3:1 surface contrast): blue → orange → green → magenta. Total wears a
// neutral ink, never a series hue. The bucket containing `to` is partial by
// server contract and rendered as a dashed segment with a hollow end marker.

import { useMemo, useRef, useState } from "react";

import { formatCount } from "../../model/format";
import {
  dayBucketStarts,
  isPartialBucket,
  timeseriesSeriesLabel,
  zeroFillPoints,
} from "../../model/timeseries";
import type { DeploymentTimeseries } from "../../model/timeseries";
import { CHIP, CHIP_TONE } from "./chip";

const SERIES_COLORS = [
  "var(--color-blue)",
  "var(--color-orange)",
  "var(--color-green)",
  "var(--color-magenta)",
] as const;
const TOTAL_COLOR = "var(--color-fg-2)";
const MAX_DRAWN_SERIES = SERIES_COLORS.length;

const VIEW_W = 720;
const VIEW_H = 220;
const PLOT = { bottom: 26, left: 40, right: 12, top: 10 };
const INNER_W = VIEW_W - PLOT.left - PLOT.right;
const INNER_H = VIEW_H - PLOT.top - PLOT.bottom;

interface ChartRow {
  color: string;
  key: string;
  label: string;
  values: number[];
}

export function AdoptionChart({
  timeseries,
}: {
  timeseries: DeploymentTimeseries;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const buckets = useMemo(
    () => dayBucketStarts(timeseries.from, timeseries.to),
    [timeseries.from, timeseries.to],
  );

  const rows = useMemo<ChartRow[]>(() => {
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
  }, [buckets, timeseries.series, timeseries.totals]);

  const maxValue = Math.max(...rows.flatMap((row) => row.values));
  const undrawnCount = timeseries.series.length - MAX_DRAWN_SERIES;

  if (buckets.length < 2 || maxValue === 0) {
    return (
      <p className="text-[13px] text-fg-2">
        No active-device reports in this range yet. The chart fills in once
        devices run releases from this deployment.
      </p>
    );
  }

  const top = niceCeiling(maxValue);
  const x = (index: number) =>
    PLOT.left + (index / (buckets.length - 1)) * INNER_W;
  const y = (value: number) => PLOT.top + INNER_H * (1 - value / top);
  const lastIndex = buckets.length - 1;
  const lastIsPartial = isPartialBucket(buckets[lastIndex], timeseries.to);

  const handleMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) {
      return;
    }
    const rect = svg.getBoundingClientRect();
    const viewX = ((event.clientX - rect.left) / rect.width) * VIEW_W;
    const index = Math.round(((viewX - PLOT.left) / INNER_W) * lastIndex);
    setHoverIndex(Math.min(lastIndex, Math.max(0, index)));
  };

  const gridValues = [0, top / 2, top];

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        {rows.map((row) => (
          <span
            key={row.key}
            className="flex items-center gap-[7px] text-[12.5px] text-fg-2"
          >
            <span
              className="size-[10px] flex-none rounded-[4px]"
              style={{ background: row.color }}
              aria-hidden="true"
            />
            {row.label}
          </span>
        ))}
        {undrawnCount > 0 ? (
          <span className={`${CHIP} ${CHIP_TONE.neutral}`}>
            +{undrawnCount} quieter series in Total only
          </span>
        ) : null}
        {timeseries.seriesTruncated ? (
          <span className={`${CHIP} ${CHIP_TONE.neutral}`}>top 50 series</span>
        ) : null}
      </div>

      <div className="relative">
        <svg
          ref={svgRef}
          className="block h-auto w-full"
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          role="img"
          aria-label="Active devices per day, per release"
          onMouseMove={handleMove}
          onMouseLeave={() => setHoverIndex(null)}
        >
          {gridValues.map((value) => (
            <g key={value}>
              <line
                className="stroke-border [stroke-dasharray:3_4] [stroke-width:1]"
                x1={PLOT.left}
                y1={y(value)}
                x2={VIEW_W - PLOT.right}
                y2={y(value)}
              />
              <text
                className="fill-fg-3 text-[11px]"
                x={PLOT.left - 7}
                y={y(value) + 3.5}
                textAnchor="end"
              >
                {formatCount(value)}
              </text>
            </g>
          ))}

          {[0, Math.floor(lastIndex / 2), lastIndex]
            .filter((index, position, all) => all.indexOf(index) === position)
            .map((index) => (
              <text
                key={index}
                className="fill-fg-3 text-[11px]"
                x={x(index)}
                y={VIEW_H - 8}
                textAnchor={
                  index === 0 ? "start" : index === lastIndex ? "end" : "middle"
                }
              >
                {bucketDateLabel(buckets[index])}
              </text>
            ))}

          {rows.map((row) => {
            const solidEnd = lastIsPartial ? lastIndex - 1 : lastIndex;
            const solidPoints = row.values
              .slice(0, solidEnd + 1)
              .map((value, index) => `${x(index)},${y(value)}`)
              .join(" ");
            return (
              <g key={row.key}>
                <polyline
                  fill="none"
                  stroke={row.color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  points={solidPoints}
                />
                {lastIsPartial ? (
                  <line
                    stroke={row.color}
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeDasharray="3 5"
                    x1={x(lastIndex - 1)}
                    y1={y(row.values[lastIndex - 1])}
                    x2={x(lastIndex)}
                    y2={y(row.values[lastIndex])}
                  />
                ) : null}
                <circle
                  cx={x(lastIndex)}
                  cy={y(row.values[lastIndex])}
                  r={3.5}
                  fill={lastIsPartial ? "var(--color-surface)" : row.color}
                  stroke={row.color}
                  strokeWidth={1.5}
                />
              </g>
            );
          })}

          {hoverIndex !== null ? (
            <g>
              <line
                className="stroke-border-strong [stroke-width:1]"
                x1={x(hoverIndex)}
                y1={PLOT.top}
                x2={x(hoverIndex)}
                y2={PLOT.top + INNER_H}
              />
              {rows.map((row) => (
                <circle
                  key={row.key}
                  cx={x(hoverIndex)}
                  cy={y(row.values[hoverIndex])}
                  r={3.5}
                  fill={row.color}
                  stroke="var(--color-surface)"
                  strokeWidth={1.5}
                />
              ))}
            </g>
          ) : null}
        </svg>

        {hoverIndex !== null ? (
          <div
            className="pointer-events-none absolute top-0 z-10 min-w-[168px] rounded-[10px] border border-border bg-surface p-2.5 shadow-md"
            style={
              hoverIndex > lastIndex / 2
                ? {
                    right: `${100 - (x(hoverIndex) / VIEW_W) * 100}%`,
                    marginRight: 10,
                  }
                : {
                    left: `${(x(hoverIndex) / VIEW_W) * 100}%`,
                    marginLeft: 10,
                  }
            }
          >
            <div className="mb-1.5 text-[12px] font-semibold text-fg">
              {bucketDateLabel(buckets[hoverIndex])}
              {hoverIndex === lastIndex && lastIsPartial ? (
                <span className="font-normal text-fg-3"> · partial day</span>
              ) : null}
            </div>
            {rows.map((row) => (
              <div
                key={row.key}
                className="flex items-center justify-between gap-3.5 py-px text-[12px] text-fg-2"
              >
                <span className="flex items-center gap-[7px]">
                  <span
                    className="size-[8px] flex-none rounded-[3px]"
                    style={{ background: row.color }}
                    aria-hidden="true"
                  />
                  {row.label}
                </span>
                <span className="mono tabular-nums text-fg">
                  {formatCount(row.values[hoverIndex])}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {/* Table equivalent for screen readers and as the color-free fallback. */}
      <table className="sr-only">
        <caption>Active devices per day, per release</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            {rows.map((row) => (
              <th key={row.key} scope="col">
                {row.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {buckets.map((bucket, index) => (
            <tr key={bucket}>
              <th scope="row">{bucketDateLabel(bucket)}</th>
              {rows.map((row) => (
                <td key={row.key}>{row.values[index]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Smallest 1/2/5 × 10^k value at or above max, so the y-axis ends on a round number. */
function niceCeiling(max: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 5, 10]) {
    if (step * magnitude >= max) {
      return step * magnitude;
    }
  }
  return 10 * magnitude;
}

function bucketDateLabel(bucketStart: string): string {
  return new Date(bucketStart).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}
