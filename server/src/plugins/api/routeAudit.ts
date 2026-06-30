import type { FastifyRequest } from "fastify";

import type { AuditEventWriteRouteHandler } from "../../app/types";
import { requireControlPlanePrincipal } from "./routeAuthorization";
import { headerToSingleValue } from "./routeValidation";

export async function writeAuditEventIfConfigured(
  handler: AuditEventWriteRouteHandler | undefined,
  request: FastifyRequest,
  input: {
    action: string;
    afterState: Record<string, unknown> | null;
    beforeState: Record<string, unknown> | null;
    resourceId: string;
    resourceType: string;
    result: "success" | "failure";
    teamId: string;
  },
): Promise<void> {
  if (!handler) {
    return;
  }

  const principal = requireControlPlanePrincipal(request);

  await handler({
    action: input.action,
    actorId: principal.userId,
    actorType: "user",
    afterState: input.afterState,
    beforeState: input.beforeState,
    ip: request.ip ?? null,
    requestId: request.id ?? null,
    resourceId: input.resourceId,
    resourceType: input.resourceType,
    result: input.result,
    teamId: input.teamId,
    userAgent: headerToSingleValue(request.headers["user-agent"]),
  });
}
