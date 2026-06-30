import type { ReleaseShowCommand } from "../commandTypes";
import { authenticatedRequest } from "../authenticatedRequest";
import { resolveReleaseId } from "./resolveNames";
import { buildApiUrl, type CommandDeps } from "./shared";

export async function executeReleaseShow(
  command: ReleaseShowCommand,
  deps: CommandDeps,
): Promise<unknown> {
  const releaseId = await resolveReleaseId(
    command.release,
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
      `/v1/releases/${encodeURIComponent(releaseId)}`,
    ),
  });
}
