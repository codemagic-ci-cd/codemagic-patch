import { randomUUID } from "node:crypto";

import type { DatabasePool } from "../db";

/**
 * Reads behind the daily usage report (`app/telemetryReport.ts`). Everything
 * here is read-only except `ensureInstanceId`. The day's counts come from the
 * raw `metric_event` rows of that UTC day (it is always inside the raw
 * retention window, never folded yet) and from `release`; only counts leave
 * the database, never a device id, failure reason, or package hash.
 *
 * The day is passed as `YYYY-MM-DD` text and bounded in UTC in SQL, so the
 * server's own time zone never shifts it.
 */

/** Counts of one UTC day; every value is zero when the day had no data. */
export interface TelemetryReportDayCounts {
  activeApps: number;
  activeDevices: number;
  activeTeams: number;
  applied: number;
  /** UTC calendar date, `YYYY-MM-DD`. */
  day: string;
  failed: number;
  failedUnattributed: number;
  releases: number;
  rollbacks: number;
}

export interface TelemetryReportSnapshot {
  apps: number;
  deployments: number;
  releasesTotal: number;
  teams: number;
  teamsWithApps: number;
}

/**
 * The installation's id, minted on the first call and stable afterwards.
 * `ON CONFLICT DO NOTHING` on the singleton key makes concurrent first
 * calls agree on one id; the read that follows returns whichever won.
 */
export async function ensureInstanceId(pool: DatabasePool): Promise<string> {
  await pool.query(
    `
      INSERT INTO server_instance (instance_id)
      VALUES ($1)
      ON CONFLICT (singleton) DO NOTHING
    `,
    [randomUUID()],
  );
  const result = await pool.query<{ instance_id: string }>(
    "SELECT instance_id FROM server_instance",
  );
  const instanceId = result.rows[0]?.instance_id;
  if (instanceId === undefined) {
    throw new Error("server_instance has no row after insert");
  }
  return instanceId;
}

/** The counts of one UTC day, `YYYY-MM-DD`; zeros when it had no data. */
export async function readReportDay(
  pool: DatabasePool,
  day: string,
): Promise<TelemetryReportDayCounts> {
  const params = [day];
  const [activeDevices, events, releases] = await Promise.all([
    pool.query<{ active_devices: number }>(ACTIVE_DEVICES_SQL, params),
    pool.query<{
      active_apps: number;
      active_teams: number;
      applied: number;
      failed: number;
      failed_unattributed: number;
    }>(EVENTS_SQL, params),
    pool.query<{ releases: number; rollbacks: number }>(RELEASES_SQL, params),
  ]);
  const deviceRow = activeDevices.rows[0];
  const eventRow = events.rows[0];
  const releaseRow = releases.rows[0];
  if (deviceRow === undefined || eventRow === undefined || releaseRow === undefined) {
    throw new Error("day count query returned no row");
  }
  return {
    activeApps: eventRow.active_apps,
    activeDevices: deviceRow.active_devices,
    activeTeams: eventRow.active_teams,
    applied: eventRow.applied,
    day,
    failed: eventRow.failed,
    failedUnattributed: eventRow.failed_unattributed,
    releases: releaseRow.releases,
    rollbacks: releaseRow.rollbacks,
  };
}

/** Point-in-time totals at send time. */
export async function readSnapshot(
  pool: DatabasePool,
): Promise<TelemetryReportSnapshot> {
  const result = await pool.query<{
    apps: number;
    deployments: number;
    releases_total: number;
    teams: number;
    teams_with_apps: number;
  }>(SNAPSHOT_SQL);
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("snapshot query returned no row");
  }
  return {
    apps: row.apps,
    deployments: row.deployments,
    releasesTotal: row.releases_total,
    teams: row.teams,
    teamsWithApps: row.teams_with_apps,
  };
}

/** The UTC day `$1` as a half-open `emitted_at` range, served by `idx_metric_event_emitted_at`. */
const DAY_RANGE = `
  emitted_at >= $1::date::timestamp AT TIME ZONE 'UTC'
  AND emitted_at < ($1::date + 1)::timestamp AT TIME ZONE 'UTC'
`;

/**
 * Active devices are not additive, so the day's figure is the sum of each
 * deployment's own distinct count of devices that sent `Active`.
 */
const ACTIVE_DEVICES_SQL = `
  SELECT COALESCE(SUM(device_count), 0)::integer AS active_devices
  FROM (
    SELECT COUNT(DISTINCT device_id) AS device_count
    FROM metric_event
    WHERE event_name = 'Active' AND ${DAY_RANGE}
    GROUP BY deployment_id
  ) per_deployment
`;

/**
 * Applied and failed with a target package hash are the success-rate pair;
 * failures without one are reported apart so nothing is dropped silently.
 * Historical `Success` rows count as `Applied`, as the fold and the
 * dashboard count them. Active teams and apps count any event name. Grouping by (team, app) first
 * keeps the distinct counts to a few thousand groups instead of sorting the
 * whole day: an app belongs to one team, so each group is one app.
 */
const EVENTS_SQL = `
  SELECT
    COALESCE(SUM(applied), 0)::integer AS applied,
    COALESCE(SUM(failed), 0)::integer AS failed,
    COALESCE(SUM(failed_unattributed), 0)::integer AS failed_unattributed,
    COUNT(DISTINCT team_id)::integer AS active_teams,
    COUNT(*)::integer AS active_apps
  FROM (
    SELECT
      team_id,
      app_id,
      COUNT(*) FILTER (
        WHERE event_name IN ('Applied', 'Success') AND target_package_hash IS NOT NULL
      ) AS applied,
      COUNT(*) FILTER (
        WHERE event_name = 'Failed' AND target_package_hash IS NOT NULL
      ) AS failed,
      COUNT(*) FILTER (
        WHERE event_name = 'Failed' AND target_package_hash IS NULL
      ) AS failed_unattributed
    FROM metric_event
    WHERE ${DAY_RANGE}
    GROUP BY team_id, app_id
  ) per_app
`;

/**
 * Releases created that UTC day, split into operator rollbacks
 * (`rollback_of` set) and everything else. SDK crash rollbacks are device
 * events, not releases, and are never counted here.
 */
const RELEASES_SQL = `
  SELECT
    COUNT(*) FILTER (WHERE rollback_of IS NULL)::integer AS releases,
    COUNT(*) FILTER (WHERE rollback_of IS NOT NULL)::integer AS rollbacks
  FROM release
  WHERE status IN ('published', 'disabled')
    AND created_at >= $1::date::timestamp AT TIME ZONE 'UTC'
    AND created_at < ($1::date + 1)::timestamp AT TIME ZONE 'UTC'
`;

const SNAPSHOT_SQL = `
  SELECT
    (SELECT COUNT(*) FROM team WHERE status = 'active')::integer AS teams,
    (SELECT COUNT(DISTINCT team_id) FROM app)::integer AS teams_with_apps,
    (SELECT COUNT(*) FROM app)::integer AS apps,
    (SELECT COUNT(*) FROM deployment)::integer AS deployments,
    (
      SELECT COUNT(*) FROM release WHERE status IN ('published', 'disabled')
    )::integer AS releases_total
`;
