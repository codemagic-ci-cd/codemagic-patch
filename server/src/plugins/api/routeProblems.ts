import { createProblem, type ProblemDetails } from "../../app/problemDetails";
import { MANAGEMENT_NOT_ENABLED_ERROR } from "./routeConstants";

export function createManagementNotEnabledProblem(): ProblemDetails {
  return createProblem({
    detail: MANAGEMENT_NOT_ENABLED_ERROR,
    status: 501,
  });
}

export function createAccountDisabledProblem(
  reason: "team_disabled" | "user_disabled",
): ProblemDetails {
  return createProblem({
    detail:
      reason === "team_disabled" ? "team is disabled" : "account is disabled",
    extensions: {
      outcome: "account_disabled",
      reason,
    },
    status: 403,
    typeSuffix: "account-disabled",
  });
}

export function createTeamNotFoundProblem(result: {
  outcome: "not_found";
  reason: "team_not_found";
}): ProblemDetails {
  return createProblem({
    detail: "team was not found",
    extensions: {
      outcome: result.outcome,
      reason: result.reason,
    },
    status: 404,
    typeSuffix: "not-found",
  });
}

export function createAppNotFoundProblem(result: {
  outcome: "not_found";
  reason: "app_not_found";
}): ProblemDetails {
  return createProblem({
    detail: "app was not found",
    extensions: {
      outcome: result.outcome,
      reason: result.reason,
    },
    status: 404,
    typeSuffix: "not-found",
  });
}

export function createDeploymentNotFoundProblem(): ProblemDetails {
  return createProblem({
    detail: "deployment was not found",
    extensions: {
      outcome: "not_found",
      reason: "deployment_not_found",
    },
    status: 404,
    typeSuffix: "not-found",
  });
}

export function createReleaseNotFoundProblem(): ProblemDetails {
  return createProblem({
    detail: "release was not found",
    extensions: {
      outcome: "not_found",
      reason: "release_not_found",
    },
    status: 404,
    typeSuffix: "not-found",
  });
}
