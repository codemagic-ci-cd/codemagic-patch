import type { WhoamiCommand } from "../commandTypes";
import { authenticatedRequest } from "../authenticatedRequest";
import { buildApiUrl, type CommandDeps } from "./shared";

export async function executeWhoami(
  command: WhoamiCommand,
  deps: CommandDeps,
): Promise<unknown> {
  return authenticatedRequest(deps, {
    init: {
      method: "GET",
    },
    serverUrl: command.serverUrl,
    token: command.token,
    url: buildApiUrl(command.serverUrl, "/v1/users/me"),
  });
}
