import type { SqlMigration } from "./index";

export const workerMvpMigration: SqlMigration = {
  name: "0001_worker_mvp",
  sql: `
    CREATE TABLE team (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'disabled')),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX idx_team_name ON team (name);

    CREATE TABLE app (
      id                    TEXT PRIMARY KEY,
      team_id               TEXT NOT NULL REFERENCES team (id) ON DELETE CASCADE,
      name                  TEXT NOT NULL,
      require_code_signing  BOOLEAN NOT NULL DEFAULT false,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX idx_app_team_name ON app (team_id, name);

    CREATE TABLE deployment (
      id              TEXT PRIMARY KEY,
      app_id          TEXT NOT NULL REFERENCES app (id) ON DELETE CASCADE,
      team_id         TEXT NOT NULL REFERENCES team (id) ON DELETE CASCADE,
      name            TEXT NOT NULL,
      deployment_key  TEXT NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX idx_deployment_app_name ON deployment (app_id, name);
    CREATE UNIQUE INDEX idx_deployment_key ON deployment (deployment_key);

    CREATE TABLE release (
      id                        TEXT PRIMARY KEY,
      team_id                   TEXT NOT NULL REFERENCES team (id) ON DELETE CASCADE,
      app_id                    TEXT NOT NULL REFERENCES app (id) ON DELETE CASCADE,
      deployment_id             TEXT NOT NULL REFERENCES deployment (id) ON DELETE CASCADE,
      release_label             TEXT NOT NULL,
      target_binary_version     TEXT NOT NULL,
      fingerprint               TEXT NOT NULL,
      target_package_hash       TEXT,
      rollout_percentage        INTEGER NOT NULL DEFAULT 100
                                CHECK (rollout_percentage BETWEEN 1 AND 100),
      is_mandatory              BOOLEAN NOT NULL DEFAULT false,
      release_notes             TEXT,
      status                    TEXT NOT NULL DEFAULT 'uploaded'
                                CHECK (status IN ('uploaded', 'processing', 'published', 'failed', 'disabled')),
      rollback_of               TEXT REFERENCES release (id) ON DELETE SET NULL,
      signature                 TEXT,
      signature_hash_algorithm  TEXT,
      processing_started_at     TIMESTAMPTZ,
      processing_finished_at    TIMESTAMPTZ,
      processing_attempt_count  INTEGER NOT NULL DEFAULT 0,
      failure_stage             TEXT,
      failure_reason            TEXT,
      created_by                TEXT,
      created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX idx_release_deployment_label ON release (deployment_id, release_label);
    CREATE INDEX idx_release_deployment_status ON release (deployment_id, status);
    CREATE INDEX idx_release_deployment_created ON release (deployment_id, created_at);

    CREATE TABLE release_job (
      id                  TEXT PRIMARY KEY,
      release_id          TEXT NOT NULL REFERENCES release (id) ON DELETE CASCADE,
      deployment_id       TEXT NOT NULL REFERENCES deployment (id) ON DELETE CASCADE,
      trigger_type        TEXT NOT NULL
                          CHECK (trigger_type IN (
                            'release_created', 'release_promoted', 'release_rolled_back',
                            'release_patched', 'release_disabled', 'release_enabled'
                          )),
      status              TEXT NOT NULL DEFAULT 'queued'
                          CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'dead_letter')),
      attempt_count       INTEGER NOT NULL DEFAULT 0,
      claim_generation    INTEGER NOT NULL DEFAULT 0,
      max_total_attempts  INTEGER NOT NULL DEFAULT 15,
      lease_expires_at    TIMESTAMPTZ,
      last_heartbeat_at   TIMESTAMPTZ,
      failure_stage       TEXT,
      failure_reason      TEXT,
      requested_by        TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX idx_release_job_deployment_active
      ON release_job (deployment_id)
      WHERE status IN ('queued', 'running');
    CREATE INDEX idx_release_job_status ON release_job (status);
    CREATE INDEX idx_release_job_release ON release_job (release_id);
    CREATE INDEX idx_release_job_lease ON release_job (status, lease_expires_at)
      WHERE status = 'running';

    CREATE TABLE release_target (
      id                    TEXT PRIMARY KEY,
      release_id            TEXT NOT NULL REFERENCES release (id) ON DELETE CASCADE,
      binary_version        TEXT NOT NULL,
      resolution_source     TEXT NOT NULL CHECK (resolution_source IN ('explicit', 'fingerprint')),
      fingerprint           TEXT,
      reconcile_generation  INTEGER NOT NULL,
      status                TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'active')),
      job_id                TEXT NOT NULL REFERENCES release_job (id) ON DELETE CASCADE,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX idx_release_target_unique
      ON release_target (release_id, binary_version, reconcile_generation);
    CREATE INDEX idx_release_target_active
      ON release_target (release_id, status, reconcile_generation)
      WHERE status = 'active';
    CREATE INDEX idx_release_target_pending_job
      ON release_target (job_id)
      WHERE status = 'pending';
    CREATE INDEX idx_release_target_fingerprint
      ON release_target (fingerprint)
      WHERE fingerprint IS NOT NULL AND status = 'active';

    CREATE TABLE release_artifact (
      id            TEXT PRIMARY KEY,
      release_id    TEXT NOT NULL REFERENCES release (id) ON DELETE CASCADE,
      artifact_type TEXT NOT NULL CHECK (artifact_type IN ('bundle', 'patch', 'sourcemap')),
      storage_key   TEXT NOT NULL,
      file_size     BIGINT,
      content_hash  TEXT,
      metadata      JSONB,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX idx_release_artifact_release ON release_artifact (release_id);
    CREATE INDEX idx_release_artifact_type ON release_artifact (release_id, artifact_type);

    CREATE TABLE binary_version_fingerprint (
      id                        TEXT PRIMARY KEY,
      deployment_id             TEXT NOT NULL REFERENCES deployment (id) ON DELETE CASCADE,
      binary_version            TEXT NOT NULL,
      fingerprint               TEXT NOT NULL,
      inferred_from_release_id  TEXT REFERENCES release (id) ON DELETE SET NULL,
      created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX idx_bvf_deployment_version
      ON binary_version_fingerprint (deployment_id, binary_version);
  `,
};
