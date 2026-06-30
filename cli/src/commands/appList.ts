import type { AppListCommand } from "../commandTypes";
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

  return authenticatedRequest(deps, {
    init: {
      method: "GET",
    },
    serverUrl: command.serverUrl,
    token: command.token,
    url: buildApiUrl(
      command.serverUrl,
      `/v1/teams/${encodeURIComponent(teamId)}/apps`,
    ),
  });
}
