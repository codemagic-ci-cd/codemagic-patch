import type { FastifyPluginAsync } from "fastify";

import { createProblem, sendProblem } from "../../app/problemDetails";
import { registerControlPlaneAuthRoutes, registerPublicAuthRoutes } from "./authRoutes";
import { registerIamRoutes } from "./iamRoutes";
import { registerManagementRoutes } from "./managementRoutes";
import {
  registerMetricsQueryRoutes,
  registerMetricsRoutes,
} from "./metricsRoutes";
import { registerReleaseRoutes } from "./releaseRoutes";
import { createSessionRequiredProblem } from "./routeProblems";
import type { ApiRoutesOptions } from "./routeTypes";
import { registerServerRoutes } from "./serverRoutes";

const WRITE_METHODS = new Set(["DELETE", "PATCH", "POST", "PUT"]);

declare module "fastify" {
  interface FastifyContextConfig {
    // Lets an API-token principal call this write route. Without it, the
    // control-plane auth hook answers 403 session_required.
    allowApiToken?: true;
  }
}

export const apiRoutes: FastifyPluginAsync<ApiRoutesOptions> = async (
  app,
  options,
) => {
  app.get("/health", async () => {
    return {
      mode: options.mode,
      ok: true,
    };
  });

  app.get("/health/ready", async (_request, reply) => {
    if (!options.readinessCheckHandler) {
      return sendProblem(
        reply,
        createProblem({
          detail: "readiness check is not implemented",
          status: 501,
        }),
      );
    }

    const result = await options.readinessCheckHandler();

    reply.status(result.ok ? 200 : 503);
    return {
      checks: result.checks,
      mode: options.mode,
      ok: result.ok,
    };
  });

  registerMetricsRoutes(app, options);
  registerPublicAuthRoutes(app, options);

  app.register(
    async (controlPlane) => {
      controlPlane.addHook("onRequest", async (request, reply) => {
        const result = await options.controlPlaneAuthHandler(request);

        if (result.outcome === "unauthenticated") {
          const problem = createProblem({
            detail: "missing or invalid control-plane api credentials",
            status: 401,
            typeSuffix: "authentication-required",
          });

          reply.status(problem.status);
          reply.type("application/problem+json");
          return reply.send(problem);
        }

        if (result.outcome === "forbidden") {
          const problem = createProblem({
            detail: "account is disabled",
            status: 403,
            typeSuffix: "account-disabled",
          });

          reply.status(problem.status);
          reply.type("application/problem+json");
          return reply.send(problem);
        }

        request.controlPlanePrincipal = result.principal;

        // Write routes are session-only unless they opt in, so a route that
        // forgets to decide fails closed. Setting allowApiToken is a security
        // decision for review.
        const principal = result.principal;
        if (
          principal.kind === "api-token" &&
          WRITE_METHODS.has(request.method) &&
          !request.is404 &&
          request.routeOptions.config.allowApiToken !== true
        ) {
          request.log.warn(
            {
              method: request.method,
              reason: "session_required",
              route: request.routeOptions.url,
              tokenId: principal.tokenId,
              userId: principal.userId,
            },
            "api token refused on a session-only route",
          );
          return reply.send(sendProblem(reply, createSessionRequiredProblem()));
        }
      });

      registerManagementRoutes(controlPlane, options);
      registerControlPlaneAuthRoutes(controlPlane, options);
      registerIamRoutes(controlPlane, options);
      registerMetricsQueryRoutes(controlPlane, options);
      registerReleaseRoutes(controlPlane, options);
      registerServerRoutes(controlPlane, options);
    },
    { prefix: "/v1" },
  );
};
