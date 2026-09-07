import type { SqlMigration } from "./index";

/**
 * Indexes for the failure drill-down: reason → `payload.code` → that bucket's
 * events, newest first (PROTOCOL.md §Metric Event `Failed` Payload).
 *
 * **The event feed is what justifies indexing this at all.** It reads one
 * bucket in `emitted_at DESC` order, 25 rows at a time, continuing from a
 * keyset cursor. With no matching index every page has to read the whole
 * bucket and top-N-sort it, and that cost does not shrink as the reader pages
 * deeper. The aggregates above the feed — the code list, the top-value
 * distributions — must read every row in their range whatever the access path,
 * so for them an index only changes *how* those rows are reached.
 *
 * Two indexes rather than one, because the drill-down is opened from two
 * places that narrow differently. A deployment scopes to `deployment_id`
 * alone; a release scopes additionally to its own `target_package_hash`
 * (`metric_event` has no `release_id` — the hash is how a release is
 * identified here). A btree cannot skip a leading column, so an index with the
 * hash in it cannot serve the deployment queries, and one without it makes the
 * release queries filter away most of what they read.
 *
 * Measured on 500k events (62.5k `Failed`, a 4,166-row bucket), best of
 * repeated warm runs:
 *
 * | query           | feed index only | both indexes |
 * |-----------------|-----------------|--------------|
 * | release codes   | 26.25 ms        | 8.23 ms      |
 * | release dist    | 12.22 ms        | 4.85 ms      |
 * | release feed    | 0.14 ms         | 0.08 ms      |
 * | deployment feed | 0.08 ms         | 0.08 ms      |
 *
 * Both are partial on `event_name = 'Failed'`, around an eighth of the rows in
 * a typical deployment. Bulk-inserting 500k events measured 2.89 s with
 * neither, 3.04 s with the feed index, and 3.29 s with both — roughly 8% for
 * the second one, which is a few microseconds per `Failed` event against an
 * ingest path that already costs milliseconds per HTTP request. Together they
 * add about 9 MB against a 53 MB table.
 *
 * The planner estimates these buckets at a couple of rows when they hold tens
 * of thousands: three JSONB expressions have no correlated statistics, so
 * their selectivities are multiplied as if independent. It has not chosen
 * badly here, but `CREATE STATISTICS` on the expression pair is the targeted
 * remedy if it ever does.
 *
 * The expressions are spelled exactly as the queries spell them; a btree
 * expression index is only usable when the query's expression matches it
 * verbatim, so any edit to one has to be mirrored in
 * `repositories/metricsRepository.ts`.
 */
export const metricEventFailureFeedMigration: SqlMigration = {
  name: "0014_metric_event_failure_feed",
  sql: `
    CREATE INDEX idx_metric_event_failure_feed
      ON metric_event (
        deployment_id,
        (COALESCE(NULLIF(attributes ->> 'reason', ''), 'unknown')),
        (NULLIF(failure_payload ->> 'code', '')),
        emitted_at DESC,
        id DESC
      )
      WHERE event_name = 'Failed';

    CREATE INDEX idx_metric_event_failure_feed_target
      ON metric_event (
        deployment_id,
        target_package_hash,
        (COALESCE(NULLIF(attributes ->> 'reason', ''), 'unknown')),
        (NULLIF(failure_payload ->> 'code', '')),
        emitted_at DESC,
        id DESC
      )
      WHERE event_name = 'Failed';
  `,
};
