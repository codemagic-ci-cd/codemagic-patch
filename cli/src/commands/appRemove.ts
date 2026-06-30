import type { AppRemoveCommand } from "../commandTypes";
import { authenticatedRequest } from "../authenticatedRequest";
import { resolveAppId } from "./resolveNames";
import { buildApiUrl, type CommandDeps } from "./shared";

export async function executeAppRemove(
  command: AppRemoveCommand,
  deps: CommandDeps,
): Promise<unknown> {
  const appId = await resolveAppId(
    command.app,
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
    url: buildApiUrl(command.serverUrl, `/v1/apps/${encodeURIComponent(appId)}`),
  });

  return {
    deleted: true,
    id: appId,
    resource: "app",
  };
}
