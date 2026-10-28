import type { CommandDefinition } from "./command";
import { appCommands } from "./commands/app";
import { authCommands } from "./commands/auth";
import { configCommands } from "./commands/config";
import { deploymentCommands } from "./commands/deployment";
import { doctorCommand } from "./commands/doctor";
import { deploymentMetricsDrillDown, releaseMetricsDrillDown } from "./commands/metricsDrillDown";
import { releaseCreate } from "./commands/releaseCreate";
import { releaseManageCommands } from "./commands/releaseManage";
import { teamCommands } from "./commands/team";

/** Every command, in the order help lists them: set up, publish, operate. */
export const COMMANDS: readonly CommandDefinition[] = [
  ...authCommands,
  ...configCommands,
  ...teamCommands,
  ...appCommands,
  ...deploymentCommands,
  ...deploymentMetricsDrillDown,
  releaseCreate,
  ...releaseManageCommands,
  ...releaseMetricsDrillDown,
  doctorCommand,
];

export function commandName(definition: CommandDefinition): string {
  return definition.path.join(" ");
}

/** The first word of every command: `app`, `login`, `release`, ... */
export function commandGroups(): string[] {
  return Array.from(new Set(COMMANDS.map((definition) => definition.path[0]!)));
}

export function commandsInGroup(group: string): CommandDefinition[] {
  return COMMANDS.filter((definition) => definition.path[0] === group);
}
