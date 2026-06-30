import type { AppShowCommand } from "../commandTypes";
import { authenticatedRequest } from "../authenticatedRequest";
import { resolveAppId } from "./resolveNames";
import { buildApiUrl, type CommandDeps } from "./shared";

export async function executeAppShow(
  command: AppShowCommand,
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
      method: "GET",
    },
    serverUrl: command.serverUrl,
    token: command.token,
    url: buildApiUrl(command.serverUrl, `/v1/apps/${encodeURIComponent(appId)}`),
  });
}
