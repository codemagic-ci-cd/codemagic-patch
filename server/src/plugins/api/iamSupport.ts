import {
  createProblem,
  type ProblemDetails,
} from "../../app/problemDetails";
import type {
  IamInvitationCreateRouteHandler,
  IamInvitationRevokeRouteHandler,
  IamInvitationStatusFilter,
  IamRoleBindingCreateRouteHandler,
  IamRoleBindingDeleteRouteHandler,
  IamUserProvisionRouteHandler,
} from "../../app/types";
import { MAX_API_TOKEN_EXPIRATION_DAYS } from "./routeConstants";
import {
  createAccountDisabledProblem,
  createTeamNotFoundProblem,
  MAX_IAM_INVITATION_EXPIRES_IN_DAYS,
  type PreparedJsonResponse,
} from "./routeSupport";
import {
  isJsonObject,
  parseRequiredTrimmedString,
  requiredStringReason,
  singleFieldValidationProblem,
} from "./routeValidation";
import type {
  IamInvitationListQuery,
  IamRoleBindingListQuery,
} from "./routeTypes";
import {
  toApiTokenWire,
  toInvitationWire,
  toRoleBindingWire,
} from "./wireSerializers";

export function parseIamRoleBindingListInput(query: IamRoleBindingListQuery):
  | {
      kind: "error";
      problem: ProblemDetails;
    }
  | {
      kind: "success";
      value: {
        teamId: string;
      };
    } {
  const teamId = parseRequiredTrimmedString(query.team_id);

  if (teamId === null) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "team_id must be a non-empty string",
        "team_id",
        requiredStringReason(query.team_id),
      ),
    };
  }

  return {
    kind: "success",
    value: {
      teamId,
    },
  };
}

export function parseIamRoleBindingCreateInput(
  body: unknown,
  createdBy: string,
):
  | {
      kind: "error";
      problem: ProblemDetails;
    }
  | {
      kind: "success";
      value: {
        createdBy: string;
        roleId: string;
        teamId: string;
        userSelector:
          | {
              type: "userId";
              userId: string;
            }
          | {
              type: "email";
              email: string;
            };
      };
    } {
  if (!isJsonObject(body)) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "role binding creation body must be a JSON object",
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

  const roleId = parseRequiredTrimmedString(body.role_id);
  if (roleId === null) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "role_id must be a non-empty string",
        "role_id",
        requiredStringReason(body.role_id),
      ),
    };
  }

  const userId = parseOptionalTrimmedString(body.user_id);
  const email = parseOptionalTrimmedString(body.email);
  if (userId.kind === "error") {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "user_id must be a non-empty string when provided",
        "user_id",
        typeof body.user_id === "string" ? "required" : "invalid_type",
      ),
    };
  }

  if (email.kind === "error") {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "email must be a non-empty string when provided",
        "email",
        typeof body.email === "string" ? "required" : "invalid_type",
      ),
    };
  }

  if ((userId.value === null && email.value === null) || (userId.value && email.value)) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "exactly one of user_id or email is required",
        "user_selector",
        "invalid_combination",
      ),
    };
  }

  return {
    kind: "success",
    value: {
      createdBy,
      roleId,
      teamId,
      userSelector:
        userId.value !== null
          ? {
              type: "userId",
              userId: userId.value,
            }
          : {
              email: email.value!,
              type: "email",
            },
    },
  };
}

export function parseIamInvitationListInput(query: IamInvitationListQuery):
  | {
      kind: "error";
      problem: ProblemDetails;
    }
  | {
      kind: "success";
      value: {
        status: IamInvitationStatusFilter;
        teamId: string;
      };
    } {
  const teamId = parseRequiredTrimmedString(query.team_id);

  if (teamId === null) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "team_id must be a non-empty string",
        "team_id",
        requiredStringReason(query.team_id),
      ),
    };
  }

  const status = parseOptionalTrimmedString(query.status);
  if (status.kind === "error" || !isIamInvitationStatusFilter(status.value)) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "status must be one of: pending, accepted, revoked, expired, all",
        "status",
        status.kind === "error" ? "invalid_type" : "invalid_value",
      ),
    };
  }

  return {
    kind: "success",
    value: {
      status: status.value ?? "pending",
      teamId,
    },
  };
}

export function parseIamInvitationCreateInput(
  body: unknown,
  createdBy: string,
):
  | {
      kind: "error";
      problem: ProblemDetails;
    }
  | {
      kind: "success";
      value: {
        createdBy: string;
        expiresInDays: number | null;
        roleId: string;
        target:
          | {
              type: "email";
              email: string;
            }
          | {
              type: "github_handle";
              githubHandle: string;
            };
        teamId: string;
      };
    } {
  if (!isJsonObject(body)) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "invitation creation body must be a JSON object",
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

  // Exactly one of email | github_handle, mirroring the role-binding selector.
  const email = parseOptionalTrimmedString(body.email);
  const githubHandle = parseOptionalTrimmedString(body.github_handle);
  if (email.kind === "error") {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "email must be a non-empty string when provided",
        "email",
        typeof body.email === "string" ? "required" : "invalid_type",
      ),
    };
  }

  if (githubHandle.kind === "error") {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "github_handle must be a non-empty string when provided",
        "github_handle",
        typeof body.github_handle === "string" ? "required" : "invalid_type",
      ),
    };
  }

  if (
    (email.value === null && githubHandle.value === null) ||
    (email.value && githubHandle.value)
  ) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "exactly one of email or github_handle is required",
        "invitation_target",
        "invalid_combination",
      ),
    };
  }

  const roleId = parseRequiredTrimmedString(body.role_id);
  if (roleId === null) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "role_id must be a non-empty string",
        "role_id",
        requiredStringReason(body.role_id),
      ),
    };
  }

  const expiresInDays = parseOptionalPositiveInteger(
    body.expires_in_days,
    "expires_in_days",
    MAX_IAM_INVITATION_EXPIRES_IN_DAYS,
  );
  if (expiresInDays.kind === "error") {
    return {
      kind: "error",
      problem: expiresInDays.problem,
    };
  }

  return {
    kind: "success",
    value: {
      createdBy,
      expiresInDays: expiresInDays.value,
      roleId,
      target:
        email.value !== null
          ? {
              email: email.value,
              type: "email",
            }
          : {
              githubHandle: githubHandle.value!,
              type: "github_handle",
            },
      teamId,
    },
  };
}

export function parseIamUserProvisionInput(
  body: unknown,
  createdBy: string,
):
  | {
      kind: "error";
      problem: ProblemDetails;
    }
  | {
      kind: "success";
      value: {
        createdBy: string;
        displayName: string | null;
        email: string;
        expiresInDays?: number;
        roleId: string;
        teamId: string;
        tokenDisplayName: string;
      };
    } {
  if (!isJsonObject(body)) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "user provision body must be a JSON object",
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

  const email = parseRequiredTrimmedString(body.email);
  if (email === null) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "email must be a non-empty string",
        "email",
        requiredStringReason(body.email),
      ),
    };
  }

  const roleId = parseRequiredTrimmedString(body.role_id);
  if (roleId === null) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "role_id must be a non-empty string",
        "role_id",
        requiredStringReason(body.role_id),
      ),
    };
  }

  const displayName = parseOptionalTrimmedString(body.display_name);
  if (displayName.kind === "error") {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "display_name must be a non-empty string when provided",
        "display_name",
        "invalid_type",
      ),
    };
  }

  const tokenDisplayName = parseOptionalTrimmedString(body.token_display_name);
  if (tokenDisplayName.kind === "error") {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "token_display_name must be a non-empty string when provided",
        "token_display_name",
        "invalid_type",
      ),
    };
  }

  const expiresInDays = parseOptionalPositiveInteger(
    body.expires_in_days,
    "expires_in_days",
    MAX_API_TOKEN_EXPIRATION_DAYS,
  );
  if (expiresInDays.kind === "error") {
    return {
      kind: "error",
      problem: expiresInDays.problem,
    };
  }

  return {
    kind: "success",
    value: {
      createdBy,
      displayName: displayName.value,
      email,
      ...(expiresInDays.value !== null
        ? { expiresInDays: expiresInDays.value }
        : {}),
      roleId,
      teamId,
      tokenDisplayName: tokenDisplayName.value ?? `${email} (provisioned)`,
    },
  };
}

export function prepareIamUserProvisionResponse(
  result: Awaited<ReturnType<IamUserProvisionRouteHandler>>,
): PreparedJsonResponse {
  if (result.outcome === "provisioned") {
    return {
      body: {
        api_token: toApiTokenWire(result.apiToken),
        role_binding: toRoleBindingWire(result.roleBinding),
        token: result.plaintextToken,
        user: result.user,
      },
      status: 201,
    };
  }

  if (result.outcome === "user_exists") {
    const problem = createProblem({
      detail:
        "an account already exists for this email; grant a role to an existing user with POST /v1/iam/role-bindings instead",
      status: 409,
      typeSuffix: "user-exists",
    });
    return {
      body: problem,
      status: problem.status,
    };
  }

  if (result.outcome === "account_disabled") {
    const problem = createAccountDisabledProblem(result.reason);
    return {
      body: problem,
      status: problem.status,
    };
  }

  if (result.outcome === "role_not_supported") {
    const problem = createProblem({
      detail: "role is not supported for user provisioning",
      status: 400,
      typeSuffix: "role-not-supported",
    });
    return {
      body: problem,
      status: problem.status,
    };
  }

  const problem =
    result.reason === "team_not_found"
      ? createTeamNotFoundProblem({
          outcome: "not_found",
          reason: "team_not_found",
        })
      : createProblem({
          detail: "role was not found",
          extensions: {
            outcome: result.outcome,
            reason: result.reason,
          },
          status: 404,
          typeSuffix: "not-found",
        });

  return {
    body: problem,
    status: problem.status,
  };
}

export function prepareIamRoleBindingCreateResponse(
  result: Awaited<ReturnType<IamRoleBindingCreateRouteHandler>>,
): PreparedJsonResponse {
  if (result.outcome === "created" || result.outcome === "already_exists") {
    return {
      body: {
        role_binding: toRoleBindingWire(result.roleBinding),
      },
      status: result.outcome === "created" ? 201 : 200,
    };
  }

  if (result.outcome === "account_disabled") {
    const problem = createAccountDisabledProblem(result.reason);
    return {
      body: problem,
      status: problem.status,
    };
  }

  if (result.outcome === "role_not_supported") {
    const problem = createProblem({
      detail: "role is not supported for team role binding grants",
      status: 400,
      typeSuffix: "role-not-supported",
    });
    return {
      body: problem,
      status: problem.status,
    };
  }

  if (result.outcome === "not_found") {
    const problem =
      result.reason === "team_not_found"
        ? createTeamNotFoundProblem({
            outcome: "not_found",
            reason: "team_not_found",
          })
        : createProblem({
            detail:
              result.reason === "user_not_found"
                ? "user was not found"
                : "role was not found",
            extensions: {
              outcome: result.outcome,
              reason: result.reason,
            },
            status: 404,
            typeSuffix: "not-found",
          });

    return {
      body: problem,
      status: problem.status,
    };
  }

  throw new Error(`unhandled IAM role binding create outcome: ${result}`);
}

export function prepareIamRoleBindingDeleteResponse(
  result: Awaited<ReturnType<IamRoleBindingDeleteRouteHandler>>,
): PreparedJsonResponse {
  if (result.outcome === "deleted") {
    return {
      body: {},
      status: 204,
    };
  }

  if (result.outcome === "last_owner") {
    const problem = createProblem({
      detail: "cannot remove the last owner role binding for the team",
      status: 409,
      typeSuffix: "last-owner",
    });
    return {
      body: problem,
      status: problem.status,
    };
  }

  const problem = createRoleBindingNotFoundProblem();
  return {
    body: problem,
    status: problem.status,
  };
}

export function prepareIamInvitationCreateResponse(
  result: Awaited<ReturnType<IamInvitationCreateRouteHandler>>,
): PreparedJsonResponse {
  if (result.outcome === "pending") {
    return {
      body: {
        invitation: toInvitationWire(result.invitation),
        outcome: "pending",
      },
      status: result.created ? 201 : 200,
    };
  }

  if (
    result.outcome === "accepted_existing_user" ||
    result.outcome === "already_granted"
  ) {
    return {
      body: {
        invitation: result.invitation ? toInvitationWire(result.invitation) : null,
        outcome: result.outcome,
        role_binding: toRoleBindingWire(result.roleBinding),
      },
      status: 200,
    };
  }

  if (result.outcome === "conflict") {
    const problem = createProblem({
      detail: "a pending invitation already exists for this team and email",
      extensions: {
        outcome: result.outcome,
        reason: result.reason,
      },
      status: 409,
      typeSuffix: "invitation-conflict",
    });
    return {
      body: problem,
      status: problem.status,
    };
  }

  if (result.outcome === "account_disabled") {
    const problem = createAccountDisabledProblem(result.reason);
    return {
      body: problem,
      status: problem.status,
    };
  }

  if (result.outcome === "role_not_supported") {
    const problem = createProblem({
      detail: "role is not supported for invitations",
      status: 400,
      typeSuffix: "role-not-supported",
    });
    return {
      body: problem,
      status: problem.status,
    };
  }

  if (result.outcome === "handle_not_found") {
    const problem = createProblem({
      detail: "no GitHub account was found for that handle",
      extensions: {
        outcome: result.outcome,
      },
      status: 422,
      typeSuffix: "github-handle-not-found",
    });
    return {
      body: problem,
      status: problem.status,
    };
  }

  if (result.outcome === "handle_lookup_failed") {
    const problem = createProblem({
      detail:
        "GitHub handle lookup is unavailable; try again or invite by email",
      extensions: {
        outcome: result.outcome,
      },
      status: 503,
      typeSuffix: "github-handle-lookup-failed",
    });
    return {
      body: problem,
      status: problem.status,
    };
  }

  const problem =
    result.reason === "team_not_found"
      ? createTeamNotFoundProblem({
          outcome: "not_found",
          reason: "team_not_found",
        })
      : createProblem({
          detail: "role was not found",
          extensions: {
            outcome: result.outcome,
            reason: result.reason,
          },
          status: 404,
          typeSuffix: "not-found",
        });

  return {
    body: problem,
    status: problem.status,
  };
}

export function prepareIamInvitationRevokeResponse(
  result: Awaited<ReturnType<IamInvitationRevokeRouteHandler>>,
): PreparedJsonResponse {
  if (result.outcome === "revoked") {
    return {
      body: {},
      status: 204,
    };
  }

  if (result.outcome === "conflict") {
    const problem = createProblem({
      detail: "invitation is not pending",
      extensions: {
        outcome: result.outcome,
        reason: result.reason,
      },
      status: 409,
      typeSuffix: "invitation-not-pending",
    });
    return {
      body: problem,
      status: problem.status,
    };
  }

  const problem = createInvitationNotFoundProblem();
  return {
    body: problem,
    status: problem.status,
  };
}

export function createRoleBindingNotFoundProblem(): ProblemDetails {
  return createProblem({
    detail: "role binding was not found",
    extensions: {
      outcome: "not_found",
      reason: "role_binding_not_found",
    },
    status: 404,
    typeSuffix: "not-found",
  });
}

export function createInvitationNotFoundProblem(): ProblemDetails {
  return createProblem({
    detail: "invitation was not found",
    extensions: {
      outcome: "not_found",
      reason: "invitation_not_found",
    },
    status: 404,
    typeSuffix: "not-found",
  });
}

function isIamInvitationStatusFilter(
  value: string | null,
): value is IamInvitationStatusFilter | null {
  return (
    value === null ||
    value === "pending" ||
    value === "accepted" ||
    value === "revoked" ||
    value === "expired" ||
    value === "all"
  );
}

function parseOptionalPositiveInteger(
  value: unknown,
  field: string,
  max: number,
):
  | {
      kind: "success";
      value: number | null;
    }
  | {
      kind: "error";
      problem: ProblemDetails;
    } {
  if (value === undefined || value === null) {
    return {
      kind: "success",
      value: null,
    };
  }

  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > max
  ) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        `${field} must be a positive integer no greater than ${max}`,
        field,
        typeof value === "number" ? "out_of_range" : "invalid_type",
      ),
    };
  }

  return {
    kind: "success",
    value,
  };
}

function parseOptionalTrimmedString(value: unknown):
  | {
      kind: "success";
      value: string | null;
    }
  | {
      kind: "error";
    } {
  if (value === undefined || value === null) {
    return {
      kind: "success",
      value: null,
    };
  }

  if (typeof value !== "string") {
    return {
      kind: "error",
    };
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return {
      kind: "error",
    };
  }

  return {
    kind: "success",
    value: trimmed,
  };
}
