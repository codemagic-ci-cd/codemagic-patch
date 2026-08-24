import type {
  CliCommand,
  CommandDefaultFlagValues,
  ParseCliResult,
  DeploymentSelector,
  PromptableFlag,
} from "./commandTypes";
import type { ActionSummary, ObjectField } from "./resultView";
import { renderCommand } from "./argv";
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
  parseMemberUpdate,
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
  executeMemberUpdate,
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
import {
  isRecord,
  PLAIN_PALETTE,
  readCell,
  writeLine,
  type Palette,
} from "./output";

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

export type CommandFlagHelp = {
  /** The flag with its value placeholder, e.g. "--app <name>". */
  flag: string;
  summary: string;
};

export type CommandFlagSection = {
  flags: readonly CommandFlagHelp[];
  /** Section heading in help output; defaults to "Flags". */
  title?: string;
};

type CommandHelpInput = {
  description: string;
  examples?: readonly string[];
  flags?: readonly CommandFlagSection[];
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
  /**
   * This command changes state without re-showing what was resolved — it has
   * no mutation-safety note and no confirm. The interactive resolver must then
   * ask even when only one resource exists: a sole-entry selector may only be
   * inferred for a command that still confirms (or only reads), because the
   * confirm is where an inferred selector becomes visible before anything is
   * mutated (cli-tech-spec.md, interactive resolution).
   */
  mutatesWithoutConfirm?: true;
  platform?: true;
  /**
   * Flags this command may ASK for without ever taking them from stored
   * configuration. The two are not the same permission: choosing from a list is
   * a decision the user makes now and can see, while a config default is one
   * they made earlier in another context. Destructive commands want the first
   * and must not have the second — a stale codemagic-patch.config.json must
   * never be what decides which app gets removed.
   */
  prompt?: PromptableFlag[];
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

/**
 * How a command's human-facing result is presented. Declared here rather than
 * written per command so one renderer serves all of them, and so a command that
 * declares nothing still gets the right SHAPE — a record is not shown as a
 * table just because no one said otherwise.
 */
export type CommandView<C = never> =
  | {
      /**
       * Something changed. Return the sentence that says what; return null when
       * the response is not recognisable enough to summarise, and the labelled
       * record is shown instead.
       */
      summarize: (result: unknown, command: C) => ActionSummary | string | null;
      kind: "action";
    }
  | {
      /** Label and source path per field, in the order they should be read. */
      fields: readonly ObjectField[];
      kind: "object";
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
  renderTable?: (
    result: unknown,
    command: CommandForKind<K>,
    palette: Palette,
  ) => string;
  view?: CommandView<CommandForKind<K>>;
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
  renderTable?: (
    result: unknown,
    command: ExecutableCliCommand,
    palette: Palette,
  ) => string;
  view?: CommandView<never>;
  responseWarnings?: true;
  routes: readonly CommandRoute[];
};

// One definition per recurring flag so it reads the same on every help page.
const flagHelp = {
  allowFingerprintMismatch: {
    flag: "--allow-fingerprint-mismatch",
    summary: "Publish after verifying a fingerprint mismatch",
  },
  app: { flag: "--app <name>", summary: "App name" },
  appId: { flag: "--app-id <id>", summary: "App id (alternative to --app)" },
  deployment: { flag: "--deployment <name>", summary: "Deployment name" },
  deploymentId: {
    flag: "--deployment-id <id>",
    summary: "Deployment id (alternative to --app plus --deployment)",
  },
  disabled: {
    flag: "--disabled",
    summary: "Create the release in the disabled state",
  },
  dryRun: {
    flag: "--dry-run",
    summary: "Build and validate without uploading",
  },
  format: {
    flag: "--format <json|table>",
    summary: "Output format; piped stdout defaults to json",
  },
  label: { flag: "--label <label>", summary: "Release label, e.g. v42" },
  limit: { flag: "--limit <1-100>", summary: "Page size" },
  mandatory: {
    flag: "--mandatory",
    summary: "Mark the release as mandatory",
  },
  noDuplicateReleaseError: {
    flag: "--no-duplicate-release-error",
    summary: "Treat an identical pending release as success, not an error",
  },
  nonInteractive: {
    flag: "--non-interactive",
    summary: "Never prompt; fail when input would be needed",
  },
  offset: { flag: "--offset <0+>", summary: "Skip this many entries" },
  platform: { flag: "--platform <ios|android>", summary: "Target platform" },
  privateKeyPath: {
    flag: "--private-key-path <path>",
    summary: "Sign the bundle with this private key",
  },
  projectRoot: {
    flag: "--project-root <path>",
    summary: "React Native project root (default: current directory)",
  },
  releaseId: {
    flag: "--release-id <id>",
    summary: "Release id (alternative to a deployment selector plus --label)",
  },
  releaseNotes: {
    flag: "--release-notes <text>",
    summary: "Notes shown alongside the release",
  },
  rolloutPercentage: {
    flag: "--rollout-percentage <1-100>",
    summary: "Roll out to a percentage of devices",
  },
  serverUrl: {
    flag: "--server-url <url>",
    summary: "Update server URL (stored config is used when omitted)",
  },
  targetBinaryVersion: {
    flag: "--target-binary-version <version>",
    summary: "Binary version(s) the release targets, e.g. 1.2.3",
  },
  team: {
    flag: "--team <name>",
    summary: "Team name (auto-resolved when the server has a single team)",
  },
  teamId: { flag: "--team-id <id>", summary: "Team id (alternative to --team)" },
  token: {
    flag: "--token <token>",
    summary: "Personal access token (stored login is used when omitted)",
  },
  yes: { flag: "--yes", summary: "Skip confirmation prompts" },
} as const satisfies Record<string, CommandFlagHelp>;

// Selector and connection flags recur as whole blocks, not just single flags.
const teamSelectorFlagHelp: readonly CommandFlagHelp[] = [
  flagHelp.team,
  flagHelp.teamId,
];

const appSelectorFlags: readonly CommandFlagHelp[] = [
  flagHelp.app,
  flagHelp.appId,
  ...teamSelectorFlagHelp,
];

const deploymentSelectorFlagHelp: readonly CommandFlagHelp[] = [
  ...appSelectorFlags,
  flagHelp.deployment,
  flagHelp.deploymentId,
];

const releaseSelectorFlagHelp: readonly CommandFlagHelp[] = [
  ...deploymentSelectorFlagHelp,
  flagHelp.label,
  flagHelp.releaseId,
];

const serverFlagHelp: readonly CommandFlagHelp[] = [
  flagHelp.serverUrl,
  flagHelp.token,
];

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
      "cmpatch init --ios-app MyApp-iOS --android-app MyApp-Android --yes",
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
        flags: [
          {
            flags: [
              flagHelp.projectRoot,
              {
                flag: "--remote",
                summary: "Also fetch server-provided SDK configuration",
              },
              flagHelp.token,
            ],
          },
        ],
        group: "config",
        usage: "cmpatch context [flags]",
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
        description: `Initialize ${PRODUCT_NAME} for this project. Runs as an interactive wizard; pass flags to script it.`,
        examples: [
          "cmpatch init",
          "cmpatch init --ios-app MyApp-iOS --android-app MyApp-Android --yes",
        ],
        flags: [
          {
            flags: [
              flagHelp.serverUrl,
              { flag: "--ios-app <name>", summary: "App name for iOS" },
              {
                flag: "--android-app <name>",
                summary: "App name for Android",
              },
              {
                flag: "--deployment <name>",
                summary: "Default deployment to store",
              },
              flagHelp.projectRoot,
              flagHelp.yes,
              flagHelp.nonInteractive,
            ],
          },
        ],
        group: "config",
        usage: "cmpatch init [flags]",
      }
    ],
    parse: (args) => parseRawArgvCommand(args, "init"),
    routes: [{ path: ["init"] }],
  }),
  commandSpec({
    commandName: "app create",
    view: {
      kind: "action",
      summarize: (_result, command) => `Created app ${command.name}`,
    },
    defaults: { prompt: ["name"], serverUrl: true, team: "always" },
    execute: executeAppCreate,
    kind: "app-create",
    help: [
      {
        description: "Create an app in a team.",
        flags: [
          {
            flags: [
              { flag: "--name <name>", summary: "App name" },
              {
                flag: "--require-code-signing",
                summary: "Only accept signed bundles for this app",
              },
              ...teamSelectorFlagHelp,
              ...serverFlagHelp,
            ],
          },
        ],
        group: "management",
        usage: "cmpatch app create --name <name> [flags]",
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
        flags: [{ flags: [...teamSelectorFlagHelp, flagHelp.format, ...serverFlagHelp] }],
        group: "management",
        usage: "cmpatch app list [flags]",
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
    view: { kind: "action", summarize: summarizeDeletion },
    defaults: { prompt: ["app"], serverUrl: true, team: "app-selector-explicit" },
    execute: executeAppRemove,
    kind: "app-remove",
    help: [
      {
        description: "Delete an app (confirms unless --yes).",
        flags: [
          {
            flags: [
              ...appSelectorFlags,
              flagHelp.yes,
              flagHelp.nonInteractive,
              ...serverFlagHelp,
            ],
          },
        ],
        group: "management",
        usage: "cmpatch app remove (--app <name> | --app-id <id>) [flags]",
      }
    ],
    parse: parseAppRemove,
    routes: [{ path: ["app", "remove"] }],
  }),
  commandSpec({
    commandName: "app rename",
    view: {
      kind: "action",
      summarize: (_result, command) => `Renamed app to ${command.name}`,
    },
    defaults: { mutatesWithoutConfirm: true, prompt: ["app", "newName"], serverUrl: true, team: "app-selector-explicit" },
    execute: executeAppRename,
    kind: "app-rename",
    help: [
      {
        description: "Rename an app.",
        flags: [
          {
            flags: [
              ...appSelectorFlags,
              { flag: "--new-name <name>", summary: "New app name" },
              ...serverFlagHelp,
            ],
          },
        ],
        group: "management",
        usage:
          "cmpatch app rename (--app <name> | --app-id <id>) --new-name <name> [flags]",
      }
    ],
    parse: parseAppRename,
    routes: [{ path: ["app", "rename"] }],
  }),
  commandSpec({
    commandName: "app setting",
    defaults: { mutatesWithoutConfirm: true, prompt: ["app", "requireCodeSigning"], serverUrl: true, team: "app-selector-explicit" },
    execute: executeAppSetting,
    kind: "app-setting",
    help: [
      {
        description: "View or update app settings.",
        flags: [
          {
            flags: [
              ...appSelectorFlags,
              {
                flag: "--require-code-signing=<true|false>",
                summary: "Update whether bundles must be signed",
              },
              ...serverFlagHelp,
            ],
          },
        ],
        group: "management",
        usage: "cmpatch app setting (--app <name> | --app-id <id>) [flags]",
      }
    ],
    parse: parseAppSetting,
    routes: [{ path: ["app", "setting"] }],
  }),
  commandSpec({
    commandName: "app show",
    view: {
      fields: [
        ["Name", "app.name"],
        ["App ID", "app.id"],
        ["Code signing", "app.require_code_signing"],
      ],
      kind: "object",
    },
    defaults: { serverUrl: true, team: "app-selector", app: "app-show" },
    execute: executeAppShow,
    kind: "app-show",
    help: [
      {
        description: "Show app details.",
        flags: [{ flags: [...appSelectorFlags, ...serverFlagHelp] }],
        group: "management",
        usage: "cmpatch app show (--app <name> | --app-id <id>) [flags]",
      }
    ],
    parse: parseAppShow,
    routes: [{ path: ["app", "show"] }],
  }),
  commandSpec({
    commandName: "deployment clear",
    view: {
      kind: "action",
      summarize: (_result, command) =>
        "Cleared release history for " + deploymentLabel(command.deployment),
    },
    defaults: { prompt: ["app", "deployment"], serverUrl: true, team: "app-selector-explicit" },
    execute: executeDeploymentClear,
    kind: "deployment-clear",
    help: [
      {
        description: "Clear release history.",
        flags: [
          {
            flags: [
              ...deploymentSelectorFlagHelp,
              flagHelp.yes,
              flagHelp.nonInteractive,
              ...serverFlagHelp,
            ],
          },
        ],
        group: "management",
        usage: "cmpatch deployment clear --deployment <name> [flags]",
      }
    ],
    parse: parseDeploymentClear,
    routes: [{ path: ["deployment", "clear"] }],
  }),
  commandSpec({
    commandName: "deployment create",
    view: {
      kind: "action",
      summarize: (_result, command) => `Created deployment ${command.name}`,
    },
    defaults: { mutatesWithoutConfirm: true, prompt: ["name"], serverUrl: true, team: "app-selector", app: "deployment" },
    execute: executeDeploymentCreate,
    kind: "deployment-create",
    help: [
      {
        description: "Create a deployment.",
        flags: [
          {
            flags: [
              ...appSelectorFlags,
              { flag: "--name <name>", summary: "Deployment name" },
              ...serverFlagHelp,
            ],
          },
        ],
        group: "management",
        usage: "cmpatch deployment create --name <name> [flags]",
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
        flags: [
          { flags: [...appSelectorFlags, flagHelp.format, ...serverFlagHelp] },
        ],
        group: "management",
        usage: "cmpatch deployment list [flags]",
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
        flags: [
          {
            flags: [
              ...deploymentSelectorFlagHelp,
              flagHelp.format,
              flagHelp.limit,
              flagHelp.offset,
              ...serverFlagHelp,
            ],
          },
        ],
        group: "management",
        usage: "cmpatch deployment metrics --deployment <name> [flags]",
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
    view: { kind: "action", summarize: summarizeDeletion },
    defaults: { prompt: ["app", "deployment"], serverUrl: true, team: "app-selector-explicit" },
    execute: executeDeploymentRemove,
    kind: "deployment-remove",
    help: [
      {
        description: "Delete a deployment (confirms unless --yes).",
        flags: [
          {
            flags: [
              ...deploymentSelectorFlagHelp,
              flagHelp.yes,
              flagHelp.nonInteractive,
              ...serverFlagHelp,
            ],
          },
        ],
        group: "management",
        usage: "cmpatch deployment remove --deployment <name> [flags]",
      }
    ],
    parse: parseDeploymentRemove,
    routes: [{ path: ["deployment", "remove"] }],
  }),
  commandSpec({
    commandName: "deployment rename",
    view: {
      kind: "action",
      summarize: (_result, command) => `Renamed deployment to ${command.name}`,
    },
    defaults: { mutatesWithoutConfirm: true, prompt: ["app", "deployment", "newName"], serverUrl: true, team: "app-selector-explicit" },
    execute: executeDeploymentRename,
    kind: "deployment-rename",
    help: [
      {
        description: "Rename a deployment.",
        flags: [
          {
            flags: [
              ...deploymentSelectorFlagHelp,
              { flag: "--new-name <name>", summary: "New deployment name" },
              ...serverFlagHelp,
            ],
          },
        ],
        group: "management",
        usage:
          "cmpatch deployment rename --deployment <name> --new-name <name> [flags]",
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
        examples: ["cmpatch doctor", "cmpatch doctor --deployment Staging --verbose"],
        flags: [
          {
            flags: [
              ...deploymentSelectorFlagHelp,
              flagHelp.platform,
              flagHelp.projectRoot,
              flagHelp.format,
              { flag: "--verbose", summary: "Show every check, not just failures" },
              ...serverFlagHelp,
            ],
          },
          {
            flags: [
              {
                flag: "--deployment-key <key>",
                summary: "Check a specific deployment key",
              },
              flagHelp.targetBinaryVersion,
              {
                flag: "--download-base-url <url>",
                summary: "Override the artifact download origin",
              },
              {
                flag: "--current-package-hash <hash>",
                summary: "Simulate a device that already runs this package",
              },
            ],
            title: "Update-check flags",
          },
        ],
        group: "diagnostics",
        usage: "cmpatch doctor [flags]",
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
        flags: [
          {
            flags: [
              flagHelp.platform,
              flagHelp.projectRoot,
              {
                flag: "--format <text|json|table>",
                summary: "Output format; piped stdout defaults to json",
              },
              {
                flag: "--verbose",
                summary: "List the files that fed the fingerprint",
              },
            ],
          },
        ],
        group: "fingerprint",
        usage: "cmpatch fingerprint --platform <ios|android> [flags]",
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
        writeAuthorizationInstructions(message) {
          writeLine(deps.stdout, message);
        },
      }),
    kind: "login",
    help: [
      {
        description:
          "Sign in with the browser or a personal access token. Browser sign-in opens the dashboard and finishes over a localhost redirect.",
        flags: [
          {
            flags: [
              flagHelp.serverUrl,
              {
                flag: "--token <token>",
                summary: "Sign in with a token instead of the browser",
              },
              {
                flag: "--no-browser",
                summary: "Print the sign-in URL instead of opening a browser",
              },
              {
                flag: "--timeout-seconds <seconds>",
                summary: "How long to wait for browser sign-in",
              },
              flagHelp.nonInteractive,
            ],
          },
        ],
        group: "auth",
        usage: "cmpatch login [flags]",
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
        flags: [{ flags: [flagHelp.serverUrl] }],
        group: "auth",
        usage: "cmpatch logout [flags]",
      }
    ],
    parse: parseLogout,
    routes: [{ path: ["logout"] }, { path: ["auth", "logout"] }],
  }),
  commandSpec({
    commandName: "member add",
    defaults: { prompt: ["email", "role"], serverUrl: true, team: "member" },
    execute: executeMemberAdd,
    kind: "member-add",
    help: [
      {
        description: "Grant a team role.",
        flags: [
          {
            flags: [
              { flag: "--email <email>", summary: "Member email" },
              {
                flag: "--user-id <id>",
                summary: "User id (alternative to --email)",
              },
              {
                flag: "--role <role>",
                summary: "Role to grant: viewer, developer, admin, or owner",
              },
              ...teamSelectorFlagHelp,
              ...serverFlagHelp,
            ],
          },
        ],
        group: "auth",
        usage: "cmpatch member add --email <email> --role <role> [flags]",
      }
    ],
    parse: parseMemberAdd,
    routes: [{ path: ["member", "add"] }],
  }),
  commandSpec({
    commandName: "member invite",
    defaults: { prompt: ["email", "role"], serverUrl: true, team: "member" },
    execute: executeMemberInvite,
    kind: "member-invite",
    help: [
      {
        description: "Invite a team member by email or GitHub handle.",
        flags: [
          {
            flags: [
              { flag: "--email <email>", summary: "Invitee email" },
              {
                flag: "--github-handle <handle>",
                summary: "GitHub handle (alternative to --email)",
              },
              {
                flag: "--role <role>",
                summary: "Role granted on acceptance: viewer, developer, admin, or owner",
              },
              {
                flag: "--expires-in-days <days>",
                summary: "Invitation validity (default: 14)",
              },
              ...teamSelectorFlagHelp,
              ...serverFlagHelp,
            ],
          },
        ],
        group: "auth",
        usage: "cmpatch member invite --email <email> --role <role> [flags]",
      }
    ],
    parse: parseMemberInvite,
    routes: [{ path: ["member", "invite"] }],
  }),
  commandSpec({
    commandName: "member provision",
    defaults: { prompt: ["email", "role"], serverUrl: true, team: "member" },
    execute: executeMemberProvision,
    kind: "member-provision",
    help: [
      {
        description:
          "Provision a teammate account and personal access token, then add them to a team. Prints a one-time token to hand off (token-mode self-host).",
        flags: [
          {
            flags: [
              { flag: "--email <email>", summary: "Teammate email" },
              {
                flag: "--role <role>",
                summary: "Role to grant: viewer, developer, admin, or owner",
              },
              {
                flag: "--display-name <name>",
                summary: "Display name for the new account",
              },
              {
                flag: "--token-display-name <name>",
                summary: "Display name for the handed-off token",
              },
              {
                flag: "--expires-in-days <days>",
                summary: "Token validity (default: 90)",
              },
              ...teamSelectorFlagHelp,
              ...serverFlagHelp,
            ],
          },
        ],
        group: "auth",
        usage: "cmpatch member provision --email <email> --role <role> [flags]",
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
        flags: [
          {
            flags: [
              {
                flag: "--status <status>",
                summary: "Filter: pending, accepted, revoked, expired, or all",
              },
              flagHelp.format,
              ...teamSelectorFlagHelp,
              ...serverFlagHelp,
            ],
          },
        ],
        group: "auth",
        usage: "cmpatch member invite-list [flags]",
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
        flags: [
          {
            flags: [
              {
                flag: "--invitation-id <id>",
                summary: "Invitation to revoke (see member invite-list)",
              },
              ...serverFlagHelp,
            ],
          },
        ],
        group: "auth",
        usage: "cmpatch member invite-revoke --invitation-id <id> [flags]",
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
        flags: [
          { flags: [...teamSelectorFlagHelp, flagHelp.format, ...serverFlagHelp] },
        ],
        group: "auth",
        usage: "cmpatch member list [flags]",
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
    // `role` is promptable too: the parser demands the role before the member
    // selector, so leaving it out would make the declared email prompt
    // unreachable for the bare invocation.
    defaults: { prompt: ["email", "role"], serverUrl: true, team: "member" },
    execute: executeMemberRemove,
    kind: "member-remove",
    help: [
      {
        description: "Remove a team role binding.",
        flags: [
          {
            flags: [
              { flag: "--email <email>", summary: "Member email" },
              {
                flag: "--user-id <id>",
                summary: "User id (alternative to --email)",
              },
              {
                flag: "--role <role>",
                summary: "Role of the binding to remove",
              },
              {
                flag: "--binding-id <id>",
                summary: "Binding id (alternative to member plus --role)",
              },
              ...teamSelectorFlagHelp,
              ...serverFlagHelp,
            ],
          },
        ],
        group: "auth",
        usage: "cmpatch member remove --email <email> --role <role> [flags]",
      }
    ],
    parse: parseMemberRemove,
    routes: [{ path: ["member", "remove"] }],
  }),
  commandSpec({
    commandName: "member update",
    defaults: { prompt: ["email", "fromRole", "role"], serverUrl: true, team: "member" },
    execute: executeMemberUpdate,
    kind: "member-update",
    help: [
      {
        description: "Change a team member's role.",
        flags: [
          {
            flags: [
              { flag: "--email <email>", summary: "Member email" },
              {
                flag: "--user-id <id>",
                summary: "User id (alternative to --email)",
              },
              {
                flag: "--role <role>",
                summary: "New role: viewer, developer, admin, or owner",
              },
              {
                flag: "--from-role <role>",
                summary: "Current role, when the member has several",
              },
              {
                flag: "--binding-id <id>",
                summary: "Binding id (alternative to member selectors)",
              },
              ...teamSelectorFlagHelp,
              ...serverFlagHelp,
            ],
          },
        ],
        group: "auth",
        usage: "cmpatch member update --email <email> --role <role> [flags]",
      }
    ],
    parse: parseMemberUpdate,
    routes: [{ path: ["member", "update"] }],
  }),
  commandSpec({
    commandName: "release create",
    view: {
      kind: "action",
      summarize: (result, command) => summarizeRelease(result, command),
    },
    defaults: { prompt: ["bundlePath"], deployment: "release", platform: true, serverUrl: true, team: "app-selector", app: "release" },
    execute: executeReleaseCreate,
    kind: "release-create",
    help: [
      {
        description: "Upload a prebuilt bundle or .cmpatch.",
        examples: [
          "cmpatch release create --bundle-path MyApp.cmpatch --deployment Staging",
          "cmpatch release create --bundle-path build/ --target-binary-version 1.2.3",
        ],
        flags: [
          {
            flags: [
              {
                flag: "--bundle-path <path>",
                summary: "Bundle directory, zip, or prebuilt .cmpatch artifact",
              },
              ...deploymentSelectorFlagHelp,
              ...serverFlagHelp,
            ],
          },
          {
            flags: [
              {
                flag: flagHelp.targetBinaryVersion.flag,
                summary: "Binary version(s) the release targets, e.g. 1.2.3",
              },
              flagHelp.platform,
              flagHelp.projectRoot,
              {
                flag: "--fingerprint <hash>",
                summary: "Native fingerprint (alternative to --platform)",
              },
              { flag: "--sourcemap <path>", summary: "Upload this sourcemap" },
              flagHelp.privateKeyPath,
            ],
            title: "Bundle flags (not for .cmpatch input)",
          },
          {
            flags: [
              flagHelp.releaseNotes,
              flagHelp.rolloutPercentage,
              flagHelp.mandatory,
              flagHelp.disabled,
              flagHelp.dryRun,
              flagHelp.noDuplicateReleaseError,
              flagHelp.allowFingerprintMismatch,
              flagHelp.yes,
              flagHelp.nonInteractive,
            ],
            title: "Release flags",
          },
        ],
        group: "release",
        usage: "cmpatch release create --bundle-path <path> [flags]",
      }
    ],
    parse: parseReleaseCreate,
    responseWarnings: true,
    routes: [{ path: ["release", "create"] }],
  }),
  commandSpec({
    commandName: "release inspect",
    defaults: { prompt: ["label"], deployment: "release", serverUrl: true, team: "app-selector", app: "release" },
    execute: executeReleaseInspect,
    kind: "release-inspect",
    help: [
      {
        description: "Inspect release processing status.",
        flags: [
          {
            flags: [
              ...releaseSelectorFlagHelp,
              { flag: "--wait", summary: "Wait until processing finishes" },
              {
                flag: "--timeout <seconds>",
                summary: "Give up on --wait after this long",
              },
              flagHelp.format,
              ...serverFlagHelp,
            ],
          },
        ],
        group: "release",
        usage: "cmpatch release inspect --label <label> [flags]",
      }
    ],
    parse: parseReleaseInspect,
    renderTable: renderReleaseInspectTable,
    routes: [{ path: ["release", "inspect"] }],
  }),
  commandSpec({
    aliases: ["release disable", "release enable"],
    commandName: "release patch",
    defaults: { prompt: ["app", "deployment", "label"], serverUrl: true, team: "app-selector-explicit" },
    execute: executeReleasePatch,
    kind: "release-patch",
    help: [
      {
        description: "Update release metadata.",
        flags: [
          {
            flags: [
              ...releaseSelectorFlagHelp,
              flagHelp.yes,
              flagHelp.nonInteractive,
              ...serverFlagHelp,
            ],
          },
          {
            flags: [
              flagHelp.releaseNotes,
              flagHelp.rolloutPercentage,
              flagHelp.mandatory,
              {
                flag: "--not-mandatory",
                summary: "Clear the mandatory flag",
              },
              flagHelp.targetBinaryVersion,
              {
                flag: "--status <disabled|published>",
                summary: "Disable or re-enable the release",
              },
            ],
            title: "Metadata flags",
          },
        ],
        group: "release",
        usage: "cmpatch release patch --label <label> [flags]",
      },
      {
        description: "Disable a release.",
        flags: [
          {
            flags: [
              ...releaseSelectorFlagHelp,
              flagHelp.yes,
              flagHelp.nonInteractive,
              ...serverFlagHelp,
            ],
          },
        ],
        group: "release",
        usage: "cmpatch release disable --label <label> [flags]",
      },
      {
        description: "Enable a release.",
        flags: [
          {
            flags: [
              ...releaseSelectorFlagHelp,
              flagHelp.yes,
              flagHelp.nonInteractive,
              ...serverFlagHelp,
            ],
          },
        ],
        group: "release",
        usage: "cmpatch release enable --label <label> [flags]",
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
        flags: [
          {
            flags: [
              ...deploymentSelectorFlagHelp,
              flagHelp.format,
              flagHelp.limit,
              flagHelp.offset,
              {
                flag: "--include metrics",
                summary: "Include per-release metrics",
              },
              ...serverFlagHelp,
            ],
          },
        ],
        group: "release",
        usage: "cmpatch release list --deployment <name> [flags]",
      },
      {
        description: "Show deployment release history.",
        examples: ["cmpatch deployment history --app MyApp-iOS --deployment Staging","cmpatch deployment history --deployment-id <id>"],
        flags: [
          {
            flags: [
              ...deploymentSelectorFlagHelp,
              flagHelp.limit,
              flagHelp.offset,
              ...serverFlagHelp,
            ],
          },
        ],
        group: "management",
        usage: "cmpatch deployment history --deployment <name> [flags]",
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
    defaults: { prompt: ["label"], deployment: "release", serverUrl: true, team: "app-selector", app: "release" },
    execute: executeReleaseMetrics,
    kind: "release-metrics",
    help: [
      {
        description: "Show release metrics.",
        flags: [
          {
            flags: [
              ...releaseSelectorFlagHelp,
              flagHelp.format,
              ...serverFlagHelp,
            ],
          },
        ],
        group: "release",
        usage: "cmpatch release metrics --label <label> [flags]",
      }
    ],
    parse: parseReleaseMetrics,
    renderTable: renderReleaseMetricsTable,
    routes: [{ path: ["release", "metrics"] }],
  }),
  commandSpec({
    commandName: "release promote",
    view: {
      kind: "action",
      summarize: (_result, command) =>
        "Promoted to " + deploymentLabel(command.destinationDeployment),
    },
    defaults: { prompt: ["app", "sourceDeployment", "destDeployment", "label"], serverUrl: true, team: "app-selector-explicit" },
    execute: executeReleasePromote,
    kind: "release-promote",
    help: [
      {
        description: "Promote a release to another deployment.",
        examples: [
          "cmpatch release promote --source-deployment Staging --dest-deployment Prod",
        ],
        flags: [
          {
            flags: [
              ...appSelectorFlags,
              {
                flag: "--source-deployment <name>",
                summary: "Deployment to promote from",
              },
              {
                flag: "--source-deployment-id <id>",
                summary: "Source deployment id (alternative to names)",
              },
              { flag: "--label <label>", summary: "Release to promote" },
              {
                flag: "--release-id <id>",
                summary: "Release id (alternative to source plus --label)",
              },
              {
                flag: "--dest-deployment <name>",
                summary: "Deployment to promote to",
              },
              {
                flag: "--dest-deployment-id <id>",
                summary: "Destination deployment id (alternative to names)",
              },
              ...serverFlagHelp,
            ],
          },
          {
            flags: [
              flagHelp.releaseNotes,
              flagHelp.rolloutPercentage,
              flagHelp.mandatory,
              {
                flag: "--not-mandatory",
                summary: "Clear the mandatory flag",
              },
              flagHelp.disabled,
              flagHelp.targetBinaryVersion,
              flagHelp.noDuplicateReleaseError,
              flagHelp.yes,
              flagHelp.nonInteractive,
            ],
            title: "Override flags (default: copied from the source release)",
          },
        ],
        group: "release",
        usage: "cmpatch release promote [flags]",
      }
    ],
    parse: parseReleasePromote,
    responseWarnings: true,
    routes: [{ path: ["release", "promote"] }],
  }),
  commandSpec({
    commandName: "release rollback",
    view: {
      kind: "action",
      summarize: (_result, command) =>
        "Rolled back " + deploymentLabel(command.deployment),
    },
    defaults: { prompt: ["app", "deployment"], serverUrl: true, team: "app-selector-explicit" },
    execute: executeReleaseRollback,
    kind: "release-rollback",
    help: [
      {
        description: "Roll back a deployment.",
        flags: [
          {
            flags: [
              ...deploymentSelectorFlagHelp,
              {
                flag: "--label <label>",
                summary: "Roll back to this release (default: the previous one)",
              },
              flagHelp.yes,
              flagHelp.nonInteractive,
              ...serverFlagHelp,
            ],
          },
        ],
        group: "release",
        usage: "cmpatch release rollback --deployment <name> [flags]",
      }
    ],
    parse: parseReleaseRollback,
    responseWarnings: true,
    routes: [{ path: ["release", "rollback"] }],
  }),
  commandSpec({
    commandName: "release show",
    view: {
      fields: [
        // Field names are the server wire format (toReleaseWire), which is
        // snake_case throughout.
        ["Label", "release.release_label"],
        ["Status", "release.status"],
        ["Target version", "release.target_binary_version"],
        ["Rollout", "release.rollout_percentage"],
        ["Mandatory", "release.is_mandatory"],
        ["Release ID", "release.id"],
      ],
      kind: "object",
    },
    defaults: { prompt: ["label"], deployment: "release", serverUrl: true, team: "app-selector", app: "release" },
    execute: executeReleaseShow,
    kind: "release-show",
    help: [
      {
        description: "Show release details.",
        flags: [{ flags: [...releaseSelectorFlagHelp, ...serverFlagHelp] }],
        group: "release",
        usage: "cmpatch release show --label <label> [flags]",
      }
    ],
    parse: parseReleaseShow,
    routes: [{ path: ["release", "show"] }],
  }),
  commandSpec({
    commandName: "release-react",
    view: {
      kind: "action",
      summarize: (result, command) => summarizeRelease(result, command),
    },
    defaults: { bundler: true, deployment: "release-react", platform: true, serverUrl: true, team: "app-selector", app: "release-react" },
    execute: executeReleaseReact,
    kind: "release-react",
    help: [
      {
        description: "Build a React Native bundle and upload it.",
        examples: [
          "cmpatch release-react --deployment Staging --dry-run",
          "cmpatch release-react --deployment Staging --platform ios",
          "cmpatch release-react --deployment Production --mandatory",
        ],
        flags: [
          {
            flags: [
              ...deploymentSelectorFlagHelp,
              flagHelp.platform,
              {
                flag: flagHelp.targetBinaryVersion.flag,
                summary: "Targeted binary version (default: read from the native project)",
              },
              flagHelp.projectRoot,
              ...serverFlagHelp,
            ],
          },
          {
            flags: [
              {
                flag: "--bundler <auto|metro|expo>",
                summary: "Bundler to run (default: detect from the project)",
              },
              {
                flag: "--entry-file <path>",
                summary: "JS entry file (default: detected)",
              },
              {
                flag: "--bundler-args <arg>",
                summary: "Extra argument passed to the bundler (repeatable)",
              },
              {
                flag: "--hermes <auto|true|false>",
                summary: "Compile to Hermes bytecode (metro only)",
              },
              {
                flag: "--extra-hermes-flag <flag>",
                summary: "Extra hermesc argument (metro only, repeatable)",
              },
              {
                flag: "--base-bytecode <auto|off>",
                summary: "Fetch base bytecode for smaller Hermes patches",
              },
              {
                flag: "--sourcemap-output <path>",
                summary: "Also write the sourcemap here",
              },
            ],
            title: "Bundler flags",
          },
          {
            flags: [
              {
                flag: "--plist-file <path>",
                summary: "Info.plist to read the iOS version from",
              },
              {
                flag: "--plist-file-prefix <prefix>",
                summary: "Prefix for the default Info.plist filename",
              },
              {
                flag: "--gradle-file <path>",
                summary: "build.gradle to read the Android version from",
              },
              {
                flag: "--xcode-project-file <path>",
                summary: "Xcode project to read build settings from",
              },
              {
                flag: "--xcode-target-name <name>",
                summary: "Xcode target to read (default: the app target)",
              },
              {
                flag: "--build-configuration-name <name>",
                summary: "Xcode build configuration (default: Release)",
              },
            ],
            title: "Version detection flags (when --target-binary-version is omitted)",
          },
          {
            flags: [
              flagHelp.releaseNotes,
              flagHelp.rolloutPercentage,
              flagHelp.mandatory,
              flagHelp.disabled,
              flagHelp.privateKeyPath,
              flagHelp.dryRun,
              flagHelp.noDuplicateReleaseError,
              flagHelp.allowFingerprintMismatch,
              flagHelp.yes,
              flagHelp.nonInteractive,
            ],
            title: "Release flags",
          },
        ],
        group: "release",
        usage: "cmpatch release-react --deployment <name> [flags]",
      }
    ],
    parse: parseReleaseReact,
    responseWarnings: true,
    routes: [{ path: ["release-react"] }],
  }),
  commandSpec({
    commandName: "bundle",
    view: {
      kind: "action",
      summarize: (result) =>
        isRecord(result) && typeof result.outputPath === "string"
          ? { summary: "Wrote " + result.outputPath }
          : null,
    },
    defaults: { bundler: true, platform: true },
    execute: executeBundle,
    kind: "bundle",
    help: [
      {
        description: "Build a .cmpatch artifact only (no upload).",
        examples: ["cmpatch bundle --platform ios --output MyApp.cmpatch"],
        flags: [
          {
            flags: [
              flagHelp.platform,
              {
                flag: flagHelp.targetBinaryVersion.flag,
                summary: "Targeted binary version (default: read from the native project)",
              },
              {
                flag: "--output <file.cmpatch>",
                summary: "Where to write the artifact",
              },
              flagHelp.projectRoot,
            ],
          },
          {
            flags: [
              {
                flag: "--bundler <auto|metro|expo>",
                summary: "Bundler to run (default: detect from the project)",
              },
              {
                flag: "--entry-file <path>",
                summary: "JS entry file (default: detected)",
              },
              {
                flag: "--hermes <auto|true|false>",
                summary: "Compile to Hermes bytecode (metro only)",
              },
              {
                flag: "--extra-hermes-flag <flag>",
                summary: "Extra hermesc argument (metro only, repeatable)",
              },
              {
                flag: "--base-bytecode <auto|off>",
                summary: "Fetch base bytecode for smaller Hermes patches",
              },
              {
                flag: "--sourcemap-output <path>",
                summary: "Also write the sourcemap here",
              },
              flagHelp.privateKeyPath,
            ],
            title: "Bundler flags",
          },
          {
            flags: [
              flagHelp.releaseNotes,
              flagHelp.rolloutPercentage,
              flagHelp.mandatory,
              flagHelp.disabled,
              flagHelp.noDuplicateReleaseError,
            ],
            title: "Release flags (stored in the artifact for release create)",
          },
        ],
        group: "release",
        usage: "cmpatch bundle --platform <ios|android> [flags]",
      },
    ],
    parse: parseBundle,
    routes: [{ path: ["bundle"] }],
  }),
  commandSpec({
    commandName: "token create",
    defaults: { prompt: ["name"], serverUrl: true },
    execute: executeTokenCreate,
    kind: "token-create",
    help: [
      {
        description: "Create a personal access token.",
        flags: [
          {
            flags: [
              { flag: "--name <name>", summary: "Display name for the token" },
              {
                flag: "--expires-in-days <days>",
                summary: "Token validity",
              },
              ...serverFlagHelp,
            ],
          },
        ],
        group: "auth",
        usage: "cmpatch token create --name <name> [flags]",
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
        flags: [{ flags: [...serverFlagHelp] }],
        group: "auth",
        usage: "cmpatch token list [flags]",
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
        flags: [
          {
            flags: [
              {
                flag: "--token-id <id>",
                summary: "Token to revoke (see token list)",
              },
              ...serverFlagHelp,
            ],
          },
        ],
        group: "auth",
        usage: "cmpatch token revoke --token-id <id> [flags]",
      }
    ],
    parse: parseTokenRevoke,
    routes: [{ path: ["token", "revoke"] }],
  }),
  commandSpec({
    commandName: "whoami",
    view: {
      fields: [
        ["Email", "user.email"],
        ["Name", "user.display_name"],
        ["User ID", "user.id"],
      ],
      kind: "object",
    },
    defaults: { serverUrl: true },
    execute: executeWhoami,
    kind: "whoami",
    help: [
      {
        description: "Show the authenticated user.",
        flags: [{ flags: [...serverFlagHelp] }],
        group: "auth",
        usage: "cmpatch whoami [flags]",
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
  palette: Palette = PLAIN_PALETTE,
): string | null {
  if (
    command.kind === "help" ||
    command.kind === "version" ||
    command.kind === "not-implemented"
  ) {
    return null;
  }

  const spec = commandSpecsByKind.get(command.kind);
  return spec?.renderTable?.(result, command, palette) ?? null;
}

/**
 * The delete commands answer with { deleted, id, resource }; anything else
 * means the server changed its contract, and the labelled record is a safer
 * thing to show than a sentence asserting something that may not be true.
 */
function summarizeDeletion(result: unknown): string | null {
  if (!isRecord(result) || result.deleted !== true) {
    return null;
  }

  const resource = typeof result.resource === "string" ? result.resource : "resource";
  const id = typeof result.id === "string" ? result.id : "";

  return `Deleted ${resource}${id.length === 0 ? "" : ` ${id}`}`;
}

/**
 * What the user called the deployment, falling back to the id they passed. The
 * name is what they typed and what they will recognise; the id is ours.
 */
function deploymentLabel(selector: DeploymentSelector): string {
  return selector.deploymentName ?? selector.deploymentId;
}

/**
 * The selector spelled back as flags, so a suggested command actually runs.
 * A deployment name alone is not a selector — the API scopes deployments to an
 * app — and suggesting "--deployment Staging" on its own sends the user
 * straight into a usage error.
 */
function deploymentSelectorFlags(selector: DeploymentSelector): string {
  if (selector.deploymentId !== undefined) {
    return renderCommand(["--deployment-id", selector.deploymentId]);
  }

  // Names come from the server and land in a line the user is invited to copy,
  // so every one of them is quoted rather than concatenated.
  return renderCommand([
    ...(selector.appId !== undefined
      ? ["--app-id", selector.appId]
      : [
          ...(selector.teamName === undefined
            ? []
            : ["--team", selector.teamName]),
          "--app",
          selector.appName,
        ]),
    "--deployment",
    selector.deploymentName,
  ]);
}

/**
 * An action says what changed and points at the command that shows the rest.
 * Release ids and job ids are deliberately absent: they are our identifiers,
 * they are not what the user asked about, and `--format json` still carries
 * them for anything that needs to script on them.
 */
function summarizeRelease(
  result: unknown,
  command: {
    deployment: DeploymentSelector;
    dryRun?: boolean;
    platform?: string;
  },
): ActionSummary {
  const target = deploymentLabel(command.deployment);
  // A release created from a prebuilt artifact carries its platform in the
  // artifact, not on the command line.
  const where =
    command.platform === undefined ? target : target + " (" + command.platform + ")";

  if (command.dryRun === true || (isRecord(result) && result.dryRun === true)) {
    return {
      summary: "Dry run complete for " + where + ". Nothing was uploaded.",
    };
  }

  // `release show` requires --label, so the hint must carry the label of the
  // release just created — the response has it. Without one (an older server,
  // an unexpected shape) fall back to `release list`, which the selector flags
  // alone can run; a hint the user cannot paste is worse than a broader one.
  const label = createdReleaseLabel(result);
  const selector = deploymentSelectorFlags(command.deployment);

  return {
    hint:
      label === undefined
        ? "Run `cmpatch release list " + selector + "` for details."
        : "Run `cmpatch release show " +
          selector +
          " " +
          renderCommand(["--label", label]) +
          "` for details.",
    summary: "Released to " + where,
  };
}

function createdReleaseLabel(result: unknown): string | undefined {
  if (!isRecord(result) || !isRecord(result.release)) {
    return undefined;
  }

  const label = result.release.release_label;
  return typeof label === "string" && label.length > 0 ? label : undefined;
}
export function getCommandView(command: CliCommand): CommandView<never> | null {
  if (
    command.kind === "help" ||
    command.kind === "version" ||
    command.kind === "not-implemented"
  ) {
    return null;
  }

  return commandSpecsByKind.get(command.kind)?.view ?? null;
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
    ...(spec.view !== undefined
      ? { view: spec.view as CommandView<never> }
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
  const lines = [renderRow(headers), ...rows.map(renderRow)];

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
