import { parseCliArgs } from "./args";
import { FORMAT_FLAG, readFormat } from "./command";
import { createDefaultDeps, type CliDeps } from "./deps";
import {
  DeclinedError,
  PromptAbortError,
  UsageError,
  ValidationError,
} from "./errors";
import { renderHelp } from "./help";
import { renderProblemDetails, writeLine } from "./output";
import {
  exitCodeForProblemDetails,
  HttpProblemError,
} from "./problem-details";
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
      case "command": {
        // Read before the command runs, so a bad --format is a usage error rather
        // than something discovered after the command has already changed state.
        const format = parsed.definition.flags.includes(FORMAT_FLAG)
          ? readFormat(parsed.values)
          : "text";
        const output = await parsed.definition.run(parsed.values, deps);
        if (output !== undefined) {
          deps.stdout.write(renderOutput(output, format));
        }
        return 0;
      }
    }
  } catch (error) {
    return reportError(error, deps);
  }
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
    writeLine(deps.stderr, "Run `cmpatch-capacitor --help` for usage.");
    return 2;
  }

  if (error instanceof ValidationError) {
    writeLine(deps.stderr, `Error: ${error.message}`);
    return 3;
  }

  if (error instanceof HttpProblemError) {
    writeLine(deps.stderr, renderProblemDetails(withServerProblemHint(error.problem)));
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
