// Edit-metadata modal for non-rollout metadata. Form for
// the three fields outside the rollout flow: mandatory toggle, release
// notes textarea, target binary version input. The PATCH body carries ONLY
// the fields that actually changed against the opened release — and never
// `status` (type-enforced: usePatchReleaseMetadata's ReleaseMetadataPatch
// omits it, keeping the exclusive `{ status }` flow separate so
// `status-transition-conflict` is prevented by design). The mandatory toggle
// inside this open modal is plain form state — nothing is optimistic here
// (the worker job is async; the hook's invalidation reconciles via refetch).
// A quick mandatory toggle OUTSIDE a modal would need
// optimistic-flip-with-rollback — no such control exists yet, so that
// contract lives with whichever screen adds one. `409 active-release-job` →
// blocking notice + manual Retry (new mutate per press; no auto-retry);
// `400 validation-error` surfaces `errors[]` inline. Mounted only while a
// target release is set so form/mutation state resets per open.

import { useState } from "react";
import type { FormEvent, ReactNode } from "react";

import { usePatchReleaseMetadata } from "../../../api/hooks/releases";
import { classifyProblem, HttpProblemError } from "../../../api/problem";
import { Modal } from "../../../components/overlay/Modal";
import { useToast } from "../../../components/overlay/ToastProvider";
import type { ReleaseMetadataPatch } from "../../../api/hooks/releases";
import type { ProblemBehavior } from "../../../api/problem";
import type { Release } from "../../../model/release";
import { buttonVariants } from "../../../components/ui/Button";
import { CALLOUT, CALLOUT_BLOCK, CALLOUT_TONE } from "../../../components/ui/callout";
import {
  FIELD,
  FIELD_ERR,
  FIELD_HINT,
  FIELD_LABEL,
  INPUT,
  INPUT_STATE,
  TEXTAREA_EXTRA,
} from "../../../components/ui/form";

export interface EditMetadataModalProps {
  /** Release being edited; null keeps the modal unmounted (closed). */
  release: Release | null;
  onClose: () => void;
}

export function EditMetadataModal({ release, onClose }: EditMetadataModalProps) {
  // Unmounted while closed: form + mutation state reset for free on reopen.
  if (release === null) {
    return null;
  }
  return <EditMetadataModalContent release={release} onClose={onClose} />;
}

function EditMetadataModalContent({
  release,
  onClose,
}: {
  release: Release;
  onClose: () => void;
}) {
  const patchMutation = usePatchReleaseMetadata();
  const toast = useToast();

  const [mandatory, setMandatory] = useState(release.isMandatory);
  const [notes, setNotes] = useState(release.releaseNotes ?? "");
  const [targetVersion, setTargetVersion] = useState(release.targetBinaryVersion);

  const busy = patchMutation.isPending;

  // Changed-fields-only body: untouched fields are OMITTED so the
  // server never sees a spurious write; an empty textarea maps to null.
  const trimmedTarget = targetVersion.trim();
  const normalizedNotes = notes.trim().length === 0 ? null : notes;
  const changes: ReleaseMetadataPatch = {
    ...(mandatory !== release.isMandatory ? { is_mandatory: mandatory } : {}),
    ...(normalizedNotes !== release.releaseNotes
      ? { release_notes: normalizedNotes }
      : {}),
    ...(trimmedTarget !== release.targetBinaryVersion
      ? { target_binary_version: trimmedTarget }
      : {}),
  };
  const hasChanges = Object.keys(changes).length > 0;
  const targetInvalid = trimmedTarget.length === 0;

  const submit = () => {
    if (busy || !hasChanges || targetInvalid) {
      return;
    }
    patchMutation.mutate(
      { releaseId: release.id, body: changes },
      {
        onSuccess: () => {
          toast.success(`Release ${release.releaseLabel} updated`, {
            description: "Worker job queued — changes reconcile shortly.",
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
      title="Edit metadata"
      description={`Mandatory, notes, and target binary version for ${release.releaseLabel} — only changed fields are sent.`}
      icon={<PencilIcon />}
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
            disabled={busy || !hasChanges || targetInvalid}
            aria-busy={busy || undefined}
          >
            {busy ? <span className="spinner sm" aria-hidden="true" /> : null}
            {behavior === "blocking-job" ? "Retry" : "Save changes"}
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
        <div className={FIELD}>
          <span className={FIELD_LABEL}>Mandatory</span>
          {/* Legacy `.field>label` (== `.field-label`) won on specificity over
              `.toggle` for this direct-child toggle label, so it carried the
              field-label box wholesale: display:block (which un-flexes the row →
              the `.track` <span> collapses to the bare thumb) + the 13px/600/
              text color + a 7px bottom margin. Reproduce it verbatim. */}
          <label
            className="toggle mb-[7px] mt-0.5 block text-[13px] font-semibold text-fg"
          >
            <input
              type="checkbox"
              checked={mandatory}
              disabled={busy}
              onChange={(event) => setMandatory(event.currentTarget.checked)}
            />
            <span className="track" /> Clients must install this update
          </label>
        </div>
        <label className={FIELD}>
          <span className={FIELD_LABEL}>Release notes</span>
          <textarea
            className={`${INPUT} ${INPUT_STATE.normal} ${TEXTAREA_EXTRA}`}
            rows={4}
            value={notes}
            disabled={busy}
            placeholder="What changed in this release?"
            onChange={(event) => setNotes(event.currentTarget.value)}
          />
          <span className={FIELD_HINT}>Leave empty to clear the notes.</span>
        </label>
        <label className={FIELD}>
          <span className={FIELD_LABEL}>Target binary version</span>
          <input
            className={`${INPUT} ${targetInvalid ? INPUT_STATE.invalid : INPUT_STATE.normal} font-mono`}
            value={targetVersion}
            disabled={busy}
            onChange={(event) => setTargetVersion(event.currentTarget.value)}
            aria-invalid={targetInvalid || undefined}
          />
          {targetInvalid ? (
            <span className={FIELD_ERR} role="alert">
              <AlertIcon />
              Enter a target binary version.
            </span>
          ) : (
            <span className={FIELD_HINT}>
              Exact binary version this release targets, e.g.{" "}
              <code>1.0.0</code>.
            </span>
          )}
        </label>
        {patchMutation.isError ? (
          <div className={`${CALLOUT} ${CALLOUT_TONE.danger} ${CALLOUT_BLOCK}`} role="alert">
            <AlertIcon />
            <div>
              {behavior === "blocking-job" ? (
                <BlockingJobNotice />
              ) : (
                <>
                  {describeProblem(patchMutation.error)}
                  {patchMutation.error instanceof HttpProblemError &&
                  patchMutation.error.errors !== undefined ? (
                    <ul className="mt-1.5 mb-0 mx-0 pl-[18px]">
                      {patchMutation.error.errors.map((fieldError) => (
                        <li key={`${fieldError.field}:${fieldError.reason}`}>
                          <code>{fieldError.field}</code>: {fieldError.message}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </>
              )}
            </div>
          </div>
        ) : null}
      </form>
    </Modal>
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

// Icon paths: `pencil` (lucide-style, local), `alert`.

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

function PencilIcon() {
  return (
    <IconSvg>
      <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
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
