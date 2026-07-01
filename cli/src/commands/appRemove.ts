import type { AppRemoveCommand } from "../commandTypes";
import { authenticatedRequest } from "../authenticatedRequest";
import { enforceMutationSafety } from "./mutationSafety";
import { formatAppSelector, resolveAppId } from "./resolveNames";
import { buildApiUrl, type CommandDeps } from "./shared";

export async function executeAppRemove(
  command: AppRemoveCommand,
  deps: CommandDeps,
): Promise<unknown> {
  // Guard before resolving the id so a missing --yes fails fast without a
  // network read (matching the old parse-time gate).
  await enforceMutationSafety(deps, {
    commandName: "app remove",
    fields: [
      ["serverUrl", command.serverUrl],
      ["app", formatAppSelector(command.app)],
    ],
    nonInteractive: command.nonInteractive === true,
    yes: command.yes === true,
  });

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
