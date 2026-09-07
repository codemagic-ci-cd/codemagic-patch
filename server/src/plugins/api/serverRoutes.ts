import type { FastifyInstance } from "fastify";

import { createProblem, sendProblem } from "../../app/problemDetails";
import { authorizeResourceAccess } from "./routeAuthorization";
import type { ApiRoutesOptions } from "./routeTypes";

/**
 * Instance-level routes: they describe the install itself rather than any
 * team's resources, so they authorize against the `instance` scope. Future
 * admin surfaces (queue depth, migration state, config summary) belong here.
 */
export function registerServerRoutes(
  controlPlane: FastifyInstance,
  options: ApiRoutesOptions,
): void {
  controlPlane.get("/server/status", async (request, reply) => {
    if (!options.serverStatusHandler) {
      return sendProblem(
        reply,
        createProblem({
          detail: "server status is not available",
          status: 501,
        }),
      );
    }

    const authorization = await authorizeResourceAccess(
      options.authorizationService,
      request.controlPlanePrincipal,
      "instance.read",
      async () => ({ outcome: "found", scope: { type: "instance" } }),
      createProblem({
        detail: "server status is not available",
        status: 404,
        typeSuffix: "not-found",
      }),
    );
    if (authorization.kind === "error") {
      return sendProblem(reply, authorization.problem);
    }

    return options.serverStatusHandler();
  });
}
