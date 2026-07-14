import type { SqlMigration } from "./index";

// Reconciles `chk_team_invitation_status_fields` (0009) with the `ON DELETE SET
// NULL` foreign keys on the columns it guarded. `accepted_by`, `role_binding_id`
// and `revoked_by` all reference rows that can legitimately be deleted later —
// removing a team member deletes the `role_binding` an accepted invitation points
// at — and Postgres then nulls the column, which the old constraint immediately
// rejected (23514), aborting the delete.
//
// The bookkeeping timestamps carry no foreign key, so nothing can null them out
// behind our back: `accepted_at` / `revoked_at` become the durable marker of a
// terminal status, and the three referencing columns are allowed to fall back to
// NULL once their referent is gone. The invitation row survives as audit history.
export const teamInvitationStatusFieldsMigration: SqlMigration = {
  name: "0012_team_invitation_status_fields",
  sql: `
    ALTER TABLE team_invitation
      DROP CONSTRAINT chk_team_invitation_status_fields;

    ALTER TABLE team_invitation
      ADD CONSTRAINT chk_team_invitation_status_fields
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
            AND accepted_at IS NOT NULL
            AND revoked_by IS NULL
            AND revoked_at IS NULL
          )
          OR (
            status = 'revoked'
            AND accepted_by IS NULL
            AND accepted_at IS NULL
            AND role_binding_id IS NULL
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
        );
  `,
};
