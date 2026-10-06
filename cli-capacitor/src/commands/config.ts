// `config list | set | unset`: the default server of the user config file
// (../userConfig.ts). It is cli/src/commands/localConfig.ts › executeConfigCommand
// (@codemagic/patch-cli 0.4.0) narrowed and respelled. Narrowed to `server-url`, the one
// default this CLI reads — `team` and `team-id` would be stored here and used nowhere —
// which also leaves `config get` with nothing `list` does not show. Respelled with a
// flag where `cmpatch` takes `<key> <value>`: no command of this CLI takes positional
// arguments. See cli-capacitor-tech-spec › R33.

import { assertHttpUrl, SERVER_URL_ENV } from "../api";
import { CLI_NAME } from "../branding";
import {
  FORMAT_FLAG,
  readBoolean,
  requireString,
  type CommandDefinition,
} from "../command";
import { UsageError } from "../errors";
import { readConfiguredServerUrl, writeConfiguredServerUrl } from "../userConfig";

/**
 * Said wherever the default is shown or changed while the environment names a server:
 * without it the default looks like the server in use, and a new one like it had no
 * effect. In the text output only — a `json` run says nothing beyond its result (R6).
 */
function environmentPrecedenceNote(
  env: Record<string, string | undefined>,
): string | undefined {
  const fromEnvironment = (env[SERVER_URL_ENV] ?? "").trim();

  return fromEnvironment.length > 0
    ? `$${SERVER_URL_ENV} is set (${fromEnvironment}) and takes precedence over this default`
    : undefined;
}

const configList: CommandDefinition = {
  flags: [FORMAT_FLAG],
  path: ["config", "list"],
  run: async (_values, deps) => {
    const configured = readConfiguredServerUrl(deps.env);
    const note = environmentPrecedenceNote(deps.env);

    if (configured === undefined) {
      return {
        details: [
          `set one with \`${CLI_NAME} config set --server-url <url>\``,
          ...(note !== undefined ? [`note: ${note}`] : []),
        ],
        json: {},
        kind: "action",
        summary: "No default server is set.",
      };
    }

    return {
      fields: [
        ["server url", "serverUrl"],
        ["file", "configPath"],
        ["note", "note"],
      ],
      json: { serverUrl: configured.serverUrl },
      kind: "record",
      record: { ...configured, ...(note !== undefined ? { note } : {}) },
    };
  },
  summary: "Show the default server",
  usage: "[--format <text|json>]",
};

const configSet: CommandDefinition = {
  flags: [
    {
      help: "Server to use when a command names none itself",
      name: "server-url",
      type: "string",
      value: "url",
    },
    FORMAT_FLAG,
  ],
  notes: [
    "Stored as serverUrl in ~/.codemagic-patch/config.json (or under $CODEMAGIC_PATCH_HOME).",
    `A command's own --server-url, and then $${SERVER_URL_ENV}, still outrank this default.`,
  ],
  path: ["config", "set"],
  run: async (values, deps) => {
    const serverUrl = assertHttpUrl(requireString(values, "server-url"));

    const { configPath } = await writeConfiguredServerUrl(deps.env, serverUrl);
    const note = environmentPrecedenceNote(deps.env);

    return {
      details: [`file: ${configPath}`, ...(note !== undefined ? [`note: ${note}`] : [])],
      json: { serverUrl },
      kind: "action",
      summary: `Default server set to ${serverUrl}.`,
    };
  },
  summary: "Store the default server",
  usage: "--server-url <url> [--format <text|json>]",
};

const configUnset: CommandDefinition = {
  flags: [
    { help: "Forget the default server", name: "server-url", type: "boolean" },
    FORMAT_FLAG,
  ],
  path: ["config", "unset"],
  run: async (values, deps) => {
    if (!readBoolean(values, "server-url")) {
      throw new UsageError("Missing what to unset. Pass --server-url.");
    }

    const { changed, configPath } = await writeConfiguredServerUrl(deps.env, undefined);

    return {
      details: [`file: ${configPath}`],
      json: {},
      kind: "action",
      summary: changed ? "Default server unset." : "No default server was set.",
    };
  },
  summary: "Forget the default server",
  usage: "--server-url [--format <text|json>]",
};

export const configCommands: readonly CommandDefinition[] = [
  configList,
  configSet,
  configUnset,
];
