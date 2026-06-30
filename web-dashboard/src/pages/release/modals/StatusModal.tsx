// Disable/Enable confirmation modal. One
// component, two variants driven by the target's CURRENT status: `published`
// → offer Disable, `disabled` → offer Enable (the callers only surface the
// legal one via model/release.ts canDisable/canEnable, but the variant is
// derived here so the summary can never contradict the data). Tier-1
// confirmation = ConfirmDialog `variant="summary"` with the explicit
// status-transition row (the UI's `--yes` equivalent). Sends `{ status }`
// ALONE via usePatchReleaseStatus — combining it with edits would 400
// `status-transition-conflict`, which the split RolloutModal/
// EditMetadataModal flows prevent by design. NOT optimistic (worker job is
// async; the hook's invalidation reconciles via refetch). `409
// active-release-job` lands in the ConfirmDialog blocking error slot with a
// manual Retry (new mutate per press; no auto-retry). Mounted only while a
// target release is set so mutation state resets per open.

import type { ReactNode } from "react";

import { usePatchReleaseStatus } from "../../../api/hooks/releases";
import { classifyProblem, HttpProblemError } from "../../../api/problem";
import { ConfirmDialog } from "../../../components/overlay/ConfirmDialog";
import { useToast } from "../../../components/overlay/ToastProvider";
import type { ProblemBehavior } from "../../../api/problem";
import type { Release } from "../../../model/release";
import { CALLOUT, CALLOUT_TONE } from "../../../components/ui/callout";
import { SUMMARY_ARROW } from "../../../components/ui/summary";

export interface StatusModalProps {
  /** Target release; null keeps the modal unmounted (closed). */
  release: Release | null;
  onClose: () => void;
}

export function StatusModal({ release, onClose }: StatusModalProps) {
  // Unmounted while closed: mutation/error state resets for free on reopen.
  if (release === null) {
    return null;
  }
  return <StatusModalContent release={release} onClose={onClose} />;
}

function StatusModalContent({
  release,
  onClose,
}: {
  release: Release;
  onClose: () => void;
}) {
  const statusMutation = usePatchReleaseStatus();
  const toast = useToast();

  // Variant from the current status: only `disabled` re-enables; every
  // other (gated) entry point is the published → disabled direction.
  const variant: "disable" | "enable" =
    release.status === "disabled" ? "enable" : "disable";
  const label = release.releaseLabel;

  const busy = statusMutation.isPending;
  const behavior = problemBehavior(statusMutation.error);

  const confirm = () => {
    if (busy) {
      return;
    }
    statusMutation.mutate(
      // `{ status }` is sent ALONE (the hook's body is exactly that field).
      {
        releaseId: release.id,
        status: variant === "disable" ? "disabled" : "published",
      },
      {
        onSuccess: () => {
          toast.success(
            variant === "disable"
              ? `Release ${label} disabled`
              : `Release ${label} enabled`,
            { description: "Worker job queued — status reconciles shortly." },
          );
          onClose();
        },
      },
    );
  };

  return (
    <ConfirmDialog
      open
      variant="summary"
      onCancel={onClose}
      onConfirm={confirm}
      title={variant === "disable" ? "Disable release" : "Enable release"}
      description={
        variant === "disable"
          ? `Clients stop receiving ${label}.`
          : `Resume serving ${label} to clients.`
      }
      icon={variant === "disable" ? <PauseIcon /> : <PlayIcon />}
      confirmLabel={
        behavior === "blocking-job"
          ? "Retry"
          : variant === "disable"
            ? "Disable release"
            : "Enable release"
      }
      busy={busy}
      error={
        statusMutation.isError ? (
          behavior === "blocking-job" ? (
            <BlockingJobNotice />
          ) : (
            describeProblem(statusMutation.error)
          )
        ) : undefined
      }
      summary={[
        { label: "Release", value: label },
        {
          label: "Status",
          value:
            variant === "disable" ? (
              <>
                Published <span className={SUMMARY_ARROW}>→</span> Disabled
              </>
            ) : (
              <>
                Disabled <span className={SUMMARY_ARROW}>→</span> Published
              </>
            ),
        },
      ]}
    >
      {variant === "disable" ? (
        <div className={`${CALLOUT} ${CALLOUT_TONE.info}`}>
          <InfoIcon />
          <div>
            Previously healthy manifests remain authoritative for clients
            already updated.
          </div>
        </div>
      ) : null}
    </ConfirmDialog>
  );
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

// Icon paths use lucide-style glyphs (`pause`, `play`, `info`).

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

function PauseIcon() {
  return (
    <IconSvg>
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </IconSvg>
  );
}

function PlayIcon() {
  return (
    <IconSvg>
      <polygon points="7 5 19 12 7 19 7 5" />
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
