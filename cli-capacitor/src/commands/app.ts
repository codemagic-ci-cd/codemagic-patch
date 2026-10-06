// app create | list | show | rename | setting | remove — cli/src/commands/app*.ts
// (@codemagic/patch-cli 0.4.0): the same endpoints and bodies, and the same rule for
// what needs confirmation (only `remove`). The one difference is the `framework` that
// `create` states (R34). See cli-capacitor-tech-spec › Provenance.

import { APP_FRAMEWORK, teamAppsPath } from "../appFramework";
import { authenticatedRequest } from "../authenticatedRequest";
import {
  APP_SELECTOR_FLAGS,
  APP_USAGE,
  CONNECTION_FLAGS,
  deletedOutput,
  describeSelector,
  FORMAT_FLAG,
  readApiTarget,
  readAppSelector,
  readBoolean,
  readFormat,
  readString,
  requireString,
  TEAM_FLAG,
  YES_FLAG,
  type CommandDefinition,
  type CommandOutput,
} from "../command";
import { UsageError } from "../errors";
import { assertConsentPossible, enforceMutationSafety } from "../mutation";
import { isRecord } from "../output";
import { resolveAppId, resolveTeamId } from "../resolveNames";

// A server that predates `framework` returns none, and the row is then left out.
const APP_FIELDS = [
  ["name", "name"],
  ["id", "id"],
  ["framework", "framework"],
  ["code signing required", "require_code_signing"],
  ["team", "team_id"],
  ["created", "created_at"],
] as const;

function appRecord(result: unknown): CommandOutput {
  return {
    fields: APP_FIELDS,
    json: result,
    kind: "record",
    record: isRecord(result) ? result.app : result,
  };
}

const appCreate: CommandDefinition = {
  flags: [
    { help: "Name of the new app, e.g. MyApp-iOS", name: "name", type: "string", value: "name" },
    {
      help: "Only accept signed releases for this app",
      name: "require-code-signing",
      type: "boolean",
    },
    TEAM_FLAG,
    ...CONNECTION_FLAGS,
    FORMAT_FLAG,
  ],
  notes: [
    "Create one app per platform (MyApp-iOS, MyApp-Android): iOS and Android must not",
    "share a deployment. A new app comes with Staging and Production deployments —",
    "`deployment list` shows their deployment keys.",
  ],
  path: ["app", "create"],
  run: async (values, deps) => {
    const name = requireString(values, "name");
    const target = readApiTarget(values, deps);
    const teamId = await resolveTeamId(deps, target, readString(values, "team"));
    const result = await authenticatedRequest(deps, target, "/v1/apps", {
      body: JSON.stringify({
        framework: APP_FRAMEWORK,
        name,
        require_code_signing: readBoolean(values, "require-code-signing"),
        team_id: teamId,
      }),
      headers: {
        "content-type": "application/json",
        "idempotency-key": deps.randomUUID(),
      },
      method: "POST",
    });

    return appRecord(result);
  },
  summary: "Create an app (with Staging and Production deployments)",
  usage: "--name <name> [--require-code-signing] [flags]",
};

const appList: CommandDefinition = {
  flags: [TEAM_FLAG, ...CONNECTION_FLAGS, FORMAT_FLAG],
  path: ["app", "list"],
  run: async (values, deps) => {
    const target = readApiTarget(values, deps);
    const teamId = await resolveTeamId(deps, target, readString(values, "team"));
    // The server does the filtering (see appFramework.ts), so both formats show its
    // response as it came.
    const result = await authenticatedRequest(deps, target, teamAppsPath(teamId), { method: "GET" });

    const apps = isRecord(result) && Array.isArray(result.apps) ? result.apps.filter(isRecord) : [];

    return {
      // No FRAMEWORK column: every row would say the same thing.
      columns: [
        { header: "NAME", path: "name" },
        { header: "ID", path: "id" },
        { header: "CODE SIGNING", path: "require_code_signing" },
        { header: "CREATED", path: "created_at" },
      ],
      // Says nothing of other frameworks, as the help does not: whoever uses this CLI sees
      // one kind of app and need not be told that a team can hold another.
      empty: "No apps yet. Create one with `app create --name <name>`.",
      json: result,
      kind: "list",
      rows: apps,
    };
  },
  summary: "List the team's apps",
  usage: "[flags]",
};

const appShow: CommandDefinition = {
  flags: [...APP_SELECTOR_FLAGS, ...CONNECTION_FLAGS, FORMAT_FLAG],
  path: ["app", "show"],
  run: async (values, deps) => {
    const selector = readAppSelector(values);
    const target = readApiTarget(values, deps);
    const appId = await resolveAppId(deps, target, selector);

    return appRecord(
      await authenticatedRequest(deps, target, `/v1/apps/${encodeURIComponent(appId)}`, {
        method: "GET",
      }),
    );
  },
  summary: "Show one app",
  usage: `${APP_USAGE} [flags]`,
};

async function patchApp(
  values: Parameters<CommandDefinition["run"]>[0],
  deps: Parameters<CommandDefinition["run"]>[1],
  body: Record<string, unknown>,
): Promise<CommandOutput> {
  const selector = readAppSelector(values);
  const target = readApiTarget(values, deps);
  const appId = await resolveAppId(deps, target, selector);

  return appRecord(
    await authenticatedRequest(deps, target, `/v1/apps/${encodeURIComponent(appId)}`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    }),
  );
}

const appRename: CommandDefinition = {
  flags: [
    { help: "The app's new name", name: "new-name", type: "string", value: "name" },
    ...APP_SELECTOR_FLAGS,
    ...CONNECTION_FLAGS,
    FORMAT_FLAG,
  ],
  path: ["app", "rename"],
  run: async (values, deps) =>
    patchApp(values, deps, { name: requireString(values, "new-name") }),
  summary: "Rename an app",
  usage: `${APP_USAGE} --new-name <name> [flags]`,
};

const appSetting: CommandDefinition = {
  flags: [
    {
      help: "Whether the app only accepts signed releases",
      name: "require-code-signing",
      type: "string",
      value: "true|false",
    },
    ...APP_SELECTOR_FLAGS,
    ...CONNECTION_FLAGS,
    FORMAT_FLAG,
  ],
  notes: [
    "With code signing required, `release create` needs --private-key-path, and the SDK",
    "needs the matching `publicKey` to verify what it installs.",
  ],
  path: ["app", "setting"],
  run: async (values, deps) => {
    const requireCodeSigning = requireString(values, "require-code-signing");
    if (requireCodeSigning !== "true" && requireCodeSigning !== "false") {
      throw new UsageError(
        `--require-code-signing must be "true" or "false" (got "${requireCodeSigning}").`,
      );
    }

    return patchApp(values, deps, {
      require_code_signing: requireCodeSigning === "true",
    });
  },
  summary: "Change an app's settings",
  usage: `${APP_USAGE} --require-code-signing=<true|false> [flags]`,
};

const appRemove: CommandDefinition = {
  flags: [...APP_SELECTOR_FLAGS, YES_FLAG, ...CONNECTION_FLAGS, FORMAT_FLAG],
  notes: ["Deletes the app with its deployments and releases. This cannot be undone."],
  path: ["app", "remove"],
  run: async (values, deps) => {
    const selector = readAppSelector(values);
    const target = readApiTarget(values, deps);
    const consent = {
      commandName: "app remove",
      format: readFormat(values),
      yes: readBoolean(values, "yes"),
    };
    // A missing --yes fails before any request; the question is asked after the name
    // is resolved, so that it names the app that will be deleted — names match
    // case-insensitively, and "Payments" may turn out to be `payments`.
    assertConsentPossible(deps, consent);
    const appId = await resolveAppId(deps, target, selector);
    await enforceMutationSafety(deps, {
      ...consent,
      fields: [
        ["serverUrl", target.serverUrl],
        ["app", describeSelector(selector)],
        ["appId", appId],
      ],
    });
    await authenticatedRequest(deps, target, `/v1/apps/${encodeURIComponent(appId)}`, {
      method: "DELETE",
    });

    return deletedOutput("app", appId, `Removed app ${appId}.`);
  },
  summary: "Delete an app, its deployments and its releases",
  usage: `${APP_USAGE} [--yes] [flags]`,
};

export const appCommands: readonly CommandDefinition[] = [
  appCreate,
  appList,
  appShow,
  appRename,
  appSetting,
  appRemove,
];
