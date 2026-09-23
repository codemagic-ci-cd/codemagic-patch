import path from "node:path";

import type { CommandDeps } from "../commands/shared";

/**
 * Whether the project has uncommitted changes, so wiring's edits would land
 * on top of work the developer cannot tell apart from them afterwards.
 * `null` when the project is not in a git repository or git is unavailable
 * — nothing to protect there. The project config file init writes is not
 * counted: it is the one file this same run may have just created.
 */
export async function isWorktreeDirty(
  deps: Pick<CommandDeps, "runCommand">,
  projectRoot: string,
): Promise<boolean | null> {
  let result: Awaited<ReturnType<CommandDeps["runCommand"]>>;
  try {
    result = await deps.runCommand(
      "git",
      ["status", "--porcelain", "--untracked-files=all", "--", "."],
      { cwd: projectRoot },
    );
  } catch {
    return null;
  }
  if (result.exitCode !== 0) return null;
  return result.stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .some((line) => path.basename(line.slice(3).trim()) !== "codemagic-patch.config.json");
}
