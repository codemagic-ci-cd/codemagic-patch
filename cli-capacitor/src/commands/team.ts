// team list | show — cli/src/commands/team.ts (@codemagic/patch-cli 0.7.0): the teams
// this account can see, as `GET /v1/teams` and `GET /v1/teams/:teamId` report them, so a
// user can find the name or id to pass as --team. They only read: teams are created and
// managed in the dashboard. See cli-capacitor-tech-spec › Provenance.

import { authenticatedRequest } from "../authenticatedRequest";
import {
  CONNECTION_FLAGS,
  FORMAT_FLAG,
  readApiTarget,
  readString,
  TEAM_FLAG,
  type CommandDefinition,
} from "../command";
import { isRecord } from "../output";
import { resolveTeamId } from "../resolveNames";

const teamList: CommandDefinition = {
  flags: [...CONNECTION_FLAGS, FORMAT_FLAG],
  path: ["team", "list"],
  run: async (values, deps) => {
    // The server lists only the caller's teams, so its response is shown as it came.
    const result = await authenticatedRequest(deps, readApiTarget(values, deps), "/v1/teams", {
      method: "GET",
    });

    return {
      columns: [
        { header: "NAME", path: "name" },
        { header: "ID", path: "id" },
      ],
      empty: "No teams found.",
      json: result,
      kind: "list",
      rows: isRecord(result) && Array.isArray(result.teams) ? result.teams.filter(isRecord) : [],
    };
  },
  summary: "List the teams you can see",
  usage: "[flags]",
};

const teamShow: CommandDefinition = {
  flags: [TEAM_FLAG, ...CONNECTION_FLAGS, FORMAT_FLAG],
  path: ["team", "show"],
  run: async (values, deps) => {
    const target = readApiTarget(values, deps);
    const teamId = await resolveTeamId(deps, target, readString(values, "team"));
    const result = await authenticatedRequest(deps, target, `/v1/teams/${encodeURIComponent(teamId)}`, {
      method: "GET",
    });

    return {
      fields: [
        ["name", "name"],
        ["id", "id"],
        ["status", "status"],
        ["created", "created_at"],
        ["updated", "updated_at"],
      ],
      json: result,
      kind: "record",
      record: isRecord(result) ? result.team : result,
    };
  },
  summary: "Show one team",
  usage: "[--team <name or id>] [flags]",
};

export const teamCommands: readonly CommandDefinition[] = [teamList, teamShow];
