import { isValidBinaryVersion } from "./binaryVersion";
import {
  createProblem,
  type ProblemDetails,
  type ProblemFieldError,
} from "../../app/problemDetails";
import type {
  DeploymentRollbackHandlerInput,
  ReleaseCreationHandlerInput,
  ReleasePatchHandlerInput,
  ReleasePromoteHandlerInput,
} from "../../app/types";
import {
  INVALID_BINARY_VERSION_ERROR,
  INVALID_RELEASE_LIST_LIMIT_ERROR,
  INVALID_RELEASE_LIST_OFFSET_ERROR,
  INVALID_RELEASE_PATCH_MANDATORY_ERROR,
  INVALID_RELEASE_PATCH_NOTES_ERROR,
  INVALID_RELEASE_PATCH_STATUS_COMBINATION_ERROR,
  INVALID_RELEASE_PATCH_STATUS_ERROR,
  INVALID_RELEASE_PROMOTE_DISABLED_ERROR,
  INVALID_RELEASE_PROMOTE_NO_DUPLICATE_ERROR,
  INVALID_RELEASE_ROLLOUT_ERROR,
  INVALID_RELEASE_SIGNATURE_HASH_ALGORITHM_ERROR,
  MISSING_RELEASE_METADATA_FIELDS_ERROR,
  SIGNED_RELEASE_SIGNATURE_HASH_ALGORITHM,
  UNSUPPORTED_RELEASE_LIST_INCLUDE_ERROR,
} from "./routeConstants";
import {
  fieldError,
  isJsonObject,
  parseBoundedIntegerQueryParam,
  parseRequiredTrimmedString,
  requiredStringFieldError,
  requiredStringReason,
  rolloutPercentageReason,
  singleFieldValidationProblem,
  validationProblem,
} from "./routeValidation";
import type {
  PaginationQuery,
  ReleaseListQuery,
  ReleasePatchBody,
} from "./routeTypes";
import { createReleaseId, createReleaseJobId } from "./releaseIds";

export interface ReleaseCreationMetadata {
  disabled: boolean;
  fingerprint: string | null;
  isMandatory: boolean;
  noDuplicateReleaseError: boolean;
  releaseNotes: string | null;
  rolloutPercentage: number;
  signature: string | null;
  signatureHashAlgorithm: string | null;
  targetBinaryVersion: string;
}

export function parseReleaseCreationMetadata(
  body: Record<string, unknown> | undefined,
):
  | {
      kind: "error";
      problem: ProblemDetails;
    }
  | {
      kind: "success";
      value: ReleaseCreationMetadata;
    } {
  const missingMetadataErrors = [
    requiredStringFieldError(
      "metadata.target_binary_version",
      body?.target_binary_version,
      "target_binary_version is required",
    ),
    requiredStringFieldError(
      "metadata.fingerprint",
      body?.fingerprint,
      "fingerprint is required",
    ),
  ].filter((error): error is ProblemFieldError => error !== null);

  if (missingMetadataErrors.length > 0) {
    return {
      kind: "error",
      problem: validationProblem(
        MISSING_RELEASE_METADATA_FIELDS_ERROR,
        missingMetadataErrors,
      ),
    };
  }

  const metadataBody = body!;
  const targetBinaryVersion = metadataBody.target_binary_version as string;
  const fingerprint = metadataBody.fingerprint as string;

  if (!isValidBinaryVersion(targetBinaryVersion)) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        INVALID_BINARY_VERSION_ERROR,
        "metadata.target_binary_version",
        "invalid_format",
      ),
    };
  }

  const rolloutPercentage =
    metadataBody.rollout_percentage === undefined
      ? 100
      : metadataBody.rollout_percentage;
  if (
    typeof rolloutPercentage !== "number" ||
    !Number.isInteger(rolloutPercentage) ||
    rolloutPercentage < 1 ||
    rolloutPercentage > 100
  ) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        INVALID_RELEASE_ROLLOUT_ERROR,
        "metadata.rollout_percentage",
        rolloutPercentageReason(rolloutPercentage),
      ),
    };
  }

  if (
    metadataBody.signature_hash_algorithm !== undefined &&
    metadataBody.signature_hash_algorithm !== null &&
    (typeof metadataBody.signature !== "string" ||
      metadataBody.signature.length === 0)
  ) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        INVALID_RELEASE_SIGNATURE_HASH_ALGORITHM_ERROR,
        "metadata.signature",
        "required",
      ),
    };
  }

  const signature =
    typeof metadataBody.signature === "string" && metadataBody.signature.length > 0
      ? metadataBody.signature
      : null;

  return {
    kind: "success",
    value: {
      disabled: metadataBody.disabled === true,
      fingerprint,
      isMandatory: metadataBody.is_mandatory === true,
      noDuplicateReleaseError:
        metadataBody.no_duplicate_release_error === true,
      releaseNotes:
        typeof metadataBody.release_notes === "string"
          ? metadataBody.release_notes
          : null,
      rolloutPercentage,
      signature,
      signatureHashAlgorithm:
        signature === null ? null : SIGNED_RELEASE_SIGNATURE_HASH_ALGORITHM,
      targetBinaryVersion,
    },
  };
}

export function buildReleaseCreationInput(
  deploymentId: string,
  createdBy: string | null,
  metadata: ReleaseCreationMetadata,
  releaseId: string,
  jobId: string,
  bundleStorageKey: string,
  sourceMapStorageKey: string | null,
  targetPackageHash: string,
): ReleaseCreationHandlerInput {
  return {
    bundleStorageKey,
    createdBy,
    deploymentId,
    disabled: metadata.disabled,
    fingerprint: metadata.fingerprint,
    isMandatory: metadata.isMandatory,
    jobId,
    noDuplicateReleaseError: metadata.noDuplicateReleaseError,
    releaseId,
    releaseNotes: metadata.releaseNotes,
    rolloutPercentage: metadata.rolloutPercentage,
    sourceMapStorageKey,
    signature: metadata.signature,
    signatureHashAlgorithm: metadata.signatureHashAlgorithm,
    targetBinaryVersion: metadata.targetBinaryVersion,
    targetPackageHash,
  };
}

export function parseReleasePatchInput(
  releaseId: string,
  body: unknown,
  createdBy: string | null,
):
  | {
      kind: "error";
      problem: ProblemDetails;
    }
  | {
      kind: "not_modified";
    }
  | {
      kind: "success";
      value: ReleasePatchHandlerInput;
    } {
  if (body === undefined) {
    return {
      kind: "not_modified",
    };
  }

  if (!isReleasePatchBody(body)) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "release patch body must be a JSON object",
        "body",
        "invalid_type",
      ),
    };
  }

  const hasStatus = Object.hasOwn(body, "status");
  const hasRolloutPercentage = Object.hasOwn(body, "rollout_percentage");
  const hasIsMandatory = Object.hasOwn(body, "is_mandatory");
  const hasReleaseNotes = Object.hasOwn(body, "release_notes");
  const hasTargetBinaryVersion = Object.hasOwn(body, "target_binary_version");
  const recognizedFieldCount = [
    hasStatus,
    hasRolloutPercentage,
    hasIsMandatory,
    hasReleaseNotes,
    hasTargetBinaryVersion,
  ].filter(Boolean).length;

  if (recognizedFieldCount === 0) {
    return {
      kind: "not_modified",
    };
  }

  if (hasStatus && recognizedFieldCount > 1) {
    return {
      kind: "error",
      problem: createProblem({
        detail: INVALID_RELEASE_PATCH_STATUS_COMBINATION_ERROR,
        extensions: {
          errors: [
            fieldError(
              "status",
              "invalid_combination",
              INVALID_RELEASE_PATCH_STATUS_COMBINATION_ERROR,
            ),
          ],
        },
        status: 400,
        typeSuffix: "status-transition-conflict",
      }),
    };
  }

  if (
    hasStatus &&
    body?.status !== "published" &&
    body?.status !== "disabled"
  ) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        INVALID_RELEASE_PATCH_STATUS_ERROR,
        "status",
        typeof body?.status === "string" ? "invalid_value" : "invalid_type",
      ),
    };
  }

  if (
    hasRolloutPercentage &&
    (typeof body?.rollout_percentage !== "number" ||
      !Number.isInteger(body.rollout_percentage) ||
      body.rollout_percentage < 1 ||
      body.rollout_percentage > 100)
  ) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        INVALID_RELEASE_ROLLOUT_ERROR,
        "rollout_percentage",
        rolloutPercentageReason(body?.rollout_percentage),
      ),
    };
  }

  if (hasIsMandatory && typeof body?.is_mandatory !== "boolean") {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        INVALID_RELEASE_PATCH_MANDATORY_ERROR,
        "is_mandatory",
        "invalid_type",
      ),
    };
  }

  if (
    hasReleaseNotes &&
    body?.release_notes !== null &&
    typeof body?.release_notes !== "string"
  ) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        INVALID_RELEASE_PATCH_NOTES_ERROR,
        "release_notes",
        "invalid_type",
      ),
    };
  }

  if (
    hasTargetBinaryVersion &&
    (typeof body?.target_binary_version !== "string" ||
      body.target_binary_version.length === 0 ||
      !isValidBinaryVersion(body.target_binary_version))
  ) {
    const reason =
      typeof body?.target_binary_version === "string" &&
      body.target_binary_version.length > 0
        ? "invalid_format"
        : requiredStringReason(body?.target_binary_version);

    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        INVALID_BINARY_VERSION_ERROR,
        "target_binary_version",
        reason,
      ),
    };
  }

  return {
    kind: "success",
    value: {
      createdBy,
      isMandatory: hasIsMandatory ? body?.is_mandatory : undefined,
      jobId: createReleaseJobId(),
      releaseId,
      releaseNotes: hasReleaseNotes ? (body?.release_notes ?? null) : undefined,
      rolloutPercentage: hasRolloutPercentage
        ? body?.rollout_percentage
        : undefined,
      status: hasStatus
        ? (body?.status as "disabled" | "published")
        : undefined,
      targetBinaryVersion: hasTargetBinaryVersion
        ? body?.target_binary_version
        : undefined,
    },
  };
}

export function parseReleasePromoteInput(
  sourceReleaseId: string,
  body: unknown,
  createdBy: string | null,
):
  | {
      kind: "error";
      problem: ProblemDetails;
    }
  | {
      kind: "success";
      value: ReleasePromoteHandlerInput;
    } {
  if (!isJsonObject(body)) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "release promote body must be a JSON object",
        "body",
        "invalid_type",
      ),
    };
  }

  const destinationDeploymentId = parseRequiredTrimmedString(
    body.destination_deployment_id,
  );
  if (destinationDeploymentId === null) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "destination_deployment_id must be a non-empty string",
        "destination_deployment_id",
        requiredStringReason(body.destination_deployment_id),
      ),
    };
  }

  const rolloutPercentage =
    body.rollout_percentage === undefined ? 100 : body.rollout_percentage;
  if (
    typeof rolloutPercentage !== "number" ||
    !Number.isInteger(rolloutPercentage) ||
    rolloutPercentage < 1 ||
    rolloutPercentage > 100
  ) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        INVALID_RELEASE_ROLLOUT_ERROR,
        "rollout_percentage",
        rolloutPercentageReason(rolloutPercentage),
      ),
    };
  }

  if (
    body.is_mandatory !== undefined &&
    typeof body.is_mandatory !== "boolean"
  ) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        INVALID_RELEASE_PATCH_MANDATORY_ERROR,
        "is_mandatory",
        "invalid_type",
      ),
    };
  }

  if (
    body.release_notes !== undefined &&
    body.release_notes !== null &&
    typeof body.release_notes !== "string"
  ) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        INVALID_RELEASE_PATCH_NOTES_ERROR,
        "release_notes",
        "invalid_type",
      ),
    };
  }

  if (
    body.target_binary_version !== undefined &&
    (typeof body.target_binary_version !== "string" ||
      !isValidBinaryVersion(body.target_binary_version))
  ) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        INVALID_BINARY_VERSION_ERROR,
        "target_binary_version",
        typeof body.target_binary_version === "string"
          ? "invalid_format"
          : "invalid_type",
      ),
    };
  }

  if (body.disabled !== undefined && typeof body.disabled !== "boolean") {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        INVALID_RELEASE_PROMOTE_DISABLED_ERROR,
        "disabled",
        "invalid_type",
      ),
    };
  }

  if (
    body.no_duplicate_release_error !== undefined &&
    typeof body.no_duplicate_release_error !== "boolean"
  ) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        INVALID_RELEASE_PROMOTE_NO_DUPLICATE_ERROR,
        "no_duplicate_release_error",
        "invalid_type",
      ),
    };
  }

  return {
    kind: "success",
    value: {
      createdBy,
      destinationDeploymentId,
      disabled: body.disabled === true,
      isMandatory:
        body.is_mandatory === undefined ? undefined : body.is_mandatory,
      jobId: createReleaseJobId(),
      noDuplicateReleaseError: body.no_duplicate_release_error === true,
      releaseId: createReleaseId(),
      releaseNotes:
        body.release_notes === undefined
          ? undefined
          : (body.release_notes as string | null),
      rolloutPercentage,
      sourceReleaseId,
      targetBinaryVersion:
        body.target_binary_version === undefined
          ? undefined
          : (body.target_binary_version as string),
    },
  };
}

export function parseDeploymentRollbackInput(
  deploymentId: string,
  body: unknown,
  createdBy: string | null,
):
  | {
      kind: "error";
      problem: ProblemDetails;
    }
  | {
      kind: "success";
      value: DeploymentRollbackHandlerInput;
    } {
  if (body !== undefined && !isJsonObject(body)) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "deployment rollback body must be a JSON object",
        "body",
        "invalid_type",
      ),
    };
  }

  const label = body?.target_release_label;
  if (label !== undefined && (typeof label !== "string" || label.trim() === "")) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "target_release_label must be a non-empty string when provided",
        "target_release_label",
        requiredStringReason(label),
      ),
    };
  }

  return {
    kind: "success",
    value: {
      createdBy,
      deploymentId,
      jobId: createReleaseJobId(),
      releaseId: createReleaseId(),
      targetReleaseLabel: typeof label === "string" ? label.trim() : null,
    },
  };
}

export function parseReleaseListInput(
  deploymentId: string,
  query: ReleaseListQuery,
):
  | {
      kind: "error";
      problem: ProblemDetails;
    }
  | {
      kind: "success";
      value: {
        deploymentId: string;
        includeMetrics: boolean;
        limit: number;
        offset: number;
      };
    } {
  if (
    query.include !== undefined &&
    (Array.isArray(query.include) ||
      typeof query.include !== "string" ||
      query.include !== "metrics")
  ) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        UNSUPPORTED_RELEASE_LIST_INCLUDE_ERROR,
        "include",
        Array.isArray(query.include) ? "invalid_type" : "invalid_value",
      ),
    };
  }

  const pagination = parsePaginationQuery(query);
  if (pagination.kind === "error") {
    return pagination;
  }

  return {
    kind: "success",
    value: {
      deploymentId,
      includeMetrics: query.include === "metrics",
      limit: pagination.value.limit,
      offset: pagination.value.offset,
    },
  };
}

export function parseDeploymentMetricsInput(
  deploymentId: string,
  query: PaginationQuery,
):
  | {
      kind: "error";
      problem: ProblemDetails;
    }
  | {
      kind: "success";
      value: {
        deploymentId: string;
        limit: number;
        offset: number;
      };
    } {
  const pagination = parsePaginationQuery(query);
  if (pagination.kind === "error") {
    return pagination;
  }

  return {
    kind: "success",
    value: {
      deploymentId,
      limit: pagination.value.limit,
      offset: pagination.value.offset,
    },
  };
}

function parsePaginationQuery(query: PaginationQuery):
  | {
      kind: "error";
      problem: ProblemDetails;
    }
  | {
      kind: "success";
      value: {
        limit: number;
        offset: number;
      };
    } {
  const limit = parseBoundedIntegerQueryParam(query.limit, {
    defaultValue: 50,
    field: "limit",
    max: 100,
    min: 1,
    problemDetail: INVALID_RELEASE_LIST_LIMIT_ERROR,
  });
  if (limit.kind === "error") {
    return limit;
  }

  const offset = parseBoundedIntegerQueryParam(query.offset, {
    defaultValue: 0,
    field: "offset",
    min: 0,
    problemDetail: INVALID_RELEASE_LIST_OFFSET_ERROR,
  });
  if (offset.kind === "error") {
    return offset;
  }

  return {
    kind: "success",
    value: {
      limit: limit.value,
      offset: offset.value,
    },
  };
}

function isReleasePatchBody(value: unknown): value is ReleasePatchBody {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
