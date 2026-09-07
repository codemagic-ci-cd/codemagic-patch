/**
 * Short local commands whose output is read rather than shown — `docker
 * info`, `git status`, `lsof`. The same `runProcess` the ssh layer uses, so
 * every probe here runs in tests without a process being spawned.
 */

import type { CommandDeps } from "../shared";

export type CaptureResult = {
  exitCode: number | null;
  output: string;
  /**
   * The spawn itself failed — the executable is not on PATH. Distinguished
   * from a non-zero exit because the two mean different things to a probe:
   * "docker is not installed" versus "docker is installed but not answering".
   */
  spawnError: string | null;
};

export async function captureLocal(
  deps: CommandDeps,
  input: { args: readonly string[]; command: string },
): Promise<CaptureResult> {
  const chunks: string[] = [];
  try {
    const result = await deps.runProcess({
      args: input.args,
      command: input.command,
      onOutput: (chunk) => {
        chunks.push(chunk);
      },
    });
    return { ...result, output: chunks.join(""), spawnError: null };
  } catch (error) {
    return {
      exitCode: null,
      output: chunks.join(""),
      spawnError: error instanceof Error ? error.message : String(error),
    };
  }
}
