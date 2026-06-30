import type { FastifyInstance } from "fastify";

import { createProblem, sendProblem } from "../../app/problemDetails";
import {
  extractAcknowledgeableEventId,
  parseMetricEventInput,
} from "./metricsSupport";
import { parseDeploymentMetricsInput } from "./releaseSupport";
import {
  authorizeResourceAccess,
  createDeploymentNotFoundProblem,
  createReleaseNotFoundProblem,
  INVALID_METRIC_EVENTS_BATCH_ERROR,
  METRIC_EVENTS_BATCH_LIMIT,
  METRIC_EVENTS_BATCH_TOO_LARGE_ERROR,
} from "./routeSupport";
import {
  isJsonObject,
  singleFieldValidationProblem,
} from "./routeValidation";
import type {
  ApiRoutesOptions,
  DeploymentParams,
  MetricEventBatchRequestBody,
  PaginationQuery,
  ReleaseReadParams,
} from "./routeTypes";
import { toReleaseMetricsRowWire } from "./wireSerializers";

export function registerMetricsRoutes(
  app: FastifyInstance,
  options: ApiRoutesOptions,
): void {
  app.post<{ Body: MetricEventBatchRequestBody }>(
    "/v1/metrics/events",
    async (request, reply) => {
      if (!options.metricEventIngestHandler) {
        return sendProblem(
          reply,
          createProblem({
            detail: "metrics ingest is not implemented",
            status: 501,
          }),
        );
      }

      if (!isJsonObject(request.body) || !Array.isArray(request.body.events)) {
        return sendProblem(
          reply,
          singleFieldValidationProblem(
            INVALID_METRIC_EVENTS_BATCH_ERROR,
            "events",
            "invalid_type",
          ),
        );
      }

      if (request.body.events.length > METRIC_EVENTS_BATCH_LIMIT) {
        return sendProblem(
          reply,
          singleFieldValidationProblem(
            METRIC_EVENTS_BATCH_TOO_LARGE_ERROR,
            "events",
            "out_of_range",
          ),
        );
      }

      // Events that cannot succeed on retry (malformed envelope, unknown
      // deployment key) are acknowledged anyway so the client clears them
      // from its retry queue. Transient failures must NOT be handled here:
      // a thrown handler error becomes a 500 and the client retries the
      // batch, with event_id idempotency absorbing re-delivery of events
      // that were already persisted.
      const acknowledgedEventIds = new Set<string>();
      for (const envelope of request.body.events) {
        const input = parseMetricEventInput(envelope);
        if (input.kind === "error") {
          request.log.warn(
            { problem: input.problem },
            "dropping invalid metric event",
          );
          const eventId = extractAcknowledgeableEventId(envelope);
          if (eventId !== null) {
            acknowledgedEventIds.add(eventId);
          }
          continue;
        }

        const result = await options.metricEventIngestHandler(input.value);
        if (result.outcome === "not_found") {
          request.log.warn(
            { deploymentKey: input.value.deploymentKey, reason: result.reason },
            "dropping metric event for unknown deployment",
          );
        }
        acknowledgedEventIds.add(input.value.eventId);
      }

      reply.status(202);
      return {
        acknowledged_event_ids: [...acknowledgedEventIds],
      };
    },
  );
}

export function registerMetricsQueryRoutes(
  app: FastifyInstance,
  options: ApiRoutesOptions,
): void {
  app.get<{ Params: DeploymentParams; Querystring: PaginationQuery }>(
    "/metrics/deployments/:deploymentId",
    async (request, reply) => {
      const input = parseDeploymentMetricsInput(
        request.params.deploymentId,
        request.query,
      );
      if (input.kind === "error") {
        return sendProblem(reply, input.problem);
      }

      const authorization = await authorizeResourceAccess(
        options.authorizationService,
        request.controlPlanePrincipal,
        "release.view",
        () =>
          options.authorizationService!.resolveDeploymentScope(
            request.params.deploymentId,
          ),
        createDeploymentNotFoundProblem(),
      );
      if (authorization.kind === "error") {
        return sendProblem(reply, authorization.problem);
      }

      if (!options.deploymentMetricsHandler) {
        return sendProblem(
          reply,
          createProblem({
            detail: "deployment metrics is not implemented",
            status: 501,
          }),
        );
      }

      const result = await options.deploymentMetricsHandler(input.value);

      if (result.outcome === "not_found") {
        return sendProblem(reply, createDeploymentNotFoundProblem());
      }

      return {
        pagination: result.pagination,
        releases: result.releases.map(toReleaseMetricsRowWire),
      };
    },
  );

  app.get<{ Params: ReleaseReadParams }>(
    "/metrics/releases/:releaseId",
    async (request, reply) => {
      const authorization = await authorizeResourceAccess(
        options.authorizationService,
        request.controlPlanePrincipal,
        "release.view",
        () =>
          options.authorizationService!.resolveReleaseScope(
            request.params.releaseId,
          ),
        createReleaseNotFoundProblem(),
      );
      if (authorization.kind === "error") {
        return sendProblem(reply, authorization.problem);
      }

      if (!options.releaseMetricsReadHandler) {
        return sendProblem(
          reply,
          createProblem({
            detail: "release metrics is not implemented",
            status: 501,
          }),
        );
      }

      const result = await options.releaseMetricsReadHandler(
        request.params.releaseId,
      );

      if (result.outcome === "not_found") {
        return sendProblem(reply, createReleaseNotFoundProblem());
      }

      return {
        release: toReleaseMetricsRowWire(result.release),
      };
    },
  );
}
