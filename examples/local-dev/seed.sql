-- Local-eval-only fixtures: admin user, membership, owner role, API token,
-- demo-app, and CLI/on-device deployments on the bootstrap team so smoke
-- scripts can publish without first calling control-plane CRUD APIs.
--
-- Dashboard browse data (Example Data + Staging/Production releases + metrics)
-- lives in examples/fixtures/demo-example-app.sql and is applied after this
-- file by the docker-compose.dev.yml seed service (also opt-in on self-host).
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

INSERT INTO app (id, team_id, name)
VALUES (
  'app_local_demo',
  (SELECT id FROM team WHERE name = 'default-team'),
  'demo-app'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO deployment (id, app_id, team_id, name, deployment_key)
VALUES (
  'deployment_local_staging',
  'app_local_demo',
  (SELECT id FROM team WHERE name = 'default-team'),
  'staging',
  'dev_local_deployment_key'
)
ON CONFLICT (id) DO NOTHING;

-- Per-platform deployments for the on-device demo (examples/on-device-demo).
-- Releases target (deployment, binary_version) with no platform dimension, so
-- iOS and Android must not share one deployment: the second platform's release
-- would trip the fingerprint-disagreement warning and win the shared manifest,
-- serving one platform the other's bundle. The demo app's iOS config carries
-- the ios key, its Android config the android key.
INSERT INTO deployment (id, app_id, team_id, name, deployment_key)
VALUES
  (
    'deployment_local_staging_ios',
    'app_local_demo',
    (SELECT id FROM team WHERE name = 'default-team'),
    'staging-ios',
    'dev_local_ios_deployment_key'
  ),
  (
    'deployment_local_staging_android',
    'app_local_demo',
    (SELECT id FROM team WHERE name = 'default-team'),
    'staging-android',
    'dev_local_android_deployment_key'
  )
ON CONFLICT (id) DO NOTHING;
