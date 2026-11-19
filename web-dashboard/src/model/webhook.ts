// Webhook endpoints and their deliveries, as the dashboard reads them. The
// contract is server/specs/webhooks-tech-spec.md; the wire mapping is in
// api/hooks/webhooks.ts.

/**
 * The event types this dashboard knows, in the order the form lists them. The
 * server may know more (it is the one that validates a filter), so an
 * endpoint's own `eventTypes` are plain strings.
 */
export const WEBHOOK_EVENT_TYPES = [
  "release.published",
  "release.promoted",
  "release.rolled_back",
  "release.updated",
  "release.disabled",
  "release.enabled",
  "release.failed",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** One line per event type for the form: what happened, in plain words. */
export const WEBHOOK_EVENT_DESCRIPTIONS: Record<WebhookEventType, string> = {
  "release.published": "A new release went live",
  "release.promoted": "A release was promoted into a deployment",
  "release.rolled_back": "A rollback went live",
  "release.updated": "Rollout, mandatory flag, notes or target version changed",
  "release.disabled": "A release was disabled",
  "release.enabled": "A release was enabled again",
  "release.failed": "Publishing or changing a release failed",
};

/**
 * The types the form offers for an endpoint: the catalog, then any type the
 * endpoint already has that this dashboard does not know. A form that offered
 * the catalog alone would drop such a type on save, and an endpoint that had
 * only such types would be saved with an empty filter, which means all events.
 */
export function webhookEventOptions(current: readonly string[]): string[] {
  const known: ReadonlySet<string> = new Set(WEBHOOK_EVENT_TYPES);

  return [...WEBHOOK_EVENT_TYPES, ...current.filter((type) => !known.has(type))];
}

/** The catalog's line for a type, or null for one this dashboard does not know. */
export function describeWebhookEventType(type: string): string | null {
  return (WEBHOOK_EVENT_DESCRIPTIONS as Record<string, string | undefined>)[type] ?? null;
}

export type WebhookStatus = "active" | "disabled";
export type WebhookDeliveryStatus = "pending" | "succeeded" | "failed";

export interface WebhookLastDelivery {
  attemptCount: number;
  eventType: string;
  id: string;
  lastAttemptAt: string | null;
  lastError: string | null;
  lastResponseStatus: number | null;
  status: WebhookDeliveryStatus;
}

export interface Webhook {
  createdAt: string;
  description: string | null;
  /** Empty means every event type. */
  eventTypes: string[];
  id: string;
  lastDelivery: WebhookLastDelivery | null;
  status: WebhookStatus;
  teamId: string;
  url: string;
}

export interface WebhookDelivery {
  attemptCount: number;
  completedAt: string | null;
  createdAt: string;
  eventId: string;
  eventType: string;
  id: string;
  lastAttemptAt: string | null;
  lastError: string | null;
  lastResponseStatus: number | null;
  nextAttemptAt: string | null;
  status: WebhookDeliveryStatus;
  webhookId: string;
}

const ERROR_LABELS: Record<string, string> = {
  blocked_address: "Blocked address",
  endpoint_disabled: "Webhook was disabled",
  http_error: "HTTP error",
  network_error: "Could not connect",
  timeout: "Timed out",
};

/** "All events", or the selected types joined for a table cell. */
export function describeWebhookEvents(eventTypes: readonly string[]): string {
  return eventTypes.length === 0 ? "All events" : eventTypes.join(", ");
}

/**
 * What the latest attempt came back with, for one cell: the HTTP status when
 * there was a response, otherwise the reason there was none. Null before any
 * attempt.
 */
export function describeDeliveryResult(delivery: {
  lastError: string | null;
  lastResponseStatus: number | null;
}): string | null {
  if (delivery.lastResponseStatus !== null) {
    return `HTTP ${delivery.lastResponseStatus}`;
  }
  if (delivery.lastError !== null) {
    return ERROR_LABELS[delivery.lastError] ?? delivery.lastError;
  }
  return null;
}

/** A delivery can be sent again once it has stopped retrying on its own. */
export function canRedeliver(delivery: { status: WebhookDeliveryStatus }): boolean {
  return delivery.status !== "pending";
}

export type WebhookUrlProblem = "empty" | "not_a_url" | "unsupported_scheme";

/**
 * The checks the form can make before asking the server: something was typed,
 * it parses, and it is a web URL. Whether http or a private address is
 * accepted depends on how the server is configured, so that is left to it.
 */
export function checkWebhookUrl(value: string): WebhookUrlProblem | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "empty";
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return "not_a_url";
  }

  return url.protocol === "https:" || url.protocol === "http:" ? null : "unsupported_scheme";
}

/**
 * The fields an edit actually changed, for the PATCH body. Sending the whole
 * form back would also send values the editor never touched, and so undo a
 * change someone else saved while the dialog was open.
 */
export function changedWebhookFields(
  before: Pick<Webhook, "description" | "eventTypes" | "url">,
  after: { description: string | null; eventTypes: string[]; url: string },
): { description?: string | null; eventTypes?: string[]; url?: string } {
  const sameEvents =
    before.eventTypes.length === after.eventTypes.length &&
    before.eventTypes.every((type) => after.eventTypes.includes(type));

  return {
    ...(after.description !== before.description ? { description: after.description } : {}),
    ...(sameEvents ? {} : { eventTypes: after.eventTypes }),
    ...(after.url !== before.url ? { url: after.url } : {}),
  };
}
