// Adapted from cli/src/updateNotice.ts: this CLI's names and state file, no palette and
// no source-bundle build. See cli-capacitor-tech-spec › Provenance.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { notifyOfUpdate } from "@codemagic/patch-shared";

import { CLI_NAME } from "./branding";
import type { CliDeps } from "./deps";
import { resolveUserConfigPath } from "./userConfig";
import { getCliVersion } from "./version";

const PACKAGE_NAME = "@codemagic/capacitor-patch-cli";

export type StartUpdateCheck = (packageName: string, statePath: string) => void;

/**
 * The starter of dist/update-check.js (src/bin/update-check.ts), which runs on its own:
 * detached and with no stdio, so the command that started it exits without waiting.
 *
 * Undefined where that file does not exist, which is a run from source (`yarn dev`):
 * there is no npm install to update, and stamping the state for a check that cannot
 * run would hold back the installed CLI's own.
 */
export function detachedUpdateCheck(): StartUpdateCheck | undefined {
  const worker = join(__dirname, "update-check.js");
  if (!existsSync(worker)) {
    return undefined;
  }

  return (packageName, statePath) => {
    const child = spawn(process.execPath, [worker, packageName, statePath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    // A spawn failure arrives as an event, and an unhandled one would crash the CLI.
    child.on("error", () => {});
    child.unref();
  };
}

export function writeUpdateNotice(
  deps: Pick<CliDeps, "env" | "now" | "startUpdateCheck" | "stderr" | "stdout">,
  jsonRequested: boolean,
): void {
  const { startUpdateCheck } = deps;
  if (startUpdateCheck === undefined) {
    return;
  }

  // Beside the user config file, and apart from `cmpatch`'s update-check.json: the two
  // CLIs are separate packages with separate versions. Resolved only inside the
  // callbacks, which run for a notice that is on and may throw: with no HOME and no
  // passwd entry (a container under an unmapped UID) there is no home to find.
  const statePath = (): string =>
    join(dirname(resolveUserConfigPath(deps.env)), "update-check-capacitor.json");

  notifyOfUpdate({
    cliName: CLI_NAME,
    currentVersion: getCliVersion(),
    env: deps.env,
    jsonRequested,
    now: deps.now(),
    packageName: PACKAGE_NAME,
    readState: () => {
      try {
        return readFileSync(statePath(), "utf8");
      } catch {
        return null;
      }
    },
    startCheck: () => startUpdateCheck(PACKAGE_NAME, statePath()),
    stderr: deps.stderr,
    stdout: deps.stdout,
    writeState: (text) => {
      mkdirSync(dirname(statePath()), { mode: 0o700, recursive: true });
      writeFileSync(statePath(), text);
    },
  });
}
