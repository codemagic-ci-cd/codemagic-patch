import type { Pool } from "pg";

import type {
  DeploymentId,
  Release,
  ReleaseId,
  ReleaseJob,
  ReleaseJobId,
  ReleaseJobTriggerType,
  ReleaseStatus,
  UserId,
} from "../domain";
import type { DatabasePool } from "../db";
import { withTransaction } from "../db";
import {
  mapReleaseJobRow,
  mapReleaseRow,
  type DeploymentRow,
  type ReleaseJobRow,
  type ReleaseRow,
} from "./rowMappers";

export interface CreateReleaseInput {
  bundleStorageKey: string;
  createdAt: Date;
  createdBy: UserId | null;
  deploymentId: DeploymentId;
  fingerprint: string | null;
  releaseId: ReleaseId;
  isMandatory: boolean;
  jobId: ReleaseJobId;
  noDuplicateReleaseError: boolean;
  releaseNotes: string | null;
  rolloutPercentage: number;
  signature: string | null;
  signatureHashAlgorithm: string | null;
  sourceMapStorageKey: string | null;
  status: "disabled" | "uploaded";
  targetBinaryVersion: string;
  targetPackageHash: string | null;
}

export type ReleaseCreationWarning =
  | {
      code: "duplicate-release";
      detail: string;
    }
  | {
      code: "fingerprint-disagreement";
      detail: string;
      binaryVersion: string;
      storedFingerprint: string;
      releaseFingerprint: string;
    };

export interface LatestReleasePackageHash {
  releaseId: ReleaseId;
  releaseLabel: string;
  targetPackageHash: string;
}

export interface PreflightCreateReleaseInput {
  deploymentId: DeploymentId;
  signature: string | null;
}

export type CreateReleaseResult =
  | {
      job: ReleaseJob;
      outcome: "created";
      release: Release;
      warnings?: ReleaseCreationWarning[];
    }
  | {
      activeJob: {
        jobId: ReleaseJobId;
        releaseId: ReleaseId;
        status: "queued" | "running";
      };
      outcome: "conflict";
      reason: "active_release_job_exists";
    }
  | {
      outcome: "conflict";
      reason: "active_rollout_exists";
    }
  | {
      latestRelease: LatestReleasePackageHash;
      outcome: "conflict";
      reason: "duplicate_release";
    }
  | {
      outcome: "invalid";
      reason: "signature_required";
    }
  | {
      outcome: "not_created";
      reason: "deployment_not_found";
    };

export type PreflightCreateReleaseResult =
  | {
      outcome: "accepted";
    }
  | Exclude<CreateReleaseResult, { outcome: "created" }>;

export type GetReleaseResult =
  | {
      job: ReleaseJob | null;
      outcome: "found";
      release: Release;
    }
  | {
      outcome: "not_found";
      reason: "release_not_found";
    };

export interface ListReleasesForDeploymentInput {
  deploymentId: DeploymentId;
  limit: number;
  offset: number;
}

export type ListReleasesForDeploymentResult =
  | {
      outcome: "found";
      releases: Array<{
        release: Release;
        job: ReleaseJob | null;
      }>;
      pagination: {
        limit: number;
        offset: number;
        total: number;
      };
    }
  | {
      outcome: "not_found";
      reason: "deployment_not_found";
    };

export interface PatchReleaseInput {
  createdAt: Date;
  createdBy: UserId | null;
  isMandatory?: boolean;
  jobId: ReleaseJobId;
  releaseId: ReleaseId;
  releaseNotes?: string | null;
  rolloutPercentage?: number;
  status?: "disabled" | "published";
  targetBinaryVersion?: string;
}

export interface PromoteReleaseInput {
  createdAt: Date;
  createdBy: UserId | null;
  destinationDeploymentId: DeploymentId;
  disabled: boolean;
  isMandatory?: boolean;
  jobId: ReleaseJobId;
  noDuplicateReleaseError: boolean;
  releaseId: ReleaseId;
  releaseNotes?: string | null;
  rolloutPercentage: number;
  sourceReleaseId: ReleaseId;
  targetBinaryVersion?: string;
}

export interface RollbackDeploymentInput {
  createdAt: Date;
  createdBy: UserId | null;
  deploymentId: DeploymentId;
  jobId: ReleaseJobId;
  releaseId: ReleaseId;
  targetReleaseLabel: string | null;
}

export type PatchReleaseResult =
  | {
      job: ReleaseJob;
      outcome: "updated";
      release: Release;
      warnings?: ReleaseCreationWarning[];
    }
  | {
      activeJob: {
        jobId: ReleaseJobId;
        releaseId: ReleaseId;
        status: "queued" | "running";
      };
      outcome: "conflict";
      reason: "active_release_job_exists";
    }
  | {
      outcome: "invalid";
      reason:
        | "release_not_patchable"
        | "rollout_percentage_decrease"
        | "signature_required"
        | "status_transition_not_allowed";
    }
  | {
      outcome: "not_found";
      reason: "release_not_found";
    }
  | {
      outcome: "not_modified";
    };

export type ReleaseLifecycleCreateResult =
  | {
      job: ReleaseJob;
      outcome: "created";
      release: Release;
      warnings?: ReleaseCreationWarning[];
    }
  | {
      activeJob: {
        jobId: ReleaseJobId;
        releaseId: ReleaseId;
        status: "queued" | "running";
      };
      outcome: "conflict";
      reason: "active_release_job_exists";
    }
  | {
      outcome: "conflict";
      reason: "active_rollout_exists";
    }
  | {
      latestRelease: LatestReleasePackageHash;
      outcome: "conflict";
      reason: "duplicate_release";
    }
  | {
      outcome: "conflict";
      reason: "rollback_no_op";
    }
  | {
      outcome: "invalid";
      reason: "release_not_promotable" | "signature_required";
    }
  | {
      outcome: "not_found";
      reason:
        | "deployment_not_found"
        | "release_not_found"
        | "rollback_target_not_found";
    };

export interface ReleaseIdentity {
  createdAt: Date;
  id: string;
  releaseLabel: string;
  targetPackageHash: string | null;
}

export type ListReleaseIdentitiesResult =
  | {
      outcome: "found";
      releases: ReleaseIdentity[];
    }
  | {
      outcome: "not_found";
      reason: "deployment_not_found";
    };

export interface ReleaseRepository {
  createRelease(input: CreateReleaseInput): Promise<CreateReleaseResult>;
  /** Lighter variant of getReleaseById — skips the release_job lookup. */
  findReleaseById(releaseId: ReleaseId): Promise<Release | null>;
  getReleaseById(releaseId: ReleaseId): Promise<GetReleaseResult>;
  /**
   * Unpaginated identity rows (id / label / hash) for mapping metric hashes
   * back to releases — much lighter than listReleasesForDeployment.
   */
  listReleaseIdentitiesForDeployment(
    deploymentId: DeploymentId,
  ): Promise<ListReleaseIdentitiesResult>;
  listReleasesForDeployment(
    input: ListReleasesForDeploymentInput,
  ): Promise<ListReleasesForDeploymentResult>;
  patchRelease(input: PatchReleaseInput): Promise<PatchReleaseResult>;
  preflightCreateRelease(
    input: PreflightCreateReleaseInput,
  ): Promise<PreflightCreateReleaseResult>;
  promoteRelease(input: PromoteReleaseInput): Promise<ReleaseLifecycleCreateResult>;
  rollbackDeployment(
    input: RollbackDeploymentInput,
  ): Promise<ReleaseLifecycleCreateResult>;
  setReleaseTargetPackageHash(
    releaseId: ReleaseId,
    targetPackageHash: string,
  ): Promise<boolean>;
}

interface Queryable {
  query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

type ReleaseListRow = ReleaseRow & {
  latest_job_attempt_count: number | null;
  latest_job_claim_generation: number | null;
  latest_job_created_at: Date | null;
  latest_job_deployment_id: string | null;
  latest_job_failure_reason: string | null;
  latest_job_failure_stage: string | null;
  latest_job_id: string | null;
  latest_job_last_heartbeat_at: Date | null;
  latest_job_lease_expires_at: Date | null;
  latest_job_max_total_attempts: number | null;
  latest_job_release_id: string | null;
  latest_job_requested_by: string | null;
  latest_job_status: ReleaseJob["status"] | null;
  latest_job_trigger_type: ReleaseJob["triggerType"] | null;
  latest_job_updated_at: Date | null;
};

const DUPLICATE_RELEASE_DETAIL =
  "release content is identical to the latest published release";

type ReleaseCreatePreconditionResult =
  | {
      deploymentRow: DeploymentRow;
      outcome: "accepted";
    }
  | Exclude<CreateReleaseResult, { outcome: "created" }>;

type ReleaseLifecyclePreconditionResult =
  | {
      deploymentRow: DeploymentRow;
      outcome: "accepted";
    }
  | Extract<
      ReleaseLifecycleCreateResult,
      { outcome: "conflict" | "invalid" | "not_found" }
    >;

interface InsertSourcedReleaseInput {
  appId: string;
  createdAt: Date;
  createdBy: UserId | null;
  deploymentId: DeploymentId;
  fingerprint: string | null;
  isMandatory: boolean;
  jobId: ReleaseJobId;
  releaseId: ReleaseId;
  releaseNotes: string | null;
  rollbackOf: ReleaseId | null;
  rolloutPercentage: number;
  signature: string | null;
  signatureHashAlgorithm: string | null;
  sourceBundleReleaseId: ReleaseId;
  status: "disabled" | "uploaded";
  targetBinaryVersion: string;
  targetPackageHash: string;
  teamId: string;
  triggerType: "release_promoted" | "release_rolled_back";
  warnings: ReleaseCreationWarning[];
}

export function createPostgresReleaseRepository(
  pool: DatabasePool | Pool,
): ReleaseRepository {
  return {
    async createRelease(input) {
      return withTransaction(pool, async (client) => {
        const preconditions = await checkReleaseCreatePreconditions(client, {
          deploymentId: input.deploymentId,
          signature: input.signature,
        });

        if (preconditions.outcome !== "accepted") {
          return preconditions;
        }

        const { deploymentRow } = preconditions;
        const duplicateRelease = input.targetPackageHash
          ? await findLatestPublishedReleaseWithPackageHash(
              client,
              input.deploymentId,
              input.targetPackageHash,
            )
          : null;

        if (duplicateRelease && !input.noDuplicateReleaseError) {
          return {
            latestRelease: duplicateRelease,
            outcome: "conflict",
            reason: "duplicate_release",
          };
        }

        const warnings: ReleaseCreationWarning[] = duplicateRelease
          ? [
              {
                code: "duplicate-release",
                detail: DUPLICATE_RELEASE_DETAIL,
              },
            ]
          : [];

        const fingerprintWarning = await detectFingerprintDisagreementWarning(
          client,
          input.deploymentId,
          input.targetBinaryVersion,
          input.fingerprint,
        );
        if (fingerprintWarning) {
          warnings.push(fingerprintWarning);
        }

        const nextReleaseLabel = await computeNextReleaseLabel(client, input.deploymentId);

        await client.query(`SAVEPOINT ${RELEASE_INSERT_SAVEPOINT}`);

        try {
          const insertedRelease = await client.query<ReleaseRow>(
            `
              INSERT INTO release (
                id,
                team_id,
                app_id,
                deployment_id,
                release_label,
                target_binary_version,
                fingerprint,
                target_package_hash,
                rollout_percentage,
                is_mandatory,
                release_notes,
                status,
                rollback_of,
                signature,
                signature_hash_algorithm,
                processing_started_at,
                processing_finished_at,
                processing_attempt_count,
                failure_stage,
                failure_reason,
                created_by,
                created_at,
                updated_at
              ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                $11, $12, NULL, $13, $14, NULL, NULL, 0,
                NULL, NULL, $15, $16, $16
              )
              RETURNING *
            `,
            [
              input.releaseId,
              deploymentRow.team_id,
              deploymentRow.app_id,
              input.deploymentId,
              nextReleaseLabel,
              input.targetBinaryVersion,
              input.fingerprint,
              input.targetPackageHash,
              input.rolloutPercentage,
              input.isMandatory,
              input.releaseNotes,
              input.status,
              input.signature,
              input.signatureHashAlgorithm,
              input.createdBy,
              input.createdAt,
            ],
          );

          const insertedJob = await client.query<ReleaseJobRow>(
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
                $1, $2, $3, 'release_created', 'queued', 0, 0, 15,
                NULL, NULL, NULL, NULL, $4, $5, $5
              )
              RETURNING *
            `,
            [
              input.jobId,
              input.releaseId,
              input.deploymentId,
              input.createdBy,
              input.createdAt,
            ],
          );

          return {
            job: mapReleaseJobRow(requireRow(insertedJob.rows[0], "release_job")),
            outcome: "created",
            release: mapReleaseRow(requireRow(insertedRelease.rows[0], "release")),
            ...(warnings.length > 0 ? { warnings } : {}),
          };
        } catch (error) {
          if (isActiveReleaseJobConflict(error)) {
            await rollbackToReleaseInsertSavepoint(client);
            const conflictingActiveJob = await findActiveDeploymentJob(client, input.deploymentId);
            if (conflictingActiveJob) {
              return {
                activeJob: conflictingActiveJob,
                outcome: "conflict",
                reason: "active_release_job_exists",
              };
            }
          }

          throw error;
        }
      });
    },

    async preflightCreateRelease(input) {
      return withTransaction(pool, async (client) => {
        const preconditions = await checkReleaseCreatePreconditions(client, input);

        if (preconditions.outcome !== "accepted") {
          return preconditions;
        }

        return {
          outcome: "accepted",
        };
      });
    },

    async findReleaseById(releaseId) {
      const releaseResult = await pool.query<ReleaseRow>(
        "SELECT * FROM release WHERE id = $1",
        [releaseId],
      );
      const releaseRow = releaseResult.rows[0];

      return releaseRow ? mapReleaseRow(releaseRow) : null;
    },

    async getReleaseById(releaseId) {
      const releaseResult = await pool.query<ReleaseRow>(
        "SELECT * FROM release WHERE id = $1",
        [releaseId],
      );
      const releaseRow = releaseResult.rows[0];

      if (!releaseRow) {
        return {
          outcome: "not_found",
          reason: "release_not_found",
        };
      }

      const jobResult = await pool.query<ReleaseJobRow>(
        `
          SELECT *
          FROM release_job
          WHERE release_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `,
        [releaseId],
      );

      return {
        job: jobResult.rows[0] ? mapReleaseJobRow(jobResult.rows[0]) : null,
        outcome: "found",
        release: mapReleaseRow(releaseRow),
      };
    },

    async listReleaseIdentitiesForDeployment(deploymentId) {
      const result = await pool.query<{
        created_at: Date | null;
        deployment_exists: boolean;
        id: string | null;
        release_label: string | null;
        target_package_hash: string | null;
      }>(
        `
          SELECT
            true AS deployment_exists,
            r.id,
            r.release_label,
            r.target_package_hash,
            r.created_at
          FROM deployment d
          LEFT JOIN release r ON r.deployment_id = d.id
          WHERE d.id = $1
          ORDER BY r.created_at DESC, r.id DESC
        `,
        [deploymentId],
      );

      if (result.rows.length === 0) {
        return {
          outcome: "not_found",
          reason: "deployment_not_found",
        };
      }

      return {
        outcome: "found",
        releases: result.rows
          .filter((row) => row.id !== null)
          .map((row) => ({
            createdAt: row.created_at!,
            id: row.id!,
            releaseLabel: row.release_label!,
            targetPackageHash: row.target_package_hash,
          })),
      };
    },

    async listReleasesForDeployment(input) {
      const countResult = await pool.query<{ total: number }>(
        `
          SELECT COUNT(r.id)::integer AS total
          FROM deployment d
          LEFT JOIN release r ON r.deployment_id = d.id
          WHERE d.id = $1
          GROUP BY d.id
        `,
        [input.deploymentId],
      );
      const countRow = countResult.rows[0];

      if (!countRow) {
        return {
          outcome: "not_found",
          reason: "deployment_not_found",
        };
      }

      const releaseResult = await pool.query<ReleaseListRow>(
        `
          SELECT
            r.*,
            latest_job.id AS latest_job_id,
            latest_job.release_id AS latest_job_release_id,
            latest_job.deployment_id AS latest_job_deployment_id,
            latest_job.trigger_type AS latest_job_trigger_type,
            latest_job.status AS latest_job_status,
            latest_job.attempt_count AS latest_job_attempt_count,
            latest_job.claim_generation AS latest_job_claim_generation,
            latest_job.max_total_attempts AS latest_job_max_total_attempts,
            latest_job.lease_expires_at AS latest_job_lease_expires_at,
            latest_job.last_heartbeat_at AS latest_job_last_heartbeat_at,
            latest_job.failure_stage AS latest_job_failure_stage,
            latest_job.failure_reason AS latest_job_failure_reason,
            latest_job.requested_by AS latest_job_requested_by,
            latest_job.created_at AS latest_job_created_at,
            latest_job.updated_at AS latest_job_updated_at
          FROM release r
          LEFT JOIN LATERAL (
            SELECT *
            FROM release_job rj
            WHERE rj.release_id = r.id
            ORDER BY rj.created_at DESC, rj.id DESC
            LIMIT 1
          ) latest_job ON true
          WHERE r.deployment_id = $1
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT $2 OFFSET $3
        `,
        [input.deploymentId, input.limit, input.offset],
      );

      return {
        outcome: "found",
        pagination: {
          limit: input.limit,
          offset: input.offset,
          total: countRow.total,
        },
        releases: releaseResult.rows.map((row) => ({
          job: mapLatestReleaseJob(row),
          release: mapReleaseRow(row),
        })),
      };
    },

    async patchRelease(input) {
      return withTransaction(pool, async (client) => {
        const releaseResult = await client.query<ReleaseRow>(
          "SELECT * FROM release WHERE id = $1 FOR UPDATE",
          [input.releaseId],
        );
        const releaseRow = releaseResult.rows[0];

        if (!releaseRow) {
          return {
            outcome: "not_found",
            reason: "release_not_found",
          };
        }

        const currentRelease = mapReleaseRow(releaseRow);
        const triggerType = derivePatchTriggerType(currentRelease.status, input.status);

        if (triggerType === "invalid") {
          return {
            outcome: "invalid",
            reason: "status_transition_not_allowed",
          };
        }

        if (!isPatchableReleaseStatus(currentRelease.status)) {
          return {
            outcome: "invalid",
            reason: "release_not_patchable",
          };
        }

        if (
          input.rolloutPercentage !== undefined &&
          input.rolloutPercentage < currentRelease.rolloutPercentage
        ) {
          return {
            outcome: "invalid",
            reason: "rollout_percentage_decrease",
          };
        }

        const nextReleaseValues = {
          isMandatory:
            input.isMandatory === undefined
              ? currentRelease.isMandatory
              : input.isMandatory,
          releaseNotes:
            input.releaseNotes === undefined
              ? currentRelease.releaseNotes
              : input.releaseNotes,
          rolloutPercentage:
            input.rolloutPercentage === undefined
              ? currentRelease.rolloutPercentage
              : input.rolloutPercentage,
          status:
            triggerType === "release_enabled"
              ? currentRelease.status
              : input.status === undefined
                ? currentRelease.status
                : input.status,
          targetBinaryVersion:
            input.targetBinaryVersion === undefined
              ? currentRelease.targetBinaryVersion
              : input.targetBinaryVersion,
        } satisfies {
          isMandatory: boolean;
          releaseNotes: string | null;
          rolloutPercentage: number;
          status: ReleaseStatus;
          targetBinaryVersion: string;
        };

        const changed =
          triggerType === "release_enabled" ||
          nextReleaseValues.isMandatory !== currentRelease.isMandatory ||
          nextReleaseValues.releaseNotes !== currentRelease.releaseNotes ||
          nextReleaseValues.rolloutPercentage !== currentRelease.rolloutPercentage ||
          nextReleaseValues.status !== currentRelease.status ||
          nextReleaseValues.targetBinaryVersion !== currentRelease.targetBinaryVersion;

        if (!changed) {
          return {
            outcome: "not_modified",
          };
        }

        const activeJob = await findActiveDeploymentJob(client, currentRelease.deploymentId);
        if (activeJob) {
          return {
            activeJob,
            outcome: "conflict",
            reason: "active_release_job_exists",
          };
        }

        if (
          triggerType === "release_enabled" &&
          !currentRelease.signature &&
          (await appRequiresCodeSigning(client, currentRelease.appId))
        ) {
          return {
            outcome: "invalid",
            reason: "signature_required",
          };
        }

        let jobResult;

        await client.query(`SAVEPOINT ${RELEASE_INSERT_SAVEPOINT}`);

        try {
          jobResult = await client.query<ReleaseJobRow>(
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
                $1, $2, $3, $4, 'queued', 0, 0, 15,
                NULL, NULL, NULL, NULL, $5, $6, $6
              )
              RETURNING *
            `,
            [
              input.jobId,
              input.releaseId,
              currentRelease.deploymentId,
              triggerType,
              input.createdBy,
              input.createdAt,
            ],
          );
        } catch (error) {
          if (isActiveReleaseJobConflict(error)) {
            await rollbackToReleaseInsertSavepoint(client);
            const conflictingActiveJob = await findActiveDeploymentJob(
              client,
              currentRelease.deploymentId,
            );
            if (conflictingActiveJob) {
              return {
                activeJob: conflictingActiveJob,
                outcome: "conflict",
                reason: "active_release_job_exists",
              };
            }
          }

          throw error;
        }

        const updatedReleaseResult = await client.query<ReleaseRow>(
          `
            UPDATE release
            SET target_binary_version = $2,
                rollout_percentage = $3,
                is_mandatory = $4,
                release_notes = $5,
                status = $6,
                failure_stage = NULL,
                failure_reason = NULL,
                updated_at = $7
            WHERE id = $1
            RETURNING *
          `,
          [
            input.releaseId,
            nextReleaseValues.targetBinaryVersion,
            nextReleaseValues.rolloutPercentage,
            nextReleaseValues.isMandatory,
            nextReleaseValues.releaseNotes,
            nextReleaseValues.status,
            input.createdAt,
          ],
        );

        const updatedRelease = requireRow(updatedReleaseResult.rows[0], "release");

        // Only a retarget can introduce a new disagreement; the original
        // binary version was already checked when the release was created.
        const fingerprintWarning =
          nextReleaseValues.targetBinaryVersion !== currentRelease.targetBinaryVersion
            ? await detectFingerprintDisagreementWarning(
                client,
                currentRelease.deploymentId,
                nextReleaseValues.targetBinaryVersion,
                currentRelease.fingerprint,
              )
            : null;

        return {
          job: mapReleaseJobRow(requireRow(jobResult.rows[0], "release_job")),
          outcome: "updated",
          release: mapReleaseRow(updatedRelease),
          ...(fingerprintWarning ? { warnings: [fingerprintWarning] } : {}),
        };
      });
    },

    async promoteRelease(input) {
      return withTransaction(pool, async (client) => {
        const sourceResult = await client.query<ReleaseRow>(
          "SELECT * FROM release WHERE id = $1",
          [input.sourceReleaseId],
        );
        const source = sourceResult.rows[0];

        if (!source) {
          return {
            outcome: "not_found",
            reason: "release_not_found",
          };
        }

        if (!(await isReusableBundleSource(client, source))) {
          return {
            outcome: "invalid",
            reason: "release_not_promotable",
          };
        }

        const preconditions = await checkLifecycleCreatePreconditions(client, {
          deploymentId: input.destinationDeploymentId,
          signature: source.signature,
        });
        if (preconditions.outcome !== "accepted") {
          return preconditions;
        }

        const duplicateRelease = await findLatestPublishedReleaseWithPackageHash(
          client,
          input.destinationDeploymentId,
          source.target_package_hash!,
        );

        if (duplicateRelease && !input.noDuplicateReleaseError) {
          return {
            latestRelease: duplicateRelease,
            outcome: "conflict",
            reason: "duplicate_release",
          };
        }

        const warnings: ReleaseCreationWarning[] = duplicateRelease
          ? [
              {
                code: "duplicate-release",
                detail: DUPLICATE_RELEASE_DETAIL,
              },
            ]
          : [];

        const targetBinaryVersion =
          input.targetBinaryVersion ?? source.target_binary_version;
        const fingerprintWarning = await detectFingerprintDisagreementWarning(
          client,
          input.destinationDeploymentId,
          targetBinaryVersion,
          source.fingerprint,
        );
        if (fingerprintWarning) {
          warnings.push(fingerprintWarning);
        }

        return insertSourcedRelease(client, {
          appId: preconditions.deploymentRow.app_id,
          createdAt: input.createdAt,
          createdBy: input.createdBy,
          deploymentId: input.destinationDeploymentId,
          fingerprint: source.fingerprint,
          isMandatory: input.isMandatory ?? source.is_mandatory,
          jobId: input.jobId,
          releaseId: input.releaseId,
          releaseNotes:
            input.releaseNotes === undefined
              ? source.release_notes
              : input.releaseNotes,
          rollbackOf: null,
          rolloutPercentage: input.rolloutPercentage,
          signature: source.signature,
          signatureHashAlgorithm: source.signature_hash_algorithm,
          sourceBundleReleaseId: input.sourceReleaseId,
          status: input.disabled ? "disabled" : "uploaded",
          targetBinaryVersion,
          targetPackageHash: source.target_package_hash!,
          teamId: preconditions.deploymentRow.team_id,
          triggerType: "release_promoted",
          warnings,
        });
      });
    },

    async rollbackDeployment(input) {
      return withTransaction(pool, async (client) => {
        const preconditions = await checkLifecycleCreatePreconditions(client, {
          deploymentId: input.deploymentId,
          signature: "rollback-target-resolved-later",
        });
        if (preconditions.outcome !== "accepted") {
          return preconditions;
        }

        const rollbackTarget = await resolveRollbackTarget(client, input);
        if (rollbackTarget.outcome !== "found") {
          return rollbackTarget;
        }

        const { currentRelease, targetRelease } = rollbackTarget;
        if (
          (await appRequiresCodeSigning(client, preconditions.deploymentRow.app_id)) &&
          !targetRelease.signature
        ) {
          return {
            outcome: "invalid",
            reason: "signature_required",
          };
        }

        if (currentRelease.target_package_hash === targetRelease.target_package_hash) {
          return {
            outcome: "conflict",
            reason: "rollback_no_op",
          };
        }

        if (!(await isReusableBundleSource(client, targetRelease))) {
          return {
            outcome: "invalid",
            reason: "release_not_promotable",
          };
        }

        return insertSourcedRelease(client, {
          appId: preconditions.deploymentRow.app_id,
          createdAt: input.createdAt,
          createdBy: input.createdBy,
          deploymentId: input.deploymentId,
          fingerprint: targetRelease.fingerprint,
          isMandatory: targetRelease.is_mandatory,
          jobId: input.jobId,
          releaseId: input.releaseId,
          releaseNotes: targetRelease.release_notes,
          rollbackOf: targetRelease.id as ReleaseId,
          rolloutPercentage: 100,
          signature: targetRelease.signature,
          signatureHashAlgorithm: targetRelease.signature_hash_algorithm,
          sourceBundleReleaseId: targetRelease.id as ReleaseId,
          status: "uploaded",
          targetBinaryVersion: targetRelease.target_binary_version,
          targetPackageHash: targetRelease.target_package_hash!,
          teamId: preconditions.deploymentRow.team_id,
          triggerType: "release_rolled_back",
          // No fingerprint-disagreement warning here: rollback re-publishes a
          // release that already shipped through this deployment, and the
          // emergency path should stay quiet.
          warnings: [],
        });
      });
    },

    async setReleaseTargetPackageHash(releaseId, targetPackageHash) {
      const result = await pool.query<{ id: string }>(
        `
          UPDATE release
          SET target_package_hash = $2,
              updated_at = NOW()
          WHERE id = $1
            AND (target_package_hash IS NULL OR target_package_hash = $2)
          RETURNING id
        `,
        [releaseId, targetPackageHash],
      );

      return result.rows[0] !== undefined;
    },
  };
}

function derivePatchTriggerType(
  currentStatus: ReleaseStatus,
  requestedStatus: PatchReleaseInput["status"],
): ReleaseJobTriggerType | "invalid" {
  if (requestedStatus === undefined) {
    return "release_patched";
  }

  if (requestedStatus === "disabled" && currentStatus === "published") {
    return "release_disabled";
  }

  if (requestedStatus === "published" && currentStatus === "disabled") {
    return "release_enabled";
  }

  if (requestedStatus === currentStatus) {
    return "release_patched";
  }

  return "invalid";
}

function isPatchableReleaseStatus(status: ReleaseStatus): boolean {
  return status === "published" || status === "disabled";
}

function mapLatestReleaseJob(row: ReleaseListRow): ReleaseJob | null {
  if (row.latest_job_id === null) {
    return null;
  }

  return mapReleaseJobRow({
    attempt_count: requireValue(
      row.latest_job_attempt_count,
      "latest_job.attempt_count",
    ),
    claim_generation: requireValue(
      row.latest_job_claim_generation,
      "latest_job.claim_generation",
    ),
    created_at: requireValue(row.latest_job_created_at, "latest_job.created_at"),
    deployment_id: requireValue(
      row.latest_job_deployment_id,
      "latest_job.deployment_id",
    ),
    failure_reason: row.latest_job_failure_reason,
    failure_stage: row.latest_job_failure_stage,
    id: row.latest_job_id,
    last_heartbeat_at: row.latest_job_last_heartbeat_at,
    lease_expires_at: row.latest_job_lease_expires_at,
    max_total_attempts: requireValue(
      row.latest_job_max_total_attempts,
      "latest_job.max_total_attempts",
    ),
    release_id: requireValue(
      row.latest_job_release_id,
      "latest_job.release_id",
    ),
    requested_by: row.latest_job_requested_by,
    status: requireValue(row.latest_job_status, "latest_job.status"),
    trigger_type: requireValue(
      row.latest_job_trigger_type,
      "latest_job.trigger_type",
    ),
    updated_at: requireValue(row.latest_job_updated_at, "latest_job.updated_at"),
  });
}

async function findActiveDeploymentJob(
  client: Queryable,
  deploymentId: DeploymentId,
): Promise<{
  jobId: ReleaseJobId;
  releaseId: ReleaseId;
  status: "queued" | "running";
} | null> {
  const result = await client.query<{
    id: string;
    release_id: string;
    status: "queued" | "running";
  }>(
    `
      SELECT id, release_id, status
      FROM release_job
      WHERE deployment_id = $1
        AND status IN ('queued', 'running')
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `,
    [deploymentId],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    jobId: row.id as ReleaseJobId,
    releaseId: row.release_id as ReleaseId,
    status: row.status,
  };
}

async function findLatestPublishedReleaseWithPackageHash(
  client: Queryable,
  deploymentId: DeploymentId,
  targetPackageHash: string,
): Promise<LatestReleasePackageHash | null> {
  const result = await client.query<{
    id: string;
    release_label: string;
    target_package_hash: string;
  }>(
    `
      SELECT id, release_label, target_package_hash
      FROM release
      WHERE deployment_id = $1
        AND status = 'published'
        AND target_package_hash IS NOT NULL
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [deploymentId],
  );

  const row = result.rows[0];
  if (!row || row.target_package_hash !== targetPackageHash) {
    return null;
  }

  return {
    releaseId: row.id as ReleaseId,
    releaseLabel: row.release_label,
    targetPackageHash: row.target_package_hash,
  };
}

/**
 * Look up the fingerprint the worker recorded for this binary version. Returns
 * null for the first release targeting a binary version (the worker has not
 * written the row yet at create time), so concurrent first releases with
 * different fingerprints both pass without a warning — the worker's
 * disagreement log still covers that race.
 */
async function findStoredBinaryVersionFingerprint(
  client: Queryable,
  deploymentId: DeploymentId,
  binaryVersion: string,
): Promise<string | null> {
  const result = await client.query<{ fingerprint: string }>(
    `
      SELECT fingerprint
      FROM binary_version_fingerprint
      WHERE deployment_id = $1 AND binary_version = $2
    `,
    [deploymentId, binaryVersion],
  );

  return result.rows[0]?.fingerprint ?? null;
}

function fingerprintDisagreementWarning(
  binaryVersion: string,
  storedFingerprint: string,
  releaseFingerprint: string,
): ReleaseCreationWarning {
  const truncate = (value: string): string =>
    value.length > 12 ? `${value.slice(0, 12)}…` : value;

  return {
    binaryVersion,
    code: "fingerprint-disagreement",
    detail:
      `release fingerprint ${truncate(releaseFingerprint)} differs from the fingerprint ` +
      `${truncate(storedFingerprint)} recorded for binary version ${binaryVersion} in this ` +
      `deployment; devices on this binary version may be native-incompatible with this update`,
    releaseFingerprint,
    storedFingerprint,
  };
}

async function detectFingerprintDisagreementWarning(
  client: Queryable,
  deploymentId: DeploymentId,
  binaryVersion: string,
  releaseFingerprint: string | null,
): Promise<ReleaseCreationWarning | null> {
  if (releaseFingerprint === null) {
    return null;
  }

  const storedFingerprint = await findStoredBinaryVersionFingerprint(
    client,
    deploymentId,
    binaryVersion,
  );
  if (storedFingerprint === null || storedFingerprint === releaseFingerprint) {
    return null;
  }

  return fingerprintDisagreementWarning(
    binaryVersion,
    storedFingerprint,
    releaseFingerprint,
  );
}

async function checkReleaseCreatePreconditions(
  client: Queryable,
  input: PreflightCreateReleaseInput,
): Promise<ReleaseCreatePreconditionResult> {
  const deploymentResult = await client.query<DeploymentRow>(
    "SELECT * FROM deployment WHERE id = $1 FOR UPDATE",
    [input.deploymentId],
  );
  const deploymentRow = deploymentResult.rows[0];

  if (!deploymentRow) {
    return {
      outcome: "not_created",
      reason: "deployment_not_found",
    };
  }

  const activeJob = await findActiveDeploymentJob(client, input.deploymentId);
  if (activeJob) {
    return {
      activeJob,
      outcome: "conflict",
      reason: "active_release_job_exists",
    };
  }

  const partialRolloutResult = await client.query<{ id: string }>(
    `
      SELECT id
      FROM release
      WHERE deployment_id = $1
        AND status = 'published'
        AND rollout_percentage < 100
      LIMIT 1
    `,
    [input.deploymentId],
  );

  if (partialRolloutResult.rows[0]) {
    return {
      outcome: "conflict",
      reason: "active_rollout_exists",
    };
  }

  const appSettingsResult = await client.query<{ require_code_signing: boolean }>(
    "SELECT require_code_signing FROM app WHERE id = $1",
    [deploymentRow.app_id],
  );
  const appSettings = requireRow(appSettingsResult.rows[0], "app");

  if (appSettings.require_code_signing && !input.signature) {
    return {
      outcome: "invalid",
      reason: "signature_required",
    };
  }

  return {
    deploymentRow,
    outcome: "accepted",
  };
}

async function checkLifecycleCreatePreconditions(
  client: Queryable,
  input: PreflightCreateReleaseInput,
): Promise<ReleaseLifecyclePreconditionResult> {
  const releasePreconditions = await checkReleaseCreatePreconditions(client, input);

  if (releasePreconditions.outcome === "accepted") {
    return releasePreconditions;
  }

  if (releasePreconditions.outcome === "not_created") {
    return {
      outcome: "not_found",
      reason: "deployment_not_found",
    };
  }

  return releasePreconditions;
}

async function isReusableBundleSource(
  client: Queryable,
  row: ReleaseRow,
): Promise<boolean> {
  if (
    row.target_package_hash === null ||
    (row.status !== "published" && row.status !== "disabled")
  ) {
    return false;
  }

  const artifactResult = await client.query<{ id: string }>(
    `
      SELECT id
      FROM release_artifact
      WHERE release_id = $1
        AND artifact_type = 'bundle'
      LIMIT 1
    `,
    [row.id],
  );

  return artifactResult.rows[0] !== undefined;
}

async function appRequiresCodeSigning(
  client: Queryable,
  appId: string,
): Promise<boolean> {
  const appSettingsResult = await client.query<{ require_code_signing: boolean }>(
    "SELECT require_code_signing FROM app WHERE id = $1",
    [appId],
  );
  const appSettings = requireRow(appSettingsResult.rows[0], "app");

  return appSettings.require_code_signing;
}

async function insertSourcedRelease(
  client: Queryable,
  input: InsertSourcedReleaseInput,
): Promise<ReleaseLifecycleCreateResult> {
  const nextReleaseLabel = await computeNextReleaseLabel(
    client,
    input.deploymentId,
  );

  await client.query(`SAVEPOINT ${RELEASE_INSERT_SAVEPOINT}`);

  try {
    const releaseResult = await client.query<ReleaseRow>(
      `
        INSERT INTO release (
          id,
          team_id,
          app_id,
          deployment_id,
          release_label,
          target_binary_version,
          fingerprint,
          target_package_hash,
          rollout_percentage,
          is_mandatory,
          release_notes,
          status,
          rollback_of,
          source_bundle_release_id,
          signature,
          signature_hash_algorithm,
          processing_started_at,
          processing_finished_at,
          processing_attempt_count,
          failure_stage,
          failure_reason,
          created_by,
          created_at,
          updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, NULL, NULL, 0,
          NULL, NULL, $17, $18, $18
        )
        RETURNING *
      `,
      [
        input.releaseId,
        input.teamId,
        input.appId,
        input.deploymentId,
        nextReleaseLabel,
        input.targetBinaryVersion,
        input.fingerprint,
        input.targetPackageHash,
        input.rolloutPercentage,
        input.isMandatory,
        input.releaseNotes,
        input.status,
        input.rollbackOf,
        input.sourceBundleReleaseId,
        input.signature,
        input.signatureHashAlgorithm,
        input.createdBy,
        input.createdAt,
      ],
    );

    const jobResult = await client.query<ReleaseJobRow>(
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
          $1, $2, $3, $4, 'queued', 0, 0, 15,
          NULL, NULL, NULL, NULL, $5, $6, $6
        )
        RETURNING *
      `,
      [
        input.jobId,
        input.releaseId,
        input.deploymentId,
        input.triggerType,
        input.createdBy,
        input.createdAt,
      ],
    );

    return {
      job: mapReleaseJobRow(requireRow(jobResult.rows[0], "release_job")),
      outcome: "created",
      release: mapReleaseRow(requireRow(releaseResult.rows[0], "release")),
      ...(input.warnings.length > 0 ? { warnings: input.warnings } : {}),
    };
  } catch (error) {
    if (isActiveReleaseJobConflict(error)) {
      await rollbackToReleaseInsertSavepoint(client);
      const activeJob = await findActiveDeploymentJob(client, input.deploymentId);
      if (activeJob) {
        return {
          activeJob,
          outcome: "conflict",
          reason: "active_release_job_exists",
        };
      }
    }

    throw error;
  }
}

type RollbackTargetResult =
  | {
      currentRelease: ReleaseRow;
      outcome: "found";
      targetRelease: ReleaseRow;
    }
  | {
      outcome: "conflict";
      reason: "rollback_no_op";
    }
  | {
      outcome: "not_found";
      reason: "rollback_target_not_found";
    };

async function resolveRollbackTarget(
  client: Queryable,
  input: RollbackDeploymentInput,
): Promise<RollbackTargetResult> {
  const currentResult = await client.query<ReleaseRow>(
    `
      SELECT *
      FROM release
      WHERE deployment_id = $1
        AND status = 'published'
        AND target_package_hash IS NOT NULL
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [input.deploymentId],
  );
  const currentRelease = currentResult.rows[0];

  if (!currentRelease) {
    return {
      outcome: "conflict",
      reason: "rollback_no_op",
    };
  }

  const targetResult =
    input.targetReleaseLabel === null
      ? await client.query<ReleaseRow>(
          `
            SELECT *
            FROM release
            WHERE deployment_id = $1
              AND status = 'published'
              AND target_package_hash IS NOT NULL
              AND id <> $2
            ORDER BY created_at DESC, id DESC
            LIMIT 1
          `,
          [input.deploymentId, currentRelease.id],
        )
      : await client.query<ReleaseRow>(
          `
            SELECT *
            FROM release
            WHERE deployment_id = $1
              AND release_label = $2
              AND status = 'published'
              AND target_package_hash IS NOT NULL
            LIMIT 1
          `,
          [input.deploymentId, input.targetReleaseLabel],
        );
  const targetRelease = targetResult.rows[0];

  if (!targetRelease) {
    return input.targetReleaseLabel === null
      ? {
          outcome: "conflict",
          reason: "rollback_no_op",
        }
      : {
          outcome: "not_found",
          reason: "rollback_target_not_found",
        };
  }

  return {
    currentRelease,
    outcome: "found",
    targetRelease,
  };
}

async function computeNextReleaseLabel(
  client: Queryable,
  deploymentId: DeploymentId,
): Promise<string> {
  const result = await client.query<{ max_release_number: number | null }>(
    `
      SELECT MAX(
        CASE
          WHEN release_label ~ '^v[0-9]+$'
            THEN SUBSTRING(release_label FROM 2)::INTEGER
          ELSE NULL
        END
      ) AS max_release_number
      FROM release
      WHERE deployment_id = $1
    `,
    [deploymentId],
  );

  const maxReleaseNumber = result.rows[0]?.max_release_number ?? 0;
  return `v${maxReleaseNumber + 1}`;
}

const RELEASE_INSERT_SAVEPOINT = "release_insert";
const ACTIVE_RELEASE_JOB_CONSTRAINT = "idx_release_job_deployment_active";

// A failed INSERT leaves the surrounding transaction aborted, so the
// active-job recovery lookup must first roll back to the savepoint taken
// right before the insert.
async function rollbackToReleaseInsertSavepoint(client: Queryable): Promise<void> {
  await client.query(`ROLLBACK TO SAVEPOINT ${RELEASE_INSERT_SAVEPOINT}`);
}

function isActiveReleaseJobConflict(error: unknown): boolean {
  return uniqueConstraint(error) === ACTIVE_RELEASE_JOB_CONSTRAINT;
}

function uniqueConstraint(error: unknown): string | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    typeof error.constraint === "string"
  ) {
    return error.constraint;
  }

  return null;
}

function requireRow<T>(row: T | undefined, tableName: string): T {
  if (!row) {
    throw new Error(`Expected ${tableName} row to exist`);
  }

  return row;
}

function requireValue<T>(value: T | null, columnName: string): T {
  if (value === null) {
    throw new Error(`Expected ${columnName} to exist`);
  }

  return value;
}
