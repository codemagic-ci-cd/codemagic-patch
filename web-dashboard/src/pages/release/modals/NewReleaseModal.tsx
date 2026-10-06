// New-release wizard: pick Via CLI or Bundle upload, then follow that path
// inside one modal. Replaces the separate header upload button + inline CLI
// builder on the deployment detail page. What the wizard offers depends on the
// app's framework — see offersBundleUpload.

import { useState } from "react";
import type { ReactNode } from "react";

import { Modal } from "../../../components/overlay/Modal";
import {
  CliCommandBuilder,
  type CliBuilderFramework,
} from "../../../components/ui/CliCommandBuilder";
import { buttonVariants } from "../../../components/ui/Button";
import {
  RC_DESC,
  RC_TITLE,
  RADIO_CARD,
  RADIO_CARD_STATE,
} from "../../../components/ui/form";
import { isKnownFramework, offersBundleUpload } from "../../../model/framework";
import { UploadIcon, useUploadArtifactForm } from "./uploadArtifactForm";

type Step = "choose" | "cli" | "upload";

// A framework with no bundle upload has one publishing path, so nothing to choose:
// it goes straight to its CLI. One this build does not know has no builder either.
function cliBuilderFramework(framework: string): CliBuilderFramework | null {
  return isKnownFramework(framework) ? framework : null;
}

export interface NewReleaseModalProps {
  open: boolean;
  deploymentId: string;
  deploymentName: string;
  /** The app's framework; an unknown value gets neutral guidance. */
  framework: string;
  serverUrl: string;
  appName: string;
  suggestedTargetBinaryVersion?: string;
  codeSigningRequired?: boolean;
  onClose: () => void;
}

export function NewReleaseModal({
  open,
  deploymentId,
  deploymentName,
  framework,
  serverUrl,
  appName,
  suggestedTargetBinaryVersion = "",
  codeSigningRequired = false,
  onClose,
}: NewReleaseModalProps) {
  if (!open) {
    return null;
  }
  return (
    <NewReleaseModalContent
      deploymentId={deploymentId}
      deploymentName={deploymentName}
      framework={framework}
      serverUrl={serverUrl}
      appName={appName}
      suggestedTargetBinaryVersion={suggestedTargetBinaryVersion}
      codeSigningRequired={codeSigningRequired}
      onClose={onClose}
    />
  );
}

function NewReleaseModalContent({
  deploymentId,
  deploymentName,
  framework,
  serverUrl,
  appName,
  suggestedTargetBinaryVersion,
  codeSigningRequired,
  onClose,
}: Omit<NewReleaseModalProps, "open">) {
  const canChoose = offersBundleUpload(framework);
  // No step/form reset on close: the wrapper unmounts this component while
  // closed, so all wizard state starts fresh on every open.
  const [step, setStep] = useState<Step>(canChoose ? "choose" : "cli");

  const uploadForm = useUploadArtifactForm({
    deploymentId,
    deploymentName,
    onComplete: onClose,
  });

  const handleClose = () => {
    if (uploadForm.busy) {
      return;
    }
    onClose();
  };

  const goBack = () => {
    if (uploadForm.busy) {
      return;
    }
    if (step === "upload") {
      uploadForm.reset();
    }
    setStep("choose");
  };

  const builderFramework = cliBuilderFramework(framework);
  const header = stepMeta(step, deploymentName, builderFramework);
  const footer = footerForStep(step, {
    canGoBack: canChoose,
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
      notice={step === "upload" ? uploadForm.notice : undefined}
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
            <span
              className="mt-0.5 size-[18px] shrink-0 text-blue"
              aria-hidden="true"
            >
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
            <span
              className="mt-0.5 size-[18px] shrink-0 text-blue"
              aria-hidden="true"
            >
              <UploadIcon />
            </span>
            <div>
              <div className={RC_TITLE}>Bundle upload</div>
              <div className={RC_DESC}>
                Drop a pre-built{" "}
                <code className="rounded bg-surface-3 px-1 py-0.5">
                  .cmpatch
                </code>{" "}
                artifact from{" "}
                <code className="rounded bg-surface-3 px-1 py-0.5">
                  cmpatch bundle
                </code>
                .
              </div>
            </div>
          </button>
        </div>
      ) : null}

      {step === "cli" ? (
        builderFramework === null ? (
          <p className="m-0 text-[13.5px] leading-relaxed text-fg-2">
            Publish an update to this deployment with the CLI for this app&apos;s
            framework, pointed at {serverUrl}.
          </p>
        ) : (
          <CliCommandBuilder
            framework={builderFramework}
            serverUrl={serverUrl}
            appName={appName}
            deploymentName={deploymentName}
            suggestedTargetBinaryVersion={suggestedTargetBinaryVersion}
            codeSigningRequired={codeSigningRequired}
          />
        )
      ) : null}

      {step === "upload" ? uploadForm.content : null}
    </Modal>
  );
}

function stepMeta(
  step: Step,
  deploymentName: string,
  builderFramework: CliBuilderFramework | null,
): { title: string; description?: string } {
  switch (step) {
    case "cli":
      return {
        title: `Release via CLI to ${deploymentName}`,
        // No builder, no command to point at: the body says what there is to say.
        ...(builderFramework === null
          ? {}
          : {
              description:
                "Copy the command below and run it from your project directory or CI pipeline.",
            }),
      };
    case "upload":
      return {
        title: `Upload a release to ${deploymentName}`,
        description:
          "Drop a .cmpatch artifact built with `cmpatch bundle`. The bundle and its signature are uploaded as-is.",
      };
    default:
      return {
        title: `New release to ${deploymentName}`,
        description:
          "Choose how you want to publish an update to this deployment.",
      };
  }
}

function footerForStep(
  step: Step,
  options: {
    /** False when the wizard opened straight into a step: nothing to go back to. */
    canGoBack: boolean;
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

  const backButton = options.canGoBack ? (
    <button
      type="button"
      className={buttonVariants({ intent: "ghost" })}
      onClick={options.onBack}
      disabled={step === "upload" && options.uploadBusy}
    >
      <BackIcon /> Back
    </button>
  ) : null;

  if (step === "cli") {
    return (
      <>
        {backButton}
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

  return (
    <>
      {backButton}
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
