import type { SqlMigration } from "./index";

export const releaseBundleSourceMigration: SqlMigration = {
  name: "0004_release_bundle_source",
  sql: `
    ALTER TABLE release
      ADD COLUMN source_bundle_release_id TEXT REFERENCES release (id) ON DELETE SET NULL;

    CREATE INDEX idx_release_source_bundle ON release (source_bundle_release_id);
  `,
};
