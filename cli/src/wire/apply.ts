// Executing a decided plan: the package install first, then every file
// edit, then CocoaPods, then a read-back of each edit. A failed install
// defers the edits that assume the SDK; a file that changed since the plan
// was made fails its step rather than being overwritten; completed changes
// are never rolled back — the next run re-reads the project as it is.

import { rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CommandDeps } from "../commands/shared";
import type { Progress } from "../progress";
import { readExpoPluginEntry } from "./expoConfig";
import { readTextFile } from "./fs";
import { transformJsRoot } from "./jsRoot";
import {
  compareDestination,
  readPlistDestination,
  readStringsDestination,
} from "./nativeConfig";
import {
  transformAndroidMainApplication,
  transformIosAppDelegate,
} from "./nativeHooks";
import { hasWork, materializeWrites, plannedIntents, type PlannedStep, type WirePlan } from "./plan";
import { SDK_INSTALL_FAILED_NOTE, type WireStep } from "./types";

export type ApplyOptions = {
  progress: Progress;
};

export async function applyPlan(
  deps: Pick<CommandDeps, "runCommand">,
  plan: WirePlan,
  options: ApplyOptions,
): Promise<WireStep[]> {
  const { progress } = options;
  // Executable steps begin uncompleted. Only a successful command or verified
  // write earns `changed`; the preview's projected success is never reused.
  const results = new Map(plan.steps.map((planned): [PlannedStep, WireStep] => [planned, {
    ...planned.step,
    state: planned.action.kind === "none" ? planned.action.state : hasWork(planned) ? "deferred" : "skipped",
  }]));
  const find = (id: WireStep["id"]) => plan.steps.find((planned) => planned.step.id === id);
  const install = find("sdk-install");
  let installFailed = false;

  if (install?.action.kind === "command" && install.action.decision === "run") {
    const action = install.action;
    progress.write(`Installing ${action.detail.replace(/^(install|upgrade) /, "")} with ${action.command[0]}`);
    const result = await run(deps, action.command, action.cwd);
    const step = results.get(install)!;
    installFailed = !result.ok;
    step.state = result.ok ? "changed" : "failed";
    if (!result.ok) {
      progress.settle("failed");
      Object.assign(step, commandFailure(action.command, result.output));
      step.manual = [
        "Fix the error above, then run `cmpatch wire` again. Or install the SDK yourself first:",
        `  ${action.command.join(" ")}`,
      ];
    }
  }

  const edits = plan.steps.filter((planned) => planned.action.kind === "edit");
  if (installFailed) {
    for (const planned of edits) {
      const step = results.get(planned)!;
      step.detail = `${step.detail} (not applied: ${SDK_INSTALL_FAILED_NOTE})`;
    }
  }
  const activeEdits = installFailed ? [] : edits;
  if (activeEdits.length > 0) progress.write("Editing project files");
  const { writes, failures } = await materializeWrites(activeEdits);
  for (const [file, reason] of failures) {
    for (const planned of activeEdits) {
      if (!plannedIntents(planned).some((intent) => intent.file === file)) continue;
      const step = results.get(planned)!;
      step.state = "failed";
      step.detail = `${step.detail}: ${reason}`;
      step.manual = ["Check the file, then run `cmpatch wire` again."];
    }
  }
  for (const write of writes) {
    const owners = activeEdits.filter((planned) => plannedIntents(planned).some((intent) => intent.file === write.file));
    const moved = owners.some((planned) =>
      plannedIntents(planned).some((intent) => intent.file === write.file && intent.snapshot !== write.before),
    );
    if (moved) {
      for (const planned of owners) {
        const step = results.get(planned)!;
        step.state = "failed";
        step.detail = `${path.basename(write.file)} changed while the plan was being reviewed`;
        step.manual = ["Run `cmpatch wire` again to plan from the file as it is now."];
      }
      continue;
    }
    try {
      await writeAtomically(write.file, write.after);
    } catch (error) {
      for (const planned of owners) {
        const step = results.get(planned)!;
        step.state = "failed";
        step.detail = `could not write ${write.file}: ${error instanceof Error ? error.message : String(error)}`;
        step.manual = ["Check that the file is writable, then run `cmpatch wire` again."];
      }
    }
  }

  if (activeEdits.some((planned) => results.get(planned)!.state === "failed")) progress.settle("failed");

  const pods = find("pod-install");
  if (pods?.action.kind === "command" && pods.action.decision === "run") {
    const action = pods.action;
    const step = results.get(pods)!;
    if (installFailed) {
      step.detail = `${step.detail} (not run: ${SDK_INSTALL_FAILED_NOTE})`;
    } else {
      progress.write(`Running ${action.command.join(" ")}`);
      const result = await run(deps, action.command, action.cwd);
      step.state = result.ok ? "changed" : "failed";
      if (result.ok) {
        delete step.manual;
      } else {
        progress.settle("failed");
        Object.assign(step, commandFailure(action.command, result.output));
        step.manual = [
          `Fix the CocoaPods error above, then run it again: \`cd ${path.relative(plan.shape.root, action.cwd) || "."} && ${action.command.join(" ")}\``,
        ];
      }
    }
  }

  if (activeEdits.length > 0) progress.write("Verifying the changes");
  let readBackFailed = false;
  for (const planned of activeEdits) {
    const step = results.get(planned)!;
    if (step.state === "failed") continue;
    const problem = await readBack(planned);
    step.state = problem === null ? "changed" : "failed";
    if (problem !== null) {
      readBackFailed = true;
      step.detail = `${step.detail}; read-back: ${problem}`;
      step.manual = ["Check the file, then run `cmpatch wire` again; `cmpatch wire --dry-run --diff` shows the change it makes."];
    }
  }
  progress.settle(readBackFailed ? "failed" : undefined);
  return [...results.values()];
}

/** A failed command's detail is one line; what it printed is kept apart, line by line. */
function commandFailure(command: string[], output: string[]): Pick<WireStep, "detail" | "output"> {
  return { detail: `${command.join(" ")} failed`, output };
}

async function run(
  deps: Pick<CommandDeps, "runCommand">,
  command: string[],
  cwd: string,
): Promise<{ ok: boolean; output: string[] }> {
  try {
    const result = await deps.runCommand(command[0]!, command.slice(1), { cwd, cleanupOnInterrupt: true });
    const output = `${result.stderr}${result.stdout}`.trim();
    return {
      ok: result.exitCode === 0,
      output: output === "" ? [`exit code ${result.exitCode ?? result.signal}`] : output.split("\n").slice(-8).map((line) => line.trimEnd()),
    };
  } catch (error) {
    return { ok: false, output: [error instanceof Error ? error.message : String(error)] };
  }
}

async function writeAtomically(file: string, contents: string): Promise<void> {
  const mode = await stat(file).then((s) => s.mode, () => undefined);
  const temporary = `${file}.${process.pid}.cmpatch.tmp`;
  await writeFile(temporary, contents, mode === undefined ? {} : { mode });
  await rename(temporary, file);
}

/** Null when the edited file reads back as configured; otherwise what is off. */
async function readBack(planned: PlannedStep): Promise<string | null> {
  const intent = plannedIntents(planned)[0]!;
  const text = await readTextFile(intent.file);
  if (text === null) return `${intent.file} is not readable`;
  switch (intent.kind) {
    case "plist":
    case "strings": {
      const current = intent.kind === "plist" ? readPlistDestination(text) : readStringsDestination(text);
      const comparison = current === null ? null : compareDestination(current, intent.values);
      return comparison?.kind === "complete" ? null : `${path.basename(intent.file)} does not carry the selected destination`;
    }
    case "expo-plugin": {
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        return "the Expo config is no longer valid JSON";
      }
      const entry = readExpoPluginEntry(data as Record<string, unknown>);
      const block = entry.kind === "present" ? entry.blocks[intent.platform] : undefined;
      return block !== undefined && compareDestination(block, intent.values).kind === "complete"
        ? null
        : "the plugin entry does not carry the selected destination";
    }
    case "source": {
      const result =
        planned.step.id === "js-root"
          ? transformJsRoot(text, intent.file)
          : planned.step.platform === "ios"
            ? transformIosAppDelegate(text, intent.file.endsWith(".swift") ? "swift" : "objc")
            : transformAndroidMainApplication(text, "kt");
      return result.kind === "already-configured" ? null : `${path.basename(intent.file)} does not read back as wired (${result.kind})`;
    }
  }
}
