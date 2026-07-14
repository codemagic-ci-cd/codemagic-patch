import type {
  CliCommand,
  CommandDefaultFlagValues,
  ParseCliResult,
} from "./commandTypes";
import { PRODUCT_NAME } from "./branding";
import {
  parseAppCreate,
  parseAppList,
  parseAppRemove,
  parseAppRename,
  parseAppSetting,
  parseAppShow,
  parseDebug,
  parseDeploymentClear,
  parseDeploymentCreate,
  parseDeploymentHistory,
  parseDeploymentList,
  parseDeploymentMetrics,
  parseDeploymentRemove,
  parseDeploymentRename,
  parseDoctor,
  parseFingerprint,
  parseLogin,
  parseLogout,
  parseMemberAdd,
  parseMemberInvite,
  parseMemberInviteList,
  parseMemberInviteRevoke,
  parseMemberList,
  parseMemberProvision,
  parseMemberRemove,
  parseRawArgvCommand,
  parseReleaseCreate,
  parseReleaseInspect,
  parseReleaseList,
  parseReleaseMetrics,
  parseReleasePatch,
  parseReleasePromote,
  parseBundle,
  parseContext,
  parseReleaseReact,
  parseReleaseRollback,
  parseReleaseShow,
  parseReleaseStatus,
  parseTokenCreate,
  parseTokenList,
  parseTokenRevoke,
  parseWhoami,
} from "./commandParsers";
import { executeAppCreate } from "./commands/appCreate";
import { executeAppList } from "./commands/appList";
import { executeAppRemove } from "./commands/appRemove";
import { executeAppRename } from "./commands/appRename";
import { executeAppSetting } from "./commands/appSetting";
import { executeAppShow } from "./commands/appShow";
import { executeLogin, executeLogout } from "./commands/auth";
import { executeDeploymentClear } from "./commands/deploymentClear";
import { executeDeploymentCreate } from "./commands/deploymentCreate";
import { executeDeploymentList } from "./commands/deploymentList";
import { executeDeploymentMetrics } from "./commands/deploymentMetrics";
import { executeDeploymentRename } from "./commands/deploymentRename";
import { executeDeploymentRemove } from "./commands/deploymentRemove";
import { executeDebug } from "./commands/debug";
import { executeDoctor, renderDoctorTable } from "./commands/doctor";
import { executeFingerprint } from "./commands/fingerprint";
import {
  executeConfigCommand,
  executeContextCommand,
  executeInitCommand,
} from "./commands/localConfig";
import {
  executeMemberAdd,
  executeMemberInvite,
  executeMemberInviteList,
  executeMemberInviteRevoke,
  executeMemberList,
  executeMemberProvision,
  executeMemberRemove,
} from "./commands/member";
import { executeReleaseCreate } from "./commands/releaseCreate";
import { executeReleaseInspect, renderReleaseInspectTable } from "./commands/releaseInspect";
import { executeReleaseList } from "./commands/releaseList";
import { executeReleaseMetrics, renderReleaseMetricsTable } from "./commands/releaseMetrics";
import { executeReleasePatch } from "./commands/releasePatch";
import { executeReleasePromote } from "./commands/releasePromote";
import { executeBundle, executeReleaseReact } from "./commands/releaseReact";
import { executeReleaseRollback } from "./commands/releaseRollback";
import { executeReleaseShow } from "./commands/releaseShow";
import {
  type CommandDeps,
  UsageError,
} from "./commands/shared";
import { executeTokenCreate } from "./commands/tokenCreate";
import { executeTokenList } from "./commands/tokenList";
import { executeTokenRevoke } from "./commands/tokenRevoke";
import { executeWhoami } from "./commands/whoami";
import { isRecord, readCell, writeLine } from "./output";

type Writable = {
  write: (chunk: string) => void;
};

export type ExecutableCliCommand = Exclude<
  CliCommand,
  { kind: "help" } | { kind: "version" } | { kind: "not-implemented" }
>;

type CommandKind = ExecutableCliCommand["kind"];

type CommandPath = readonly [string] | readonly [string, string];

type CommandParser = (
  args: string[],
  defaults?: CommandDefaultFlagValues,
) => ParseCliResult;

type CommandHelpGroupName =
  | "auth"
  | "config"
  | "diagnostics"
  | "fingerprint"
  | "management"
  | "release";

type CommandHelpInput = {
  description: string;
  examples?: readonly string[];
  group: CommandHelpGroupName;
  usage: string;
};

export type TeamDefaultPolicy =
  | "always"
  | "app-selector"
  | "app-selector-explicit"
  | "doctor"
  | "member";

export type AppDefaultPolicy =
  | "app-show"
  | "deployment"
  | "doctor"
  | "release"
  | "release-react";

export type DeploymentDefaultPolicy =
  | "deployment-history"
  | "doctor"
  | "release"
  | "release-react";

export type CommandDefaultPolicy = {
  app?: AppDefaultPolicy;
  bundler?: true;
  deployment?: DeploymentDefaultPolicy;
  platform?: true;
  serverUrl?: true;
  team?: TeamDefaultPolicy;
};

export type CommandHelpGroup = {
  examples: readonly string[];
  name: CommandHelpGroupName;
  summary: string;
  topics: readonly string[];
};

export type CommandHelpEntry = CommandHelpInput & {
  commandName: string;
};

type CommandRouteInput = {
  defaults?: CommandDefaultPolicy | false;
  parse?: CommandParser;
  path: CommandPath;
};

type CommandRoute = {
  defaults: CommandDefaultPolicy | false;
  parse: CommandParser;
  path: CommandPath;
};

type CommandForKind<K extends CommandKind> =
  ExecutableCliCommand extends infer Command
    ? Command extends { kind: infer Kind }
      ? K extends Kind
        ? Command
        : never
      : never
    : never;

type CommandSpecDeps = CommandDeps & {
  stdout: Writable;
};

type CommandSpecInput<
  K extends CommandKind,
  R extends readonly CommandRouteInput[],
> = {
  aliases?: string[];
  commandName: string;
  defaults: CommandDefaultPolicy | false;
  execute: (
    command: CommandForKind<K>,
    deps: CommandSpecDeps,
  ) => Promise<unknown>;
  help?: readonly CommandHelpInput[];
  kind: K;
  parse: CommandParser;
  renderTable?: (result: unknown, command: CommandForKind<K>) => string;
  /**
   * The command's success result is a server release response that may carry
   * a non-blocking `warnings` array; the CLI surfaces those entries on stderr
   * in table mode. Declared per command so results that carry a `warnings`
   * key as first-class data are never reinterpreted.
   */
  responseWarnings?: true;
  routes: R;
};

type RunnableCommandSpec<K extends CommandKind = CommandKind> = {
  aliases: string[];
  commandName: string;
  defaults: CommandDefaultPolicy | false;
  execute: (
    command: CommandForKind<K>,
    deps: CommandSpecDeps,
  ) => Promise<unknown>;
  help: readonly CommandHelpEntry[];
  kind: K;
  parse: CommandParser;
  renderTable?: (result: unknown, command: ExecutableCliCommand) => string;
  responseWarnings?: true;
  routes: readonly CommandRoute[];
};

const helpGroups: readonly CommandHelpGroup[] = [
  {
    examples: [
      "cmpatch release-react --deployment Staging --dry-run",
      "cmpatch release-react --deployment Staging --mandatory",
    ],
    name: "release",
    summary: "Publish, inspect, patch, promote, and roll back OTA releases.",
    topics: ["release"],
  },
  {
    examples: [
      "cmpatch app list --format table",
      "cmpatch deployment list --app MyApp --format table",
    ],
    name: "management",
    summary: "Manage apps, deployments, and deployment history.",
    topics: ["management", "app", "deployment"],
  },
  {
    examples: [
      "cmpatch login",
      "cmpatch member list --format table",
    ],
    name: "auth",
    summary: "Authenticate, manage tokens, and manage team members.",
    topics: ["auth", "login", "logout", "member", "token", "whoami"],
  },
  {
    examples: [
      "cmpatch doctor",
      "cmpatch doctor --deployment Staging --verbose",
    ],
    name: "diagnostics",
    summary: "Diagnose local setup and OTA readiness.",
    topics: ["diagnostics"],
  },
  {
    examples: [
      "cmpatch config set server-url https://updates.example.com",
      "cmpatch init",
      "cmpatch init --server-url https://updates.example.com --ios-app MyApp-iOS --android-app MyApp-Android --deployment Staging --yes",
      "cmpatch context",
      "cmpatch context --remote",
    ],
    name: "config",
    summary: "Store defaults and inspect the effective local context.",
    topics: ["config", "context", "init"],
  },
  {
    examples: [
      "cmpatch fingerprint --platform ios --format json",
      "cmpatch debug ios",
    ],
    name: "fingerprint",
    summary: "Compute fingerprints and inspect device update logs.",
    topics: ["fingerprint"],
  },
] as const;

const commandSpecs: RunnableCommandSpec[] = [
  commandSpec({
    aliases: ["config get", "config list", "config set", "config unset"],
    commandName: "config",
    defaults: false,
    execute: executeConfigCommand,
    kind: "config",
    help: [
      {
        description: "Print one user default.",
        group: "config",
        usage: "cmpatch config get <server-url|team|team-id>",
      },
      {
        description: "List user defaults.",
        group: "config",
        usage: "cmpatch config list",
      },
      {
        description: "Store a user default.",
        group: "config",
        usage: "cmpatch config set team-id <id>",
      },
      {
        description: "Remove a user default.",
        group: "config",
        usage: "cmpatch config unset <server-url|team|team-id>",
      }
    ],
    parse: (args) => parseRawArgvCommand(args, "config"),
    routes: [{ path: ["config"] }],
  }),
  commandSpec({
    commandName: "context",
    defaults: false,
    execute: executeContextCommand,
    kind: "context",
    help: [
      {
        description:
          "Show effective local context; --remote adds server-provided SDK configuration.",
        group: "config",
        usage:
          "cmpatch context [--project-root <path>] [--remote] [--token <token>]",
      }
    ],
    parse: (args) => parseContext(args),
    routes: [{ path: ["context"] }],
  }),
  commandSpec({
    commandName: "init",
    defaults: false,
    execute: executeInitCommand,
    kind: "init",
    help: [
      {
        description: `Initialize ${PRODUCT_NAME} for this project.`,
        group: "config",
        usage: "cmpatch init --server-url <url> --ios-app <name> --android-app <name> [--deployment <name>] [--project-root <path>] [--yes] [--non-interactive]",
      }
    ],
    parse: (args) => parseRawArgvCommand(args, "init"),
    routes: [{ path: ["init"] }],
  }),
  commandSpec({
    commandName: "app create",
    defaults: { serverUrl: true, team: "always" },
    execute: executeAppCreate,
    kind: "app-create",
    help: [
      {
        description: "Create an app in a team.",
        group: "management",
        usage: "cmpatch app create --server-url <url> --name <name> [--require-code-signing] [--token <token>]",
      }
    ],
    parse: parseAppCreate,
    routes: [{ path: ["app", "create"] }],
  }),
  commandSpec({
    commandName: "app list",
    defaults: { serverUrl: true, team: "always" },
    execute: executeAppList,
    kind: "app-list",
    help: [
      {
        description: "List apps in a team.",
        group: "management",
        usage: "cmpatch app list --server-url <url> [--token <token>] [--format json|table]",
      }
    ],
    parse: parseAppList,
    renderTable: (result) =>
      renderTableOrEmpty(
        result,
        "apps",
        "No apps found. Create one with `cmpatch app create --name <name>`.",
        ["ID", "NAME", "CODE SIGNING"],
        (app) => [
          readCell(app, "id", ""),
          readCell(app, "name", ""),
          readBooleanCell(app, "require_code_signing"),
        ],
      ),
    routes: [{ path: ["app", "list"] }],
  }),
  commandSpec({
    commandName: "app remove",
    defaults: { serverUrl: true, team: "app-selector-explicit" },
    execute: executeAppRemove,
    kind: "app-remove",
    help: [
      {
        description: "Delete an app (confirms unless --yes).",
        group: "management",
        usage: "cmpatch app remove --server-url <url> (--app-id <id> | --app <name>) [--yes] [--non-interactive] [--token <token>]",
      }
    ],
    parse: parseAppRemove,
    routes: [{ path: ["app", "remove"] }],
  }),
  commandSpec({
    commandName: "app rename",
    defaults: { serverUrl: true, team: "app-selector-explicit" },
    execute: executeAppRename,
    kind: "app-rename",
    help: [
      {
        description: "Rename an app.",
        group: "management",
        usage: "cmpatch app rename --server-url <url> (--app-id <id> | --app <name>) --new-name <name> [--token <token>]",
      }
    ],
    parse: parseAppRename,
    routes: [{ path: ["app", "rename"] }],
  }),
  commandSpec({
    commandName: "app setting",
    defaults: { serverUrl: true, team: "app-selector-explicit" },
    execute: executeAppSetting,
    kind: "app-setting",
    help: [
      {
        description: "View or update app settings.",
        group: "management",
        usage: "cmpatch app setting --server-url <url> (--app-id <id> | --app <name>) --require-code-signing=<true|false> [--token <token>]",
      }
    ],
    parse: parseAppSetting,
    routes: [{ path: ["app", "setting"] }],
  }),
  commandSpec({
    commandName: "app show",
    defaults: { serverUrl: true, team: "app-selector", app: "app-show" },
    execute: executeAppShow,
    kind: "app-show",
    help: [
      {
        description: "Show app details.",
        group: "management",
        usage: "cmpatch app show --server-url <url> (--app-id <id> | --app <name>) [--token <token>]",
      }
    ],
    parse: parseAppShow,
    routes: [{ path: ["app", "show"] }],
  }),
  commandSpec({
    commandName: "deployment clear",
    defaults: { serverUrl: true, team: "app-selector-explicit" },
    execute: executeDeploymentClear,
    kind: "deployment-clear",
    help: [
      {
        description: "Clear release history.",
        group: "management",
        usage: "cmpatch deployment clear --server-url <url> (--deployment-id <id> | --app <name> --deployment <name>) [--token <token>] [--yes] [--non-interactive]",
      }
    ],
    parse: parseDeploymentClear,
    routes: [{ path: ["deployment", "clear"] }],
  }),
  commandSpec({
    commandName: "deployment create",
    defaults: { serverUrl: true, team: "app-selector", app: "deployment" },
    execute: executeDeploymentCreate,
    kind: "deployment-create",
    help: [
      {
        description: "Create a deployment.",
        group: "management",
        usage: "cmpatch deployment create --server-url <url> (--app-id <id> | --app <name>) --name <name> [--token <token>]",
      }
    ],
    parse: parseDeploymentCreate,
    routes: [{ path: ["deployment", "create"] }],
  }),
  commandSpec({
    commandName: "deployment list",
    defaults: { serverUrl: true, team: "app-selector", app: "deployment" },
    execute: executeDeploymentList,
    kind: "deployment-list",
    help: [
      {
        description: "List app deployments.",
        group: "management",
        usage: "cmpatch deployment list --server-url <url> (--app-id <id> | --app <name>) [--token <token>] [--format json|table]",
      }
    ],
    parse: parseDeploymentList,
    renderTable: (result) =>
      renderTableOrEmpty(
        result,
        "deployments",
        "No deployments found. Create one with `cmpatch deployment create --name <name>`.",
        ["ID", "NAME", "DEPLOYMENT_KEY"],
        (deployment) => [
          readCell(deployment, "id", ""),
          readCell(deployment, "name", ""),
          readCell(deployment, "deployment_key", ""),
        ],
      ),
    routes: [{ path: ["deployment", "list"] }],
  }),
  commandSpec({
    commandName: "deployment metrics",
    defaults: { app: "deployment", deployment: "deployment-history", serverUrl: true, team: "app-selector" },
    execute: executeDeploymentMetrics,
    kind: "deployment-metrics",
    help: [
      {
        description: "Show per-release metrics for a deployment.",
        examples: ["cmpatch deployment metrics --app MyApp-iOS --deployment Staging","cmpatch deployment metrics --deployment-id <id>"],
        group: "management",
        usage: "cmpatch deployment metrics --server-url <url> (--deployment-id <id> | --app <name> --deployment <name>) [--token <token>] [--format json|table] [--limit <1-100>] [--offset <0+>]",
      }
    ],
    parse: parseDeploymentMetrics,
    renderTable: (result) =>
      renderTableOrEmpty(
        result,
        "releases",
        "No release metrics found. Publish a release with `cmpatch release-react --deployment <name>`.",
        ["ID", "LABEL", "TARGET", "ACTIVE", "DOWNLOADED", "INSTALLED", "FAILED", "SUCCESS"],
        (item) => {
          const metrics = readRecord(item, "metrics");
          return [
            readCell(item, "release_id", ""),
            readCell(item, "release_label", ""),
            readCell(item, "target_binary_version", ""),
            readCell(metrics, "active", ""),
            readCell(metrics, "downloaded", ""),
            readCell(metrics, "installed", ""),
            readCell(metrics, "failed", ""),
            readCell(metrics, "success", ""),
          ];
        },
      ),
    routes: [{ path: ["deployment", "metrics"] }],
  }),
  commandSpec({
    commandName: "deployment remove",
    defaults: { serverUrl: true, team: "app-selector-explicit" },
    execute: executeDeploymentRemove,
    kind: "deployment-remove",
    help: [
      {
        description: "Delete a deployment (confirms unless --yes).",
        group: "management",
        usage: "cmpatch deployment remove --server-url <url> (--deployment-id <id> | --app <name> --deployment <name>) [--yes] [--non-interactive] [--token <token>]",
      }
    ],
    parse: parseDeploymentRemove,
    routes: [{ path: ["deployment", "remove"] }],
  }),
  commandSpec({
    commandName: "deployment rename",
    defaults: { serverUrl: true, team: "app-selector-explicit" },
    execute: executeDeploymentRename,
    kind: "deployment-rename",
    help: [
      {
        description: "Rename a deployment.",
        group: "management",
        usage: "cmpatch deployment rename --server-url <url> (--deployment-id <id> | --app <name> --deployment <name>) --new-name <name> [--token <token>]",
      }
    ],
    parse: parseDeploymentRename,
    routes: [{ path: ["deployment", "rename"] }],
  }),
  commandSpec({
    commandName: "debug",
    defaults: false,
    execute: executeDebug,
    kind: "debug",
    help: [
      {
        description: `Stream ${PRODUCT_NAME} device logs.`,
        group: "fingerprint",
        usage: "cmpatch debug <ios|android>",
      }
    ],
    parse: parseDebug,
    routes: [{ path: ["debug"] }],
  }),
  commandSpec({
    commandName: "doctor",
    defaults: { bundler: true, deployment: "doctor", platform: true, serverUrl: true, team: "doctor", app: "doctor" },
    execute: executeDoctor,
    kind: "doctor",
    help: [
      {
        description: `Diagnose ${PRODUCT_NAME} setup and OTA readiness.`,
        group: "diagnostics",
        usage: "cmpatch doctor [--server-url <url>] [--app <name> | --app-id <id>] [--deployment <name> | --deployment-id <id>] [--platform <ios|android>] [--project-root <path>] [--deployment-key <key>] [--target-binary-version <version>] [--download-base-url <url>] [--current-package-hash <hash>] [--token <token>] [--format json|table] [--verbose]",
      }
    ],
    parse: parseDoctor,
    renderTable: renderDoctorTable,
    routes: [{ path: ["doctor"] }],
  }),
  commandSpec({
    commandName: "fingerprint",
    defaults: { platform: true },
    execute: executeFingerprint,
    kind: "fingerprint",
    help: [
      {
        description: "Compute a native fingerprint.",
        group: "fingerprint",
        usage: "cmpatch fingerprint --platform <ios|android> [--project-root <path>] [--format text|json|table] [--verbose]",
      }
    ],
    parse: parseFingerprint,
    routes: [{ path: ["fingerprint"] }],
  }),
  commandSpec({
    commandName: "login",
    defaults: { serverUrl: true },
    execute: (command, deps) =>
      executeLogin(command, deps, {
        writeDeviceAuthorizationInstructions(message) {
          writeLine(deps.stdout, message);
        },
      }),
    kind: "login",
    help: [
      {
        description:
          "Sign in. Interactively pick GitHub device login or a personal access token; pass --token to skip the prompt. Non-interactive defaults to device login.",
        group: "auth",
        usage:
          "cmpatch login --server-url <url> [--token <token>] [--non-interactive] [--timeout-seconds <seconds>]",
      }
    ],
    parse: (args, defaults) => parseLogin(args, defaults),
    routes: [{ path: ["login"] }, { path: ["auth", "login"] }],
  }),
  commandSpec({
    commandName: "logout",
    defaults: { serverUrl: true },
    execute: executeLogout,
    kind: "logout",
    help: [
      {
        description: "Remove stored credentials.",
        group: "auth",
        usage: "cmpatch logout --server-url <url>",
      }
    ],
    parse: parseLogout,
    routes: [{ path: ["logout"] }, { path: ["auth", "logout"] }],
  }),
  commandSpec({
    commandName: "member add",
    defaults: { serverUrl: true, team: "member" },
    execute: executeMemberAdd,
    kind: "member-add",
    help: [
      {
        description: "Grant a team role.",
        group: "auth",
        usage: "cmpatch member add --server-url <url> (--user-id <id> | --email <email>) --role <viewer|developer|admin|owner> [--token <token>]",
      }
    ],
    parse: parseMemberAdd,
    routes: [{ path: ["member", "add"] }],
  }),
  commandSpec({
    commandName: "member invite",
    defaults: { serverUrl: true, team: "member" },
    execute: executeMemberInvite,
    kind: "member-invite",
    help: [
      {
        description: "Invite a team member by email or GitHub handle.",
        group: "auth",
        usage: "cmpatch member invite --server-url <url> (--email <email> | --github-handle <handle>) --role <viewer|developer|admin|owner> [--expires-in-days 14] [--token <token>]",
      }
    ],
    parse: parseMemberInvite,
    routes: [{ path: ["member", "invite"] }],
  }),
  commandSpec({
    commandName: "member provision",
    defaults: { serverUrl: true, team: "member" },
    execute: executeMemberProvision,
    kind: "member-provision",
    help: [
      {
        description:
          "Provision a teammate account and personal access token, then add them to a team. Prints a one-time token to hand off (token-mode self-host).",
        group: "auth",
        usage: "cmpatch member provision --server-url <url> --email <email> --role <viewer|developer|admin|owner> [--display-name <name>] [--token-display-name <name>] [--expires-in-days 90] [--token <token>]",
      }
    ],
    parse: parseMemberProvision,
    routes: [{ path: ["member", "provision"] }],
  }),
  commandSpec({
    commandName: "member invite-list",
    defaults: { serverUrl: true, team: "member" },
    execute: executeMemberInviteList,
    kind: "member-invite-list",
    help: [
      {
        description: "List team invitations.",
        group: "auth",
        usage: "cmpatch member invite-list --server-url <url> [--status pending|accepted|revoked|expired|all] [--token <token>] [--format json|table]",
      }
    ],
    parse: parseMemberInviteList,
    renderTable: (result) =>
      renderTableOrEmpty(
        result,
        "invitations",
        "No invitations found. Invite one with `cmpatch member invite --email <email>`.",
        ["ID", "EMAIL", "ROLE", "STATUS", "EXPIRES"],
        (invitation) => {
          const role = readRecord(invitation, "role");
          return [
            readCell(invitation, "id", ""),
            readCell(invitation, "email", ""),
            readCell(role, "key", ""),
            readCell(invitation, "status", ""),
            readCell(invitation, "expires_at", ""),
          ];
        },
      ),
    routes: [
      { path: ["member", "invite-list"] },
    ],
  }),
  commandSpec({
    commandName: "member invite-revoke",
    defaults: { serverUrl: true },
    execute: executeMemberInviteRevoke,
    kind: "member-invite-revoke",
    help: [
      {
        description: "Revoke a team invitation.",
        group: "auth",
        usage: "cmpatch member invite-revoke --server-url <url> --invitation-id <id> [--token <token>]",
      }
    ],
    parse: parseMemberInviteRevoke,
    routes: [
      { path: ["member", "invite-revoke"] },
    ],
  }),
  commandSpec({
    commandName: "member list",
    defaults: { serverUrl: true, team: "member" },
    execute: executeMemberList,
    kind: "member-list",
    help: [
      {
        description: "List team role bindings.",
        group: "auth",
        usage: "cmpatch member list --server-url <url> [--token <token>] [--format json|table]",
      }
    ],
    parse: parseMemberList,
    renderTable: (result) =>
      renderTableOrEmpty(
        result,
        "role_bindings",
        "No members found. Add one with `cmpatch member add --email <email>`.",
        ["ID", "USER", "EMAIL", "ROLE"],
        (binding) => {
          const user = readRecord(binding, "user");
          const role = readRecord(binding, "role");
          return [
            readCell(binding, "id", ""),
            readCell(user, "id", ""),
            readCell(user, "email", ""),
            readCell(role, "key", ""),
          ];
        },
      ),
    routes: [{ path: ["member", "list"] }],
  }),
  commandSpec({
    commandName: "member remove",
    defaults: { serverUrl: true, team: "member" },
    execute: executeMemberRemove,
    kind: "member-remove",
    help: [
      {
        description: "Remove a team role binding.",
        group: "auth",
        usage: "cmpatch member remove --server-url <url> (--binding-id <id> | (--user-id <id> | --email <email>) --role <viewer|developer|admin|owner>) [--token <token>]",
      }
    ],
    parse: parseMemberRemove,
    routes: [{ path: ["member", "remove"] }],
  }),
  commandSpec({
    commandName: "release create",
    defaults: { deployment: "release", platform: true, serverUrl: true, team: "app-selector", app: "release" },
    execute: executeReleaseCreate,
    kind: "release-create",
    help: [
      {
        description: "Upload a prebuilt bundle or .cmpatch.",
        group: "release",
        usage: "cmpatch release create --server-url <url> (--deployment-id <id> | --app <name> --deployment <name>) (--bundle-path <dir|zip> --target-binary-version <version> (--platform <ios|android> [--project-root <path>] | --fingerprint <hash>) [--sourcemap <path>] [--private-key-path <path>] | --bundle-path <file.cmpatch>) [--token <token>] [--release-notes <text>] [--rollout-percentage <1-100>] [--mandatory] [--disabled] [--dry-run] [--yes] [--non-interactive] [--no-duplicate-release-error]",
      }
    ],
    parse: parseReleaseCreate,
    responseWarnings: true,
    routes: [{ path: ["release", "create"] }],
  }),
  commandSpec({
    commandName: "release inspect",
    defaults: { deployment: "release", serverUrl: true, team: "app-selector", app: "release" },
    execute: executeReleaseInspect,
    kind: "release-inspect",
    help: [
      {
        description: "Inspect release processing status.",
        group: "release",
        usage: "cmpatch release inspect --server-url <url> (--release-id <id> | (--deployment-id <id> | --app <name> --deployment <name>) --label <label>) [--wait] [--timeout <seconds>] [--token <token>] [--format json|table]",
      }
    ],
    parse: parseReleaseInspect,
    renderTable: renderReleaseInspectTable,
    routes: [{ path: ["release", "inspect"] }],
  }),
  commandSpec({
    aliases: ["release disable", "release enable"],
    commandName: "release patch",
    defaults: { serverUrl: true, team: "app-selector-explicit" },
    execute: executeReleasePatch,
    kind: "release-patch",
    help: [
      {
        description: "Update release metadata.",
        group: "release",
        usage: "cmpatch release patch --server-url <url> (--release-id <id> | (--deployment-id <id> | --app <name> --deployment <name>) --label <label>) [--token <token>] [--release-notes <text>] [--rollout-percentage <1-100>] [--mandatory | --not-mandatory] [--target-binary-version <version>] [--status disabled|published] [--yes] [--non-interactive]",
      },
      {
        description: "Disable a release.",
        group: "release",
        usage: "cmpatch release disable --server-url <url> (--release-id <id> | (--deployment-id <id> | --app <name> --deployment <name>) --label <label>) [--token <token>] [--yes] [--non-interactive]",
      },
      {
        description: "Enable a release.",
        group: "release",
        usage: "cmpatch release enable --server-url <url> (--release-id <id> | (--deployment-id <id> | --app <name> --deployment <name>) --label <label>) [--token <token>] [--yes] [--non-interactive]",
      }
    ],
    parse: parseReleasePatch,
    responseWarnings: true,
    routes: [
      { path: ["release", "patch"] },
      {
        parse: (args, defaults) =>
          parseReleaseStatus(args, "disabled", defaults),
        path: ["release", "disable"],
      },
      {
        parse: (args, defaults) =>
          parseReleaseStatus(args, "published", defaults),
        path: ["release", "enable"],
      },
    ],
  }),
  commandSpec({
    aliases: ["deployment history"],
    commandName: "release list",
    defaults: { deployment: "release", serverUrl: true, team: "app-selector", app: "release" },
    execute: executeReleaseList,
    kind: "release-list",
    help: [
      {
        description: "List deployment releases.",
        group: "release",
        usage: "cmpatch release list --server-url <url> (--deployment-id <id> | --app <name> --deployment <name>) [--token <token>] [--format json|table] [--limit <1-100>] [--offset <0+>] [--include metrics]",
      },
      {
        description: "Show deployment release history.",
        examples: ["cmpatch deployment history --app MyApp-iOS --deployment Staging","cmpatch deployment history --deployment-id <id>"],
        group: "management",
        usage: "cmpatch deployment history --server-url <url> (--deployment-id <id> | --app <name> --deployment <name>) [--token <token>] [--limit <1-100>] [--offset <0+>]",
      }
    ],
    parse: parseReleaseList,
    renderTable: (result) =>
      renderTableOrEmpty(
        result,
        "releases",
        "No releases found. Publish one with `cmpatch release-react --deployment <name>`.",
        ["ID", "LABEL", "TARGET", "STATUS", "MANDATORY", "ROLLOUT"],
        (item) => {
          const release = readRecord(item, "release");
          return [
            readCell(release, "id", ""),
            readCell(release, "release_label", ""),
            readCell(release, "target_binary_version", ""),
            readCell(release, "status", ""),
            readBooleanCell(release, "is_mandatory"),
            readCell(release, "rollout_percentage", ""),
          ];
        },
      ),
    routes: [
      { path: ["release", "list"] },
      {
        defaults: {
          app: "deployment",
          deployment: "deployment-history",
          serverUrl: true,
          team: "app-selector",
        },
        parse: parseDeploymentHistory,
        path: ["deployment", "history"],
      },
    ],
  }),
  commandSpec({
    commandName: "release metrics",
    defaults: { deployment: "release", serverUrl: true, team: "app-selector", app: "release" },
    execute: executeReleaseMetrics,
    kind: "release-metrics",
    help: [
      {
        description: "Show release metrics.",
        group: "release",
        usage: "cmpatch release metrics --server-url <url> (--release-id <id> | (--deployment-id <id> | --app <name> --deployment <name>) --label <label>) [--token <token>] [--format json|table]",
      }
    ],
    parse: parseReleaseMetrics,
    renderTable: renderReleaseMetricsTable,
    routes: [{ path: ["release", "metrics"] }],
  }),
  commandSpec({
    commandName: "release promote",
    defaults: { serverUrl: true, team: "app-selector-explicit" },
    execute: executeReleasePromote,
    kind: "release-promote",
    help: [
      {
        description: "Promote a release.",
        group: "release",
        usage: "cmpatch release promote --server-url <url> (--release-id <id> | (--source-deployment-id <id> | --app <name> --source-deployment <name>) --label <label>) (--dest-deployment-id <id> | --app <name> --dest-deployment <name>) [--token <token>] [--release-notes <text>] [--rollout-percentage <1-100>] [--mandatory | --not-mandatory] [--disabled] [--target-binary-version <version>] [--yes] [--non-interactive] [--no-duplicate-release-error]",
      }
    ],
    parse: parseReleasePromote,
    responseWarnings: true,
    routes: [{ path: ["release", "promote"] }],
  }),
  commandSpec({
    commandName: "release rollback",
    defaults: { serverUrl: true, team: "app-selector-explicit" },
    execute: executeReleaseRollback,
    kind: "release-rollback",
    help: [
      {
        description: "Roll back a deployment.",
        group: "release",
        usage: "cmpatch release rollback --server-url <url> (--deployment-id <id> | --app <name> --deployment <name>) [--label <label>] [--token <token>] [--yes] [--non-interactive]",
      }
    ],
    parse: parseReleaseRollback,
    responseWarnings: true,
    routes: [{ path: ["release", "rollback"] }],
  }),
  commandSpec({
    commandName: "release show",
    defaults: { deployment: "release", serverUrl: true, team: "app-selector", app: "release" },
    execute: executeReleaseShow,
    kind: "release-show",
    help: [
      {
        description: "Show release details.",
        group: "release",
        usage: "cmpatch release show --server-url <url> (--release-id <id> | (--deployment-id <id> | --app <name> --deployment <name>) --label <label>) [--token <token>]",
      }
    ],
    parse: parseReleaseShow,
    routes: [{ path: ["release", "show"] }],
  }),
  commandSpec({
    commandName: "release-react",
    defaults: { bundler: true, deployment: "release-react", platform: true, serverUrl: true, team: "app-selector", app: "release-react" },
    execute: executeReleaseReact,
    kind: "release-react",
    help: [
      {
        description: "Build a React Native bundle and upload it.",
        group: "release",
        usage: "cmpatch release-react --server-url <url> (--deployment-id <id> | --app <name> --deployment <name>) --platform <ios|android> [--target-binary-version <version>] [--token <token>] [--entry-file <path>] [--project-root <path>] [--plist-file <path>] [--plist-file-prefix <prefix>] [--gradle-file <path>] [--xcode-project-file <path>] [--xcode-target-name <name>] [--build-configuration-name <name>] [--bundler auto|metro|expo] [--bundler-args <arg>] [--hermes auto|true|false (metro only)] [--extra-hermes-flag <flag> (metro only)] [--base-bytecode auto|off] [--release-notes <text>] [--rollout-percentage <1-100>] [--mandatory] [--disabled] [--dry-run] [--yes] [--non-interactive] [--no-duplicate-release-error] [--sourcemap-output <path>] [--private-key-path <path>]",
      }
    ],
    parse: parseReleaseReact,
    responseWarnings: true,
    routes: [{ path: ["release-react"] }],
  }),
  commandSpec({
    commandName: "bundle",
    defaults: { bundler: true, platform: true },
    execute: executeBundle,
    kind: "bundle",
    help: [
      {
        description: "Build a .cmpatch artifact only (no upload).",
        group: "release",
        usage:
          "cmpatch bundle --platform <ios|android> [--target-binary-version <version>] [--output <file.cmpatch>] [--project-root <path>] [--bundler auto|metro|expo] [--entry-file <path>] [--hermes auto|true|false (metro only)] [--extra-hermes-flag <flag> (metro only)] [--base-bytecode auto|off] [--private-key-path <path>] [--sourcemap-output <path>] [--rollout-percentage <1-100>] [--mandatory] [--disabled] [--release-notes <text>] [--no-duplicate-release-error]",
      },
    ],
    parse: parseBundle,
    routes: [{ path: ["bundle"] }],
  }),
  commandSpec({
    commandName: "token create",
    defaults: { serverUrl: true },
    execute: executeTokenCreate,
    kind: "token-create",
    help: [
      {
        description: "Create a personal access token.",
        group: "auth",
        usage: "cmpatch token create --server-url <url> --name <name> [--expires-in-days <days>] [--token <token>]",
      }
    ],
    parse: parseTokenCreate,
    routes: [{ path: ["token", "create"] }],
  }),
  commandSpec({
    commandName: "token list",
    defaults: { serverUrl: true },
    execute: executeTokenList,
    kind: "token-list",
    help: [
      {
        description: "List personal access tokens.",
        group: "auth",
        usage: "cmpatch token list --server-url <url> [--token <token>]",
      }
    ],
    parse: parseTokenList,
    routes: [{ path: ["token", "list"] }],
  }),
  commandSpec({
    commandName: "token revoke",
    defaults: { serverUrl: true },
    execute: executeTokenRevoke,
    kind: "token-revoke",
    help: [
      {
        description: "Revoke a personal access token.",
        group: "auth",
        usage: "cmpatch token revoke --server-url <url> --token-id <id> [--token <token>]",
      }
    ],
    parse: parseTokenRevoke,
    routes: [{ path: ["token", "revoke"] }],
  }),
  commandSpec({
    commandName: "whoami",
    defaults: { serverUrl: true },
    execute: executeWhoami,
    kind: "whoami",
    help: [
      {
        description: "Show the authenticated user.",
        group: "auth",
        usage: "cmpatch whoami --server-url <url> [--token <token>]",
      }
    ],
    parse: parseWhoami,
    routes: [{ path: ["whoami"] }, { path: ["auth", "whoami"] }],
  }),
];

type RegisteredCommandKind = (typeof commandSpecs)[number]["kind"];
type MissingCommandSpec = Exclude<CommandKind, RegisteredCommandKind>;
const allCommandSpecsRegistered: Record<MissingCommandSpec, never> = {};
void allCommandSpecsRegistered;

const commandSpecsByKind = new Map<CommandKind, RunnableCommandSpec>(
  commandSpecs.map((spec) => [spec.kind, spec as RunnableCommandSpec]),
);

export async function executeCommandSpec(
  command: ExecutableCliCommand,
  deps: CommandSpecDeps,
): Promise<unknown> {
  const spec = commandSpecsByKind.get(command.kind);

  if (spec === undefined) {
    throw new Error(`No command spec registered for ${command.kind}`);
  }

  return spec.execute(command, deps);
}

export function getCommandSuggestionCandidates(): string[] {
  return Array.from(
    new Set([
      ...commandSpecs.flatMap((spec) => [
        spec.commandName,
        ...spec.aliases,
        ...spec.routes.map((route) => formatCommandPath(route.path)),
      ]),
    ]),
  );
}

export function findCommandSpecRoute(
  argv: string[],
): {
  args: string[];
  defaults: CommandDefaultPolicy | false;
  kind: CommandKind;
  parse: CommandParser;
} | null {
  for (const spec of commandSpecs) {
    const route = spec.routes.find((candidate) =>
      matchesCommandPath(argv, candidate.path),
    );

    if (route !== undefined) {
      return {
        args: argv.slice(route.path.length),
        defaults: route.defaults,
        kind: spec.kind,
        parse: route.parse,
      };
    }
  }

  return null;
}

/**
 * True when `token` is the first segment of any registered command route
 * (e.g. `release`, `app`, `auth`, `login`). Used to tell a mistyped top-level
 * command (`cmpatch frobnicate` -> "unknown command") apart from a known command
 * group with a bad/missing subcommand (`cmpatch release frob` -> "unknown
 * subcommand").
 */
export function isKnownCommandPrefix(token: string | undefined): boolean {
  if (token === undefined) {
    return false;
  }

  return commandSpecs.some((spec) =>
    spec.routes.some((route) => route.path[0] === token),
  );
}

export function renderCommandTable(
  command: CliCommand,
  result: unknown,
): string | null {
  if (
    command.kind === "help" ||
    command.kind === "version" ||
    command.kind === "not-implemented"
  ) {
    return null;
  }

  const spec = commandSpecsByKind.get(command.kind);
  return spec?.renderTable?.(result, command) ?? null;
}

export function hasCommandTableRenderer(command: CliCommand): boolean {
  if (
    command.kind === "help" ||
    command.kind === "version" ||
    command.kind === "not-implemented"
  ) {
    return false;
  }

  const spec = commandSpecsByKind.get(command.kind);
  return spec?.renderTable !== undefined;
}

export function commandEmitsResponseWarnings(command: CliCommand): boolean {
  if (
    command.kind === "help" ||
    command.kind === "version" ||
    command.kind === "not-implemented"
  ) {
    return false;
  }

  const spec = commandSpecsByKind.get(command.kind);
  return spec?.responseWarnings === true;
}

export function getCommandHelpGroups(): readonly CommandHelpGroup[] {
  return helpGroups;
}

export function getCommandHelpEntries(): CommandHelpEntry[] {
  return commandSpecs.flatMap((spec) => spec.help);
}

function commandSpec<
  K extends CommandKind,
  const R extends readonly CommandRouteInput[],
>(spec: CommandSpecInput<K, R>): RunnableCommandSpec<K> {
  return {
    aliases: spec.aliases ?? [],
    commandName: spec.commandName,
    defaults: spec.defaults,
    execute: spec.execute,
    help: (spec.help ?? []).map((help) => ({
      ...help,
      commandName: extractHelpCommandName(help.usage),
    })),
    kind: spec.kind,
    parse: spec.parse,
    ...(spec.renderTable !== undefined
      ? {
          renderTable: spec.renderTable as (
            result: unknown,
            command: ExecutableCliCommand,
          ) => string,
        }
      : {}),
    ...(spec.responseWarnings !== undefined
      ? { responseWarnings: spec.responseWarnings }
      : {}),
    routes: spec.routes.map((route) => ({
      defaults: route.defaults ?? spec.defaults,
      parse: route.parse ?? spec.parse,
      path: route.path,
    })),
  };
}

function extractHelpCommandName(usageLine: string): string {
  const tokens = usageLine.split(" ").filter(Boolean);
  const commandTokens: string[] = [];

  for (const token of tokens.slice(1)) {
    if (
      token.startsWith("-") ||
      token.startsWith("(") ||
      token.startsWith("[") ||
      token.startsWith("<")
    ) {
      break;
    }

    commandTokens.push(token);
    if (commandTokens.length === 2) {
      break;
    }
  }

  return commandTokens.join(" ");
}

function formatCommandPath(path: CommandPath): string {
  return path.join(" ");
}

function matchesCommandPath(argv: string[], path: CommandPath): boolean {
  return path.every((part, index) => argv[index] === part);
}

function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(
      header.length,
      ...rows.map((row) => row[index]?.length ?? 0),
    ),
  );
  const renderRow = (row: string[]) =>
    row
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join("  ")
      .trimEnd();
  const lines = [
    renderRow(headers),
    renderRow(headers.map((header) => "-".repeat(header.length))),
    ...rows.map(renderRow),
  ];

  return `${lines.join("\n")}\n`;
}

function renderTableOrEmpty(
  result: unknown,
  key: string,
  emptyMessage: string,
  headers: string[],
  mapRow: (row: Record<string, unknown>) => string[],
): string {
  const rows = readArray(result, key);

  if (rows.length === 0) {
    return `${emptyMessage}\n`;
  }

  return renderTable(headers, rows.map(mapRow));
}

function readArray(value: unknown, key: string): Record<string, unknown>[] {
  if (!isRecord(value) || !Array.isArray(value[key])) {
    throw new UsageError(
      `Cannot render table output: expected response field "${key}" to be an array`,
    );
  }

  return value[key].filter(isRecord);
}

function readRecord(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const nested = value[key];
  return isRecord(nested) ? nested : {};
}

function readBooleanCell(value: Record<string, unknown>, key: string): string {
  const cell = value[key];
  if (typeof cell !== "boolean") {
    return "";
  }

  return cell ? "yes" : "no";
}
