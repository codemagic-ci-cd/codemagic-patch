import { formatCount } from "../../model/format";
import type { MetricsRollup } from "./useMetricsRollup";
import { ICON_BTN } from "../../components/ui/iconButton";
import { Skeleton } from "../../components/ui/Skeleton";
import { TBL_NUM, TBL_TD } from "../../components/ui/table";

export function MetricsRollupCells({
  label,
  isPending,
  isError,
  rollup,
  onRetry,
}: {
  label: string;
  isPending: boolean;
  isError: boolean;
  rollup: MetricsRollup | null | undefined;
  onRetry: () => void;
}) {
  if (isPending) {
    return (
      <>
        <MetricSkeletonCell />
        <MetricSkeletonCell />
        <MetricSkeletonCell />
        <MetricSkeletonCell />
      </>
    );
  }

  if (isError) {
    return (
      <td className={TBL_TD} colSpan={4}>
        <MetricCellRetry
          onRetry={onRetry}
          ariaLabel={`Retry loading metrics for ${label}`}
        />
      </td>
    );
  }

  if (rollup === null || rollup === undefined) {
    return (
      <>
        <EmptyMetricCell />
        <EmptyMetricCell />
        <EmptyMetricCell />
        <EmptyMetricCell />
      </>
    );
  }

  const { totals, rate } = rollup;
  return (
    <>
      <td className={`${TBL_TD} ${TBL_NUM}`}>{formatCount(totals.active)}</td>
      <td className={`${TBL_TD} ${TBL_NUM}`}>
        {formatCount(totals.downloaded)}
      </td>
      <td className={`${TBL_TD} ${TBL_NUM}`}>{formatCount(totals.failed)}</td>
      <td className={`${TBL_TD} ${TBL_NUM}`}>
        {rate === null ? "—" : `${(rate * 100).toFixed(1)}%`}
      </td>
    </>
  );
}

function MetricSkeletonCell() {
  return (
    <td className={`${TBL_TD} ${TBL_NUM}`}>
      <span className="flex justify-end">
        <Skeleton width={48} variant="text" />
      </span>
    </td>
  );
}

function EmptyMetricCell() {
  return (
    <td className={`${TBL_TD} ${TBL_NUM}`}>
      <span className="text-fg-3">—</span>
    </td>
  );
}

function MetricCellRetry({
  onRetry,
  ariaLabel,
}: {
  onRetry: () => void;
  ariaLabel: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] text-fg-2">
      <span className="text-fg-3" aria-hidden="true">
        Couldn't load metrics
      </span>
      <button
        type="button"
        className={`${ICON_BTN} size-6 rounded-[7px]`}
        aria-label={ariaLabel}
        onClick={onRetry}
      >
        <svg
          className="size-[13px]"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="23 4 23 10 17 10" />
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
        </svg>
      </button>
    </span>
  );
}
