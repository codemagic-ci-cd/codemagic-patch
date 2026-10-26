import { findCommandSpecRoute, isKnownCommandPrefix } from "./commandSpecs";
import type {
  CommandDefaultFlagValues,
  ParseCliResult,
} from "./commandTypes";

export function parseCliArgs(
  argv: string[],
  defaults: CommandDefaultFlagValues = {},
): ParseCliResult {
  if (argv.length === 0) {
    return {
      command: { kind: "help" },
      ok: true,
    };
  }

  if (argv[0] === "--version" || argv[0] === "-v") {
    return {
      command: { kind: "version" },
      ok: true,
    };
  }

  if (argv[0] === "help") {
    const topic = argv.slice(1).join(" ");
    return {
      command: {
        kind: "help",
        ...(topic.length > 0 ? { topic } : {}),
      },
      ok: true,
    };
  }

  if (argv.includes("--help") || argv.includes("-h")) {
    const topic = argv
      .filter((arg) => arg !== "--help" && arg !== "-h")
      .join(" ");
    return {
      command: {
        kind: "help",
        ...(topic.length > 0 ? { topic } : {}),
      },
      ok: true,
    };
  }

  const parseRoute = findCommandSpecRoute(argv);

  if (parseRoute !== null) {
    const parsed = parseRoute.parse(parseRoute.args, defaults);

    // A flag error inside a command we did resolve belongs to that command:
    // point at its help page, which lists the flags it accepts, rather than
    // reprinting the root command listing, which does not.
    if (!parsed.ok && parsed.showHelp && parsed.helpTopic === undefined) {
      return { ...parsed, helpTopic: parseRoute.path.join(" ") };
    }

    return parsed;
  }

  // A known command group typed without a subcommand (e.g. `cmpatch release`).
  if (isKnownCommandPrefix(argv[0]) && argv.length < 2) {
    return {
      error: "A command group and subcommand are required",
      ok: false,
      showHelp: true,
    };
  }

  // Everything else is unrecognized: a mistyped top-level command or a known
  // group with a bad subcommand. runCli phrases the message accordingly.
  return {
    command: {
      argv,
      kind: "not-implemented",
    },
    ok: true,
  };
}

export { renderHelp } from "./help";
