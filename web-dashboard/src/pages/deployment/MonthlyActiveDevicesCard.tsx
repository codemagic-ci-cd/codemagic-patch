// Estimated monthly active devices for one deployment, as a line over up to the
// last 12 UTC months. Not every server offers the figure: one that answers 501
// gets no section at all, so this card owns its query and its states rather
// than sharing the page's.

import { useState } from "react";

import {
  isMonthlyActiveDevicesUnavailable,
  useMonthlyActiveDevices,
} from "../../api/hooks/metrics";
import { formatCount } from "../../model/format";
import {
  monthlyActiveDevicesChart,
  type MonthlyActiveDevices,
} from "../../model/monthlyActiveDevices";
import { CARD, CARD_PAD } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorState } from "../../components/ui/ErrorState";
import { Skeleton } from "../../components/ui/Skeleton";
import { TimeseriesChart } from "../../components/ui/TimeseriesChart";
import { SECTION_TITLE } from "../../components/ui/typography";

const CAPTION =
  "Devices running an OTA release per UTC calendar month, updated daily.";

export function MonthlyActiveDevicesCard({
  deploymentId,
}: {
  deploymentId: string;
}) {
  const query = useMonthlyActiveDevices(deploymentId);
  // A retry goes back through pending, but by then this server has shown it
  // offers the figure, so the section stays.
  const [retried, setRetried] = useState(false);

  // Nothing while first pending, so a server without the figure never shows a
  // section that vanishes one round trip later.
  if (
    (query.isPending && !retried) ||
    (query.isError && isMonthlyActiveDevicesUnavailable(query.error))
  ) {
    return null;
  }

  return (
    <div className={`${CARD} ${CARD_PAD} mb-[18px]`}>
      <div className={`${SECTION_TITLE} mb-[18px]`}>Monthly active devices</div>
      {query.isPending ? (
        <div role="status" aria-label="Loading monthly active devices">
          <Skeleton variant="line" />
          <Skeleton variant="line" />
        </div>
      ) : query.isError ? (
        <ErrorState
          error={query.error}
          onRetry={() => {
            setRetried(true);
            void query.refetch();
          }}
        />
      ) : query.data.months.length === 0 ? (
        <EmptyState title="No monthly figures yet" description={CAPTION} />
      ) : (
        <>
          <MonthlyFigures data={query.data} />
          <p className="mt-3.5 text-[12.5px] text-fg-3">{CAPTION}</p>
        </>
      )}
    </div>
  );
}

function formatEstimate(value: number): string {
  return `≈${formatCount(value)}`;
}

/** A line needs two months; the first counted month is stated in words. */
function MonthlyFigures({ data }: { data: MonthlyActiveDevices }) {
  const { buckets, values } = monthlyActiveDevicesChart(data);

  if (buckets.length === 1) {
    return (
      <p className="text-[13px] text-fg-2">
        <span className="mono text-fg">{formatEstimate(values[0])}</span> in{" "}
        {buckets[0].label}
        {buckets[0].partialNote ? `, ${buckets[0].partialNote}` : null}
      </p>
    );
  }

  return (
    <div className="h-[180px]">
      <TimeseriesChart
        ariaLabel="Estimated active devices per UTC month"
        bucketHeading="Month"
        buckets={buckets}
        emptyMessage="No active devices in these months."
        fill
        formatValue={formatEstimate}
        rows={[
          {
            color: "var(--color-chart-1)",
            key: "active-devices",
            label: "Active devices",
            values,
          },
        ]}
        showLegend={false}
      />
    </div>
  );
}
