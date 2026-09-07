import type { ReactNode } from "react";

import { CARD, CARD_PAD } from "../../components/ui/card";
import { PageHeader } from "../../components/ui/PageHeader";
import { Skeleton } from "../../components/ui/Skeleton";

export function MetricsPageFrame({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <PageHeader
        title={title}
        description={subtitle}
        actions={actions}
      />
      {children}
    </>
  );
}

export function MetricsBodySkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label}>
      <div className="mb-[18px] grid-cols-[repeat(4,1fr)] gap-[18px] [display:grid] max-cols:grid-cols-[repeat(2,1fr)]">
        <Skeleton height={118} />
        <Skeleton height={118} />
        <Skeleton height={118} />
        <Skeleton height={118} />
      </div>
      <div className={`${CARD} ${CARD_PAD}`}>
        <Skeleton variant="line" />
        <Skeleton variant="line" />
        <Skeleton variant="line" />
      </div>
    </div>
  );
}

export function MetricsTableSkeleton({
  label,
  columns,
}: {
  label: string;
  columns: readonly string[];
}) {
  return (
    <div
      className="rounded-lg border border-border bg-surface shadow-sm"
      role="status"
      aria-label={label}
    >
      <div className="p-[22px]">
        <Skeleton width="30%" height={18} />
        <div className="mt-4 flex flex-col gap-2.5">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} height={36} />
          ))}
        </div>
      </div>
      <span className="sr-only">{columns.join(", ")}</span>
    </div>
  );
}
