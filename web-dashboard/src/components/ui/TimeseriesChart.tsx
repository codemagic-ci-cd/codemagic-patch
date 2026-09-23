// Shared UTC-day line chart used by adoption (Active) and per-release Applied.
// Inline SVG on purpose: the dashboard has no chart dependency.
//
// The bucket containing `to` is partial by server contract and rendered as a
// dashed segment with a hollow end marker.

import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { formatCompactCount, formatCount } from "../../model/format";
import { dayBucketStarts, isPartialBucket } from "../../model/timeseries";
import type { DeploymentTimeseries } from "../../model/timeseries";

const FULL_VIEW = {
  height: 220,
  plot: { bottom: 26, left: 40, right: 12, top: 10 },
  width: 720,
} as const;
const COMPACT_VIEW = {
  height: 148,
  plot: { bottom: 22, left: 34, right: 8, top: 8 },
  width: 560,
} as const;

export interface TimeseriesChartRow {
  color: string;
  key: string;
  label: string;
  values: number[];
}

export function TimeseriesChart({
  ariaLabel,
  emptyMessage,
  fill = false,
  legendExtra,
  rows,
  showLegend = true,
  timeseries,
}: {
  ariaLabel: string;
  emptyMessage: string;
  /** Stretch the plot to the parent. Used by the deployment overview card. */
  fill?: boolean;
  legendExtra?: ReactNode;
  rows: TimeseriesChartRow[];
  showLegend?: boolean;
  timeseries: Pick<DeploymentTimeseries, "from" | "to">;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  // State (not a plain ref) so empty ↔ plot remounts re-run the observer effect.
  const [plotNode, setPlotNode] = useState<HTMLDivElement | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [plotSize, setPlotSize] = useState({ height: 0, width: 0 });

  useLayoutEffect(() => {
    if (!fill || plotNode === null) {
      return;
    }
    const update = () => {
      setPlotSize({
        height: plotNode.clientHeight,
        width: plotNode.clientWidth,
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(plotNode);
    return () => observer.disconnect();
  }, [fill, plotNode]);

  const view = fill ? COMPACT_VIEW : FULL_VIEW;
  const viewW = fill && plotSize.width > 0 ? plotSize.width : view.width;
  const viewH = fill && plotSize.height > 0 ? plotSize.height : view.height;
  const plot = view.plot;
  const innerW = viewW - plot.left - plot.right;
  const innerH = viewH - plot.top - plot.bottom;

  const buckets = useMemo(
    () => dayBucketStarts(timeseries.from, timeseries.to),
    [timeseries.from, timeseries.to],
  );

  const maxValue = Math.max(0, ...rows.flatMap((row) => row.values));

  if (buckets.length < 2 || maxValue === 0) {
    return <p className="text-[13px] text-fg-2">{emptyMessage}</p>;
  }

  const top = niceCeiling(maxValue);
  const x = (index: number) =>
    plot.left + (index / (buckets.length - 1)) * innerW;
  const y = (value: number) => plot.top + innerH * (1 - value / top);
  const lastIndex = buckets.length - 1;
  const lastIsPartial = isPartialBucket(buckets[lastIndex], timeseries.to);

  const handleMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) {
      return;
    }
    const rect = svg.getBoundingClientRect();
    const viewX = ((event.clientX - rect.left) / rect.width) * viewW;
    const index = Math.round(((viewX - plot.left) / innerW) * lastIndex);
    setHoverIndex(Math.min(lastIndex, Math.max(0, index)));
  };

  const gridValues = [0, top / 2, top];
  const showLegendRow = showLegend || legendExtra != null;

  return (
    <div className={fill ? "flex h-full min-h-0 flex-col" : undefined}>
      {showLegendRow ? (
        <div
          className={`flex flex-wrap items-center justify-end gap-2.5 ${fill ? "mb-2 shrink-0" : "mb-3"}`}
        >
          {showLegend
            ? rows.map((row) => (
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
              ))
            : null}
          {legendExtra}
        </div>
      ) : null}

      <div
        ref={setPlotNode}
        className={fill ? "relative min-h-0 flex-1" : "relative"}
      >
        <svg
          ref={svgRef}
          className={fill ? "block size-full" : "block h-auto w-full"}
          viewBox={`0 0 ${viewW} ${viewH}`}
          preserveAspectRatio={fill ? "none" : undefined}
          role="img"
          aria-label={ariaLabel}
          onMouseMove={handleMove}
          onMouseLeave={() => setHoverIndex(null)}
        >
          {gridValues.map((value) => (
            <g key={value}>
              <line
                className={
                  value === 0
                    ? "stroke-border-strong [stroke-width:1]"
                    : "stroke-border [stroke-dasharray:3_4] [stroke-width:1]"
                }
                x1={plot.left}
                y1={y(value)}
                x2={viewW - plot.right}
                y2={y(value)}
              />
              <text
                className="fill-fg-3 text-[11px]"
                x={plot.left - 7}
                y={y(value) + 3.5}
                textAnchor="end"
              >
                {formatCompactCount(value)}
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
                y={viewH - 8}
                textAnchor={
                  index === 0 ? "start" : index === lastIndex ? "end" : "middle"
                }
              >
                {bucketDateLabel(buckets[index])}
              </text>
            ))}

          {rows.map((row) => {
            const solidEnd = lastIsPartial ? lastIndex - 1 : lastIndex;
            const first = row.values.findIndex((value) => value > 0);
            const from = first > 0 ? first - 1 : first;
            const solidPoints =
              first === -1 || from > solidEnd
                ? ""
                : row.values
                    .slice(from, solidEnd + 1)
                    .map((value, offset) => `${x(from + offset)},${y(value)}`)
                    .join(" ");
            return (
              <g key={row.key}>
                {solidPoints ? (
                  <polyline
                    fill="none"
                    stroke={row.color}
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    points={solidPoints}
                  />
                ) : null}
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
                y1={plot.top}
                x2={x(hoverIndex)}
                y2={plot.top + innerH}
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
                    right: `${100 - (x(hoverIndex) / viewW) * 100}%`,
                    marginRight: 10,
                  }
                : {
                    left: `${(x(hoverIndex) / viewW) * 100}%`,
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

      {/* Table equivalent for screen readers and as the color-free fallback.
          Wrap it: `sr-only` on a <table> cannot shrink the box (table
          height ignores the 1px rule), so the day rows were stretching
          the page and creating a blank scroll. */}
      <div className="sr-only">
        <table>
          <caption>{ariaLabel}</caption>
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
