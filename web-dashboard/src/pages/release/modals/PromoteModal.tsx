// Promote modal. Destination select comes
// from useDeployments(appId) EXCLUDING the source deployment; Rollout
// defaults to 100 with the "not inherited" hint (the destination rollout
// is NOT copied from the source). Mandatory / release notes / target binary
// version each carry an inherit/override toggle — un-overridden fields are
// OMITTED from the body so the server inherits the source values; "Create as
// disabled" maps to `disabled: true`. Submission goes through
// usePromoteRelease, whose mutationFn calls createIdempotencyKey() per
// mutate() — every press (Promote / Promote anyway / Retry) is a NEW
// submission with a fresh Idempotency-Key (shared hooks convention; reusing a key
// with the changed `no_duplicate_release_error` body would 422
// idempotency-mismatch).
// Error paths (error catalog): `409 duplicate-release` → inline notice
// with a "Promote anyway" button that resubmits the same form body plus
// `no_duplicate_release_error: true`; `409 release-conflict` → "An active
// rollout blocks this" deep-linking to the offending release when the
// problem extensions carry an id, else to the destination deployment; `400`
// (signature-required / validation) surfaced inline with `errors[]`; `409
// active-release-job` → blocking notice + manual Retry (no auto-retry).
// Success: toast + NAVIGATE to the new release detail route — ToastProvider
// mounts outside RouterProvider (locked App.tsx contract), so toasts cannot
// embed router Links; opening the new release directly is the equivalent of
// "success toast links to the new release". Mounted only while a
// source release is set so form/mutation state resets per open.

import { useState } from "react";
import { Link, useNavigate } from "react-router";
import type { FormEvent, ReactNode } from "react";

import { useDeployments } from "../../../api/hooks/deployments";
import { usePromoteRelease } from "../../../api/hooks/releases";
import { classifyProblem, HttpProblemError } from "../../../api/problem";
import { Modal } from "../../../components/overlay/Modal";
import { useToast } from "../../../components/overlay/ToastProvider";
import type { ReleasePromoteBody } from "../../../api/types";
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
  SELECT_EXTRA,
  TEXTAREA_EXTRA,
  TOGGLE,
  TOGGLE_INPUT,
  TOGGLE_TRACK,
} from "../../../components/ui/form";

export interface PromoteModalProps {
  /** Source release; null keeps the modal unmounted (closed). */
  release: Release | null;
  teamId: string;
  appId: string;
  onClose: () => void;
}

export function PromoteModal({ release, teamId, appId, onClose }: PromoteModalProps) {
  // Unmounted while closed: form + mutation state reset for free on reopen,
  // and the deployments query only runs while the modal is actually open.
  if (release === null) {
    return null;
  }
  return (
    <PromoteModalContent
      release={release}
      teamId={teamId}
      appId={appId}
      onClose={onClose}
    />
  );
}

function PromoteModalContent({
  release,
  teamId,
  appId,
  onClose,
}: {
  release: Release;
  teamId: string;
  appId: string;
  onClose: () => void;
}) {
  const deploymentsQuery = useDeployments(appId);
  const promoteMutation = usePromoteRelease();
  const toast = useToast();
  const navigate = useNavigate();

  const [destId, setDestId] = useState("");
  const [rolloutText, setRolloutText] = useState("100");
  const [overrideMandatory, setOverrideMandatory] = useState(false);
  const [mandatory, setMandatory] = useState(release.isMandatory);
  const [overrideNotes, setOverrideNotes] = useState(false);
  const [notes, setNotes] = useState(release.releaseNotes ?? "");
  const [overrideTarget, setOverrideTarget] = useState(false);
  const [targetVersion, setTargetVersion] = useState(release.targetBinaryVersion);
  const [createDisabled, setCreateDisabled] = useState(false);
  // Destination captured at submit time so the release-conflict deep-link
  // stays accurate even if the select changes after the error.
  const [submittedDestId, setSubmittedDestId] = useState<string | null>(null);

  // The source deployment is excluded — promote copies ACROSS deployments.
  const destinations = (deploymentsQuery.data ?? []).filter(
    (deployment) => deployment.id !== release.deploymentId,
  );
  const effectiveDestId = destId !== "" ? destId : (destinations[0]?.id ?? "");

  const busy = promoteMutation.isPending;
  const rollout = parseWholePercent(rolloutText);
  const targetInvalid = overrideTarget && targetVersion.trim().length === 0;
  const formValid =
    effectiveDestId !== "" && rollout !== null && !targetInvalid;

  const submit = (promoteAnyway: boolean) => {
    if (busy || !formValid || rollout === null) {
      return;
    }
    const body: ReleasePromoteBody = {
      destination_deployment_id: effectiveDestId,
      // Explicit even at the default — promote rollout is never inherited.
      rollout_percentage: rollout,
      ...(overrideMandatory ? { is_mandatory: mandatory } : {}),
      ...(overrideNotes
        ? { release_notes: notes.trim().length === 0 ? null : notes }
        : {}),
      ...(overrideTarget
        ? { target_binary_version: targetVersion.trim() }
        : {}),
      ...(createDisabled ? { disabled: true } : {}),
      // "Promote anyway": same body resubmitted with the bypass flag
      // as a NEW submission (fresh Idempotency-Key from the hook).
      ...(promoteAnyway ? { no_duplicate_release_error: true } : {}),
    };
    setSubmittedDestId(effectiveDestId);
    promoteMutation.mutate(
      { releaseId: release.id, body },
      {
        onSuccess: (data) => {
          const created = data.release;
          const destName =
            destinations.find((d) => d.id === effectiveDestId)?.name ??
            "destination";
          toast.success(
            `Promoted ${release.releaseLabel} to ${destName} as ${created.releaseLabel}`,
            {
              description:
                "Opening the new release — its worker job is queued.",
            },
          );
          onClose();
          // Route built from the created release's OWN scope fields.
          navigate(
            `/teams/${created.teamId}/apps/${created.appId}/deployments/${created.deploymentId}/releases/${created.id}`,
          );
        },
      },
    );
  };

  const requestClose = () => {
    if (!busy) {
      onClose();
    }
  };

  const behavior = problemBehavior(promoteMutation.error);

  let errorSlot: ReactNode = null;
  if (promoteMutation.isError) {
    const error = promoteMutation.error;
    if (behavior === "duplicate-release") {
      errorSlot = (
        <div className={`${CALLOUT} ${CALLOUT_TONE.warn} ${CALLOUT_BLOCK} mt-[18px]`} role="alert">
          <AlertIcon />
          <div>
            <b>The destination already has this content.</b> Promoting again
            records a duplicate release entry.
            <div className="mt-2.5">
              <button
                type="button"
                className={buttonVariants({ intent: "primary", size: "sm" })}
                disabled={busy}
                onClick={() => submit(true)}
              >
                Promote anyway
              </button>
            </div>
          </div>
        </div>
      );
    } else if (behavior === "release-conflict") {
      const conflictId = conflictReleaseIdFrom(error);
      const conflictRollout = conflictRolloutFrom(error);
      const destPath = `/teams/${teamId}/apps/${appId}/deployments/${submittedDestId ?? effectiveDestId}`;
      errorSlot = (
        <div className={`${CALLOUT} ${CALLOUT_TONE.danger} ${CALLOUT_BLOCK} mt-[18px]`} role="alert">
          <AlertIcon />
          <div>
            An active rollout blocks this
            {conflictRollout !== null ? ` (at ${conflictRollout}%)` : ""} —
            complete or disable it in the destination first.{" "}
            <Link
              to={
                conflictId !== null
                  ? `${destPath}/releases/${conflictId}`
                  : destPath
              }
              onClick={onClose}
              className="font-bold text-inherit underline"
            >
              {conflictId !== null
                ? "View the blocking release"
                : "Open the destination deployment"}
            </Link>
          </div>
        </div>
      );
    } else if (behavior === "blocking-job") {
      errorSlot = (
        <div className={`${CALLOUT} ${CALLOUT_TONE.danger} ${CALLOUT_BLOCK} mt-[18px]`} role="alert">
          <AlertIcon />
          <div>
            <BlockingJobNotice />
          </div>
        </div>
      );
    } else {
      // Includes the 400 signature-required path (destination app requires
      // code signing) — surfaced inline via the problem detail + errors[].
      errorSlot = (
        <div className={`${CALLOUT} ${CALLOUT_TONE.danger} ${CALLOUT_BLOCK} mt-[18px]`} role="alert">
          <AlertIcon />
          <div>
            {describeProblem(error)}
            {error instanceof HttpProblemError &&
            error.errors !== undefined ? (
              <ul className="mt-1.5 mb-0 mx-0 pl-[18px]">
                {error.errors.map((fieldError) => (
                  <li key={`${fieldError.field}:${fieldError.reason}`}>
                    <code>{fieldError.field}</code>: {fieldError.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      );
    }
  }

  return (
    <Modal
      open
      onClose={requestClose}
      title={`Promote ${release.releaseLabel}`}
      description="Copy this release into another deployment."
      icon={<RocketIcon />}
      wide
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
            onClick={() => submit(false)}
            disabled={busy || !formValid}
            aria-busy={busy || undefined}
          >
            {busy ? <span className="spinner sm" aria-hidden="true" /> : null}
            {behavior === "blocking-job" ? "Retry" : "Promote"}
          </button>
        </>
      }
    >
      <form
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          submit(false);
        }}
      >
        <label className={FIELD}>
          <span className={FIELD_LABEL}>Destination deployment</span>
          {deploymentsQuery.isPending ? (
            <select
              className={`${INPUT} ${INPUT_STATE.normal} ${SELECT_EXTRA} select`}
              disabled
              aria-label="Destination deployment"
            >
              <option>Loading deployments…</option>
            </select>
          ) : deploymentsQuery.isError ? (
            <div className={`${CALLOUT} ${CALLOUT_TONE.warn}`} role="alert">
              <AlertIcon />
              <div>
                Couldn't load deployments.{" "}
                <button
                  type="button"
                  className={buttonVariants({ intent: "ghost", size: "sm" })}
                  onClick={() => {
                    void deploymentsQuery.refetch();
                  }}
                >
                  Retry
                </button>
              </div>
            </div>
          ) : destinations.length === 0 ? (
            <div className={`${CALLOUT} ${CALLOUT_TONE.info}`}>
              <InfoIcon />
              <div>
                No other deployments in this app — create one to promote into.
              </div>
            </div>
          ) : (
            <select
              className={`${INPUT} ${INPUT_STATE.normal} ${SELECT_EXTRA} select`}
              value={effectiveDestId}
              disabled={busy}
              onChange={(event) => setDestId(event.currentTarget.value)}
            >
              {destinations.map((deployment) => (
                <option key={deployment.id} value={deployment.id}>
                  {deployment.name}
                </option>
              ))}
            </select>
          )}
        </label>

        <div className="grid-cols-[repeat(2,1fr)] gap-[18px] [display:grid]">
          <label className={FIELD}>
            <span className={FIELD_LABEL}>Rollout %</span>
            <input
              className={`${INPUT} ${INPUT_STATE.normal}`}
              inputMode="numeric"
              value={rolloutText}
              disabled={busy}
              onChange={(event) => setRolloutText(event.currentTarget.value)}
              aria-invalid={rollout === null || undefined}
            />
            {rollout === null ? (
              <span className={FIELD_ERR} role="alert">
                <AlertIcon />
                Enter a whole number between 1 and 100.
              </span>
            ) : (
              <span className={FIELD_HINT}>Default 100 — not inherited.</span>
            )}
          </label>
          <OverrideField
            label="Target binary version"
            overridden={overrideTarget}
            onToggle={setOverrideTarget}
            inheritedDisplay={<code className="mono">{release.targetBinaryVersion}</code>}
            busy={busy}
          >
            <input
              className={`${INPUT} ${INPUT_STATE.normal} font-mono`}
              value={targetVersion}
              disabled={busy}
              onChange={(event) => setTargetVersion(event.currentTarget.value)}
              aria-label="Target binary version override"
              aria-invalid={targetInvalid || undefined}
            />
            {targetInvalid ? (
              <span className={FIELD_ERR} role="alert">
                <AlertIcon />
                Enter a target binary version.
              </span>
            ) : null}
          </OverrideField>
        </div>

        <OverrideField
          label="Release notes"
          overridden={overrideNotes}
          onToggle={setOverrideNotes}
          inheritedDisplay={
            release.releaseNotes === null
              ? "None"
              : truncate(release.releaseNotes, 80)
          }
          busy={busy}
        >
          <textarea
            className={`${INPUT} ${INPUT_STATE.normal} ${TEXTAREA_EXTRA}`}
            rows={3}
            value={notes}
            disabled={busy}
            onChange={(event) => setNotes(event.currentTarget.value)}
            aria-label="Release notes override"
          />
        </OverrideField>

        <div className="grid-cols-[repeat(2,1fr)] items-start gap-[18px] [display:grid]">
          <OverrideField
            label="Mandatory"
            overridden={overrideMandatory}
            onToggle={setOverrideMandatory}
            inheritedDisplay={release.isMandatory ? "Yes" : "No"}
            busy={busy}
          >
            <label className={TOGGLE}>
              <input
                type="checkbox"
                className={TOGGLE_INPUT}
                checked={mandatory}
                disabled={busy}
                onChange={(event) => setMandatory(event.currentTarget.checked)}
              />
              <span className={TOGGLE_TRACK} aria-hidden="true" />
              Clients must install this update
            </label>
          </OverrideField>
          <div className={FIELD}>
            <span className={FIELD_LABEL}>Initial status</span>
            <label className={TOGGLE}>
              <input
                type="checkbox"
                className={TOGGLE_INPUT}
                checked={createDisabled}
                disabled={busy}
                onChange={(event) =>
                  setCreateDisabled(event.currentTarget.checked)
                }
              />
              <span className={TOGGLE_TRACK} aria-hidden="true" />
              Create as disabled
            </label>
          </div>
        </div>

        <div className={`${CALLOUT} ${CALLOUT_TONE.warn}`}>
          <InfoIcon />
          <div>
            If the destination already has this content, you'll be offered{" "}
            <b>Promote anyway</b>.
          </div>
        </div>
        {errorSlot}
      </form>
    </Modal>
  );
}

/**
 * Field block with an inherit/override switch: un-overridden fields show the
 * inherited source value and are OMITTED from the request body.
 */
function OverrideField({
  label,
  overridden,
  onToggle,
  inheritedDisplay,
  busy,
  children,
}: {
  label: string;
  overridden: boolean;
  onToggle: (value: boolean) => void;
  inheritedDisplay: ReactNode;
  busy: boolean;
  children: ReactNode;
}) {
  return (
    <div className={FIELD}>
      <div className="flex items-center justify-between gap-3.5 mb-[7px]">
        {/* marginBottom:0 OVERRIDES FIELD_LABEL's mb-[7px]; conflicting
            utilities cannot co-apply, so the override stays inline. */}
        <span className={FIELD_LABEL} style={{ marginBottom: 0 }}>
          {label}
        </span>
        <label className="inline-flex cursor-pointer items-center gap-1.5 text-[12px] font-semibold text-fg-2">
          <input
            type="checkbox"
            checked={overridden}
            disabled={busy}
            onChange={(event) => onToggle(event.currentTarget.checked)}
            className="accent-blue"
          />
          Override
        </label>
      </div>
      {overridden ? (
        children
      ) : (
        // marginTop:0 OVERRIDES FIELD_HINT's mt-[7px]; conflicting utilities
        // cannot co-apply, so the override stays inline (display:block → util).
        <span className={`${FIELD_HINT} block`} style={{ marginTop: 0 }}>
          Inherited: {inheritedDisplay}
        </span>
      )}
    </div>
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

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// --- release-conflict extension extraction (defensive key sweep) ------------

const CONFLICT_RELEASE_ID_KEYS = [
  "release_id",
  "releaseId",
  "conflicting_release_id",
  "conflictingReleaseId",
  "active_release_id",
  "activeReleaseId",
] as const;

/** Offending-release id from the problem extensions, when the server sends one. */
function conflictReleaseIdFrom(error: unknown): string | null {
  if (!(error instanceof HttpProblemError)) {
    return null;
  }
  for (const key of CONFLICT_RELEASE_ID_KEYS) {
    const value = error.extensions[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

/** Active rollout % from the problem extensions ("Active rollout at X%"). */
function conflictRolloutFrom(error: unknown): number | null {
  if (!(error instanceof HttpProblemError)) {
    return null;
  }
  for (const key of ["rollout_percentage", "rolloutPercentage"]) {
    const value = error.extensions[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
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

// Icon paths use lucide-style glyphs (`rocket`, `info`, `alert`).

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

function RocketIcon() {
  return (
    <IconSvg>
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
      <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
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
