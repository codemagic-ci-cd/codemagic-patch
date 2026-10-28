import { parseCliArgs } from "./args";
import { CLI_NAME } from "./branding";
import {
  type CommandDefinition,
  type FlagValues,
  FORMAT_FLAG,
  readRequestedFormat,
} from "./command";
import { createDefaultDeps, type CliDeps } from "./deps";
import {
  attributeUsageError,
  DeclinedError,
  PromptAbortError,
  UsageError,
  ValidationError,
} from "./errors";
import { renderHelp } from "./help";
import { renderProblemDetails, selectOutputFormat, writeLine } from "./output";
import {
  exitCodeForProblemDetails,
  HttpProblemError,
  ServerFeatureUnavailableError,
} from "./problem-details";
import { commandName } from "./registry";
import { renderOutput } from "./render";
import { withServerProblemHint } from "./serverProblemHints";
import { getCliVersion } from "./version";

/** Runs one command line and returns the process exit code. Never throws. */
export async function runCli(
  argv: string[],
  deps: CliDeps = createDefaultDeps(),
): Promise<number> {
  try {
    const parsed = parseCliArgs(argv);

    switch (parsed.kind) {
      case "help":
        deps.stdout.write(renderHelp(parsed.topic));
        return 0;
      case "version":
        writeLine(deps.stdout, getCliVersion());
        return 0;
      case "command":
        try {
          return await runCommand(parsed.definition, parsed.values, deps);
        } catch (error) {
          // A usage error the command itself raised (a flag it reads, a bundle
          // it rejects) is as much its own as a flag the parser rejected.
          attributeUsageError(error, commandName(parsed.definition));
          throw error;
        }
    }
  } catch (error) {
    return reportError(error, deps);
  }
}

async function runCommand(
  definition: CommandDefinition,
  values: FlagValues,
  deps: CliDeps,
): Promise<number> {
  // Read before the command runs, so a bad --format is a usage error rather
  // than something discovered after the command has already changed state.
  const format = definition.flags.includes(FORMAT_FLAG)
    ? selectOutputFormat(readRequestedFormat(values), deps.stdout)
    : "text";
  const output = await definition.run(values, deps);
  if (output !== undefined) {
    deps.stdout.write(renderOutput(output, format));
  }
  return output !== undefined && output.kind === "report" ? (output.exitCode ?? 0) : 0;
}

// Exit codes are `cmpatch`'s (cli/README.md › Exit codes), so CI logic written
// for one CLI holds for the other.
function reportError(error: unknown, deps: CliDeps): number {
  if (error instanceof PromptAbortError) {
    writeLine(deps.stderr, error.message);
    return 130;
  }

  if (error instanceof DeclinedError) {
    writeLine(deps.stderr, error.message);
    return 1;
  }

  if (error instanceof UsageError) {
    writeLine(deps.stderr, `Error: ${error.message}`);
    // The command's own help lists the flags it takes; the root listing does not.
    // Only an error from before a command resolved (unknown command, a group
    // without its subcommand) sends the reader to the listing.
    writeLine(
      deps.stderr,
      error.command === undefined
        ? `Run \`${CLI_NAME} --help\` for usage.`
        : `Run \`${CLI_NAME} ${error.command} --help\` for usage.`,
    );
    return 2;
  }

  if (error instanceof ValidationError) {
    writeLine(deps.stderr, `Error: ${error.message}`);
    return 3;
  }

  if (error instanceof HttpProblemError) {
    writeLine(
      deps.stderr,
      error instanceof ServerFeatureUnavailableError
        ? `Error: ${error.message}`
        : renderProblemDetails(withServerProblemHint(error.problem)),
    );
    if (error.serverUrl !== undefined) {
      writeLine(deps.stderr, `server: ${error.serverUrl}`);
    }
    return exitCodeForProblemDetails(error.problem, error.responseStatus);
  }

  writeLine(
    deps.stderr,
    `Error: ${error instanceof Error ? error.message : String(error)}`,
  );
  return 1;
}
