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
  commandEmitsResponseWarnings,
  executeCommandSpec,
  findCommandSpecRoute,
  getCommandSuggestionCandidates,
  isKnownCommandPrefix,
  getCommandView,
  renderCommandTable,
  type CommandDefaultPolicy,
  type ExecutableCliCommand,
} from "./commandSpecs";
import {
  DeclinedError,
  UsageError,
  ValidationError,
  type CommandDeps,
} from "./commands/shared";
import {
  createInteractiveConfirm,
  createInteractivePrompt,
  PromptAbortError,
} from "./prompt";
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
  colorizeTable,
  createPalette,
  type Palette,
  isInteractiveOutput,
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
import {
  hasOption,
  readOptionValue,
  redactSecretFlags,
  renderCommand,
  withoutOption,
} from "./argv";
import { PROMPTABLE_FLAGS } from "./promptableFlags";
import {
  renderActionView,
  renderObjectView,
  unwrapSingleList,
} from "./resultView";
import { resolveEffectiveContext, resolveProjectRoot } from "./localContext";
import {
  canResolveMissingFlags,
  declinesInteraction,
  formatResolvedFlags,
  parseWithInteractiveFlags,
} from "./interactiveFlags";
import { getCliVersion } from "./version";

export type CliDeps = CommandDeps & {
  stderr: WritableStream;
  stdout: WritableStream;
};

function createDefaultDeps(): CliDeps {
  return {
    computeFingerprint: computeNativeFingerprint,
    computeFingerprintDetails: computeNativeFingerprintDetails,
    confirm: createInteractiveConfirm(process.stdin, process.stderr),
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
  // One palette per stream: stdout can be piped into jq while stderr is still
  // a terminal, and each must be styled on its own merits.
  const out = createPalette(deps.stdout, deps.env);
  const err = createPalette(deps.stderr, deps.env);

  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    const parsed = parseCliArgs(argv);

    if (!parsed.ok) {
      writeParseError(deps.stderr, parsed, err);
      return 2;
    }

    if (parsed.command.kind === "help") {
      writeLine(deps.stdout, renderHelp(parsed.command.topic, out));
      return 0;
    }
  }

  let parsed;
  let resolvedFlags: CommandDefaultFlagValues = {};
  // The invocation the `Using:` replay line is built from. Differs from argv
  // only after a resolution-stage sign-in stripped a rejected --token: echoing
  // that token back would hand the user a command that reproduces the 401.
  let replayArgv = argv;
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

    // Everything cheaper has already been tried — flag, env, stored config — so
    // a flag still missing here has never been supplied anywhere. Ask for it
    // rather than failing, but only for a command that declared it resolvable
    // and only when there is a person on the other end.
    if (
      !parsed.ok &&
      shouldApplyDefaults &&
      !isMachineOutputRun(argv, deps) &&
      canResolveMissingFlags(argv, deps)
    ) {
      // The resolver talks to the same server with the same credentials as
      // execution, so an authentication failure here earns the same offer:
      // sign in and retry once, with the rejected explicit token dropped so
      // the new credential can take effect.
      let resolveArgv = argv;
      for (let signedIn = false; ; ) {
        try {
          const outcome = await parseWithInteractiveFlags({
            argv: resolveArgv,
            commandKind: commandRoute!.kind,
            defaults: defaultFlags,
            deps,
            parse: (defaults) => parseCliArgs(resolveArgv, defaults),
            policy: commandRoute!.defaults as CommandDefaultPolicy,
            projectRoot: resolveProjectRoot(resolveArgv),
          });
          parsed = outcome.result;
          resolvedFlags = outcome.answers;
          break;
        } catch (error) {
          if (signedIn || !(error instanceof HttpProblemError)) {
            throw error;
          }

          deps.stderr.write(renderProblemDetails(error.problem, err));
          const offer = await offerInteractiveLogin(
            argv,
            null,
            deps,
            err,
            error,
          );

          if (offer === "aborted") {
            writeLine(deps.stderr, err.dim("Aborted."));
            return 130;
          }

          if (offer !== "signed-in") {
            return reportHttpProblemOutcome(error, deps, err, null);
          }

          signedIn = true;
          resolveArgv = withoutOption(argv, "--token");
          replayArgv = resolveArgv;
        }
      }
    }
  } catch (error) {
    // The resolver runs real server requests and execution-grade validation,
    // so its failures must render — and exit — exactly as execution's do.
    return reportCommandFailure(error, deps, err, null);
  }

  if (!parsed.ok) {
    writeParseError(deps.stderr, parsed, err);
    return 2;
  }

  const command = parsed.command;

  if (Object.keys(resolvedFlags).length > 0) {
    reportResolvedFlags(replayArgv, deps, err, resolvedFlags);
  }

  const explicitOutputFormat = parseExplicitOutputFormat(argv, command);

  if (!explicitOutputFormat.ok) {
    writeLine(deps.stderr, err.err(explicitOutputFormat.error));
    return 2;
  }

  const commandForExecution = withJsonNonInteractiveMode(
    command,
    explicitOutputFormat.ok ? explicitOutputFormat.format : undefined,
  );

  if (commandForExecution.kind === "help") {
    writeLine(deps.stdout, renderHelp(commandForExecution.topic, out));
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
    writeLine(deps.stderr, err.err(`${label}: cmpatch ${argv.join(" ")}${tail}`));
    return 2;
  }

  // Replaying after a sign-in runs a command that differs from the parsed one:
  // the explicit token that was just rejected has to come off, or it keeps
  // taking precedence over the credential the user just obtained.
  let commandToRun = commandForExecution;

  const requestedFormat =
    explicitOutputFormat.format ?? getStructuredOutputFormat(commandForExecution);
  const effectiveOutput = selectStructuredOutputFormat(
    requestedFormat,
    deps.stdout,
  );
  // Execution-stage resource pickers (the team/app selects inside resolvers)
  // live behind deps.prompt. A JSON run — explicit or defaulted by a piped
  // stdout — must never stop on a question, and neither may a run that passed
  // --non-interactive/--yes; withdrawing the prompt dep makes every such path
  // fall back to its deterministic usage error, whatever command is running,
  // instead of relying on each executor to thread a flag. Mutation confirms
  // (deps.confirm) stay: they are a safety stop, drawn on stderr for a user
  // who is present, and explicit-json runs already force them into the --yes
  // requirement via withJsonNonInteractiveMode. Commands whose whole point is
  // a guided session keep their prompts and their own interactivity gates.
  const promptDrivenKinds = new Set(["config", "init", "login"]);
  const executionDeps =
    !promptDrivenKinds.has(commandForExecution.kind) &&
    (effectiveOutput.format === "json" || declinesInteraction(argv))
      ? { ...deps, prompt: undefined }
      : deps;

  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = await executeCommandSpec(commandToRun, executionDeps);

      if (typeof result === "string") {
        const output = selectStructuredOutputFormat(requestedFormat, deps.stdout);
        if (output.format === "json" && output.source === "explicit") {
          writeJson(deps.stdout, result);
        } else if (output.format === "table" && explicitOutputFormat.text !== true) {
          deps.stdout.write(renderObjectView(result, out));
        } else {
          writeLine(deps.stdout, result);
        }
      } else if (result !== null) {
        const output = selectStructuredOutputFormat(
          requestedFormat,
          deps.stdout,
        );
        const warnings =
          output.format === "table" &&
          commandEmitsResponseWarnings(commandForExecution)
            ? extractResponseWarnings(result)
            : null;
        const table =
          output.format === "table"
            ? renderResultView(
                commandForExecution,
                warnings ? withoutWarningsKey(result) : result,
                out,
              )
            : null;
        if (table !== null) {
          // Human-facing warnings go to stderr; JSON output keeps the raw
          // response (warnings included) on stdout for machine consumption.
          for (const warning of warnings ?? []) {
            writeLine(deps.stderr, err.warn(`Warning: ${warning.detail}`));
          }
          deps.stdout.write(table);
        } else {
          writeJson(deps.stdout, result);
        }
      }

      return getCommandResultExitCode(result) ?? 0;
    } catch (error) {
      if (error instanceof HttpProblemError) {
        if (explicitOutputFormat.format === "json") {
          // `--format json` is machine-readable structured output: forward the
          // full RFC 9457 body as the `error` field on stdout so CI pipelines can
          // consume server-provided detail (cli-tech-spec §Server Error Response
          // Parsing). Data goes to stdout; the exit code is unchanged.
          writeJson(deps.stdout, { error: error.problem });
          return exitCodeForProblemDetails(error.problem, error.responseStatus);
        }
        deps.stderr.write(renderProblemDetails(error.problem, err));

        // Nothing ran, and the CLI already knows which server refused and how to
        // sign in to it — so offer, rather than printing the command to retype.
        // Not when stdout is machine-consumed, though: a piped run defaults to
        // JSON output and must exit with the auth error, not wait on a confirm.
        if (attempt === 0 && effectiveOutput.format !== "json") {
          const outcome = await offerInteractiveLogin(
            argv,
            commandForExecution,
            deps,
            err,
            error,
          );

          if (outcome === "aborted") {
            writeLine(deps.stderr, err.dim("Aborted."));
            return 130;
          }

          if (outcome === "signed-in") {
            commandToRun = withoutExplicitToken(commandToRun);
            continue;
          }
        }

        return reportHttpProblemOutcome(error, deps, err, commandForExecution);
      }

      return reportCommandFailure(error, deps, err, commandForExecution);
    }
  }
}

/**
 * One rendering for a failed command, wherever it failed: interactive flag
 * resolution talks to the same server, with the same credentials and the same
 * validation, as execution — so its errors must print the same details, carry
 * the same hints, and map to the same exit codes.
 */
function reportCommandFailure(
  error: unknown,
  deps: CliDeps,
  palette: Palette,
  command: CliCommand | null,
): number {
  if (error instanceof PromptAbortError) {
    writeLine(deps.stderr, palette.dim("Aborted."));
    return 130;
  }

  if (error instanceof DeclinedError) {
    writeLine(deps.stderr, palette.err(error.message));
    return 1;
  }

  if (error instanceof UsageError) {
    writeLine(deps.stderr, palette.err(error.message));
    return 2;
  }

  if (error instanceof ValidationError) {
    writeLine(deps.stderr, palette.err(error.message));
    return 3;
  }

  if (error instanceof HttpProblemError) {
    deps.stderr.write(renderProblemDetails(error.problem, palette));
    return reportHttpProblemOutcome(error, deps, palette, command);
  }

  writeLine(
    deps.stderr,
    palette.err(error instanceof Error ? error.message : String(error)),
  );
  return 1;
}

/**
 * The tail every HttpProblemError path shares once the problem details are on
 * screen and any sign-in offer has been declined: the how-to-authenticate hint
 * and the documented exit-code mapping.
 */
function reportHttpProblemOutcome(
  error: HttpProblemError,
  deps: CliDeps,
  palette: Palette,
  command: CliCommand | null,
): number {
  const authHint = renderAuthenticationHint(command, error);
  if (authHint !== null) {
    writeLine(deps.stderr, palette.dim(authHint));
  }
  return exitCodeForProblemDetails(error.problem, error.responseStatus);
}

/**
 * Hands back the invocation that would not have asked anything. A user who is
 * only ever prompted never learns the flag, and their CI job still fails — so
 * the run has to show the equivalent command line. Persisting it is left to
 * `cmpatch init`, which owns the project config.
 */
function reportResolvedFlags(
  argv: string[],
  deps: CliDeps,
  palette: Palette,
  answers: CommandDefaultFlagValues,
): void {
  const flags = formatResolvedFlags(answers);

  if (flags.length === 0) {
    return;
  }

  // The whole invocation, not just its first word: "cmpatch app --name Demo"
  // drops the subcommand and every flag the user already typed, so it is not a
  // command they can run.
  writeLine(
    deps.stderr,
    palette.dim(
      `Using: cmpatch ${renderCommand(redactSecretFlags([...argv, ...flags]))}`,
    ),
  );
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

  if (policy.bundler === true && !hasOption(argv, "--bundler")) {
    return true;
  }

  // A promptable-only flag pulls no value out of config, but the defaults stage
  // still has to run: it is what gets far enough to notice the flag is absent
  // and hand the parse to the interactive resolver.
  return (policy.prompt ?? []).some((flag) =>
    PROMPTABLE_FLAGS[flag].options.every((option) => !hasOption(argv, option)),
  );
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
  palette: Palette,
): void {
  writeLine(
    stderr,
    palette.err(
      error.error.startsWith("Error:") ? error.error : `Error: ${error.error}`,
    ),
  );

  if (error.suggestion !== undefined) {
    writeLine(stderr, "");
    writeLine(stderr, error.suggestion);
  }

  if (error.examples !== undefined && error.examples.length > 0) {
    writeLine(stderr, "");
    writeLine(stderr, palette.dim("Try:"));
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
    writeLine(stderr, renderHelp(undefined, palette));
  }
}

/**
 * Whether this invocation's stdout is being consumed by a machine: `--format
 * json` was requested, or no format was requested and stdout is not a terminal
 * (where output defaults to JSON — see `selectStructuredOutputFormat`). Both
 * shapes carry the same promise: machine-readable output never prompts, so a
 * captured `$(cmpatch …)` must fail fast exactly like an explicit-json run.
 */
function isMachineOutputRun(
  argv: string[],
  deps: Pick<CliDeps, "stdout">,
): boolean {
  const rawFormat = readRawFormatFlag(argv);

  return (
    rawFormat === "json" ||
    (rawFormat === undefined && !isInteractiveOutput(deps.stdout))
  );
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

/**
 * Picks the presentation from the shape of the result, not from a single
 * default. A declared view wins; otherwise an array is a table and anything
 * else is a labelled record. Only lists get ruled — a record rendered with a
 * header row and a separator is a table of one thing, which reads worse than
 * the fields it contains.
 */
function renderResultView(
  command: CliCommand,
  result: unknown,
  palette: Palette,
): string {
  const table = renderCommandTable(command, result, palette);

  if (table !== null) {
    return colorizeTable(table, palette);
  }

  const view = getCommandView(command);

  if (view?.kind === "action") {
    const summary = view.summarize(result, command as never);

    if (summary !== null) {
      return renderActionView(
        typeof summary === "string" ? { summary } : summary,
        palette,
      );
    }
  }

  if (view?.kind === "object") {
    return renderObjectView(result, palette, view.fields);
  }

  const list = Array.isArray(result) ? result : unwrapSingleList(result);

  if (list !== null) {
    return colorizeTable(renderGenericTable(list), palette);
  }

  return renderObjectView(result, palette);
}

/**
 * Server release responses carry non-blocking `warnings` (duplicate-release,
 * fingerprint-disagreement). Only consulted for commands whose spec declares
 * `responseWarnings`. Entries that don't match the `{code, detail}` shape
 * (e.g. a newer server's warning kind) are skipped individually so the
 * well-formed ones still reach stderr.
 */
function extractResponseWarnings(
  result: unknown,
): Array<{ code: string; detail: string }> | null {
  if (!isRecord(result) || !Array.isArray(result.warnings)) {
    return null;
  }

  const warnings: Array<{ code: string; detail: string }> = [];
  for (const entry of result.warnings) {
    if (
      !isRecord(entry) ||
      typeof entry.code !== "string" ||
      typeof entry.detail !== "string"
    ) {
      continue;
    }
    warnings.push({ code: entry.code, detail: entry.detail });
  }

  return warnings.length > 0 ? warnings : null;
}

function withoutWarningsKey(result: unknown): unknown {
  if (!isRecord(result)) {
    return result;
  }

  const rest = { ...result };
  delete rest.warnings;
  return rest;
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

// JSON is machine output — never prompt. Force non-interactive on every
// command that can otherwise prompt (mutation guard confirms, login), so the
// guard requires --yes instead of blocking on an interactive confirm. The
// `satisfies` clause is the drift guard: any command type gaining
// `nonInteractive?: true` without an entry here is a compile error.
const JSON_NON_INTERACTIVE_KINDS = {
  "app-remove": true,
  "deployment-clear": true,
  "deployment-remove": true,
  login: true,
  "release-create": true,
  "release-patch": true,
  "release-promote": true,
  "release-react": true,
  "release-rollback": true,
} satisfies Record<
  Extract<CliCommand, { nonInteractive?: true }>["kind"],
  true
>;

function supportsNonInteractive(
  command: CliCommand,
): command is Extract<CliCommand, { nonInteractive?: true }> {
  return command.kind in JSON_NON_INTERACTIVE_KINDS;
}

function withJsonNonInteractiveMode(
  command: CliCommand,
  format: StructuredOutputFormat | undefined,
): CliCommand {
  if (format !== "json" || !supportsNonInteractive(command)) {
    return command;
  }

  return {
    ...command,
    nonInteractive: true,
  };
}

/**
 * Drops a `--token` the server just refused. Auth precedence is
 * `--token` -> CODEMAGIC_PATCH_TOKEN -> stored credential, so replaying with it
 * still in place would present the same rejected token and fail identically,
 * making the sign-in pointless.
 */
function withoutExplicitToken(
  command: ExecutableCliCommand,
): ExecutableCliCommand {
  return "token" in command && command.token !== undefined
    ? { ...command, token: undefined }
    : command;
}

type LoginOfferOutcome = "aborted" | "declined" | "signed-in";

/**
 * Offers the sign-in the failed command needs, then reports whether it happened
 * so the caller can replay. Anything that goes wrong inside the login itself is
 * reported and treated as a decline: the user still gets the original error and
 * the printed instructions, which is exactly where they would have been.
 */
async function offerInteractiveLogin(
  argv: string[],
  // Null during interactive flag resolution, where no command has parsed yet;
  // the refusing server is then read off the error itself.
  command: CliCommand | null,
  deps: CliDeps,
  palette: Palette,
  error: HttpProblemError,
): Promise<LoginOfferOutcome> {
  const serverUrl = resolveAuthenticationServerUrl(command, error);

  if (
    serverUrl === null ||
    deps.confirm === undefined ||
    !canResolveMissingFlags(argv, deps)
  ) {
    return "declined";
  }

  // A sign-in stores a credential, but CODEMAGIC_PATCH_TOKEN outranks the
  // store — the replay would present the same rejected environment token and
  // fail identically. Point at the variable instead of offering a login that
  // cannot take effect.
  const envToken = deps.env.CODEMAGIC_PATCH_TOKEN?.trim();
  if (envToken !== undefined && envToken.length > 0) {
    writeLine(
      deps.stderr,
      palette.dim(
        "CODEMAGIC_PATCH_TOKEN is set and takes precedence over a stored sign-in. Unset it or set it to a valid token.",
      ),
    );
    return "declined";
  }

  try {
    const confirmed = await deps.confirm({
      initial: true,
      message: `Sign in to ${serverUrl} now?`,
    });

    if (!confirmed) {
      return "declined";
    }

    const login = parseCliArgs(["login", "--server-url", serverUrl]);

    if (!login.ok || login.command.kind !== "login") {
      return "declined";
    }

    await executeCommandSpec(login.command, deps);
    return "signed-in";
  } catch (loginError) {
    if (loginError instanceof PromptAbortError) {
      return "aborted";
    }

    writeLine(
      deps.stderr,
      palette.err(
        loginError instanceof Error ? loginError.message : String(loginError),
      ),
    );
    return "declined";
  }
}

/** The server that refused, if this failure is an authentication failure. */
function resolveAuthenticationServerUrl(
  command: CliCommand | null,
  error: HttpProblemError,
): string | null {
  const serverUrl =
    command !== null &&
    "serverUrl" in command &&
    typeof command.serverUrl === "string"
      ? command.serverUrl
      : error.serverUrl;

  return getProblemTypeSuffix(error.problem.type) === "authentication-required" &&
    serverUrl !== undefined
    ? serverUrl
    : null;
}

function renderAuthenticationHint(
  command: CliCommand | null,
  error: HttpProblemError,
): string | null {
  const serverUrl =
    command !== null &&
    "serverUrl" in command &&
    typeof command.serverUrl === "string"
      ? command.serverUrl
      : error.serverUrl;

  if (
    getProblemTypeSuffix(error.problem.type) !== "authentication-required" ||
    serverUrl === undefined
  ) {
    return null;
  }

  return [
    `Authentication required for ${serverUrl}.`,
    `Run \`cmpatch login --server-url ${serverUrl}\` or pass --token/CODEMAGIC_PATCH_TOKEN.`,
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
    supportsAppDefault(argv, policy) &&
    !hasOption(argv, "--app") &&
    !hasOption(argv, "--app-id")
  ) {
    const appId = context.appId?.value;
    const app = context.app?.value;

    if (appId !== undefined) {
      defaults.appId = appId;
    } else if (app !== undefined) {
      defaults.app = app;
    }
  }

  // Resolved after the app default: an app-selector command whose default is
  // the rename-safe appId must not also receive a team default, because the
  // parsers reject --app-id combined with --team/--team-id.
  if (
    supportsTeamDefault(argv, policy, defaults) &&
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
  defaults: CommandDefaultFlagValues,
): boolean {
  switch (policy.team) {
    case "always":
      return true;
    case "app-selector":
      return supportsAppSelectorTeamDefault(argv, defaults);
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
  defaults: CommandDefaultFlagValues,
): boolean {
  if (hasOption(argv, "--app-id") || hasOption(argv, "--deployment-id")) {
    return false;
  }

  return hasOption(argv, "--app") || defaults.app !== undefined;
}

function supportsExplicitAppSelectorTeamDefault(argv: string[]): boolean {
  return (
    !hasOption(argv, "--app-id") &&
    !hasOption(argv, "--deployment-id") &&
    hasOption(argv, "--app")
  );
}
