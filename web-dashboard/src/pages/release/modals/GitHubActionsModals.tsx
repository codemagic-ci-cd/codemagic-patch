// GitHub Actions setup + dispatch modals for deployment detail.

import { useEffect, useState, type FormEvent } from "react";

import {
  useDeploymentGitHubActions,
  useDispatchGitHubRelease,
  useTeamGitHubIntegration,
  useUpsertDeploymentGitHubActions,
} from "../../../api/hooks/githubActions";
import { HttpProblemError } from "../../../api/problem";
import { Modal } from "../../../components/overlay/Modal";
import { useToast } from "../../../components/overlay/ToastProvider";
import { buttonVariants } from "../../../components/ui/Button";
import { GitHubActionsWorkflowBuilder } from "../../../components/ui/GitHubActionsWorkflowBuilder";
import { FIELD, FIELD_LABEL, INPUT, INPUT_STATE } from "../../../components/ui/form";
import { apiServerUrl } from "../../../lib/cliSnippet";
import type { ReleaseReactPlatform } from "../../../cli/buildReleaseReactCommand";

interface ConfigureGitHubActionsModalProps {
  appName: string;
  codeSigningRequired: boolean;
  deploymentId: string;
  deploymentName: string;
  onClose: () => void;
  open: boolean;
  teamId: string;
}

export function ConfigureGitHubActionsModal({
  appName,
  codeSigningRequired,
  deploymentId,
  deploymentName,
  onClose,
  open,
  teamId,
}: ConfigureGitHubActionsModalProps) {
  const toast = useToast();
  const integrationQuery = useTeamGitHubIntegration(teamId);
  const linkQuery = useDeploymentGitHubActions(deploymentId);
  const upsert = useUpsertDeploymentGitHubActions(deploymentId);

  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [defaultRef, setDefaultRef] = useState("main");
  const [workflowFile, setWorkflowFile] = useState(
    "codemagic-patch-release.yml",
  );
  useEffect(() => {
    if (linkQuery.data) {
      setOwner(linkQuery.data.owner);
      setRepo(linkQuery.data.repo);
      setDefaultRef(linkQuery.data.defaultRef);
      setWorkflowFile(linkQuery.data.workflowFile);
    }
  }, [linkQuery.data]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    upsert.mutate(
      {
        default_ref: defaultRef,
        enabled: true,
        owner: owner.trim(),
        repo: repo.trim(),
        workflow_file: workflowFile.trim(),
      },
      {
        onSuccess: () => {
          toast.success("GitHub Actions linked", {
            description: `${owner}/${repo}`,
          });
          onClose();
        },
        onError: (error) => {
          toast.error("Could not save link", {
            description:
              error instanceof HttpProblemError
                ? error.detail
                : "Try again.",
          });
        },
      },
    );
  };

  return (
    <Modal open={open} title="Configure GitHub Actions" onClose={onClose}>
      <div className="flex flex-col gap-5">
        <ol className="list-decimal space-y-1 pl-5 text-[13px] text-fg-2">
          <li>Copy the workflow below into your repo</li>
          <li>
            Add GitHub secrets:{" "}
            <code className="text-fg">CODEMAGIC_PATCH_TOKEN</code>,{" "}
            <code className="text-fg">CODEMAGIC_PATCH_SERVER_URL</code>
          </li>
          <li>
            Save a GitHub PAT under Account → API tokens → GitHub Actions
            integration
          </li>
          <li>Link the repository below</li>
        </ol>

        {integrationQuery.data?.configured === false ? (
          <p className="rounded-md border border-border bg-surface-2 px-3 py-2 text-[13px] text-fg-2">
            Team GitHub PAT is not configured yet. Save one under Account → API
            tokens → GitHub Actions integration.
          </p>
        ) : null}

        <GitHubActionsWorkflowBuilder
          appName={appName}
          codeSigningRequired={codeSigningRequired}
          deploymentName={deploymentName}
          serverUrl={apiServerUrl()}
          workflowFilename={workflowFile}
          onWorkflowFilenameChange={setWorkflowFile}
        />

        <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={FIELD}>
              <span className={FIELD_LABEL}>Owner</span>
              <input
                className={`${INPUT} ${INPUT_STATE.normal}`}
                value={owner}
                required
                onChange={(event) => setOwner(event.target.value)}
              />
            </label>
            <label className={FIELD}>
              <span className={FIELD_LABEL}>Repository</span>
              <input
                className={`${INPUT} ${INPUT_STATE.normal}`}
                value={repo}
                required
                onChange={(event) => setRepo(event.target.value)}
              />
            </label>
            <label className={FIELD}>
              <span className={FIELD_LABEL}>Workflow file</span>
              <input
                className={`${INPUT} ${INPUT_STATE.normal}`}
                value={workflowFile}
                required
                onChange={(event) => setWorkflowFile(event.target.value)}
              />
            </label>
            <label className={FIELD}>
              <span className={FIELD_LABEL}>Branch</span>
              <input
                className={`${INPUT} ${INPUT_STATE.normal}`}
                value={defaultRef}
                required
                onChange={(event) => setDefaultRef(event.target.value)}
              />
            </label>
          </div>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              className={buttonVariants({ intent: "ghost" })}
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={buttonVariants({ intent: "primary" })}
              disabled={upsert.isPending}
            >
              Save link
            </button>
          </div>
        </form>
      </div>
    </Modal>
  );
}

interface RunGitHubActionsModalProps {
  deploymentId: string;
  onClose: () => void;
  open: boolean;
  suggestedTargetBinaryVersion?: string;
}

export function RunGitHubActionsModal({
  deploymentId,
  onClose,
  open,
  suggestedTargetBinaryVersion = "",
}: RunGitHubActionsModalProps) {
  const toast = useToast();
  const dispatch = useDispatchGitHubRelease(deploymentId);
  const [platform, setPlatform] = useState<ReleaseReactPlatform>("ios");
  const [releaseNotes, setReleaseNotes] = useState("");
  const [targetBinaryVersion, setTargetBinaryVersion] = useState(
    suggestedTargetBinaryVersion,
  );
  const [rolloutPercentage, setRolloutPercentage] = useState("100");
  const [mandatory, setMandatory] = useState(false);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const rollout = Number.parseInt(rolloutPercentage, 10);
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
        ...(targetBinaryVersion.trim().length > 0
          ? { target_binary_version: targetBinaryVersion.trim() }
          : {}),
      },
      {
        onSuccess: (response) => {
          toast.success("Workflow dispatched", {
            description: "GitHub Actions is running your release.",
          });
          window.open(response.actionsUrl, "_blank", "noopener,noreferrer");
          onClose();
        },
        onError: (error) => {
          toast.error("Dispatch failed", {
            description:
              error instanceof HttpProblemError
                ? error.detail
                : "Try again.",
          });
        },
      },
    );
  };

  return (
    <Modal open={open} title="Run in GitHub Actions" onClose={onClose}>
      <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
        <label className={FIELD}>
          <span className={FIELD_LABEL}>Platform</span>
          <select
            className={`${INPUT} ${INPUT_STATE.normal}`}
            value={platform}
            onChange={(event) =>
              setPlatform(event.target.value as ReleaseReactPlatform)
            }
          >
            <option value="ios">iOS</option>
            <option value="android">Android</option>
          </select>
        </label>
        <label className={FIELD}>
          <span className={FIELD_LABEL}>Release notes (optional)</span>
          <input
            className={`${INPUT} ${INPUT_STATE.normal}`}
            value={releaseNotes}
            onChange={(event) => setReleaseNotes(event.target.value)}
          />
        </label>
        <label className={FIELD}>
          <span className={FIELD_LABEL}>Target binary version (optional)</span>
          <input
            className={`${INPUT} ${INPUT_STATE.normal}`}
            value={targetBinaryVersion}
            onChange={(event) => setTargetBinaryVersion(event.target.value)}
          />
        </label>
        <label className={FIELD}>
          <span className={FIELD_LABEL}>Rollout %</span>
          <input
            type="number"
            min={1}
            max={100}
            className={`${INPUT} ${INPUT_STATE.normal}`}
            value={rolloutPercentage}
            onChange={(event) => setRolloutPercentage(event.target.value)}
          />
        </label>
        <label className="inline-flex cursor-pointer items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            className="accent-blue"
            checked={mandatory}
            onChange={(event) => setMandatory(event.target.checked)}
          />
          Mandatory
        </label>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className={buttonVariants({ intent: "ghost" })}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            className={buttonVariants({ intent: "primary" })}
            disabled={dispatch.isPending}
          >
            {dispatch.isPending ? "Dispatching…" : "Run workflow"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
