import type { TokenRevokeCommand } from "../commandTypes";
import { authenticatedRequest } from "../authenticatedRequest";
import { buildApiUrl, type CommandDeps } from "./shared";

export async function executeTokenRevoke(
  command: TokenRevokeCommand,
  deps: CommandDeps,
): Promise<unknown> {
  return authenticatedRequest(deps, {
    init: {
      method: "DELETE",
    },
    serverUrl: command.serverUrl,
    token: command.token,
    url: buildApiUrl(
      command.serverUrl,
      `/v1/auth/tokens/${encodeURIComponent(command.tokenId)}`,
    ),
  });
}
