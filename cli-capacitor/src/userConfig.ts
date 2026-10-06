// The user config file — config.json under ~/.codemagic-patch, or $CODEMAGIC_PATCH_HOME
// — and the one value of it this CLI has a use for: the default server URL. The file is
// shared with `cmpatch`, whose `config set`, self-host install and local evaluation
// write it in the format of cli/src/configStore.ts (@codemagic/patch-cli 0.4.0). Both
// CLIs talk to the same servers, so a machine one of them was pointed at needs no
// --server-url for the other (decided 2026-09-21).
//
// Sharing a file is what R18 undid for the credential stores, so this module keeps its
// hands off everything but `serverUrl`: nothing else is read or validated, and a write
// carries the rest of the document through as it found it — the team defaults and the
// self-host pairings are not this CLI's to drop. See cli-capacitor-tech-spec › R32, R33.

import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { CLI_NAME } from "./branding";
import { ValidationError } from "./errors";

const USER_CONFIG_FILE_NAME = "config.json";

/**
 * The file is there and cannot be used. A class of its own so that the caller, which
 * knows why the file was wanted, can add the way around it to the message.
 */
export class UserConfigFileError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = "UserConfigFileError";
  }
}

type UserConfigDocument = Record<string, unknown>;

// `env` has no `process.env` default here, unlike configStore.ts: a caller that forgot
// it would read the developer's real config file from inside a test, and nothing would
// fail.
export function resolveUserConfigPath(
  env: Record<string, string | undefined>,
): string {
  const codemagicPatchHome = resolveOptionalString(env.CODEMAGIC_PATCH_HOME);
  const home =
    codemagicPatchHome ??
    join(resolveOptionalString(env.HOME) ?? homedir(), ".codemagic-patch");

  return join(home, USER_CONFIG_FILE_NAME);
}

/**
 * The `serverUrl` the user config file sets, with the file it came from, or undefined
 * when there is no file or it sets none. A file that is there but cannot be understood
 * fails instead of counting as "none": whoever relies on its default would otherwise be
 * told the server URL is missing, with nothing pointing at the file that was supposed to
 * supply it.
 */
export function readConfiguredServerUrl(
  env: Record<string, string | undefined>,
): { configPath: string; serverUrl: string } | undefined {
  const configPath = resolveUserConfigPath(env);
  const document = readUserConfigDocument(configPath);

  if (document === undefined || !("serverUrl" in document)) {
    return undefined;
  }

  // Its own message: the file is version 1, so "upgrade" would be advice that cannot help.
  if (typeof document.serverUrl !== "string") {
    throw new UserConfigFileError(
      `The config file ${configPath} sets serverUrl to something that is not a string.\n` +
        `Replace it with \`${CLI_NAME} config set --server-url <url>\`.`,
    );
  }

  // A blank value counts as unset, as it does for the CLI this file is shared with.
  const serverUrl = resolveOptionalString(document.serverUrl);
  return serverUrl === undefined ? undefined : { configPath, serverUrl };
}

/**
 * Sets the file's `serverUrl`, or removes it when given undefined, and leaves every
 * other key of the document as it was. A file that cannot be understood is refused, not
 * overwritten — it may be one a newer version reads perfectly well — but a `serverUrl`
 * of the wrong type is simply replaced: that is the repair its error message offers.
 */
export async function writeConfiguredServerUrl(
  env: Record<string, string | undefined>,
  serverUrl: string | undefined,
): Promise<{ changed: boolean; configPath: string }> {
  const configPath = resolveUserConfigPath(env);
  const document = readUserConfigDocument(configPath);

  if (serverUrl === undefined) {
    // Nothing to remove: no file is created, or rewritten, to record an absence.
    if (document === undefined || !("serverUrl" in document)) {
      return { changed: false, configPath };
    }

    const withoutServerUrl = { ...document };
    delete withoutServerUrl.serverUrl;
    await writeUserConfigDocument(configPath, withoutServerUrl);
    return { changed: true, configPath };
  }

  await writeUserConfigDocument(configPath, { ...document, serverUrl, version: 1 });
  return { changed: true, configPath };
}

/** The file's JSON object, or undefined when there is no file. Only `version` is checked. */
function readUserConfigDocument(configPath: string): UserConfigDocument | undefined {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }

    // The code alone: Node's message for these repeats the path just given.
    const reason = isNodeError(error) ? ` (${error.code})` : formatErrorSuffix(error);
    throw new UserConfigFileError(
      `The config file ${configPath} could not be read${reason}.\nFix the file.`,
    );
  }

  let parsed: unknown;
  try {
    // A byte order mark is what a Windows editor leaves in front of a hand-edited file.
    parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (error) {
    throw new UserConfigFileError(
      `The config file ${configPath} is not valid JSON${formatErrorSuffix(error)}.\nFix the file.`,
    );
  }

  // Only what is read is checked. Refusing the file over a section this CLI has no use
  // for would stop every command for the sake of a value none of them needs.
  const version =
    typeof parsed === "object" && parsed !== null && "version" in parsed
      ? parsed.version
      : undefined;
  if (version === 1) {
    return parsed as UserConfigDocument;
  }

  // "Upgrade" only where upgrading can help: a newer format, not a damaged file.
  throw new UserConfigFileError(
    typeof version === "number" && version > 1
      ? `The config file ${configPath} is not in the format this version of ${CLI_NAME} reads (version 1).\nUpgrade ${CLI_NAME}.`
      : `The config file ${configPath} is not a JSON object with "version": 1.\nFix the file.`,
  );
}

// Directory 0700, file 0600, through a temp file and a rename — as configStore.ts and
// the credential store write theirs, so an interrupted write leaves the old file whole.
// Unlike them, a failure is explained and takes its temp file with it: the name is
// unique to the attempt, so every retry would otherwise leave another one behind.
async function writeUserConfigDocument(
  configPath: string,
  document: UserConfigDocument,
): Promise<void> {
  const tempPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;

  try {
    await mkdir(dirname(configPath), { mode: 0o700, recursive: true });
    await writeFile(tempPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    await rename(tempPath, configPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});

    const reason = isNodeError(error) ? ` (${error.code})` : formatErrorSuffix(error);
    throw new UserConfigFileError(
      `The config file ${configPath} could not be written${reason}.\n` +
        `Check that ${dirname(configPath)} is a directory you can write to.`,
    );
  }
}

function formatErrorSuffix(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? ` (${error.message})`
    : "";
}

function resolveOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isNodeError(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  );
}
