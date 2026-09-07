import type { SqlMigration } from "./index";

/**
 * Adds the decoded `Failed`-event detail blob (PROTOCOL.md §Metric Event
 * `Failed` Payload).
 *
 * The client sends it inside `attributes` as a JSON *string*, so it is already
 * persisted there verbatim. Decoding it into its own JSONB column is what makes
 * the failure breakdown queryable at all: grouping straight off the raw string
 * would mean `(attributes ->> 'payload')::jsonb` per row, which re-parses text
 * on every scan and raises outright on any payload a client malformed — turning
 * one bad device's blob into a failed query for the whole deployment.
 *
 * Backfill is deliberately omitted. Events predating the client change carry no
 * payload at all, so there is nothing to recover, and events whose raw string
 * failed to decode are exactly the ones a cast-based backfill would choke on.
 *
 * No index accompanies the column here. The aggregate breakdowns filter on
 * `(deployment_id, target_package_hash, event_name)`, which
 * `idx_metric_event_target` already serves, and they must read every matching
 * row whatever the access path, so an index would only change how those rows
 * are reached. The drill-down's raw event feed is a different case, and
 * `0014_metric_event_failure_feed` adds the indexes that one needs; its
 * comment carries the measurements behind that split.
 */
export const metricEventFailurePayloadMigration: SqlMigration = {
  name: "0013_metric_event_failure_payload",
  sql: `
    ALTER TABLE metric_event
      ADD COLUMN failure_payload JSONB;
  `,
};
