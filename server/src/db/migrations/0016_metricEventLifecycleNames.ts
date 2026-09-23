import type { SqlMigration } from "./index";

/**
 * the SDK now emits `Ready` and `Applied` where it used to emit `Installed` and
 * `Success`, and ingest stores pre-rename SDK events under the new names too.
 *
 * Additive only. The event-name CHECK keeps the historical values so rows
 * already stored under them stay valid and are read as aliases; no row is
 * rewritten. The new CHECK is a superset of the old one, so it is added
 * NOT VALID: every stored row already satisfies it and scanning the table to
 * prove that would only lengthen the ACCESS EXCLUSIVE lock this transaction
 * holds on `metric_event`. The device-outcome index from 0015 is rebuilt to
 * cover `Applied` alongside historical `Success`, because failure
 * supersession on ingest checks both; that build is the one table scan left,
 * and ingest writes wait for it (the runner applies migrations inside one
 * transaction, so CONCURRENTLY is not available here).
 */
export const metricEventLifecycleNamesMigration: SqlMigration = {
  name: "0016_metric_event_lifecycle_names",
  sql: `
    ALTER TABLE metric_event
      DROP CONSTRAINT metric_event_event_name_check;
    ALTER TABLE metric_event
      ADD CONSTRAINT metric_event_event_name_check
      CHECK (event_name IN ('Downloaded', 'Ready', 'Applied', 'Installed', 'Success', 'Failed', 'Active'))
      NOT VALID;

    DROP INDEX idx_metric_event_device_outcome;
    CREATE INDEX idx_metric_event_device_outcome
      ON metric_event (deployment_id, device_id, target_package_hash, event_name)
      WHERE event_name IN ('Failed', 'Applied', 'Success')
        AND target_package_hash IS NOT NULL;
  `,
};
