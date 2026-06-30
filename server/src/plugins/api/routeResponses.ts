import type { FastifyReply } from "fastify";

import type { ProblemDetails } from "../../app/problemDetails";

export interface PreparedJsonResponse {
  body: unknown;
  headers?: Record<string, string>;
  status: number;
}

export function sendPreparedJsonResponse(
  reply: FastifyReply,
  response: PreparedJsonResponse,
) {
  reply.status(response.status);
  for (const [name, value] of Object.entries(response.headers ?? {})) {
    reply.header(name, value);
  }
  if (isProblemDetailsBody(response.body)) {
    reply.type("application/problem+json");
  }
  return reply.send(response.body);
}

export function isProblemDetailsBody(body: unknown): body is ProblemDetails {
  return (
    typeof body === "object" &&
    body !== null &&
    "status" in body &&
    "title" in body &&
    "type" in body
  );
}
