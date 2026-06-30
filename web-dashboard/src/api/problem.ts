// RFC 9457 application/problem+json parsing + the shared UI-behavior
// classification from the "Error catalog -> UI behavior" mapping.
// Parsing ported from cli/src/problem-details.ts (browser-safe); the CLI-only
// exitCodeForProblemDetails mapping is intentionally not ported.

import type {
  ProblemDetails,
  ProblemFieldError,
  ProblemTypeSuffix,
} from "./types";

/**
 * Shared UI-behavior classes, one per error-catalog row. Screens key
 * messaging off this; `HttpProblemError.typeSuffix` stays available when a
 * screen needs to discriminate inside a grouped row (e.g. the `*-conflict`
 * name family or the two invitation suffixes).
 */
export type ProblemBehavior =
  | "session-expired"
  | "account-disabled"
  | "registration-closed"
  | "forbidden"
  | "not-found"
  | "configuration-error"
  | "validation-error"
  | "status-transition-conflict"
  | "invalid-status-transition"
  | "blocking-job"
  | "release-conflict"
  | "duplicate-release"
  | "rollback-no-op"
  | "name-conflict"
  | "last-owner"
  | "invitation-conflict"
  | "role-not-supported"
  | "idempotency-retry"
  | "idempotency-mismatch"
  | "rate-limited"
  | "provider-unavailable"
  | "retryable"
  | "generic";

const RFC9457_STANDARD_KEYS: ReadonlySet<string> = new Set([
  "type",
  "title",
  "status",
  "detail",
  "instance",
  "errors",
]);

// Mirrors the ProblemTypeSuffix union member-for-member (the Record type
// errors on drift in either direction).
const KNOWN_TYPE_SUFFIXES: Record<ProblemTypeSuffix, true> = {
  "account-disabled": true,
  "active-release-job": true,
  "authentication-required": true,
  "app-conflict": true,
  "duplicate-release": true,
  "forbidden": true,
  "idempotency-in-progress": true,
  "idempotency-mismatch": true,
  "deployment-conflict": true,
  "invitation-conflict": true,
  "invitation-not-pending": true,
  "invalid-status-transition": true,
  "not-found": true,
  "release-conflict": true,
  "role-not-supported": true,
  "rollback-no-op": true,
  "status-transition-conflict": true,
  "team-conflict": true,
  "last-owner": true,
  "user-exists": true,
  "validation-error": true,
};

export function isProblemDetailsContentType(
  contentType: string | null,
): boolean {
  return (
    typeof contentType === "string" &&
    contentType.toLowerCase().includes("application/problem+json")
  );
}

/**
 * `https://codemagic.io/patch/errors/<suffix>` -> `<suffix>` (trailing slashes
 * normalized); `about:blank` and non-strings -> null.
 */
export function getProblemTypeSuffix(type: unknown): string | null {
  if (typeof type !== "string" || type === "about:blank") {
    return null;
  }
  const normalized = type.replace(/\/+$/, "");
  const slashIndex = normalized.lastIndexOf("/");
  return slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1);
}

function toKnownTypeSuffix(type: unknown): ProblemTypeSuffix | null {
  const suffix = getProblemTypeSuffix(type);
  return suffix !== null && Object.hasOwn(KNOWN_TYPE_SUFFIXES, suffix)
    ? (suffix as ProblemTypeSuffix)
    : null;
}

function readFieldErrors(value: unknown): ProblemFieldError[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const fieldErrors: ProblemFieldError[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const { field, message, reason } = entry as Record<string, unknown>;
    if (
      typeof field === "string" &&
      typeof message === "string" &&
      typeof reason === "string"
    ) {
      fieldErrors.push({ field, message, reason });
    }
  }
  return fieldErrors.length > 0 ? fieldErrors : undefined;
}

function readExtensions(problem: ProblemDetails): Record<string, unknown> {
  const extensions: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(problem)) {
    if (!RFC9457_STANDARD_KEYS.has(key)) {
      extensions[key] = value;
    }
  }
  return extensions;
}

export class HttpProblemError extends Error {
  readonly status: number;
  /** Known `https://codemagic.io/patch/errors/<suffix>`; null for `about:blank` or unrecognized types. */
  readonly typeSuffix: ProblemTypeSuffix | null;
  readonly title?: string;
  readonly detail?: string;
  readonly errors?: ProblemFieldError[];
  /** Non-standard problem members (`outcome`, `reason`, `activeJob`, `retry_after`, ...). */
  readonly extensions: Record<string, unknown>;

  constructor(problem: ProblemDetails, responseStatus: number) {
    const title = typeof problem.title === "string" ? problem.title : undefined;
    const status =
      typeof problem.status === "number" && Number.isInteger(problem.status)
        ? problem.status
        : responseStatus;
    super(title ?? `HTTP problem ${status}`);
    this.name = "HttpProblemError";
    this.status = status;
    this.typeSuffix = toKnownTypeSuffix(problem.type);
    this.title = title;
    this.detail =
      typeof problem.detail === "string" ? problem.detail : undefined;
    this.errors = readFieldErrors(problem.errors);
    this.extensions = readExtensions(problem);
  }
}

/**
 * Returns null when the response is not `application/problem+json` (the body
 * is left unread) or when a problem-typed body fails to parse as a JSON
 * object (the body has been consumed).
 */
export async function parseProblemResponse(
  response: Response,
): Promise<HttpProblemError | null> {
  if (!isProblemDetailsContentType(response.headers.get("content-type"))) {
    return null;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  return new HttpProblemError(body as ProblemDetails, response.status);
}

export interface ClassifyProblemOptions {
  /**
   * Set by the `GET /v1/auth/oauth/web-config` caller only: a 404 with no
   * type suffix means web OAuth is unconfigured, not a
   * missing resource. Ordinary `not-found` problems are unaffected.
   */
  webConfigRequest?: boolean;
}

export function classifyProblem(
  error: HttpProblemError,
  options?: ClassifyProblemOptions,
): ProblemBehavior {
  const { status, typeSuffix, extensions } = error;
  if (
    typeSuffix === "forbidden" &&
    extensions.outcome === "registration_closed"
  ) {
    return "registration-closed";
  }
  if (typeSuffix !== null) {
    return behaviorForTypeSuffix(typeSuffix);
  }
  if (status === 404 && options?.webConfigRequest === true) {
    return "configuration-error";
  }
  if (status === 503 && extensions.reason === "provider_error") {
    return "provider-unavailable";
  }
  return fallbackBehavior(status);
}

function behaviorForTypeSuffix(typeSuffix: ProblemTypeSuffix): ProblemBehavior {
  switch (typeSuffix) {
    case "authentication-required":
      return "session-expired";
    case "account-disabled":
      return "account-disabled";
    case "forbidden":
      return "forbidden";
    case "not-found":
      return "not-found";
    case "validation-error":
      return "validation-error";
    case "status-transition-conflict":
      return "status-transition-conflict";
    case "invalid-status-transition":
      return "invalid-status-transition";
    case "active-release-job":
      return "blocking-job";
    case "release-conflict":
      return "release-conflict";
    case "duplicate-release":
      return "duplicate-release";
    case "rollback-no-op":
      return "rollback-no-op";
    case "team-conflict":
    case "app-conflict":
    case "deployment-conflict":
      return "name-conflict";
    case "last-owner":
      return "last-owner";
    case "invitation-conflict":
    case "invitation-not-pending":
      return "invitation-conflict";
    case "role-not-supported":
      return "role-not-supported";
    case "idempotency-in-progress":
      return "idempotency-retry";
    case "idempotency-mismatch":
      return "idempotency-mismatch";
    case "user-exists":
      // Device-flow registration suffix; not in the error catalog.
      return "generic";
  }
}

function fallbackBehavior(status: number): ProblemBehavior {
  if (status === 401) {
    return "session-expired";
  }
  if (status === 429) {
    // `rate-limited` is a deferred server type (error-catalog row); classified
    // defensively by status so a future suffix also lands here.
    return "rate-limited";
  }
  if (status >= 500) {
    return "retryable";
  }
  return "generic";
}
