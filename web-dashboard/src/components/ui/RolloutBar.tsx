// Rollout percentage bar (release rows). Visual contract: the `.rollout`
// markup — track + fill (full-green gradient at 100%) + the mono numeric
// label, ported to utility literals. The literals are exported because
// MetricsPage, ReleaseDetailPage and RolloutModal render bespoke track/fill
// geometry (custom height, slider echo) that a fixed component can't carry.
// A11y: the track is a `role="progressbar"` carrying aria-valuenow; the
// visible `%` label is aria-hidden so the value is announced exactly once.

export const ROLLOUT = "flex min-w-[130px] items-center gap-2.5";

export const ROLLOUT_TRACK =
  "h-[7px] flex-1 overflow-hidden rounded-pill bg-surface-3";

export const ROLLOUT_FILL =
  "h-full rounded-pill bg-[linear-gradient(90deg,var(--color-blue),var(--color-aqua))]";

/** 100%-rollout fill (legacy `.rollout__fill.full`) — swaps the gradient. */
export const ROLLOUT_FILL_FULL =
  "h-full rounded-pill bg-[linear-gradient(90deg,var(--color-green),#34d399)]";

export interface RolloutBarProps {
  /** Rollout percentage; clamped to 0–100 and rounded for display. */
  percentage: number;
  /** Accessible name for the progressbar. */
  ariaLabel?: string;
}

export function RolloutBar({
  percentage,
  ariaLabel = "Rollout percentage",
}: RolloutBarProps) {
  const pct = Math.min(100, Math.max(0, Math.round(percentage)));
  return (
    <div className={ROLLOUT}>
      <div
        className={ROLLOUT_TRACK}
        role="progressbar"
        aria-label={ariaLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={`${pct}%`}
      >
        <div
          className={pct >= 100 ? ROLLOUT_FILL_FULL : ROLLOUT_FILL}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span
        className="min-w-[38px] text-right font-mono text-[12px] font-semibold text-fg-2"
        aria-hidden="true"
      >
        {pct}%
      </span>
    </div>
  );
}
