export type ProblemDetails = {
  detail?: string;
  status?: number;
  title?: string;
  type?: string;
} & Record<string, unknown>;

export class HttpProblemError extends Error {
  readonly problem: ProblemDetails;
  readonly responseStatus: number;

  constructor(problem: ProblemDetails, responseStatus: number) {
    super(
      typeof problem.title === "string"
        ? problem.title
        : `HTTP problem ${responseStatus}`,
    );
    this.name = "HttpProblemError";
    this.problem = problem;
    this.responseStatus = responseStatus;
  }
}

export function exitCodeForProblemDetails(
  problem: ProblemDetails,
  responseStatus: number,
): number {
  const typeSuffix = getProblemTypeSuffix(problem.type);

  switch (typeSuffix) {
    case "authentication-required":
      return 2;
    case "validation-error":
    case "role-not-supported":
    case "status-transition-conflict":
    case "invalid-status-transition":
      return 3;
    case "account-disabled":
      return 4;
    case "duplicate-release":
    case "forbidden":
    case "idempotency-mismatch":
    case "last-owner":
    case "not-found":
    case "rate-limited":
    case "release-conflict":
      return 1;
    default:
      return fallbackExitCode(problem.status, responseStatus);
  }
}

export function isProblemDetailsContentType(contentType: string | null): boolean {
  return (
    typeof contentType === "string" &&
    contentType.toLowerCase().includes("application/problem+json")
  );
}

export function getProblemTypeSuffix(type: unknown): string | undefined {
  if (typeof type !== "string" || type === "about:blank") {
    return undefined;
  }

  const normalized = type.replace(/\/+$/, "");
  const slashIndex = normalized.lastIndexOf("/");

  return slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1);
}

function fallbackExitCode(problemStatus: unknown, responseStatus: number): number {
  const status =
    typeof problemStatus === "number" && Number.isInteger(problemStatus)
      ? problemStatus
      : responseStatus;

  if (status === 401) {
    return 2;
  }

  return 1;
}
