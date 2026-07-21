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

/**
 * RFC 7636 code-challenge shape: 43–128 chars from the unreserved set. The
 * S256 challenge the CLI sends is always 43 base64url chars; the wider bound
 * matches what the RFC permits on the wire.
 */
const PKCE_CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;
const MAX_LOOPBACK_PORT = 65535;

export function parseOAuthCliAuthorizationIssueInput(body: unknown):
  | {
      kind: "error";
      problem: ProblemDetails;
    }
  | {
      kind: "success";
      value: {
        codeChallenge: string;
        port: number;
      };
    } {
  if (!isJsonObject(body)) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "CLI authorization body must be a JSON object",
        "body",
        "invalid_type",
      ),
    };
  }

  const codeChallenge = parseRequiredOAuthString(
    body.code_challenge,
    "code_challenge",
  );
  if (codeChallenge.kind === "error") {
    return codeChallenge;
  }

  if (!PKCE_CODE_CHALLENGE_PATTERN.test(codeChallenge.value)) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "code_challenge must be a 43-128 character PKCE S256 challenge",
        "code_challenge",
        "invalid_format",
      ),
    };
  }

  const port = body.port;
  if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > MAX_LOOPBACK_PORT
  ) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        `port must be an integer between 1 and ${MAX_LOOPBACK_PORT}`,
        "port",
        numericRangeReason(port),
      ),
    };
  }

  return {
    kind: "success",
    value: {
      codeChallenge: codeChallenge.value,
      port,
    },
  };
}

export function parseOAuthCliExchangeInput(body: unknown):
  | {
      kind: "error";
      problem: ProblemDetails;
    }
  | {
      kind: "success";
      value: {
        code: string;
        codeVerifier: string;
      };
    } {
  if (!isJsonObject(body)) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "CLI exchange body must be a JSON object",
        "body",
        "invalid_type",
      ),
    };
  }

  const code = parseRequiredOAuthString(body.code, "code");
  if (code.kind === "error") {
    return code;
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
    },
  };
}

export function createOAuthCliExchangeFailedProblem(): ProblemDetails {
  return createProblem({
    detail:
      "CLI authorization code is invalid or expired — run `cmpatch login` again",
    extensions: {
      outcome: "auth_failed",
      reason: "invalid_cli_authorization_code",
    },
    status: 401,
    typeSuffix: "authentication-required",
  });
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
    | "unverified_email"
    | "verified_email_required",
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

  if (reason === "verified_email_required") {
    return createProblem({
      detail:
        "The provider account has no confirmed primary email address — confirm it with the provider, then sign in again",
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

export function createAuthenticationRequiredProblem(): ProblemDetails {
  return createProblem({
    detail: "missing or invalid control-plane api credentials",
    status: 401,
    typeSuffix: "authentication-required",
  });
}
