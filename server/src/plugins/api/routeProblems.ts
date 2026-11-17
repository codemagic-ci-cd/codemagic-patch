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

/**
 * For routes that create or delegate a credential. An API token can act but
 * cannot issue: a credential it minted would outlive it, so deleting a leaked
 * token would not end the access it granted.
 */
export function createSessionRequiredProblem(): ProblemDetails {
  return createProblem({
    detail:
      "This action needs a browser sign-in or a CLI session approved in the browser; API tokens cannot perform it.",
    extensions: {
      outcome: "forbidden",
      reason: "session_required",
    },
    status: 403,
    typeSuffix: "forbidden",
  });
}

/** The calling session ended between authentication and the guarded write. */
export function createSessionRevokedProblem(): ProblemDetails {
  return createProblem({
    detail: "this session has been signed out; sign in again",
    extensions: {
      outcome: "unauthenticated",
      reason: "session_revoked",
    },
    status: 401,
    typeSuffix: "authentication-required",
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
