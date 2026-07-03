// New-release wizard: pick Via CLI or Bundle upload, then follow that path
// inside one modal. Replaces the separate header upload button + inline CLI
// builder on the deployment detail page.

import { useState } from "react";
import type { ReactNode } from "react";

import { Modal } from "../../../components/overlay/Modal";
import { CliCommandBuilder } from "../../../components/ui/CliCommandBuilder";
import { buttonVariants } from "../../../components/ui/Button";
import { RC_DESC, RC_TITLE, RADIO_CARD, RADIO_CARD_STATE } from "../../../components/ui/form";
import { UploadIcon, useUploadArtifactForm } from "./uploadArtifactForm";
import { useRunGitHubReleaseForm } from "./runGitHubReleaseForm";

type Step = "choose" | "cli" | "upload" | "github";

export interface NewReleaseModalProps {
  open: boolean;
  deploymentId: string;
  deploymentName: string;
  serverUrl: string;
  appName: string;
  suggestedTargetBinaryVersion?: string;
  codeSigningRequired?: boolean;
  teamId: string;
  onOpenGitHubConfigure: () => void;
  onClose: () => void;
}

export function NewReleaseModal({
  open,
  deploymentId,
  deploymentName,
  serverUrl,
  appName,
  suggestedTargetBinaryVersion = "",
  codeSigningRequired = false,
  teamId,
  onOpenGitHubConfigure,
  onClose,
}: NewReleaseModalProps) {
  if (!open) {
    return null;
  }
  return (
    <NewReleaseModalContent
      deploymentId={deploymentId}
      deploymentName={deploymentName}
      serverUrl={serverUrl}
      appName={appName}
      suggestedTargetBinaryVersion={suggestedTargetBinaryVersion}
      codeSigningRequired={codeSigningRequired}
      teamId={teamId}
      onOpenGitHubConfigure={onOpenGitHubConfigure}
      onClose={onClose}
    />
  );
}

function NewReleaseModalContent({
  deploymentId,
  deploymentName,
  serverUrl,
  appName,
  suggestedTargetBinaryVersion,
  codeSigningRequired,
  teamId,
  onOpenGitHubConfigure,
  onClose,
}: Omit<NewReleaseModalProps, "open">) {
  // No step/form reset on close: the wrapper unmounts this component while
  // closed, so all wizard state starts fresh on every open.
  const [step, setStep] = useState<Step>("choose");

  const uploadForm = useUploadArtifactForm({
    deploymentId,
    deploymentName,
    onComplete: onClose,
  });
  const githubForm = useRunGitHubReleaseForm({
    deploymentId,
    onComplete: onClose,
    onOpenConfigure: onOpenGitHubConfigure,
    suggestedTargetBinaryVersion,
    teamId,
  });

  const handleClose = () => {
    if (uploadForm.busy || githubForm.busy) {
      return;
    }
    onClose();
  };

  const goBack = () => {
    if (uploadForm.busy || githubForm.busy) {
      return;
    }
    if (step === "upload") {
      uploadForm.reset();
    }
    if (step === "github") {
      githubForm.reset();
    }
    setStep("choose");
  };

  const header = stepMeta(step, deploymentName);
  const footer = footerForStep(step, {
    githubFooter: githubForm.footer,
    githubBusy: githubForm.busy,
    onClose: handleClose,
    onBack: goBack,
    uploadFooter: uploadForm.footer,
    uploadBusy: uploadForm.busy,
  });

  return (
    <Modal
      open
      onClose={handleClose}
      title={header.title}
      description={header.description}
      icon={header.icon}
      wide={step !== "choose"}
      footer={footer}
    >
      {step === "choose" ? (
        <div className="flex flex-col gap-2.5">
          <button
            type="button"
            className={`${RADIO_CARD} ${RADIO_CARD_STATE.idle} text-left`}
            onClick={() => setStep("cli")}
          >
            <span className="mt-0.5 size-[18px] shrink-0 text-blue" aria-hidden="true">
              <TerminalIcon />
            </span>
            <div>
              <div className={RC_TITLE}>Via CLI</div>
              <div className={RC_DESC}>
                Build and publish in one step with{" "}
                <code className="rounded bg-surface-3 px-1 py-0.5">
                  cmpatch release-react
                </code>{" "}
                from your machine or CI.
              </div>
            </div>
          </button>
          <button
            type="button"
            className={`${RADIO_CARD} ${RADIO_CARD_STATE.idle} text-left`}
            onClick={() => setStep("upload")}
          >
            <span className="mt-0.5 size-[18px] shrink-0 text-blue" aria-hidden="true">
              <UploadIcon />
            </span>
            <div>
              <div className={RC_TITLE}>Bundle upload</div>
              <div className={RC_DESC}>
                Drop a pre-built{" "}
                <code className="rounded bg-surface-3 px-1 py-0.5">.cmpatch</code>{" "}
                artifact from{" "}
                <code className="rounded bg-surface-3 px-1 py-0.5">cmpatch bundle</code>.
              </div>
            </div>
          </button>
          <button
            type="button"
            className={`${RADIO_CARD} ${RADIO_CARD_STATE.idle} text-left`}
            onClick={() => setStep("github")}
          >
            <span className="mt-0.5 size-[18px] shrink-0 text-blue" aria-hidden="true">
              <GitHubIcon />
            </span>
            <div>
              <div className={RC_TITLE}>GitHub Actions</div>
              <div className={RC_DESC}>
                Trigger your linked release workflow on GitHub with platform and
                target binary settings.
              </div>
            </div>
          </button>
        </div>
      ) : null}

      {step === "cli" ? (
        <CliCommandBuilder
          serverUrl={serverUrl}
          appName={appName}
          deploymentName={deploymentName}
          suggestedTargetBinaryVersion={suggestedTargetBinaryVersion}
          codeSigningRequired={codeSigningRequired}
        />
      ) : null}

      {step === "upload" ? uploadForm.content : null}

      {step === "github" ? githubForm.content : null}
    </Modal>
  );
}

function stepMeta(
  step: Step,
  deploymentName: string,
): { title: string; description?: string; icon: ReactNode } {
  switch (step) {
    case "cli":
      return {
        title: `Release via CLI to ${deploymentName}`,
        description:
          "Copy the command below and run it from your project directory or CI pipeline.",
        icon: <TerminalIcon />,
      };
    case "upload":
      return {
        title: `Upload a release to ${deploymentName}`,
        description:
          "Drop a .cmpatch artifact built with `cmpatch bundle`. The bundle and its signature are uploaded as-is.",
        icon: <UploadIcon />,
      };
    case "github":
      return {
        title: `Release via GitHub Actions to ${deploymentName}`,
        description:
          "Pick the platform and target binary version, then start the linked workflow.",
        icon: <GitHubIcon />,
      };
    default:
      return {
        title: `New release to ${deploymentName}`,
        description: "Choose how you want to publish an update to this deployment.",
        icon: <RocketIcon />,
      };
  }
}

function footerForStep(
  step: Step,
  options: {
    githubBusy: boolean;
    githubFooter: ReactNode;
    onClose: () => void;
    onBack: () => void;
    uploadFooter: ReactNode;
    uploadBusy: boolean;
  },
): ReactNode {
  if (step === "choose") {
    return (
      <button
        type="button"
        className={buttonVariants({ intent: "subtle" })}
        onClick={options.onClose}
      >
        Cancel
      </button>
    );
  }

  if (step === "cli") {
    return (
      <>
        <button
          type="button"
          className={buttonVariants({ intent: "ghost" })}
          onClick={options.onBack}
        >
          <BackIcon /> Back
        </button>
        <button
          type="button"
          className={buttonVariants({ intent: "subtle" })}
          onClick={options.onClose}
        >
          Close
        </button>
      </>
    );
  }

  if (step === "github") {
    return (
      <>
        <button
          type="button"
          className={buttonVariants({ intent: "ghost" })}
          onClick={options.onBack}
          disabled={options.githubBusy}
        >
          <BackIcon /> Back
        </button>
        {options.githubFooter}
      </>
    );
  }

  return (
    <>
      <button
        type="button"
        className={buttonVariants({ intent: "ghost" })}
        onClick={options.onBack}
        disabled={options.uploadBusy}
      >
        <BackIcon /> Back
      </button>
      {options.uploadFooter}
    </>
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

function RocketIcon() {
  return (
    <IconSvg>
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
      <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </IconSvg>
  );
}

function TerminalIcon() {
  return (
    <IconSvg>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
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

function GitHubIcon() {
  return (
    <IconSvg>
      <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48 0-.24-.01-.87-.01-1.7-2.78.6-3.37-1.34-3.37-1.34-.45-1.15-1.1-1.46-1.1-1.46-.9-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.89 1.52 2.34 1.08 2.91.83.09-.65.35-1.08.63-1.33-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02A9.58 9.58 0 0 1 12 6.8c.85.004 1.71.11 2.51.33 1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85 0 1.33-.01 2.4-.01 2.73 0 .27.18.58.69.48A10 10 0 0 0 12 2Z" />
    </IconSvg>
  );
}
