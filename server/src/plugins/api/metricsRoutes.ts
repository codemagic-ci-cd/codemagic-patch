import type { FastifyInstance } from "fastify";

import { createProblem, sendProblem } from "../../app/problemDetails";
import {
  extractAcknowledgeableEventId,
  parseDeploymentTimeseriesInput,
  parseFailureCodesInput,
  parseFailureBucketInput,
  parseFailureEventsInput,
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
  FailureCodesQuery,
  FailureBucketQuery,
  FailureEventsQuery,
  MetricEventBatchRequestBody,
  PaginationQuery,
  ReleaseReadParams,
  TimeseriesRangeQuery,
} from "./routeTypes";
import {
  toDeploymentTimeseriesWire,
  toFailureCodesWire,
  toFailureDistributionWire,
  toFailureEventsWire,
  toReleaseMetricsRowWire,
} from "./wireSerializers";

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
        } else if (result.outcome === "superseded") {
          // Not a problem with the event, so no warning: the device already
          // reported that this package went on to succeed, and the failure
          // being reported here preceded that outcome.
          request.log.debug(
            {
              deviceId: input.value.deviceId,
              eventId: input.value.eventId,
              targetPackageHash: input.value.targetPackageHash,
            },
            "dropping Failed metric event superseded by the device's Success",
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

  app.get<{ Params: DeploymentParams; Querystring: TimeseriesRangeQuery }>(
    "/metrics/deployments/:deploymentId/timeseries",
    async (request, reply) => {
      const input = parseDeploymentTimeseriesInput(
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

      if (!options.deploymentTimeseriesHandler) {
        return sendProblem(
          reply,
          createProblem({
            detail: "deployment timeseries is not implemented",
            status: 501,
          }),
        );
      }

      const result = await options.deploymentTimeseriesHandler(input.value);

      if (result.outcome === "not_found") {
        return sendProblem(reply, createDeploymentNotFoundProblem());
      }

      return toDeploymentTimeseriesWire(input.value, result);
    },
  );

  app.get<{ Params: DeploymentParams; Querystring: FailureCodesQuery }>(
    "/metrics/deployments/:deploymentId/failures",
    async (request, reply) => {
      const input = parseFailureCodesInput(request.query);
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

      if (!options.deploymentFailureCodesHandler) {
        return sendProblem(
          reply,
          createProblem({
            detail: "deployment failure codes is not implemented",
            status: 501,
          }),
        );
      }

      const result = await options.deploymentFailureCodesHandler(
        request.params.deploymentId,
        input.value,
      );

      if (result.outcome === "not_found") {
        return sendProblem(reply, createDeploymentNotFoundProblem());
      }

      return toFailureCodesWire(result);
    },
  );

  app.get<{ Params: ReleaseReadParams; Querystring: FailureCodesQuery }>(
    "/metrics/releases/:releaseId/failures",
    async (request, reply) => {
      const input = parseFailureCodesInput(request.query);
      if (input.kind === "error") {
        return sendProblem(reply, input.problem);
      }

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

      if (!options.releaseFailureCodesHandler) {
        return sendProblem(
          reply,
          createProblem({
            detail: "release failure codes is not implemented",
            status: 501,
          }),
        );
      }

      const result = await options.releaseFailureCodesHandler(
        request.params.releaseId,
        input.value,
      );

      if (result.outcome === "not_found") {
        return sendProblem(reply, createReleaseNotFoundProblem());
      }

      return {
        ...toFailureCodesWire(result),
        target_package_hash: result.targetPackageHash,
      };
    },
  );

  app.get<{ Params: DeploymentParams; Querystring: FailureBucketQuery }>(
    "/metrics/deployments/:deploymentId/failures/distribution",
    async (request, reply) => {
      const input = parseFailureBucketInput(request.query);
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

      if (!options.deploymentFailureDistributionHandler) {
        return sendProblem(
          reply,
          createProblem({
            detail: "deployment failure distribution is not implemented",
            status: 501,
          }),
        );
      }

      const result = await options.deploymentFailureDistributionHandler(
        request.params.deploymentId,
        input.value,
      );

      if (result.outcome === "not_found") {
        return sendProblem(reply, createDeploymentNotFoundProblem());
      }

      return toFailureDistributionWire(result);
    },
  );

  app.get<{ Params: ReleaseReadParams; Querystring: FailureBucketQuery }>(
    "/metrics/releases/:releaseId/failures/distribution",
    async (request, reply) => {
      const input = parseFailureBucketInput(request.query);
      if (input.kind === "error") {
        return sendProblem(reply, input.problem);
      }

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

      if (!options.releaseFailureDistributionHandler) {
        return sendProblem(
          reply,
          createProblem({
            detail: "release failure distribution is not implemented",
            status: 501,
          }),
        );
      }

      const result = await options.releaseFailureDistributionHandler(
        request.params.releaseId,
        input.value,
      );

      if (result.outcome === "not_found") {
        return sendProblem(reply, createReleaseNotFoundProblem());
      }

      return toFailureDistributionWire(result);
    },
  );

  app.get<{ Params: DeploymentParams; Querystring: FailureEventsQuery }>(
    "/metrics/deployments/:deploymentId/failures/events",
    async (request, reply) => {
      const input = parseFailureEventsInput(request.query);
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

      if (!options.deploymentFailureEventsHandler) {
        return sendProblem(
          reply,
          createProblem({
            detail: "deployment failure events is not implemented",
            status: 501,
          }),
        );
      }

      const result = await options.deploymentFailureEventsHandler(
        request.params.deploymentId,
        input.value,
      );

      if (result.outcome === "not_found") {
        return sendProblem(reply, createDeploymentNotFoundProblem());
      }

      return toFailureEventsWire(result);
    },
  );

  app.get<{ Params: ReleaseReadParams; Querystring: FailureEventsQuery }>(
    "/metrics/releases/:releaseId/failures/events",
    async (request, reply) => {
      const input = parseFailureEventsInput(request.query);
      if (input.kind === "error") {
        return sendProblem(reply, input.problem);
      }

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

      if (!options.releaseFailureEventsHandler) {
        return sendProblem(
          reply,
          createProblem({
            detail: "release failure events is not implemented",
            status: 501,
          }),
        );
      }

      const result = await options.releaseFailureEventsHandler(
        request.params.releaseId,
        input.value,
      );

      if (result.outcome === "not_found") {
        return sendProblem(reply, createReleaseNotFoundProblem());
      }

      return toFailureEventsWire(result);
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
