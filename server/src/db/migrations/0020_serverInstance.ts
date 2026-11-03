import type { SqlMigration } from "./index";

/**
 * The installation's identity for the daily usage report
 * (`app/telemetryReport.ts`): one random UUID that says nothing about the
 * operator, minted by the first report and stable from then on.
 *
 * The migration creates the table and no row. The id is minted lazily on the
 * first send, so an installation with the usage report turned off never has
 * one, rather than carrying an unused id a later opt-in would reveal.
 */
export const serverInstanceMigration: SqlMigration = {
  name: "0020_server_instance",
  sql: `
    CREATE TABLE server_instance (
      singleton    BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
      instance_id  TEXT NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `,
};
