// Shared deployment overview: in-range totals and the adoption chart, driven
// by one timeseries query. A year is the widest preset the endpoint allows
// (366-day cap after UTC truncation). Failure stays on this card; the release
// history table is unaffected.

import { type ReactNode } from "react";

import { AdoptionChart } from "../../components/ui/AdoptionChart";
import { CARD, CARD_HEAD, CARD_HEAD_RIGHT } from "../../components/ui/card";
import { ErrorState } from "../../components/ui/ErrorState";
import { Skeleton } from "../../components/ui/Skeleton";
import {
  TimeseriesRangeSelector,
  useTimeseriesRange,
} from "../../components/ui/TimeseriesRangeSelector";
import { formatCount, formatSuccessRate } from "../../model/format";
import { successRate } from "../../model/metrics";
import { sumTimeseriesTotals } from "../../model/timeseries";

const METRIC_CELL =
  "tip flex h-full min-w-0 flex-col justify-center rounded-lg border border-border py-3 pl-[22px] pr-4";
const CHART_WELL =
  "flex h-full min-h-[220px] min-w-0 flex-col rounded-lg border border-border px-4 py-3";
const METRIC_TOP =
  "flex items-center gap-2 text-[14px] font-semibold text-fg-2";
const METRIC_ICO = "text-fg-3 [&_svg]:block [&_svg]:size-[17px]";
const METRIC_VAL =
  "mt-1.5 text-[32px] font-semibold leading-none tracking-[-.03em] tabular-nums [&_small]:text-[16px] [&_small]:font-semibold [&_small]:text-fg-3";

export function OverviewCard({ deploymentId }: { deploymentId: string }) {
  const { rangeDays, setRangeDays, timeseriesQuery } =
    useTimeseriesRange(deploymentId);

  const totals = timeseriesQuery.data
    ? sumTimeseriesTotals(timeseriesQuery.data.totals)
    : null;
  const rate = totals === null ? null : successRate(totals);
  const loading = timeseriesQuery.isPending;
  const rangeStale = timeseriesQuery.isPlaceholderData;

  return (
    <div className={`${CARD} mb-[18px]`}>
      <div className={CARD_HEAD}>
        <h3>Adoption</h3>
        <div className={CARD_HEAD_RIGHT}>
          <TimeseriesRangeSelector
            onChange={setRangeDays}
            rangeDays={rangeDays}
          />
        </div>
      </div>
      <div className="grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] items-stretch gap-5 [display:grid] p-5 max-cols:grid-cols-[1fr]">
        <div
          className={`h-full min-w-0 grid-cols-2 grid-rows-2 gap-3 [display:grid]${rangeStale ? " opacity-60" : ""}`}
          aria-busy={loading || rangeStale || undefined}
        >
          <Metric
            icon={<DownloadIcon />}
            label="Downloaded"
            loading={loading}
            tip="Patch download events"
            value={totals === null ? null : formatCount(totals.downloaded)}
          />
          <Metric
            icon={<CheckCircleIcon />}
            label="Applied"
            loading={loading}
            tip="Successfully applied updates"
            value={totals === null ? null : formatCount(totals.success)}
          />
          <Metric
            icon={<AlertIcon />}
            label="Failed"
            loading={loading}
            tip="Failed installs"
            value={totals === null ? null : formatCount(totals.failed)}
          />
          <Metric
            icon={<CheckCircleIcon />}
            label="Success rate"
            loading={loading}
            tip="Applied / (applied + failed)"
            value={
              rate === null ? null : (
                <>
                  {formatSuccessRate(rate)}
                  <small>%</small>
                </>
              )
            }
          />
        </div>
        <div className={CHART_WELL}>
          {loading ? (
            <div
              className="flex min-h-0 flex-1 flex-col"
              role="status"
              aria-label="Loading adoption"
            >
              <Skeleton className="min-h-0 flex-1" />
            </div>
          ) : timeseriesQuery.isError ? (
            <ErrorState
              error={timeseriesQuery.error}
              onRetry={() => {
                void timeseriesQuery.refetch();
              }}
            />
          ) : (
            <div
              className={`flex min-h-0 flex-1 flex-col${rangeStale ? " opacity-60" : ""}`}
              aria-busy={rangeStale || undefined}
            >
              <AdoptionChart fill timeseries={timeseriesQuery.data} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Metric({
  icon,
  label,
  loading,
  tip,
  value,
}: {
  icon: ReactNode;
  label: string;
  loading: boolean;
  tip: string;
  value: ReactNode;
}) {
  return (
    <div className={METRIC_CELL} data-tip={tip}>
      <div className={METRIC_TOP}>
        {label}
        <span className={METRIC_ICO}>{icon}</span>
      </div>
      <div className={METRIC_VAL}>
        {loading ? <Skeleton width={72} height={32} /> : (value ?? "—")}
      </div>
    </div>
  );
}

function IconSvg({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function DownloadIcon() {
  return (
    <IconSvg>
      <g transform="translate(0 -1.5)">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </g>
    </IconSvg>
  );
}

function CheckCircleIcon() {
  return (
    <IconSvg>
      <circle cx="12" cy="12" r="9" />
      <polyline points="16 9.5 11 14.5 8.5 12" />
    </IconSvg>
  );
}

function AlertIcon() {
  return (
    <IconSvg>
      <path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12" y2="17" />
    </IconSvg>
  );
}
