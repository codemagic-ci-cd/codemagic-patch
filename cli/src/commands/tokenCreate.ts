import type { TokenCreateCommand } from "../commandTypes";
import { authenticatedRequest } from "../authenticatedRequest";
import { buildApiUrl, type CommandDeps } from "./shared";

export async function executeTokenCreate(
  command: TokenCreateCommand,
  deps: CommandDeps,
): Promise<unknown> {
  return authenticatedRequest(deps, {
    init: {
      body: JSON.stringify({
        display_name: command.name,
        ...(command.expiresInDays === undefined
          ? {}
          : { expires_in_days: command.expiresInDays }),
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    },
    serverUrl: command.serverUrl,
    token: command.token,
    url: buildApiUrl(command.serverUrl, "/v1/auth/tokens"),
  });
}
