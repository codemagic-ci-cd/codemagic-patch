import type { AppCreateCommand } from "../commandTypes";
import { APP_FRAMEWORK } from "../appFramework";
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
        // Always sent, never asked for: there is no --framework flag and no
        // question, because every app this CLI creates is a React Native app.
        // What the server does with the value is in appFramework.ts.
        framework: APP_FRAMEWORK,
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
