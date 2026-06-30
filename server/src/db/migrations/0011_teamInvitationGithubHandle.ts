import type { SqlMigration } from "./index";

// Adds GitHub-handle invitations alongside the existing email invitations.
// An invitation now targets EITHER an email (satisfied by whoever proves that
// verified email via OAuth) OR an immutable OAuth identity — `(oauth_provider,
// oauth_subject)`, resolved from the handle at invite time. `github_handle` is
// the handle as typed, kept for display only. Email is now nullable; the
// `chk_team_invitation_target` constraint enforces exactly one target kind.
// `chk_team_invitation_status_fields` (0009) governs only the accepted/revoked
// bookkeeping columns and never references email, so it is left untouched.
export const teamInvitationGithubHandleMigration: SqlMigration = {
  name: "0011_team_invitation_github_handle",
  sql: `
    ALTER TABLE team_invitation
      ADD COLUMN github_handle  TEXT,
      ADD COLUMN oauth_provider TEXT,
      ADD COLUMN oauth_subject  TEXT,
      ALTER COLUMN email DROP NOT NULL;

    ALTER TABLE team_invitation
      DROP CONSTRAINT chk_team_invitation_email_canonical;
    ALTER TABLE team_invitation
      ADD CONSTRAINT chk_team_invitation_email_canonical
        CHECK (
          email IS NULL
          OR (email = lower(trim(email)) AND length(email) > 0)
        );

    ALTER TABLE team_invitation
      ADD CONSTRAINT chk_team_invitation_target
        CHECK (
          (
            email IS NOT NULL
            AND oauth_provider IS NULL
            AND oauth_subject IS NULL
          )
          OR (
            email IS NULL
            AND oauth_provider IS NOT NULL
            AND oauth_subject IS NOT NULL
          )
        );

    DROP INDEX idx_team_invitation_pending_email;
    CREATE UNIQUE INDEX idx_team_invitation_pending_email
      ON team_invitation (team_id, email)
      WHERE status = 'pending' AND email IS NOT NULL;

    CREATE UNIQUE INDEX idx_team_invitation_pending_oauth
      ON team_invitation (team_id, oauth_provider, oauth_subject)
      WHERE status = 'pending' AND oauth_subject IS NOT NULL;

    CREATE INDEX idx_team_invitation_oauth_status
      ON team_invitation (oauth_provider, oauth_subject, status, expires_at);
  `,
};
