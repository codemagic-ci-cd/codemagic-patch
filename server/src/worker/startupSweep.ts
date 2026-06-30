import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { withTransaction } from "../db";
import type { DatabasePool } from "../db";
import type { ReleaseJobId } from "../domain";

const DEFAULT_MAX_TOTAL_ATTEMPTS = 15;

export interface StartupSweepOptions {
  enqueue?: (jobId: ReleaseJobId) => Promise<void>;
  now?: Date;
}

export interface StartupSweepResult {
  createdQueuedJobCount: number;
  queuedJobIds: ReleaseJobId[];
  requeuedExpiredRunningCount: number;
  requeuedStuckProcessingCount: number;
}

export async function startupSweep(
  pool: DatabasePool | Pool,
  options: StartupSweepOptions = {},
): Promise<StartupSweepResult> {
  const now = options.now ?? new Date();

  const {
    createdQueuedJobIds,
    expiredRunningJobIds,
    revivedQueuedJobIds,
  } = await withTransaction(pool, async (client) => {
    const expiredRunningJobIds = await selectExpiredRunningJobIds(client, now);

    if (expiredRunningJobIds.length > 0) {
      await client.query(
        `
          UPDATE release_job
          SET status = 'queued',
              lease_expires_at = NULL,
              updated_at = $2
          WHERE id = ANY($1::text[])
        `,
        [expiredRunningJobIds, now],
      );
    }

    const processingReleases = await selectRecoverableProcessingReleases(client, now);
    const revivedQueuedJobIds: string[] = [];
    const createdQueuedJobIds: string[] = [];

    for (const release of processingReleases) {
      if (expiredRunningJobIds.includes(release.latestJobId ?? "")) {
        continue;
      }

      if (release.latestJobId && release.latestJobStatus === "queued") {
        await client.query(
          `
            UPDATE release_job
            SET status = 'queued',
                lease_expires_at = NULL,
                updated_at = $2
            WHERE id = $1
          `,
          [release.latestJobId, now],
        );
        revivedQueuedJobIds.push(release.latestJobId);
        continue;
      }

      if (release.latestJobId && release.latestJobStatus === "running") {
        await client.query(
          `
            UPDATE release_job
            SET status = 'queued',
                lease_expires_at = NULL,
                updated_at = $2
            WHERE id = $1
          `,
          [release.latestJobId, now],
        );
        revivedQueuedJobIds.push(release.latestJobId);
        continue;
      }

      if (release.latestJobId) {
        continue;
      }

      const createdJobId = createReleaseJobId();
      await client.query(
        `
          INSERT INTO release_job (
            id,
            release_id,
            deployment_id,
            trigger_type,
            status,
            attempt_count,
            claim_generation,
            max_total_attempts,
            lease_expires_at,
            last_heartbeat_at,
            failure_stage,
            failure_reason,
            requested_by,
            created_at,
            updated_at
          ) VALUES (
            $1, $2, $3, 'release_created', 'queued', 0,
            0, $4, NULL, NULL,
            NULL, NULL, NULL, $5, $5
          )
        `,
        [
          createdJobId,
          release.releaseId,
          release.deploymentId,
          DEFAULT_MAX_TOTAL_ATTEMPTS,
          now,
        ],
      );
      createdQueuedJobIds.push(createdJobId);
    }

    return {
      createdQueuedJobIds,
      expiredRunningJobIds,
      revivedQueuedJobIds,
    };
  });

  const queuedJobIds = [
    ...new Set([
      ...expiredRunningJobIds,
      ...revivedQueuedJobIds,
      ...createdQueuedJobIds,
    ]),
  ].map((jobId) => jobId as ReleaseJobId);

  if (options.enqueue) {
    for (const jobId of queuedJobIds) {
      await options.enqueue(jobId);
    }
  }

  return {
    createdQueuedJobCount: createdQueuedJobIds.length,
    queuedJobIds,
    requeuedExpiredRunningCount: expiredRunningJobIds.length,
    requeuedStuckProcessingCount:
      revivedQueuedJobIds.length + createdQueuedJobIds.length,
  };
}

async function selectExpiredRunningJobIds(
  client: PoolClient,
  now: Date,
): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `
      SELECT id
      FROM release_job
      WHERE status = 'running'
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= $1
      FOR UPDATE
    `,
    [now],
  );

  return result.rows.map((row) => row.id);
}

interface RecoverableProcessingReleaseRow {
  deploymentId: string;
  latestJobId: string | null;
  latestJobStatus: string | null;
  releaseId: string;
}

async function selectRecoverableProcessingReleases(
  client: PoolClient,
  now: Date,
): Promise<RecoverableProcessingReleaseRow[]> {
  const result = await client.query<{
    deployment_id: string;
    latest_job_id: string | null;
    latest_job_status: string | null;
    release_id: string;
  }>(
    `
      SELECT
        r.id AS release_id,
        r.deployment_id,
        latest.id AS latest_job_id,
        latest.status AS latest_job_status
      FROM release r
      LEFT JOIN LATERAL (
        SELECT j.id, j.status
        FROM release_job j
        WHERE j.release_id = r.id
        ORDER BY j.created_at DESC, j.id DESC
        LIMIT 1
      ) latest ON TRUE
      WHERE r.status = 'processing'
        AND NOT EXISTS (
          SELECT 1
          FROM release_job live
          WHERE live.deployment_id = r.deployment_id
            AND live.status = 'running'
            AND live.lease_expires_at IS NOT NULL
            AND live.lease_expires_at > $1
        )
      FOR UPDATE OF r
    `,
    [now],
  );

  return result.rows.map((row) => ({
    deploymentId: row.deployment_id,
    latestJobId: row.latest_job_id,
    latestJobStatus: row.latest_job_status,
    releaseId: row.release_id,
  }));
}

function createReleaseJobId(): string {
  return `rj_${randomUUID().replace(/-/g, "")}`;
}
