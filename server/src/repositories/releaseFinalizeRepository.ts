import type { Pool, PoolClient } from "pg";

import { withTransaction } from "../db";
import type { Release, ReleaseJob, ReleaseJobId } from "../domain";
import type { DatabasePool } from "../db";
import {
  mapReleaseJobRow,
  mapReleaseRow,
  type ReleaseJobRow,
  type ReleaseRow,
} from "./rowMappers";

export interface TransitionReleaseJobOptions {
  now?: Date;
}

export interface ReleaseFailureInfo {
  reason: string;
  stage: string;
}

type TransitionFailureReason =
  | "job_not_found"
  | "job_not_running"
  | "claim_generation_mismatch";

interface TransitionUpdatedResult {
  outcome: "updated";
  job: ReleaseJob;
  release: Release;
}

interface TransitionRejectedResult {
  outcome: "not_updated";
  reason: TransitionFailureReason;
}

export type FinalizeReleaseSuccessResult =
  | (TransitionUpdatedResult & {
      activatedTargetCount: number;
      cleanedPendingTargetCount: number;
    })
  | TransitionRejectedResult;

export type TransitionReleaseJobResult = TransitionUpdatedResult | TransitionRejectedResult;

export interface ReleaseFinalizeRepository {
  finalizeReleaseFailure(
    jobId: ReleaseJobId,
    claimGeneration: number,
    failure: ReleaseFailureInfo,
    options?: TransitionReleaseJobOptions,
  ): Promise<TransitionReleaseJobResult>;
  finalizeReleaseSuccess(
    jobId: ReleaseJobId,
    claimGeneration: number,
    options?: TransitionReleaseJobOptions,
  ): Promise<FinalizeReleaseSuccessResult>;
  requeueRetryableJob(
    jobId: ReleaseJobId,
    claimGeneration: number,
    failure: ReleaseFailureInfo,
    options?: TransitionReleaseJobOptions,
  ): Promise<TransitionReleaseJobResult>;
}

export function createPostgresReleaseFinalizeRepository(
  pool: DatabasePool | Pool,
): ReleaseFinalizeRepository {
  return {
    async finalizeReleaseSuccess(jobId, claimGeneration, options = {}) {
      const now = options.now ?? new Date();

      return withTransaction(pool, async (client) => {
        const claim = await lockOwnedRunningJob(client, jobId, claimGeneration);
        if ("outcome" in claim) {
          return claim;
        }

        const activatedTargets = await client.query<{ id: string }>(
          `
            UPDATE release_target
            SET status = 'active'
            WHERE job_id = $1
              AND status = 'pending'
            RETURNING id
          `,
          [jobId],
        );

        const cleanedPendingTargets = await client.query<{ id: string }>(
          `
            DELETE FROM release_target rt
            USING release_job rj
            WHERE rt.release_id = $1
              AND rt.status = 'pending'
              AND rt.job_id = rj.id
              AND rj.status IN ('failed', 'dead_letter')
            RETURNING rt.id
          `,
          [claim.releaseRow.id],
        );

        const releaseResult = await client.query<ReleaseRow>(
          `
            UPDATE release
            SET status = CASE
                  WHEN status IN ('uploaded', 'processing') THEN 'published'
                  WHEN status = 'disabled' AND $3 = 'release_enabled' THEN 'published'
                  ELSE status
                END,
                processing_finished_at = CASE
                  WHEN status IN ('uploaded', 'processing') THEN $2
                  WHEN status = 'disabled' AND $3 = 'release_enabled' THEN $2
                  WHEN status = 'disabled' AND processing_finished_at IS NULL THEN $2
                  ELSE processing_finished_at
                END,
                failure_stage = NULL,
                failure_reason = NULL,
                updated_at = $2
            WHERE id = $1
            RETURNING *
          `,
          [claim.releaseRow.id, now, claim.jobRow.trigger_type],
        );

        const jobResult = await client.query<ReleaseJobRow>(
          `
            UPDATE release_job
            SET status = 'succeeded',
                lease_expires_at = NULL,
                failure_stage = NULL,
                failure_reason = NULL,
                updated_at = $2
            WHERE id = $1
            RETURNING *
          `,
          [jobId, now],
        );

        return {
          activatedTargetCount: activatedTargets.rowCount ?? 0,
          cleanedPendingTargetCount: cleanedPendingTargets.rowCount ?? 0,
          job: mapReleaseJobRow(requireRow(jobResult.rows[0], "release_job")),
          outcome: "updated",
          release: mapReleaseRow(requireRow(releaseResult.rows[0], "release")),
        };
      });
    },

    async finalizeReleaseFailure(jobId, claimGeneration, failure, options = {}) {
      const now = options.now ?? new Date();

      return withTransaction(pool, async (client) => {
        const claim = await lockOwnedRunningJob(client, jobId, claimGeneration);
        if ("outcome" in claim) {
          return claim;
        }

        const releaseResult = await client.query<ReleaseRow>(
          `
            UPDATE release
            SET status = CASE
                  WHEN status IN ('uploaded', 'processing') THEN 'failed'
                  ELSE status
                END,
                processing_finished_at = CASE
                  WHEN status IN ('uploaded', 'processing') THEN $2
                  ELSE processing_finished_at
                END,
                failure_stage = $3,
                failure_reason = $4,
                updated_at = $2
            WHERE id = $1
            RETURNING *
          `,
          [claim.releaseRow.id, now, failure.stage, failure.reason],
        );

        const jobResult = await client.query<ReleaseJobRow>(
          `
            UPDATE release_job
            SET status = 'failed',
                lease_expires_at = NULL,
                failure_stage = $3,
                failure_reason = $4,
                updated_at = $2
            WHERE id = $1
            RETURNING *
          `,
          [jobId, now, failure.stage, failure.reason],
        );

        return {
          job: mapReleaseJobRow(requireRow(jobResult.rows[0], "release_job")),
          outcome: "updated",
          release: mapReleaseRow(requireRow(releaseResult.rows[0], "release")),
        };
      });
    },

    async requeueRetryableJob(jobId, claimGeneration, failure, options = {}) {
      const now = options.now ?? new Date();

      return withTransaction(pool, async (client) => {
        const claim = await lockOwnedRunningJob(client, jobId, claimGeneration);
        if ("outcome" in claim) {
          return claim;
        }

        const releaseResult = await client.query<ReleaseRow>(
          `
            UPDATE release
            SET status = CASE
                  WHEN status = 'uploaded' THEN 'processing'
                  ELSE status
                END,
                failure_stage = $3,
                failure_reason = $4,
                updated_at = $2
            WHERE id = $1
            RETURNING *
          `,
          [claim.releaseRow.id, now, failure.stage, failure.reason],
        );

        const jobResult = await client.query<ReleaseJobRow>(
          `
            UPDATE release_job
            SET status = 'queued',
                lease_expires_at = NULL,
                failure_stage = $3,
                failure_reason = $4,
                updated_at = $2
            WHERE id = $1
            RETURNING *
          `,
          [jobId, now, failure.stage, failure.reason],
        );

        return {
          job: mapReleaseJobRow(requireRow(jobResult.rows[0], "release_job")),
          outcome: "updated",
          release: mapReleaseRow(requireRow(releaseResult.rows[0], "release")),
        };
      });
    },
  };
}

async function lockOwnedRunningJob(
  client: PoolClient,
  jobId: ReleaseJobId,
  claimGeneration: number,
): Promise<
  | TransitionRejectedResult
  | {
      jobRow: ReleaseJobRow;
      releaseRow: ReleaseRow;
    }
> {
  const jobResult = await client.query<ReleaseJobRow>(
    "SELECT * FROM release_job WHERE id = $1 FOR UPDATE",
    [jobId],
  );
  const jobRow = jobResult.rows[0];

  if (!jobRow) {
    return {
      outcome: "not_updated",
      reason: "job_not_found",
    };
  }

  if (jobRow.status !== "running") {
    return {
      outcome: "not_updated",
      reason: "job_not_running",
    };
  }

  if (jobRow.claim_generation !== claimGeneration) {
    return {
      outcome: "not_updated",
      reason: "claim_generation_mismatch",
    };
  }

  const releaseResult = await client.query<ReleaseRow>(
    "SELECT * FROM release WHERE id = $1 FOR UPDATE",
    [jobRow.release_id],
  );

  return {
    jobRow,
    releaseRow: requireRow(releaseResult.rows[0], "release"),
  };
}

function requireRow<T>(row: T | undefined, tableName: string): T {
  if (!row) {
    throw new Error(`Expected ${tableName} row to exist`);
  }

  return row;
}
