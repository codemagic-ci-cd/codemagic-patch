import type { SqlMigration } from "./index";

/**
 * Outbound webhooks for release events (`server/specs/webhooks-tech-spec.md`).
 *
 * `webhook_event.payload` is TEXT, not JSONB: every attempt must send the
 * same bytes, and JSONB does not keep them.
 *
 * `release_job.patch_changes` holds the before/after of the fields a PATCH
 * changed. The release row already carries the new values when the request
 * commits, so the pair has to be kept somewhere until the job settles.
 *
 * `webhook_delivery.claim_generation` is the token a worker completes an
 * attempt with. It only ever goes up: `attempt_count` is what people read and
 * a manual redelivery resets it, so it cannot also tell two claims apart.
 *
 * `webhook.manage` goes to the same two roles as `app.manage`.
 */
export const webhooksMigration: SqlMigration = {
  name: "0023_webhooks",
  sql: `
    CREATE TABLE webhook_endpoint (
      id           TEXT PRIMARY KEY,
      team_id      TEXT NOT NULL REFERENCES team (id) ON DELETE CASCADE,
      url          TEXT NOT NULL,
      description  TEXT,
      event_types  TEXT[] NOT NULL DEFAULT '{}',
      secret       TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'disabled')),
      created_by   TEXT REFERENCES user_account (id) ON DELETE SET NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_webhook_endpoint_team ON webhook_endpoint (team_id, created_at);

    CREATE TABLE webhook_event (
      id          TEXT PRIMARY KEY,
      team_id     TEXT NOT NULL REFERENCES team (id) ON DELETE CASCADE,
      type        TEXT NOT NULL,
      payload     TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_webhook_event_created ON webhook_event (created_at);

    CREATE TABLE webhook_delivery (
      id                    TEXT PRIMARY KEY,
      event_id              TEXT NOT NULL REFERENCES webhook_event (id) ON DELETE CASCADE,
      endpoint_id           TEXT NOT NULL REFERENCES webhook_endpoint (id) ON DELETE CASCADE,
      status                TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'succeeded', 'failed')),
      attempt_count         INTEGER NOT NULL DEFAULT 0,
      claim_generation      INTEGER NOT NULL DEFAULT 0,
      next_attempt_at       TIMESTAMPTZ,
      last_attempt_at       TIMESTAMPTZ,
      last_response_status  INTEGER,
      last_error            TEXT,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at          TIMESTAMPTZ,
      CONSTRAINT chk_webhook_delivery_pending_schedule
        CHECK ((status = 'pending') = (next_attempt_at IS NOT NULL))
    );
    CREATE UNIQUE INDEX idx_webhook_delivery_event_endpoint
      ON webhook_delivery (event_id, endpoint_id);
    CREATE INDEX idx_webhook_delivery_due ON webhook_delivery (next_attempt_at)
      WHERE status = 'pending';
    CREATE INDEX idx_webhook_delivery_endpoint
      ON webhook_delivery (endpoint_id, created_at);

    ALTER TABLE release_job ADD COLUMN patch_changes JSONB;

    INSERT INTO role_permission (role_definition_id, action)
    VALUES
      ('role_admin', 'webhook.manage'),
      ('role_owner', 'webhook.manage')
    ON CONFLICT (role_definition_id, action) DO NOTHING;
  `,
};
