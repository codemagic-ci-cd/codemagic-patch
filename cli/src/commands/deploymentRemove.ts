import type { DeploymentRemoveCommand } from "../commandTypes";
import { authenticatedRequest } from "../authenticatedRequest";
import { resolveDeploymentId } from "./resolveNames";
import { buildApiUrl, type CommandDeps } from "./shared";

export async function executeDeploymentRemove(
  command: DeploymentRemoveCommand,
  deps: CommandDeps,
): Promise<unknown> {
  const deploymentId = await resolveDeploymentId(
    command.deployment,
    command.serverUrl,
    command.token,
    deps,
  );

  await authenticatedRequest(deps, {
    init: {
      method: "DELETE",
    },
    serverUrl: command.serverUrl,
    token: command.token,
    url: buildApiUrl(
      command.serverUrl,
      `/v1/deployments/${encodeURIComponent(deploymentId)}`,
    ),
  });

  return {
    deleted: true,
    id: deploymentId,
    resource: "deployment",
  };
}
