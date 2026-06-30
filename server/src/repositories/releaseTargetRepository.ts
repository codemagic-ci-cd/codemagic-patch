import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { withTransaction } from "../db";
import type { DatabasePool } from "../db";
import type { ReleaseId, ReleaseJobId, ReleaseTarget } from "../domain";
import type { ResolvedTarget } from "../worker/types";
import {
  mapReleaseTargetRow,
  type ReleaseJobRow,
  type ReleaseTargetRow,
} from "./rowMappers";

type PersistFailureReason =
  | "job_not_found"
  | "job_not_running"
  | "claim_generation_mismatch";

type PersistPendingTargetsResult =
  | {
      outcome: "updated";
      reconcileGeneration: number;
      targets: ReleaseTarget[];
    }
  | {
      outcome: "not_updated";
      reason: PersistFailureReason;
    };

export interface PersistPendingReleaseTargetsOptions {
  inferredFingerprint?: {
    binaryVersion: string;
    fingerprint: string;
    inferredFromReleaseId: ReleaseId;
  };
  now?: Date;
}

export interface ReleaseTargetRepository {
  persistPendingReleaseTargets(
    jobId: ReleaseJobId,
    claimGeneration: number,
    targets: ResolvedTarget[],
    options?: PersistPendingReleaseTargetsOptions,
  ): Promise<PersistPendingTargetsResult>;
}

export function createPostgresReleaseTargetRepository(
  pool: DatabasePool | Pool,
): ReleaseTargetRepository {
  return {
    async persistPendingReleaseTargets(jobId, claimGeneration, targets, options = {}) {
      const now = options.now ?? new Date();

      return withTransaction(pool, async (client) => {
        const claim = await lockOwnedRunningJob(client, jobId, claimGeneration);
        if ("outcome" in claim) {
          return claim;
        }

        const existingTargetsResult = await client.query<ReleaseTargetRow>(
          `
            SELECT *
            FROM release_target
            WHERE release_id = $1
            FOR UPDATE
          `,
          [claim.jobRow.release_id],
        );
        const existingTargets = existingTargetsResult.rows;
        const currentPendingTargets = sortReleaseTargetRows(
          existingTargets.filter(
            (row) => row.status === "pending" && row.job_id === jobId,
          ),
        );
        const latestActiveTargets = selectLatestActiveTargets(existingTargets);

        if (options.inferredFingerprint) {
          await client.query(
            `
              INSERT INTO binary_version_fingerprint (
                id,
                deployment_id,
                binary_version,
                fingerprint,
                inferred_from_release_id,
                created_at
              ) VALUES ($1, $2, $3, $4, $5, $6)
              ON CONFLICT (deployment_id, binary_version) DO NOTHING
            `,
            [
              createBinaryVersionFingerprintId(),
              claim.jobRow.deployment_id,
              options.inferredFingerprint.binaryVersion,
              options.inferredFingerprint.fingerprint,
              options.inferredFingerprint.inferredFromReleaseId,
              now,
            ],
          );
        }

        if (targetsMatchRows(currentPendingTargets, targets)) {
          return {
            outcome: "updated",
            reconcileGeneration:
              currentPendingTargets[0]?.reconcile_generation ?? 0,
            targets: currentPendingTargets.map(mapReleaseTargetRow),
          };
        }

        if (currentPendingTargets.length > 0) {
          await client.query(
            `
              DELETE FROM release_target
              WHERE release_id = $1
                AND status = 'pending'
            `,
            [claim.jobRow.release_id],
          );
        }

        if (targetsMatchRows(latestActiveTargets, targets)) {
          return {
            outcome: "updated",
            reconcileGeneration:
              latestActiveTargets[0]?.reconcile_generation ?? 0,
            targets: latestActiveTargets.map(mapReleaseTargetRow),
          };
        }

        const nextGeneration =
          existingTargets.reduce(
            (max, row) => Math.max(max, row.reconcile_generation),
            0,
          ) + 1;

        if (targets.length === 0) {
          return {
            outcome: "updated",
            reconcileGeneration: nextGeneration,
            targets: [],
          };
        }

        const insertedTargets = await client.query<ReleaseTargetRow>(
          `
            INSERT INTO release_target (
              id,
              release_id,
              binary_version,
              resolution_source,
              fingerprint,
              reconcile_generation,
              status,
              job_id,
              created_at
            )
            SELECT
              unnest($1::text[]),
              $2,
              unnest($3::text[]),
              unnest($4::text[]),
              unnest($5::text[]),
              $6,
              'pending',
              $7,
              $8
            RETURNING *
          `,
          [
            targets.map(() => createReleaseTargetId()),
            claim.jobRow.release_id,
            targets.map((target) => target.binaryVersion),
            targets.map((target) => target.resolutionSource),
            targets.map((target) => target.fingerprint),
            nextGeneration,
            jobId,
            now,
          ],
        );

        return {
          outcome: "updated",
          reconcileGeneration: nextGeneration,
          targets: insertedTargets.rows.map(mapReleaseTargetRow),
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
  | {
      outcome: "not_updated";
      reason: PersistFailureReason;
    }
  | {
      jobRow: ReleaseJobRow;
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

  return { jobRow };
}

function createReleaseTargetId(): string {
  return `rt_${randomUUID().replace(/-/g, "")}`;
}

function createBinaryVersionFingerprintId(): string {
  return `bvf_${randomUUID().replace(/-/g, "")}`;
}

function selectLatestActiveTargets(rows: ReleaseTargetRow[]): ReleaseTargetRow[] {
  const latestActiveGeneration = rows.reduce((max, row) => {
    if (row.status !== "active") {
      return max;
    }

    return Math.max(max, row.reconcile_generation);
  }, 0);

  return sortReleaseTargetRows(
    rows.filter(
      (row) =>
        row.status === "active" &&
        row.reconcile_generation === latestActiveGeneration,
    ),
  );
}

function sortReleaseTargetRows(rows: ReleaseTargetRow[]): ReleaseTargetRow[] {
  return [...rows].sort((left, right) =>
    left.binary_version.localeCompare(right.binary_version),
  );
}

function targetsMatchRows(
  rows: ReleaseTargetRow[],
  targets: ResolvedTarget[],
): boolean {
  if (rows.length !== targets.length) {
    return false;
  }

  const sortedTargets = [...targets].sort((left, right) =>
    left.binaryVersion.localeCompare(right.binaryVersion),
  );

  return rows.every((row, index) => {
    const target = sortedTargets[index];
    return (
      target !== undefined &&
      row.binary_version === target.binaryVersion &&
      row.resolution_source === target.resolutionSource &&
      row.fingerprint === target.fingerprint
    );
  });
}
