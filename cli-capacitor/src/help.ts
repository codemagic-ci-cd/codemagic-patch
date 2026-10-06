// Help is generated from the command definitions (registry.ts), so it cannot
// describe a flag the parser rejects or omit one it accepts.

import { SERVER_URL_ENV, TOKEN_ENV } from "./api";
import { CLI_NAME } from "./branding";
import type { CommandDefinition, FlagSpec } from "./command";
import { COMMANDS, commandName, commandsInGroup } from "./registry";

const INTRO = `${CLI_NAME} — publish and operate over-the-air updates of Capacitor / Ionic apps on Codemagic Patch`;

export function renderHelp(topic?: CommandDefinition | string): string {
  if (topic === undefined) {
    return renderOverview();
  }

  return typeof topic === "string" ? renderGroupHelp(topic) : renderCommandHelp(topic);
}

function renderOverview(): string {
  const width = Math.max(...COMMANDS.map((definition) => commandName(definition).length));

  return [
    INTRO,
    "",
    "Usage:",
    `  ${CLI_NAME} <command> [flags]`,
    `  ${CLI_NAME} <command> --help     what a command does, and its flags`,
    "",
    "Commands:",
    ...COMMANDS.map(
      (definition) => `  ${commandName(definition).padEnd(width)}  ${definition.summary}`,
    ),
    "",
    "Every command that talks to the server needs:",
    `  --server-url <url>, or $${SERVER_URL_ENV}, or the default of \`${CLI_NAME} config set\``,
    `  a sign-in: \`${CLI_NAME} login\`, or an access token in $${TOKEN_ENV} (what CI uses), or --token`,
    "",
    "Example:",
    `  ${CLI_NAME} login --server-url https://patch.example.com`,
    `  ${CLI_NAME} release create --server-url https://patch.example.com \\`,
    "    --app MyApp-iOS --deployment Staging --bundle-path www --target-binary-version 1.4.0",
    "",
    "  -h, --help       Show this help",
    "  -v, --version    Show the version",
    "",
  ].join("\n");
}

function renderGroupHelp(group: string): string {
  const definitions = commandsInGroup(group);
  const width = Math.max(...definitions.map((definition) => commandName(definition).length));

  return [
    `${CLI_NAME} ${group} — subcommands:`,
    "",
    ...definitions.map(
      (definition) => `  ${commandName(definition).padEnd(width)}  ${definition.summary}`,
    ),
    "",
    `Run \`${CLI_NAME} ${group} <subcommand> --help\` for the flags.`,
    "",
  ].join("\n");
}

function renderCommandHelp(definition: CommandDefinition): string {
  const flags = [...definition.flags, HELP_FLAG].map(
    (flag) => [flagSyntax(flag), flag.help] as const,
  );
  const width = Math.max(...flags.map(([syntax]) => syntax.length));

  return [
    `${CLI_NAME} ${commandName(definition)} — ${definition.summary}`,
    "",
    "Usage:",
    `  ${CLI_NAME} ${commandName(definition)} ${definition.usage}`,
    ...(definition.notes === undefined ? [] : ["", ...definition.notes.map((line) => (line === "" ? "" : `  ${line}`))]),
    "",
    "Flags:",
    ...flags.map(([syntax, help]) => `  ${syntax.padEnd(width)}  ${help}`),
    "",
  ].join("\n");
}

const HELP_FLAG: FlagSpec = { help: "Show this help", name: "help", short: "h", type: "boolean" };

function flagSyntax(flag: FlagSpec): string {
  const long = flag.type === "string" ? `--${flag.name} <${flag.value ?? "value"}>` : `--${flag.name}`;
  return flag.short === undefined ? long : `-${flag.short}, ${long}`;
}
