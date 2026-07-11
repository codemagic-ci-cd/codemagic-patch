// Interactive CLI command builder (v1: release-react), rendered inside the
// New release modal. App and deployment come from the caller; the user picks
// platform and options. Bare form only — the modal supplies title and chrome.

import { useEffect, useMemo, useRef, useState } from "react";

import {
  buildReleaseReactCommand,
  type ReleaseReactPlatform,
} from "../../cli/buildReleaseReactCommand";
import {
  CODEBLOCK,
  CODEBLOCK_COPY_BTN,
  CODEBLOCK_COPY_BTN_COPIED,
  CODEBLOCK_COPY_BTN_IDLE,
  CODEBLOCK_TOKEN,
} from "./codeblock";
import { CheckIcon, CopyIcon, useCopyState } from "./Copyable";
import { INPUT, INPUT_STATE } from "./form";

interface CommandToken {
  kind: "cmd" | "flag" | "str" | "plain";
  text: string;
}

function tokenizeCommand(command: string): CommandToken[] {
  const parts = command.match(/"[^"]*"|'[^']*'|\s+|[^\s"']+/g) ?? [];
  const tokens: CommandToken[] = [];
  let sawCommand = false;
  for (const part of parts) {
    if (/^\s+$/.test(part)) {
      tokens.push({ kind: "plain", text: part });
    } else if (part.startsWith('"') || part.startsWith("'")) {
      tokens.push({ kind: "str", text: part });
    } else if (part.startsWith("--") || part === "\\") {
      tokens.push({ kind: "flag", text: part });
    } else if (!sawCommand) {
      sawCommand = true;
      tokens.push({ kind: "cmd", text: part });
    } else {
      tokens.push({ kind: "plain", text: part });
    }
  }
  return tokens;
}

const SEGMENTED =
  "inline-flex gap-[3px] rounded-control border border-border bg-surface-2 p-[3px]";
const SEGMENTED_BTN =
  "rounded-[8px] border-0 px-[14px] py-[7px] text-[13px] font-semibold [transition:.13s]";
const SEGMENTED_BTN_IDLE = "bg-transparent text-fg-2";
const SEGMENTED_BTN_ACTIVE = "bg-surface text-blue shadow-xs";

/** Same as INPUT but without w-full — compact fields in the builder column. */
const BUILDER_INPUT = INPUT.replace("w-full ", "");

const BUILDER_FIELD = "flex min-w-0 flex-col gap-1.5";

const BUILDER_LABEL =
  "block text-[13px] font-semibold leading-snug text-fg";

const BUILDER_CONTROL = "flex items-center";

const DEFAULT_PRIVATE_KEY_PATH = "./cmpatch-private.pem";

const PLATFORMS: readonly { value: ReleaseReactPlatform; label: string }[] = [
  { value: "ios", label: "iOS" },
  { value: "android", label: "Android" },
];

export interface CliCommandBuilderProps {
  serverUrl: string;
  appName: string;
  deploymentName: string;
  /** Prefill from the newest release on this deployment, when available. */
  suggestedTargetBinaryVersion?: string;
  codeSigningRequired?: boolean;
}

export function CliCommandBuilder({
  serverUrl,
  appName,
  deploymentName,
  suggestedTargetBinaryVersion = "",
  codeSigningRequired = false,
}: CliCommandBuilderProps) {
  const [platform, setPlatform] = useState<ReleaseReactPlatform>("ios");
  const [targetBinaryVersion, setTargetBinaryVersion] = useState(
    suggestedTargetBinaryVersion,
  );
  const [releaseNotes, setReleaseNotes] = useState("");
  const [rolloutPercentage, setRolloutPercentage] = useState("100");
  const [mandatory, setMandatory] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const [privateKeyPath, setPrivateKeyPath] = useState(DEFAULT_PRIVATE_KEY_PATH);

  // Re-prefill the target version when a newer release changes the suggestion.
  // React's "adjust state during render" pattern — avoids an effect that would
  // cascade-render (and trips react-hooks/set-state-in-effect). The user's own
  // edits survive until the suggested value actually changes.
  const [prevSuggested, setPrevSuggested] = useState(suggestedTargetBinaryVersion);
  if (suggestedTargetBinaryVersion !== prevSuggested) {
    setPrevSuggested(suggestedTargetBinaryVersion);
    setTargetBinaryVersion(suggestedTargetBinaryVersion);
  }

  const parsedRollout = Number.parseInt(rolloutPercentage, 10);
  const rollout =
    Number.isFinite(parsedRollout) && parsedRollout >= 1 && parsedRollout <= 100
      ? parsedRollout
      : 100;

  const command = useMemo(
    () =>
      buildReleaseReactCommand({
        serverUrl,
        appName,
        deploymentName,
        platform,
        targetBinaryVersion,
        releaseNotes,
        rolloutPercentage: rollout,
        mandatory,
        disabled,
        dryRun,
        privateKeyPath: codeSigningRequired ? privateKeyPath : undefined,
      }),
    [
      serverUrl,
      appName,
      deploymentName,
      platform,
      targetBinaryVersion,
      releaseNotes,
      rollout,
      mandatory,
      disabled,
      dryRun,
      codeSigningRequired,
      privateKeyPath,
    ],
  );

  const { state, copy } = useCopyState();
  const codeRef = useRef<HTMLElement>(null);
  const copied = state === "copied";

  useEffect(() => {
    if (state !== "fallback") {
      return;
    }
    const node = codeRef.current;
    if (node === null) {
      return;
    }
    const selection = window.getSelection();
    if (selection === null) {
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
  }, [state]);

  return (
    <div className="flex w-full min-w-0 flex-col gap-4">
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
              onChange={(event) => setRolloutPercentage(event.target.value)}
            />
          </div>
        </label>

        <label className={`${BUILDER_FIELD} w-[7.5rem] shrink-0`}>
          <span className={BUILDER_LABEL}>Target version</span>
          <div className={BUILDER_CONTROL}>
            <input
              type="text"
              className={`${BUILDER_INPUT} ${INPUT_STATE.normal} w-full`}
              value={targetBinaryVersion}
              placeholder="e.g. ^1.8.0"
              title="Optional semver range for native app versions"
              onChange={(event) => setTargetBinaryVersion(event.target.value)}
            />
          </div>
        </label>

        {codeSigningRequired ? (
          <label className={`${BUILDER_FIELD} w-[9rem] shrink-0`}>
            <span className={BUILDER_LABEL}>Private key path</span>
            <div className={BUILDER_CONTROL}>
              <input
                type="text"
                className={`${BUILDER_INPUT} ${INPUT_STATE.normal} w-full`}
                value={privateKeyPath}
                title="Required for signed releases on this app"
                onChange={(event) => setPrivateKeyPath(event.target.value)}
              />
            </div>
          </label>
        ) : null}

        <label className={`${BUILDER_FIELD} min-w-[12rem] flex-1 basis-full`}>
          <span className={BUILDER_LABEL}>Release note</span>
          <div className={BUILDER_CONTROL}>
            <input
              type="text"
              className={`${BUILDER_INPUT} ${INPUT_STATE.normal} w-full`}
              value={releaseNotes}
              placeholder="What changed in this release? (optional)"
              onChange={(event) => setReleaseNotes(event.target.value)}
            />
          </div>
        </label>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-2 text-[13px] text-fg">
        <label className="inline-flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            className="accent-blue"
            checked={mandatory}
            onChange={(event) => setMandatory(event.target.checked)}
          />
          Mandatory
        </label>
        <label className="inline-flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            className="accent-blue"
            checked={disabled}
            onChange={(event) => setDisabled(event.target.checked)}
          />
          Disabled
        </label>
        <label className="inline-flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            className="accent-blue"
            checked={dryRun}
            onChange={(event) => setDryRun(event.target.checked)}
          />
          Dry run
        </label>
      </div>

      <div className={`${CODEBLOCK} w-full min-w-0 overflow-x-hidden`}>
        <button
          type="button"
          className={`${CODEBLOCK_COPY_BTN} ${
            copied ? CODEBLOCK_COPY_BTN_COPIED : CODEBLOCK_COPY_BTN_IDLE
          }`}
          aria-label="Copy command"
          onClick={() => void copy(command)}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
        <code ref={codeRef} className="block whitespace-normal break-words pr-8">
          {tokenizeCommand(command).map((token, index) =>
            token.kind === "plain" ? (
              token.text
            ) : (
              <span key={index} className={CODEBLOCK_TOKEN[token.kind]}>
                {token.text}
              </span>
            ),
          )}
        </code>
      </div>
      <span role="status" className="sr-only">
        {copied
          ? "Copied to clipboard"
          : state === "fallback"
            ? "Clipboard unavailable — command selected, copy it manually"
            : ""}
      </span>
    </div>
  );
}
