import type { Pool } from "pg";

import { withTransaction } from "../db";
import type { ReleaseId, ReleaseJobId, ReleaseTarget } from "../domain";
import type { DatabasePool } from "../db";
import { makeBundleInternalKey } from "../worker/artifactKeys";
import type { BundleSource, ReconcileContext } from "../worker/types";
import {
  mapDeploymentRow,
  mapReleaseJobRow,
  mapReleaseRow,
  mapReleaseTargetRow,
  type DeploymentRow,
  type ReleaseJobRow,
  type ReleaseRow,
  type ReleaseTargetRow,
} from "./rowMappers";

type ReconcileReleaseRow = ReleaseRow & {
  source_bundle_release_id: string | null;
};

export interface ReconcileContextRepository {
  loadReconcileContext(jobId: ReleaseJobId): Promise<ReconcileContext | null>;
}

export function createPostgresReconcileContextRepository(
  pool: DatabasePool | Pool,
  patchWindow: number | null = null,
): ReconcileContextRepository {
  return {
    async loadReconcileContext(jobId) {
      return withTransaction(pool, async (client) => {
        const jobResult = await client.query<ReleaseJobRow>(
          "SELECT * FROM release_job WHERE id = $1",
          [jobId],
        );
        const jobRow = jobResult.rows[0];
        if (!jobRow) {
          return null;
        }

        const releaseResult = await client.query<ReconcileReleaseRow>(
          "SELECT * FROM release WHERE id = $1",
          [jobRow.release_id],
        );
        const releaseRow = requireRow(releaseResult.rows[0], "release");

        const deploymentResult = await client.query<DeploymentRow>(
          "SELECT * FROM deployment WHERE id = $1",
          [jobRow.deployment_id],
        );
        const deploymentRow = requireRow(deploymentResult.rows[0], "deployment");

        const appSettingsResult = await client.query<{ require_code_signing: boolean }>(
          "SELECT require_code_signing FROM app WHERE id = $1",
          [releaseRow.app_id],
        );
        const appSettingsRow = requireRow(appSettingsResult.rows[0], "app");

        const publishedReleaseRows = await client.query<ReleaseRow>(
          `
            SELECT *
            FROM release
            WHERE deployment_id = $1
              AND status IN ('published', 'disabled')
            ORDER BY created_at DESC, id DESC
          `,
          [deploymentRow.id],
        );

        const activeTargetRows = await client.query<ReleaseTargetRow>(
          `
            WITH latest_active_generation AS (
              SELECT release_id, MAX(reconcile_generation) AS reconcile_generation
              FROM release_target
              WHERE status = 'active'
              GROUP BY release_id
            )
            SELECT rt.*
            FROM release_target rt
            JOIN latest_active_generation lag
              ON lag.release_id = rt.release_id
             AND lag.reconcile_generation = rt.reconcile_generation
            JOIN release r
              ON r.id = rt.release_id
            WHERE rt.status = 'active'
              AND r.deployment_id = $1
              AND r.status = 'published'
            ORDER BY rt.binary_version ASC, r.created_at DESC, rt.id ASC
          `,
          [deploymentRow.id],
        );

        const historicalTargetRows = await client.query<ReleaseTargetRow>(
          `
            WITH latest_active_generation AS (
              SELECT release_id, MAX(reconcile_generation) AS reconcile_generation
              FROM release_target
              WHERE status = 'active'
              GROUP BY release_id
            )
            SELECT rt.*
            FROM release_target rt
            JOIN latest_active_generation lag
              ON lag.release_id = rt.release_id
             AND lag.reconcile_generation = rt.reconcile_generation
            JOIN release r
              ON r.id = rt.release_id
            WHERE rt.status = 'active'
              AND r.deployment_id = $1
              AND r.status IN ('published', 'disabled')
            ORDER BY rt.binary_version ASC, r.created_at DESC, rt.id ASC
          `,
          [deploymentRow.id],
        );

        const previousActiveTargetRows = await client.query<ReleaseTargetRow>(
          `
            WITH latest_active_generation AS (
              SELECT MAX(reconcile_generation) AS reconcile_generation
              FROM release_target
              WHERE release_id = $1
                AND status = 'active'
            )
            SELECT rt.*
            FROM release_target rt
            CROSS JOIN latest_active_generation lag
            WHERE rt.release_id = $1
              AND rt.status = 'active'
              AND rt.reconcile_generation = lag.reconcile_generation
            ORDER BY rt.binary_version ASC, rt.id ASC
          `,
          [releaseRow.id],
        );

        const inferredFingerprintRows = await client.query<{
          binary_version: string;
          fingerprint: string;
        }>(
          `
            SELECT binary_version, fingerprint
            FROM binary_version_fingerprint
            WHERE deployment_id = $1
            ORDER BY binary_version ASC
          `,
          [deploymentRow.id],
        );

        return {
          activeTargetsByBinaryVersion: groupTargetsByBinaryVersion(
            activeTargetRows.rows.map(mapReleaseTargetRow),
          ),
          appSettings: {
            requireCodeSigning: appSettingsRow.require_code_signing,
          },
          bundleSource: deriveBundleSource(
            mapReleaseRow(releaseRow),
            releaseRow.source_bundle_release_id,
          ),
          deployment: mapDeploymentRow(deploymentRow),
          historicalTargetsByBinaryVersion: groupTargetsByBinaryVersion(
            historicalTargetRows.rows.map(mapReleaseTargetRow),
          ),
          inferredFingerprints: new Map(
            inferredFingerprintRows.rows.map((row) => [row.binary_version, row.fingerprint] as const),
          ),
          job: mapReleaseJobRow(jobRow),
          patchWindow,
          previousActiveTargets: previousActiveTargetRows.rows.map(mapReleaseTargetRow),
          publishedReleases: publishedReleaseRows.rows.map(mapReleaseRow),
          release: mapReleaseRow(releaseRow),
        };
      });
    },
  };
}

function groupTargetsByBinaryVersion(targets: ReleaseTarget[]): Map<string, ReleaseTarget[]> {
  const grouped = new Map<string, ReleaseTarget[]>();

  for (const target of targets) {
    const currentTargets = grouped.get(target.binaryVersion) ?? [];
    currentTargets.push(target);
    grouped.set(target.binaryVersion, currentTargets);
  }

  return grouped;
}

function deriveBundleSource(
  release: ReconcileContext["release"],
  sourceBundleReleaseId: string | null,
): BundleSource | null {
  if (release.status === "failed") {
    return null;
  }

  if (release.status === "published") {
    return {
      kind: "existing",
      sourceReleaseId: release.id,
      internalKey: makeBundleInternalKey(release.id),
    };
  }

  if (release.status === "disabled" && release.processingFinishedAt !== null) {
    return {
      kind: "existing",
      sourceReleaseId: release.id,
      internalKey: makeBundleInternalKey(release.id),
    };
  }

  if (sourceBundleReleaseId !== null) {
    const sourceReleaseId = sourceBundleReleaseId as ReleaseId;

    return {
      kind: "existing",
      sourceReleaseId,
      internalKey: makeBundleInternalKey(sourceReleaseId),
    };
  }

  return {
    kind: "staged",
    uploadKey: `_internal/uploads/releases/${release.id}/bundle.zip`,
  };
}

function requireRow<T>(row: T | undefined, tableName: string): T {
  if (!row) {
    throw new Error(`Expected ${tableName} row to exist`);
  }

  return row;
}
