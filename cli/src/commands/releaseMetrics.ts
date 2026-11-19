import type { ReleaseMetricsCommand } from "../commandTypes";
import { authenticatedRequest } from "../authenticatedRequest";
import {
  formatBytes,
  formatSuccessRate,
  isRecord,
  readCell,
  renderTable,
} from "../output";
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

/**
 * The release's counters, then what the dashboard's release page shows beside
 * them: how the release was delivered, how each binary version fared, and why
 * devices failed. Each part appears only when the server sent it.
 */
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
    ["ready", metrics === null ? "-" : readCell(metrics, "installed")],
    ["failed", metrics === null ? "-" : readCell(metrics, "failed")],
    ["applied", metrics === null ? "-" : readCell(metrics, "success")],
    ...deliveryRows(release.delivery),
  ];
  const keyWidth = Math.max(...rows.map(([key]) => key.length));

  return [
    `${rows.map(([key, value]) => `${key.padEnd(keyWidth)}  ${value}`).join("\n")}\n`,
    binaryVersionsTable(result.binary_versions),
    failureReasonsTable(metrics?.failure_reasons),
  ]
    .filter((block) => block.length > 0)
    .join("\n");
}

/** Diff and full-bundle downloads; an older server sends no `delivery`. */
function deliveryRows(delivery: unknown): string[][] {
  if (!isRecord(delivery)) {
    return [];
  }

  const patch = isRecord(delivery.patch) ? delivery.patch : {};
  const fullBundle = isRecord(delivery.full_bundle) ? delivery.full_bundle : {};
  const size = (lane: Record<string, unknown>) =>
    typeof lane.size_bytes === "number" ? formatBytes(lane.size_bytes) : "-";
  // The release a diff was cut from is known even before its size is measured.
  const from =
    typeof patch.from_release_label === "string"
      ? ` (from ${patch.from_release_label})`
      : "";

  return [
    ["diffDownloads", readCell(patch, "downloads")],
    ["diffSize", `${size(patch)}${from}`],
    ["fullDownloads", readCell(fullBundle, "downloads")],
    ["fullSize", size(fullBundle)],
  ];
}

/** One binary version repeats the counters above, so the split starts at two. */
function binaryVersionsTable(binaryVersions: unknown): string {
  const rows = Array.isArray(binaryVersions) ? binaryVersions.filter(isRecord) : [];

  if (rows.length < 2) {
    return "";
  }

  return renderTable(
    ["BINARY VERSION", "DOWNLOADED", "READY", "FAILED", "APPLIED", "SUCCESS RATE"],
    rows.map((row) => [
      readCell(row, "binary_version", "(unknown)"),
      readCell(row, "downloaded"),
      readCell(row, "installed"),
      readCell(row, "failed"),
      readCell(row, "success"),
      formatSuccessRate(row.success_rate),
    ]),
  );
}

/** Most frequent first; each reason is a `--reason` value of `release failures`. */
function failureReasonsTable(failureReasons: unknown): string {
  const rows = isRecord(failureReasons)
    ? Object.entries(failureReasons)
        .filter((entry): entry is [string, number] => typeof entry[1] === "number")
        .sort(([a, countA], [b, countB]) => countB - countA || a.localeCompare(b))
    : [];

  return rows.length === 0
    ? ""
    : renderTable(
        ["FAILURE REASON", "COUNT"],
        rows.map(([reason, count]) => [reason, String(count)]),
      );
}
