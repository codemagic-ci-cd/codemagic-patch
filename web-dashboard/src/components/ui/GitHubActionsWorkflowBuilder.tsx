// Interactive GitHub Actions workflow generator for deployment setup.

import { useMemo, useRef, useState } from "react";

import {
  buildGitHubActionsWorkflow,
  type GitHubActionsBundler,
  type GitHubActionsPlatformMode,
  type GitHubActionsRunner,
} from "../../cli/buildGitHubActionsWorkflow";
import { CARD, CARD_PAD } from "./card";
import {
  CODEBLOCK,
  CODEBLOCK_COPY_BTN,
  CODEBLOCK_COPY_BTN_COPIED,
  CODEBLOCK_COPY_BTN_IDLE,
} from "./codeblock";
import { CheckIcon, CopyIcon, useCopyState } from "./Copyable";
import { INPUT, INPUT_STATE } from "./form";
import { SECTION_TITLE } from "./typography";

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

const PLATFORM_MODES: readonly {
  value: GitHubActionsPlatformMode;
  label: string;
}[] = [
  { value: "dispatch-input", label: "Pick at run" },
  { value: "android-only", label: "Android" },
  { value: "ios-only", label: "iOS" },
  { value: "matrix-both", label: "Both" },
];

const RUNNERS: readonly { value: GitHubActionsRunner; label: string }[] = [
  { value: "ubuntu-latest", label: "Linux" },
  { value: "macos-latest", label: "macOS" },
];

const BUNDLERS: readonly { value: GitHubActionsBundler; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "metro", label: "Metro" },
  { value: "expo", label: "Expo" },
];

function WorkflowIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="size-[18px] text-blue"
    >
      <path d="M12 3v6m0 6v6" />
      <circle cx="12" cy="12" r="3" />
      <path d="M5.5 8.5 9 10.5M15 13.5l3.5 2M18.5 8.5 15 10.5M9 13.5 5.5 15.5" />
    </svg>
  );
}

export interface GitHubActionsWorkflowBuilderProps {
  appName: string;
  codeSigningRequired?: boolean;
  deploymentName: string;
  onWorkflowFilenameChange?: (filename: string) => void;
  serverUrl: string;
  workflowFilename?: string;
}

export function GitHubActionsWorkflowBuilder({
  appName,
  codeSigningRequired = false,
  deploymentName,
  onWorkflowFilenameChange,
  serverUrl,
  workflowFilename: workflowFilenameProp = "codemagic-patch-release.yml",
}: GitHubActionsWorkflowBuilderProps) {
  const [platformMode, setPlatformMode] =
    useState<GitHubActionsPlatformMode>("dispatch-input");
  const [runner, setRunner] = useState<GitHubActionsRunner>("ubuntu-latest");
  const [bundler, setBundler] = useState<GitHubActionsBundler>("auto");
  const [monorepoRoot, setMonorepoRoot] = useState("");
  const [workflowFilename, setWorkflowFilename] = useState(workflowFilenameProp);
  const [releaseNotesInput, setReleaseNotesInput] = useState(true);
  const [targetVersionInput, setTargetVersionInput] = useState(true);
  const [rolloutInput, setRolloutInput] = useState(false);
  const [mandatoryInput, setMandatoryInput] = useState(true);

  const workflow = useMemo(
    () =>
      buildGitHubActionsWorkflow({
        appName,
        bundler,
        codeSigningRequired,
        deploymentName,
        dispatchInputs: {
          mandatory: mandatoryInput,
          releaseNotes: releaseNotesInput,
          rolloutPercentage: rolloutInput,
          targetBinaryVersion: targetVersionInput,
        },
        monorepoRoot,
        platformMode,
        runner,
        serverUrl,
        workflowFilename,
      }),
    [
      appName,
      bundler,
      codeSigningRequired,
      deploymentName,
      mandatoryInput,
      monorepoRoot,
      platformMode,
      releaseNotesInput,
      rolloutInput,
      runner,
      serverUrl,
      targetVersionInput,
      workflowFilename,
    ],
  );

  const { state, copy } = useCopyState();
  const codeRef = useRef<HTMLElement>(null);
  const copied = state === "copied";

  const updateWorkflowFilename = (value: string) => {
    setWorkflowFilename(value);
    onWorkflowFilenameChange?.(value);
  };

  return (
    <div className={`${CARD} ${CARD_PAD} flex w-full min-w-0 flex-col gap-4`}>
      <div className={SECTION_TITLE}>
        <WorkflowIcon /> Workflow generator
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className={BUILDER_FIELD}>
          <span className={BUILDER_LABEL}>Platform mode</span>
          <div className={BUILDER_CONTROL}>
            <div className={`${SEGMENTED} flex-wrap`} role="group">
              {PLATFORM_MODES.map((option) => {
                const active = platformMode === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    className={`${SEGMENTED_BTN} ${
                      active ? SEGMENTED_BTN_ACTIVE : SEGMENTED_BTN_IDLE
                    }`}
                    aria-pressed={active}
                    onClick={() => setPlatformMode(option.value)}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className={BUILDER_FIELD}>
          <span className={BUILDER_LABEL}>Runner</span>
          <div className={BUILDER_CONTROL}>
            <div className={SEGMENTED} role="group" aria-label="Runner">
              {RUNNERS.map((option) => {
                const active = runner === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    className={`${SEGMENTED_BTN} ${
                      active ? SEGMENTED_BTN_ACTIVE : SEGMENTED_BTN_IDLE
                    }`}
                    aria-pressed={active}
                    onClick={() => setRunner(option.value)}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <label className={BUILDER_FIELD}>
          <span className={BUILDER_LABEL}>Bundler</span>
          <div className={BUILDER_CONTROL}>
            <div className={SEGMENTED} role="group" aria-label="Bundler">
              {BUNDLERS.map((option) => {
                const active = bundler === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    className={`${SEGMENTED_BTN} ${
                      active ? SEGMENTED_BTN_ACTIVE : SEGMENTED_BTN_IDLE
                    }`}
                    aria-pressed={active}
                    onClick={() => setBundler(option.value)}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>
        </label>

        <label className={BUILDER_FIELD}>
          <span className={BUILDER_LABEL}>Workflow filename</span>
          <input
            type="text"
            className={`${BUILDER_INPUT} ${INPUT_STATE.normal} w-full`}
            value={workflowFilename}
            onChange={(event) => updateWorkflowFilename(event.target.value)}
          />
        </label>

        <label className={`${BUILDER_FIELD} sm:col-span-2`}>
          <span className={BUILDER_LABEL}>Monorepo root (optional)</span>
          <input
            type="text"
            className={`${BUILDER_INPUT} ${INPUT_STATE.normal} w-full`}
            value={monorepoRoot}
            placeholder="e.g. apps/mobile"
            onChange={(event) => setMonorepoRoot(event.target.value)}
          />
        </label>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-2 text-[13px] text-fg">
        <span className="font-semibold text-fg-2">Dispatch inputs:</span>
        <label className="inline-flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            className="accent-blue"
            checked={releaseNotesInput}
            onChange={(event) => setReleaseNotesInput(event.target.checked)}
          />
          Release notes
        </label>
        <label className="inline-flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            className="accent-blue"
            checked={targetVersionInput}
            onChange={(event) => setTargetVersionInput(event.target.checked)}
          />
          Target version
        </label>
        <label className="inline-flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            className="accent-blue"
            checked={rolloutInput}
            onChange={(event) => setRolloutInput(event.target.checked)}
          />
          Rollout %
        </label>
        <label className="inline-flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            className="accent-blue"
            checked={mandatoryInput}
            onChange={(event) => setMandatoryInput(event.target.checked)}
          />
          Mandatory
        </label>
      </div>

      {platformMode === "ios-only" && runner === "ubuntu-latest" ? (
        <p className="text-[13px] text-fg-2">
          iOS releases on Linux runners may fail when native project files are
          required — consider macOS.
        </p>
      ) : null}

      <div className={`${CODEBLOCK} w-full min-w-0 overflow-x-auto`}>
        <button
          type="button"
          className={`${CODEBLOCK_COPY_BTN} ${
            copied ? CODEBLOCK_COPY_BTN_COPIED : CODEBLOCK_COPY_BTN_IDLE
          }`}
          aria-label="Copy workflow"
          onClick={() => void copy(workflow)}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
        <code ref={codeRef} className="block whitespace-pre pr-8 text-[12px]">
          {workflow}
        </code>
      </div>
    </div>
  );
}
