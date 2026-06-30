import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import {
  parseCliArgs,
  renderHelp,
} from "./cli";
import type {
  CliCommand,
  CommandDefaultFlagValues,
  ParseCliResult,
} from "./commandTypes";
import {
  executeCommandSpec,
  findCommandSpecRoute,
  getCommandSuggestionCandidates,
  isKnownCommandPrefix,
  renderCommandTable,
  type CommandDefaultPolicy,
} from "./commandSpecs";
import {
  UsageError,
  ValidationError,
  type CommandDeps,
} from "./commands/shared";
import { createInteractivePrompt, PromptAbortError } from "./prompt";
import {
  computeNativeFingerprint,
  computeNativeFingerprintDetails,
} from "./fingerprint";
import {
  exitCodeForProblemDetails,
  getProblemTypeSuffix,
  HttpProblemError,
} from "./problem-details";
import {
  isRecord,
  renderProblemDetails,
  renderGenericTable,
  selectStructuredOutputFormat,
  writeJson,
  writeLine,
  type StructuredOutputFormat,
  type WritableStream,
} from "./output";
import {
  loadCliConfig,
  loadProjectConfig,
  type CliConfig,
  type ProjectConfig,
} from "./configStore";
import { resolveEffectiveContext, resolveProjectRoot } from "./localContext";
import { getCliVersion } from "./version";

export type CliDeps = CommandDeps & {
  stderr: WritableStream;
  stdout: WritableStream;
};

function createDefaultDeps(): CliDeps {
  return {
    computeFingerprint: computeNativeFingerprint,
    computeFingerprintDetails: computeNativeFingerprintDetails,
    env: process.env,
    fetch: globalThis.fetch,
    now: () => Date.now(),
    prompt: createInteractivePrompt(process.stdin, process.stderr),
    randomUUID,
    readFile: (path) => fs.readFile(path),
    readDirectory: (path) => fs.readdir(path, { withFileTypes: true }),
    runCommand,
    sleep: (milliseconds) =>
      new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
      }),
    stat: (path) => fs.stat(path),
    stderr: process.stderr,
    stdin: process.stdin,
    streamCommand,
    stdout: process.stdout,
  };
}

function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: Record<string, string | undefined>;
  },
): Promise<{
  exitCode: number | null;
  signal: string | null;
  stderr: string;
  stdout: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      resolve({
        exitCode,
        signal,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      });
    });
  });
}

function streamCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: Record<string, string | undefined>;
    stderr: WritableStream;
    stdout: WritableStream;
  },
): Promise<{
  exitCode: number | null;
  signal: string | null;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk: Buffer) => {
      options.stdout.write(chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      options.stderr.write(chunk.toString("utf8"));
    });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      resolve({ exitCode, signal });
    });
  });
}

export async function runCli(
  argv: string[],
  depsOverrides: Partial<CliDeps> = {},
): Promise<number> {
  const deps = {
    ...createDefaultDeps(),
    ...depsOverrides,
  } satisfies CliDeps;

  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    const parsed = parseCliArgs(argv);

    if (!parsed.ok) {
      writeParseError(deps.stderr, parsed);
      return 2;
    }

    if (parsed.command.kind === "help") {
      writeLine(deps.stdout, renderHelp(parsed.command.topic));
      return 0;
    }
  }

  let parsed;
  try {
    const commandRoute = findCommandSpecRoute(argv);
    const shouldApplyDefaults =
      commandRoute?.defaults !== undefined &&
      commandRoute.defaults !== false &&
      mayNeedDefaultOptions(argv, commandRoute.defaults);
    const defaultConfig =
      shouldApplyDefaults
        ? await loadDefaultOptionsConfig(
            argv,
            deps.env,
            commandRoute?.kind === "doctor",
          )
        : null;
    const defaultFlags =
      shouldApplyDefaults
        ? resolveDefaultFlagValues(
            argv,
            deps.env,
            defaultConfig!.userConfig,
            defaultConfig!.projectConfig,
            commandRoute!.defaults as CommandDefaultPolicy,
          )
        : {};
    parsed = parseCliArgs(argv, defaultFlags);
  } catch (error) {
    writeLine(
      deps.stderr,
      error instanceof Error ? error.message : String(error),
    );
    return 1;
  }

  if (!parsed.ok) {
    writeParseError(deps.stderr, parsed);
    return 2;
  }

  const command = parsed.command;
  const explicitOutputFormat = parseExplicitOutputFormat(argv, command);

  if (!explicitOutputFormat.ok) {
    writeLine(deps.stderr, explicitOutputFormat.error);
    return 2;
  }

  const commandForExecution = withJsonNonInteractiveMode(
    command,
    explicitOutputFormat.ok ? explicitOutputFormat.format : undefined,
  );

  if (commandForExecution.kind === "help") {
    writeLine(deps.stdout, renderHelp(commandForExecution.topic));
    return 0;
  }

  if (commandForExecution.kind === "version") {
    writeLine(deps.stdout, getCliVersion());
    return 0;
  }

  if (commandForExecution.kind === "not-implemented") {
    const { argv } = commandForExecution;
    const label = isKnownCommandPrefix(argv[0])
      ? "unknown subcommand"
      : "unknown command";
    const suggestion = suggestCommand(argv);
    const tail =
      suggestion.length > 0 ? suggestion : ". Run `cmpatch help` to list commands.";
    writeLine(deps.stderr, `${label}: cmpatch ${argv.join(" ")}${tail}`);
    return 2;
  }

  try {
    const result = await executeCommandSpec(commandForExecution, deps);
    const requestedFormat =
      explicitOutputFormat.format ?? getStructuredOutputFormat(commandForExecution);

    if (typeof result === "string") {
      const output = selectStructuredOutputFormat(requestedFormat, deps.stdout);
      if (output.format === "json" && output.source === "explicit") {
        writeJson(deps.stdout, result);
      } else if (output.format === "table" && explicitOutputFormat.text !== true) {
        deps.stdout.write(renderGenericTable(result));
      } else {
        writeLine(deps.stdout, result);
      }
    } else if (result !== null) {
      const output = selectStructuredOutputFormat(
        requestedFormat,
        deps.stdout,
      );
      const table =
        output.format === "table"
          ? renderTableResult(commandForExecution, result)
          : null;
      if (table !== null) {
        deps.stdout.write(table);
      } else {
        writeJson(deps.stdout, result);
      }
    }

    return getCommandResultExitCode(result) ?? 0;
  } catch (error) {
    if (error instanceof PromptAbortError) {
      writeLine(deps.stderr, "Aborted.");
      return 130;
    }

    if (error instanceof UsageError) {
      writeLine(deps.stderr, error.message);
      return 2;
    }

    if (error instanceof ValidationError) {
      writeLine(deps.stderr, error.message);
      return 3;
    }

    if (error instanceof HttpProblemError) {
      if (explicitOutputFormat.format === "json") {
        // `--format json` is machine-readable structured output: forward the
        // full RFC 9457 body as the `error` field on stdout so CI pipelines can
        // consume server-provided detail (cli-tech-spec §Server Error Response
        // Parsing). Data goes to stdout; the exit code is unchanged.
        writeJson(deps.stdout, { error: error.problem });
        return exitCodeForProblemDetails(error.problem, error.responseStatus);
      }
      deps.stderr.write(renderProblemDetails(error.problem));
      const authHint = renderAuthenticationHint(commandForExecution, error.problem);
      if (authHint !== null) {
        writeLine(deps.stderr, authHint);
      }
      return exitCodeForProblemDetails(error.problem, error.responseStatus);
    }

    writeLine(
      deps.stderr,
      error instanceof Error ? error.message : String(error),
    );
    return 1;
  }
}

function mayNeedDefaultOptions(
  argv: string[],
  policy: CommandDefaultPolicy,
): boolean {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    return false;
  }

  if (policy.serverUrl === true && !hasOption(argv, "--server-url")) {
    return true;
  }

  if (
    mayNeedTeamDefault(argv, policy) &&
    !hasOption(argv, "--team") &&
    !hasOption(argv, "--team-id")
  ) {
    return true;
  }

  if (
    supportsAppDefault(argv, policy) &&
    !hasOption(argv, "--app") &&
    !hasOption(argv, "--app-id")
  ) {
    return true;
  }

  if (
    supportsDeploymentDefault(argv, policy) &&
    !hasOption(argv, "--deployment") &&
    !hasOption(argv, "--deployment-id")
  ) {
    return true;
  }

  if (policy.platform === true && !hasOption(argv, "--platform")) {
    return true;
  }

  return policy.bundler === true && !hasOption(argv, "--bundler");
}

function getStructuredOutputFormat(
  command: CliCommand,
): StructuredOutputFormat | undefined {
  if (!("format" in command)) {
    return undefined;
  }

  return command.format === "json" || command.format === "table"
    ? command.format
    : undefined;
}

function parseExplicitOutputFormat(
  argv: string[],
  command: CliCommand,
):
  | { format?: StructuredOutputFormat; ok: true; text?: true }
  | { error: string; ok: false } {
  const format = readRawFormatFlag(argv);

  if (format === undefined) {
    return { ok: true };
  }

  if (format === "json" || format === "table") {
    return { format, ok: true };
  }

  if (format === "text" && command.kind === "fingerprint") {
    return { ok: true, text: true };
  }

  return {
    error:
      command.kind === "fingerprint"
        ? "--format must be either text, json, or table"
        : "--format must be either json or table",
    ok: false,
  };
}

function writeParseError(
  stderr: WritableStream,
  error: Extract<ParseCliResult, { ok: false }>,
): void {
  writeLine(
    stderr,
    error.error.startsWith("Error:") ? error.error : `Error: ${error.error}`,
  );

  if (error.suggestion !== undefined) {
    writeLine(stderr, "");
    writeLine(stderr, error.suggestion);
  }

  if (error.examples !== undefined && error.examples.length > 0) {
    writeLine(stderr, "");
    writeLine(stderr, "Try:");
    for (const example of error.examples) {
      writeLine(stderr, `  ${example}`);
    }
  }

  if (!error.showHelp) {
    return;
  }

  writeLine(stderr, "");
  if (error.helpTopic !== undefined) {
    writeLine(stderr, `Run \`cmpatch help ${error.helpTopic}\` for usage.`);
  } else {
    writeLine(stderr, renderHelp());
  }
}

function readRawFormatFlag(argv: string[]): string | undefined {
  let format: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--format") {
      const rawValue = argv[index + 1];
      if (rawValue !== undefined && !rawValue.startsWith("--")) {
        format = rawValue;
      }
      index += 1;
      continue;
    }

    if (token.startsWith("--format=")) {
      format = token.slice("--format=".length);
    }
  }

  return format;
}

function suggestCommand(argv: string[]): string {
  const requested = argv.join(" ");
  const candidates = getCommandSuggestionCandidates();
  const match =
    candidates.find((candidate) => candidate.startsWith(requested)) ??
    candidates.find((candidate) => candidate.split(" ")[0] === argv[0]);

  return match === undefined ? "" : `. Did you mean \`cmpatch ${match}\`?`;
}

function renderTableResult(command: CliCommand, result: unknown): string | null {
  return renderCommandTable(command, result) ?? renderGenericTable(result);
}

function getCommandResultExitCode(result: unknown): number | null {
  if (
    isRecord(result) &&
    result.command === "doctor" &&
    (result.exitCode === 0 || result.exitCode === 1)
  ) {
    return result.exitCode;
  }

  return null;
}

function withJsonNonInteractiveMode(
  command: CliCommand,
  format: StructuredOutputFormat | undefined,
): CliCommand {
  if (format !== "json" || !("nonInteractive" in command)) {
    return command;
  }

  return {
    ...command,
    nonInteractive: true,
  };
}

function renderAuthenticationHint(
  command: CliCommand,
  problem: { type?: unknown },
): string | null {
  if (
    getProblemTypeSuffix(problem.type) !== "authentication-required" ||
    !("serverUrl" in command) ||
    typeof command.serverUrl !== "string"
  ) {
    return null;
  }

  return [
    `Authentication required for ${command.serverUrl}.`,
    `Run \`cmpatch login --server-url ${command.serverUrl}\` or pass --token/CODEMAGIC_PATCH_TOKEN.`,
  ].join("\n");
}

function resolveDefaultFlagValues(
  argv: string[],
  env: Record<string, string | undefined>,
  userConfig: CliConfig,
  projectConfig: ProjectConfig,
  policy: CommandDefaultPolicy,
): CommandDefaultFlagValues {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    return {};
  }

  const defaults: CommandDefaultFlagValues = {};
  const context = resolveEffectiveContext(
    env,
    userConfig,
    projectConfig,
    resolveProjectRoot(argv),
    { platform: readOptionValue(argv, "--platform") },
  );
  const serverUrl = context.serverUrl?.value;
  if (
    serverUrl !== undefined &&
    policy.serverUrl === true &&
    !hasOption(argv, "--server-url")
  ) {
    defaults.serverUrl = serverUrl;
  }

  if (
    supportsTeamDefault(argv, policy, projectConfig) &&
    !hasOption(argv, "--team") &&
    !hasOption(argv, "--team-id")
  ) {
    const teamId = context.teamId?.value;
    const team = context.team?.value;

    if (teamId !== undefined) {
      defaults.teamId = teamId;
    } else if (team !== undefined) {
      defaults.team = team;
    }
  }

  if (
    supportsAppDefault(argv, policy) &&
    !hasOption(argv, "--app") &&
    !hasOption(argv, "--app-id")
  ) {
    const app = context.app?.value;

    if (app !== undefined) {
      defaults.app = app;
    }
  }

  if (
    supportsDeploymentDefault(argv, policy) &&
    !hasOption(argv, "--deployment") &&
    !hasOption(argv, "--deployment-id")
  ) {
    const deployment = context.deployment?.value;

    if (deployment !== undefined) {
      defaults.deployment = deployment;
    }
  }

  if (policy.platform === true && !hasOption(argv, "--platform")) {
    const platform = context.platform?.value;

    if (platform !== undefined) {
      defaults.platform = platform;
    }
  }

  if (policy.bundler === true && !hasOption(argv, "--bundler")) {
    const bundler = context.bundler?.value;

    if (bundler !== undefined) {
      defaults.bundler = bundler;
    }
  }

  return defaults;
}

async function loadDefaultOptionsConfig(
  argv: string[],
  env: Record<string, string | undefined>,
  tolerateErrors: boolean,
): Promise<{
  projectConfig: ProjectConfig;
  userConfig: CliConfig;
}> {
  let userConfig: CliConfig;
  let projectConfig: ProjectConfig;

  try {
    userConfig = await loadCliConfig({ env });
  } catch (error) {
    if (!tolerateErrors) {
      throw error;
    }
    userConfig = {};
  }

  try {
    projectConfig = await loadProjectConfig(resolveProjectRoot(argv));
  } catch (error) {
    if (!tolerateErrors) {
      throw error;
    }
    projectConfig = {};
  }

  return {
    projectConfig,
    userConfig,
  };
}

function supportsTeamDefault(
  argv: string[],
  policy: CommandDefaultPolicy,
  projectConfig: ProjectConfig,
): boolean {
  switch (policy.team) {
    case "always":
      return true;
    case "app-selector":
      return supportsAppSelectorTeamDefault(argv, policy, projectConfig);
    case "app-selector-explicit":
      return supportsExplicitAppSelectorTeamDefault(argv);
    case "doctor":
      return !hasOption(argv, "--app-id") && !hasOption(argv, "--deployment-id");
    case "member":
      return !hasOption(argv, "--binding-id");
    case undefined:
      return false;
  }
}

function mayNeedTeamDefault(
  argv: string[],
  policy: CommandDefaultPolicy,
): boolean {
  switch (policy.team) {
    case "always":
      return true;
    case "app-selector":
      return (
        hasOption(argv, "--app") ||
        (supportsAppDefault(argv, policy) && !hasOption(argv, "--app-id"))
      );
    case "app-selector-explicit":
      return supportsExplicitAppSelectorTeamDefault(argv);
    case "doctor":
      return !hasOption(argv, "--app-id") && !hasOption(argv, "--deployment-id");
    case "member":
      return !hasOption(argv, "--binding-id");
    case undefined:
      return false;
  }
}

function supportsAppDefault(
  argv: string[],
  policy: CommandDefaultPolicy,
): boolean {
  switch (policy.app) {
    case "app-show":
      return true;
    case "deployment":
    case "release-react":
      return !hasOption(argv, "--deployment-id");
    case "doctor":
      return !hasOption(argv, "--app-id") && !hasOption(argv, "--deployment-id");
    case "release":
      return !hasOption(argv, "--deployment-id") && !hasOption(argv, "--release-id");
    case undefined:
      return false;
  }
}

function supportsDeploymentDefault(
  argv: string[],
  policy: CommandDefaultPolicy,
): boolean {
  switch (policy.deployment) {
    case "deployment-history":
    case "doctor":
    case "release-react":
      return true;
    case "release":
      return !hasOption(argv, "--release-id");
    case undefined:
      return false;
  }
}

function supportsAppSelectorTeamDefault(
  argv: string[],
  policy: CommandDefaultPolicy,
  projectConfig: ProjectConfig,
): boolean {
  if (hasOption(argv, "--app-id") || hasOption(argv, "--deployment-id")) {
    return false;
  }

  return (
    hasOption(argv, "--app") ||
    (supportsAppDefault(argv, policy) && hasProjectAppDefault(argv, projectConfig))
  );
}

function supportsExplicitAppSelectorTeamDefault(argv: string[]): boolean {
  return (
    !hasOption(argv, "--app-id") &&
    !hasOption(argv, "--deployment-id") &&
    hasOption(argv, "--app")
  );
}

function hasOption(argv: string[], option: string): boolean {
  return argv.some((arg) => arg === option || arg.startsWith(`${option}=`));
}

function hasProjectAppDefault(argv: string[], projectConfig: ProjectConfig): boolean {
  if (projectConfig.app !== undefined) {
    return true;
  }

  const platform = readOptionValue(argv, "--platform") ?? projectConfig.platform;
  if (platform !== "android" && platform !== "ios") {
    return false;
  }

  return projectConfig.apps?.[platform]?.app !== undefined;
}

function readOptionValue(argv: string[], option: string): string | undefined {
  const equalsPrefix = `${option}=`;
  const equalsMatch = argv.find((arg) => arg.startsWith(equalsPrefix));
  if (equalsMatch !== undefined) {
    return equalsMatch.slice(equalsPrefix.length);
  }

  const index = argv.indexOf(option);
  if (index === -1) {
    return undefined;
  }

  const value = argv[index + 1];
  return value !== undefined && !value.startsWith("--") ? value : undefined;
}
