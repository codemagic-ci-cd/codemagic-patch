import type {
  TeamId,
  UserId,
  WebhookDelivery,
  WebhookDeliveryId,
  WebhookDeliveryStatus,
  WebhookEndpoint,
  WebhookEndpointId,
  WebhookEndpointStatus,
  WebhookEventId,
  WebhookReleaseEventType,
} from "../domain";
import type {
  RedeliverWebhookResult,
  WebhookEndpointWithLastDelivery,
  WebhookRepository,
} from "../repositories";
import { buildPingPayload } from "./payload";
import { generateWebhookSecret } from "./signature";
import {
  checkWebhookUrl,
  type WebhookTargetOptions,
  type WebhookUrlRejection,
} from "./target";

/**
 * What the webhook routes call (`server/specs/webhooks-tech-spec.md`,
 * Management API). Authorization and input shape are the routes' job; these
 * own the rules that need the store or the server's configuration.
 */
export interface WebhookRouteHandlers {
  create(input: WebhookCreateHandlerInput): Promise<WebhookCreateHandlerResult>;
  delete(webhookId: string): Promise<WebhookEndpoint | null>;
  get(webhookId: string): Promise<WebhookEndpointWithLastDelivery | null>;
  getDelivery(
    webhookId: string,
    deliveryId: string,
  ): Promise<{ delivery: WebhookDelivery; payload: string } | null>;
  list(teamId: string): Promise<WebhookEndpointWithLastDelivery[]>;
  listDeliveries(input: {
    limit: number;
    offset: number;
    status?: WebhookDeliveryStatus;
    webhookId: string;
  }): Promise<{ deliveries: WebhookDelivery[]; total: number }>;
  redeliver(webhookId: string, deliveryId: string): Promise<RedeliverWebhookResult>;
  rotateSecret(
    webhookId: string,
  ): Promise<{ secret: string; webhook: WebhookEndpointWithLastDelivery } | null>;
  /** Queues a `ping` for this endpoint, whatever its filter says. */
  test(webhookId: string): Promise<WebhookTestHandlerResult>;
  update(input: WebhookUpdateHandlerInput): Promise<WebhookUpdateHandlerResult>;
}

export type WebhookTestHandlerResult =
  | { outcome: "disabled" }
  | { outcome: "not_found" }
  | { outcome: "queued"; delivery: WebhookDelivery };

export interface WebhookCreateHandlerInput {
  createdBy: string;
  description: string | null;
  eventTypes: readonly WebhookReleaseEventType[];
  teamId: string;
  url: string;
}

export type WebhookCreateHandlerResult =
  | { outcome: "created"; secret: string; webhook: WebhookEndpointWithLastDelivery }
  | { outcome: "invalid_url"; reason: WebhookUrlRejection }
  | { outcome: "limit_reached"; limit: number }
  | { outcome: "not_found"; reason: "team_not_found" };

export interface WebhookUpdateHandlerInput {
  description?: string | null;
  eventTypes?: readonly WebhookReleaseEventType[];
  status?: WebhookEndpointStatus;
  url?: string;
  webhookId: string;
}

export type WebhookUpdateHandlerResult =
  | { outcome: "invalid_url"; reason: WebhookUrlRejection }
  | { outcome: "not_found" }
  | {
      outcome: "updated";
      previous: WebhookEndpoint;
      webhook: WebhookEndpointWithLastDelivery;
    };

export interface WebhookHandlerDependencies {
  createDeliveryId: () => string;
  createEndpointId: () => string;
  createEventId: () => string;
  now?: () => Date;
  /** Called after a delivery is queued by hand, so it need not wait for a tick. */
  onDeliveryQueued?: () => void;
  repository: WebhookRepository;
  targetOptions: WebhookTargetOptions;
}

export function createWebhookHandlers(
  dependencies: WebhookHandlerDependencies,
): WebhookRouteHandlers {
  const { repository, targetOptions } = dependencies;
  const now = dependencies.now ?? (() => new Date());

  return {
    async create(input) {
      const url = checkWebhookUrl(input.url, targetOptions);
      if (!url.ok) {
        return { outcome: "invalid_url", reason: url.reason };
      }

      const secret = generateWebhookSecret();
      const result = await repository.createEndpoint({
        createdAt: now(),
        createdBy: input.createdBy as UserId,
        description: input.description,
        eventTypes: input.eventTypes,
        id: dependencies.createEndpointId() as WebhookEndpointId,
        secret,
        teamId: input.teamId as TeamId,
        url: url.url,
      });
      if (result.outcome !== "created") {
        return result;
      }

      return {
        outcome: "created",
        secret,
        webhook: { endpoint: result.endpoint, lastDelivery: null },
      };
    },

    list(teamId) {
      return repository.listEndpointsForTeam(teamId as TeamId);
    },

    get(webhookId) {
      return repository.getEndpoint(webhookId as WebhookEndpointId);
    },

    async update(input) {
      let url: string | undefined;
      if (input.url !== undefined) {
        const checked = checkWebhookUrl(input.url, targetOptions);
        if (!checked.ok) {
          return { outcome: "invalid_url", reason: checked.reason };
        }
        url = checked.url;
      }

      const id = input.webhookId as WebhookEndpointId;
      const result = await repository.updateEndpoint({
        description: input.description,
        eventTypes: input.eventTypes,
        id,
        status: input.status,
        updatedAt: now(),
        url,
      });
      if (result.outcome !== "updated") {
        return result;
      }

      const webhook = await repository.getEndpoint(id);

      return {
        outcome: "updated",
        previous: result.previous,
        webhook: webhook ?? { endpoint: result.endpoint, lastDelivery: null },
      };
    },

    delete(webhookId) {
      return repository.deleteEndpoint(webhookId as WebhookEndpointId);
    },

    async rotateSecret(webhookId) {
      const id = webhookId as WebhookEndpointId;
      const secret = generateWebhookSecret();
      const rotated = await repository.rotateEndpointSecret(id, secret, now());
      if (!rotated) {
        return null;
      }

      const webhook = await repository.getEndpoint(id);

      return { secret, webhook: webhook ?? { endpoint: rotated, lastDelivery: null } };
    },

    async test(webhookId) {
      const at = now();
      const result = await repository.recordTestEvent({
        buildPayload: (team) =>
          buildPingPayload({ team, timestamp: at, webhookId: webhookId as WebhookEndpointId }),
        deliveryId: dependencies.createDeliveryId() as WebhookDeliveryId,
        endpointId: webhookId as WebhookEndpointId,
        eventId: dependencies.createEventId() as WebhookEventId,
        now: at,
      });
      if (result.outcome !== "recorded") {
        return result;
      }

      dependencies.onDeliveryQueued?.();
      return { delivery: result.delivery, outcome: "queued" };
    },

    listDeliveries(input) {
      return repository.listDeliveries({
        endpointId: input.webhookId as WebhookEndpointId,
        limit: input.limit,
        offset: input.offset,
        status: input.status,
      });
    },

    getDelivery(webhookId, deliveryId) {
      return repository.getDelivery(
        webhookId as WebhookEndpointId,
        deliveryId as WebhookDeliveryId,
      );
    },

    async redeliver(webhookId, deliveryId) {
      const result = await repository.redeliver(
        webhookId as WebhookEndpointId,
        deliveryId as WebhookDeliveryId,
        now(),
      );
      if (result.outcome === "queued") {
        dependencies.onDeliveryQueued?.();
      }

      return result;
    },
  };
}
