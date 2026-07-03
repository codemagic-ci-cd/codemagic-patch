// GitHub Actions release form for the New release modal.

import { useState, type FormEvent } from "react";

import {
  useDeploymentGitHubActions,
  useDispatchGitHubRelease,
  useTeamGitHubIntegration,
  useUpsertDeploymentGitHubActions,
} from "../../../api/hooks/githubActions";
import { HttpProblemError } from "../../../api/problem";
import { useToast } from "../../../components/overlay/ToastProvider";
import { buttonVariants } from "../../../components/ui/Button";
import { CALLOUT, CALLOUT_TONE } from "../../../components/ui/callout";
import {
  FIELD,
  FIELD_LABEL,
  INPUT,
  INPUT_STATE,
  TEXTAREA_EXTRA,
} from "../../../components/ui/form";
import type { ReleaseReactPlatform } from "../../../cli/buildReleaseReactCommand";

const SEGMENTED =
  "inline-flex gap-[3px] rounded-control border border-border bg-surface-2 p-[3px]";
const SEGMENTED_BTN =
  "rounded-[8px] border-0 px-[14px] py-[7px] text-[13px] font-semibold [transition:.13s]";
const SEGMENTED_BTN_IDLE = "bg-transparent text-fg-2";
const SEGMENTED_BTN_ACTIVE = "bg-surface text-blue shadow-xs";
const BUILDER_INPUT = INPUT.replace("w-full ", "");
const BUILDER_FIELD = "flex min-w-0 flex-col gap-1.5";
const BUILDER_LABEL = "block text-[13px] font-semibold leading-snug text-fg";
const BUILDER_CONTROL = "flex items-center";

const PLATFORMS: readonly { value: ReleaseReactPlatform; label: string }[] = [
  { value: "ios", label: "iOS" },
  { value: "android", label: "Android" },
];

export interface UseRunGitHubReleaseFormOptions {
  deploymentId: string;
  onComplete: () => void;
  onOpenConfigure: () => void;
  suggestedTargetBinaryVersion?: string;
  teamId: string;
}

export function useRunGitHubReleaseForm({
  deploymentId,
  onComplete,
  onOpenConfigure,
  suggestedTargetBinaryVersion = "",
  teamId,
}: UseRunGitHubReleaseFormOptions) {
  const toast = useToast();
  const linkQuery = useDeploymentGitHubActions(deploymentId);
  const integrationQuery = useTeamGitHubIntegration(teamId);
  const upsertLink = useUpsertDeploymentGitHubActions(deploymentId);
  const dispatch = useDispatchGitHubRelease(deploymentId);

  const [platform, setPlatform] = useState<ReleaseReactPlatform>("ios");
  const [targetBinaryVersions, setTargetBinaryVersions] = useState({
    android: suggestedTargetBinaryVersion,
    ios: suggestedTargetBinaryVersion,
  });
  const [releaseNotes, setReleaseNotes] = useState("");
  const [rolloutPercentage, setRolloutPercentage] = useState("100");
  const [mandatory, setMandatory] = useState(false);
  const configuredRef = linkQuery.data?.defaultRef ?? "main";
  const [branch, setBranch] = useState(configuredRef);
  const [prevConfiguredRef, setPrevConfiguredRef] = useState(configuredRef);
  if (configuredRef !== prevConfiguredRef) {
    setPrevConfiguredRef(configuredRef);
    setBranch(configuredRef);
  }

  const busy = dispatch.isPending || upsertLink.isPending;
  const linkReady = linkQuery.data !== null && linkQuery.data !== undefined;
  const patReady = integrationQuery.data?.configured === true;
  const canSubmit =
    linkReady && patReady && !busy && branch.trim().length > 0;

  const setTargetForPlatform = (value: string) => {
    setTargetBinaryVersions((current) => ({
      ...current,
      [platform]: value,
    }));
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit || linkQuery.data === null || linkQuery.data === undefined) {
      return;
    }

    const rollout = Number.parseInt(rolloutPercentage, 10);
    const targetBinaryVersion = targetBinaryVersions[platform].trim();
    const branchRef = branch.trim();
    const link = linkQuery.data;

    const runDispatch = () => {
      dispatch.mutate(
        {
          mandatory,
          platform,
          ...(releaseNotes.trim().length > 0
            ? { release_notes: releaseNotes.trim() }
            : {}),
          ...(Number.isFinite(rollout) && rollout !== 100
            ? { rollout_percentage: rollout }
            : {}),
          ...(targetBinaryVersion.length > 0
            ? { target_binary_version: targetBinaryVersion }
            : {}),
        },
        {
          onSuccess: () => {
            toast.success("Release started", {
              description:
                "GitHub Actions is building and publishing your update.",
            });
            onComplete();
          },
          onError: (error) => {
            toast.error("Release failed", {
              description:
                error instanceof HttpProblemError
                  ? error.detail
                  : "Try again.",
            });
          },
        },
      );
    };

    if (branchRef !== link.defaultRef) {
      upsertLink.mutate(
        {
          default_ref: branchRef,
          enabled: link.enabled,
          owner: link.owner,
          repo: link.repo,
          workflow_file: link.workflowFile,
        },
        {
          onSuccess: runDispatch,
          onError: (error) => {
            toast.error("Could not update branch", {
              description:
                error instanceof HttpProblemError
                  ? error.detail
                  : "Try again.",
            });
          },
        },
      );
      return;
    }

    runDispatch();
  };

  const content = (
    <form
      className="flex flex-col gap-4"
      id="github-release-form"
      onSubmit={handleSubmit}
    >
      {!linkReady || !patReady ? (
        <div className={`${CALLOUT} ${CALLOUT_TONE.warn}`}>
          <AlertIcon />
          <div>
            {!linkReady ? (
              <>
                GitHub Actions is not linked for this deployment yet.{" "}
                <button
                  type="button"
                  className="text-blue underline"
                  onClick={onOpenConfigure}
                >
                  Set up GitHub Actions
                </button>
                .
              </>
            ) : (
              <>
                Team GitHub token is missing. Finish setup under{" "}
                <button
                  type="button"
                  className="text-blue underline"
                  onClick={onOpenConfigure}
                >
                  GitHub Actions
                </button>
                .
              </>
            )}
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-x-3 gap-y-3">
        <div className={BUILDER_FIELD}>
          <span className={BUILDER_LABEL}>Platform</span>
          <div className={BUILDER_CONTROL}>
            <div className={SEGMENTED} role="group" aria-label="Platform">
              {PLATFORMS.map((option) => {
                const active = platform === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    className={`${SEGMENTED_BTN} ${
                      active ? SEGMENTED_BTN_ACTIVE : SEGMENTED_BTN_IDLE
                    }`}
                    aria-pressed={active}
                    disabled={busy}
                    onClick={() => setPlatform(option.value)}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <label className={`${BUILDER_FIELD} w-[4.5rem] shrink-0`}>
          <span className={BUILDER_LABEL}>Rollout %</span>
          <div className={BUILDER_CONTROL}>
            <input
              type="number"
              min={1}
              max={100}
              className={`${BUILDER_INPUT} ${INPUT_STATE.normal} w-full`}
              value={rolloutPercentage}
              disabled={busy}
              onChange={(event) => setRolloutPercentage(event.target.value)}
            />
          </div>
        </label>

        <label className={`${BUILDER_FIELD} min-w-[7.5rem] flex-1`}>
          <span className={BUILDER_LABEL}>
            Target binary ({platform === "ios" ? "iOS" : "Android"})
          </span>
          <div className={BUILDER_CONTROL}>
            <input
              type="text"
              className={`${BUILDER_INPUT} ${INPUT_STATE.normal} w-full`}
              value={targetBinaryVersions[platform]}
              placeholder="e.g. ^1.8.0"
              disabled={busy}
              onChange={(event) => setTargetForPlatform(event.target.value)}
            />
          </div>
        </label>

        <label className={`${BUILDER_FIELD} w-[7rem] shrink-0`}>
          <span className={BUILDER_LABEL}>Branch</span>
          <div className={BUILDER_CONTROL}>
            <input
              type="text"
              className={`${BUILDER_INPUT} ${INPUT_STATE.normal} w-full`}
              value={branch}
              required
              disabled={busy}
              onChange={(event) => setBranch(event.target.value)}
            />
          </div>
        </label>
      </div>

      <label className={FIELD}>
        <span className={FIELD_LABEL}>Release notes (optional)</span>
        <textarea
          className={`${INPUT} ${INPUT_STATE.normal} ${TEXTAREA_EXTRA}`}
          rows={3}
          value={releaseNotes}
          disabled={busy}
          onChange={(event) => setReleaseNotes(event.target.value)}
        />
      </label>

      <label className="inline-flex cursor-pointer items-center gap-2 text-[13px]">
        <input
          type="checkbox"
          className="accent-blue"
          checked={mandatory}
          disabled={busy}
          onChange={(event) => setMandatory(event.target.checked)}
        />
        Mandatory
      </label>
    </form>
  );

  const footer = (
    <button
      type="submit"
      form="github-release-form"
      className={buttonVariants({ intent: "primary" })}
      disabled={!canSubmit}
    >
      {busy ? "Starting…" : "Run release"}
    </button>
  );

  return {
    busy,
    content,
    footer,
    reset: () => {
      setPlatform("ios");
      setTargetBinaryVersions({
        android: suggestedTargetBinaryVersion,
        ios: suggestedTargetBinaryVersion,
      });
      setReleaseNotes("");
      setRolloutPercentage("100");
      setMandatory(false);
      setBranch(configuredRef);
      dispatch.reset();
      upsertLink.reset();
    },
  };
}

function AlertIcon() {
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
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}
