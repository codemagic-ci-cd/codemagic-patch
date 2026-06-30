import type { FastifyRequest } from "fastify";

import { createProblem, type ProblemDetails } from "../../app/problemDetails";
import type {
  AuthorizationService,
  ResourceScopeLookupResult,
} from "../../app/authorizationService";
import type { ControlPlanePrincipal } from "../../app/controlPlaneAuth";
import type {
  AuthorizationResult,
  ControlPlaneAction,
  Team,
} from "../../domain";
import { createAccountDisabledProblem } from "./routeProblems";

// The control-plane auth hook authenticates every request before the handler
// runs and always attaches a (user-backed) principal, so handlers can resolve
// it through this single accessor instead of re-checking presence everywhere.
export function requireControlPlanePrincipal(
  request: FastifyRequest,
): ControlPlanePrincipal {
  const principal = request.controlPlanePrincipal;
  if (!principal) {
    throw new Error(
      "control-plane principal is missing; the auth hook must run before this handler",
    );
  }

  return principal;
}

export async function listVisibleTeamsForPrincipal(
  authorizationService: AuthorizationService | undefined,
  principal: ControlPlanePrincipal | undefined,
): Promise<
  | {
      kind: "skip";
    }
  | {
      kind: "success";
      teams: Team[];
    }
  | {
      kind: "error";
      problem: ProblemDetails;
    }
> {
  if (!authorizationService) {
    return {
      kind: "skip",
    };
  }

  if (!principal) {
    return {
      kind: "error",
      problem: createProblem({
        detail: "control-plane authentication is required",
        status: 401,
        typeSuffix: "authentication-required",
      }),
    };
  }

  const result = await authorizationService.listVisibleTeams(principal);
  if (result.outcome === "found") {
    return {
      kind: "success",
      teams: result.teams,
    };
  }

  if (result.outcome === "account_disabled") {
    return {
      kind: "error",
      problem: createAccountDisabledProblem(result.reason),
    };
  }

  return {
    kind: "error",
    problem: createProblem({
      detail: "user was not found",
      extensions: {
        outcome: result.outcome,
        reason: result.reason,
      },
      status: 404,
      typeSuffix: "not-found",
    }),
  };
}

export async function authorizeResourceAccess(
  authorizationService: AuthorizationService | undefined,
  principal: ControlPlanePrincipal | undefined,
  action: ControlPlaneAction,
  lookupScope: () => Promise<ResourceScopeLookupResult>,
  notFoundProblem: ProblemDetails,
): Promise<
  | {
      kind: "authorized";
    }
  | {
      kind: "error";
      problem: ProblemDetails;
    }
> {
  if (!authorizationService) {
    return {
      kind: "authorized",
    };
  }

  if (!principal) {
    return {
      kind: "error",
      problem: createProblem({
        detail: "control-plane authentication is required",
        status: 401,
        typeSuffix: "authentication-required",
      }),
    };
  }

  const scope = await lookupScope();
  if (scope.outcome === "not_found") {
    return {
      kind: "error",
      problem: notFoundProblem,
    };
  }

  const result = await authorizationService.authorize(
    principal,
    action,
    scope.scope,
  );
  if (result.outcome === "authorized") {
    return {
      kind: "authorized",
    };
  }

  return {
    kind: "error",
    problem: createAuthorizationProblem(result, notFoundProblem),
  };
}

export async function authorizeVisibleResourceAccess(
  authorizationService: AuthorizationService | undefined,
  principal: ControlPlanePrincipal | undefined,
  action: ControlPlaneAction,
  lookupScope: () => Promise<ResourceScopeLookupResult>,
  notFoundProblem: ProblemDetails,
  invisibleProblem = notFoundProblem,
): Promise<
  | {
      kind: "authorized";
    }
  | {
      kind: "error";
      problem: ProblemDetails;
    }
> {
  if (!authorizationService) {
    return {
      kind: "authorized",
    };
  }

  if (!principal) {
    return {
      kind: "error",
      problem: createProblem({
        detail: "control-plane authentication is required",
        status: 401,
        typeSuffix: "authentication-required",
      }),
    };
  }

  const scope = await lookupScope();
  if (scope.outcome === "not_found") {
    return {
      kind: "error",
      problem: notFoundProblem,
    };
  }

  const visibility = await authorizationService.authorize(
    principal,
    "team.read",
    scope.scope,
  );
  const visibilityProblem = createVisibilityProblem(
    visibility,
    invisibleProblem,
  );
  if (visibilityProblem) {
    return {
      kind: "error",
      problem: visibilityProblem,
    };
  }

  if (action === "team.read") {
    return {
      kind: "authorized",
    };
  }

  const result = await authorizationService.authorize(
    principal,
    action,
    scope.scope,
  );
  if (result.outcome === "authorized") {
    return {
      kind: "authorized",
    };
  }

  return {
    kind: "error",
    problem: createAuthorizationProblem(result, notFoundProblem),
  };
}

export function createVisibilityProblem(
  result: AuthorizationResult,
  invisibleProblem: ProblemDetails,
): ProblemDetails | null {
  if (result.outcome === "authorized") {
    return null;
  }

  if (result.outcome === "account_disabled") {
    return createAccountDisabledProblem(result.reason);
  }

  return invisibleProblem;
}

export function createAuthorizationProblem(
  result: Exclude<AuthorizationResult, { outcome: "authorized" }>,
  notFoundProblem: ProblemDetails,
): ProblemDetails {
  if (result.outcome === "account_disabled") {
    return createAccountDisabledProblem(result.reason);
  }

  if (result.outcome === "not_found") {
    return notFoundProblem;
  }

  return createProblem({
    detail: "principal is not authorized for this resource",
    status: 403,
    typeSuffix: "forbidden",
  });
}
