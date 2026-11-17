// `cmpatch deployment timeseries`: the day-bucketed counters behind the
// dashboard's deployment chart, from
// `GET /v1/metrics/deployments/:deploymentId/timeseries`.

import type {
  DeploymentTimeseriesCommand,
  TimeseriesRange,
} from "../commandTypes";
import { authenticatedRequest } from "../authenticatedRequest";
import { isRecord, type Palette } from "../output";
import { resolveDeploymentId } from "./resolveNames";
import {
  binaryVersionFilterQuery,
  buildApiUrlWithQuery,
  withUnavailableFeatureMessage,
  type CommandDeps,
} from "./shared";

export const DEPLOYMENT_TIMESERIES_UNAVAILABLE_MESSAGE =
  "This server does not publish deployment time series (server too old or timeseries disabled).";

const DAY_MS = 24 * 60 * 60 * 1000;

// The dashboard's chart presets: a trailing window of whole days ending now,
// `1y` included (365 days, not a calendar year).
const RANGE_DAYS: Record<TimeseriesRange, number> = {
  "1y": 365,
  "30d": 30,
  "7d": 7,
  "90d": 90,
};

export async function executeDeploymentTimeseries(
  command: DeploymentTimeseriesCommand,
  deps: CommandDeps,
): Promise<unknown> {
  const deploymentId = await resolveDeploymentId(
    command.deployment,
    command.serverUrl,
    command.token,
    deps,
  );
  const range =
    command.range !== undefined
      ? presetRange(command.range, deps.now())
      : { from: command.from, to: command.to };

  return withUnavailableFeatureMessage(
    authenticatedRequest(deps, {
      init: {
        method: "GET",
      },
      serverUrl: command.serverUrl,
      token: command.token,
      url: buildApiUrlWithQuery(
        command.serverUrl,
        `/v1/metrics/deployments/${encodeURIComponent(deploymentId)}/timeseries`,
        {
          ...binaryVersionFilterQuery(command),
          from: range.from,
          series_limit: command.seriesLimit,
          to: range.to,
        },
      ),
    }),
    DEPLOYMENT_TIMESERIES_UNAVAILABLE_MESSAGE,
  );
}

function presetRange(
  range: TimeseriesRange,
  now: number,
): { from: string; to: string } {
  return {
    from: new Date(now - RANGE_DAYS[range] * DAY_MS).toISOString(),
    to: new Date(now).toISOString(),
  };
}

/** A bucket's `bucket_start` as its UTC day; buckets start at UTC midnight. */
export function readBucketDay(bucket: Record<string, unknown>): string {
  const start = bucket.bucket_start;
  return typeof start === "string" ? start.slice(0, 10) : "";
}

/**
 * The lines under the daily table: the server's range summary, how many
 * per-release series the JSON output carries (they have no table of their
 * own), and the binary versions that reported in the range, which are the
 * values the filter flags take. A server without `summary` gets no summary
 * lines rather than locally computed ones.
 */
export function renderDeploymentTimeseriesNote(
  result: unknown,
  palette: Palette,
): string {
  if (!isRecord(result)) {
    return "";
  }

  const lines: string[] = [];

  if (isRecord(result.summary)) {
    const { last_complete_day: lastDay, totals } = result.summary;
    if (isRecord(totals)) {
      const rate =
        typeof totals.success_rate === "number"
          ? `${(totals.success_rate * 100).toFixed(1)}%`
          : "n/a";
      lines.push(
        `Range totals: ${String(totals.downloaded)} downloaded, ${String(totals.installed)} ready, ${String(totals.failed)} failed, ${String(totals.success)} applied; success rate ${rate}.`,
      );
    }
    lines.push(
      isRecord(lastDay)
        ? `Last complete day: ${readBucketDay(lastDay)}, ${String(lastDay.active_devices)} active devices.`
        : "Last complete day: none in this range.",
    );
  }

  const series = Array.isArray(result.series) ? result.series : [];

  if (series.length > 0 || result.series_truncated === true) {
    const truncated =
      result.unlisted_series === "unavailable"
        ? " (truncated; packages not listed are unavailable, not zero)"
        : result.series_truncated === true
          ? " (truncated)"
          : "";
    lines.push(
      `Per-release series: ${series.length}${truncated}. Read them with --format json.`,
    );
  }

  const binaryVersions = Array.isArray(result.binary_versions)
    ? result.binary_versions.filter(
        (version): version is string => typeof version === "string",
      )
    : [];

  if (binaryVersions.length > 0) {
    lines.push(
      `Binary versions in range: ${binaryVersions.join(", ")}. Narrow with --binary-version or --binary-version-prefix.`,
    );
  }

  return lines.length === 0
    ? ""
    : `\n${lines.map((line) => palette.dim(line)).join("\n")}\n`;
}
