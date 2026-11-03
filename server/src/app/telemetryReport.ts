/**
 * Daily usage report: the body a server POSTs to the public collector once
 * per UTC day while the usage report is on (the default; `SERVER_TELEMETRY=false`
 * or `DO_NOT_TRACK=1` turns it off), and the reporter that sends it.
 *
 * The report carries one day of aggregate counts, the previous UTC day,
 * plus a snapshot of totals, and nothing else: no device, app, team, or
 * deployment identifiers or names, no URLs, emails, bundle hashes, or
 * failure reasons. The collector
 * publishes aggregate statistics from it; the data is never used to enforce
 * the licence's MAU limit. The wire contract is
 * `shared/schemas/telemetry-report.v1.schema.json`, whose
 * `$defs/strictReport` is exactly what `buildTelemetryReport` produces.
 *
 * `buildTelemetryReport` and `telemetryReportDay` are pure; the reporter
 * owns the database reads and the request. Its `report()` never rejects:
 * every failure becomes an outcome the timer (`runtime/telemetryReportTimer.ts`)
 * turns into "retry next tick", "wait", "done for today", or "stop".
 */

import { addUtcDays, formatUtcDay } from "../domain";
import type { DatabasePool } from "../db";
import {
  ensureInstanceId,
  readReportDay,
  readSnapshot,
  type TelemetryReportDayCounts,
  type TelemetryReportSnapshot,
} from "../repositories";
import type { RuntimeLogger } from "../runtime/logger";
import type { ServerStatusTopology } from "./types";

export const DEFAULT_TELEMETRY_ENDPOINT =
  "https://telemetry.codemagicpatch.dev/v1/report";

/**
 * Largest body the collector accepts without question. A report over it is
 * not sent at all: the one day row is a few hundred bytes and the whole body
 * under 1 KiB, so exceeding it means something is wrong with the sender, not
 * the network.
 */
export const TELEMETRY_MAX_REPORT_BYTES = 8 * 1024;

const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_AFTER_MS = 3_600_000;
const MAX_RETRY_AFTER_MS = 86_400_000;

export interface TelemetryReportInstance {
  database: ServerStatusTopology["database"];
  delivery_adapter: "base-url" | "cloudflare" | "cloudfront";
  hosting: ServerStatusTopology["hosting"];
  /** A `worker` process never reports, so the wire value is never `worker`. */
  mode: "all" | "api";
  server_version: string;
  storage: ServerStatusTopology["storage"];
  storage_adapter: "gcs" | "memory" | "s3";
}

export interface TelemetryReportDay {
  active_apps: number;
  active_devices: number;
  active_teams: number;
  applied: number;
  day: string;
  failed: number;
  failed_unattributed: number;
  releases: number;
  rollbacks: number;
}

export interface TelemetryReportSnapshotFields {
  apps: number;
  deployments: number;
  releases_total: number;
  teams: number;
  teams_with_apps: number;
}

/** Exactly `$defs/strictReport` of the v1 schema. */
export interface TelemetryReport {
  days: TelemetryReportDay[];
  instance: TelemetryReportInstance;
  instance_id: string;
  schema_version: 1;
  sent_at: string;
  snapshot: TelemetryReportSnapshotFields;
}

export interface TelemetryReportInput {
  /** The previous UTC day's counts, as `readReportDay` returns them. */
  day: TelemetryReportDayCounts;
  hosting: ServerStatusTopology["hosting"];
  instance: Omit<TelemetryReportInstance, "hosting" | "server_version">;
  instanceId: string;
  now: Date;
  serverVersion: string;
  snapshot: TelemetryReportSnapshot;
}

/**
 * The UTC day before `now`, the one day a report carries. Its counts are
 * whatever raw events had arrived by the time of sending: the SDK sends a
 * session's events on the next foreground entry, so a later delivery for
 * that day is never counted (about 15-20 % of the day's final count in
 * production, 2026-10-24), an accepted undercount in exchange for a one-day
 * delay. Nothing is re-sent, so a day the server could not deliver stays
 * missing for the instance; the collector shows such a gap as no data,
 * never as 0.
 */
export function telemetryReportDay(now: Date): string {
  return formatUtcDay(addUtcDays(now, -1));
}

export function buildTelemetryReport(
  input: TelemetryReportInput,
): TelemetryReport {
  // Built in the schema's field order so the logged and wire bodies read the
  // same way the contract does.
  return {
    schema_version: 1,
    instance_id: input.instanceId,
    sent_at: input.now.toISOString(),
    instance: {
      hosting: input.hosting,
      server_version: input.serverVersion,
      mode: input.instance.mode,
      storage_adapter: input.instance.storage_adapter,
      delivery_adapter: input.instance.delivery_adapter,
      database: input.instance.database,
      storage: input.instance.storage,
    },
    snapshot: {
      teams: input.snapshot.teams,
      teams_with_apps: input.snapshot.teamsWithApps,
      apps: input.snapshot.apps,
      deployments: input.snapshot.deployments,
      releases_total: input.snapshot.releasesTotal,
    },
    days: [
      {
        day: input.day.day,
        active_devices: input.day.activeDevices,
        applied: input.day.applied,
        failed: input.day.failed,
        failed_unattributed: input.day.failedUnattributed,
        releases: input.day.releases,
        rollbacks: input.day.rollbacks,
        active_teams: input.day.activeTeams,
        active_apps: input.day.activeApps,
      },
    ],
  };
}

export type TelemetryReportResult =
  | { outcome: "deferred"; retryAfterMs: number }
  | { outcome: "failed"; reason: TelemetryReportFailedReason; status?: number }
  | { outcome: "gone" }
  | { outcome: "rejected"; reason: TelemetryReportRejectedReason; status?: number }
  | { outcome: "sent" };

/** `status`: a 5xx answer; the others never reached a status line. */
export type TelemetryReportFailedReason =
  | "database"
  | "network"
  | "status"
  | "timeout";

/** `status`: a 4xx answer other than 410 and 429. */
export type TelemetryReportRejectedReason = "status" | "too_large";

export interface TelemetryReporter {
  report(): Promise<TelemetryReportResult>;
}

export interface TelemetryReporterOptions {
  endpoint: string;
  fetchImpl?: typeof globalThis.fetch;
  hosting: ServerStatusTopology["hosting"];
  /**
   * `database` and `storage` are the Status page's topology
   * (`resolveServerStatusTopology`), so the report says the same thing the
   * dashboard does and `storage` is `none` for the memory adapter.
   */
  instance: TelemetryReportInput["instance"];
  logger: RuntimeLogger;
  now?: () => number;
  pool: DatabasePool;
  serverVersion: string;
  /** Managed hosting only: the collector's bearer token for that population. */
  token?: string;
}

export function createTelemetryReporter(
  options: TelemetryReporterOptions,
): TelemetryReporter {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const { endpoint, hosting, instance, logger, pool, serverVersion, token } =
    options;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": `codemagic-patch-server/${serverVersion}`,
  };
  if (token !== undefined) {
    headers.authorization = `Bearer ${token}`;
  }

  const readReport = async (): Promise<TelemetryReport> => {
    const instanceId = await ensureInstanceId(pool);
    const sentAt = new Date(now());
    const day = await readReportDay(pool, telemetryReportDay(sentAt));
    const snapshot = await readSnapshot(pool);
    return buildTelemetryReport({
      day,
      hosting,
      instance,
      instanceId,
      now: sentAt,
      serverVersion,
      snapshot,
    });
  };

  return {
    async report() {
      let report: TelemetryReport;
      try {
        report = await readReport();
      } catch (error) {
        logger.warn(
          {
            err: error,
            event: "telemetry.report_failed",
            outcome: "failed",
            reason: "database",
          },
          "usage report could not be read from the database; the next attempt retries",
        );
        return { outcome: "failed", reason: "database" };
      }

      const body = JSON.stringify(report);
      const bytes = Buffer.byteLength(body);
      if (bytes > TELEMETRY_MAX_REPORT_BYTES) {
        logger.warn(
          {
            bytes,
            event: "telemetry.report_failed",
            outcome: "rejected",
            reason: "too_large",
          },
          "usage report exceeds the collector's size limit and was not sent",
        );
        return { outcome: "rejected", reason: "too_large" };
      }

      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          body,
          headers,
          method: "POST",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        const reason = isTimeoutError(error) ? "timeout" : "network";
        logger.warn(
          { err: error, event: "telemetry.report_failed", outcome: "failed", reason },
          "usage report request failed; the next attempt retries",
        );
        return { outcome: "failed", reason };
      }
      // The body is never read; releasing it returns the connection.
      await response.body?.cancel().catch(() => undefined);
      const { status } = response;

      if (response.ok) {
        // The whole report is logged so operators can see exactly what left
        // the server without a debug knob.
        logger.info(
          { event: "telemetry.report_sent", report, status },
          "usage report sent",
        );
        return { outcome: "sent" };
      }
      if (status === 410) {
        logger.warn(
          { event: "telemetry.disabled", reason: "gone", status },
          "collector answered 410 Gone; usage reports stop until the server restarts",
        );
        return { outcome: "gone" };
      }
      if (status === 429) {
        const retryAfterMs = parseRetryAfterMs(
          response.headers.get("retry-after"),
          now(),
        );
        logger.info(
          { event: "telemetry.report_deferred", retryAfterMs, status },
          "collector already has today's usage report; waiting before the next attempt",
        );
        return { outcome: "deferred", retryAfterMs };
      }
      if (status >= 400 && status < 500) {
        logger.warn(
          {
            event: "telemetry.report_failed",
            outcome: "rejected",
            reason: "status",
            status,
          },
          "collector rejected the usage report; not retried until tomorrow",
        );
        return { outcome: "rejected", reason: "status", status };
      }
      logger.warn(
        { event: "telemetry.report_failed", outcome: "failed", reason: "status", status },
        "collector could not take the usage report; the next attempt retries",
      );
      return { outcome: "failed", reason: "status", status };
    },
  };
}

/**
 * `Retry-After` as delay-seconds or an HTTP-date, in milliseconds from
 * `nowMs`. Missing or unreadable falls back to an hour; anything is capped
 * at a day so a collector cannot park a sender for longer than the next
 * report is worth.
 */
export function parseRetryAfterMs(
  header: string | null,
  nowMs: number,
): number {
  if (header !== null) {
    const value = header.trim();
    if (/^\d+$/.test(value)) {
      return Math.min(Number.parseInt(value, 10) * 1000, MAX_RETRY_AFTER_MS);
    }
    const dateMs = Date.parse(value);
    if (!Number.isNaN(dateMs)) {
      return Math.min(Math.max(0, dateMs - nowMs), MAX_RETRY_AFTER_MS);
    }
  }
  return DEFAULT_RETRY_AFTER_MS;
}

/** `AbortSignal.timeout` aborts with a `TimeoutError`; older runtimes said `AbortError`. */
function isTimeoutError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}
