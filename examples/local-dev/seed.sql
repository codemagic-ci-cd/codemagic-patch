-- Attach dev fixtures (admin user, membership, owner role, API token, per-platform
-- demo apps, and their deployments) to the bootstrap team so the CLI can publish a
-- release against the local dev stack without first calling control-plane CRUD APIs.
-- Also seed a local-only API token owned by an admin user so smoke scripts can
-- authenticate through the same DB-backed path used in production-like runs.
--
-- The team itself is NOT created here: the server provisions it on boot from
-- INITIAL_TEAM_NAME (default-team) — see docker-compose.dev.yml. This seed
-- resolves that team by name, so it must run after the server is healthy.
--
-- The deployment_key is intentionally fixed so docs and scripts can refer
-- to it. Re-running the seed is safe because of the ON CONFLICT clauses.
--
-- Plaintext local token:
--   cm_pat_local-dev-token-change-me-00000001

INSERT INTO user_account (id, email, display_name)
VALUES (
  'user_local_admin',
  'local-admin@example.com',
  'Local Admin'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO membership (id, team_id, user_id)
VALUES (
  'membership_local_admin',
  (SELECT id FROM team WHERE name = 'default-team'),
  'user_local_admin'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO role_binding (
  id,
  principal_type,
  principal_id,
  role_definition_id,
  scope_type,
  scope_id,
  created_by
)
VALUES (
  'role_binding_local_admin_owner',
  'user',
  'user_local_admin',
  'role_owner',
  'team',
  (SELECT id FROM team WHERE name = 'default-team'),
  'user_local_admin'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO api_token (
  id,
  user_id,
  display_name,
  token_hash,
  masked_prefix
)
VALUES (
  'api_token_local_admin',
  'user_local_admin',
  'local-dev',
  '24331315d3d8bb8e182045ad03670042a0e2d30cf67813d0526a54438aaa77a8',
  'cm_pat_lo...'
)
ON CONFLICT (id) DO NOTHING;

-- One app per platform, matching the recommended setup (see the top-level
-- README): releases target (deployment, binary_version) with no platform
-- dimension, so iOS and Android must never share a deployment — the second
-- platform's release would trip the fingerprint-disagreement warning and win
-- the shared manifest, serving one platform the other's bundle. Splitting at
-- the app level keeps the whole hierarchy per-platform. The React Native demo
-- app itself stays a single cross-platform codebase; only the server-side app
-- entities are split.
INSERT INTO app (id, team_id, name)
VALUES
  (
    'app_local_demo_ios',
    (SELECT id FROM team WHERE name = 'default-team'),
    'demo-app-ios'
  ),
  (
    'app_local_demo_android',
    (SELECT id FROM team WHERE name = 'default-team'),
    'demo-app-android'
  )
ON CONFLICT (id) DO NOTHING;

-- Staging deployments for the on-device demo (examples/on-device-demo). The
-- demo app's iOS config carries the ios key, its Android config the android
-- key.
INSERT INTO deployment (id, app_id, team_id, name, deployment_key)
VALUES
  (
    'deployment_local_staging_ios',
    'app_local_demo_ios',
    (SELECT id FROM team WHERE name = 'default-team'),
    'staging',
    'dev_local_ios_deployment_key'
  ),
  (
    'deployment_local_staging_android',
    'app_local_demo_android',
    (SELECT id FROM team WHERE name = 'default-team'),
    'staging',
    'dev_local_android_deployment_key'
  )
ON CONFLICT (id) DO NOTHING;

-- Dedicated deployment for the CLI quickstart (the up.sh ready banner) and the
-- local-eval smoke scripts, which publish the repo's iOS Hermes fixture bundle.
-- Kept separate from the on-device demo's staging deployment so the fixture's
-- synthetic fingerprint never collides with update checks from the demo app.
INSERT INTO deployment (id, app_id, team_id, name, deployment_key)
VALUES (
  'deployment_local_cli_quickstart',
  'app_local_demo_ios',
  (SELECT id FROM team WHERE name = 'default-team'),
  'cli-quickstart',
  'dev_local_deployment_key'
)
ON CONFLICT (id) DO NOTHING;
