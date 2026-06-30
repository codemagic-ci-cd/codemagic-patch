import type { FingerprintCommand } from "../commandTypes";
import { ensureReadableDirectory, type CommandDeps } from "./shared";

export async function executeFingerprint(
  command: FingerprintCommand,
  deps: CommandDeps,
): Promise<Record<string, unknown> | string> {
  const projectRoot = await ensureReadableDirectory(
    deps,
    command.projectRoot,
    "project root",
  );

  if (command.verbose) {
    const details = await deps.computeFingerprintDetails({
      platform: command.platform,
      projectRoot,
    });
    const sources = details.sources.map((source) => ({
      ...(source.filePath !== undefined ? { filePath: source.filePath } : {}),
      type: source.type,
    }));

    if (command.format === "json") {
      return {
        fingerprint: details.fingerprint,
        sources,
      };
    }

    return [
      details.fingerprint,
      ...sources.map((source) =>
        source.filePath === undefined
          ? source.type
          : `${source.type}\t${source.filePath}`,
      ),
    ].join("\n");
  }

  const fingerprint = await deps.computeFingerprint({
    platform: command.platform,
    projectRoot,
  });

  if (command.format === "json") {
    return { fingerprint };
  }

  return fingerprint;
}
