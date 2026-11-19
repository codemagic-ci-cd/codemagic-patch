// `cmpatch server status`: the server's own view of what it sits on — its
// database, object storage, disk, download origin and version — as reported by
// `GET /v1/server/status`, the route behind the dashboard's Status page.
// `cmpatch doctor` answers a different question: what this machine can reach.

import type { ServerStatusCommand } from "../commandTypes";
import { authenticatedRequest } from "../authenticatedRequest";
import { formatBytes, isRecord } from "../output";
import { readPath, type ObjectField } from "../resultView";
import {
  buildApiUrl,
  withUnavailableFeatureMessage,
  type CommandDeps,
} from "./shared";

export const SERVER_STATUS_UNAVAILABLE_MESSAGE =
  "This server does not publish status (server too old or status disabled).";

export async function executeServerStatus(
  command: ServerStatusCommand,
  deps: CommandDeps,
): Promise<unknown> {
  return withUnavailableFeatureMessage(
    authenticatedRequest(deps, {
      init: {
        method: "GET",
      },
      serverUrl: command.serverUrl,
      token: command.token,
      url: buildApiUrl(command.serverUrl, "/v1/server/status"),
    }),
    SERVER_STATUS_UNAVAILABLE_MESSAGE,
  );
}

/**
 * One row per probe, each read as its status plus the detail that status
 * carries: what was measured when `ok`, the error when `error`, why it did not
 * run when `skipped`. The JSON output is the response as it came; this is only
 * how a person reads it.
 */
export const SERVER_STATUS_FIELDS: readonly ObjectField[] = [
  {
    cell: (record) =>
      probeCell(readPath(record, "checks.database"), {
        qualifier: readString(record, "topology.database"),
      }),
    label: "Database",
    reads: [...probeReads("checks.database"), "topology.database"],
  },
  {
    cell: (record) =>
      probeCell(readPath(record, "checks.storage"), {
        qualifier: readString(record, "topology.storage"),
      }),
    label: "Storage",
    reads: [...probeReads("checks.storage"), "topology.storage"],
  },
  {
    cell: (record) =>
      probeCell(readPath(record, "checks.disk"), { okDetail: diskDetail }),
    label: "Disk",
    reads: probeReads("checks.disk", ["free_bytes", "path", "total_bytes"]),
  },
  {
    cell: (record) =>
      probeCell(readPath(record, "checks.download_url"), {
        okDetail: downloadUrlDetail,
      }),
    label: "Download URL",
    reads: probeReads("checks.download_url", ["http_status", "url"]),
  },
  {
    cell: (record) => {
      const version = readPath(record, "version");

      if (!isRecord(version)) {
        return undefined;
      }

      return typeof version.running === "string" && version.running.length > 0
        ? version.running
        : "unknown";
    },
    label: "Version",
    reads: ["version.running"],
  },
  {
    cell: (record) =>
      probeCell(readPath(record, "checks.latest_release"), {
        okDetail: (probe) =>
          latestReleaseDetail(probe, readPath(record, "version.update_available")),
      }),
    label: "Update",
    reads: [
      ...probeReads("checks.latest_release", [
        "html_url",
        "published_at",
        "tag",
        "version",
      ]),
      "version.update_available",
    ],
  },
  ["Hosting", "topology.hosting"],
];

/** The envelope every probe shares, plus the details its `ok` form carries. */
function probeReads(
  path: string,
  okDetails: readonly string[] = [],
): string[] {
  return ["status", "error", "reason", ...okDetails].map(
    (key) => `${path}.${key}`,
  );
}

/**
 * `ok (bundled)`, `ok: 12 GB free of 40 GB (/)`, `error: connection refused`,
 * `skipped: update check disabled`. A probe that does not have the envelope
 * shape is left to the raw rows below the declared ones.
 */
function probeCell(
  probe: unknown,
  options: {
    okDetail?: (probe: Record<string, unknown>) => string | undefined;
    qualifier?: string;
  },
): string | undefined {
  if (!isRecord(probe) || typeof probe.status !== "string") {
    return undefined;
  }

  const head =
    options.qualifier === undefined
      ? probe.status
      : `${probe.status} (${options.qualifier})`;
  const detail =
    probe.status === "ok"
      ? options.okDetail?.(probe)
      : probe.status === "error"
        ? nonEmptyString(probe.error)
        : probe.status === "skipped"
          ? nonEmptyString(probe.reason)
          : undefined;

  return detail === undefined ? head : `${head}: ${detail}`;
}

function diskDetail(probe: Record<string, unknown>): string | undefined {
  if (typeof probe.free_bytes !== "number" || typeof probe.total_bytes !== "number") {
    return undefined;
  }

  const where = nonEmptyString(probe.path);
  const amounts = `${formatBytes(probe.free_bytes)} free of ${formatBytes(probe.total_bytes)}`;

  return where === undefined ? amounts : `${amounts} (${where})`;
}

function downloadUrlDetail(probe: Record<string, unknown>): string | undefined {
  const url = nonEmptyString(probe.url);
  const status =
    typeof probe.http_status === "number" ? `HTTP ${probe.http_status}` : undefined;

  return [status, url].filter((part) => part !== undefined).join(" ") || undefined;
}

/**
 * Whether there is something to upgrade to, and where to read about it. The
 * comparison is the server's (`version.update_available`, null when either
 * side is not comparable); the CLI only words it.
 */
function latestReleaseDetail(
  probe: Record<string, unknown>,
  updateAvailable: unknown,
): string | undefined {
  const version = nonEmptyString(probe.version);
  const latest = version === undefined ? nonEmptyString(probe.tag) : `v${version}`;

  if (latest === undefined) {
    return undefined;
  }

  if (updateAvailable === true) {
    const url = nonEmptyString(probe.html_url);
    return url === undefined ? `${latest} available` : `${latest} available, ${url}`;
  }

  return updateAvailable === false
    ? `up to date (latest ${latest})`
    : `latest ${latest}`;
}

function readString(value: unknown, path: string): string | undefined {
  return nonEmptyString(readPath(value, path));
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
