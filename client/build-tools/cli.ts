// Command-line adapter for the build tools: the `write` command a native build
// step runs with Node (build-tools/native/). This file only parses arguments
// and prints results.
//
// Every line that reports a problem starts with `error: ` or `warning: `, the
// prefixes Xcode lists as issues, so the iOS phase passes the output through
// unchanged and a Gradle log reads the same. Xcode fails a phase that prints
// an `error: ` line even when it exits 0, so a failure that only warns prints
// `warning: ` lines and nothing else.

import path from "node:path";
import { parseArgs } from "node:util";

import { BUILD_METADATA_FILE_NAME } from "./buildMetadata";
import { isBuildToolsError } from "./errors";
import { assertSupportedNode } from "./nodeVersion";
import {
  isBuildMetadataOptedOut,
  removeBuildMetadata,
  SKIP_BUILD_FINGERPRINT_ENV,
  writeBuildMetadata,
  type BundleMode,
} from "./writer";
import { xcodeBundleMode } from "./xcodeBundleMode";

/** What `cmpatch` checks before it calls the calculator (specs/build-metadata.md §6.1 rule 5). */
export const BUILD_TOOLS_CONTRACT_VERSION = 1;

const TAG = "[codemagic-patch build-tools]";
const ERROR = `error: ${TAG}`;
const WARNING = `warning: ${TAG}`;

const USAGE = `Usage:
  write --platform <ios|android> --app-root <dir> --bundle-mode <embedded|metro|xcode>
        [--bundle-input-dir <dir>] [--bundle-name <name>] --output <file>
      Write ${BUILD_METADATA_FILE_NAME} for one build. --output must name that
      file. --bundle-input-dir is required in embedded mode. --bundle-mode xcode
      derives the mode of an iOS build from CONFIGURATION, PLATFORM_NAME, ACTION,
      SKIP_BUNDLING and FORCE_BUNDLING.
`;

export type CliIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

const processIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

type Env = Readonly<Record<string, string | undefined>>;

export type CliOptions = {
  /** The Node.js version to check against the floor; defaults to `process.versions.node`. */
  nodeVersion?: string;
  /** The environment the opt-out and the Xcode build settings are read from; defaults to `process.env`. */
  env?: Env;
};

class UsageError extends Error {}

function readPlatform(value: string | undefined): "ios" | "android" {
  if (value !== "ios" && value !== "android") {
    throw new UsageError("--platform must be ios or android");
  }
  return value;
}

/** `xcode` stands for the mode the Xcode build environment gives (xcodeBundleMode.ts). */
function resolveBundleMode(value: string | undefined, env: Env): string | undefined {
  return value === "xcode" ? xcodeBundleMode(env) : value;
}

function readBundleMode(value: string | undefined): BundleMode {
  if (value !== "embedded" && value !== "metro") {
    throw new UsageError("--bundle-mode must be embedded, metro or xcode");
  }
  return value;
}

/**
 * The last value of `--<name>`, read without parseArgs: the opt-out and the
 * Metro-served warning must work when the Node.js check fails, which happens
 * before parseArgs runs, and when parseArgs itself rejects the arguments.
 */
function rawOption(args: readonly string[], name: string): string | undefined {
  let value: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === `--${name}`) {
      value = args[index + 1];
    } else if (arg.startsWith(`--${name}=`)) {
      value = arg.slice(name.length + 3);
    }
  }
  return value;
}

/**
 * The metadata path `write` owns. Only a path to the pinned file name counts:
 * the writer removes this file on opt-out and on failure, and a mistyped
 * --output must never remove anything else.
 */
function metadataOutputPath(args: readonly string[]): string | undefined {
  const value = rawOption(args, "output");
  return value !== undefined && path.basename(value) === BUILD_METADATA_FILE_NAME
    ? path.resolve(value)
    : undefined;
}

/** One `warning: ` line per line of `text`. */
function warningLines(text: string): string {
  return text
    .split(/\r?\n|\r/)
    .map((line) => `${WARNING} ${line}\n`)
    .join("");
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined || value.length === 0) {
    throw new UsageError(`${flag} is required`);
  }
  return value;
}

/**
 * Runs one adapter command. Returns the process exit code: 0 success, 1 a
 * calculator, tree or write failure, 2 a usage error. Never throws. In a
 * Metro-served `write` a failure other than a usage error warns, leaves no
 * metadata file and returns 0.
 */
export async function runCli(
  argv: readonly string[],
  io: CliIo = processIo,
  options: CliOptions = {},
): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "help") {
    io.stdout(USAGE);
    return 0;
  }
  if (command !== "write") {
    io.stderr(`${ERROR} usage error: ${command === undefined ? "a command is required" : `unknown command: ${command}`}\n${USAGE}`);
    return 2;
  }

  const env = options.env ?? process.env;
  let context = "";
  // A non-zero exit never leaves an earlier record that looks current.
  const ownedOutput = metadataOutputPath(rest);
  const optedOut = isBuildMetadataOptedOut(env);
  // A Metro-served development build only warns on a failure (spec §5.1 rule 4).
  let metroBuild = resolveBundleMode(rawOption(rest, "bundle-mode"), env) === "metro";
  try {
    // The opt-out is read before the Node.js check (spec §5.1 rule 7).
    if (optedOut) {
      if (ownedOutput === undefined) {
        throw new UsageError(`--output must be a path to ${BUILD_METADATA_FILE_NAME}`);
      }
      const removed = removeBuildMetadata(ownedOutput);
      io.stderr(
        `${WARNING} ${SKIP_BUILD_FINGERPRINT_ENV}=1 opts out: no ${BUILD_METADATA_FILE_NAME} for this build (${removed ? "removed the previous one at" : "none at"} ${ownedOutput}). This disables the whole metadata file, and with it embedded-baseline identification for this binary.\n`,
      );
      return 0;
    }
    // Checked before parseArgs, which an old Node may not have.
    assertSupportedNode(options.nodeVersion);
    const { values } = parseArgs({
      args: [...rest],
      options: {
        platform: { type: "string" },
        "app-root": { type: "string" },
        "bundle-mode": { type: "string" },
        "bundle-input-dir": { type: "string" },
        "bundle-name": { type: "string" },
        output: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    });
    const requestedMode = resolveBundleMode(values["bundle-mode"], env);
    metroBuild = requestedMode === "metro";

    const platform = readPlatform(values.platform);
    const appRoot = required(values["app-root"], "--app-root");
    context = ` platform=${platform} appRoot=${appRoot}`;
    const bundleMode = readBundleMode(requestedMode);
    if (ownedOutput === undefined) {
      throw new UsageError(`--output must be a path to ${BUILD_METADATA_FILE_NAME}`);
    }
    const bundleInputDir = values["bundle-input-dir"];
    const common = { platform, appRoot, bundleName: values["bundle-name"], output: ownedOutput };
    const result = await writeBuildMetadata(
      bundleMode === "embedded"
        ? { ...common, bundleMode, bundleInputDir: required(bundleInputDir, "--bundle-input-dir (embedded mode)") }
        : { ...common, bundleMode, bundleInputDir },
    );
    for (const leftover of result.leftovers) {
      io.stderr(
        `${WARNING} Metro-served development build: the leftover bundle file ${leftover} is not hashed or recorded. Embedded-baseline identification is disabled for this build.\n`,
      );
    }
    const embedded =
      result.embeddedMs === null
        ? "embedded hash skipped (metro)"
        : `embedded hash ${result.embeddedMs} ms, ${result.embeddedFileCount} files`;
    io.stderr(
      `${TAG} ${result.written ? "wrote" : "unchanged, not rewritten:"} ${ownedOutput} (fingerprint ${result.fingerprintMs} ms, ${embedded})\n`,
    );
    return 0;
  } catch (error) {
    const usageError =
      error instanceof UsageError || String((error as { code?: unknown } | null)?.code).startsWith("ERR_PARSE_ARGS");
    const code = isBuildToolsError(error) ? error.code : "UNEXPECTED";
    const message = error instanceof Error ? error.message : String(error);
    // A wrong invocation is the integration's bug and fails in both modes. A
    // metadata file that cannot be removed fails too: it would look current.
    if (metroBuild && !usageError && ownedOutput !== undefined) {
      let removed: boolean | undefined;
      try {
        removed = removeBuildMetadata(ownedOutput);
      } catch {
        // Reported by the failure below.
      }
      if (removed !== undefined) {
        io.stderr(
          warningLines(
            [
              `Metro-served development build: the build metadata step failed (${code})${context === "" ? "" : ` for${context}`}, so this build has no ${BUILD_METADATA_FILE_NAME}. In a build that embeds its JS bundle this failure is an error.`,
              ...message.split(/\r?\n|\r/).filter((line) => line.trim().length > 0).map((line) => `cause: ${line}`),
              ...(removed ? [`removed the earlier ${ownedOutput}`] : []),
            ].join("\n"),
          ),
        );
        return 0;
      }
    }
    const removal = removeAfterFailure(ownedOutput);
    // A failed build names its opt-out (spec §5.1 rule 4), which needs only a valid --output.
    const hint =
      ownedOutput !== undefined && !optedOut
        ? `${ERROR} hint: to build without this step, set ${SKIP_BUILD_FINGERPRINT_ENV}=1. The app then has no ${BUILD_METADATA_FILE_NAME}.\n`
        : "";
    if (usageError) {
      io.stderr(`${ERROR} usage error: ${message}\n${removal}${hint}${USAGE}`);
      return 2;
    }
    io.stderr(`${ERROR} (${code}):${context === "" ? " platform=?" : context}\n${ERROR} cause: ${message}\n${removal}${hint}`);
    return 1;
  }
}

/** Removes the metadata file after a failed `write`; returns a line to print, or "". */
function removeAfterFailure(output: string | undefined): string {
  if (output === undefined) return "";
  try {
    return removeBuildMetadata(output) ? `${TAG} removed the earlier ${output}\n` : "";
  } catch (error) {
    return `${ERROR} ${error instanceof Error ? error.message : String(error)}\n`;
  }
}
