import type { SqlMigration } from "./index";

export const phase4FoundationsMigration: SqlMigration = {
  name: "0005_phase4_foundations",
  sql: `
    CREATE TABLE metric_event (
      id                    TEXT PRIMARY KEY,
      event_id              TEXT NOT NULL,
      event_name            TEXT NOT NULL
                            CHECK (event_name IN ('Downloaded', 'Installed', 'Success', 'Failed', 'Active')),
      emitted_at            TIMESTAMPTZ NOT NULL,
      team_id               TEXT NOT NULL REFERENCES team (id) ON DELETE CASCADE,
      app_id                TEXT NOT NULL REFERENCES app (id) ON DELETE CASCADE,
      deployment_id         TEXT NOT NULL REFERENCES deployment (id) ON DELETE CASCADE,
      deployment_key        TEXT NOT NULL,
      binary_version        TEXT NOT NULL,
      current_package_hash  TEXT,
      target_package_hash   TEXT,
      installation_id       TEXT NOT NULL,
      sdk_version           TEXT,
      platform              TEXT,
      attributes            JSONB,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX idx_metric_event_event_id ON metric_event (event_id);
    CREATE INDEX idx_metric_event_deployment ON metric_event (deployment_id, event_name, emitted_at);
    CREATE INDEX idx_metric_event_target ON metric_event (deployment_id, target_package_hash, event_name);

    CREATE TABLE audit_event (
      id             TEXT PRIMARY KEY,
      timestamp      TIMESTAMPTZ NOT NULL DEFAULT now(),
      team_id        TEXT NOT NULL REFERENCES team (id) ON DELETE CASCADE,
      actor_type     TEXT NOT NULL,
      actor_id       TEXT,
      action         TEXT NOT NULL,
      resource_type  TEXT NOT NULL,
      resource_id    TEXT NOT NULL,
      before_state   JSONB,
      after_state    JSONB,
      ip             TEXT,
      user_agent     TEXT,
      request_id     TEXT,
      result         TEXT NOT NULL DEFAULT 'success'
                     CHECK (result IN ('success', 'failure'))
    );

    CREATE INDEX idx_audit_event_team ON audit_event (team_id, timestamp);
    CREATE INDEX idx_audit_event_resource ON audit_event (resource_type, resource_id, timestamp);
    CREATE INDEX idx_audit_event_actor ON audit_event (actor_type, actor_id, timestamp);

    CREATE TABLE idempotency_key (
      key                TEXT PRIMARY KEY,
      request_method     TEXT NOT NULL,
      request_path       TEXT NOT NULL,
      request_body_hash  TEXT NOT NULL,
      response_status    INTEGER,
      response_body      JSONB,
      completed          BOOLEAN NOT NULL DEFAULT false,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at         TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX idx_idempotency_key_expires ON idempotency_key (expires_at);
  `,
};
