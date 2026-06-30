import type { ReleaseMetricsCommand } from "../commandTypes";
import { authenticatedRequest } from "../authenticatedRequest";
import { isRecord, readCell } from "../output";
import { buildApiUrl, type CommandDeps, UsageError } from "./shared";
import { resolveReleaseId } from "./resolveNames";

export async function executeReleaseMetrics(
  command: ReleaseMetricsCommand,
  deps: CommandDeps,
): Promise<unknown> {
  const releaseId = await resolveReleaseId(
    command.release,
    command.serverUrl,
    command.token,
    deps,
  );

  return authenticatedRequest(deps, {
    init: {
      method: "GET",
    },
    serverUrl: command.serverUrl,
    token: command.token,
    url: buildApiUrl(
      command.serverUrl,
      `/v1/metrics/releases/${encodeURIComponent(releaseId)}`,
    ),
  });
}

export function renderReleaseMetricsTable(result: unknown): string {
  if (!isRecord(result) || !isRecord(result.release)) {
    throw new UsageError(
      'Cannot render table output: expected response field "release"',
    );
  }

  const release = result.release;
  const metrics = isRecord(release.metrics) ? release.metrics : null;
  const rows = [
    ["releaseId", readCell(release, "release_id")],
    ["label", readCell(release, "release_label")],
    ["targetBinaryVersion", readCell(release, "target_binary_version")],
    ["active", metrics === null ? "-" : readCell(metrics, "active")],
    ["downloaded", metrics === null ? "-" : readCell(metrics, "downloaded")],
    ["installed", metrics === null ? "-" : readCell(metrics, "installed")],
    ["failed", metrics === null ? "-" : readCell(metrics, "failed")],
    ["success", metrics === null ? "-" : readCell(metrics, "success")],
  ];
  const keyWidth = Math.max(...rows.map(([key]) => key.length));

  return `${rows
    .map(([key, value]) => `${key.padEnd(keyWidth)}  ${value}`)
    .join("\n")}\n`;
}
