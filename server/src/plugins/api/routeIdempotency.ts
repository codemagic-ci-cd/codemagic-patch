import { createHash } from "node:crypto";

import type { FastifyRequest } from "fastify";

import { createProblem, type ProblemDetails } from "../../app/problemDetails";
import type { IdempotencyHandler } from "../../app/types";
import { INVALID_IDEMPOTENCY_KEY_ERROR } from "./routeConstants";
import type { PreparedJsonResponse } from "./routeResponses";
import { singleFieldValidationProblem } from "./routeValidation";

export type IdempotencyRequestState =
  | {
      kind: "skip";
    }
  | {
      key: string;
      kind: "started";
    }
  | {
      kind: "terminal";
      response: PreparedJsonResponse;
    };

export async function startIdempotentRequestIfPresent(
  request: FastifyRequest,
  handler: IdempotencyHandler | undefined,
  bodyHash: string,
): Promise<IdempotencyRequestState> {
  const keyResult = parseIdempotencyKey(request.headers["idempotency-key"]);
  if (keyResult.kind === "error") {
    return {
      kind: "terminal",
      response: {
        body: keyResult.problem,
        status: keyResult.problem.status,
      },
    };
  }

  if (!handler || keyResult.key === null) {
    return {
      kind: "skip",
    };
  }

  const result = await handler.start({
    bodyHash,
    key: keyResult.key,
    method: request.method,
    path: request.url.split("?")[0] ?? request.url,
  });

  if (result.outcome === "started") {
    return {
      key: keyResult.key,
      kind: "started",
    };
  }

  if (result.outcome === "replay") {
    return {
      kind: "terminal",
      response: {
        body: result.body,
        headers: {
          "Idempotency-Replayed": "true",
        },
        status: result.status,
      },
    };
  }

  if (result.outcome === "in_progress") {
    return {
      kind: "terminal",
      response: {
        body: createProblem({
          detail: "request with this Idempotency-Key is still in progress",
          status: 409,
          typeSuffix: "idempotency-in-progress",
        }),
        headers: {
          "Retry-After": "1",
        },
        status: 409,
      },
    };
  }

  return {
    kind: "terminal",
    response: {
      body: createProblem({
        detail:
          "Idempotency-Key was already used with different request parameters",
        status: 422,
        typeSuffix: "idempotency-mismatch",
      }),
      status: 422,
    },
  };
}

export async function completeIdempotentRequestIfStarted(
  handler: IdempotencyHandler | undefined,
  state: IdempotencyRequestState,
  response: PreparedJsonResponse,
): Promise<void> {
  if (!handler || state.kind !== "started") {
    return;
  }

  await handler.complete({
    body: response.body,
    key: state.key,
    status: response.status,
  });
}

export function parseIdempotencyKey(value: unknown):
  | {
      key: string | null;
      kind: "success";
    }
  | {
      kind: "error";
      problem: ProblemDetails;
    } {
  if (value === undefined) {
    return {
      key: null,
      kind: "success",
    };
  }

  if (Array.isArray(value) || typeof value !== "string") {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        INVALID_IDEMPOTENCY_KEY_ERROR,
        "Idempotency-Key",
        "invalid_type",
      ),
    };
  }

  const key = value.trim();
  if (key.length === 0) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        INVALID_IDEMPOTENCY_KEY_ERROR,
        "Idempotency-Key",
        "required",
      ),
    };
  }

  return {
    key,
    kind: "success",
  };
}

export function createRequestBodyHash(value: unknown): string {
  return createHash("sha256").update(stableJsonStringify(value)).digest("hex");
}

export function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJsonStringify).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(record[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}
