import type { DeploymentCreateCommand } from "../commandTypes";
import { authenticatedRequest } from "../authenticatedRequest";
import { resolveAppId } from "./resolveNames";
import { buildApiUrl, type CommandDeps } from "./shared";

export async function executeDeploymentCreate(
  command: DeploymentCreateCommand,
  deps: CommandDeps,
): Promise<unknown> {
  const appId = await resolveAppId(
    command.app,
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
        "idempotency-key": deps.randomUUID(),
      },
      method: "POST",
    },
    serverUrl: command.serverUrl,
    token: command.token,
    url: buildApiUrl(
      command.serverUrl,
      `/v1/apps/${encodeURIComponent(appId)}/deployments`,
    ),
  });
}
