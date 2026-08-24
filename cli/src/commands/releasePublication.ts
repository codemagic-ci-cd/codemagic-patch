import type { ReleaseSafetyPolicy } from "@codemagic/patch-shared";

import { isRecord } from "../output";
import { getProblemTypeSuffix, HttpProblemError } from "../problem-details";
import {
  canPromptOnStderr,
  type CommandDeps,
  DeclinedError,
} from "./shared";
import type { InteractionContext } from "./releaseExecution";

type PublicationApproval = "fingerprint-mismatch";

export type ReleasePublicationAttempt = {
  idempotencyKey: string;
  safetyPolicy: ReleaseSafetyPolicy;
};

export type ReleasePublicationInput = {
  allowFingerprintMismatch: boolean;
  duplicateRelease: ReleaseSafetyPolicy["duplicateRelease"];
  interaction: InteractionContext;
  onPrompt?: () => void;
  onRetry?: () => void;
  upload: (attempt: ReleasePublicationAttempt) => Promise<unknown>;
};

type FingerprintConflict = {
  binaryVersion: string;
  releaseFingerprint: string;
  storedFingerprint: string;
};

export async function executeReleasePublication(
  deps: CommandDeps,
  input: ReleasePublicationInput,
): Promise<unknown> {
  const approvals = new Set<PublicationApproval>();

  for (;;) {
    const fingerprintMismatch =
      input.allowFingerprintMismatch || approvals.has("fingerprint-mismatch")
        ? "allow"
        : "block";

    try {
      const result = await input.upload({
        idempotencyKey: deps.randomUUID(),
        safetyPolicy: {
          duplicateRelease: input.duplicateRelease,
          fingerprintMismatch,
        },
      });
      return approvals.has("fingerprint-mismatch")
        ? withoutApprovedFingerprintWarning(result)
        : result;
    } catch (error) {
      if (!(error instanceof HttpProblemError)) {
        throw error;
      }

      const type = getProblemTypeSuffix(error.problem.type);
      if (type === "duplicate-release") {
        throw withPublicationHint(
          error,
          approvals.has("fingerprint-mismatch")
            ? "The fingerprint mismatch was approved, but the retry found a duplicate release. Re-run with both --allow-fingerprint-mismatch and --no-duplicate-release-error after verifying both conditions."
            : "Re-run with --no-duplicate-release-error after verifying that accepting the duplicate is intended.",
        );
      }

      if (type !== "fingerprint-disagreement" || fingerprintMismatch === "allow") {
        throw error;
      }

      // The hint applies to every blocked fingerprint disagreement; the prompt
      // additionally needs the complete evidence fields to show.
      const conflict = readFingerprintConflict(error);
      if (
        conflict === null ||
        input.interaction.explicitYes ||
        input.interaction.machineOutput ||
        input.interaction.mode !== "interactive" ||
        !canPromptOnStderr(deps, false) ||
        deps.confirm === undefined
      ) {
        throw withPublicationHint(
          error,
          "Re-run with --allow-fingerprint-mismatch after verifying the installed and release fingerprints.",
        );
      }

      input.onPrompt?.();
      const confirmed = await deps.confirm({
        initial: false,
        message: [
          `The release fingerprint does not match the installed fingerprint for ${conflict.binaryVersion}.`,
          `Installed: ${conflict.storedFingerprint}`,
          `Release: ${conflict.releaseFingerprint}`,
          "Publish this release anyway?",
        ].join("\n"),
      });
      if (!confirmed) {
        throw new DeclinedError(
          "Aborted: the fingerprint mismatch was not approved.",
        );
      }

      approvals.add("fingerprint-mismatch");
      input.onRetry?.();
    }
  }
}

function readFingerprintConflict(
  error: HttpProblemError,
): FingerprintConflict | null {
  if (
    typeof error.problem.binary_version !== "string" ||
    typeof error.problem.stored_fingerprint !== "string" ||
    typeof error.problem.release_fingerprint !== "string"
  ) {
    return null;
  }

  return {
    binaryVersion: error.problem.binary_version,
    releaseFingerprint: error.problem.release_fingerprint,
    storedFingerprint: error.problem.stored_fingerprint,
  };
}

function withPublicationHint(
  error: HttpProblemError,
  hint: string,
): HttpProblemError {
  return new HttpProblemError(
    { ...error.problem, hint },
    error.responseStatus,
    error.serverUrl,
  );
}

function withoutApprovedFingerprintWarning(result: unknown): unknown {
  if (!isRecord(result) || !Array.isArray(result.warnings)) {
    return result;
  }

  return {
    ...result,
    warnings: result.warnings.filter(
      (warning) =>
        !isRecord(warning) || warning.code !== "fingerprint-disagreement",
    ),
  };
}
