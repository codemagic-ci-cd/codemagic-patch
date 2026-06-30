// Rollback modal. Radio choice between
// "Previous release (default)" — the release immediately before the latest,
// body omits the label — and a label picker built from the deployment's
// loaded history (useReleases with the SAME `includeMetrics: true` params as
// the deployment-detail table, so this is a cache read, not a second fetch)
// EXCLUDING disabled releases and the current latest. A read-only summary
// previews the inherited fields of the selected target (target binary
// version / mandatory / notes) with rollout FORCED to 100. Submits via
// useRollbackDeployment, sending `target_release_label` only when a label is
// picked; the hook stamps a fresh Idempotency-Key per mutate() (each Retry
// press is a new submission — no auto-retry). The "nothing to roll back to"
// case is guarded upstream by the ≥2-published gate (model/release.ts
// canRollback) before this modal can open.
// Error rows: `409 rollback-no-op` → "Target content already live."; `404`
// (rollback-target-not-found) → inline refresh-and-repick message; `409
// active-release-job` → blocking notice + Retry. NOT optimistic; the hook's
// invalidation refetches the deployment history. Mounted only while open so
// state resets per open.

import { useId, useState } from "react";
import type { FormEvent, ReactNode } from "react";

import { useReleases, useRollbackDeployment } from "../../../api/hooks/releases";
import { classifyProblem, HttpProblemError } from "../../../api/problem";
import { Modal } from "../../../components/overlay/Modal";
import { useToast } from "../../../components/overlay/ToastProvider";
import { Skeleton } from "../../../components/ui/Skeleton";
import type { ProblemBehavior } from "../../../api/problem";
import type { Release } from "../../../model/release";
import { buttonVariants } from "../../../components/ui/Button";
import { CALLOUT, CALLOUT_BLOCK, CALLOUT_TONE } from "../../../components/ui/callout";
import {
  INPUT,
  INPUT_STATE,
  RADIO_CARD,
  RADIO_CARD_STATE,
  RC_DESC,
  RC_TITLE,
  SELECT_EXTRA,
} from "../../../components/ui/form";
import {
  SUMMARY,
  SUMMARY_KEY,
  SUMMARY_ROW,
  SUMMARY_VALUE,
} from "../../../components/ui/summary";

export interface RollbackModalProps {
  open: boolean;
  /** Deployment whose history is rolled back. */
  deploymentId: string;
  /** Display name for the title/toast (falls back to "deployment"). */
  deploymentName?: string;
  onClose: () => void;
}

export function RollbackModal({
  open,
  deploymentId,
  deploymentName,
  onClose,
}: RollbackModalProps) {
  // Unmounted while closed: picker + mutation state reset for free on
  // reopen, and the releases query only reads cache while actually open.
  if (!open) {
    return null;
  }
  return (
    <RollbackModalContent
      deploymentId={deploymentId}
      deploymentName={deploymentName}
      onClose={onClose}
    />
  );
}

function RollbackModalContent({
  deploymentId,
  deploymentName,
  onClose,
}: {
  deploymentId: string;
  deploymentName?: string;
  onClose: () => void;
}) {
  // Same params as the deployment-detail history table → shared cache entry.
  const releasesQuery = useReleases(deploymentId, { includeMetrics: true });
  const rollbackMutation = useRollbackDeployment();
  const toast = useToast();
  const radioName = useId();

  const [mode, setMode] = useState<"previous" | "label">("previous");
  const [chosenLabel, setChosenLabel] = useState("");

  const rows = releasesQuery.data?.pages.flatMap((page) => page.releases) ?? [];
  const latest = rows[0]?.release ?? null;
  // Default target: the release immediately before the latest.
  const previous = rows[1]?.release ?? null;
  // Picker pool: loaded history EXCLUDING disabled + the current latest.
  const options = rows
    .map((item) => item.release)
    .filter(
      (candidate) =>
        candidate.status !== "disabled" &&
        (latest === null || candidate.id !== latest.id),
    );
  const effectiveLabel =
    chosenLabel !== "" ? chosenLabel : (options[0]?.releaseLabel ?? "");
  const target: Release | null =
    mode === "previous"
      ? previous
      : (options.find((candidate) => candidate.releaseLabel === effectiveLabel) ??
        null);

  const busy = rollbackMutation.isPending;
  const valid = mode === "previous" ? previous !== null : effectiveLabel !== "";

  const submit = () => {
    if (busy || !valid) {
      return;
    }
    rollbackMutation.mutate(
      {
        deploymentId,
        // The label rides along ONLY when explicitly picked — the
        // default body is empty and the server resolves "previous".
        ...(mode === "label" ? { targetReleaseLabel: effectiveLabel } : {}),
      },
      {
        onSuccess: (data) => {
          toast.success(
            `Rollback queued for ${deploymentName ?? "deployment"}`,
            {
              description: `${data.release.releaseLabel} created at 100% rollout — history refreshes as the job runs.`,
            },
          );
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

  const behavior = problemBehavior(rollbackMutation.error);

  let errorMessage: ReactNode = null;
  if (rollbackMutation.isError) {
    const error = rollbackMutation.error;
    if (behavior === "blocking-job") {
      errorMessage = <BlockingJobNotice />;
    } else if (behavior === "rollback-no-op") {
      errorMessage = (
        <>
          <b>Target content already live.</b> The chosen release matches what
          clients already receive — there is nothing to roll back.
        </>
      );
    } else if (error instanceof HttpProblemError && error.status === 404) {
      // `rollback-target-not-found` (and any plain not-found): the picked
      // label vanished between load and submit.
      errorMessage =
        "Rollback target not found — the chosen label no longer exists. Refresh the history and pick again.";
    } else {
      errorMessage = describeProblem(error);
    }
  }

  return (
    <Modal
      open
      onClose={requestClose}
      title={`Rollback ${deploymentName ?? "deployment"}`}
      description="Republishes a previous release as a new release at 100%."
      icon={<RollbackIcon />}
      tone="warn"
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
            {behavior === "blocking-job" ? "Retry" : "Roll back"}
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
        {releasesQuery.isPending ? (
          <div role="status" aria-label="Loading release history">
            <Skeleton variant="line" />
            <Skeleton variant="line" />
          </div>
        ) : releasesQuery.isError ? (
          <div className={`${CALLOUT} ${CALLOUT_TONE.warn}`} role="alert">
            <AlertIcon />
            <div>
              Couldn't load the release history.{" "}
              <button
                type="button"
                className={buttonVariants({ intent: "ghost", size: "sm" })}
                onClick={() => {
                  void releasesQuery.refetch();
                }}
              >
                Retry
              </button>
            </div>
          </div>
        ) : (
          <>
            <label
              className={`${RADIO_CARD} ${mode === "previous" ? RADIO_CARD_STATE.sel : RADIO_CARD_STATE.idle}`}
            >
              <input
                type="radio"
                name={radioName}
                checked={mode === "previous"}
                disabled={busy}
                onChange={() => setMode("previous")}
              />
              <div>
                <div className={RC_TITLE}>Previous release (default)</div>
                <div className={RC_DESC}>
                  {previous !== null
                    ? `${previous.releaseLabel} — the release immediately before the latest.`
                    : "The release immediately before the latest."}
                </div>
              </div>
            </label>
            <label
              className={`${RADIO_CARD} ${mode === "label" ? RADIO_CARD_STATE.sel : RADIO_CARD_STATE.idle} mt-2.5`}
            >
              <input
                type="radio"
                name={radioName}
                checked={mode === "label"}
                disabled={busy || options.length === 0}
                onChange={() => setMode("label")}
              />
              <div className="flex-1">
                <div className={RC_TITLE}>Choose a label</div>
                <div className={RC_DESC}>
                  {options.length === 0 ? (
                    "No eligible releases — disabled releases and the current latest are excluded."
                  ) : (
                    <select
                      className={`${INPUT} ${INPUT_STATE.normal} ${SELECT_EXTRA} select mt-2.5 max-w-[220px]`}
                      value={effectiveLabel}
                      disabled={busy || mode !== "label"}
                      aria-label="Rollback target release"
                      onChange={(event) =>
                        setChosenLabel(event.currentTarget.value)
                      }
                    >
                      {options.map((candidate) => (
                        <option key={candidate.id} value={candidate.releaseLabel}>
                          {candidate.releaseLabel}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
            </label>
            {/* Read-only preview of the inherited fields — rollout is
                always forced to 100 regardless of the target's value. */}
            <div className={SUMMARY}>
              <div className={SUMMARY_ROW}>
                <span className={SUMMARY_KEY}>Target</span>
                <span className={SUMMARY_VALUE}>{target?.releaseLabel ?? "—"}</span>
              </div>
              <div className={SUMMARY_ROW}>
                <span className={SUMMARY_KEY}>Rollout</span>
                <span className={SUMMARY_VALUE}>forced to 100%</span>
              </div>
              <div className={SUMMARY_ROW}>
                <span className={SUMMARY_KEY}>Target binary</span>
                <span className={SUMMARY_VALUE}>
                  {target !== null ? (
                    <code className="mono">{target.targetBinaryVersion}</code>
                  ) : (
                    "—"
                  )}
                </span>
              </div>
              <div className={SUMMARY_ROW}>
                <span className={SUMMARY_KEY}>Mandatory</span>
                <span className={SUMMARY_VALUE}>
                  {target !== null ? (target.isMandatory ? "Yes" : "No") : "—"}
                </span>
              </div>
              <div className={SUMMARY_ROW}>
                <span className={SUMMARY_KEY}>Notes</span>
                <span className={SUMMARY_VALUE}>
                  {target !== null
                    ? target.releaseNotes === null
                      ? "None"
                      : truncate(target.releaseNotes, 60)
                    : "—"}
                </span>
              </div>
            </div>
          </>
        )}
        {errorMessage !== null ? (
          <div className={`${CALLOUT} ${CALLOUT_TONE.danger} ${CALLOUT_BLOCK} mt-[18px]`} role="alert">
            <AlertIcon />
            <div>{errorMessage}</div>
          </div>
        ) : null}
      </form>
    </Modal>
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
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

// Icon paths use lucide-style glyphs (`rollback`, `alert`).

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

function RollbackIcon() {
  return (
    <IconSvg>
      <polyline points="9 14 4 9 9 4" />
      <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
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
