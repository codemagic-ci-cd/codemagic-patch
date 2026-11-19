import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { notifyOfUpdate } from "@codemagic/patch-shared";

import { sourceBundlePath } from "./commands/selfhostInstall/hostBootstrap";
import { resolveConfigHome } from "./configStore";
import type { Palette, WritableStream } from "./output";
import { getCliVersion } from "./version";

const PACKAGE_NAME = "@codemagic/patch-cli";

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
  deps: {
    env: Record<string, string | undefined>;
    now: () => number;
    startUpdateCheck?: StartUpdateCheck;
    stderr: WritableStream;
    stdout: WritableStream;
  },
  jsonRequested: boolean,
  palette: Palette,
): void {
  const { startUpdateCheck } = deps;
  if (startUpdateCheck === undefined) {
    return;
  }

  // Resolved only inside the callbacks, which run for a notice that is on and may
  // throw: with no HOME and no passwd entry (a container under an unmapped UID)
  // there is no home to find.
  const statePath = (): string =>
    join(resolveConfigHome(deps.env), "update-check.json");

  notifyOfUpdate({
    cliName: "cmpatch",
    currentVersion: getCliVersion(),
    env: deps.env,
    hideInstallHint: sourceBundlePath(deps) !== null,
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
    style: palette.warn,
    writeState: (text) => {
      mkdirSync(dirname(statePath()), { mode: 0o700, recursive: true });
      writeFileSync(statePath(), text);
    },
  });
}
