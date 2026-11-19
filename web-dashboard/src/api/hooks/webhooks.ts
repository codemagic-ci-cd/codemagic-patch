// TanStack Query bindings for the webhook endpoints
// (server/specs/webhooks-tech-spec.md → Management API). Conventions as in
// teams.ts: single-field envelopes unwrap. Create and rotate-secret return
// the show-once signing secret as mutation data and set `gcTime: 0`, so it
// leaves the mutation cache as soon as the dialog that showed it unmounts.
// Every route needs `webhook.manage`; a 403 propagates untouched.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  Webhook,
  WebhookDelivery,
  WebhookDeliveryStatus,
  WebhookLastDelivery,
  WebhookStatus,
} from "../../model/webhook";
import { authenticatedRequest } from "../client";

interface LastDeliveryWire {
  attempt_count: number;
  event_type: string;
  id: string;
  last_attempt_at: string | null;
  last_error: string | null;
  last_response_status: number | null;
  status: WebhookDeliveryStatus;
}

interface WebhookWire {
  created_at: string;
  description: string | null;
  event_types: string[];
  id: string;
  last_delivery: LastDeliveryWire | null;
  status: WebhookStatus;
  team_id: string;
  url: string;
}

interface WebhookDeliveryWire extends LastDeliveryWire {
  completed_at: string | null;
  created_at: string;
  event_id: string;
  next_attempt_at: string | null;
  webhook_id: string;
}

function fromLastDeliveryWire(wire: LastDeliveryWire): WebhookLastDelivery {
  return {
    attemptCount: wire.attempt_count,
    eventType: wire.event_type,
    id: wire.id,
    lastAttemptAt: wire.last_attempt_at,
    lastError: wire.last_error,
    lastResponseStatus: wire.last_response_status,
    status: wire.status,
  };
}

export function fromWebhookWire(wire: WebhookWire): Webhook {
  return {
    createdAt: wire.created_at,
    description: wire.description,
    eventTypes: wire.event_types,
    id: wire.id,
    lastDelivery: wire.last_delivery === null ? null : fromLastDeliveryWire(wire.last_delivery),
    status: wire.status,
    teamId: wire.team_id,
    url: wire.url,
  };
}

export function fromWebhookDeliveryWire(wire: WebhookDeliveryWire): WebhookDelivery {
  return {
    ...fromLastDeliveryWire(wire),
    completedAt: wire.completed_at,
    createdAt: wire.created_at,
    eventId: wire.event_id,
    nextAttemptAt: wire.next_attempt_at,
    webhookId: wire.webhook_id,
  };
}

export interface WebhookCreateInput {
  description: string | null;
  eventTypes: string[];
  url: string;
}

export interface WebhookUpdateInput {
  description?: string | null;
  eventTypes?: string[];
  status?: WebhookStatus;
  url?: string;
}

/** The endpoint together with its signing secret, returned exactly once. */
export interface WebhookWithSecret {
  secret: string;
  webhook: Webhook;
}

export const webhookKeys = {
  all: ["webhooks"] as const,
  list: (teamId: string) => [...webhookKeys.all, "list", teamId] as const,
  /** Prefix covering every page and filter of one endpoint's deliveries. */
  deliveries: (webhookId: string) => [...webhookKeys.all, "deliveries", webhookId] as const,
  deliveryPage: (webhookId: string, status: WebhookDeliveryStatus | "all", offset: number) =>
    [...webhookKeys.deliveries(webhookId), status, offset] as const,
  delivery: (webhookId: string, deliveryId: string) =>
    [...webhookKeys.all, "delivery", webhookId, deliveryId] as const,
};

function webhookPath(webhookId: string, suffix = ""): string {
  return `/webhooks/${encodeURIComponent(webhookId)}${suffix}`;
}

/** `GET /v1/teams/:teamId/webhooks`. */
export function useWebhooks(teamId: string) {
  return useQuery({
    queryKey: webhookKeys.list(teamId),
    queryFn: async ({ signal }) => {
      const { webhooks } = await authenticatedRequest<{ webhooks: WebhookWire[] }>({
        method: "GET",
        path: `/teams/${encodeURIComponent(teamId)}/webhooks`,
        signal,
      });
      return webhooks.map(fromWebhookWire);
    },
  });
}

function toWireBody(input: WebhookUpdateInput): Record<string, unknown> {
  return {
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.eventTypes !== undefined ? { event_types: input.eventTypes } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.url !== undefined ? { url: input.url } : {}),
  };
}

/** `POST /v1/teams/:teamId/webhooks` → 201 `{ webhook, secret }`. */
export function useCreateWebhook(teamId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: async (input: WebhookCreateInput): Promise<WebhookWithSecret> => {
      const response = await authenticatedRequest<{ secret: string; webhook: WebhookWire }>({
        body: toWireBody(input),
        method: "POST",
        path: `/teams/${encodeURIComponent(teamId)}/webhooks`,
      });
      return { secret: response.secret, webhook: fromWebhookWire(response.webhook) };
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: webhookKeys.list(teamId) });
    },
  });
}

/** `PATCH /v1/webhooks/:webhookId`. */
export function useUpdateWebhook(teamId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: WebhookUpdateInput & { webhookId: string }) => {
      const { webhookId, ...changes } = input;
      const response = await authenticatedRequest<{ webhook: WebhookWire }>({
        body: toWireBody(changes),
        method: "PATCH",
        path: webhookPath(webhookId),
      });
      return fromWebhookWire(response.webhook);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: webhookKeys.list(teamId) });
    },
  });
}

/** `DELETE /v1/webhooks/:webhookId` → 204. */
export function useDeleteWebhook(teamId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (webhookId: string) =>
      authenticatedRequest<void>({ method: "DELETE", path: webhookPath(webhookId) }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: webhookKeys.list(teamId) });
    },
  });
}

/** `POST /v1/webhooks/:webhookId/rotate-secret` → `{ webhook, secret }`. */
export function useRotateWebhookSecret() {
  return useMutation({
    gcTime: 0,
    mutationFn: async (webhookId: string): Promise<WebhookWithSecret> => {
      const response = await authenticatedRequest<{ secret: string; webhook: WebhookWire }>({
        method: "POST",
        path: webhookPath(webhookId, "/rotate-secret"),
      });
      return { secret: response.secret, webhook: fromWebhookWire(response.webhook) };
    },
  });
}

/** Refreshes what a queued delivery changes: the list's latest result and the history. */
function useInvalidateDeliveries(teamId: string) {
  const queryClient = useQueryClient();
  return async (webhookId: string) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: webhookKeys.list(teamId) }),
      queryClient.invalidateQueries({ queryKey: webhookKeys.deliveries(webhookId) }),
    ]);
  };
}

/** `POST /v1/webhooks/:webhookId/test` → 202 `{ delivery }`. */
export function useTestWebhook(teamId: string) {
  const invalidate = useInvalidateDeliveries(teamId);
  return useMutation({
    mutationFn: async (webhookId: string) => {
      const response = await authenticatedRequest<{ delivery: WebhookDeliveryWire }>({
        method: "POST",
        path: webhookPath(webhookId, "/test"),
      });
      return fromWebhookDeliveryWire(response.delivery);
    },
    onSuccess: (_delivery, webhookId) => invalidate(webhookId),
  });
}

export const WEBHOOK_DELIVERY_PAGE_SIZE = 25;

/** `GET /v1/webhooks/:webhookId/deliveries`, one page, newest first. */
export function useWebhookDeliveries(
  webhookId: string,
  options: { offset: number; status: WebhookDeliveryStatus | "all" },
) {
  return useQuery({
    queryKey: webhookKeys.deliveryPage(webhookId, options.status, options.offset),
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams({
        limit: String(WEBHOOK_DELIVERY_PAGE_SIZE),
        offset: String(options.offset),
        ...(options.status === "all" ? {} : { status: options.status }),
      });
      const response = await authenticatedRequest<{
        deliveries: WebhookDeliveryWire[];
        total: number;
      }>({
        method: "GET",
        path: `${webhookPath(webhookId, "/deliveries")}?${query.toString()}`,
        signal,
      });
      return {
        deliveries: response.deliveries.map(fromWebhookDeliveryWire),
        total: response.total,
      };
    },
  });
}

/** `GET /v1/webhooks/:webhookId/deliveries/:deliveryId` → the delivery and the body sent. */
export function useWebhookDelivery(webhookId: string, deliveryId: string | null) {
  return useQuery({
    enabled: deliveryId !== null,
    queryKey: webhookKeys.delivery(webhookId, deliveryId ?? ""),
    queryFn: async ({ signal }) => {
      const response = await authenticatedRequest<{
        delivery: WebhookDeliveryWire;
        payload: unknown;
      }>({
        method: "GET",
        path: webhookPath(webhookId, `/deliveries/${encodeURIComponent(deliveryId ?? "")}`),
        signal,
      });
      return {
        delivery: fromWebhookDeliveryWire(response.delivery),
        payload: response.payload,
      };
    },
  });
}

/** `POST /v1/webhooks/:webhookId/deliveries/:deliveryId/redeliver` → 202 `{ delivery }`. */
export function useRedeliverWebhook(teamId: string) {
  const invalidate = useInvalidateDeliveries(teamId);
  return useMutation({
    mutationFn: async (input: { deliveryId: string; webhookId: string }) => {
      const response = await authenticatedRequest<{ delivery: WebhookDeliveryWire }>({
        method: "POST",
        path: webhookPath(
          input.webhookId,
          `/deliveries/${encodeURIComponent(input.deliveryId)}/redeliver`,
        ),
      });
      return fromWebhookDeliveryWire(response.delivery);
    },
    onSuccess: (_delivery, input) => invalidate(input.webhookId),
  });
}
