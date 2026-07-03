import type { SqlMigration } from "./index";

export const githubActionsIntegrationMigration: SqlMigration = {
  name: "0013_github_actions_integration",
  sql: `
    CREATE TABLE team_github_integration (
      id               TEXT PRIMARY KEY,
      team_id          TEXT NOT NULL REFERENCES team (id) ON DELETE CASCADE,
      token_ciphertext TEXT NOT NULL,
      token_last4      TEXT NOT NULL,
      created_by       TEXT REFERENCES user_account (id) ON DELETE SET NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      revoked_at       TIMESTAMPTZ
    );

    CREATE UNIQUE INDEX idx_team_github_integration_active_team
      ON team_github_integration (team_id)
      WHERE revoked_at IS NULL;

    CREATE TABLE deployment_github_actions (
      deployment_id   TEXT PRIMARY KEY REFERENCES deployment (id) ON DELETE CASCADE,
      owner           TEXT NOT NULL,
      repo            TEXT NOT NULL,
      workflow_file   TEXT NOT NULL,
      default_ref     TEXT NOT NULL DEFAULT 'main',
      enabled         BOOLEAN NOT NULL DEFAULT true,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX idx_deployment_github_actions_repo
      ON deployment_github_actions (owner, repo);
  `,
};
