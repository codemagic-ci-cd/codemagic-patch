import type { SqlMigration } from "./index";

/**
 * A service account is an account owned by one team: `owner_team_id` is set.
 * It never signs in, is honored in its owner team only, and its token is
 * rotated by that team's admins. Linking a provider identity clears the
 * ownership, so an owned account never carries an identity.
 *
 * No delete rule on the reference: a team cannot be deleted while it still
 * owns accounts, because their history (releases, invitations) may reach into
 * other teams.
 *
 * Backfill: only accounts that the provisioning route created, by its audit
 * event, and only while they still look the way it left them (no identity,
 * every binding a team binding on that team, so becoming owned takes no
 * access away). "Has no identity" alone is not
 * evidence: a person who has not signed in yet has none either. Accounts the
 * backfill skips stay unowned and cannot be rotated.
 *
 * The scope comparison is on text, so this runs the same before and after the
 * managed chain adds its `instance` scope.
 *
 * The audit scan comes first, into a temporary table: `ALTER TABLE` locks
 * `user_account` against every reader until the migration commits, and no
 * index serves a lookup by audit action.
 */
export const serviceAccountOwnerTeamMigration: SqlMigration = {
  name: "0022_service_account_owner_team",
  sql: `
    CREATE TEMPORARY TABLE provisioned_account ON COMMIT DROP AS
      SELECT DISTINCT ON (resource_id) resource_id, team_id
      FROM audit_event
      WHERE action = 'iam.user.provisioned'
        AND result = 'success'
      ORDER BY resource_id, timestamp;

    ALTER TABLE user_account
      ADD COLUMN owner_team_id TEXT REFERENCES team (id);
    ALTER TABLE user_account
      ADD CONSTRAINT chk_user_account_owner_team_no_identity
      CHECK (owner_team_id IS NULL OR oauth_provider IS NULL);
    CREATE INDEX idx_user_account_owner_team ON user_account (owner_team_id)
      WHERE owner_team_id IS NOT NULL;

    UPDATE user_account u
    SET owner_team_id = provisioned.team_id
    FROM provisioned_account provisioned
    WHERE u.id = provisioned.resource_id
      AND u.oauth_provider IS NULL
      AND EXISTS (
        SELECT 1
        FROM role_binding rb
        WHERE rb.principal_type = 'user'
          AND rb.principal_id = u.id
          AND rb.scope_type = 'team'
          AND rb.scope_id = provisioned.team_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM role_binding rb
        WHERE rb.principal_type = 'user'
          AND rb.principal_id = u.id
          AND NOT (rb.scope_type = 'team' AND rb.scope_id = provisioned.team_id)
      );
  `,
};
