import type { SqlMigration } from "./index";

/**
 * Index for the failure-supersession rule on ingest (server tech spec §Metrics
 * Service → Failure Supersession): a device's `Success` for a package deletes
 * that device's `Failed` events for the same package, and a `Failed` arriving
 * once such a `Success` is stored is dropped instead of stored.
 *
 * Both statements look up one `(deployment_id, device_id, target_package_hash)`
 * triple and run on the ingest path, once per `Failed` or `Success` event. No
 * existing index leads with the device: `idx_metric_event_target` narrows to
 * every `Failed` event for the hash in the deployment and filters the device
 * out of that, so its cost grows with how badly the release is doing — the
 * moment the rule matters most is when the release has thousands of failures.
 *
 * Partial on the two outcome events with a concrete hash, which is exactly the
 * row set the rule can ever touch; `Active` is the bulk of the table and never
 * qualifies. Measured on 500k events (125k `Failed`, 62.5k `Success`; 4,999
 * devices, 23 hashes, so a device holds a couple of `Failed` rows per hash),
 * best of five warm runs:
 *
 * | statement                      | without index      | with index      |
 * |--------------------------------|--------------------|-----------------|
 * | `Failed` guard (`Success` seen) | 0.04 ms, 139 pages | 0.01 ms, 4 pages |
 * | `Success` delete of `Failed`    | 1.08 ms, 5,444 pages | 0.01 ms, 7 pages |
 *
 * The delete without the index read and discarded 5,433 other devices' rows to
 * reach the two it wanted. Bulk-inserting the same 500k events took 10.25 s
 * without the index and 10.32 s with it; the index is 8.8 MB against a 76 MB
 * table.
 */
export const metricEventDeviceOutcomeMigration: SqlMigration = {
  name: "0015_metric_event_device_outcome",
  sql: `
    CREATE INDEX idx_metric_event_device_outcome
      ON metric_event (deployment_id, device_id, target_package_hash, event_name)
      WHERE event_name IN ('Failed', 'Success')
        AND target_package_hash IS NOT NULL;
  `,
};
