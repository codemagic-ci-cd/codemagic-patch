import type { AppCreateCommand } from "../commandTypes";
import { authenticatedRequest } from "../authenticatedRequest";
import { resolveTeamId } from "./resolveNames";
import { buildApiUrl, type CommandDeps } from "./shared";

export async function executeAppCreate(
  command: AppCreateCommand,
  deps: CommandDeps,
): Promise<unknown> {
  const teamId =
    command.team.teamId ??
    (await resolveTeamId(command.team, command.serverUrl, command.token, deps));

  return authenticatedRequest(deps, {
    init: {
      body: JSON.stringify({
        name: command.name,
        require_code_signing: command.requireCodeSigning,
        team_id: teamId,
      }),
      headers: {
        "content-type": "application/json",
        "idempotency-key": deps.randomUUID(),
      },
      method: "POST",
    },
    serverUrl: command.serverUrl,
    token: command.token,
    url: buildApiUrl(command.serverUrl, "/v1/apps"),
  });
}
