// Upload-a-release modal: drag/drop or pick a .cmpatch artifact, parse it in
// the browser via the shared parseArtifact, review the descriptor, edit the
// upload policy (seeded from the artifact's baked-in defaults), and POST it as
// multipart via useCreateReleaseFromArtifact — the same body the CLI sends, so
// the server is untouched. Mounted only while open, so form + mutation state
// reset on every reopen. `409 duplicate-release` mirrors PromoteModal: an inline
// "Upload anyway" resubmits with no_duplicate_release_error.

import { Modal } from "../../../components/overlay/Modal";
import { UploadIcon, useUploadArtifactForm } from "./uploadArtifactForm";

export interface UploadArtifactModalProps {
  open: boolean;
  deploymentId: string;
  deploymentName: string;
  onClose: () => void;
}

export function UploadArtifactModal({
  open,
  deploymentId,
  deploymentName,
  onClose,
}: UploadArtifactModalProps) {
  if (!open) {
    return null;
  }
  return (
    <UploadArtifactModalContent
      deploymentId={deploymentId}
      deploymentName={deploymentName}
      onClose={onClose}
    />
  );
}

function UploadArtifactModalContent({
  deploymentId,
  deploymentName,
  onClose,
}: {
  deploymentId: string;
  deploymentName: string;
  onClose: () => void;
}) {
  const form = useUploadArtifactForm({
    deploymentId,
    deploymentName,
    onComplete: onClose,
  });

  const requestClose = () => {
    if (!form.busy) {
      onClose();
    }
  };

  return (
    <Modal
      open
      onClose={requestClose}
      title={`Upload a release to ${deploymentName}`}
      description="Drop a .cmpatch artifact built with `cmpatch bundle`. The bundle and its signature are uploaded as-is."
      icon={<UploadIcon />}
      wide
      footer={form.footer}
    >
      {form.content}
    </Modal>
  );
}
