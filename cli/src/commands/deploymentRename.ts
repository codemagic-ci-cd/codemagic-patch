import type { DeploymentRenameCommand } from "../commandTypes";
import { authenticatedRequest } from "../authenticatedRequest";
import { resolveDeploymentId } from "./resolveNames";
import { buildApiUrl, type CommandDeps } from "./shared";

export async function executeDeploymentRename(
  command: DeploymentRenameCommand,
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
      body: JSON.stringify({
        name: command.name,
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "PATCH",
    },
    serverUrl: command.serverUrl,
    token: command.token,
    url: buildApiUrl(
      command.serverUrl,
      `/v1/deployments/${encodeURIComponent(deploymentId)}`,
    ),
  });
}
