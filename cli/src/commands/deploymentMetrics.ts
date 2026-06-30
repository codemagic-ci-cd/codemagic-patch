import type { DeploymentMetricsCommand } from "../commandTypes";
import { authenticatedRequest } from "../authenticatedRequest";
import { resolveDeploymentId } from "./resolveNames";
import {
  buildApiUrlWithQuery,
  type CommandDeps,
} from "./shared";

export async function executeDeploymentMetrics(
  command: DeploymentMetricsCommand,
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
      `/v1/metrics/deployments/${encodeURIComponent(deploymentId)}`,
      {
        limit: command.limit,
        offset: command.offset,
      },
    ),
  });
}
