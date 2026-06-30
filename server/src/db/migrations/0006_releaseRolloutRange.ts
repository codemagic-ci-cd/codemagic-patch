import type { SqlMigration } from "./index";

export const releaseRolloutRangeMigration: SqlMigration = {
  name: "0006_release_rollout_range",
  sql: `
    UPDATE release
    SET rollout_percentage = 1
    WHERE rollout_percentage = 0;

    ALTER TABLE release
      DROP CONSTRAINT IF EXISTS release_rollout_percentage_check,
      ADD CONSTRAINT release_rollout_percentage_check
        CHECK (rollout_percentage BETWEEN 1 AND 100);
  `,
};
