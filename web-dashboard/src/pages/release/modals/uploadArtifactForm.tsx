// Shared upload-a-release form body + submission hook. Used by UploadArtifactModal
// and the upload step of NewReleaseModal so both paths share identical parsing,
// policy editing, and POST behavior.

import { useId, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useNavigate } from "react-router";

import type { Artifact } from "@codemagic/patch-shared";

import { useCreateReleaseFromArtifact } from "../../../api/hooks/releases";
import { classifyProblem, HttpProblemError } from "../../../api/problem";
import type { ProblemBehavior } from "../../../api/problem";
import { useToast } from "../../../components/overlay/ToastProvider";
import { buttonVariants } from "../../../components/ui/Button";
import {
  CALLOUT,
  CALLOUT_BLOCK,
  CALLOUT_TONE,
} from "../../../components/ui/callout";
import {
  FIELD,
  FIELD_ERR,
  FIELD_HINT,
  FIELD_LABEL,
  INPUT,
  INPUT_STATE,
  SLIDER,
  TEXTAREA_EXTRA,
  TOGGLE,
  TOGGLE_INPUT,
  TOGGLE_TRACK,
} from "../../../components/ui/form";
import {
  SUMMARY,
  SUMMARY_KEY,
  SUMMARY_ROW,
  SUMMARY_VALUE,
} from "../../../components/ui/summary";
import {
  formatBytes,
  parseRolloutPercent,
  policyFromForm,
  readArtifactFile,
  seedPolicyForm,
  type PolicyForm,
} from "../../../model/artifactUpload";

export interface UseUploadArtifactFormOptions {
  deploymentId: string;
  deploymentName: string;
  onComplete: () => void;
}

export function useUploadArtifactForm({
  deploymentId,
  deploymentName,
  onComplete,
}: UseUploadArtifactFormOptions) {
  const createMutation = useCreateReleaseFromArtifact();
  const toast = useToast();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const rolloutHintId = useId();

  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [form, setForm] = useState<PolicyForm | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const busy = createMutation.isPending;

  const handleFile = async (file: File) => {
    setParseError(null);
    try {
      const parsed = await readArtifactFile(file);
      setArtifact(parsed);
      setFileName(file.name);
      setForm(seedPolicyForm(parsed.descriptor.defaults));
    } catch (error) {
      setArtifact(null);
      setFileName(null);
      setForm(null);
      setParseError(
        error instanceof Error
          ? error.message
          : "That file is not a valid .cmpatch artifact.",
      );
    }
  };

  const onPick = (file: File | undefined) => {
    if (file !== undefined) {
      void handleFile(file);
    }
  };

  const reset = () => {
    setArtifact(null);
    setFileName(null);
    setParseError(null);
    setForm(null);
    createMutation.reset();
    if (inputRef.current) {
      inputRef.current.value = "";
    }
  };

  const rolloutValue =
    form === null ? null : parseRolloutPercent(form.rolloutText);
  const policy = form === null ? null : policyFromForm(form);
  const canSubmit = artifact !== null && policy !== null && !busy;

  const submit = (uploadAnyway = false) => {
    if (artifact === null || policy === null || busy) {
      return;
    }
    const effectivePolicy = uploadAnyway
      ? { ...policy, noDuplicateReleaseError: true }
      : policy;
    createMutation.mutate(
      { deploymentId, artifact, policy: effectivePolicy },
      {
        onSuccess: (data) => {
          const created = data.release;
          toast.success(
            `Uploaded ${created.releaseLabel} to ${deploymentName}`,
            { description: "Opening the new release — its worker job is queued." },
          );
          onComplete();
          navigate(
            `/teams/${created.teamId}/apps/${created.appId}/deployments/${created.deploymentId}/releases/${created.id}`,
          );
        },
      },
    );
  };

  const requestClose = () => {
    if (!busy) {
      onComplete();
    }
  };

  const behavior = problemBehavior(createMutation.error);

  const updateForm = (patch: Partial<PolicyForm>) => {
    setForm((previous) => (previous === null ? previous : { ...previous, ...patch }));
  };

  const content = (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".cmpatch"
        className="sr-only"
        onChange={(event) => {
          const input = event.currentTarget;
          onPick(input.files?.[0]);
          input.value = "";
        }}
      />

      {artifact === null ? (
        <>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            onDragOver={(event) => {
              event.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragOver(false);
              onPick(event.dataTransfer.files?.[0]);
            }}
            className={`flex w-full flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-6 py-10 text-center [transition:.15s] ${
              dragOver
                ? "border-blue bg-blue-tint"
                : "border-border-strong hover:border-blue"
            }`}
          >
            <span className="size-7 text-fg-3" aria-hidden="true">
              <UploadIcon />
            </span>
            <span className="text-[14px] font-semibold text-fg">
              Drop a .cmpatch file here, or click to choose
            </span>
            <span className="text-[12.5px] text-fg-3">
              Build one with{" "}
              <code className="rounded bg-surface-3 px-1 py-0.5">
                cmpatch bundle
              </code>
            </span>
          </button>
          {parseError !== null ? (
            <div
              className={`${CALLOUT} ${CALLOUT_TONE.danger} ${CALLOUT_BLOCK} mt-[18px]`}
              role="alert"
            >
              <AlertIcon />
              <div>
                <b>Couldn't read that file.</b> {parseError}
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <DescriptorSummary artifact={artifact} fileName={fileName} />
          <div className="mb-[18px] mt-2.5 flex justify-end">
            <button
              type="button"
              className={buttonVariants({ intent: "ghost", size: "sm" })}
              onClick={reset}
              disabled={busy}
            >
              Choose a different file
            </button>
          </div>

          {form !== null ? (
            <form
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                submit();
              }}
            >
              <div className={FIELD}>
                <span className={FIELD_LABEL}>Rollout</span>
                <div className="flex items-center gap-3.5">
                  <input
                    type="range"
                    className={SLIDER}
                    min={1}
                    max={100}
                    step={1}
                    value={rolloutValue ?? 1}
                    disabled={busy}
                    aria-label="Rollout percentage slider"
                    onChange={(event) =>
                      updateForm({ rolloutText: event.currentTarget.value })
                    }
                  />
                  <span className="flex flex-none items-center gap-[7px]">
                    <input
                      className={`${INPUT} ${
                        rolloutValue === null ? INPUT_STATE.invalid : INPUT_STATE.normal
                      } text-right tabular-nums`}
                      style={{ width: 86 }}
                      inputMode="numeric"
                      value={form.rolloutText}
                      disabled={busy}
                      aria-label="Rollout percentage"
                      aria-invalid={rolloutValue === null || undefined}
                      aria-describedby={rolloutHintId}
                      onChange={(event) =>
                        updateForm({ rolloutText: event.currentTarget.value })
                      }
                    />
                    <b className="text-[16px]">%</b>
                  </span>
                </div>
                {rolloutValue === null ? (
                  <span id={rolloutHintId} className={FIELD_ERR}>
                    <AlertIcon />
                    Enter a whole number between 1 and 100.
                  </span>
                ) : (
                  <span id={rolloutHintId} className={FIELD_HINT}>
                    Share of devices that receive this release.
                  </span>
                )}
              </div>

              <div className={FIELD}>
                <span className={FIELD_LABEL}>Release notes</span>
                <textarea
                  className={`${INPUT} ${INPUT_STATE.normal} ${TEXTAREA_EXTRA}`}
                  value={form.releaseNotes}
                  disabled={busy}
                  placeholder="What changed in this release? (optional)"
                  onChange={(event) =>
                    updateForm({ releaseNotes: event.currentTarget.value })
                  }
                />
              </div>

              <div className="flex flex-col gap-3">
                <PolicyToggle
                  label="Mandatory update"
                  checked={form.isMandatory}
                  disabled={busy}
                  onChange={(isMandatory) => updateForm({ isMandatory })}
                />
                <PolicyToggle
                  label="Create disabled (publish later)"
                  checked={form.disabled}
                  disabled={busy}
                  onChange={(disabled) => updateForm({ disabled })}
                />
                <PolicyToggle
                  label="Ignore duplicate-release error"
                  checked={form.noDuplicateReleaseError}
                  disabled={busy}
                  onChange={(noDuplicateReleaseError) =>
                    updateForm({ noDuplicateReleaseError })
                  }
                />
              </div>

              {createMutation.isError ? (
                <ErrorSlot
                  behavior={behavior}
                  error={createMutation.error}
                  busy={busy}
                  onUploadAnyway={() => submit(true)}
                />
              ) : null}
            </form>
          ) : null}
        </>
      )}
    </>
  );

  const footer = (
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
        onClick={() => submit()}
        disabled={!canSubmit}
        aria-busy={busy || undefined}
      >
        {busy ? <span className="spinner sm" aria-hidden="true" /> : null}
        Upload release
      </button>
    </>
  );

  return { content, footer, busy, requestClose, reset };
}

function DescriptorSummary({
  artifact,
  fileName,
}: {
  artifact: Artifact;
  fileName: string | null;
}) {
  const { descriptor } = artifact;
  return (
    <div className={SUMMARY}>
      {fileName !== null ? (
        <div className={SUMMARY_ROW}>
          <span className={SUMMARY_KEY}>File</span>
          <span className={SUMMARY_VALUE}>{fileName}</span>
        </div>
      ) : null}
      <div className={SUMMARY_ROW}>
        <span className={SUMMARY_KEY}>Platform</span>
        <span className={SUMMARY_VALUE}>{descriptor.platform}</span>
      </div>
      <div className={SUMMARY_ROW}>
        <span className={SUMMARY_KEY}>Target version</span>
        <span className={SUMMARY_VALUE}>{descriptor.targetBinaryVersion}</span>
      </div>
      <div className={SUMMARY_ROW}>
        <span className={SUMMARY_KEY}>Fingerprint</span>
        <span className={`${SUMMARY_VALUE} font-mono`}>
          {descriptor.fingerprint.slice(0, 16)}
          {descriptor.fingerprint.length > 16 ? "…" : ""}
        </span>
      </div>
      <div className={SUMMARY_ROW}>
        <span className={SUMMARY_KEY}>Code signing</span>
        <span className={SUMMARY_VALUE}>
          {descriptor.signature !== undefined ? "Signed" : "Not signed"}
        </span>
      </div>
      <div className={SUMMARY_ROW}>
        <span className={SUMMARY_KEY}>Bundle size</span>
        <span className={SUMMARY_VALUE}>{formatBytes(descriptor.bundleSize)}</span>
      </div>
      <div className={SUMMARY_ROW}>
        <span className={SUMMARY_KEY}>Built with</span>
        <span className={SUMMARY_VALUE}>
          {descriptor.provenance.bundler}
          {descriptor.provenance.hermes ? " · Hermes" : ""}
        </span>
      </div>
    </div>
  );
}

function PolicyToggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={TOGGLE}>
      <input
        type="checkbox"
        className={TOGGLE_INPUT}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span className={TOGGLE_TRACK} aria-hidden="true" />
      <span>{label}</span>
    </label>
  );
}

function ErrorSlot({
  behavior,
  error,
  busy,
  onUploadAnyway,
}: {
  behavior: ProblemBehavior | null;
  error: unknown;
  busy: boolean;
  onUploadAnyway: () => void;
}) {
  if (behavior === "duplicate-release") {
    return (
      <div
        className={`${CALLOUT} ${CALLOUT_TONE.warn} ${CALLOUT_BLOCK} mt-[18px]`}
        role="alert"
      >
        <AlertIcon />
        <div>
          <b>This deployment already has this content.</b> Uploading again records
          a duplicate release entry.
          <div className="mt-2.5">
            <button
              type="button"
              className={buttonVariants({ intent: "primary", size: "sm" })}
              disabled={busy}
              onClick={onUploadAnyway}
            >
              Upload anyway
            </button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div
      className={`${CALLOUT} ${CALLOUT_TONE.danger} ${CALLOUT_BLOCK} mt-[18px]`}
      role="alert"
    >
      <AlertIcon />
      <div>{describeProblem(error)}</div>
    </div>
  );
}

function problemBehavior(error: unknown): ProblemBehavior | null {
  return error instanceof HttpProblemError ? classifyProblem(error) : null;
}

function describeProblem(error: unknown): string {
  if (error instanceof HttpProblemError) {
    return error.detail ?? error.title ?? "The upload couldn't be completed.";
  }
  return "The upload couldn't be completed. Check your connection and try again.";
}

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

export function UploadIcon() {
  return (
    <IconSvg>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
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
