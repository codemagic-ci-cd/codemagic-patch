import type { Pool } from "pg";

import { withTransaction } from "../db";
import type { Release, ReleaseJob, ReleaseJobId } from "../domain";
import type { DatabasePool } from "../db";
import {
  mapReleaseJobRow,
  mapReleaseRow,
  type ReleaseJobRow,
  type ReleaseRow,
} from "./rowMappers";

const DEFAULT_LEASE_DURATION_MS = 15 * 60 * 1000;

export interface ClaimReleaseJobOptions {
  leaseDurationMs?: number;
  now?: Date;
}

export interface HeartbeatReleaseJobOptions {
  leaseDurationMs?: number;
  now?: Date;
}

export type ClaimReleaseJobResult =
  | {
      outcome: "claimed";
      job: ReleaseJob;
      release: Release;
    }
  | {
      outcome: "dead_lettered";
      job: ReleaseJob;
    }
  | {
      outcome: "not_claimed";
      reason: "job_not_found" | "job_not_claimable";
    };

export interface ReleaseJobRepository {
  claimReleaseJob(
    jobId: ReleaseJobId,
    options?: ClaimReleaseJobOptions,
  ): Promise<ClaimReleaseJobResult>;
  heartbeatReleaseJob(
    jobId: ReleaseJobId,
    claimGeneration: number,
    options?: HeartbeatReleaseJobOptions,
  ): Promise<ReleaseJob | null>;
}

export function createPostgresReleaseJobRepository(
  pool: DatabasePool | Pool,
): ReleaseJobRepository {
  return {
    async claimReleaseJob(jobId, options = {}) {
      const now = options.now ?? new Date();
      const leaseExpiresAt = new Date(now.getTime() + (options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS));

      return withTransaction(pool, async (client) => {
        const existingJobResult = await client.query<ReleaseJobRow>(
          "SELECT * FROM release_job WHERE id = $1 FOR UPDATE",
          [jobId],
        );
        const existingJobRow = existingJobResult.rows[0];

        if (!existingJobRow) {
          return {
            outcome: "not_claimed",
            reason: "job_not_found",
          };
        }

        if (!isJobClaimable(existingJobRow, now)) {
          return {
            outcome: "not_claimed",
            reason: "job_not_claimable",
          };
        }

        if (existingJobRow.attempt_count >= existingJobRow.max_total_attempts) {
          const releaseResult = await client.query<ReleaseRow>(
            "SELECT * FROM release WHERE id = $1 FOR UPDATE",
            [existingJobRow.release_id],
          );
          const releaseRow = requireRow(releaseResult.rows[0], "release");
          const terminalFailureStage = releaseRow.failure_stage ?? "claim";
          const terminalFailureReason =
            releaseRow.failure_reason ?? "max_total_attempts_exceeded";

          const deadLetteredJob = await client.query<ReleaseJobRow>(
            `
              UPDATE release_job
              SET status = 'dead_letter',
                  failure_stage = COALESCE(failure_stage, $3),
                  failure_reason = COALESCE(failure_reason, $4),
                  updated_at = $2
              WHERE id = $1
              RETURNING *
            `,
            [jobId, now, terminalFailureStage, terminalFailureReason],
          );

          if (releaseRow.status === "uploaded" || releaseRow.status === "processing") {
            await client.query(
              `
                UPDATE release
                SET status = 'failed',
                    processing_finished_at = $2,
                    failure_stage = COALESCE(failure_stage, $3),
                    failure_reason = COALESCE(failure_reason, $4),
                    updated_at = $2
                WHERE id = $1
              `,
              [releaseRow.id, now, terminalFailureStage, terminalFailureReason],
            );
          }

          return {
            outcome: "dead_lettered",
            job: mapReleaseJobRow(requireRow(deadLetteredJob.rows[0], "release_job")),
          };
        }

        const releaseResult = await client.query<ReleaseRow>(
          "SELECT * FROM release WHERE id = $1 FOR UPDATE",
          [existingJobRow.release_id],
        );
        let releaseRow = requireRow(releaseResult.rows[0], "release");

        const claimedJobResult = await client.query<ReleaseJobRow>(
          `
            UPDATE release_job
            SET status = 'running',
                attempt_count = attempt_count + 1,
                claim_generation = claim_generation + 1,
                lease_expires_at = $2,
                last_heartbeat_at = $1,
                updated_at = $1
            WHERE id = $3
            RETURNING *
          `,
          [now, leaseExpiresAt, jobId],
        );

        if (releaseRow.status === "uploaded" || releaseRow.status === "processing") {
          const updatedReleaseResult = await client.query<ReleaseRow>(
            `
              UPDATE release
              SET status = CASE
                    WHEN status = 'uploaded' THEN 'processing'
                    ELSE status
                  END,
                  processing_started_at = COALESCE(processing_started_at, $2),
                  processing_attempt_count = processing_attempt_count + 1,
                  updated_at = $2
              WHERE id = $1
              RETURNING *
            `,
            [releaseRow.id, now],
          );
          releaseRow = requireRow(updatedReleaseResult.rows[0], "release");
        }

        return {
          outcome: "claimed",
          job: mapReleaseJobRow(requireRow(claimedJobResult.rows[0], "release_job")),
          release: mapReleaseRow(releaseRow),
        };
      });
    },

    async heartbeatReleaseJob(jobId, claimGeneration, options = {}) {
      const now = options.now ?? new Date();
      const leaseExpiresAt = new Date(now.getTime() + (options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS));

      const result = await pool.query<ReleaseJobRow>(
        `
          UPDATE release_job
          SET last_heartbeat_at = $3,
              lease_expires_at = $4,
              updated_at = $3
          WHERE id = $1
            AND status = 'running'
            AND claim_generation = $2
          RETURNING *
        `,
        [jobId, claimGeneration, now, leaseExpiresAt],
      );

      return result.rows[0] ? mapReleaseJobRow(result.rows[0]) : null;
    },
  };
}

function isJobClaimable(job: ReleaseJobRow, now: Date): boolean {
  if (job.status === "queued") {
    return true;
  }

  if (job.status !== "running") {
    return false;
  }

  return job.lease_expires_at !== null && job.lease_expires_at.getTime() <= now.getTime();
}

function requireRow<T>(row: T | undefined, tableName: string): T {
  if (!row) {
    throw new Error(`Expected ${tableName} row to exist`);
  }

  return row;
}
