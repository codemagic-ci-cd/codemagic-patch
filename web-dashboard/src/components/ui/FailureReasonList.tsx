// Failure-reason breakdown rows (Install outcomes card, release
// MetricsPanel). Derivation via model/metrics.ts failureReasonShares — no
// math re-derived here. Renders nothing when no failures were reported, so
// callers only gate their own heading/divider chrome.

import { formatCount } from "../../model/format";
import { failureReasonShares } from "../../model/metrics";
import type { ReleaseMetrics } from "../../model/metrics";
import { ROLLOUT, ROLLOUT_TRACK } from "./RolloutBar";

export function FailureReasonList({ metrics }: { metrics: ReleaseMetrics }) {
  const shares = failureReasonShares(metrics);

  if (shares.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-3">
      {shares.map((share) => (
        <div key={share.reason}>
          <div className="mb-[5px] flex items-center justify-between gap-3.5 text-[12.5px]">
            <span className="text-fg-2">{share.label}</span>
            <span className="mono text-fg-2">
              {formatCount(share.count)} · {(share.share * 100).toFixed(1)}%
            </span>
          </div>
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
        </div>
      ))}
    </div>
  );
}
