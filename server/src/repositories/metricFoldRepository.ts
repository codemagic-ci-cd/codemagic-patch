import type { PoolClient } from "pg";

import { withTransaction, type DatabasePool } from "../db";
import { addUtcDays, foldCutoff, utcDay } from "../domain";

export interface FoldExpiredMetricDaysOptions {
  now: Date;
  /**
   * Called as each day commits. A first run can work through months of
   * backlog, and a run that fails part-way still reports the days it folded.
   */
  onDayFolded?: (result: MetricFoldDayResult) => void;
  /**
   * Checked before each day and again once the watermark lock is granted; a
   * day already started always finishes.
   */
  shouldStop?: () => boolean;
}

export interface MetricFoldDayResult {
  /** 00:00Z of the folded UTC day. */
  day: Date;
  /** Raw rows deleted, keyed by event name after `Installed`/`Success` map to `Ready`/`Applied`. */
  deletedEventCounts: Record<string, number>;
  /** From the watermark lock being granted, so time spent queued is excluded. */
  durationMs: number;
}

/**
 * Keeps the fold's scan to the days not yet folded, reading the watermark on
 * the statement's own snapshot. Metric reads leave it out and read every raw
 * row (`listDeploymentTimeseries` in `metricsRepository.ts` says why).
 */
const UNFOLDED_METRIC_EVENT_SQL = `emitted_at >= COALESCE(
  (SELECT folded_before::timestamp AT TIME ZONE 'UTC' FROM metric_event_fold_state),
  '-infinity'
)`;

/**
 * Folds every UTC day before the raw retention cutoff into the daily
 * aggregate tables and deletes its raw rows, one transaction per day.
 *
 * Days with no raw rows are skipped rather than walked: a device with a wrong
 * clock can leave an event decades back, and stepping through every day in
 * between would cost one transaction each for nothing.
 */
export async function foldExpiredMetricDays(
  pool: DatabasePool,
  options: FoldExpiredMetricDaysOptions,
): Promise<MetricFoldDayResult[]> {
  const cutoff = foldCutoff(options.now);
  const results: MetricFoldDayResult[] = [];

  while (!options.shouldStop?.()) {
    const result = await withTransaction(pool, (client) =>
      foldNextMetricDay(client, cutoff, options.shouldStop),
    );
    if (result === null) {
      break;
    }

    results.push(result);
    options.onDayFolded?.(result);
  }

  return results;
}

async function foldNextMetricDay(
  client: PoolClient,
  cutoff: Date,
  shouldStop: (() => boolean) | undefined,
): Promise<MetricFoldDayResult | null> {
  // The watermark row lock serializes folds across instances, and against
  // the deployment and app management that rewrites raw rows
  // (`waitForMetricFold`). Ingest never reaches a day being folded, so it
  // does not take it. Every query after it runs on a fresh snapshot, so a
  // fold that waited here sees the days the other one already moved.
  await client.query("SELECT 1 FROM metric_event_fold_state FOR UPDATE");
  // A stop requested while this waited for the lock should not start a day
  // that shutdown then has to wait out.
  if (shouldStop?.()) {
    return null;
  }
  const lockedAt = Date.now();

  // Bounded below by the watermark so the index scan starts past the dead
  // entries every folded day leaves behind until vacuum reclaims them.
  const earliest = await client.query<{ emitted_at: Date | null }>(
    `
      SELECT MIN(emitted_at) AS emitted_at
      FROM metric_event
      WHERE ${UNFOLDED_METRIC_EVENT_SQL}
    `,
  );
  const earliestAt = earliest.rows[0]?.emitted_at ?? null;
  const day = earliestAt === null ? null : utcDay(earliestAt);

  if (day === null || day.getTime() >= cutoff.getTime()) {
    await advanceFoldWatermark(client, cutoff);
    return null;
  }

  const nextDay = addUtcDays(day, 1);
  const deleted = await client.query<{ deleted_count: number; event_name: string }>(
    FOLD_DAY_SQL,
    [day, nextDay],
  );
  await advanceFoldWatermark(client, nextDay);

  return {
    day,
    deletedEventCounts: Object.fromEntries(
      deleted.rows.map((row) => [row.event_name, row.deleted_count]),
    ),
    durationMs: Date.now() - lockedAt,
  };
}

async function advanceFoldWatermark(
  client: PoolClient,
  foldedBefore: Date,
): Promise<void> {
  await client.query(
    `
      UPDATE metric_event_fold_state
      SET folded_before = GREATEST(folded_before, ($1::timestamptz AT TIME ZONE 'UTC')::date),
          updated_at = now()
    `,
    [foldedBefore],
  );
}

/**
 * Moves the raw rows of `[$1, $2)`, one UTC day, into the aggregate tables.
 *
 * One statement, aggregating exactly the rows its DELETE returned, so the
 * rows counted and the rows removed cannot differ. An `Applied` deleting the
 * same day's `Failed` at the same moment (failure supersession) decides only
 * whether that failure is counted, never whether it is counted twice.
 * PostgreSQL runs each data-modifying CTE to completion exactly once even
 * though the final SELECT reads only `moved`.
 *
 * Historical `Installed`/`Success` are stored under `Ready`/`Applied`, so the
 * aggregate side of every read can ignore the old names. The failure reason,
 * code, message, and exit-reason expressions match the raw reads in
 * `metricsRepository.ts`; message and exit reason are kept so the failure
 * distributions stay cumulative like the code counts they break down.
 *
 * Active devices are not additive, so each device is counted under every
 * key a timeseries filter can ask for: `all`, its `exact` version, and one
 * `prefix` per leading run of dot-separated components (`1`, `1.2`, `1.2.3`
 * for `1.2.3`). Those are exactly the prefixes `binaryVersionMatchSql`
 * matches the version against. GROUPING SETS yields the per-package and the
 * deployment-wide count in one pass, so a device active on several packages
 * that day, or seen under two versions, is still counted once per key. The
 * keys are compared in the C collation: these sorts are most of the fold's
 * time, byte comparison costs a fraction of the database locale's, and a
 * deterministic collation treats only identical bytes as equal, so the same
 * devices are counted.
 */
const FOLD_DAY_SQL = `
  WITH moved AS (
    DELETE FROM metric_event
    WHERE emitted_at >= $1
      AND emitted_at < $2
    RETURNING
      deployment_id,
      target_package_hash,
      binary_version,
      device_id,
      emitted_at,
      CASE event_name
        WHEN 'Installed' THEN 'Ready'
        WHEN 'Success' THEN 'Applied'
        ELSE event_name
      END AS event_name,
      attributes,
      failure_payload
  ),
  counted AS (
    INSERT INTO metric_event_daily_count (
      deployment_id,
      day,
      target_package_hash,
      binary_version,
      event_name,
      delivery_type,
      event_count
    )
    SELECT
      deployment_id,
      ($1::timestamptz AT TIME ZONE 'UTC')::date,
      target_package_hash,
      binary_version,
      event_name,
      CASE WHEN event_name = 'Downloaded' THEN attributes ->> 'delivery_type' END AS delivery_type,
      COUNT(*)
    FROM moved
    GROUP BY deployment_id, target_package_hash, binary_version, event_name, delivery_type
  ),
  counted_failures AS (
    INSERT INTO metric_failure_daily_count (
      deployment_id,
      day,
      target_package_hash,
      reason,
      code,
      message,
      exit_reason,
      event_count,
      first_seen_at,
      last_seen_at
    )
    SELECT
      deployment_id,
      ($1::timestamptz AT TIME ZONE 'UTC')::date,
      target_package_hash,
      COALESCE(NULLIF(attributes ->> 'reason', ''), 'unknown') AS reason,
      NULLIF(failure_payload ->> 'code', '') AS code,
      NULLIF(failure_payload ->> 'message', '') AS message,
      NULLIF(failure_payload ->> 'android_previous_process_exit', '') AS exit_reason,
      COUNT(*),
      MIN(emitted_at),
      MAX(emitted_at)
    FROM moved
    WHERE event_name = 'Failed'
    GROUP BY deployment_id, target_package_hash, reason, code, message, exit_reason
  ),
  active_devices AS (
    SELECT DISTINCT
      deployment_id COLLATE "C" AS deployment_id,
      target_package_hash COLLATE "C" AS target_package_hash,
      binary_version COLLATE "C" AS binary_version,
      device_id COLLATE "C" AS device_id
    FROM moved
    WHERE event_name = 'Active'
  ),
  active_device_keys AS (
    SELECT
      deployment_id,
      target_package_hash,
      device_id,
      'all' AS version_filter,
      '' AS version_value
    FROM active_devices
    UNION ALL
    SELECT deployment_id, target_package_hash, device_id, 'exact', binary_version
    FROM active_devices
    WHERE binary_version IS NOT NULL
    UNION ALL
    SELECT
      deployment_id,
      target_package_hash,
      device_id,
      'prefix',
      array_to_string((string_to_array(binary_version, '.'))[1:depth], '.')
    FROM active_devices
    CROSS JOIN LATERAL generate_series(
      1,
      cardinality(string_to_array(binary_version, '.'))
    ) AS depth
    WHERE binary_version IS NOT NULL
  ),
  counted_active_devices AS (
    INSERT INTO metric_active_device_daily_count (
      deployment_id,
      day,
      scope,
      target_package_hash,
      version_filter,
      version_value,
      device_count
    )
    SELECT
      deployment_id,
      ($1::timestamptz AT TIME ZONE 'UTC')::date,
      CASE WHEN GROUPING(target_package_hash) = 1 THEN 'deployment' ELSE 'package' END,
      target_package_hash,
      version_filter,
      version_value,
      COUNT(DISTINCT device_id)
    FROM active_device_keys
    GROUP BY GROUPING SETS (
      (deployment_id, version_filter, version_value, target_package_hash),
      (deployment_id, version_filter, version_value)
    )
  )
  SELECT event_name, COUNT(*)::integer AS deleted_count
  FROM moved
  GROUP BY event_name
`;
