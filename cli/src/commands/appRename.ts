import type { AppRenameCommand } from "../commandTypes";
import { authenticatedRequest } from "../authenticatedRequest";
import { resolveAppId } from "./resolveNames";
import { buildApiUrl, type CommandDeps } from "./shared";

export async function executeAppRename(
  command: AppRenameCommand,
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
      },
      method: "PATCH",
    },
    serverUrl: command.serverUrl,
    token: command.token,
    url: buildApiUrl(command.serverUrl, `/v1/apps/${encodeURIComponent(appId)}`),
  });
}
