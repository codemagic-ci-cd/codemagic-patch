import type { SqlMigration } from "./index";

export const teamInvitationMigration: SqlMigration = {
  name: "0009_team_invitation",
  sql: `
    CREATE TABLE team_invitation (
      id                  TEXT PRIMARY KEY,
      team_id             TEXT NOT NULL REFERENCES team (id) ON DELETE CASCADE,
      email               TEXT NOT NULL,
      role_definition_id  TEXT NOT NULL REFERENCES role_definition (id),
      status              TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
      created_by          TEXT NOT NULL REFERENCES user_account (id) ON DELETE RESTRICT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at          TIMESTAMPTZ NOT NULL,
      accepted_by         TEXT REFERENCES user_account (id) ON DELETE SET NULL,
      accepted_at         TIMESTAMPTZ,
      role_binding_id     TEXT REFERENCES role_binding (id) ON DELETE SET NULL,
      revoked_by          TEXT REFERENCES user_account (id) ON DELETE SET NULL,
      revoked_at          TIMESTAMPTZ,
      CONSTRAINT chk_team_invitation_email_canonical
        CHECK (email = lower(trim(email)) AND length(email) > 0),
      CONSTRAINT chk_team_invitation_status_fields
        CHECK (
          (
            status = 'pending'
            AND accepted_by IS NULL
            AND accepted_at IS NULL
            AND role_binding_id IS NULL
            AND revoked_by IS NULL
            AND revoked_at IS NULL
          )
          OR (
            status = 'accepted'
            AND accepted_by IS NOT NULL
            AND accepted_at IS NOT NULL
            AND role_binding_id IS NOT NULL
            AND revoked_by IS NULL
            AND revoked_at IS NULL
          )
          OR (
            status = 'revoked'
            AND accepted_by IS NULL
            AND accepted_at IS NULL
            AND role_binding_id IS NULL
            AND revoked_by IS NOT NULL
            AND revoked_at IS NOT NULL
          )
          OR (
            status = 'expired'
            AND accepted_by IS NULL
            AND accepted_at IS NULL
            AND role_binding_id IS NULL
            AND revoked_by IS NULL
            AND revoked_at IS NULL
          )
        )
    );

    CREATE UNIQUE INDEX idx_team_invitation_pending_email
      ON team_invitation (team_id, email)
      WHERE status = 'pending';

    CREATE INDEX idx_team_invitation_email_status
      ON team_invitation (email, status, expires_at);

    CREATE INDEX idx_team_invitation_team_status
      ON team_invitation (team_id, status, created_at);
  `,
};
