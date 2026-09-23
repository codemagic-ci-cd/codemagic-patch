// Shared 7d / 30d / 90d / 1y presets for deployment timeseries charts.
// Callers share query keys, so a visit to one screen warms the others.

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  prefetchDeploymentTimeseries,
  useDeploymentTimeseries,
} from "../../api/hooks/metrics";

export const TIMESERIES_RANGE_OPTIONS = [
  { days: 7, label: "7d", name: "Last 7 days" },
  { days: 30, label: "30d", name: "Last 30 days" },
  { days: 90, label: "90d", name: "Last 90 days" },
  { days: 365, label: "1y", name: "Last year" },
] as const;

export const DEFAULT_TIMESERIES_RANGE_DAYS = 30;

const SEGMENTED =
  "inline-flex shrink-0 gap-[3px] rounded-control border border-border p-[3px]";
const SEGMENTED_BTN =
  "rounded-[8px] border-0 px-2.5 py-1 text-[12px] font-semibold [transition:.13s]";
const SEGMENTED_BTN_IDLE = "bg-transparent text-fg-2";
const SEGMENTED_BTN_ACTIVE = "bg-surface-3 text-fg";

export function TimeseriesRangeSelector({
  rangeDays,
  onChange,
}: {
  rangeDays: number;
  onChange: (days: number) => void;
}) {
  return (
    <div className={SEGMENTED} role="group" aria-label="Time range">
      {TIMESERIES_RANGE_OPTIONS.map((option) => {
        const active = option.days === rangeDays;
        return (
          <button
            key={option.days}
            type="button"
            aria-label={option.name}
            aria-pressed={active}
            className={`${SEGMENTED_BTN} ${active ? SEGMENTED_BTN_ACTIVE : SEGMENTED_BTN_IDLE}`}
            onClick={() => {
              onChange(option.days);
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function useTimeseriesRange(deploymentId: string) {
  const queryClient = useQueryClient();
  const [rangeDays, setRangeDays] = useState(DEFAULT_TIMESERIES_RANGE_DAYS);
  const timeseriesQuery = useDeploymentTimeseries(deploymentId, { rangeDays });

  useEffect(() => {
    if (!timeseriesQuery.isSuccess) {
      return;
    }
    for (const option of TIMESERIES_RANGE_OPTIONS) {
      if (option.days !== rangeDays) {
        void prefetchDeploymentTimeseries(queryClient, deploymentId, option.days);
      }
    }
  }, [deploymentId, queryClient, rangeDays, timeseriesQuery.isSuccess]);

  return { rangeDays, setRangeDays, timeseriesQuery };
}
