-- Dashboard demo catalog for local evaluation only.
--
-- Inserts "Example Data" on the bootstrap team (default-team) with Staging and
-- Production deployments, a handful of published/disabled releases, and
-- metric_event rows so release metrics / summary cards look lived-in.
--
-- Releases are control-plane rows only (no MinIO artifacts). They are for
-- browsing the dashboard, not for client download.
--
-- Requires default-team to already exist (server boot / ensureBootstrapTeam).
-- Safe to re-run: apps/deployments conflict on fixed ids; releases upsert;
-- demo metric_event rows are deleted and reinserted with emitted_at relative
-- to now() so counters stay fresh when time-series lands.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM team WHERE name = 'default-team') THEN
    RAISE EXCEPTION
      'default-team not found; start the server (bootstrap team) before seeding demo data';
  END IF;
END $$;

INSERT INTO app (id, team_id, name)
VALUES (
  'app_demo_example',
  (SELECT id FROM team WHERE name = 'default-team'),
  'Example Data'
)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO deployment (id, app_id, team_id, name, deployment_key)
VALUES
  (
    'deployment_demo_example_staging',
    'app_demo_example',
    (SELECT id FROM team WHERE name = 'default-team'),
    'Staging',
    'demo_example_staging_deployment_key'
  ),
  (
    'deployment_demo_example_production',
    'app_demo_example',
    (SELECT id FROM team WHERE name = 'default-team'),
    'Production',
    'demo_example_production_deployment_key'
  )
ON CONFLICT (id) DO NOTHING;

-- Staging releases (newest last by created_at)
INSERT INTO release (
  id,
  team_id,
  app_id,
  deployment_id,
  release_label,
  target_binary_version,
  fingerprint,
  target_package_hash,
  rollout_percentage,
  is_mandatory,
  release_notes,
  status,
  created_at,
  updated_at
)
VALUES
  (
    'rel_demo_ex_stg_v1',
    (SELECT id FROM team WHERE name = 'default-team'),
    'app_demo_example',
    'deployment_demo_example_staging',
    'v1',
    '1.0.0',
    'demo-example-fingerprint',
    'demo_ex_stg_pkg_v1',
    100,
    false,
    'Initial staging build for Example Data.',
    'published',
    now() - interval '14 days',
    now() - interval '14 days'
  ),
  (
    'rel_demo_ex_stg_v2',
    (SELECT id FROM team WHERE name = 'default-team'),
    'app_demo_example',
    'deployment_demo_example_staging',
    'v2',
    '1.0.0',
    'demo-example-fingerprint',
    'demo_ex_stg_pkg_v2',
    100,
    false,
    'Cold-start crash fix and quieter analytics logging.',
    'published',
    now() - interval '7 days',
    now() - interval '7 days'
  ),
  (
    'rel_demo_ex_stg_v3',
    (SELECT id FROM team WHERE name = 'default-team'),
    'app_demo_example',
    'deployment_demo_example_staging',
    'v3',
    '1.1.0',
    'demo-example-fingerprint',
    'demo_ex_stg_pkg_v3',
    100,
    true,
    'Mandatory: new onboarding copy and faster patch apply.',
    'published',
    now() - interval '2 days',
    now() - interval '2 days'
  ),
  (
    'rel_demo_ex_stg_v4',
    (SELECT id FROM team WHERE name = 'default-team'),
    'app_demo_example',
    'deployment_demo_example_staging',
    'v4',
    '1.1.0',
    'demo-example-fingerprint',
    'demo_ex_stg_pkg_v4',
    100,
    false,
    'Disabled after elevated Failed events in canary.',
    'disabled',
    now() - interval '1 day',
    now() - interval '12 hours'
  ),
  (
    'rel_demo_ex_prd_v1',
    (SELECT id FROM team WHERE name = 'default-team'),
    'app_demo_example',
    'deployment_demo_example_production',
    'v1',
    '1.0.0',
    'demo-example-fingerprint',
    'demo_ex_prd_pkg_v1',
    100,
    false,
    'First production release of Example Data.',
    'published',
    now() - interval '28 days',
    now() - interval '28 days'
  ),
  (
    'rel_demo_ex_prd_v2',
    (SELECT id FROM team WHERE name = 'default-team'),
    'app_demo_example',
    'deployment_demo_example_production',
    'v2',
    '1.0.0',
    'demo-example-fingerprint',
    'demo_ex_prd_pkg_v2',
    100,
    false,
    'Promoted staging crash fix to production.',
    'published',
    now() - interval '13 days',
    now() - interval '13 days'
  ),
  (
    'rel_demo_ex_prd_v3',
    (SELECT id FROM team WHERE name = 'default-team'),
    'app_demo_example',
    'deployment_demo_example_production',
    'v3',
    '1.0.1',
    'demo-example-fingerprint',
    'demo_ex_prd_pkg_v3',
    10,
    false,
    'Careful 10% production canary for the 1.0.1 patch.',
    'published',
    now() - interval '3 days',
    now() - interval '3 days'
  )
ON CONFLICT (id) DO UPDATE SET
  release_label = EXCLUDED.release_label,
  target_binary_version = EXCLUDED.target_binary_version,
  fingerprint = EXCLUDED.fingerprint,
  target_package_hash = EXCLUDED.target_package_hash,
  rollout_percentage = EXCLUDED.rollout_percentage,
  is_mandatory = EXCLUDED.is_mandatory,
  release_notes = EXCLUDED.release_notes,
  status = EXCLUDED.status,
  created_at = EXCLUDED.created_at,
  updated_at = EXCLUDED.updated_at;

-- Refresh demo metrics on every run (relative timestamps stay recent).
DELETE FROM metric_event WHERE id LIKE 'me_demo_ex_%';

-- Funnel events (Downloaded / Ready / Applied) stamp over the few days
-- after that release's publish, front-loaded and a bit uneven so cumulative
-- Applied ramps instead of smearing. Production totals sit next to the
-- 10k-device Active occupancy grid (v1 from day 28, v2 from day 13, v3
-- peels a 10% canary from day 3), not a separate 70k lifetime funnel.
-- Staging ≈ 30-person internal team. Healthy releases have no Failed rows
-- (0.02% of ~30 devices rounds to zero). v4 is the disabled crash-rollback
-- canary.

-- Staging v1 (a couple of stragglers; high lifetime funnel)
INSERT INTO metric_event (
  id, event_id, event_name, emitted_at,
  team_id, app_id, deployment_id, deployment_key,
  binary_version, running_package_hash, target_package_hash,
  device_id, sdk_version, platform, attributes
)
SELECT
  'me_demo_ex_stg_v1_' || lower(e.event_name) || '_' || g,
  'evt_demo_ex_stg_v1_' || lower(e.event_name) || '_' || g,
  e.event_name,
  CASE
    WHEN e.event_name = 'Active'
      THEN date_trunc('day', now()) - ((10 + g) * interval '1 day') + interval '12 hours'
    ELSE LEAST(
      now() - interval '2 minutes',
      date_trunc('day', now())
        - (GREATEST(11, 14 - ((g - 1) * 3 / e.n)) * interval '1 day')
        + ((g % 17) * interval '1 hour')
        + ((g * 7) % 50) * interval '1 minute'
    )
  END,
  (SELECT id FROM team WHERE name = 'default-team'),
  'app_demo_example',
  'deployment_demo_example_staging',
  'demo_example_staging_deployment_key',
  '1.0.0',
  'demo_ex_stg_pkg_v1',
  'demo_ex_stg_pkg_v1',
  'device_demo_stg_v1_' || g,
  '0.1.0',
  CASE WHEN g % 2 = 0 THEN 'ios' ELSE 'android' END,
  CASE
    WHEN e.event_name IN ('Downloaded', 'Ready', 'Applied')
      THEN '{"delivery_type":"full_bundle"}'::jsonb
    ELSE NULL
  END
FROM (VALUES
  ('Downloaded'::text, 28),
  ('Ready', 26),
  ('Applied', 25),
  ('Active', 2)
) AS e(event_name, n)
CROSS JOIN LATERAL generate_series(1, e.n) AS g;

-- Staging v2 (minority still on previous)
INSERT INTO metric_event (
  id, event_id, event_name, emitted_at,
  team_id, app_id, deployment_id, deployment_key,
  binary_version, running_package_hash, target_package_hash,
  device_id, sdk_version, platform, attributes
)
SELECT
  'me_demo_ex_stg_v2_' || lower(e.event_name) || '_' || g,
  'evt_demo_ex_stg_v2_' || lower(e.event_name) || '_' || g,
  e.event_name,
  CASE
    WHEN e.event_name = 'Active'
      THEN date_trunc('day', now()) - ((2 + g) * interval '1 day') + interval '12 hours'
    ELSE LEAST(
      now() - interval '2 minutes',
      date_trunc('day', now())
        - (GREATEST(5, 7 - ((g - 1) * 2 / e.n)) * interval '1 day')
        + ((g % 13) * interval '1 hour')
        + ((g * 11) % 50) * interval '1 minute'
    )
  END,
  (SELECT id FROM team WHERE name = 'default-team'),
  'app_demo_example',
  'deployment_demo_example_staging',
  'demo_example_staging_deployment_key',
  '1.0.0',
  'demo_ex_stg_pkg_v2',
  'demo_ex_stg_pkg_v2',
  'device_demo_stg_v2_' || g,
  '0.1.0',
  CASE WHEN g % 3 = 0 THEN 'android' ELSE 'ios' END,
  CASE
    WHEN e.event_name IN ('Downloaded', 'Ready', 'Applied')
      THEN '{"delivery_type":"full_bundle"}'::jsonb
    ELSE NULL
  END
FROM (VALUES
  ('Downloaded'::text, 20),
  ('Ready', 18),
  ('Applied', 17),
  ('Active', 6)
) AS e(event_name, n)
CROSS JOIN LATERAL generate_series(1, e.n) AS g;

-- Staging v3 (latest; most of the team)
INSERT INTO metric_event (
  id, event_id, event_name, emitted_at,
  team_id, app_id, deployment_id, deployment_key,
  binary_version, running_package_hash, target_package_hash,
  device_id, sdk_version, platform, attributes
)
SELECT
  'me_demo_ex_stg_v3_' || lower(e.event_name) || '_' || g,
  'evt_demo_ex_stg_v3_' || lower(e.event_name) || '_' || g,
  e.event_name,
  CASE
    WHEN e.event_name = 'Active'
      THEN date_trunc('day', now()) - ((g % 3) * interval '1 day') + interval '12 hours'
    ELSE LEAST(
      now() - interval '2 minutes',
      date_trunc('day', now())
        - (GREATEST(0, 2 - ((g - 1) * 2 / e.n)) * interval '1 day')
        + ((g % 11) * interval '1 hour')
        + ((g * 13) % 50) * interval '1 minute'
    )
  END,
  (SELECT id FROM team WHERE name = 'default-team'),
  'app_demo_example',
  'deployment_demo_example_staging',
  'demo_example_staging_deployment_key',
  '1.1.0',
  'demo_ex_stg_pkg_v3',
  'demo_ex_stg_pkg_v3',
  'device_demo_stg_v3_' || g,
  '0.1.0',
  CASE WHEN g % 2 = 0 THEN 'ios' ELSE 'android' END,
  CASE
    WHEN e.event_name IN ('Downloaded', 'Ready', 'Applied')
      THEN '{"delivery_type":"patch"}'::jsonb
    ELSE NULL
  END
FROM (VALUES
  ('Downloaded'::text, 24),
  ('Ready', 23),
  ('Applied', 22),
  ('Active', 22)
) AS e(event_name, n)
CROSS JOIN LATERAL generate_series(1, e.n) AS g;

-- Staging v4 (disabled; failed residue, nobody still Active)
INSERT INTO metric_event (
  id, event_id, event_name, emitted_at,
  team_id, app_id, deployment_id, deployment_key,
  binary_version, running_package_hash, target_package_hash,
  device_id, sdk_version, platform, attributes
)
SELECT
  'me_demo_ex_stg_v4_' || lower(e.event_name) || '_' || g,
  'evt_demo_ex_stg_v4_' || lower(e.event_name) || '_' || g,
  e.event_name,
  now() - interval '20 hours' - ((g % 8) * interval '1 hour'),
  (SELECT id FROM team WHERE name = 'default-team'),
  'app_demo_example',
  'deployment_demo_example_staging',
  'demo_example_staging_deployment_key',
  '1.1.0',
  'demo_ex_stg_pkg_v4',
  'demo_ex_stg_pkg_v4',
  'device_demo_stg_v4_' || g,
  '0.1.0',
  'ios',
  CASE
    WHEN e.event_name IN ('Downloaded', 'Ready', 'Applied')
      THEN '{"delivery_type":"patch"}'::jsonb
    ELSE NULL
  END
FROM (VALUES
  ('Downloaded'::text, 8),
  ('Ready', 6),
  ('Applied', 2)
) AS e(event_name, n)
CROSS JOIN LATERAL generate_series(1, e.n) AS g;

-- Production v1: take-up over the occupancy ramp-in (publish 28 days ago).
INSERT INTO metric_event (
  id, event_id, event_name, emitted_at,
  team_id, app_id, deployment_id, deployment_key,
  binary_version, running_package_hash, target_package_hash,
  device_id, sdk_version, platform, attributes
)
SELECT
  'me_demo_ex_prd_v1_' || lower(e.event_name) || '_' || day.day_offset || '_' || g,
  'evt_demo_ex_prd_v1_' || lower(e.event_name) || '_' || day.day_offset || '_' || g,
  e.event_name,
  LEAST(
    now() - interval '2 minutes',
    date_trunc('day', now())
      - (day.day_offset * interval '1 day')
      + (((g * 13 + day.day_offset * 5) % 20) * interval '1 hour')
      + (((g * 17) % 53) * interval '1 minute')
  ),
  (SELECT id FROM team WHERE name = 'default-team'),
  'app_demo_example',
  'deployment_demo_example_production',
  'demo_example_production_deployment_key',
  '1.0.0',
  'demo_ex_prd_pkg_v1',
  'demo_ex_prd_pkg_v1',
  'device_demo_prd_v1_' || lower(e.event_name) || '_' || day.day_offset || '_' || g,
  '0.1.0',
  CASE WHEN g % 2 = 0 THEN 'ios' ELSE 'android' END,
  CASE
    WHEN e.event_name IN ('Downloaded', 'Ready', 'Applied')
      THEN '{"delivery_type":"full_bundle"}'::jsonb
    ELSE NULL
  END
FROM (VALUES
  (28, 640),
  (27, 990),
  (26, 1380),
  (25, 1640),
  (24, 1510),
  (23, 1160),
  (22, 870),
  (21, 610),
  (20, 400),
  (19, 220),
  (18, 110),
  (17, 55),
  (16, 28),
  (15, 14)
) AS day(day_offset, applied)
CROSS JOIN LATERAL (VALUES
  ('Downloaded'::text, GREATEST(1, round(day.applied * 1.08))::int),
  ('Ready', GREATEST(1, round(day.applied * 1.03))::int),
  ('Applied', day.applied)
) AS e(event_name, n)
CROSS JOIN LATERAL generate_series(1, e.n) AS g;

-- Production v2: takeover from day 13, matching the occupancy 25/55/82/100
-- steps plus a thin tail.
INSERT INTO metric_event (
  id, event_id, event_name, emitted_at,
  team_id, app_id, deployment_id, deployment_key,
  binary_version, running_package_hash, target_package_hash,
  device_id, sdk_version, platform, attributes
)
SELECT
  'me_demo_ex_prd_v2_' || lower(e.event_name) || '_' || day.day_offset || '_' || g,
  'evt_demo_ex_prd_v2_' || lower(e.event_name) || '_' || day.day_offset || '_' || g,
  e.event_name,
  LEAST(
    now() - interval '2 minutes',
    date_trunc('day', now())
      - (day.day_offset * interval '1 day')
      + (((g * 11 + day.day_offset * 7) % 20) * interval '1 hour')
      + (((g * 19) % 53) * interval '1 minute')
  ),
  (SELECT id FROM team WHERE name = 'default-team'),
  'app_demo_example',
  'deployment_demo_example_production',
  'demo_example_production_deployment_key',
  '1.0.0',
  'demo_ex_prd_pkg_v2',
  'demo_ex_prd_pkg_v2',
  'device_demo_prd_v2_' || lower(e.event_name) || '_' || day.day_offset || '_' || g,
  '0.1.0',
  CASE WHEN g % 3 = 0 THEN 'android' ELSE 'ios' END,
  CASE
    WHEN e.event_name IN ('Downloaded', 'Ready', 'Applied')
      THEN '{"delivery_type":"full_bundle"}'::jsonb
    ELSE NULL
  END
FROM (VALUES
  (13, 2410),
  (12, 3040),
  (11, 2480),
  (10, 1090),
  (9, 360),
  (8, 140),
  (7, 55),
  (6, 22)
) AS day(day_offset, applied)
CROSS JOIN LATERAL (VALUES
  ('Downloaded'::text, GREATEST(1, round(day.applied * 1.07))::int),
  ('Ready', GREATEST(1, round(day.applied * 1.03))::int),
  ('Applied', day.applied)
) AS e(event_name, n)
CROSS JOIN LATERAL generate_series(1, e.n) AS g;

-- Production v3: 10% canary from day 3.
INSERT INTO metric_event (
  id, event_id, event_name, emitted_at,
  team_id, app_id, deployment_id, deployment_key,
  binary_version, running_package_hash, target_package_hash,
  device_id, sdk_version, platform, attributes
)
SELECT
  'me_demo_ex_prd_v3_' || lower(e.event_name) || '_' || day.day_offset || '_' || g,
  'evt_demo_ex_prd_v3_' || lower(e.event_name) || '_' || day.day_offset || '_' || g,
  e.event_name,
  LEAST(
    now() - interval '2 minutes',
    date_trunc('day', now())
      - (day.day_offset * interval '1 day')
      + (((g * 9 + day.day_offset * 3) % 20) * interval '1 hour')
      + (((g * 23) % 53) * interval '1 minute')
  ),
  (SELECT id FROM team WHERE name = 'default-team'),
  'app_demo_example',
  'deployment_demo_example_production',
  'demo_example_production_deployment_key',
  '1.0.1',
  'demo_ex_prd_pkg_v3',
  'demo_ex_prd_pkg_v3',
  'device_demo_prd_v3_' || lower(e.event_name) || '_' || day.day_offset || '_' || g,
  '0.1.0',
  CASE WHEN g % 2 = 0 THEN 'ios' ELSE 'android' END,
  CASE
    WHEN e.event_name IN ('Downloaded', 'Ready', 'Applied')
      THEN '{"delivery_type":"patch"}'::jsonb
    ELSE NULL
  END
FROM (VALUES
  (3, 355),
  (2, 280),
  (1, 175),
  (0, 82)
) AS day(day_offset, applied)
CROSS JOIN LATERAL (VALUES
  ('Downloaded'::text, GREATEST(1, round(day.applied * 1.09))::int),
  ('Ready', GREATEST(1, round(day.applied * 1.04))::int),
  ('Applied', day.applied)
) AS e(event_name, n)
CROSS JOIN LATERAL generate_series(1, e.n) AS g;

-- Production Active occupancy (10k device pool, one row per device per UTC
-- day they were active). Day 0 is today. v1 smoothsteps in from day 28 so
-- the 30-day chart is not a long zero run; v2 takes over from day 13 (its
-- publish); v3 peels a 10% canary from day 3. Stragglers (devices 1–357)
-- never leave v1. Daily cap is ~96% of the pool after the ramp, with a
-- Saturday/Sunday dip and a small hash wobble so Total is not a flat line.
-- Presence is hashed across device ids so the version mix stays proportional
-- when the cap is below 10k.
INSERT INTO metric_event (
  id, event_id, event_name, emitted_at,
  team_id, app_id, deployment_id, deployment_key,
  binary_version, running_package_hash, target_package_hash,
  device_id, sdk_version, platform, attributes
)
SELECT
  'me_demo_ex_prd_active_' || d.day_offset || '_' || dev.n,
  'evt_demo_ex_prd_active_' || d.day_offset || '_' || dev.n,
  'Active',
  date_trunc('day', now())
    - (d.day_offset * interval '1 day')
    + interval '12 hours',
  (SELECT id FROM team WHERE name = 'default-team'),
  'app_demo_example',
  'deployment_demo_example_production',
  'demo_example_production_deployment_key',
  CASE ver.pkg
    WHEN 'v3' THEN '1.0.1'
    ELSE '1.0.0'
  END,
  CASE ver.pkg
    WHEN 'v1' THEN 'demo_ex_prd_pkg_v1'
    WHEN 'v2' THEN 'demo_ex_prd_pkg_v2'
    ELSE 'demo_ex_prd_pkg_v3'
  END,
  CASE ver.pkg
    WHEN 'v1' THEN 'demo_ex_prd_pkg_v1'
    WHEN 'v2' THEN 'demo_ex_prd_pkg_v2'
    ELSE 'demo_ex_prd_pkg_v3'
  END,
  'device_demo_prd_dau_' || dev.n,
  '0.1.0',
  CASE WHEN dev.n % 2 = 0 THEN 'ios' ELSE 'android' END,
  NULL
FROM generate_series(0, 28) AS d(day_offset)
CROSS JOIN generate_series(1, 10000) AS dev(n)
CROSS JOIN LATERAL (
  SELECT GREATEST(0.0, LEAST(1.0, (28.0 - d.day_offset) / 9.0)) AS p
) AS ramp
CROSS JOIN LATERAL (
  SELECT GREATEST(1, LEAST(10000,
    round(
      9600
      * (0.18 + 0.82 * (3 * ramp.p * ramp.p - 2 * ramp.p * ramp.p * ramp.p))
      * CASE EXTRACT(ISODOW FROM date_trunc('day', now())
          - (d.day_offset * interval '1 day'))
          WHEN 6 THEN 0.90
          WHEN 7 THEN 0.86
          WHEN 5 THEN 0.97
          ELSE 1.0
        END
      * (1.0 + ((d.day_offset * 37 + 11) % 13 - 6) * 0.012)
    )
  ))::int AS n
) AS daily
CROSS JOIN LATERAL (
  SELECT CASE
    WHEN d.day_offset <= 3
      AND dev.n > 9071
      AND (dev.n - 9071) <= (929 * CASE d.day_offset
        WHEN 3 THEN 40
        WHEN 2 THEN 70
        ELSE 100
      END) / 100
      THEN 'v3'
    WHEN d.day_offset <= 13
      AND dev.n > 357
      AND (dev.n - 357) <= (9643 * CASE d.day_offset
        WHEN 13 THEN 25
        WHEN 12 THEN 55
        WHEN 11 THEN 82
        ELSE 100
      END) / 100
      THEN 'v2'
    ELSE 'v1'
  END AS pkg
) AS ver
WHERE ((dev.n * 7919 + d.day_offset * 104729) % 10000) < daily.n;

-- Failed events: kind × count per release (one reason dominates, thin tail).
INSERT INTO metric_event (
  id, event_id, event_name, emitted_at,
  team_id, app_id, deployment_id, deployment_key,
  binary_version, running_package_hash, target_package_hash,
  device_id, sdk_version, platform, attributes, failure_payload
)
SELECT
  'me_demo_ex_' || f.cohort || '_failed_' || f.kind || '_' || g,
  'evt_demo_ex_' || f.cohort || '_failed_' || f.kind || '_' || g,
  'Failed',
  now() - (g * f.offset_step),
  (SELECT id FROM team WHERE name = 'default-team'),
  'app_demo_example',
  r.deployment_id,
  r.deployment_key,
  r.binary_version,
  r.package_hash,
  r.package_hash,
  'device_demo_' || f.cohort || '_fail_' || f.kind || '_' || g,
  '0.1.0',
  plat.platform,
  jsonb_strip_nulls(jsonb_build_object(
    'reason', k.reason,
    'delivery_type', r.delivery_type,
    'failure_subtype', k.failure_subtype,
    'payload', CASE
      WHEN payload.obj IS NULL THEN NULL
      ELSE payload.obj::text
    END
  )),
  payload.obj
FROM (VALUES
  ('stg_v4'::text, 'crash'::text, 4, interval '2 hours'),
  ('stg_v4', 'timeout', 1, interval '14 hours'),
  ('prd_v1', 'timeout', 8, interval '1 day'),
  ('prd_v1', 'dns', 2, interval '1 day'),
  ('prd_v1', 'forbidden', 2, interval '1 day'),
  ('prd_v1', 'crash', 1, interval '1 day'),
  ('prd_v2', 'timeout', 8, interval '1 day'),
  ('prd_v2', 'dns', 1, interval '36 hours'),
  ('prd_v2', 'forbidden', 2, interval '12 hours'),
  ('prd_v2', 'integrity', 1, interval '12 hours'),
  ('prd_v3', 'timeout', 1, interval '2 days')
) AS f(cohort, kind, n, offset_step)
JOIN (VALUES
  (
    'stg_v4'::text,
    'deployment_demo_example_staging',
    'demo_example_staging_deployment_key',
    '1.1.0', 'demo_ex_stg_pkg_v4', 'patch'
  ),
  (
    'prd_v1',
    'deployment_demo_example_production',
    'demo_example_production_deployment_key',
    '1.0.0', 'demo_ex_prd_pkg_v1', 'full_bundle'
  ),
  (
    'prd_v2',
    'deployment_demo_example_production',
    'demo_example_production_deployment_key',
    '1.0.0', 'demo_ex_prd_pkg_v2', 'full_bundle'
  ),
  (
    'prd_v3',
    'deployment_demo_example_production',
    'demo_example_production_deployment_key',
    '1.0.1', 'demo_ex_prd_pkg_v3', 'patch'
  )
) AS r(
  cohort, deployment_id, deployment_key,
  binary_version, package_hash, delivery_type
) USING (cohort)
JOIN (VALUES
  ('crash'::text, 'install_fail', 'crash_rollback'),
  ('timeout', 'network', NULL),
  ('dns', 'network', NULL),
  ('forbidden', 'network', NULL),
  ('integrity', 'integrity', NULL)
) AS k(kind, reason, failure_subtype) USING (kind)
CROSS JOIN LATERAL generate_series(1, f.n) AS g
CROSS JOIN LATERAL (
  SELECT CASE WHEN g % 2 = 0 THEN 'ios' ELSE 'android' END AS platform
) AS plat
CROSS JOIN LATERAL (
  SELECT CASE
    WHEN f.kind = 'crash' AND plat.platform = 'ios' THEN NULL
    WHEN f.kind = 'crash'
      THEN '{"android_previous_process_exit":"REASON_CRASH"}'::jsonb
    WHEN f.kind = 'timeout' AND plat.platform = 'android'
      THEN '{"code":"0","message":"The request timed out.","android_previous_process_exit":"REASON_USER_REQUESTED"}'::jsonb
    WHEN f.kind = 'timeout'
      THEN '{"code":"0","message":"The request timed out."}'::jsonb
    WHEN f.kind = 'dns' AND plat.platform = 'android'
      THEN '{"code":"0","message":"Unable to resolve host d2example.cloudfront.net: No address associated with hostname","android_previous_process_exit":"REASON_USER_REQUESTED"}'::jsonb
    WHEN f.kind = 'dns'
      THEN '{"code":"0","message":"Unable to resolve host d2example.cloudfront.net: No address associated with hostname"}'::jsonb
    WHEN f.kind = 'forbidden' AND plat.platform = 'android'
      THEN '{"code":"403","message":"AccessDenied: Access Denied.","android_previous_process_exit":"REASON_USER_REQUESTED"}'::jsonb
    WHEN f.kind = 'forbidden'
      THEN '{"code":"403","message":"AccessDenied: Access Denied."}'::jsonb
    WHEN f.kind = 'integrity'
      THEN '{"android_previous_process_exit":"REASON_USER_REQUESTED"}'::jsonb
  END AS obj
) AS payload;
