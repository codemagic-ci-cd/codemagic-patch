// What a command is, to the parser, the help text and the runner alike. cmpatch
// describes its commands three times over (commandSpecs.ts, commandParsers.ts,
// commandTypes.ts — some 8,000 lines); here one definition per command carries its
// flags, their help and its behaviour, and help, parsing and dispatch are all read
// off the same list (registry.ts), so none of them can name a flag the others lack.

import { resolveServerUrl } from "./api";
import type { ApiTarget } from "./authenticatedRequest";
import type { CliDeps } from "./deps";
import { UsageError } from "./errors";
import type { OutputFormat } from "./output";
import type {
  AppSelector,
  DeploymentSelector,
  ReleaseSelector,
} from "./resolveNames";

export interface FlagSpec {
  help: string;
  name: string;
  short?: string;
  type: "boolean" | "string";
  /** Placeholder shown in help for a string flag: `--name <value>`. */
  value?: string;
}

export type FlagValues = Record<string, boolean | string | undefined>;

export interface Column {
  header: string;
  /** Dotted path into a row, e.g. `metrics.active`. */
  path: string;
}

export type CommandOutput =
  | {
      columns: readonly Column[];
      /** Said instead of an empty table. */
      empty: string;
      footer?: string;
      json: unknown;
      kind: "list";
      rows: ReadonlyArray<Record<string, unknown>>;
    }
  | {
      /** Labelled fields, in order; everything else in `record` follows them. */
      fields: ReadonlyArray<readonly [label: string, path: string]>;
      json: unknown;
      kind: "record";
      record: unknown;
      /** A line above the fields, for a record that needs saying what it is. */
      title?: string;
    }
  | {
      details?: readonly string[];
      json: unknown;
      kind: "action";
      summary: string;
    };

export interface CommandDefinition {
  flags: readonly FlagSpec[];
  /** Longer explanation printed under the usage line of `<command> --help`. */
  notes?: readonly string[];
  path: readonly string[];
  /**
   * Runs the command. Returning an output hands presentation (text or JSON) to
   * the runner; the three commands that predate this structure print for
   * themselves and return nothing.
   */
  run: (values: FlagValues, deps: CliDeps) => Promise<CommandOutput | void>;
  summary: string;
  /** The flags part of the usage line, e.g. `--name <name> [flags]`. */
  usage: string;
}

// ---------------------------------------------------------------------------
// Flag groups. Names are cmpatch's wherever cmpatch has the flag.
// ---------------------------------------------------------------------------

export const CONNECTION_FLAGS: readonly FlagSpec[] = [
  {
    help: "Patch server URL (default: $CODEMAGIC_PATCH_SERVER_URL, then the default of `config set`)",
    name: "server-url",
    type: "string",
    value: "url",
  },
  {
    help: "Access token for this run (default: $CODEMAGIC_PATCH_TOKEN, then the stored sign-in)",
    name: "token",
    type: "string",
    value: "token",
  },
];

export const FORMAT_FLAG: FlagSpec = {
  help: "Output format: text (default) or json. json never prompts",
  name: "format",
  type: "string",
  value: "text|json",
};

export const YES_FLAG: FlagSpec = {
  help: "Skip the confirmation prompt (required when not on a terminal)",
  name: "yes",
  short: "y",
  type: "boolean",
};

export const TEAM_FLAG: FlagSpec = {
  help: "Team, by name or id; only needed when the account can see more than one",
  name: "team",
  type: "string",
  value: "name or id",
};

export const APP_SELECTOR_FLAGS: readonly FlagSpec[] = [
  { help: "App, by name", name: "app", type: "string", value: "name" },
  { help: "App, by id (instead of --app)", name: "app-id", type: "string", value: "id" },
  TEAM_FLAG,
];

export const DEPLOYMENT_SELECTOR_FLAGS: readonly FlagSpec[] = [
  ...APP_SELECTOR_FLAGS,
  {
    help: "Deployment of that app, by name, e.g. Staging or Production",
    name: "deployment",
    type: "string",
    value: "name",
  },
  {
    help: "Deployment by id (instead of --app/--app-id with --deployment)",
    name: "deployment-id",
    type: "string",
    value: "id",
  },
];

export const RELEASE_SELECTOR_FLAGS: readonly FlagSpec[] = [
  ...DEPLOYMENT_SELECTOR_FLAGS,
  { help: "Release of that deployment, by label, e.g. v12", name: "label", type: "string", value: "label" },
  {
    help: "Release by id (instead of a deployment with --label)",
    name: "release-id",
    type: "string",
    value: "id",
  },
];

export const PAGINATION_FLAGS: readonly FlagSpec[] = [
  { help: "Rows per page, 1-100 (default: 50)", name: "limit", type: "string", value: "n" },
  { help: "Rows to skip (default: 0)", name: "offset", type: "string", value: "n" },
];

// ---------------------------------------------------------------------------
// Reading flag values
// ---------------------------------------------------------------------------

/** Which server, and the `--token` flag if one was given (see authenticatedRequest.ts). */
export function readApiTarget(values: FlagValues, deps: CliDeps): ApiTarget {
  const token = readString(values, "token");

  return {
    serverUrl: resolveServerUrl(readString(values, "server-url"), deps.env),
    ...(token !== undefined ? { token } : {}),
  };
}

export function readString(values: FlagValues, name: string): string | undefined {
  const value = values[name];
  if (value === undefined || typeof value === "boolean") {
    return undefined;
  }

  // A flag that was given must say something: `--token=` falling back to the
  // environment, or `--app ""` to "no app", would hide the mistake.
  if (value.trim().length === 0) {
    throw new UsageError(`--${name} must not be empty.`);
  }

  return value;
}

export function requireString(values: FlagValues, name: string): string {
  const value = readString(values, name);
  if (value === undefined) {
    throw new UsageError(`Missing required flag --${name}`);
  }

  return value;
}

export function readBoolean(values: FlagValues, name: string): boolean {
  return values[name] === true;
}

export function readFormat(values: FlagValues): OutputFormat {
  const value = readString(values, "format");
  if (value === undefined) {
    return "text";
  }

  if (value !== "json" && value !== "text") {
    throw new UsageError(`--format must be "text" or "json" (got "${value}").`);
  }

  return value;
}

export function readInteger(
  values: FlagValues,
  name: string,
  range: { max?: number; min: number },
): number | undefined {
  const value = readString(values, name);
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(parsed) ||
    parsed < range.min ||
    (range.max !== undefined && parsed > range.max)
  ) {
    const bounds =
      range.max === undefined
        ? `an integer of at least ${range.min}`
        : `an integer from ${range.min} to ${range.max}`;
    throw new UsageError(`--${name} must be ${bounds} (got "${value}").`);
  }

  return parsed;
}

/** `--limit` / `--offset`, within the bounds the server's own query parser enforces. */
export function readPagination(values: FlagValues): {
  limit: number | undefined;
  offset: number | undefined;
} {
  return {
    limit: readInteger(values, "limit", { max: 100, min: 1 }),
    offset: readInteger(values, "offset", { min: 0 }),
  };
}

/**
 * The note under a paged list when the server holds more rows than it returned —
 * without it a page reads as the whole, and the rows that are missing as absent.
 */
export function paginationFooter(
  result: unknown,
  shown: number,
  noun: string,
): { footer?: string } {
  const pagination =
    typeof result === "object" && result !== null && "pagination" in result
      ? (result as { pagination?: { total?: unknown } }).pagination
      : undefined;
  const total = typeof pagination?.total === "number" ? pagination.total : shown;

  return total > shown
    ? { footer: `${shown} of ${total} ${noun} — page with --limit and --offset.` }
    : {};
}

/** What a removal prints: its endpoint answers with no body worth showing. */
export function deletedOutput(resource: string, id: string, summary: string): CommandOutput {
  return { json: { deleted: true, id, resource }, kind: "action", summary };
}

/** `--mandatory` → true, `--not-mandatory` → false, neither → undefined (leave as is). */
export function readMandatory(values: FlagValues): boolean | undefined {
  if (readBoolean(values, "mandatory") && readBoolean(values, "not-mandatory")) {
    throw new UsageError("--mandatory and --not-mandatory cannot be combined.");
  }

  if (readBoolean(values, "mandatory")) {
    return true;
  }

  return readBoolean(values, "not-mandatory") ? false : undefined;
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export function readAppSelector(values: FlagValues): AppSelector {
  const appId = readString(values, "app-id");
  const app = readString(values, "app");
  const team = readString(values, "team");

  if (appId !== undefined) {
    const conflicting = app !== undefined ? "app" : team !== undefined ? "team" : undefined;
    if (conflicting !== undefined) {
      throw new UsageError(
        `--app-id already identifies the app; it cannot be combined with --${conflicting}.`,
      );
    }

    return { appId };
  }

  if (app === undefined) {
    throw new UsageError("Missing the app. Pass --app <name> or --app-id <id>.");
  }

  return { app, ...(team !== undefined ? { team } : {}) };
}

export function readDeploymentSelector(
  values: FlagValues,
  flags: { deployment: string; deploymentId: string } = {
    deployment: "deployment",
    deploymentId: "deployment-id",
  },
): DeploymentSelector {
  const deploymentId = readString(values, flags.deploymentId);

  if (deploymentId !== undefined) {
    // With promote's --source-*/--dest-* pairs, --app may belong to the other side.
    const shared = flags.deployment === "deployment" ? ["app", "app-id", "team"] : [];
    const conflicting = [...shared, flags.deployment].find(
      (name) => values[name] !== undefined,
    );
    if (conflicting !== undefined) {
      throw new UsageError(
        `--${flags.deploymentId} already identifies the deployment; it cannot be combined with --${conflicting}.`,
      );
    }

    return { deploymentId };
  }

  const deployment = readString(values, flags.deployment);
  if (
    deployment === undefined ||
    (values.app === undefined && values["app-id"] === undefined)
  ) {
    throw new UsageError(
      `Missing the deployment. Pass --app <name> (or --app-id <id>) with --${flags.deployment} <name>, or --${flags.deploymentId} <id>.`,
    );
  }

  return { app: readAppSelector(values), deployment };
}

export function readReleaseSelector(
  values: FlagValues,
  deploymentFlags?: { deployment: string; deploymentId: string },
): ReleaseSelector {
  const releaseId = readString(values, "release-id");

  if (releaseId !== undefined) {
    // As above: promote's --app may be there for the destination.
    const shared = deploymentFlags === undefined ? ["app", "app-id", "team"] : [];
    const conflicting = [
      ...shared,
      deploymentFlags?.deployment ?? "deployment",
      deploymentFlags?.deploymentId ?? "deployment-id",
      "label",
    ].find((name) => values[name] !== undefined);
    if (conflicting !== undefined) {
      throw new UsageError(
        `--release-id already identifies the release; it cannot be combined with --${conflicting}.`,
      );
    }

    return { releaseId };
  }

  const label = readString(values, "label");
  if (label === undefined) {
    throw new UsageError(
      "Missing the release. Pass --label <label> with its deployment, or --release-id <id>.",
    );
  }

  return { deployment: readDeploymentSelector(values, deploymentFlags), label };
}

/** How a selector is shown in a confirmation summary, before it has been resolved. */
export function describeSelector(
  selector: AppSelector | DeploymentSelector | ReleaseSelector,
): string {
  if ("releaseId" in selector) {
    return selector.releaseId;
  }

  if ("label" in selector) {
    return `${describeSelector(selector.deployment)}/${selector.label}`;
  }

  if ("deploymentId" in selector) {
    return selector.deploymentId;
  }

  if ("deployment" in selector) {
    return `${describeSelector(selector.app)}/${selector.deployment}`;
  }

  if ("appId" in selector) {
    return selector.appId;
  }

  return selector.team === undefined ? selector.app : `${selector.team}/${selector.app}`;
}

// ---------------------------------------------------------------------------
// Usage fragments for the selectors above
// ---------------------------------------------------------------------------

export const APP_USAGE = "(--app <name> | --app-id <id>)";
export const DEPLOYMENT_USAGE = `(${APP_USAGE} --deployment <name> | --deployment-id <id>)`;
export const RELEASE_USAGE = `(${DEPLOYMENT_USAGE} --label <label> | --release-id <id>)`;
