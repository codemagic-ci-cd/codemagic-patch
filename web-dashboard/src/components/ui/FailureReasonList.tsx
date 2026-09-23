// Failure-reason breakdown rows (Update outcomes card, release MetricsPanel).
// Derivation via model/metrics.ts failureReasonShares — no math re-derived
// here. Renders nothing when no failures were reported, so callers only gate
// their own heading/divider chrome.
//
// A reason row is a coarse bucket ("Network error, 78"). Clicking one opens
// FailureDetailDialog, which drills into the `payload.code` breakdown defined
// by PROTOCOL.md §Metric Event `Failed` Payload. The drill-down lives in a
// dialog rather than inline because it is two levels deep and pages on scroll:
// nesting that inside a summary card would push the rest of the card off
// screen every time a reader glanced at one reason.
//
// Only reasons that actually reported detail are clickable. A reason every
// device reported without a payload has nothing behind it, and a row that
// opens a dialog saying so is worse than a row that does not invite the click.

import { formatCount } from "../../model/format";
import { failureReasonShares } from "../../model/metrics";
import type { ReleaseMetrics } from "../../model/metrics";
import { ROLLOUT, ROLLOUT_TRACK } from "./RolloutBar";

export function FailureReasonList({
  metrics,
  onOpenReason,
  showShareBar = true,
}: {
  metrics: ReleaseMetrics;
  /** Opens the drill-down dialog for one reason. */
  onOpenReason?: (reason: string) => void;
  /** Share bar under each reason. Off on release detail. */
  showShareBar?: boolean;
}) {
  const shares = failureReasonShares(metrics);

  if (shares.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-3">
      {shares.map((share) => {
        const clickable = onOpenReason !== undefined && share.hasDetail;

        const summary = (
          <>
            <div
              className={`flex items-center justify-between gap-3.5 text-[12.5px] ${showShareBar ? "mb-[5px]" : ""}`}
            >
              <span className="flex items-center gap-1.5 text-fg-2">
                {clickable ? <Chevron /> : null}
                {share.label}
              </span>
              <span className="mono text-red">
                {formatCount(share.count)} · {(share.share * 100).toFixed(1)}%
              </span>
            </div>
            {showShareBar ? (
              <div className={ROLLOUT}>
                <div
                  className={ROLLOUT_TRACK}
                  role="progressbar"
                  aria-label={`${share.label} share of failures`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(share.share * 100)}
                  aria-valuetext={`${(share.share * 100).toFixed(1)}%`}
                >
                  <div
                    className="h-full rounded-pill bg-red"
                    style={{ width: `${share.share * 100}%` }}
                  />
                </div>
              </div>
            ) : null}
          </>
        );

        if (!clickable) {
          return <div key={share.reason}>{summary}</div>;
        }

        return (
          <button
            key={share.reason}
            type="button"
            // The row must read as a row, not a control: base.css resets only
            // font and cursor on <button>, so the UA background and padding
            // have to go explicitly.
            className="block w-full bg-transparent p-0 text-left"
            onClick={() => {
              onOpenReason?.(share.reason);
            }}
          >
            {summary}
          </button>
        );
      })}
    </div>
  );
}

function Chevron() {
  return (
    <svg
      className="size-3 flex-none text-fg-3"
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
