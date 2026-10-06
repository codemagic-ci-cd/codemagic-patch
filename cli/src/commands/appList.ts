import type { AppListCommand } from "../commandTypes";
import { teamAppsPath } from "../appFramework";
import { authenticatedRequest } from "../authenticatedRequest";
import { resolveTeamId } from "./resolveNames";
import { buildApiUrl, type CommandDeps } from "./shared";

export async function executeAppList(
  command: AppListCommand,
  deps: CommandDeps,
): Promise<unknown> {
  const teamId = await resolveTeamId(
    command.team,
    command.serverUrl,
    command.token,
    deps,
  );

  // The server does the filtering (see appFramework.ts), so what is printed is
  // its response as it came.
  return authenticatedRequest(deps, {
    init: {
      method: "GET",
    },
    serverUrl: command.serverUrl,
    token: command.token,
    url: buildApiUrl(command.serverUrl, teamAppsPath(teamId)),
  });
}
