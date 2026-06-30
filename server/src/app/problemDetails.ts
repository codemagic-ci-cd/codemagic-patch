import type { FastifyReply } from "fastify";

export interface ProblemDetails {
  detail: string;
  errors?: ProblemFieldError[];
  instance?: string;
  status: number;
  title: string;
  type: string;
  [key: string]: unknown;
}

export interface ProblemFieldError {
  field: string;
  message: string;
  reason: string;
}

export type ProblemTypeSuffix =
  | "account-disabled"
  | "active-release-job"
  | "authentication-required"
  | "app-conflict"
  | "duplicate-release"
  | "forbidden"
  | "github-handle-lookup-failed"
  | "github-handle-not-found"
  | "idempotency-in-progress"
  | "idempotency-mismatch"
  | "deployment-conflict"
  | "invitation-conflict"
  | "invitation-not-pending"
  | "invalid-status-transition"
  | "not-found"
  | "release-conflict"
  | "role-not-supported"
  | "rollback-no-op"
  | "status-transition-conflict"
  | "team-conflict"
  | "last-owner"
  | "user-exists"
  | "validation-error";

const PROBLEM_TYPE_BASE = "https://codemagic.io/patch/errors";

export function createProblem(input: {
  detail: string;
  extensions?: Record<string, unknown>;
  status: number;
  typeSuffix?: ProblemTypeSuffix;
}): ProblemDetails {
  return {
    detail: input.detail,
    status: input.status,
    title: problemTitleForType(input.typeSuffix, input.status),
    type: input.typeSuffix
      ? `${PROBLEM_TYPE_BASE}/${input.typeSuffix}`
      : "about:blank",
    ...input.extensions,
  };
}

export function createValidationProblem(
  detail: string,
  errors?: ProblemFieldError[],
): ProblemDetails {
  return createProblem({
    detail,
    extensions: errors && errors.length > 0 ? { errors } : undefined,
    status: 400,
    typeSuffix: "validation-error",
  });
}

export function sendProblem(
  reply: FastifyReply,
  problem: ProblemDetails,
): ProblemDetails {
  reply.status(problem.status);
  reply.type("application/problem+json");

  return problem;
}

function problemTitleForType(
  typeSuffix: ProblemTypeSuffix | undefined,
  status: number,
): string {
  if (typeSuffix === "account-disabled") {
    return "Account disabled";
  }

  if (typeSuffix === "active-release-job") {
    return "Active release job already exists";
  }

  if (typeSuffix === "authentication-required") {
    return "Authentication required";
  }

  if (typeSuffix === "app-conflict") {
    return "App already exists";
  }

  if (typeSuffix === "duplicate-release") {
    return "Duplicate release";
  }

  if (typeSuffix === "forbidden") {
    return "Forbidden";
  }

  if (typeSuffix === "github-handle-not-found") {
    return "GitHub handle not found";
  }

  if (typeSuffix === "github-handle-lookup-failed") {
    return "GitHub handle lookup failed";
  }

  if (typeSuffix === "idempotency-in-progress") {
    return "Idempotent request in progress";
  }

  if (typeSuffix === "idempotency-mismatch") {
    return "Idempotency key mismatch";
  }

  if (typeSuffix === "deployment-conflict") {
    return "Deployment already exists";
  }

  if (typeSuffix === "invitation-conflict") {
    return "Invitation conflict";
  }

  if (typeSuffix === "invitation-not-pending") {
    return "Invitation is not pending";
  }

  if (typeSuffix === "invalid-status-transition") {
    return "Invalid status transition";
  }

  if (typeSuffix === "not-found") {
    return "Resource not found";
  }

  if (typeSuffix === "release-conflict") {
    return "Active rollout blocks new release";
  }

  if (typeSuffix === "role-not-supported") {
    return "Role not supported";
  }

  if (typeSuffix === "rollback-no-op") {
    return "Rollback target is already live";
  }

  if (typeSuffix === "status-transition-conflict") {
    return "Status transition conflict";
  }

  if (typeSuffix === "team-conflict") {
    return "Team already exists";
  }

  if (typeSuffix === "last-owner") {
    return "Last owner";
  }

  if (typeSuffix === "validation-error") {
    return "Validation error";
  }

  return defaultProblemTitle(status);
}

function defaultProblemTitle(status: number): string {
  if (status === 401) {
    return "Unauthorized";
  }

  if (status === 403) {
    return "Forbidden";
  }

  if (status === 404) {
    return "Resource not found";
  }

  if (status === 409) {
    return "Conflict";
  }

  if (status === 413) {
    return "Payload Too Large";
  }

  if (status === 415) {
    return "Unsupported Media Type";
  }

  if (status === 501) {
    return "Not Implemented";
  }

  if (status === 503) {
    return "Service Unavailable";
  }

  return "Error";
}
