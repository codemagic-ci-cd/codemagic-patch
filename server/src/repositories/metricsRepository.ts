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

export interface MetricsRepository {
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
