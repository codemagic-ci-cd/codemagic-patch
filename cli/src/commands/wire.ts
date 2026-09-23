import type { WireCommand } from "../commandTypes";
import { loadProjectConfig } from "../configStore";
import { resolveProjectRoot } from "../localContext";
import type { NativePlatform } from "../projectAnalysis";
import { runWire, type WireOptions } from "../wire/run";
import { UsageError, type CommandDeps } from "./shared";

export async function executeWireCommand(
  command: WireCommand,
  deps: CommandDeps,
): Promise<unknown> {
  const projectRoot = resolveProjectRoot(command.argv);
  const options = parseWireFlags(command.argv);
  if (command.nonInteractive) options.nonInteractive = true;
  const connection = await loadProjectConfig(projectRoot);
  if (connection.serverUrl === undefined || connection.apps === undefined) {
    throw new UsageError(
      "No project connection found in codemagic-patch.config.json. Run `cmpatch init` to connect this project and wire the SDK.",
    );
  }
  return runWire(deps, { connection, options, projectRoot });
}

/** The wiring flags, by shape, so `init` can let them through its own parser. */
export const WIRE_BOOLEAN_FLAGS = [
  "allow-dirty",
  "diff",
  "dry-run",
  "no-pod-install",
  "pod-install",
  "replace-destination",
  "skip-js",
] as const;

/**
 * The wiring flags, from a raw argv. `init` forwards its argv here too,
 * naming its own flags as `known` so they pass through.
 */
export function parseWireFlags(
  argv: string[],
  known: readonly string[] = ["project-root"],
): WireOptions {
  const options: WireOptions = {
    allowDirty: false,
    dryRun: false,
    nonInteractive: false,
    podInstall: "ask",
    replaceDestination: false,
    showDiff: false,
    skipJs: false,
    yes: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) {
      throw new UsageError(`Unexpected positional argument: ${token}`);
    }
    const [name, inline] = token.slice(2).split("=", 2);
    const value = () => {
      const next = inline ?? argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new UsageError(`Flag --${name} requires a value`);
      }
      if (inline === undefined) index += 1;
      return next;
    };
    const flag = () => {
      if (inline !== undefined && inline !== "true" && inline !== "false") {
        throw new UsageError(`Flag --${name} must be true or false`);
      }
      return inline !== "false";
    };
    switch (name) {
      case "allow-dirty":
        options.allowDirty = flag();
        break;
      case "diff":
        options.showDiff = flag();
        break;
      case "dry-run":
        options.dryRun = flag();
        break;
      case "native-projects": {
        const mode = value();
        if (mode !== "generated" && mode !== "maintained") {
          throw new UsageError("--native-projects must be generated or maintained");
        }
        options.nativeProjects = mode;
        break;
      }
      case "no-pod-install":
        if (flag()) options.podInstall = "skip";
        break;
      case "platform": {
        const platform = value();
        if (platform !== "ios" && platform !== "android") {
          throw new UsageError("--platform must be either ios or android");
        }
        options.platforms = [...new Set([...(options.platforms ?? []), platform as NativePlatform])];
        break;
      }
      case "pod-install":
        options.podInstall = flag() ? "run" : "skip";
        break;
      case "replace-destination":
        options.replaceDestination = flag();
        break;
      case "skip-js":
        options.skipJs = flag();
        break;
      case "yes":
        options.yes = flag();
        break;
      case "non-interactive":
        options.nonInteractive = flag();
        break;
      case "token":
        options.token = value();
        break;
      default:
        if (known.includes(name ?? "")) {
          value();
          break;
        }
        throw new UsageError(`Unknown wire flag: --${name}`);
    }
  }
  return options;
}
