import type { CommandDefinition } from "./command";
import { appCommands } from "./commands/app";
import { authCommands } from "./commands/auth";
import { configCommands } from "./commands/config";
import { deploymentCommands } from "./commands/deployment";
import { releaseCreate } from "./commands/releaseCreate";
import { releaseManageCommands } from "./commands/releaseManage";

/** Every command, in the order help lists them: set up, publish, operate. */
export const COMMANDS: readonly CommandDefinition[] = [
  ...authCommands,
  ...configCommands,
  ...appCommands,
  ...deploymentCommands,
  releaseCreate,
  ...releaseManageCommands,
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
