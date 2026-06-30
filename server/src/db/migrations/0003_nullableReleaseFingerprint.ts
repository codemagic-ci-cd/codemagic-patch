import type { SqlMigration } from "./index";

export const nullableReleaseFingerprintMigration: SqlMigration = {
  name: "0003_nullable_release_fingerprint",
  sql: `
    ALTER TABLE release
      ALTER COLUMN fingerprint DROP NOT NULL;
  `,
};
