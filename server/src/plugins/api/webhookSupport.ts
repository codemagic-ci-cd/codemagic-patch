import { createProblem, type ProblemDetails } from "../../app/problemDetails";
import {
  WEBHOOK_RELEASE_EVENT_TYPES,
  type WebhookDelivery,
  type WebhookDeliveryStatus,
  type WebhookEndpoint,
  type WebhookEndpointStatus,
  type WebhookReleaseEventType,
} from "../../domain";
import type {
  WebhookEndpointWithLastDelivery,
  WebhookLastDelivery,
} from "../../repositories";
import type { WebhookUrlRejection } from "../../webhooks/target";
import {
  fieldError,
  isJsonObject,
  parseBoundedIntegerQueryParam,
  singleFieldValidationProblem,
  validationProblem,
} from "./routeValidation";

export const WEBHOOK_DESCRIPTION_MAX_LENGTH = 200;

const RELEASE_EVENT_TYPES: ReadonlySet<string> = new Set(WEBHOOK_RELEASE_EVENT_TYPES);
const ENDPOINT_STATUSES: ReadonlySet<string> = new Set(["active", "disabled"]);
const DELIVERY_STATUSES: ReadonlySet<string> = new Set(["pending", "succeeded", "failed"]);

export const WEBHOOK_DELIVERY_LIST_DEFAULT_LIMIT = 25;
export const WEBHOOK_DELIVERY_LIST_MAX_LIMIT = 100;

type Parsed<T> = { kind: "success"; value: T } | { kind: "error"; problem: ProblemDetails };

export interface WebhookCreateRequest {
  description: string | null;
  eventTypes: WebhookReleaseEventType[];
  url: string;
}

export interface WebhookUpdateRequest {
  description?: string | null;
  eventTypes?: WebhookReleaseEventType[];
  status?: WebhookEndpointStatus;
  url?: string;
}

export function parseWebhookCreateInput(body: unknown): Parsed<WebhookCreateRequest> {
  if (!isJsonObject(body)) {
    return invalid("request body must be a JSON object", "url", "required");
  }

  const url = parseUrl(body.url);
  if (url.kind === "error") {
    return url;
  }
  const description = parseDescription(body.description);
  if (description.kind === "error") {
    return description;
  }
  const eventTypes = parseEventTypes(body.event_types);
  if (eventTypes.kind === "error") {
    return eventTypes;
  }

  return {
    kind: "success",
    value: {
      description: description.value ?? null,
      eventTypes: eventTypes.value ?? [],
      url: url.value,
    },
  };
}

export function parseWebhookUpdateInput(body: unknown): Parsed<WebhookUpdateRequest> {
  const fields = ["url", "description", "event_types", "status"] as const;
  if (!isJsonObject(body) || fields.every((field) => body[field] === undefined)) {
    const detail = "request body must include at least one of url, description, event_types, status";
    return {
      kind: "error",
      problem: validationProblem(
        detail,
        fields.map((field) => fieldError(field, "required", detail)),
      ),
    };
  }

  const value: WebhookUpdateRequest = {};

  if (body.url !== undefined) {
    const url = parseUrl(body.url);
    if (url.kind === "error") {
      return url;
    }
    value.url = url.value;
  }

  const description = parseDescription(body.description);
  if (description.kind === "error") {
    return description;
  }
  if (description.value !== undefined) {
    value.description = description.value;
  }

  const eventTypes = parseEventTypes(body.event_types);
  if (eventTypes.kind === "error") {
    return eventTypes;
  }
  if (eventTypes.value !== undefined) {
    value.eventTypes = eventTypes.value;
  }

  if (body.status !== undefined) {
    if (typeof body.status !== "string") {
      return invalid("status must be a string", "status", "invalid_type");
    }
    if (!ENDPOINT_STATUSES.has(body.status)) {
      return invalid("status must be active or disabled", "status", "invalid_value");
    }
    value.status = body.status as WebhookEndpointStatus;
  }

  return { kind: "success", value };
}

function parseUrl(value: unknown): Parsed<string> {
  if (value === undefined) {
    return invalid("url is required", "url", "required");
  }
  if (typeof value !== "string") {
    return invalid("url must be a string", "url", "invalid_type");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return invalid("url is required", "url", "required");
  }

  return { kind: "success", value: trimmed };
}

/** `undefined` means the field was not sent; `null` clears it. */
function parseDescription(value: unknown): Parsed<string | null | undefined> {
  if (value === undefined || value === null) {
    return { kind: "success", value };
  }
  if (typeof value !== "string") {
    return invalid("description must be a string or null", "description", "invalid_type");
  }
  const trimmed = value.trim();
  if (trimmed.length > WEBHOOK_DESCRIPTION_MAX_LENGTH) {
    return invalid(
      `description must be at most ${WEBHOOK_DESCRIPTION_MAX_LENGTH} characters`,
      "description",
      "out_of_range",
    );
  }

  return { kind: "success", value: trimmed.length === 0 ? null : trimmed };
}

function parseEventTypes(value: unknown): Parsed<WebhookReleaseEventType[] | undefined> {
  if (value === undefined) {
    return { kind: "success", value: undefined };
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return invalid("event_types must be an array of strings", "event_types", "invalid_type");
  }

  const unknown = (value as string[]).filter((item) => !RELEASE_EVENT_TYPES.has(item));
  if (unknown.length > 0) {
    return invalid(
      `event_types has unknown values: ${unknown.join(", ")}. Known: ${WEBHOOK_RELEASE_EVENT_TYPES.join(", ")}`,
      "event_types",
      "invalid_value",
    );
  }

  return {
    kind: "success",
    value: [...new Set(value as WebhookReleaseEventType[])],
  };
}

function invalid(
  detail: string,
  field: string,
  reason: Parameters<typeof singleFieldValidationProblem>[2],
): { kind: "error"; problem: ProblemDetails } {
  return { kind: "error", problem: singleFieldValidationProblem(detail, field, reason) };
}

export interface WebhookDeliveryListQuery {
  limit?: unknown;
  offset?: unknown;
  status?: unknown;
}

export function parseWebhookDeliveryListInput(
  query: WebhookDeliveryListQuery,
): Parsed<{ limit: number; offset: number; status?: WebhookDeliveryStatus }> {
  const limit = parseBoundedIntegerQueryParam(query.limit, {
    defaultValue: WEBHOOK_DELIVERY_LIST_DEFAULT_LIMIT,
    field: "limit",
    max: WEBHOOK_DELIVERY_LIST_MAX_LIMIT,
    min: 1,
    problemDetail: `limit must be an integer from 1 to ${WEBHOOK_DELIVERY_LIST_MAX_LIMIT}`,
  });
  if (limit.kind === "error") {
    return limit;
  }
  const offset = parseBoundedIntegerQueryParam(query.offset, {
    defaultValue: 0,
    field: "offset",
    min: 0,
    problemDetail: "offset must be a non-negative integer",
  });
  if (offset.kind === "error") {
    return offset;
  }

  if (query.status === undefined) {
    return { kind: "success", value: { limit: limit.value, offset: offset.value } };
  }
  if (typeof query.status !== "string") {
    return invalid("status must be given once", "status", "invalid_type");
  }
  if (!DELIVERY_STATUSES.has(query.status)) {
    return invalid("status must be pending, succeeded or failed", "status", "invalid_value");
  }

  return {
    kind: "success",
    value: {
      limit: limit.value,
      offset: offset.value,
      status: query.status as WebhookDeliveryStatus,
    },
  };
}

export function createWebhookDeliveryNotFoundProblem(): ProblemDetails {
  return createProblem({
    detail: "webhook delivery was not found",
    extensions: { outcome: "not_found", reason: "webhook_delivery_not_found" },
    status: 404,
    typeSuffix: "not-found",
  });
}

export function createWebhookDisabledProblem(): ProblemDetails {
  return createProblem({
    detail: "webhook is disabled; enable it before sending to it",
    extensions: { outcome: "disabled" },
    status: 409,
    typeSuffix: "webhook-disabled",
  });
}

export function createWebhookDeliveryPendingProblem(): ProblemDetails {
  return createProblem({
    detail: "delivery is still pending and will be attempted on its own",
    extensions: { outcome: "pending" },
    status: 409,
    typeSuffix: "webhook-delivery-pending",
  });
}

export function toWebhookDeliveryWire(delivery: WebhookDelivery) {
  return {
    attempt_count: delivery.attemptCount,
    completed_at: delivery.completedAt,
    created_at: delivery.createdAt,
    event_id: delivery.eventId,
    event_type: delivery.eventType,
    id: delivery.id,
    last_attempt_at: delivery.lastAttemptAt,
    last_error: delivery.lastError,
    last_response_status: delivery.lastResponseStatus,
    next_attempt_at: delivery.nextAttemptAt,
    status: delivery.status,
    webhook_id: delivery.endpointId,
  };
}

export function createWebhookNotFoundProblem(): ProblemDetails {
  return createProblem({
    detail: "webhook was not found",
    extensions: { outcome: "not_found", reason: "webhook_not_found" },
    status: 404,
    typeSuffix: "not-found",
  });
}

export function createWebhookUrlProblem(reason: WebhookUrlRejection): ProblemDetails {
  const detail =
    reason === "unsupported_scheme"
      ? "url must use https"
      : reason === "blocked_address"
        ? "url points to a private, loopback or link-local address, which this server does not deliver to"
        : "url must be an absolute URL of at most 2048 characters without a user name or password";

  return singleFieldValidationProblem(detail, "url", reason);
}

export function createWebhookLimitProblem(limit: number): ProblemDetails {
  return createProblem({
    detail: `a team can have at most ${limit} webhooks; remove one before adding another`,
    extensions: { limit, outcome: "limit_reached" },
    status: 409,
    typeSuffix: "webhook-limit-reached",
  });
}

export function toWebhookWire(webhook: WebhookEndpointWithLastDelivery) {
  return {
    ...toWebhookEndpointWire(webhook.endpoint),
    last_delivery: webhook.lastDelivery ? toLastDeliveryWire(webhook.lastDelivery) : null,
  };
}

/** The endpoint alone: what an audit snapshot records. Never the secret. */
export function toWebhookEndpointWire(endpoint: WebhookEndpoint) {
  return {
    created_at: endpoint.createdAt,
    created_by: endpoint.createdBy,
    description: endpoint.description,
    event_types: endpoint.eventTypes,
    id: endpoint.id,
    status: endpoint.status,
    team_id: endpoint.teamId,
    updated_at: endpoint.updatedAt,
    url: endpoint.url,
  };
}

function toLastDeliveryWire(delivery: WebhookLastDelivery) {
  return {
    attempt_count: delivery.attemptCount,
    event_type: delivery.eventType,
    id: delivery.id,
    last_attempt_at: delivery.lastAttemptAt,
    last_error: delivery.lastError,
    last_response_status: delivery.lastResponseStatus,
    status: delivery.status,
  };
}
