// Drill-down for one failure reason: code list → one code's detail.
//
// Both levels live in the same dialog rather than in a route of their own. The
// drill-down is a lookup an operator performs while reading the metrics card,
// so moving them to a separate page would cost them the card they were reading
// and a navigation back to it, in exchange for nothing the dialog cannot hold.
//
// The second level pairs two aggregates with the raw feed on purpose: the bars
// answer "what does this code usually look like", the feed answers "what
// exactly happened". Neither substitutes for the other, and the bars are NOT
// derived from the loaded feed pages — see model/metrics.ts FailureDistribution.
//
// Every list here pages on scroll rather than truncating, and there is exactly
// one scroll region: the dialog body. Giving the lists boxes of their own would
// nest a scrollbar inside a scrollbar as soon as the ten bars above them made
// the dialog exceed its own height, and a reader who scrolled the wrong one
// would conclude the list had ended.
//
// Shapes: PROTOCOL.md §Metric Event `Failed` Payload. Paging: api/hooks/metrics.ts.

import { useEffect, useRef, useState } from "react";

import {
  useFailureCodes,
  useFailureDistribution,
  useFailureEvents,
} from "../../api/hooks/metrics";
import type { FailureScope } from "../../api/hooks/metrics";
import {
  formatCount,
  formatDateTime,
  formatRelativeTime,
} from "../../model/format";
import {
  failureCodeLabel,
  failureCodeShares,
  failureDistributionBars,
  failureReasonLabel,
} from "../../model/metrics";
import type {
  FailureDistributionEntry,
  FailureEvent,
} from "../../model/metrics";
import { Button } from "./Button";
import { Modal } from "../overlay/Modal";
import { Skeleton } from "./Skeleton";

/** How far below the fold the sentinel still counts as reached. */
const FETCH_MORE_THRESHOLD_PX = 120;

/** Sentinel key for the bucket of failures whose payload carried no code. */
const NO_CODE_KEY = "__no_code__";

/** Which level the dialog is showing. */
type View =
  | { kind: "codes" }
  /** `code` is null for the no-code bucket, which is a bucket like any other. */
  | { code: string | null; kind: "detail" };

export function FailureDetailDialog({
  onClose,
  open,
  reason,
  reasonTotal,
  scope,
  scopeNote,
}: {
  onClose: () => void;
  open: boolean;
  /** Null while the dialog is closed. */
  reason: string | null;
  /** The reason's failure count from the counters card — the share denominator. */
  reasonTotal: number;
  scope: FailureScope;
  /** What the numbers are counting; the counters card and this can differ. */
  scopeNote: string;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={reason === null ? "Failure detail" : failureReasonLabel(reason)}
      description={scopeNote}
      wide
    >
      {/* Keyed by reason so the open view resets on its own when the dialog
          moves to another reason — no effect writing state to undo it. */}
      <DialogBody
        key={reason ?? "none"}
        open={open}
        reason={reason}
        reasonTotal={reasonTotal}
        scope={scope}
      />
    </Modal>
  );
}

function DialogBody({
  open,
  reason,
  reasonTotal,
  scope,
}: {
  open: boolean;
  reason: string | null;
  reasonTotal: number;
  scope: FailureScope;
}) {
  const [view, setView] = useState<View>({ kind: "codes" });

  const codesQuery = useFailureCodes(scope, open ? reason : null);
  const codes = codesQuery.data ?? [];
  const shares = failureCodeShares(codes, reasonTotal);

  if (view.kind === "detail") {
    const selected = shares.find((share) => share.code === view.code);

    return (
      <CodeDetail
        code={view.code}
        count={selected?.count ?? 0}
        onBack={() => {
          setView({ kind: "codes" });
        }}
        reason={reason ?? ""}
        scope={scope}
        share={selected?.share ?? 0}
      />
    );
  }

  if (codesQuery.isPending) {
    return (
      <div role="status" aria-label="Loading error codes">
        <Skeleton variant="line" />
        <Skeleton variant="line" />
      </div>
    );
  }

  if (codesQuery.isError && codes.length === 0) {
    return (
      <div role="alert">
        <p className="text-[13px] text-fg-2">
          Error codes could not be loaded.
        </p>
        <Button
          className="mt-2.5"
          intent="ghost"
          size="sm"
          onClick={() => {
            void codesQuery.refetch();
          }}
        >
          Retry
        </Button>
      </div>
    );
  }

  if (codes.length === 0) {
    return (
      <p className="text-[13px] text-fg-2">
        No per-error detail was reported for this reason. Devices running an SDK
        older than the failure-payload contract report the reason only.
      </p>
    );
  }

  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {shares.map((share) => {
        const label = failureCodeLabel(reason ?? "", share.code);

        return (
          <li key={share.code ?? NO_CODE_KEY}>
            <button
              type="button"
              className="block w-full rounded-sm bg-transparent px-2 py-2 text-left [transition:.12s] hover:bg-surface-2"
              onClick={() => {
                setView({ code: share.code, kind: "detail" });
              }}
            >
              <div className="flex items-baseline justify-between gap-3.5">
                <span className="flex items-baseline gap-1.5">
                  <Chevron />
                  <span
                    className={
                      label.isCode
                        ? "mono text-[13px] font-semibold text-fg"
                        : "text-[13px] text-fg-3"
                    }
                  >
                    {label.text}
                  </span>
                </span>
                <span className="mono flex-none text-[12.5px] text-fg-2">
                  {formatCount(share.count)} · {(share.share * 100).toFixed(1)}%
                </span>
              </div>
              <div className="mt-1 pl-[18px] text-[11.5px] text-fg-3">
                last seen{" "}
                <time
                  dateTime={share.lastSeenAt}
                  title={formatDateTime(share.lastSeenAt)}
                >
                  {formatRelativeTime(share.lastSeenAt)}
                </time>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function CodeDetail({
  code,
  count,
  onBack,
  reason,
  scope,
  share,
}: {
  code: string | null;
  count: number;
  onBack: () => void;
  reason: string;
  scope: FailureScope;
  share: number;
}) {
  const distributionQuery = useFailureDistribution(scope, reason, code);
  const eventsQuery = useFailureEvents(scope, reason, code);

  const distribution = distributionQuery.data;
  const events = eventsQuery.data?.pages.flatMap((page) => page.events) ?? [];
  const label = failureCodeLabel(reason, code);

  // Both views share the dialog's one scroll region, so arriving here from a
  // code far down the list would otherwise open this view already scrolled
  // past its own heading.
  const topRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    topRef.current?.scrollIntoView({ block: "start" });
  }, []);

  return (
    <div>
      <button
        ref={topRef}
        type="button"
        className="-ml-1 mb-2 flex items-center gap-1 rounded-sm bg-transparent px-1 py-1 text-[12px] text-fg-2 [transition:.12s] hover:text-fg"
        onClick={onBack}
      >
        <Chevron back />
        All error codes
      </button>

      <div className="flex items-baseline justify-between gap-3.5 border-b border-border pb-3">
        <span
          className={
            label.isCode
              ? "mono text-[15px] font-semibold text-fg"
              : "text-[15px] font-semibold text-fg-2"
          }
        >
          {label.text}
        </span>
        <span className="mono flex-none text-[12.5px] text-fg-2">
          {formatCount(count)} · {(share * 100).toFixed(1)}%
        </span>
      </div>

      {distributionQuery.isPending ? (
        <div
          className="pt-3.5"
          role="status"
          aria-label="Loading distributions"
        >
          <Skeleton variant="line" />
        </div>
      ) : distribution === undefined ? (
        <p className="pt-3.5 text-[12.5px] text-fg-3">
          The distribution could not be loaded.
        </p>
      ) : distribution.messages.length === 0 &&
        distribution.exitReasons.length === 0 ? (
        <p className="pt-3.5 text-[12.5px] text-fg-3">
          These failures reported nothing beyond the code itself.
        </p>
      ) : (
        <>
          {/* A section is drawn only when it has bars. A crash rollback has no
              message to relay and a download failure has no exit reason to
              report, so a fixed pair of sections would leave one of them
              standing empty on every bucket. */}
          {distribution.messages.length > 0 ? (
            <Distribution
              entries={distribution.messages}
              title="Top messages"
              total={distribution.total}
            />
          ) : null}
          {distribution.exitReasons.length > 0 ? (
            <Distribution
              entries={distribution.exitReasons}
              mono
              title="Top previous process exits"
              total={distribution.total}
            />
          ) : null}
        </>
      )}

      <div className="mb-2 mt-4 flex items-baseline justify-between border-t border-border pt-3.5">
        <span className="text-[12px] font-semibold text-fg-2">Events</span>
        <span className="text-[11.5px] text-fg-3">newest first</span>
      </div>

      {eventsQuery.isPending ? (
        <div role="status" aria-label="Loading events">
          <Skeleton variant="line" />
          <Skeleton variant="line" />
        </div>
      ) : eventsQuery.isError && events.length === 0 ? (
        <div role="alert">
          <Button
            intent="ghost"
            size="sm"
            onClick={() => {
              void eventsQuery.refetch();
            }}
          >
            Retry loading events
          </Button>
        </div>
      ) : (
        <>
          <ul className="m-0 flex list-none flex-col p-0">
            {events.map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
          </ul>
          <FetchMoreSentinel
            ariaLabel="events"
            hasMore={eventsQuery.hasNextPage}
            isFetchingMore={eventsQuery.isFetchingNextPage}
            onFetchMore={eventsQuery.fetchNextPage}
          />
        </>
      )}
    </div>
  );
}

function Distribution({
  entries,
  mono = false,
  title,
  total,
}: {
  /** Never empty: the caller omits the whole section instead. */
  entries: readonly FailureDistributionEntry[];
  mono?: boolean;
  title: string;
  total: number;
}) {
  const bars = failureDistributionBars(entries, total);

  return (
    <section className="pt-3.5">
      <h4 className="mb-2.5 text-[12px] font-semibold text-fg-2">{title}</h4>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {bars.map((bar) => (
          <li key={bar.value}>
            <div className="mb-[3px] flex items-baseline justify-between gap-3.5 text-[12px]">
              <span
                className={`truncate ${mono ? "mono text-fg-2" : "text-fg-2"}`}
                title={bar.value}
              >
                {bar.value}
              </span>
              <span className="mono flex-none text-[11.5px] text-fg-3">
                {formatCount(bar.count)} · {(bar.share * 100).toFixed(1)}%
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-pill bg-surface-2">
              <div
                className="h-full rounded-pill bg-red"
                style={{ width: `${Math.max(bar.width * 100, 2)}%` }}
                role="progressbar"
                aria-label={bar.value}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(bar.share * 100)}
                aria-valuetext={`${(bar.share * 100).toFixed(1)}%`}
              />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function EventRow({ event }: { event: FailureEvent }) {
  return (
    <li className="border-b border-border py-2 last:border-b-0">
      <div className="flex items-baseline justify-between gap-3.5 text-[11.5px] text-fg-3">
        {/* Absolute, not relative: a reader scanning this feed is lining it up
            against their own logs, and "3h ago" does not line up with
            anything. The code rows above use relative time because there the
            question is only how fresh the bucket is. */}
        <time className="mono" dateTime={event.emittedAt}>
          {formatDateTime(event.emittedAt)}
        </time>
        <span className="mono flex-none truncate" title={event.deviceId}>
          {event.deviceId}
        </span>
      </div>
      <div className="mt-[3px] flex items-baseline gap-2">
        {event.androidPreviousProcessExit === null ? null : (
          <span className="mono flex-none rounded-sm bg-surface-2 px-1.5 py-[1px] text-[11px] text-fg-2">
            {event.androidPreviousProcessExit}
          </span>
        )}
        <span
          className={`truncate text-[12.5px] ${
            event.message === null ? "text-fg-3 italic" : "text-fg-2"
          }`}
          title={event.message ?? undefined}
        >
          {event.message ?? "No message relayed"}
        </span>
      </div>
    </li>
  );
}

/**
 * Requests the next page once the end of a list comes within reach of the
 * viewport, and reserves the row the loading placeholder will occupy.
 *
 * An IntersectionObserver rather than a scroll handler because the element
 * that scrolls is the dialog body, several levels up and not this component's
 * to know about. The observer accounts for clipping by whatever ancestor
 * happens to scroll, so a list nested one level deeper keeps working.
 */
function FetchMoreSentinel({
  ariaLabel,
  hasMore,
  isFetchingMore,
  onFetchMore,
}: {
  ariaLabel: string;
  hasMore: boolean;
  isFetchingMore: boolean;
  /** The query's own `fetchNextPage`; stable, so the observer is not rebuilt. */
  onFetchMore: () => unknown;
}) {
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = sentinelRef.current;
    if (element === null || !hasMore || isFetchingMore) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void onFetchMore();
        }
      },
      { rootMargin: `${String(FETCH_MORE_THRESHOLD_PX)}px` },
    );
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [hasMore, isFetchingMore, onFetchMore]);

  return (
    <div ref={sentinelRef} className="pt-3">
      {isFetchingMore ? (
        <div role="status" aria-label={`Loading more ${ariaLabel}`}>
          <Skeleton width="45%" variant="text" />
        </div>
      ) : null}
    </div>
  );
}

function Chevron({ back = false }: { back?: boolean }) {
  return (
    <svg
      className={`size-3 flex-none text-fg-3 ${back ? "rotate-180" : ""}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}
