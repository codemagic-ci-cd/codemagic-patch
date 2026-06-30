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
import type { ApiRoutesOptions } from "./routeTypes";

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
      });

      registerManagementRoutes(controlPlane, options);
      registerControlPlaneAuthRoutes(controlPlane, options);
      registerIamRoutes(controlPlane, options);
      registerMetricsQueryRoutes(controlPlane, options);
      registerReleaseRoutes(controlPlane, options);
    },
    { prefix: "/v1" },
  );
};
