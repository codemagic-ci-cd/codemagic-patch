import type { DeploymentRemoveCommand } from "../commandTypes";
import { authenticatedRequest } from "../authenticatedRequest";
import { enforceMutationSafety } from "./mutationSafety";
import {
  formatDeploymentSelector,
  resolveDeploymentId,
} from "./resolveNames";
import { buildApiUrl, type CommandDeps } from "./shared";

export async function executeDeploymentRemove(
  command: DeploymentRemoveCommand,
  deps: CommandDeps,
): Promise<unknown> {
  // Guard before resolving the id so a missing --yes fails fast without a
  // network read (matching the old parse-time gate).
  await enforceMutationSafety(deps, {
    commandName: "deployment remove",
    fields: [
      ["serverUrl", command.serverUrl],
      ["deployment", formatDeploymentSelector(command.deployment)],
    ],
    nonInteractive: command.nonInteractive === true,
    yes: command.yes === true,
  });

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
