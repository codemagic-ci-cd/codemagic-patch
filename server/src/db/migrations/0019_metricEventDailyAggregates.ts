import type { SqlMigration } from "./index";

/**
 * Daily aggregates that raw `metric_event` rows are folded into once they
 * leave the eight-day raw window (`foldExpiredMetricDays`), plus the watermark
 * that says which days have been folded.
 *
 * The aggregate tables carry no unique constraint. Their dimensions are
 * nullable like the raw columns they come from, and a constraint that treats
 * NULLs as equal (`NULLS NOT DISTINCT`) needs PostgreSQL 15, which an external
 * database is not guaranteed to run. Each day is instead folded exactly once
 * because the fold holds the watermark row lock and advances the watermark in
 * the same transaction that writes the day's aggregates.
 *
 * The `metric_event (emitted_at)` index is what lets the fold find and delete
 * one day at a time. Building it scans the table and ingest writes wait for it
 * (the runner applies migrations inside one transaction, so CONCURRENTLY is
 * not available here, as in 0016). It is built first because every lock the
 * migration takes is held until it commits: the new foreign keys block
 * `deployment` writes, and taking them after the build keeps that short.
 */
export const metricEventDailyAggregatesMigration: SqlMigration = {
  name: "0019_metric_event_daily_aggregates",
  sql: `
    -- Lets the fold find and delete raw rows one UTC day at a time.
    CREATE INDEX idx_metric_event_emitted_at ON metric_event (emitted_at);

    -- Days (UTC) before folded_before exist only in the aggregate tables.
    CREATE TABLE metric_event_fold_state (
      singleton      BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
      folded_before  DATE,                      -- NULL: nothing folded yet
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    INSERT INTO metric_event_fold_state DEFAULT VALUES;

    -- Additive event counts: lifetime release counters, per-binary-version
    -- counters, downloads by delivery type, and every timeseries count but
    -- active devices.
    CREATE TABLE metric_event_daily_count (
      deployment_id        TEXT NOT NULL REFERENCES deployment (id) ON DELETE CASCADE,
      day                  DATE NOT NULL,       -- UTC date of emitted_at
      target_package_hash  TEXT,
      binary_version       TEXT,
      event_name           TEXT NOT NULL
                           CHECK (event_name IN ('Downloaded', 'Ready', 'Applied', 'Failed', 'Active')),
      delivery_type        TEXT,                -- attributes.delivery_type of Downloaded, NULL otherwise
      event_count          INTEGER NOT NULL CHECK (event_count > 0)
    );
    CREATE INDEX idx_metric_event_daily_count_target
      ON metric_event_daily_count (deployment_id, target_package_hash, event_name);
    CREATE INDEX idx_metric_event_daily_count_day
      ON metric_event_daily_count (deployment_id, day);

    -- Failures by reason, code, message, and exit reason: the counters'
    -- failure_reasons and detail counts, the failure codes' counts and
    -- first/last seen, and the message and exit-reason distributions.
    CREATE TABLE metric_failure_daily_count (
      deployment_id        TEXT NOT NULL REFERENCES deployment (id) ON DELETE CASCADE,
      day                  DATE NOT NULL,
      target_package_hash  TEXT,
      reason               TEXT NOT NULL,       -- COALESCE(NULLIF(attributes->>'reason', ''), 'unknown')
      code                 TEXT,                -- NULLIF(failure_payload->>'code', ''), NULL without a payload too
      message              TEXT,                -- NULLIF(failure_payload->>'message', '')
      exit_reason          TEXT,                -- NULLIF(failure_payload->>'android_previous_process_exit', '')
      event_count          INTEGER NOT NULL CHECK (event_count > 0),
      first_seen_at        TIMESTAMPTZ NOT NULL,
      last_seen_at         TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX idx_metric_failure_daily_count_reason
      ON metric_failure_daily_count (deployment_id, reason, target_package_hash);

    -- Distinct active devices per day, precomputed for every filter the
    -- timeseries accepts because distinct counts do not add up.
    CREATE TABLE metric_active_device_daily_count (
      deployment_id        TEXT NOT NULL REFERENCES deployment (id) ON DELETE CASCADE,
      day                  DATE NOT NULL,
      scope                TEXT NOT NULL CHECK (scope IN ('package', 'deployment')),
      target_package_hash  TEXT,                -- NULL when scope = 'deployment'
      version_filter       TEXT NOT NULL CHECK (version_filter IN ('all', 'exact', 'prefix')),
      version_value        TEXT NOT NULL,       -- '' when version_filter = 'all'
      device_count         INTEGER NOT NULL CHECK (device_count > 0)
    );
    CREATE INDEX idx_metric_active_device_daily_count_day
      ON metric_active_device_daily_count (deployment_id, version_filter, version_value, day);
  `,
};
