import type { DebugCommand } from "../commandTypes";
import { type CommandDeps, UsageError } from "./shared";

/**
 * Markers the SDK actually writes to the device log. Nothing else is matched
 * on purpose: a broad clause such as `OTA` also hits "Rotation", "quota" or
 * "notation" and floods the stream with unrelated system output.
 *
 * Both filters match message text only. `adb logcat -e` never looks at the
 * tag, so native Android lines identified solely by their `CodemagicPatchModule`
 * tag (e.g. `reloadBundle: ...`) are not included.
 *
 * - `CodemagicPatch` — the module / error-domain name that React Native prints
 *   in the message when the native module rejects or fails to register.
 * - `[codemagic-patch]` — the JS SDK's console prefix (`sync failed: ...`),
 *   which React Native forwards to logcat / the unified log.
 */
const CODEMAGIC_PATCH_LOG_MARKERS = ["CodemagicPatch", "[codemagic-patch]"] as const;

/** `adb logcat -e` regex over the two markers (brackets escaped). */
export const CODEMAGIC_PATCH_LOG_PATTERN = "CodemagicPatch|\\[codemagic-patch\\]";

/** `log stream --predicate`: case-sensitive substring match on each marker. */
export const IOS_LOG_PREDICATE = CODEMAGIC_PATCH_LOG_MARKERS.map(
  (marker) => `eventMessage CONTAINS "${marker}"`,
).join(" OR ");

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
            IOS_LOG_PREDICATE,
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
