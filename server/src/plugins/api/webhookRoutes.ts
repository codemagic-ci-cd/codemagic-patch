import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  createProblem,
  sendProblem,
  type ProblemDetails,
} from "../../app/problemDetails";
import type { WebhookEndpointWithLastDelivery } from "../../repositories";
import type { WebhookRouteHandlers } from "../../webhooks/handlers";
import {
  authorizeVisibleResourceAccess,
  createTeamNotFoundProblem,
  requireControlPlanePrincipal,
  writeAuditEventIfConfigured,
} from "./routeSupport";
import type { ApiRoutesOptions } from "./routeTypes";
import {
  createWebhookDeliveryNotFoundProblem,
  createWebhookDeliveryPendingProblem,
  createWebhookDisabledProblem,
  createWebhookLimitProblem,
  createWebhookNotFoundProblem,
  createWebhookUrlProblem,
  parseWebhookCreateInput,
  parseWebhookDeliveryListInput,
  parseWebhookUpdateInput,
  toWebhookDeliveryWire,
  toWebhookEndpointWire,
  toWebhookWire,
  type WebhookDeliveryListQuery,
} from "./webhookSupport";

interface TeamParams {
  teamId: string;
}

interface WebhookParams {
  webhookId: string;
}

interface WebhookDeliveryParams extends WebhookParams {
  deliveryId: string;
}

/**
 * `server/specs/webhooks-tech-spec.md`, Management API. Every route needs
 * `webhook.manage` on the endpoint's team, reads included.
 *
 * Create, update and rotate-secret stay session-only: they decide where
 * release data goes and hand out a secret. Delete only shrinks what is sent,
 * and test and redeliver send to a URL a session already approved, so those
 * three take an API token too.
 */
export function registerWebhookRoutes(
  controlPlane: FastifyInstance,
  options: ApiRoutesOptions,
): void {
  controlPlane.post<{ Body: unknown; Params: TeamParams }>(
    "/teams/:teamId/webhooks",
    async (request, reply) => {
      const handlers = options.webhookHandlers;
      if (!handlers) {
        return sendProblem(reply, notImplementedProblem());
      }

      const input = parseWebhookCreateInput(request.body);
      if (input.kind === "error") {
        return sendProblem(reply, input.problem);
      }

      const denied = await authorizeTeam(options, request, request.params.teamId);
      if (denied) {
        return sendProblem(reply, denied);
      }

      const result = await handlers.create({
        ...input.value,
        createdBy: requireControlPlanePrincipal(request).userId,
        teamId: request.params.teamId,
      });
      if (result.outcome === "invalid_url") {
        return sendProblem(reply, createWebhookUrlProblem(result.reason));
      }
      if (result.outcome === "limit_reached") {
        return sendProblem(reply, createWebhookLimitProblem(result.limit));
      }
      if (result.outcome === "not_found") {
        return sendProblem(reply, createTeamNotFoundProblem(result));
      }

      await writeAuditEventIfConfigured(options.auditEventWriteHandler, request, {
        action: "webhook.created",
        afterState: toWebhookEndpointWire(result.webhook.endpoint),
        beforeState: null,
        resourceId: result.webhook.endpoint.id,
        resourceType: "webhook",
        result: "success",
        teamId: result.webhook.endpoint.teamId,
      });

      reply.status(201);
      return { secret: result.secret, webhook: toWebhookWire(result.webhook) };
    },
  );

  controlPlane.get<{ Params: TeamParams }>(
    "/teams/:teamId/webhooks",
    async (request, reply) => {
      const handlers = options.webhookHandlers;
      if (!handlers) {
        return sendProblem(reply, notImplementedProblem());
      }

      const denied = await authorizeTeam(options, request, request.params.teamId);
      if (denied) {
        return sendProblem(reply, denied);
      }

      const webhooks = await handlers.list(request.params.teamId);
      return { webhooks: webhooks.map(toWebhookWire) };
    },
  );

  controlPlane.get<{ Params: WebhookParams }>(
    "/webhooks/:webhookId",
    async (request, reply) => {
      const handlers = options.webhookHandlers;
      if (!handlers) {
        return sendProblem(reply, notImplementedProblem());
      }

      const found = await findAuthorizedWebhook(options, handlers, request);
      if (found.kind === "error") {
        return sendProblem(reply, found.problem);
      }
      const webhook = found.webhook;

      return { webhook: toWebhookWire(webhook) };
    },
  );

  controlPlane.patch<{ Body: unknown; Params: WebhookParams }>(
    "/webhooks/:webhookId",
    async (request, reply) => {
      const handlers = options.webhookHandlers;
      if (!handlers) {
        return sendProblem(reply, notImplementedProblem());
      }

      const input = parseWebhookUpdateInput(request.body);
      if (input.kind === "error") {
        return sendProblem(reply, input.problem);
      }

      const found = await findAuthorizedWebhook(options, handlers, request);
      if (found.kind === "error") {
        return sendProblem(reply, found.problem);
      }

      const result = await handlers.update({
        ...input.value,
        webhookId: request.params.webhookId,
      });
      if (result.outcome === "invalid_url") {
        return sendProblem(reply, createWebhookUrlProblem(result.reason));
      }
      if (result.outcome === "not_found") {
        return sendProblem(reply, createWebhookNotFoundProblem());
      }

      await writeAuditEventIfConfigured(options.auditEventWriteHandler, request, {
        action: "webhook.updated",
        afterState: toWebhookEndpointWire(result.webhook.endpoint),
        beforeState: toWebhookEndpointWire(result.previous),
        resourceId: result.webhook.endpoint.id,
        resourceType: "webhook",
        result: "success",
        teamId: result.webhook.endpoint.teamId,
      });

      return { webhook: toWebhookWire(result.webhook) };
    },
  );

  controlPlane.delete<{ Params: WebhookParams }>(
    "/webhooks/:webhookId",
    { config: { allowApiToken: true } },
    async (request, reply) => {
      const handlers = options.webhookHandlers;
      if (!handlers) {
        return sendProblem(reply, notImplementedProblem());
      }

      const found = await findAuthorizedWebhook(options, handlers, request);
      if (found.kind === "error") {
        return sendProblem(reply, found.problem);
      }

      const deleted = await handlers.delete(request.params.webhookId);
      if (!deleted) {
        return sendProblem(reply, createWebhookNotFoundProblem());
      }

      await writeAuditEventIfConfigured(options.auditEventWriteHandler, request, {
        action: "webhook.deleted",
        afterState: null,
        beforeState: toWebhookEndpointWire(deleted),
        resourceId: deleted.id,
        resourceType: "webhook",
        result: "success",
        teamId: deleted.teamId,
      });

      reply.status(204);
      return reply.send();
    },
  );

  controlPlane.post<{ Params: WebhookParams }>(
    "/webhooks/:webhookId/rotate-secret",
    async (request, reply) => {
      const handlers = options.webhookHandlers;
      if (!handlers) {
        return sendProblem(reply, notImplementedProblem());
      }

      const found = await findAuthorizedWebhook(options, handlers, request);
      if (found.kind === "error") {
        return sendProblem(reply, found.problem);
      }
      const webhook = found.webhook;

      const rotated = await handlers.rotateSecret(request.params.webhookId);
      if (!rotated) {
        return sendProblem(reply, createWebhookNotFoundProblem());
      }

      await writeAuditEventIfConfigured(options.auditEventWriteHandler, request, {
        action: "webhook.secret_rotated",
        afterState: toWebhookEndpointWire(rotated.webhook.endpoint),
        beforeState: toWebhookEndpointWire(webhook.endpoint),
        resourceId: rotated.webhook.endpoint.id,
        resourceType: "webhook",
        result: "success",
        teamId: rotated.webhook.endpoint.teamId,
      });

      return { secret: rotated.secret, webhook: toWebhookWire(rotated.webhook) };
    },
  );

  controlPlane.post<{ Params: WebhookParams }>(
    "/webhooks/:webhookId/test",
    { config: { allowApiToken: true } },
    async (request, reply) => {
      const handlers = options.webhookHandlers;
      if (!handlers) {
        return sendProblem(reply, notImplementedProblem());
      }

      const found = await findAuthorizedWebhook(options, handlers, request);
      if (found.kind === "error") {
        return sendProblem(reply, found.problem);
      }

      const result = await handlers.test(request.params.webhookId);
      if (result.outcome === "not_found") {
        return sendProblem(reply, createWebhookNotFoundProblem());
      }
      if (result.outcome === "disabled") {
        return sendProblem(reply, createWebhookDisabledProblem());
      }

      reply.status(202);
      return { delivery: toWebhookDeliveryWire(result.delivery) };
    },
  );

  controlPlane.get<{ Params: WebhookParams; Querystring: WebhookDeliveryListQuery }>(
    "/webhooks/:webhookId/deliveries",
    async (request, reply) => {
      const handlers = options.webhookHandlers;
      if (!handlers) {
        return sendProblem(reply, notImplementedProblem());
      }

      const input = parseWebhookDeliveryListInput(request.query);
      if (input.kind === "error") {
        return sendProblem(reply, input.problem);
      }

      const found = await findAuthorizedWebhook(options, handlers, request);
      if (found.kind === "error") {
        return sendProblem(reply, found.problem);
      }

      const result = await handlers.listDeliveries({
        ...input.value,
        webhookId: request.params.webhookId,
      });
      return {
        deliveries: result.deliveries.map(toWebhookDeliveryWire),
        total: result.total,
      };
    },
  );

  controlPlane.get<{ Params: WebhookDeliveryParams }>(
    "/webhooks/:webhookId/deliveries/:deliveryId",
    async (request, reply) => {
      const handlers = options.webhookHandlers;
      if (!handlers) {
        return sendProblem(reply, notImplementedProblem());
      }

      const found = await findAuthorizedWebhook(options, handlers, request);
      if (found.kind === "error") {
        return sendProblem(reply, found.problem);
      }

      const result = await handlers.getDelivery(
        request.params.webhookId,
        request.params.deliveryId,
      );
      if (!result) {
        return sendProblem(reply, createWebhookDeliveryNotFoundProblem());
      }

      return {
        delivery: toWebhookDeliveryWire(result.delivery),
        // The stored body, parsed: it is what the receiver was sent.
        payload: JSON.parse(result.payload) as unknown,
      };
    },
  );

  controlPlane.post<{ Params: WebhookDeliveryParams }>(
    "/webhooks/:webhookId/deliveries/:deliveryId/redeliver",
    { config: { allowApiToken: true } },
    async (request, reply) => {
      const handlers = options.webhookHandlers;
      if (!handlers) {
        return sendProblem(reply, notImplementedProblem());
      }

      const found = await findAuthorizedWebhook(options, handlers, request);
      if (found.kind === "error") {
        return sendProblem(reply, found.problem);
      }

      const result = await handlers.redeliver(
        request.params.webhookId,
        request.params.deliveryId,
      );
      if (result.outcome === "not_found") {
        return sendProblem(reply, createWebhookDeliveryNotFoundProblem());
      }
      if (result.outcome === "disabled") {
        return sendProblem(reply, createWebhookDisabledProblem());
      }
      if (result.outcome === "pending") {
        return sendProblem(reply, createWebhookDeliveryPendingProblem());
      }

      reply.status(202);
      return { delivery: toWebhookDeliveryWire(result.delivery) };
    },
  );
}

function notImplementedProblem(): ProblemDetails {
  return createProblem({ detail: "webhooks are not implemented", status: 501 });
}

/** Returns the problem to send, or `null` when the caller may manage the team's webhooks. */
async function authorizeTeam(
  options: ApiRoutesOptions,
  request: FastifyRequest,
  teamId: string,
) {
  const authorization = await authorizeVisibleResourceAccess(
    options.authorizationService,
    request.controlPlanePrincipal,
    "webhook.manage",
    () => options.authorizationService!.resolveTeamScope(teamId),
    createTeamNotFoundProblem({ outcome: "not_found", reason: "team_not_found" }),
  );

  return authorization.kind === "error" ? authorization.problem : null;
}

/**
 * Loads the endpoint and checks the caller against its team. A missing
 * endpoint, one in a team the caller cannot see, and one in the caller's own
 * team that they may not manage all answer the same 404, so the route does
 * not confirm that an id exists.
 */
async function findAuthorizedWebhook(
  options: ApiRoutesOptions,
  handlers: WebhookRouteHandlers,
  request: FastifyRequest<{ Params: WebhookParams }>,
): Promise<
  | { kind: "found"; webhook: WebhookEndpointWithLastDelivery }
  | { kind: "error"; problem: ProblemDetails }
> {
  const notFound = createWebhookNotFoundProblem();
  const webhook = await handlers.get(request.params.webhookId);
  if (!webhook) {
    return { kind: "error", problem: notFound };
  }

  const authorization = await authorizeVisibleResourceAccess(
    options.authorizationService,
    request.controlPlanePrincipal,
    "webhook.manage",
    () => options.authorizationService!.resolveTeamScope(webhook.endpoint.teamId),
    notFound,
  );
  if (authorization.kind === "error") {
    // "Forbidden" would tell a team member without webhook.manage that this
    // id exists. A disabled account keeps its own answer.
    return {
      kind: "error",
      problem: authorization.problem.status === 403 &&
        authorization.problem.type.endsWith("/forbidden")
        ? notFound
        : authorization.problem,
    };
  }

  return { kind: "found", webhook };
}
