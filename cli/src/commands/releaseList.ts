import type { ReleaseListCommand } from "../commandTypes";
import { authenticatedRequest } from "../authenticatedRequest";
import { resolveDeploymentId } from "./resolveNames";
import {
  buildApiUrlWithQuery,
  type CommandDeps,
} from "./shared";

export async function executeReleaseList(
  command: ReleaseListCommand,
  deps: CommandDeps,
): Promise<unknown> {
  const deploymentId = await resolveDeploymentId(
    command.deployment,
    command.serverUrl,
    command.token,
    deps,
  );

  return authenticatedRequest(deps, {
    init: {
      method: "GET",
    },
    serverUrl: command.serverUrl,
    token: command.token,
    url: buildApiUrlWithQuery(
      command.serverUrl,
      `/v1/deployments/${encodeURIComponent(deploymentId)}/releases`,
      {
        include: command.includeMetrics === true ? "metrics" : undefined,
        limit: command.limit,
        offset: command.offset,
      },
    ),
  });
}
