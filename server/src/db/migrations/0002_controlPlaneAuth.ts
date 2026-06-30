import type { SqlMigration } from "./index";

export const controlPlaneAuthMigration: SqlMigration = {
  name: "0002_control_plane_auth",
  sql: `
    CREATE TABLE user_account (
      id              TEXT PRIMARY KEY,
      email           TEXT NOT NULL,
      display_name    TEXT,
      status          TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'disabled')),
      oauth_provider  TEXT,
      oauth_subject   TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX idx_user_account_email ON user_account (email);
    CREATE UNIQUE INDEX idx_user_account_oauth
      ON user_account (oauth_provider, oauth_subject)
      WHERE oauth_provider IS NOT NULL;

    CREATE TABLE membership (
      id          TEXT PRIMARY KEY,
      team_id     TEXT NOT NULL REFERENCES team (id) ON DELETE CASCADE,
      user_id     TEXT NOT NULL REFERENCES user_account (id) ON DELETE CASCADE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX idx_membership_team_user ON membership (team_id, user_id);
    CREATE INDEX idx_membership_user ON membership (user_id);

    CREATE TABLE role_definition (
      id            TEXT PRIMARY KEY,
      team_id       TEXT REFERENCES team (id) ON DELETE CASCADE,
      key           TEXT NOT NULL,
      display_name  TEXT NOT NULL,
      is_system     BOOLEAN NOT NULL DEFAULT false,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX idx_role_definition_system_key
      ON role_definition (key)
      WHERE team_id IS NULL;
    CREATE UNIQUE INDEX idx_role_definition_team_key
      ON role_definition (team_id, key)
      WHERE team_id IS NOT NULL;

    CREATE TABLE role_permission (
      role_definition_id  TEXT NOT NULL REFERENCES role_definition (id) ON DELETE CASCADE,
      action              TEXT NOT NULL,
      PRIMARY KEY (role_definition_id, action)
    );

    CREATE TABLE role_binding (
      id                  TEXT PRIMARY KEY,
      principal_type      TEXT NOT NULL CHECK (principal_type IN ('user')),
      principal_id        TEXT NOT NULL REFERENCES user_account (id) ON DELETE CASCADE,
      role_definition_id  TEXT NOT NULL REFERENCES role_definition (id) ON DELETE CASCADE,
      scope_type          TEXT NOT NULL CHECK (scope_type IN ('team', 'app')),
      scope_id            TEXT NOT NULL,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_by          TEXT REFERENCES user_account (id) ON DELETE SET NULL
    );

    CREATE INDEX idx_role_binding_principal
      ON role_binding (principal_type, principal_id);
    CREATE INDEX idx_role_binding_scope
      ON role_binding (scope_type, scope_id);
    CREATE UNIQUE INDEX idx_role_binding_unique
      ON role_binding (
        principal_type,
        principal_id,
        role_definition_id,
        scope_type,
        scope_id
      );

    CREATE TABLE api_token (
      id             TEXT PRIMARY KEY,
      user_id        TEXT NOT NULL REFERENCES user_account (id) ON DELETE CASCADE,
      display_name   TEXT NOT NULL,
      token_hash     TEXT NOT NULL,
      masked_prefix  TEXT NOT NULL,
      expires_at     TIMESTAMPTZ,
      last_used_at   TIMESTAMPTZ,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX idx_api_token_user ON api_token (user_id);
    CREATE UNIQUE INDEX idx_api_token_hash ON api_token (token_hash);

    INSERT INTO role_definition (id, team_id, key, display_name, is_system)
    VALUES
      ('role_viewer', NULL, 'viewer', 'Viewer', true),
      ('role_developer', NULL, 'developer', 'Developer', true),
      ('role_admin', NULL, 'admin', 'Admin', true),
      ('role_owner', NULL, 'owner', 'Owner', true);

    INSERT INTO role_permission (role_definition_id, action)
    VALUES
      ('role_viewer', 'team.read'),
      ('role_viewer', 'app.read'),
      ('role_viewer', 'release.view'),
      ('role_developer', 'team.read'),
      ('role_developer', 'app.read'),
      ('role_developer', 'release.view'),
      ('role_developer', 'release.deploy'),
      ('role_admin', 'team.read'),
      ('role_admin', 'app.create'),
      ('role_admin', 'app.read'),
      ('role_admin', 'release.view'),
      ('role_admin', 'release.deploy'),
      ('role_admin', 'iam.manage'),
      ('role_owner', 'team.read'),
      ('role_owner', 'app.create'),
      ('role_owner', 'app.read'),
      ('role_owner', 'release.view'),
      ('role_owner', 'release.deploy'),
      ('role_owner', 'iam.manage');

    ALTER TABLE release
      ADD CONSTRAINT fk_release_created_by_user
      FOREIGN KEY (created_by) REFERENCES user_account (id) ON DELETE SET NULL;

    ALTER TABLE release_job
      ADD CONSTRAINT fk_release_job_requested_by_user
      FOREIGN KEY (requested_by) REFERENCES user_account (id) ON DELETE SET NULL;
  `,
};
