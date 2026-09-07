import type { Pool } from "pg";

import type {
  DeploymentId,
  FailureCodeBreakdownList,
  FailureDistribution,
  FailureDistributionEntry,
  FailureEventPage,
  MetricEvent,
  MetricEventName,
  ReleaseMetrics,
} from "../domain";
import { withTransaction, type DatabasePool } from "../db";
import {
  mapMetricEventRow,
  type DeploymentRow,
  type MetricEventRow,
} from "./rowMappers";

export interface PersistMetricEventInput {
  attributes: Record<string, unknown> | null;
  binaryVersion: string | null;
  deploymentKey: string;
  deviceId: string;
  emittedAt: Date;
  eventId: string;
  eventName: MetricEventName;
  failurePayload: Record<string, unknown> | null;
  id: string;
  platform: string | null;
  runningPackageHash: string | null;
  sdkVersion: string | null;
  targetPackageHash: string | null;
}

export type PersistMetricEventResult =
  | {
      event: MetricEvent;
      outcome: "created";
    }
  | {
      event: MetricEvent;
      outcome: "duplicate";
    }
  | {
      outcome: "not_found";
      reason: "deployment_not_found";
    }
  | {
      /**
       * A `Failed` event for a package the device has already reported
       * `Success` for. Nothing was stored.
       */
      outcome: "superseded";
    };

export interface TimeseriesBucketRow {
  activeDevices: number;
  bucketStart: Date;
  downloaded: number;
  failed: number;
  installed: number;
  success: number;
}

export interface DeploymentTimeseriesRows {
  /** One series per selected target_package_hash, ranked by in-range volume. */
  series: Array<{
    points: TimeseriesBucketRow[];
    targetPackageHash: string | null;
  }>;
  seriesTruncated: boolean;
  /** Deployment-wide rollup: each device counted once per bucket. */
  totals: TimeseriesBucketRow[];
}

export interface ListFailureCodesOptions {
  /** Exactly one reason; the reason rows themselves come from the counters. */
  reason: string;
  /** Null aggregates every target hash in the deployment. */
  targetPackageHashes: readonly string[] | null;
}

export interface ListFailureBucketOptions extends ListFailureCodesOptions {
  /** Null selects the bucket of failures whose payload carried no code. */
  code: string | null;
}

export interface ListFailureDistributionOptions
  extends ListFailureBucketOptions {
  /** Entries kept per axis; the rest of the tail is counted but not listed. */
  limit: number;
}

export interface ListFailureEventsOptions extends ListFailureBucketOptions {
  /** Opaque `(emitted_at, id)` cursor; null starts at the newest event. */
  cursor: string | null;
  limit: number;
}

export interface MetricsRepository {
  listDeploymentTimeseries(
    deploymentId: DeploymentId,
    range: { from: Date; seriesLimit: number; to: Date },
  ): Promise<DeploymentTimeseriesRows>;
  listFailureCodes(
    deploymentId: DeploymentId,
    options: ListFailureCodesOptions,
  ): Promise<FailureCodeBreakdownList>;
  listFailureDistribution(
    deploymentId: DeploymentId,
    options: ListFailureDistributionOptions,
  ): Promise<FailureDistribution>;
  listFailureEvents(
    deploymentId: DeploymentId,
    options: ListFailureEventsOptions,
  ): Promise<FailureEventPage>;
  listReleaseMetricsForDeployment(
    deploymentId: DeploymentId,
    targetPackageHashes: Array<string | null>,
  ): Promise<Map<string, ReleaseMetrics>>;
  persistMetricEvent(
    input: PersistMetricEventInput,
  ): Promise<PersistMetricEventResult>;
}

interface Queryable {
  query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

export const ZERO_RELEASE_METRICS: ReleaseMetrics = {
  active: 0,
  downloaded: 0,
  failed: 0,
  failureReasonDetailCounts: {},
  failureReasons: {},
  installed: 0,
  success: 0,
};

export function createPostgresMetricsRepository(
  pool: DatabasePool | Pool,
): MetricsRepository {
  return {
    async persistMetricEvent(input) {
      const deployment = await findDeploymentByKey(pool, input.deploymentKey);
      if (!deployment) {
        return {
          outcome: "not_found",
          reason: "deployment_not_found",
        };
      }

      const targetPackageHash = input.targetPackageHash;
      if (
        targetPackageHash === null ||
        (input.eventName !== "Failed" && input.eventName !== "Success")
      ) {
        return insertMetricEvent(pool, deployment, input);
      }

      // Failure supersession (server tech spec §Metrics Service → Failure
      // Supersession). A device that reports `Success` for a package got
      // there in the end, so the `Failed` events it reported for that package
      // on the way were transient — a retry that worked — and are removed
      // rather than left to count against the release forever. A device does
      // not fail an update it has already confirmed, so once its `Success` is
      // stored any `Failed` it sends for the same package is ignored: one that
      // arrives late because the client flushes and retries in batches, or a
      // retransmission of one the `Success` already deleted.
      //
      // The advisory lock serializes the two paths per device and package.
      // Without it, under READ COMMITTED, a `Failed` whose check ran before
      // the `Success` committed and whose insert ran after the `Success`'s
      // DELETE would slip through both and stick. The key is only ever hashed,
      // so a collision costs nothing but an unrelated device waiting its turn.
      return withTransaction(pool, async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [[deployment.id, input.deviceId, targetPackageHash].join("\n")],
        );

        const scope = [deployment.id, input.deviceId, targetPackageHash];

        if (input.eventName === "Failed") {
          const succeeded = await client.query(
            `
              SELECT 1
              FROM metric_event
              WHERE deployment_id = $1
                AND device_id = $2
                AND target_package_hash = $3
                AND event_name = 'Success'
              LIMIT 1
            `,
            scope,
          );
          if (succeeded.rows.length > 0) {
            return { outcome: "superseded" };
          }
        } else {
          await client.query(
            `
              DELETE FROM metric_event
              WHERE deployment_id = $1
                AND device_id = $2
                AND target_package_hash = $3
                AND event_name = 'Failed'
            `,
            scope,
          );
        }

        return insertMetricEvent(client, deployment, input);
      });
    },

    async listDeploymentTimeseries(deploymentId, range) {
      // One GROUPING SETS pass yields both the per-hash series rows and the
      // deployment-wide rollup. Ranking happens over those bucketed rows so
      // only the requested number of series leaves PostgreSQL, while totals
      // still cover every hash in the range.
      const result = await pool.query<{
        active_devices: number;
        bucket_start: Date;
        downloaded: number;
        failed: number;
        installed: number;
        is_total: boolean;
        series_truncated: boolean;
        success: number;
        target_package_hash: string | null;
      }>(
        `
          WITH bucketed AS MATERIALIZED (
            SELECT
              date_trunc('day', emitted_at) AS bucket_start,
              target_package_hash,
              (GROUPING(target_package_hash) = 1) AS is_total,
              COUNT(DISTINCT device_id) FILTER (WHERE event_name = 'Active')::integer AS active_devices,
              COUNT(*) FILTER (WHERE event_name = 'Downloaded')::integer AS downloaded,
              COUNT(*) FILTER (WHERE event_name = 'Installed')::integer AS installed,
              COUNT(*) FILTER (WHERE event_name = 'Success')::integer AS success,
              COUNT(*) FILTER (WHERE event_name = 'Failed')::integer AS failed
            FROM metric_event
            WHERE deployment_id = $1
              AND emitted_at >= $2
              AND emitted_at < $3
              AND event_name = ANY('{Downloaded,Installed,Success,Failed,Active}')
            GROUP BY GROUPING SETS (
              (date_trunc('day', emitted_at), target_package_hash),
              (date_trunc('day', emitted_at))
            )
          ),
          ranked_hashes AS (
            SELECT
              target_package_hash,
              ROW_NUMBER() OVER (
                ORDER BY
                  SUM(active_devices + downloaded + installed + success + failed) DESC,
                  target_package_hash ASC NULLS LAST
              ) AS series_rank
            FROM bucketed
            WHERE NOT is_total
            GROUP BY target_package_hash
          )
          SELECT
            bucketed.active_devices,
            bucketed.bucket_start,
            bucketed.downloaded,
            bucketed.failed,
            bucketed.installed,
            bucketed.is_total,
            (SELECT COUNT(*) > $4 FROM ranked_hashes) AS series_truncated,
            bucketed.success,
            bucketed.target_package_hash
          FROM bucketed
          LEFT JOIN ranked_hashes
            ON NOT bucketed.is_total
            AND bucketed.target_package_hash IS NOT DISTINCT FROM ranked_hashes.target_package_hash
          WHERE bucketed.is_total OR ranked_hashes.series_rank <= $4
          ORDER BY ranked_hashes.series_rank NULLS LAST, bucketed.bucket_start
        `,
        [deploymentId, range.from, range.to, range.seriesLimit],
      );

      const totals: TimeseriesBucketRow[] = [];
      const pointsByHash = new Map<string | null, TimeseriesBucketRow[]>();
      const seriesTruncated = result.rows[0]?.series_truncated ?? false;

      for (const row of result.rows) {
        const bucket: TimeseriesBucketRow = {
          activeDevices: row.active_devices,
          bucketStart: row.bucket_start,
          downloaded: row.downloaded,
          failed: row.failed,
          installed: row.installed,
          success: row.success,
        };

        if (row.is_total) {
          totals.push(bucket);
          continue;
        }

        const points = pointsByHash.get(row.target_package_hash);
        if (points) {
          points.push(bucket);
        } else {
          pointsByHash.set(row.target_package_hash, [bucket]);
        }
      }

      const series = [...pointsByHash.entries()].map(
        ([targetPackageHash, points]) => ({ points, targetPackageHash }),
      );

      return { series, seriesTruncated, totals };
    },

    async listReleaseMetricsForDeployment(deploymentId, targetPackageHashes) {
      const uniqueHashes = [...new Set(targetPackageHashes)].filter(
        (hash): hash is string => hash !== null,
      );
      const metrics = new Map<string, ReleaseMetrics>();

      for (const hash of uniqueHashes) {
        // Fresh failureReasons per entry — the shared constant's empty object
        // must not be mutated through one deployment's breakdown.
        metrics.set(hash, {
          ...ZERO_RELEASE_METRICS,
          failureReasonDetailCounts: {},
          failureReasons: {},
        });
      }

      if (uniqueHashes.length === 0) {
        return metrics;
      }

      const result = await pool.query<{
        active: number;
        downloaded: number;
        failed: number;
        installed: number;
        success: number;
        target_package_hash: string;
      }>(
        `
          SELECT
            target_package_hash,
            COUNT(*) FILTER (WHERE event_name = 'Active')::integer AS active,
            COUNT(*) FILTER (WHERE event_name = 'Downloaded')::integer AS downloaded,
            COUNT(*) FILTER (WHERE event_name = 'Failed')::integer AS failed,
            COUNT(*) FILTER (WHERE event_name = 'Installed')::integer AS installed,
            COUNT(*) FILTER (WHERE event_name = 'Success')::integer AS success
          FROM metric_event
          WHERE deployment_id = $1
            AND target_package_hash = ANY($2::text[])
          GROUP BY target_package_hash
        `,
        [deploymentId, uniqueHashes],
      );

      for (const row of result.rows) {
        metrics.set(row.target_package_hash, {
          active: row.active,
          downloaded: row.downloaded,
          failed: row.failed,
          failureReasons: {},
          failureReasonDetailCounts: {},
          installed: row.installed,
          success: row.success,
        });
      }

      // `detail_count` rides along with the reason counts because the
      // dashboard needs it to decide whether a reason row is worth opening:
      // a reason no device ever sent a payload for has nothing behind it, and
      // offering a drill-down into an empty dialog is a dead end.
      const reasons = await pool.query<{
        count: number;
        detail_count: number;
        reason: string;
        target_package_hash: string;
      }>(
        `
          SELECT
            target_package_hash,
            COALESCE(NULLIF(attributes ->> 'reason', ''), 'unknown') AS reason,
            COUNT(*)::integer AS count,
            COUNT(*) FILTER (WHERE failure_payload IS NOT NULL)::integer AS detail_count
          FROM metric_event
          WHERE deployment_id = $1
            AND target_package_hash = ANY($2::text[])
            AND event_name = 'Failed'
          GROUP BY target_package_hash, reason
        `,
        [deploymentId, uniqueHashes],
      );

      for (const row of reasons.rows) {
        const entry = metrics.get(row.target_package_hash);
        if (entry) {
          entry.failureReasons[row.reason] = row.count;
          if (row.detail_count > 0) {
            entry.failureReasonDetailCounts[row.reason] = row.detail_count;
          }
        }
      }

      return metrics;
    },

    async listFailureCodes(deploymentId, options) {
      // Whole list, not a page. The value space is the enumerable set of HTTP
      // statuses plus two sentinels, so this is bounded by the payload
      // contract rather than by how much data the deployment has accumulated —
      // the same reason the reason counts it drills into are returned whole.
      const values: unknown[] = [];
      const bind = (value: unknown): string => `$${String(values.push(value))}`;
      const deployment = bind(deploymentId);
      const reason = bind(options.reason);
      const hashes = hashPredicate(options.targetPackageHashes, bind);

      const result = await pool.query<{
        code: string | null;
        code_count: number;
        first_seen_at: Date;
        last_seen_at: Date;
      }>(
        `
          SELECT
            NULLIF(failure_payload ->> 'code', '') AS code,
            COUNT(*)::integer AS code_count,
            MIN(emitted_at) AS first_seen_at,
            MAX(emitted_at) AS last_seen_at
          FROM metric_event
          WHERE deployment_id = ${deployment}
            AND event_name = 'Failed'
            AND COALESCE(NULLIF(attributes ->> 'reason', ''), 'unknown') = ${reason}
            ${hashes ?? ""}
          GROUP BY 1
          ORDER BY code_count DESC, code ASC NULLS LAST
        `,
        values,
      );

      return {
        codes: result.rows.map((row) => ({
          code: row.code,
          count: row.code_count,
          firstSeenAt: row.first_seen_at,
          lastSeenAt: row.last_seen_at,
        })),
      };
    },

    async listFailureDistribution(deploymentId, options) {
      // One pass over the bucket yields both distributions and the bucket
      // total: GROUPING SETS lets a single scan feed three independent
      // groupings, where three queries would each re-read the same rows.
      //
      // Ranking happens in SQL so only the surviving rows cross the wire. The
      // bucket can hold tens of thousands of events; what leaves PostgreSQL is
      // two capped axes plus one total row.
      const bucket = failureBucketClauses(deploymentId, options);
      const limit = bucket.bind(options.limit);
      const result = await pool.query<{
        entry_count: number;
        exit_reason: string | null;
        is_total: boolean;
        message: string | null;
      }>(
        `
          WITH matched AS (
            SELECT
              NULLIF(failure_payload ->> 'message', '') AS message,
              NULLIF(failure_payload ->> 'android_previous_process_exit', '')
                AS exit_reason
            FROM metric_event
            ${bucket.where}
          ),
          grouped AS (
            SELECT
              message,
              exit_reason,
              GROUPING(message, exit_reason) = 3 AS is_total,
              COUNT(*)::integer AS entry_count
            FROM matched
            GROUP BY GROUPING SETS ((message), (exit_reason), ())
          ),
          ranked AS (
            SELECT
              entry_count,
              exit_reason,
              is_total,
              message,
              ROW_NUMBER() OVER (
                PARTITION BY is_total, (message IS NULL)
                ORDER BY entry_count DESC, COALESCE(message, exit_reason) ASC
              )::integer AS rank_in_axis
            FROM grouped
            WHERE is_total OR COALESCE(message, exit_reason) IS NOT NULL
          )
          SELECT
            entry_count,
            exit_reason,
            is_total,
            message
          FROM ranked
          WHERE is_total OR rank_in_axis <= ${limit}
          ORDER BY is_total, (message IS NULL), rank_in_axis
        `,
        bucket.values,
      );

      const exitReasons: FailureDistributionEntry[] = [];
      const messages: FailureDistributionEntry[] = [];
      let total = 0;

      for (const row of result.rows) {
        if (row.is_total) {
          total = row.entry_count;
          continue;
        }
        if (row.message !== null) {
          messages.push({ count: row.entry_count, value: row.message });
        } else if (row.exit_reason !== null) {
          exitReasons.push({ count: row.entry_count, value: row.exit_reason });
        }
      }

      return { exitReasons, messages, total };
    },

    async listFailureEvents(deploymentId, options) {
      // Keyset, not offset: `metric_event` is written continuously, so an
      // offset shifts under the reader between requests and the feed would
      // repeat or skip rows. `(emitted_at, id)` is unique because `id` is the
      // primary key, which is what makes the boundary total rather than merely
      // usually-total.
      //
      // One row beyond the page is requested so the cursor is only issued when
      // a next page genuinely exists.
      const cursor = decodeFailureEventCursor(options.cursor);
      const bucket = failureBucketClauses(deploymentId, options);
      const cursorAt = bucket.bind(cursor?.emittedAt ?? null);
      const cursorId = bucket.bind(cursor?.id ?? null);
      const limit = bucket.bind(options.limit + 1);

      const result = await pool.query<MetricEventRow>(
        `
          SELECT id, emitted_at, device_id, failure_payload
          FROM metric_event
          ${bucket.where}
            AND (
              ${cursorAt}::timestamptz IS NULL
              OR (emitted_at, id) < (${cursorAt}::timestamptz, ${cursorId}::text)
            )
          ORDER BY emitted_at DESC, id DESC
          LIMIT ${limit}
        `,
        bucket.values,
      );

      const page = result.rows.slice(0, options.limit);
      const last = page[page.length - 1];

      return {
        events: page.map((row) => ({
          androidPreviousProcessExit: failurePayloadString(
            row.failure_payload,
            "android_previous_process_exit",
          ),
          deviceId: row.device_id,
          emittedAt: row.emitted_at,
          id: row.id,
          message: failurePayloadString(row.failure_payload, "message"),
        })),
        nextCursor:
          result.rows.length > options.limit && last
            ? encodeFailureEventCursor(last.emitted_at, last.id)
            : null,
      };
    },
  };
}

/**
 * Builds the `WHERE` clause selecting one `payload.code` bucket, plus the
 * bound values it needs.
 *
 * Parameter positions are assigned as placeholders are emitted rather than
 * written out, because the clause has a variable number of them: the no-code
 * bucket binds no `code` value at all. Hard-coding `$3`, `$4` … silently
 * shifts every later placeholder by one whenever that happens.
 *
 * The `code` match is branched rather than written as `IS NOT DISTINCT FROM`.
 * NULL is a real bucket — failures whose payload carried no code — but that
 * operator cannot use a btree index, so covering both cases with it would
 * forfeit `idx_metric_event_failure_feed` on every query. `IS NULL` and `=`
 * are both indexable.
 */
function failureBucketClauses(
  deploymentId: DeploymentId,
  options: { code: string | null; reason: string } & {
    targetPackageHashes: readonly string[] | null;
  },
): { bind: (value: unknown) => string; values: unknown[]; where: string } {
  const values: unknown[] = [];
  const bind = (value: unknown): string => `$${String(values.push(value))}`;

  const deployment = bind(deploymentId);
  const reason = bind(options.reason);
  const code =
    options.code === null
      ? "NULLIF(failure_payload ->> 'code', '') IS NULL"
      : `NULLIF(failure_payload ->> 'code', '') = ${bind(options.code)}`;
  const hashes = hashPredicate(options.targetPackageHashes, bind);

  return {
    bind,
    values,
    where: `
      WHERE deployment_id = ${deployment}
        AND event_name = 'Failed'
        AND COALESCE(NULLIF(attributes ->> 'reason', ''), 'unknown') = ${reason}
        AND ${code}
        ${hashes ?? ""}
    `,
  };
}

/**
 * SQL for the `target_package_hash` restriction, or `null` when the scope
 * covers every hash.
 *
 * Written as a plain equality for the single-hash case, which is the only one
 * that occurs: a release scopes to its own hash, a deployment scopes to none.
 * The hash is not part of `idx_metric_event_failure_feed`, so it is evaluated
 * as a per-row `Filter` whichever form it takes — the plan and the number of
 * rows read are identical either way. What changes is the cost of testing one
 * row: `= ANY(array)` deconstructs an array and loops over it, while `=` is a
 * single comparison. That difference is invisible on the event feed, which
 * stops after 25 matches, and adds up on the aggregates, which scan the whole
 * reason. Measured over 62,500 rows: 37.7 ms as `($n IS NULL OR hash =
 * ANY($n))`, 19.6 ms as `hash = $n`.
 *
 * The `IS NULL OR` wrapper itself is free — the planner folds the branch away
 * once it knows the array is not null — but it forces the `ANY` form on the
 * remaining branch, which is the part that costs.
 */
function hashPredicate(
  hashes: readonly string[] | null,
  bind: (value: unknown) => string,
): string | null {
  if (hashes === null) {
    return null;
  }

  // A release whose bundle has not finished processing has no hash yet — the
  // worker fills it in after computing it — so nothing can be attributed to
  // it. Matching nothing is the correct answer; falling through to an
  // unrestricted scan would report the whole deployment's failures as this
  // release's.
  if (hashes.length === 0) {
    return "AND false";
  }

  const [only] = hashes;
  return hashes.length === 1 && only !== undefined
    ? `AND target_package_hash = ${bind(only)}`
    : `AND target_package_hash = ANY(${bind([...hashes])}::text[])`;
}

/** Reads one string field out of a decoded payload, treating "" as absent. */
function failurePayloadString(
  payload: Record<string, unknown> | null,
  field: string,
): string | null {
  const value = payload?.[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The keyset cursor: `emitted_at` and `id` joined by a tab.
 *
 * A tab cannot appear in either half — `emitted_at` serializes as ISO 8601 and
 * `id` is a generated identifier — so the split is unambiguous without
 * escaping. It is opaque to the client, which only ever echoes it back.
 */
function encodeFailureEventCursor(emittedAt: Date, id: string): string {
  return `${emittedAt.toISOString()}\t${id}`;
}

function decodeFailureEventCursor(
  cursor: string | null,
): { emittedAt: Date; id: string } | null {
  if (cursor === null) {
    return null;
  }

  const separator = cursor.indexOf("\t");
  if (separator === -1) {
    return null;
  }

  const emittedAt = new Date(cursor.slice(0, separator));
  const id = cursor.slice(separator + 1);
  // A cursor that does not parse restarts the feed rather than failing it: it
  // can only come from a client echoing something it was never given, and a
  // corrupt scroll position is not worth an error page.
  return Number.isNaN(emittedAt.getTime()) || id.length === 0
    ? null
    : { emittedAt, id };
}

/**
 * Inserts one event, or reports the row an earlier delivery of the same
 * `event_id` already left behind.
 */
async function insertMetricEvent(
  client: Queryable,
  deployment: DeploymentRow,
  input: PersistMetricEventInput,
): Promise<PersistMetricEventResult> {
  const inserted = await client.query<MetricEventRow>(
    `
      INSERT INTO metric_event (
        id,
        event_id,
        event_name,
        emitted_at,
        team_id,
        app_id,
        deployment_id,
        deployment_key,
        binary_version,
        running_package_hash,
        target_package_hash,
        device_id,
        sdk_version,
        platform,
        attributes,
        failure_payload,
        created_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, NOW()
      )
      ON CONFLICT (event_id) DO NOTHING
      RETURNING *
    `,
    [
      input.id,
      input.eventId,
      input.eventName,
      input.emittedAt,
      deployment.team_id,
      deployment.app_id,
      deployment.id,
      input.deploymentKey,
      input.binaryVersion,
      input.runningPackageHash,
      input.targetPackageHash,
      input.deviceId,
      input.sdkVersion,
      input.platform,
      input.attributes,
      input.failurePayload,
    ],
  );

  const row = inserted.rows[0];
  if (row) {
    return {
      event: mapMetricEventRow(row),
      outcome: "created",
    };
  }

  const existing = await client.query<MetricEventRow>(
    "SELECT * FROM metric_event WHERE event_id = $1",
    [input.eventId],
  );

  return {
    event: mapMetricEventRow(requireRow(existing.rows[0], "metric_event")),
    outcome: "duplicate",
  };
}

async function findDeploymentByKey(
  client: Queryable,
  deploymentKey: string,
): Promise<DeploymentRow | null> {
  const result = await client.query<DeploymentRow>(
    "SELECT * FROM deployment WHERE deployment_key = $1",
    [deploymentKey],
  );

  return result.rows[0] ?? null;
}

function requireRow<T>(row: T | undefined, tableName: string): T {
  if (!row) {
    throw new Error(`Expected ${tableName} row to exist`);
  }

  return row;
}
