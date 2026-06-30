import type {
  DeploymentRollbackHandlerInput,
  ReleaseCreationHandlerInput,
  ReleasePromoteHandlerInput,
} from "../../app/types";

export function releaseCreationIdempotencyFingerprint(
  input: ReleaseCreationHandlerInput,
): Record<string, unknown> {
  return {
    createdBy: input.createdBy,
    deploymentId: input.deploymentId,
    disabled: input.disabled,
    fingerprint: input.fingerprint,
    isMandatory: input.isMandatory,
    noDuplicateReleaseError: input.noDuplicateReleaseError,
    releaseNotes: input.releaseNotes,
    rolloutPercentage: input.rolloutPercentage,
    signature: input.signature,
    signatureHashAlgorithm: input.signatureHashAlgorithm,
    targetBinaryVersion: input.targetBinaryVersion,
    targetPackageHash: input.targetPackageHash,
  };
}

export function releasePromoteIdempotencyFingerprint(
  input: ReleasePromoteHandlerInput,
): Record<string, unknown> {
  return {
    createdBy: input.createdBy,
    destinationDeploymentId: input.destinationDeploymentId,
    disabled: input.disabled,
    isMandatory: input.isMandatory,
    noDuplicateReleaseError: input.noDuplicateReleaseError,
    releaseNotes: input.releaseNotes,
    rolloutPercentage: input.rolloutPercentage,
    sourceReleaseId: input.sourceReleaseId,
    targetBinaryVersion: input.targetBinaryVersion,
  };
}

export function deploymentRollbackIdempotencyFingerprint(
  input: DeploymentRollbackHandlerInput,
): Record<string, unknown> {
  return {
    createdBy: input.createdBy,
    deploymentId: input.deploymentId,
    targetReleaseLabel: input.targetReleaseLabel,
  };
}
