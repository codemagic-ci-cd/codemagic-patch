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
    now() - interval '21 days',
    now() - interval '21 days'
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
    now() - interval '10 days',
    now() - interval '10 days'
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

-- Helper pattern: one INSERT per (deployment, package hash, event_name) cohort.
-- emitted_at spreads across the last 14 days so a future time-series view has
-- something to bucket; counters today only need the COUNT(*) totals.
--
-- Staging ≈ 30-person internal team: most Active on latest (v3), a minority on
-- the previous (v2), a couple of stragglers on v1. v4 is disabled with failed
-- residue and no remaining Active. Lifetime funnel can exceed current Active.
--
-- Production ≈ 70k fleet: almost everyone Active on v2, ~10% canary on v3,
-- a few thousand stragglers still on v1. Older releases keep high lifetime
-- Success/Downloaded even when Active is low.

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
  now() - ((g % 14) * interval '1 day') - ((g % 17) * interval '1 hour'),
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
    WHEN e.event_name IN ('Downloaded', 'Installed', 'Success')
      THEN '{"delivery_type":"full_bundle"}'::jsonb
    ELSE NULL
  END
FROM (VALUES
  ('Downloaded'::text, 28),
  ('Installed', 26),
  ('Success', 25),
  ('Failed', 1),
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
  now() - ((g % 10) * interval '1 day') - ((g % 13) * interval '1 hour'),
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
    WHEN e.event_name IN ('Downloaded', 'Installed', 'Success')
      THEN '{"delivery_type":"full_bundle"}'::jsonb
    ELSE NULL
  END
FROM (VALUES
  ('Downloaded'::text, 20),
  ('Installed', 18),
  ('Success', 17),
  ('Failed', 1),
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
  now() - ((g % 3) * interval '1 day') - ((g % 11) * interval '1 hour'),
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
    WHEN e.event_name IN ('Downloaded', 'Installed', 'Success')
      THEN '{"delivery_type":"patch"}'::jsonb
    ELSE NULL
  END
FROM (VALUES
  ('Downloaded'::text, 24),
  ('Installed', 23),
  ('Success', 22),
  ('Failed', 1),
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
    WHEN e.event_name IN ('Downloaded', 'Installed', 'Success')
      THEN '{"delivery_type":"patch"}'::jsonb
    ELSE NULL
  END
FROM (VALUES
  ('Downloaded'::text, 8),
  ('Installed', 6),
  ('Success', 2),
  ('Failed', 5)
) AS e(event_name, n)
CROSS JOIN LATERAL generate_series(1, e.n) AS g;

-- Production v1 (stragglers; high lifetime funnel from earlier full rollout)
INSERT INTO metric_event (
  id, event_id, event_name, emitted_at,
  team_id, app_id, deployment_id, deployment_key,
  binary_version, running_package_hash, target_package_hash,
  device_id, sdk_version, platform, attributes
)
SELECT
  'me_demo_ex_prd_v1_' || lower(e.event_name) || '_' || g,
  'evt_demo_ex_prd_v1_' || lower(e.event_name) || '_' || g,
  e.event_name,
  now() - ((g % 14) * interval '1 day') - ((g % 19) * interval '1 hour'),
  (SELECT id FROM team WHERE name = 'default-team'),
  'app_demo_example',
  'deployment_demo_example_production',
  'demo_example_production_deployment_key',
  '1.0.0',
  'demo_ex_prd_pkg_v1',
  'demo_ex_prd_pkg_v1',
  'device_demo_prd_v1_' || g,
  '0.1.0',
  CASE WHEN g % 2 = 0 THEN 'ios' ELSE 'android' END,
  CASE
    WHEN e.event_name IN ('Downloaded', 'Installed', 'Success')
      THEN '{"delivery_type":"full_bundle"}'::jsonb
    ELSE NULL
  END
FROM (VALUES
  ('Downloaded'::text, 68000),
  ('Installed', 65000),
  ('Success', 63500),
  ('Failed', 1200),
  ('Active', 2500)
) AS e(event_name, n)
CROSS JOIN LATERAL generate_series(1, e.n) AS g;

-- Production v2 (almost everyone)
INSERT INTO metric_event (
  id, event_id, event_name, emitted_at,
  team_id, app_id, deployment_id, deployment_key,
  binary_version, running_package_hash, target_package_hash,
  device_id, sdk_version, platform, attributes
)
SELECT
  'me_demo_ex_prd_v2_' || lower(e.event_name) || '_' || g,
  'evt_demo_ex_prd_v2_' || lower(e.event_name) || '_' || g,
  e.event_name,
  now() - ((g % 10) * interval '1 day') - ((g % 15) * interval '1 hour'),
  (SELECT id FROM team WHERE name = 'default-team'),
  'app_demo_example',
  'deployment_demo_example_production',
  'demo_example_production_deployment_key',
  '1.0.0',
  'demo_ex_prd_pkg_v2',
  'demo_ex_prd_pkg_v2',
  'device_demo_prd_v2_' || g,
  '0.1.0',
  CASE WHEN g % 3 = 0 THEN 'android' ELSE 'ios' END,
  CASE
    WHEN e.event_name IN ('Downloaded', 'Installed', 'Success')
      THEN '{"delivery_type":"full_bundle"}'::jsonb
    ELSE NULL
  END
FROM (VALUES
  ('Downloaded'::text, 65000),
  ('Installed', 63000),
  ('Success', 62000),
  ('Failed', 1200),
  ('Active', 61000)
) AS e(event_name, n)
CROSS JOIN LATERAL generate_series(1, e.n) AS g;

-- Production v3 (10% canary)
INSERT INTO metric_event (
  id, event_id, event_name, emitted_at,
  team_id, app_id, deployment_id, deployment_key,
  binary_version, running_package_hash, target_package_hash,
  device_id, sdk_version, platform, attributes
)
SELECT
  'me_demo_ex_prd_v3_' || lower(e.event_name) || '_' || g,
  'evt_demo_ex_prd_v3_' || lower(e.event_name) || '_' || g,
  e.event_name,
  now() - ((g % 3) * interval '1 day') - ((g % 9) * interval '1 hour'),
  (SELECT id FROM team WHERE name = 'default-team'),
  'app_demo_example',
  'deployment_demo_example_production',
  'demo_example_production_deployment_key',
  '1.0.1',
  'demo_ex_prd_pkg_v3',
  'demo_ex_prd_pkg_v3',
  'device_demo_prd_v3_' || g,
  '0.1.0',
  CASE WHEN g % 2 = 0 THEN 'ios' ELSE 'android' END,
  CASE
    WHEN e.event_name IN ('Downloaded', 'Installed', 'Success')
      THEN '{"delivery_type":"patch"}'::jsonb
    ELSE NULL
  END
FROM (VALUES
  ('Downloaded'::text, 7200),
  ('Installed', 6900),
  ('Success', 6700),
  ('Failed', 130),
  ('Active', 6500)
) AS e(event_name, n)
CROSS JOIN LATERAL generate_series(1, e.n) AS g;
