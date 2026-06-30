import type { FastifyRequest } from "fastify";

import {
  createProblem,
  createValidationProblem,
  type ProblemDetails,
} from "../../app/problemDetails";
import {
  INVALID_API_TOKEN_EXPIRATION_DAYS_ERROR,
  MAX_API_TOKEN_EXPIRATION_DAYS,
  MAX_OAUTH_PUBLIC_STRING_LENGTH,
} from "./routeSupport";
import {
  headerToSingleValue,
  isJsonObject,
  numericRangeReason,
  parseRequiredTrimmedString,
  requiredStringReason,
  singleFieldValidationProblem,
} from "./routeValidation";

export function parseApiTokenCreateInput(
  body: unknown,
  userId: string,
):
  | {
      kind: "error";
      problem: ProblemDetails;
    }
  | {
      kind: "success";
      value: {
        displayName: string;
        expiresInDays?: number;
        userId: string;
      };
    } {
  if (!isJsonObject(body)) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "api token creation body must be a JSON object",
        "body",
        "invalid_type",
      ),
    };
  }

  const displayName = parseRequiredTrimmedString(body.display_name);
  if (displayName === null) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "display_name must be a non-empty string",
        "display_name",
        requiredStringReason(body.display_name),
      ),
    };
  }

  const expiresInDays = body.expires_in_days;
  if (
    expiresInDays !== undefined &&
    (typeof expiresInDays !== "number" ||
      !Number.isInteger(expiresInDays) ||
      expiresInDays <= 0 ||
      expiresInDays > MAX_API_TOKEN_EXPIRATION_DAYS)
  ) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        INVALID_API_TOKEN_EXPIRATION_DAYS_ERROR,
        "expires_in_days",
        numericRangeReason(expiresInDays),
      ),
    };
  }

  return {
    kind: "success",
    value: {
      displayName,
      expiresInDays:
        expiresInDays === undefined ? undefined : expiresInDays,
      userId,
    },
  };
}

export function parseOAuthCallbackInput(body: unknown):
  | {
      kind: "error";
      problem: ProblemDetails;
    }
  | {
      kind: "success";
      value: {
        code: string;
        codeVerifier: string;
        provider: string;
        redirectUri: string;
      };
    } {
  if (!isJsonObject(body)) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "OAuth callback body must be a JSON object",
        "body",
        "invalid_type",
      ),
    };
  }

  const provider = parseRequiredOAuthString(body.provider, "provider");
  if (provider.kind === "error") {
    return provider;
  }

  const code = parseRequiredOAuthString(body.code, "code");
  if (code.kind === "error") {
    return code;
  }

  const redirectUri = parseRequiredOAuthString(body.redirect_uri, "redirect_uri");
  if (redirectUri.kind === "error") {
    return redirectUri;
  }

  const codeVerifier = parseRequiredOAuthString(
    body.code_verifier,
    "code_verifier",
  );
  if (codeVerifier.kind === "error") {
    return codeVerifier;
  }

  return {
    kind: "success",
    value: {
      code: code.value,
      codeVerifier: codeVerifier.value,
      provider: provider.value,
      redirectUri: redirectUri.value,
    },
  };
}

export function parseOAuthDeviceStartInput(body: unknown):
  | {
      kind: "error";
      problem: ProblemDetails;
    }
  | {
      kind: "success";
      value: {
        provider: string;
      };
    } {
  if (!isJsonObject(body)) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "OAuth device start body must be a JSON object",
        "body",
        "invalid_type",
      ),
    };
  }

  const provider = parseRequiredOAuthString(body.provider, "provider");
  if (provider.kind === "error") {
    return provider;
  }

  return {
    kind: "success",
    value: {
      provider: provider.value,
    },
  };
}

export function parseOAuthDevicePollInput(body: unknown):
  | {
      kind: "error";
      problem: ProblemDetails;
    }
  | {
      kind: "success";
      value: {
        pollToken: string;
        provider: string;
      };
    } {
  if (!isJsonObject(body)) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "OAuth device poll body must be a JSON object",
        "body",
        "invalid_type",
      ),
    };
  }

  const provider = parseRequiredOAuthString(body.provider, "provider");
  if (provider.kind === "error") {
    return provider;
  }

  const pollToken = parseRequiredOAuthString(body.poll_token, "poll_token");
  if (pollToken.kind === "error") {
    return pollToken;
  }

  return {
    kind: "success",
    value: {
      pollToken: pollToken.value,
      provider: provider.value,
    },
  };
}

export function parseOAuthRefreshTokenInput(body: unknown):
  | {
      kind: "error";
      problem: ProblemDetails;
    }
  | {
      kind: "success";
      value: {
        refreshToken: string;
      };
    } {
  if (!isJsonObject(body)) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "OAuth session body must be a JSON object",
        "body",
        "invalid_type",
      ),
    };
  }

  const refreshToken = parseRequiredOAuthString(
    body.refresh_token,
    "refresh_token",
  );
  if (refreshToken.kind === "error") {
    return refreshToken;
  }

  return {
    kind: "success",
    value: {
      refreshToken: refreshToken.value,
    },
  };
}

export function parseRequiredOAuthString(
  value: unknown,
  field: string,
):
  | {
      kind: "error";
      problem: ProblemDetails;
    }
  | {
      kind: "success";
      value: string;
    } {
  const parsed = parseRequiredTrimmedString(value);
  if (parsed === null) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        `${field} must be a non-empty string`,
        field,
        requiredStringReason(value),
      ),
    };
  }

  if (parsed.length > MAX_OAUTH_PUBLIC_STRING_LENGTH) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        `${field} must be no longer than ${MAX_OAUTH_PUBLIC_STRING_LENGTH} characters`,
        field,
        "out_of_range",
      ),
    };
  }

  return {
    kind: "success",
    value: parsed,
  };
}

export function publicAuthAuditContextFromRequest(request: FastifyRequest): {
  ip: string | null;
  requestId: string | null;
  userAgent: string | null;
} {
  return {
    ip: request.ip ?? null,
    requestId: request.id ?? null,
    userAgent: headerToSingleValue(request.headers["user-agent"]),
  };
}

export function createRegistrationClosedProblem(): ProblemDetails {
  return createProblem({
    detail:
      "Registration is invite-only. Ask an admin to invite your email address, then sign in again.",
    extensions: {
      outcome: "registration_closed",
      reason: "registration_invite_only",
    },
    status: 403,
    typeSuffix: "forbidden",
  });
}

export function createOAuthAuthFailedProblem(
  reason:
    | "invalid_grant"
    | "provider_error"
    | "unknown_provider"
    | "unverified_email",
): ProblemDetails {
  if (reason === "unknown_provider") {
    return createValidationProblem("OAuth provider is not configured");
  }

  if (reason === "unverified_email") {
    return createProblem({
      detail: "OAuth provider email is not verified",
      extensions: {
        outcome: "auth_failed",
        reason,
      },
      status: 401,
      typeSuffix: "authentication-required",
    });
  }

  return createProblem({
    detail:
      reason === "invalid_grant"
        ? "OAuth authorization code was rejected"
        : "OAuth provider exchange failed",
    extensions: {
      outcome: "auth_failed",
      reason,
    },
    status: reason === "invalid_grant" ? 401 : 503,
    typeSuffix: reason === "invalid_grant" ? "authentication-required" : undefined,
  });
}

export function createOAuthDeviceAuthFailedProblem(
  reason:
    | "access_denied"
    | "email_scope_required"
    | "expired_token"
    | "invalid_poll_token"
    | "provider_error"
    | "unknown_provider"
    | "verified_email_required",
): ProblemDetails {
  if (reason === "unknown_provider") {
    return createValidationProblem("OAuth provider is not configured");
  }

  if (reason === "provider_error") {
    return createProblem({
      detail: "OAuth provider exchange failed",
      extensions: {
        outcome: "auth_failed",
        reason,
      },
      status: 503,
    });
  }

  const details: Record<Exclude<typeof reason, "provider_error" | "unknown_provider">, string> = {
    access_denied: "OAuth device authorization was denied",
    email_scope_required: "GitHub email scope is required",
    expired_token: "OAuth device authorization expired",
    invalid_poll_token: "OAuth device poll token is invalid or expired",
    verified_email_required: "GitHub verified primary email is required",
  };

  return createProblem({
    detail: details[reason],
    extensions: {
      outcome: "auth_failed",
      reason,
    },
    status: 401,
    typeSuffix: "authentication-required",
  });
}

export function createAuthenticationRequiredProblem(): ProblemDetails {
  return createProblem({
    detail: "missing or invalid control-plane api credentials",
    status: 401,
    typeSuffix: "authentication-required",
  });
}
