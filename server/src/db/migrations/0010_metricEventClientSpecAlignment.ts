import type { SqlMigration } from "./index";

export const metricEventClientSpecAlignmentMigration: SqlMigration = {
  name: "0010_metric_event_client_spec_alignment",
  sql: `
    ALTER TABLE metric_event
      RENAME COLUMN installation_id TO device_id;
    ALTER TABLE metric_event
      RENAME COLUMN current_package_hash TO running_package_hash;
    ALTER TABLE metric_event
      ALTER COLUMN binary_version DROP NOT NULL;
  `,
};
