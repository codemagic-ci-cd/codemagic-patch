import type { ReleaseRollbackCommand } from "../commandTypes";
import { authenticatedRequest } from "../authenticatedRequest";
import { enforceMutationSafety } from "./mutationSafety";
import { resolveDeploymentId } from "./resolveNames";
import { buildApiUrl, type CommandDeps } from "./shared";

export async function executeReleaseRollback(
  command: ReleaseRollbackCommand,
  deps: CommandDeps,
): Promise<unknown> {
  const deploymentId = await resolveDeploymentId(
    command.deployment,
    command.serverUrl,
    command.token,
    deps,
  );
  const body =
    command.targetReleaseLabel === undefined
      ? {}
      : {
          target_release_label: command.targetReleaseLabel,
        };

  enforceMutationSafety(deps, {
    commandName: "release rollback",
    fields: [
      ["serverUrl", command.serverUrl],
      ["deploymentId", deploymentId],
      ["targetReleaseLabel", command.targetReleaseLabel],
    ],
    nonInteractive: command.nonInteractive === true,
    yes: command.yes === true,
  });

  return authenticatedRequest(deps, {
    init: {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        "idempotency-key": deps.randomUUID(),
      },
      method: "POST",
    },
    serverUrl: command.serverUrl,
    token: command.token,
    url: buildApiUrl(
      command.serverUrl,
      `/v1/deployments/${encodeURIComponent(deploymentId)}/rollback`,
    ),
  });
}
