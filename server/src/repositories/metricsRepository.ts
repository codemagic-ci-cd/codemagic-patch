import type { Pool } from "pg";

import type {
  DeploymentId,
  MetricEvent,
  MetricEventName,
  ReleaseMetrics,
} from "../domain";
import type { DatabasePool } from "../db";
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

export interface MetricsRepository {
  listDeploymentTimeseries(
    deploymentId: DeploymentId,
    range: { from: Date; seriesLimit: number; to: Date },
  ): Promise<DeploymentTimeseriesRows>;
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

      const inserted = await pool.query<MetricEventRow>(
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
            created_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, NOW()
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
        ],
      );

      const row = inserted.rows[0];
      if (row) {
        return {
          event: mapMetricEventRow(row),
          outcome: "created",
        };
      }

      const existing = await pool.query<MetricEventRow>(
        "SELECT * FROM metric_event WHERE event_id = $1",
        [input.eventId],
      );

      return {
        event: mapMetricEventRow(requireRow(existing.rows[0], "metric_event")),
        outcome: "duplicate",
      };
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
        metrics.set(hash, { ...ZERO_RELEASE_METRICS });
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
          installed: row.installed,
          success: row.success,
        });
      }

      return metrics;
    },
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
