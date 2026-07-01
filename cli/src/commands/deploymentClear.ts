import type { DeploymentClearCommand } from "../commandTypes";
import { authenticatedRequest } from "../authenticatedRequest";
import { enforceMutationSafety } from "./mutationSafety";
import { resolveDeploymentId } from "./resolveNames";
import { buildApiUrl, type CommandDeps } from "./shared";

export async function executeDeploymentClear(
  command: DeploymentClearCommand,
  deps: CommandDeps,
): Promise<unknown> {
  const deploymentId = await resolveDeploymentId(
    command.deployment,
    command.serverUrl,
    command.token,
    deps,
  );

  await enforceMutationSafety(deps, {
    commandName: "deployment clear",
    fields: [
      ["serverUrl", command.serverUrl],
      ["deploymentId", deploymentId],
    ],
    nonInteractive: command.nonInteractive === true,
    yes: command.yes === true,
  });

  return authenticatedRequest(deps, {
    init: {
      method: "POST",
    },
    serverUrl: command.serverUrl,
    token: command.token,
    url: buildApiUrl(
      command.serverUrl,
      `/v1/deployments/${encodeURIComponent(deploymentId)}/clear`,
    ),
  });
}
