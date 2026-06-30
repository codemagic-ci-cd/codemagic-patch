// Increase-rollout modal for a rollout-only patch.
// Current % is read-only; the slider and number input stay in sync —
// the `data-rollout` group implemented as controlled state,
// with the slider clamped to ≥ current (`min` attribute
// instead of a JS clamp). Client validation: integer 1–100 and STRICTLY
// greater than current ("Rollout can only increase. Set to 100 to
// complete."). Sends `{ rollout_percentage }` ALONE via
// usePatchReleaseMetadata (never combined with `status`); the hook's
// invalidation refetches the release detail + its deployment history, so
// success here is toast + close. NOT optimistic (the worker job is async,
// optimistic vs async). `409 active-release-job` renders the
// blocking notice with a manual Retry — each press is a new mutate(), no
// auto-retry. Mounted only while a target release is set, so state and
// mutation errors reset on every open.

import { useId, useState } from "react";
import type { FormEvent, ReactNode } from "react";

import { usePatchReleaseMetadata } from "../../../api/hooks/releases";
import { classifyProblem, HttpProblemError } from "../../../api/problem";
import { Modal } from "../../../components/overlay/Modal";
import { useToast } from "../../../components/overlay/ToastProvider";
import type { ProblemBehavior } from "../../../api/problem";
import type { Release } from "../../../model/release";
import { buttonVariants } from "../../../components/ui/Button";
import { CALLOUT, CALLOUT_BLOCK, CALLOUT_TONE } from "../../../components/ui/callout";
import {
  FIELD,
  FIELD_ERR,
  FIELD_HINT,
  INPUT,
  INPUT_STATE,
  SLIDER,
} from "../../../components/ui/form";
import {
  ROLLOUT,
  ROLLOUT_FILL,
  ROLLOUT_FILL_FULL,
  ROLLOUT_TRACK,
} from "../../../components/ui/RolloutBar";
import {
  SUMMARY,
  SUMMARY_ARROW,
  SUMMARY_KEY,
  SUMMARY_ROW,
  SUMMARY_VALUE,
} from "../../../components/ui/summary";

export interface RolloutModalProps {
  /** Target release; null keeps the modal unmounted (closed). */
  release: Release | null;
  onClose: () => void;
}

export function RolloutModal({ release, onClose }: RolloutModalProps) {
  // Unmounted while closed: form + mutation state reset for free on reopen,
  // and no hooks run when the modal is idle.
  if (release === null) {
    return null;
  }
  return <RolloutModalContent release={release} onClose={onClose} />;
}

function RolloutModalContent({
  release,
  onClose,
}: {
  release: Release;
  onClose: () => void;
}) {
  const patchMutation = usePatchReleaseMetadata();
  const toast = useToast();
  const hintId = useId();

  const current = release.rolloutPercentage;
  // Single source of truth for both controls: the number input's raw text.
  // The slider renders/parses through it, so the two can never diverge.
  const [text, setText] = useState(String(current));

  const busy = patchMutation.isPending;
  const parsed = parseWholePercent(text);
  const valid = parsed !== null && parsed > current;
  // Slider position: clamp into its [current, 100] range while the number
  // input holds an out-of-range/partial value.
  const sliderValue = parsed === null ? current : Math.max(current, parsed);

  const validationMessage =
    parsed === null
      ? "Enter a whole number between 1 and 100."
      : parsed > current
        ? null
        : "Rollout can only increase. Set to 100 to complete.";

  const submit = () => {
    if (busy || parsed === null || !valid) {
      return;
    }
    patchMutation.mutate(
      // The rollout patch carries `rollout_percentage` ALONE.
      { releaseId: release.id, body: { rollout_percentage: parsed } },
      {
        onSuccess: () => {
          toast.success(`Rollout for ${release.releaseLabel} set to ${parsed}%`, {
            description:
              "Worker job queued — the release reconciles via refetch.",
          });
          onClose();
        },
      },
    );
  };

  const requestClose = () => {
    if (!busy) {
      onClose();
    }
  };

  const behavior = problemBehavior(patchMutation.error);

  return (
    <Modal
      open
      onClose={requestClose}
      title="Increase rollout"
      description="Rollout can only increase. Set to 100 to complete."
      icon={<TrendUpIcon />}
      footer={
        <>
          <button
            type="button"
            className={buttonVariants({ intent: "subtle" })}
            onClick={requestClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className={buttonVariants({ intent: "primary" })}
            onClick={submit}
            disabled={busy || !valid}
            aria-busy={busy || undefined}
          >
            {busy ? <span className="spinner sm" aria-hidden="true" /> : null}
            {behavior === "blocking-job" ? "Retry" : "Update rollout"}
          </button>
        </>
      }
    >
      <form
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          submit();
        }}
      >
        {/* marginBottom:0 OVERRIDES FIELD's mb-4; conflicting utilities cannot
            co-apply, so the override stays inline. */}
        <div className={FIELD} style={{ marginBottom: 0 }}>
          <div className="mb-[18px] flex items-center justify-between gap-3.5">
            <span className="text-fg-3">
              Current: <b className="text-fg">{current}%</b>
            </span>
            <span className="flex items-center gap-[7px]">
              <input
                className={`${INPUT} ${INPUT_STATE.normal} text-right tabular-nums`}
                // width:86 OVERRIDES INPUT's w-full; conflicting utilities
                // cannot co-apply, so the fixed width stays inline.
                style={{ width: 86 }}
                inputMode="numeric"
                value={text}
                onChange={(event) => setText(event.currentTarget.value)}
                disabled={busy}
                aria-label="New rollout percentage"
                aria-invalid={validationMessage !== null || undefined}
                aria-describedby={hintId}
              />
              <b className="text-[16px]">%</b>
            </span>
          </div>
          <input
            type="range"
            className={SLIDER}
            min={current}
            max={100}
            step={1}
            value={sliderValue}
            disabled={busy}
            aria-label="New rollout percentage slider"
            onChange={(event) => setText(event.currentTarget.value)}
          />
          <div className={`${ROLLOUT} mt-[18px]`} aria-hidden="true">
            <div className={ROLLOUT_TRACK}>
              <div
                className={
                  sliderValue >= 100 ? ROLLOUT_FILL_FULL : ROLLOUT_FILL
                }
                style={{ width: `${sliderValue}%` }}
              />
            </div>
          </div>
          {validationMessage !== null ? (
            parsed === current ? (
              // Pristine state (the slider opens AT current): neutral nudge,
              // not an error — the canonical copy already heads the modal.
              <span id={hintId} className={`${FIELD_HINT} block`}>
                Pick a value above {current}%.
              </span>
            ) : (
              <span id={hintId} className={FIELD_ERR}>
                <AlertIcon />
                {validationMessage}
              </span>
            )
          ) : null}
        </div>
        <div className={SUMMARY}>
          <div className={SUMMARY_ROW}>
            <span className={SUMMARY_KEY}>Rollout</span>
            <span className={SUMMARY_VALUE}>
              {current}% <span className={SUMMARY_ARROW}>→</span>{" "}
              {valid && parsed !== null ? `${parsed}%` : "—"}
            </span>
          </div>
        </div>
        <div className={`${CALLOUT} ${CALLOUT_TONE.warn}`}>
          <InfoIcon />
          <div>
            Decreasing is not allowed — the server also rejects it (
            <code>400</code>).
          </div>
        </div>
        {patchMutation.isError ? (
          <div className={`${CALLOUT} ${CALLOUT_TONE.danger} ${CALLOUT_BLOCK} mt-[18px]`} role="alert">
            <AlertIcon />
            <div>
              {behavior === "blocking-job" ? (
                <BlockingJobNotice />
              ) : (
                describeProblem(patchMutation.error)
              )}
            </div>
          </div>
        ) : null}
      </form>
    </Modal>
  );
}

/** Strict integer 1–100 (anything else, including partial input, is null). */
function parseWholePercent(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,3}$/.test(trimmed)) {
    return null;
  }
  const value = Number.parseInt(trimmed, 10);
  return value >= 1 && value <= 100 ? value : null;
}

// --- Problem presentation helpers (file-local per house convention) ---------

function problemBehavior(error: unknown): ProblemBehavior | null {
  return error instanceof HttpProblemError ? classifyProblem(error) : null;
}

function describeProblem(error: unknown): string {
  if (error instanceof HttpProblemError) {
    return error.detail ?? error.title ?? "The request couldn't be completed.";
  }
  return "The request couldn't be completed. Check your connection and try again.";
}

/** `active-release-job` error: blocking notice + Retry. */
function BlockingJobNotice() {
  return (
    <>
      <b>Another release job is in progress.</b> Wait for the active job to
      finish, then press Retry.
    </>
  );
}

// Icon paths use lucide-style glyphs (`trendUp`, `info`, `alert`).

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

function TrendUpIcon() {
  return (
    <IconSvg>
      <polyline points="3 17 9 11 13 15 21 7" />
      <polyline points="15 7 21 7 21 13" />
    </IconSvg>
  );
}

function InfoIcon() {
  return (
    <IconSvg>
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16" />
      <line x1="12" y1="8" x2="12" y2="8" />
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
