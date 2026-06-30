import type { DebugCommand } from "../commandTypes";
import { type CommandDeps, UsageError } from "./shared";

const CODEMAGIC_PATCH_LOG_PATTERN =
  "CodemagicPatch|codemagic-patch|OTA update|update check|rollback";

export async function executeDebug(
  command: DebugCommand,
  deps: CommandDeps,
): Promise<unknown> {
  const plan =
    command.platform === "ios"
      ? {
          args: [
            "simctl",
            "spawn",
            "booted",
            "log",
            "stream",
            "--style",
            "compact",
            "--predicate",
            `eventMessage CONTAINS[c] "CodemagicPatch" OR eventMessage CONTAINS[c] "OTA"`,
          ],
          command: "xcrun",
          label: "iOS Simulator CodemagicPatch log stream",
        }
      : {
          args: ["logcat", "-e", CODEMAGIC_PATCH_LOG_PATTERN],
          command: "adb",
          label: "Android CodemagicPatch logcat stream",
        };

  if (deps.stdout === undefined || deps.stderr === undefined) {
    throw new UsageError("debug requires stdout and stderr streams");
  }

  const result = await deps.streamCommand(plan.command, plan.args, {
    cwd: process.cwd(),
    stderr: deps.stderr,
    stdout: deps.stdout,
  });

  if (result.exitCode !== 0) {
    const status =
      result.exitCode === null
        ? `signal ${String(result.signal)}`
        : `exit code ${String(result.exitCode)}`;
    throw new UsageError(
      `${plan.label} failed. Ensure the ${
        command.platform === "ios" ? "Simulator is booted" : "Android device is connected"
      }. ${plan.command} exited with ${status}.`,
    );
  }

  return null;
}
