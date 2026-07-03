// GitHub Actions setup + dispatch modals for deployment detail.

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";

import {
  useDeploymentGitHubActions,
  useTeamGitHubIntegration,
  useUpsertDeploymentGitHubActions,
  useUpsertTeamGitHubIntegration,
} from "../../../api/hooks/githubActions";
import { HttpProblemError } from "../../../api/problem";
import { Modal } from "../../../components/overlay/Modal";
import { useToast } from "../../../components/overlay/ToastProvider";
import { buttonVariants } from "../../../components/ui/Button";
import { CALLOUT, CALLOUT_TONE } from "../../../components/ui/callout";
import { Copyable } from "../../../components/ui/Copyable";
import { GitHubActionsWorkflowBuilder } from "../../../components/ui/GitHubActionsWorkflowBuilder";
import {
  FIELD,
  FIELD_HINT,
  FIELD_LABEL,
  INPUT,
  INPUT_STATE,
} from "../../../components/ui/form";
import { apiServerUrl } from "../../../lib/cliSnippet";

const GITHUB_PAT_SETTINGS_URL =
  "https://github.com/settings/personal-access-tokens";
const GITHUB_PAT_NEW_URL =
  "https://github.com/settings/personal-access-tokens/new";

const SETUP_STEPS = [
  "overview",
  "repository",
  "workflow",
  "secrets",
  "pat",
  "finish",
] as const;

type SetupStep = (typeof SETUP_STEPS)[number];

function stepIndex(step: SetupStep): number {
  return SETUP_STEPS.indexOf(step);
}

function githubRepoSecretsUrl(owner: string, repo: string): string {
  const trimmedOwner = owner.trim();
  const trimmedRepo = repo.trim();
  if (trimmedOwner.length === 0 || trimmedRepo.length === 0) {
    return "https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions";
  }
  return `https://github.com/${trimmedOwner}/${trimmedRepo}/settings/secrets/actions`;
}

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
  if (!open) {
    return null;
  }

  return (
    <ConfigureGitHubActionsModalContent
      appName={appName}
      codeSigningRequired={codeSigningRequired}
      deploymentId={deploymentId}
      deploymentName={deploymentName}
      onClose={onClose}
      teamId={teamId}
    />
  );
}

function ConfigureGitHubActionsModalContent({
  appName,
  codeSigningRequired,
  deploymentId,
  deploymentName,
  onClose,
  teamId,
}: Omit<ConfigureGitHubActionsModalProps, "open">) {
  const toast = useToast();
  const integrationQuery = useTeamGitHubIntegration(teamId);
  const linkQuery = useDeploymentGitHubActions(deploymentId);
  const upsertLink = useUpsertDeploymentGitHubActions(deploymentId);
  const upsertPat = useUpsertTeamGitHubIntegration(teamId);

  const [step, setStep] = useState<SetupStep>("overview");
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [defaultRef, setDefaultRef] = useState("main");
  const [workflowFile, setWorkflowFile] = useState(
    "codemagic-patch-release.yml",
  );
  const [patToken, setPatToken] = useState("");
  const [patSaving, setPatSaving] = useState(false);

  useEffect(() => {
    if (linkQuery.data) {
      setOwner(linkQuery.data.owner);
      setRepo(linkQuery.data.repo);
      setDefaultRef(linkQuery.data.defaultRef);
      setWorkflowFile(linkQuery.data.workflowFile);
    }
  }, [linkQuery.data]);

  const serverUrl = apiServerUrl();
  const patConfigured = integrationQuery.data?.configured === true;
  const repoSlug =
    owner.trim().length > 0 && repo.trim().length > 0
      ? `${owner.trim()}/${repo.trim()}`
      : null;

  const goNext = async () => {
    const index = stepIndex(step);
    if (index < 0 || index >= SETUP_STEPS.length - 1) {
      return;
    }

    if (step === "pat") {
      const trimmedPat = patToken.trim();
      if (!patConfigured && trimmedPat.length < 10) {
        return;
      }
      if (trimmedPat.length >= 10) {
        setPatSaving(true);
        try {
          await upsertPat.mutateAsync({ token: trimmedPat });
          setPatToken("");
          toast.success("GitHub PAT saved", {
            description: "Patch can now dispatch workflows for this team.",
          });
        } catch (error) {
          toast.error("Could not save PAT", {
            description:
              error instanceof HttpProblemError
                ? error.detail
                : "Try again.",
          });
          setPatSaving(false);
          return;
        }
        setPatSaving(false);
      }
    }

    setStep(SETUP_STEPS[index + 1]!);
  };

  const goBack = () => {
    const index = stepIndex(step);
    if (index <= 0) {
      return;
    }
    setStep(SETUP_STEPS[index - 1]!);
  };

  const handleSaveLink = (event: FormEvent) => {
    event.preventDefault();
    upsertLink.mutate(
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
            description: `${owner.trim()}/${repo.trim()}`,
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

  const header = setupStepMeta(step, deploymentName, repoSlug);
  const canGoNext =
    step === "repository"
      ? owner.trim().length > 0 &&
        repo.trim().length > 0 &&
        workflowFile.trim().length > 0 &&
        defaultRef.trim().length > 0
      : step === "pat"
        ? patConfigured || patToken.trim().length >= 10
        : true;

  const footer = (
    <SetupWizardFooter
      canGoNext={canGoNext}
      isLastStep={step === "finish"}
      nextBusy={patSaving}
      onBack={goBack}
      onClose={onClose}
      onNext={() => {
        void goNext();
      }}
      saveBusy={upsertLink.isPending}
      showBack={step !== "overview"}
    />
  );

  return (
    <Modal
      open
      onClose={onClose}
      title={header.title}
      description={header.description}
      icon={header.icon}
      wide={step !== "overview"}
      footer={footer}
    >
      {step === "overview" ? (
        <OverviewStep deploymentName={deploymentName} />
      ) : null}
      {step === "repository" ? (
        <RepositoryStep
          defaultRef={defaultRef}
          owner={owner}
          repo={repo}
          workflowFile={workflowFile}
          onDefaultRefChange={setDefaultRef}
          onOwnerChange={setOwner}
          onRepoChange={setRepo}
          onWorkflowFileChange={setWorkflowFile}
        />
      ) : null}
      {step === "workflow" ? (
        <>
          <div className={`${CALLOUT} ${CALLOUT_TONE.warn} mb-4`}>
            <AlertIcon />
            <div>
              Commit and push to <b>{defaultRef}</b> before dispatching. GitHub
              returns 404 until the workflow file exists on that branch with{" "}
              <code className="text-fg">on: workflow_dispatch</code>.
            </div>
          </div>
          <GitHubActionsWorkflowBuilder
            appName={appName}
            codeSigningRequired={codeSigningRequired}
            deploymentName={deploymentName}
            serverUrl={serverUrl}
            workflowFilename={workflowFile}
            onWorkflowFilenameChange={setWorkflowFile}
          />
        </>
      ) : null}
      {step === "secrets" ? (
        <SecretsStep
          codeSigningRequired={codeSigningRequired}
          owner={owner}
          repo={repo}
          serverUrl={serverUrl}
        />
      ) : null}
      {step === "pat" ? (
        <PatStep
          configured={patConfigured}
          owner={owner}
          patToken={patToken}
          repo={repo}
          tokenLast4={
            integrationQuery.data?.configured
              ? integrationQuery.data.tokenLast4
              : undefined
          }
          onPatTokenChange={setPatToken}
        />
      ) : null}
      {step === "finish" ? (
        <FinishStep
          defaultRef={defaultRef}
          owner={owner}
          patConfigured={patConfigured}
          repo={repo}
          workflowFile={workflowFile}
          onSubmit={handleSaveLink}
        />
      ) : null}
    </Modal>
  );
}

function setupStepMeta(
  step: SetupStep,
  deploymentName: string,
  repoSlug: string | null,
): { title: string; description?: string; icon: ReactNode } {
  const position = stepIndex(step) + 1;
  const progress = `Step ${position} of ${SETUP_STEPS.length}`;

  switch (step) {
    case "repository":
      return {
        title: "Link your GitHub repository",
        description: `${progress} · Owner, repo, and workflow file for ${deploymentName}.`,
        icon: <GitHubIcon />,
      };
    case "workflow":
      return {
        title: "Add the workflow file",
        description: `${progress} · Commit this to .github/workflows/ in ${repoSlug ?? "your repo"}.`,
        icon: <WorkflowIcon />,
      };
    case "secrets":
      return {
        title: "Add GitHub repository secrets",
        description: `${progress} · So CI can upload releases to Patch.`,
        icon: <KeyIcon />,
      };
    case "pat":
      return {
        title: "Connect Patch to GitHub",
        description: `${progress} · A GitHub token so Patch can trigger workflows from the dashboard.`,
        icon: <GitHubIcon />,
      };
    case "finish":
      return {
        title: "Review and save",
        description: `${progress} · Confirm the link for ${deploymentName}.`,
        icon: <CheckCircleIcon />,
      };
    default:
      return {
        title: "Set up GitHub Actions",
        description: `${progress} · Connect ${deploymentName} to a release workflow in GitHub.`,
        icon: <GitHubIcon />,
      };
  }
}

function SetupWizardFooter({
  canGoNext,
  isLastStep,
  nextBusy,
  onBack,
  onClose,
  onNext,
  saveBusy,
  showBack,
}: {
  canGoNext: boolean;
  isLastStep: boolean;
  nextBusy: boolean;
  onBack: () => void;
  onClose: () => void;
  onNext: () => void;
  saveBusy: boolean;
  showBack: boolean;
}) {
  if (isLastStep) {
    return (
      <>
        <button
          type="button"
          className={buttonVariants({ intent: "ghost" })}
          onClick={onBack}
        >
          <BackIcon /> Back
        </button>
        <button
          type="submit"
          form="github-actions-finish-form"
          className={buttonVariants({ intent: "primary" })}
          disabled={saveBusy}
        >
          {saveBusy ? "Saving…" : "Save link"}
        </button>
      </>
    );
  }

  return (
    <>
      {showBack ? (
        <button
          type="button"
          className={buttonVariants({ intent: "ghost" })}
          onClick={onBack}
          disabled={nextBusy}
        >
          <BackIcon /> Back
        </button>
      ) : (
        <button
          type="button"
          className={buttonVariants({ intent: "subtle" })}
          onClick={onClose}
        >
          Cancel
        </button>
      )}
      <button
        type="button"
        className={buttonVariants({ intent: "primary" })}
        disabled={!canGoNext || nextBusy}
        onClick={onNext}
      >
        {nextBusy ? "Saving…" : "Next"}
      </button>
    </>
  );
}

function OverviewStep({ deploymentName }: { deploymentName: string }) {
  return (
    <div className="flex flex-col gap-4 text-[14px] text-fg-2">
      <p>
        You will wire <b className="text-fg">{deploymentName}</b> to a GitHub
        Actions workflow in two directions:
      </p>
      <ul className="list-disc space-y-2 pl-5">
        <li>
          <b className="text-fg">GitHub → Patch</b> — repository secrets let CI
          run <code className="text-fg">cmpatch release-react</code> and upload
          updates.
        </li>
        <li>
          <b className="text-fg">Patch → GitHub</b> — a GitHub personal access
          token stored in Patch lets you click <b className="text-fg">Run in GitHub</b>{" "}
          to trigger <code className="text-fg">workflow_dispatch</code>.
        </li>
      </ul>
      <div className={`${CALLOUT} ${CALLOUT_TONE.info}`}>
        <InfoIcon />
        <div>
          Plan for about five minutes. You will copy a workflow file, add two
          kinds of credentials, then save the repository link.
        </div>
      </div>
    </div>
  );
}

function RepositoryStep({
  defaultRef,
  owner,
  repo,
  workflowFile,
  onDefaultRefChange,
  onOwnerChange,
  onRepoChange,
  onWorkflowFileChange,
}: {
  defaultRef: string;
  owner: string;
  repo: string;
  workflowFile: string;
  onDefaultRefChange: (value: string) => void;
  onOwnerChange: (value: string) => void;
  onRepoChange: (value: string) => void;
  onWorkflowFileChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[14px] text-fg-2">
        Patch needs the repository that will host the workflow. Use the same
        owner and repo you will commit the workflow file to.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={FIELD}>
          <span className={FIELD_LABEL}>Owner</span>
          <input
            className={`${INPUT} ${INPUT_STATE.normal}`}
            placeholder="acme-corp"
            value={owner}
            required
            onChange={(event) => onOwnerChange(event.target.value)}
          />
        </label>
        <label className={FIELD}>
          <span className={FIELD_LABEL}>Repository</span>
          <input
            className={`${INPUT} ${INPUT_STATE.normal}`}
            placeholder="mobile-app"
            value={repo}
            required
            onChange={(event) => onRepoChange(event.target.value)}
          />
        </label>
        <label className={FIELD}>
          <span className={FIELD_LABEL}>Workflow filename</span>
          <input
            className={`${INPUT} ${INPUT_STATE.normal}`}
            value={workflowFile}
            required
            onChange={(event) => onWorkflowFileChange(event.target.value)}
          />
          <span className={FIELD_HINT}>
            Saved under <code>.github/workflows/</code>
          </span>
        </label>
        <label className={FIELD}>
          <span className={FIELD_LABEL}>Default branch</span>
          <input
            className={`${INPUT} ${INPUT_STATE.normal}`}
            value={defaultRef}
            required
            onChange={(event) => onDefaultRefChange(event.target.value)}
          />
          <span className={FIELD_HINT}>
            Branch Patch dispatches when you click Run in GitHub
          </span>
        </label>
      </div>
    </div>
  );
}

function SecretsStep({
  codeSigningRequired,
  owner,
  repo,
  serverUrl,
}: {
  codeSigningRequired: boolean;
  owner: string;
  repo: string;
  serverUrl: string;
}) {
  const secretsUrl = githubRepoSecretsUrl(owner, repo);
  const repoLabel =
    owner.trim().length > 0 && repo.trim().length > 0
      ? `${owner.trim()}/${repo.trim()}`
      : "your repository";

  return (
    <div className="flex flex-col gap-4 text-[14px] text-fg-2">
      <p>
        In <b className="text-fg">{repoLabel}</b>, open{" "}
        <b className="text-fg">Settings → Secrets and variables → Actions</b>{" "}
        and add:
      </p>
      <ExternalLink href={secretsUrl}>
        Open repository secrets on GitHub
      </ExternalLink>

      <div className="rounded-lg border border-border bg-surface-2 p-4">
        <h4 className="text-[13px] font-bold text-fg">
          <code>CODEMAGIC_PATCH_TOKEN</code>
        </h4>
        <p className="mt-1.5">
          A Patch API token with permission to publish releases.{" "}
          <Link className="text-blue underline" to="/account/tokens">
            Create one under Account → API tokens
          </Link>
          , copy the secret once, and paste it as the GitHub secret value.
        </p>
      </div>

      <div className="rounded-lg border border-border bg-surface-2 p-4">
        <h4 className="text-[13px] font-bold text-fg">
          <code>CODEMAGIC_PATCH_SERVER_URL</code>
        </h4>
        <p className="mt-1.5">
          The Patch API URL your workflow should call:
        </p>
        <div className="mt-2">
          <Copyable
            value={serverUrl}
            display="full"
            label="Server URL"
            ariaLabel="Copy Patch server URL"
          />
        </div>
      </div>

      {codeSigningRequired ? (
        <div className="rounded-lg border border-border bg-surface-2 p-4">
          <h4 className="text-[13px] font-bold text-fg">
            <code>CODEMAGIC_PATCH_SIGNING_KEY</code>
          </h4>
          <p className="mt-1.5">
            PEM private key for code-signed releases (required for this app).
          </p>
        </div>
      ) : null}

      <div className={`${CALLOUT} ${CALLOUT_TONE.info}`}>
        <InfoIcon />
        <div>
          These secrets live in GitHub only. Patch never stores them — they are
          used when the workflow runs on GitHub&apos;s runners.
        </div>
      </div>
    </div>
  );
}

function PatStep({
  configured,
  owner,
  patToken,
  repo,
  tokenLast4,
  onPatTokenChange,
}: {
  configured: boolean;
  owner: string;
  patToken: string;
  repo: string;
  tokenLast4?: string;
  onPatTokenChange: (value: string) => void;
}) {
  const repoLabel =
    owner.trim().length > 0 && repo.trim().length > 0
      ? `${owner.trim()}/${repo.trim()}`
      : "your release repository";

  return (
    <div className="flex flex-col gap-4 text-[14px] text-fg-2">
      <p>
        Create a <b className="text-fg">fine-grained personal access token</b>{" "}
        on GitHub. Patch stores it encrypted and uses it only to trigger{" "}
        <code className="text-fg">workflow_dispatch</code> when you click{" "}
        <b className="text-fg">Run in GitHub</b>.
      </p>

      <ExternalLink href={GITHUB_PAT_NEW_URL}>
        Create a fine-grained token on GitHub
      </ExternalLink>
      <p className="text-[13px]">
        Or manage existing tokens at{" "}
        <a
          className="text-blue underline"
          href={GITHUB_PAT_SETTINGS_URL}
          rel="noopener noreferrer"
          target="_blank"
        >
          github.com/settings/personal-access-tokens
        </a>
        .
      </p>

      <div className="rounded-lg border border-border bg-surface-2 p-4">
        <h4 className="text-[13px] font-bold text-fg">Token settings</h4>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-[13px]">
          <li>
            <b className="text-fg">Repository access</b> — Only select
            repositories → choose <b className="text-fg">{repoLabel}</b>
          </li>
          <li>
            <b className="text-fg">Repository permissions</b> — click{" "}
            <b className="text-fg">+ Add permissions</b>, search for{" "}
            <b className="text-fg">Actions</b> (not Workflows or Secrets),
            add it, then set access to <b className="text-fg">Read and write</b>
          </li>
          <li>
            <b className="text-fg">Metadata</b> — Read-only (default)
          </li>
        </ul>
        <p className="mt-2 text-[12.5px]">
          <code className="text-fg">workflow_dispatch</code> needs the{" "}
          <b className="text-fg">Actions</b> permission per{" "}
          <a
            className="text-blue underline"
            href="https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens"
            rel="noopener noreferrer"
            target="_blank"
          >
            GitHub&apos;s PAT docs
          </a>
          . <b className="text-fg">Workflows</b> is for editing{" "}
          <code className="text-fg">.github/workflows/</code> files;{" "}
          <b className="text-fg">Secrets</b> is for managing repo secrets via
          the API — neither triggers runs.
        </p>
      </div>

      {configured ? (
        <div className={`${CALLOUT} ${CALLOUT_TONE.green}`}>
          <CheckCircleIcon />
          <div>
            GitHub PAT already saved
            {tokenLast4 !== undefined ? (
              <>
                {" "}
                (ending in <code>{tokenLast4}</code>)
              </>
            ) : null}
            . Paste a new token below to replace it, or click Next to keep the
            existing one.
          </div>
        </div>
      ) : null}

      <label className={FIELD}>
        <span className={FIELD_LABEL}>GitHub personal access token</span>
        <input
          type="password"
          autoComplete="off"
          className={`${INPUT} ${INPUT_STATE.normal}`}
          placeholder={configured ? "Paste only to replace the saved token" : "ghp_… or github_pat_…"}
          value={patToken}
          onChange={(event) => onPatTokenChange(event.target.value)}
        />
        <span className={FIELD_HINT}>
          Stored encrypted on the server; never shown again after save.
        </span>
      </label>

      <div className={`${CALLOUT} ${CALLOUT_TONE.info}`}>
        <InfoIcon />
        <div>
          This is <b>not</b> the same as <code>CODEMAGIC_PATCH_TOKEN</code> in
          your repo secrets — that one lets GitHub call Patch; this one lets
          Patch call GitHub.
        </div>
      </div>
    </div>
  );
}

function FinishStep({
  defaultRef,
  owner,
  patConfigured,
  repo,
  workflowFile,
  onSubmit,
}: {
  defaultRef: string;
  owner: string;
  patConfigured: boolean;
  repo: string;
  workflowFile: string;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <form
      className="flex flex-col gap-4 text-[14px] text-fg-2"
      id="github-actions-finish-form"
      onSubmit={onSubmit}
    >
      <p>
        When you save, Patch will dispatch{" "}
        <code className="text-fg">{workflowFile}</code> on branch{" "}
        <code className="text-fg">{defaultRef}</code> in{" "}
        <b className="text-fg">
          {owner.trim()}/{repo.trim()}
        </b>{" "}
        when you click <b className="text-fg">Run in GitHub</b>.
      </p>
      <ul className="list-disc space-y-1.5 pl-5">
        <li>
          Workflow committed to{" "}
          <code className="text-fg">
            .github/workflows/{workflowFile}
          </code>
        </li>
        <li>Repository secrets added on GitHub</li>
        <li>
          GitHub PAT {patConfigured ? "saved in Patch" : "not saved yet"}
        </li>
      </ul>
      {!patConfigured ? (
        <div className={`${CALLOUT} ${CALLOUT_TONE.warn}`}>
          <AlertIcon />
          <div>
            No GitHub PAT is saved yet. Go back to save one, or dispatch from
            the dashboard will fail.
          </div>
        </div>
      ) : null}
    </form>
  );
}

function ExternalLink({
  children,
  href,
}: {
  children: ReactNode;
  href: string;
}) {
  return (
    <a
      className={`${buttonVariants({ intent: "ghost", size: "sm" })} self-start`}
      href={href}
      rel="noopener noreferrer"
      target="_blank"
    >
      {children} <ExternalLinkIcon />
    </a>
  );
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

function GitHubIcon() {
  return (
    <IconSvg>
      <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48 0-.24-.01-.87-.01-1.7-2.78.6-3.37-1.34-3.37-1.34-.45-1.15-1.1-1.46-1.1-1.46-.9-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.89 1.52 2.34 1.08 2.91.83.09-.65.35-1.08.63-1.33-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02A9.58 9.58 0 0 1 12 6.8c.85.004 1.71.11 2.51.33 1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85 0 1.33-.01 2.4-.01 2.73 0 .27.18.58.69.48A10 10 0 0 0 12 2Z" />
    </IconSvg>
  );
}

function WorkflowIcon() {
  return (
    <IconSvg>
      <path d="M12 3v6m0 6v6" />
      <circle cx="12" cy="12" r="3" />
      <path d="M5.5 8.5 9 10.5M15 13.5l3.5 2M18.5 8.5 15 10.5M9 13.5 5.5 15.5" />
    </IconSvg>
  );
}

function KeyIcon() {
  return (
    <IconSvg>
      <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4" />
    </IconSvg>
  );
}

function CheckCircleIcon() {
  return (
    <IconSvg>
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </IconSvg>
  );
}

function InfoIcon() {
  return (
    <IconSvg>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </IconSvg>
  );
}

function AlertIcon() {
  return (
    <IconSvg>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </IconSvg>
  );
}

function BackIcon() {
  return (
    <IconSvg>
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
    </IconSvg>
  );
}

function ExternalLinkIcon() {
  return (
    <IconSvg>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </IconSvg>
  );
}
