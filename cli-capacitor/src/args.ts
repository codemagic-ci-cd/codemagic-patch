import { parseArgs } from "node:util";

import type { CommandDefinition, FlagValues } from "./command";
import { UsageError } from "./errors";
import { COMMANDS, commandGroups, commandName, commandsInGroup } from "./registry";

export type ParsedCommand =
  | { kind: "help"; topic?: CommandDefinition | string }
  | { kind: "version" }
  | { definition: CommandDefinition; kind: "command"; values: FlagValues };

export function parseCliArgs(argv: string[]): ParsedCommand {
  const [first, ...rest] = argv;

  if (first === undefined || first === "--help" || first === "-h") {
    return { kind: "help" };
  }

  if (first === "--version" || first === "-v") {
    return { kind: "version" };
  }

  if (first === "help") {
    return rest.length === 0 ? { kind: "help" } : helpFor(rest);
  }

  const { args, definition } = findCommand(argv);
  const values = parseFlags(definition, args);

  return values === null
    ? { kind: "help", topic: definition }
    : { definition, kind: "command", values };
}

/** `help release`, `help release list` — a group or a command, whichever the words name. */
function helpFor(words: string[]): ParsedCommand {
  const name = words.join(" ");
  const definition = COMMANDS.find((candidate) => commandName(candidate) === name);
  if (definition !== undefined) {
    return { kind: "help", topic: definition };
  }

  if (words.length === 1 && commandGroups().includes(words[0]!)) {
    return { kind: "help", topic: words[0]! };
  }

  throw new UsageError(`Unknown command "${name}". Run \`cmpatch-capacitor --help\` for the list.`);
}

function findCommand(argv: string[]): { args: string[]; definition: CommandDefinition } {
  const [group, second] = argv;
  const candidates = commandsInGroup(group!);

  if (candidates.length === 0) {
    throw new UsageError(
      `Unknown command "${group}". Commands: ${commandGroups().join(", ")}.`,
    );
  }

  const single = candidates.find((candidate) => candidate.path.length === 1);
  if (single !== undefined) {
    return { args: argv.slice(1), definition: single };
  }

  const subcommand = candidates.find((candidate) => candidate.path[1] === second);
  if (subcommand !== undefined) {
    return { args: argv.slice(2), definition: subcommand };
  }

  // `release --bundle-path …` is `release create`: that is how the upload was
  // spelled before this CLI had any other release subcommand.
  if (group === "release" && (second === undefined || second.startsWith("-"))) {
    const create = candidates.find((candidate) => candidate.path[1] === "create")!;
    return { args: argv.slice(1), definition: create };
  }

  const subcommands = candidates.map((candidate) => candidate.path[1]).join(", ");
  throw new UsageError(
    second === undefined || second.startsWith("-")
      ? `\`${group}\` needs a subcommand: ${subcommands}.`
      : `Unknown command "${group} ${second}". \`${group}\` has: ${subcommands}.`,
  );
}

/**
 * The flag values of one command, or null when `--help` / `-h` was among them.
 * Help is parsed as a flag rather than spotted anywhere in argv:
 * `--release-notes --help` must not turn a release into a help screen that
 * exits 0 having uploaded nothing.
 */
function parseFlags(definition: CommandDefinition, args: string[]): FlagValues | null {
  const options: Record<string, { short?: string; type: "boolean" | "string" }> = {
    help: { short: "h", type: "boolean" },
  };
  for (const flag of definition.flags) {
    options[flag.name] = {
      ...(flag.short !== undefined ? { short: flag.short } : {}),
      type: flag.type,
    };
  }

  let parsed;
  try {
    parsed = parseArgs({ allowPositionals: true, args, options, strict: true });
  } catch (error) {
    throw new UsageError(describeParseError(error));
  }

  if (parsed.values.help === true) {
    return null;
  }

  if (parsed.positionals.length > 0) {
    throw new UsageError(
      `Unexpected argument "${parsed.positionals[0]}". \`${commandName(definition)}\` takes flags only.`,
    );
  }

  return parsed.values as FlagValues;
}

// Flags people reach for that this CLI does not have (most of them exist in the React
// Native CLI this one was derived from). An unknown flag that gets no explanation reads
// as a typo, so each of these says what to do instead — in this CLI's own terms, never
// by naming another tool: someone using this CLI need not have heard of one.
const NO_FINGERPRINT =
  "This CLI computes and checks no native fingerprint: the binary version a release names (--target-binary-version) is what scopes it.";
const UNSUPPORTED_FLAG_HINTS: Readonly<Record<string, string>> = {
  "--allow-fingerprint-mismatch": NO_FINGERPRINT,
  "--fingerprint": NO_FINGERPRINT,
  "--non-interactive":
    "This CLI only ever asks on a terminal; pass --yes to answer in advance (--format json never asks either).",
  "--platform":
    "There is no platform to choose: an app is one platform, so --app (or the deployment id) already says which one the release is for.",
  "--project-root":
    "This CLI reads no project files: pass the built web assets with --bundle-path.",
  "--sourcemap": "Source maps are not uploaded: a release is the built web assets and nothing else.",
  "--team-id": "Use --team, which takes a team's name or its id.",
  "--timeout": "Use --timeout-seconds.",
};

// node:util reports unknown flags, missing values and the like as TypeErrors whose
// message already names the offending flag. Its unknown-flag message goes on to
// explain positional arguments, which no command here takes.
function describeParseError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const unknownFlag = /^Unknown option '([^']+)'/.exec(message)?.[1];

  if (unknownFlag === undefined) {
    return message;
  }

  const explanation = UNSUPPORTED_FLAG_HINTS[unknownFlag];
  return explanation === undefined
    ? `Unknown option '${unknownFlag}'.`
    : `Unknown option '${unknownFlag}'. ${explanation}`;
}
