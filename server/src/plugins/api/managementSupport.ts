import {
  createProblem,
  createValidationProblem,
  type ProblemDetails,
} from "../../app/problemDetails";
import type {
  AppCreateRouteHandler,
  AppDeleteRouteHandler,
  AppTransferRouteHandler,
  AppUpdateRouteHandler,
  DeploymentCreateRouteHandler,
  DeploymentDeleteRouteHandler,
  DeploymentUpdateRouteHandler,
} from "../../app/types";
import {
  createAppNotFoundProblem,
  createDeploymentNotFoundProblem,
  createTeamNotFoundProblem,
  type PreparedJsonResponse,
} from "./routeSupport";
import {
  isJsonObject,
  parseRequiredTrimmedString,
  requiredStringReason,
  singleFieldValidationProblem,
} from "./routeValidation";
import {
  toActiveJobWire,
  toAppWire,
  toDeploymentWire,
} from "./wireSerializers";

export function parseTeamCreateInput(body: unknown):
  | {
      kind: "error";
      problem: ProblemDetails;
    }
  | {
      kind: "success";
      value: {
        name: string;
      };
    } {
  if (!isJsonObject(body)) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "team creation body must be a JSON object",
        "body",
        "invalid_type",
      ),
    };
  }

  const name = parseRequiredTrimmedString(body.name);
  if (name === null) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "name must be a non-empty string",
        "name",
        requiredStringReason(body.name),
      ),
    };
  }

  return {
    kind: "success",
    value: {
      name,
    },
  };
}

export function prepareAppCreateResponse(
  result: Awaited<ReturnType<AppCreateRouteHandler>>,
): PreparedJsonResponse {
  if (result.outcome === "created") {
    return {
      body: {
        app: toAppWire(result.app),
        deployments: result.deployments.map(toDeploymentWire),
      },
      status: 201,
    };
  }

  if (result.outcome === "not_found") {
    const problem = createTeamNotFoundProblem(result);
    return {
      body: problem,
      status: problem.status,
    };
  }

  if (result.outcome === "conflict") {
    const problem = createProblem({
      detail: "app name already exists within the team",
      status: 409,
      typeSuffix: "app-conflict",
    });

    return {
      body: problem,
      status: problem.status,
    };
  }

  const problem = createProblem({
    detail: "deployment key generation exhausted",
    status: 500,
  });

  return {
    body: problem,
    status: problem.status,
  };
}

export function prepareAppUpdateResponse(
  result: Awaited<ReturnType<AppUpdateRouteHandler>>,
): PreparedJsonResponse {
  if (result.outcome === "updated") {
    return {
      body: {
        app: toAppWire(result.app),
      },
      status: 200,
    };
  }

  if (result.outcome === "not_found") {
    const problem = createAppNotFoundProblem(result);
    return {
      body: problem,
      status: problem.status,
    };
  }

  const problem = createProblem({
    detail: "app name already exists within the team",
    status: 409,
    typeSuffix: "app-conflict",
  });

  return {
    body: problem,
    status: problem.status,
  };
}

export function prepareAppTransferResponse(
  result: Awaited<ReturnType<AppTransferRouteHandler>>,
): PreparedJsonResponse {
  if (result.outcome === "transferred") {
    return {
      body: {
        app: toAppWire(result.app),
        deployments: result.deployments.map(toDeploymentWire),
      },
      status: 200,
    };
  }

  if (result.outcome === "not_found") {
    const problem =
      result.reason === "destination_team_not_found"
        ? createTeamNotFoundProblem({
            outcome: "not_found",
            reason: "team_not_found",
          })
        : createAppNotFoundProblem({
            outcome: "not_found",
            reason: "app_not_found",
          });
    return {
      body: problem,
      status: problem.status,
    };
  }

  if (result.outcome === "invalid") {
    const problem = singleFieldValidationProblem(
      "destination team must be different from the source team",
      "team_id",
      "invalid_value",
    );
    return {
      body: problem,
      status: problem.status,
    };
  }

  if (result.reason === "active_release_job_exists") {
    const problem = createProblem({
      detail: "app already has an active queued or running release job",
      extensions: {
        active_job: toActiveJobWire(result.activeJob),
      },
      status: 409,
      typeSuffix: "app-conflict",
    });
    return {
      body: problem,
      status: problem.status,
    };
  }

  const problem = createProblem({
    detail: "app name already exists within the team",
    status: 409,
    typeSuffix: "app-conflict",
  });

  return {
    body: problem,
    status: problem.status,
  };
}

export function prepareAppDeleteResponse(
  result: Awaited<ReturnType<AppDeleteRouteHandler>>,
): PreparedJsonResponse {
  if (result.outcome === "deleted") {
    return {
      body: {},
      status: 204,
    };
  }

  if (result.outcome === "not_found") {
    const problem = createAppNotFoundProblem({
      outcome: "not_found",
      reason: "app_not_found",
    });
    return {
      body: problem,
      status: problem.status,
    };
  }

  const problem = createProblem({
    detail:
      result.reason === "source_release_active_job_exists"
        ? "app has a release that is still used by an active queued or running release job"
        : "app already has an active queued or running release job",
    extensions: {
      active_job: toActiveJobWire(result.activeJob),
    },
    status: 409,
    typeSuffix:
      result.reason === "source_release_active_job_exists"
        ? "active-release-job"
        : "app-conflict",
  });

  return {
    body: problem,
    status: problem.status,
  };
}

export function prepareDeploymentCreateResponse(
  result: Awaited<ReturnType<DeploymentCreateRouteHandler>>,
): PreparedJsonResponse {
  if (result.outcome === "created") {
    return {
      body: {
        deployment: toDeploymentWire(result.deployment),
      },
      status: 201,
    };
  }

  if (result.outcome === "not_found") {
    const problem = createAppNotFoundProblem(result);
    return {
      body: problem,
      status: problem.status,
    };
  }

  if (result.outcome === "conflict") {
    const problem = createProblem({
      detail: "deployment name already exists within the app",
      status: 409,
      typeSuffix: "deployment-conflict",
    });
    return {
      body: problem,
      status: problem.status,
    };
  }

  const problem = createProblem({
    detail: "deployment key generation exhausted",
    status: 500,
  });
  return {
    body: problem,
    status: problem.status,
  };
}

export function prepareDeploymentUpdateResponse(
  result: Awaited<ReturnType<DeploymentUpdateRouteHandler>>,
): PreparedJsonResponse {
  if (result.outcome === "updated") {
    return {
      body: {
        deployment: toDeploymentWire(result.deployment),
      },
      status: 200,
    };
  }

  if (result.outcome === "not_found") {
    const problem = createDeploymentNotFoundProblem();
    return {
      body: problem,
      status: problem.status,
    };
  }

  const problem = createProblem({
    detail: "deployment name already exists within the app",
    status: 409,
    typeSuffix: "deployment-conflict",
  });
  return {
    body: problem,
    status: problem.status,
  };
}

export function prepareDeploymentDeleteResponse(
  result: Awaited<ReturnType<DeploymentDeleteRouteHandler>>,
): PreparedJsonResponse {
  if (result.outcome === "deleted") {
    return {
      body: {},
      status: 204,
    };
  }

  if (result.outcome === "not_found") {
    const problem = createDeploymentNotFoundProblem();
    return {
      body: problem,
      status: problem.status,
    };
  }

  const problem = createProblem({
    detail:
      result.reason === "source_release_active_job_exists"
        ? "deployment has a release that is still used by an active queued or running release job"
        : "deployment already has an active queued or running release job",
    extensions: {
      active_job: toActiveJobWire(result.activeJob),
    },
    status: 409,
    typeSuffix:
      result.reason === "source_release_active_job_exists"
        ? "active-release-job"
        : "deployment-conflict",
  });
  return {
    body: problem,
    status: problem.status,
  };
}

export function parseAppCreateInput(body: unknown):
  | {
      kind: "error";
      problem: ProblemDetails;
    }
  | {
      kind: "success";
      value: {
        name: string;
        requireCodeSigning: boolean;
        teamId: string;
      };
    } {
  if (!isJsonObject(body)) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "app creation body must be a JSON object",
        "body",
        "invalid_type",
      ),
    };
  }

  const teamId = parseRequiredTrimmedString(body.team_id);
  if (teamId === null) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "team_id must be a non-empty string",
        "team_id",
        requiredStringReason(body.team_id),
      ),
    };
  }

  const name = parseRequiredTrimmedString(body.name);
  if (name === null) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "name must be a non-empty string",
        "name",
        requiredStringReason(body.name),
      ),
    };
  }

  if (
    body.require_code_signing !== undefined &&
    typeof body.require_code_signing !== "boolean"
  ) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "require_code_signing must be a boolean",
        "require_code_signing",
        "invalid_type",
      ),
    };
  }

  return {
    kind: "success",
    value: {
      name,
      requireCodeSigning: body.require_code_signing === true,
      teamId,
    },
  };
}

export function parseAppUpdateInput(
  appId: string,
  body: unknown,
):
  | {
      kind: "error";
      problem: ProblemDetails;
    }
  | {
      kind: "success";
      value: {
        appId: string;
        name?: string;
        requireCodeSigning?: boolean;
      };
    } {
  if (!isJsonObject(body)) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "app update body must be a JSON object",
        "body",
        "invalid_type",
      ),
    };
  }

  const hasName = body.name !== undefined;
  const hasRequireCodeSigning = body.require_code_signing !== undefined;
  if (!hasName && !hasRequireCodeSigning) {
    return {
      kind: "error",
      problem: createValidationProblem(
        "app update body must include name or require_code_signing",
      ),
    };
  }

  const value: {
    appId: string;
    name?: string;
    requireCodeSigning?: boolean;
  } = {
    appId,
  };

  if (hasName) {
    const name = parseRequiredTrimmedString(body.name);
    if (name === null) {
      return {
        kind: "error",
        problem: singleFieldValidationProblem(
          "name must be a non-empty string",
          "name",
          requiredStringReason(body.name),
        ),
      };
    }
    value.name = name;
  }

  if (hasRequireCodeSigning) {
    if (typeof body.require_code_signing !== "boolean") {
      return {
        kind: "error",
        problem: singleFieldValidationProblem(
          "require_code_signing must be a boolean",
          "require_code_signing",
          "invalid_type",
        ),
      };
    }
    value.requireCodeSigning = body.require_code_signing;
  }

  return {
    kind: "success",
    value,
  };
}

export function parseAppTransferInput(
  appId: string,
  body: unknown,
):
  | {
      kind: "error";
      problem: ProblemDetails;
    }
  | {
      kind: "success";
      value: {
        appId: string;
        destinationTeamId: string;
      };
    } {
  if (!isJsonObject(body)) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "app transfer body must be a JSON object",
        "body",
        "invalid_type",
      ),
    };
  }

  const destinationTeamId = parseRequiredTrimmedString(body.team_id);
  if (destinationTeamId === null) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "team_id must be a non-empty string",
        "team_id",
        requiredStringReason(body.team_id),
      ),
    };
  }

  return {
    kind: "success",
    value: {
      appId,
      destinationTeamId,
    },
  };
}

export function parseDeploymentCreateInput(
  appId: string,
  body: unknown,
):
  | {
      kind: "error";
      problem: ProblemDetails;
    }
  | {
      kind: "success";
      value: {
        appId: string;
        name: string;
      };
    } {
  if (!isJsonObject(body)) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "deployment creation body must be a JSON object",
        "body",
        "invalid_type",
      ),
    };
  }

  const name = parseRequiredTrimmedString(body.name);
  if (name === null) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "name must be a non-empty string",
        "name",
        requiredStringReason(body.name),
      ),
    };
  }

  return {
    kind: "success",
    value: {
      appId,
      name,
    },
  };
}

export function parseDeploymentUpdateInput(
  deploymentId: string,
  body: unknown,
):
  | {
      kind: "error";
      problem: ProblemDetails;
    }
  | {
      kind: "success";
      value: {
        deploymentId: string;
        name: string;
      };
    } {
  if (!isJsonObject(body)) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "deployment update body must be a JSON object",
        "body",
        "invalid_type",
      ),
    };
  }

  const name = parseRequiredTrimmedString(body.name);
  if (name === null) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "name must be a non-empty string",
        "name",
        requiredStringReason(body.name),
      ),
    };
  }

  return {
    kind: "success",
    value: {
      deploymentId,
      name,
    },
  };
}
