import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import { withTransaction } from "../db";
import type { ArtifactType, ReleaseArtifact, ReleaseId } from "../domain";
import type { DatabasePool } from "../db";

export interface PersistReleaseArtifactInput {
  artifactType: ArtifactType;
  contentHash: string | null;
  fileSize: number | null;
  metadata: Record<string, unknown> | null;
  releaseId: ReleaseId;
  storageKey: string;
}

export interface ReleaseArtifactRepository {
  replaceReleaseArtifacts(
    releaseId: ReleaseId,
    artifacts: PersistReleaseArtifactInput[],
  ): Promise<void>;
}

export function createPostgresReleaseArtifactRepository(
  pool: DatabasePool | Pool,
): ReleaseArtifactRepository {
  return {
    async replaceReleaseArtifacts(releaseId, artifacts) {
      await withTransaction(pool, async (client) => {
        await client.query(
          "DELETE FROM release_artifact WHERE release_id = $1",
          [releaseId],
        );

        for (const artifact of artifacts) {
          await client.query(
            `
              INSERT INTO release_artifact (
                id,
                release_id,
                artifact_type,
                storage_key,
                file_size,
                content_hash,
                metadata,
                created_at
              ) VALUES (
                $1, $2, $3, $4, $5, $6, $7::jsonb, NOW()
              )
            `,
            [
              createReleaseArtifactId(),
              releaseId,
              artifact.artifactType,
              artifact.storageKey,
              artifact.fileSize,
              artifact.contentHash,
              artifact.metadata ? JSON.stringify(artifact.metadata) : null,
            ],
          );
        }
      });
    },
  };
}

function createReleaseArtifactId(): ReleaseArtifact["id"] {
  return `ra_${randomUUID().replace(/-/g, "")}` as ReleaseArtifact["id"];
}
