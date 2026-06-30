import {
  createProblem,
  createValidationProblem,
  type ProblemDetails,
} from "../../app/problemDetails";
import type {
  ReleaseCreationHandlerResult,
  ReleaseLifecycleCreateHandlerResult,
  ReleasePatchHandlerInput,
} from "../../app/types";
import { DUPLICATE_RELEASE_DETAIL } from "./routeConstants";
import {
  createDeploymentNotFoundProblem,
  createReleaseNotFoundProblem,
} from "./routeProblems";
import type { PreparedJsonResponse } from "./routeResponses";
import { singleFieldValidationProblem } from "./routeValidation";
import {
  toActiveJobWire,
  toReleaseJobWire,
  toReleaseWire,
} from "./wireSerializers";

export function releasePatchInvalidProblem(
  reason:
    | "release_not_patchable"
    | "rollout_percentage_decrease"
    | "signature_required"
    | "status_transition_not_allowed",
): ProblemDetails {
  if (reason === "signature_required") {
    return singleFieldValidationProblem(
      "signature is required for this app",
      "signature",
      "required",
    );
  }

  if (reason === "rollout_percentage_decrease") {
    return singleFieldValidationProblem(
      "rollout_percentage cannot decrease",
      "rollout_percentage",
      "out_of_range",
    );
  }

  return createValidationProblem("release is not patchable in its current state");
}

export function prepareReleaseCreationResponse(
  result: ReleaseCreationHandlerResult,
): PreparedJsonResponse {
  if (result.outcome === "created") {
    return {
      body: {
        job: toReleaseJobWire(result.job),
        release: toReleaseWire(result.release),
        ...(result.warnings?.length ? { warnings: result.warnings } : {}),
      },
      status: 201,
    };
  }

  const problem = problemForReleaseCreationFailure(result);
  if (problem) {
    return {
      body: problem,
      status: problem.status,
    };
  }

  return {
    body: result,
    status: 200,
  };
}

export function prepareReleaseLifecycleCreateResponse(
  result: ReleaseLifecycleCreateHandlerResult,
): PreparedJsonResponse {
  if (result.outcome === "created") {
    return {
      body: {
        job: toReleaseJobWire(result.job),
        release: toReleaseWire(result.release),
        ...(result.warnings?.length ? { warnings: result.warnings } : {}),
      },
      status: 201,
    };
  }

  if (result.outcome === "not_found") {
    const problem =
      result.reason === "deployment_not_found"
        ? createDeploymentNotFoundProblem()
        : result.reason === "rollback_target_not_found"
          ? createProblem({
              detail: "rollback target release was not found",
              extensions: {
                outcome: result.outcome,
                reason: result.reason,
              },
              status: 404,
              typeSuffix: "not-found",
            })
          : createReleaseNotFoundProblem();

    return {
      body: problem,
      status: problem.status,
    };
  }

  if (result.outcome === "invalid") {
    const problem =
      result.reason === "signature_required"
        ? singleFieldValidationProblem(
            "signature is required for this app",
            "signature",
            "required",
          )
        : createValidationProblem("release cannot be used as a bundle source");

    return {
      body: problem,
      status: problem.status,
    };
  }

  if (result.reason === "active_release_job_exists") {
    const problem = createProblem({
      detail: "deployment already has an active queued or running release job",
      extensions: {
        active_job: toActiveJobWire(result.activeJob),
      },
      status: 409,
      typeSuffix: "active-release-job",
    });

    return {
      body: problem,
      status: problem.status,
    };
  }

  if (result.reason === "active_rollout_exists") {
    const problem = createProblem({
      detail: "deployment has an active rollout",
      status: 409,
      typeSuffix: "release-conflict",
    });

    return {
      body: problem,
      status: problem.status,
    };
  }

  if (result.reason === "duplicate_release") {
    const problem = createProblem({
      detail: DUPLICATE_RELEASE_DETAIL,
      extensions: {
        latest_release: toLatestReleaseWire(result.latestRelease),
      },
      status: 409,
      typeSuffix: "duplicate-release",
    });

    return {
      body: problem,
      status: problem.status,
    };
  }

  const problem = createProblem({
    detail: "rollback target content is already live",
    status: 409,
    typeSuffix: "rollback-no-op",
  });

  return {
    body: problem,
    status: problem.status,
  };
}

export function releasePatchAuditAction(input: ReleasePatchHandlerInput): string {
  if (input.status === "disabled") {
    return "release.disabled";
  }

  if (input.status === "published") {
    return "release.enabled";
  }

  return "release.updated";
}

export function problemForReleaseCreationFailure(
  result: Exclude<ReleaseCreationHandlerResult, { outcome: "created" }>,
): ProblemDetails | null {
  if (result.outcome === "not_found") {
    return createProblem({
      detail: "deployment was not found",
      extensions: {
        outcome: result.outcome,
        reason: result.reason,
      },
      status: 404,
      typeSuffix: "not-found",
    });
  }

  if (
    result.outcome === "conflict" &&
    result.reason === "active_release_job_exists"
  ) {
    return createProblem({
      detail: "deployment already has an active queued or running release job",
      extensions: {
        active_job: toActiveJobWire(result.activeJob),
      },
      status: 409,
      typeSuffix: "active-release-job",
    });
  }

  if (
    result.outcome === "conflict" &&
    result.reason === "active_rollout_exists"
  ) {
    return createProblem({
      detail: "deployment has an active rollout below 100 percent",
      status: 409,
      typeSuffix: "release-conflict",
    });
  }

  if (
    result.outcome === "conflict" &&
    result.reason === "duplicate_release"
  ) {
    return createProblem({
      detail: DUPLICATE_RELEASE_DETAIL,
      status: 409,
      typeSuffix: "duplicate-release",
    });
  }

  if (result.outcome === "invalid" && result.reason === "signature_required") {
    return singleFieldValidationProblem(
      "signature is required for this app",
      "metadata.signature",
      "required",
    );
  }

  return null;
}

function toLatestReleaseWire(latestRelease: {
  releaseId: string;
  releaseLabel: string;
  targetPackageHash: string;
}) {
  return {
    release_id: latestRelease.releaseId,
    release_label: latestRelease.releaseLabel,
    target_package_hash: latestRelease.targetPackageHash,
  };
}
