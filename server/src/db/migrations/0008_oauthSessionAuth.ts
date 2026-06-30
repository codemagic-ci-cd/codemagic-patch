import type { SqlMigration } from "./index";

export const oauthSessionAuthMigration: SqlMigration = {
  name: "0008_oauth_session_auth",
  sql: `
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM user_account
        WHERE length(trim(email)) = 0
      ) THEN
        RAISE EXCEPTION 'blank canonical user_account.email values exist';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM user_account
        GROUP BY lower(trim(email))
        HAVING count(*) > 1
      ) THEN
        RAISE EXCEPTION 'duplicate canonical user_account.email values exist';
      END IF;
    END
    $$;

    UPDATE user_account
    SET email = lower(trim(email))
    WHERE email <> lower(trim(email));

    ALTER TABLE user_account
      ADD CONSTRAINT chk_user_account_email_canonical
      CHECK (email = lower(trim(email)) AND length(email) > 0);

    ALTER TABLE user_account
      ADD CONSTRAINT chk_user_account_oauth_identity_pair
      CHECK (
        (oauth_provider IS NULL AND oauth_subject IS NULL)
        OR (oauth_provider IS NOT NULL AND oauth_subject IS NOT NULL)
      );

    DROP INDEX idx_user_account_oauth;
    CREATE UNIQUE INDEX idx_user_account_oauth
      ON user_account (oauth_provider, oauth_subject)
      WHERE oauth_provider IS NOT NULL AND oauth_subject IS NOT NULL;

    CREATE TABLE oauth_session (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES user_account (id) ON DELETE CASCADE,
      provider    TEXT NOT NULL,
      subject     TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      revoked_at  TIMESTAMPTZ
    );

    CREATE INDEX idx_oauth_session_user ON oauth_session (user_id);
    CREATE INDEX idx_oauth_session_provider_subject
      ON oauth_session (provider, subject);

    CREATE TABLE oauth_access_token (
      id            TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL REFERENCES oauth_session (id) ON DELETE CASCADE,
      user_id       TEXT NOT NULL REFERENCES user_account (id) ON DELETE CASCADE,
      token_hash    TEXT NOT NULL,
      expires_at    TIMESTAMPTZ NOT NULL,
      revoked_at    TIMESTAMPTZ,
      last_used_at  TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX idx_oauth_access_token_user ON oauth_access_token (user_id);
    CREATE INDEX idx_oauth_access_token_session ON oauth_access_token (session_id);
    CREATE UNIQUE INDEX idx_oauth_access_token_hash
      ON oauth_access_token (token_hash);

    CREATE TABLE refresh_token (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL REFERENCES oauth_session (id) ON DELETE CASCADE,
      user_id     TEXT NOT NULL REFERENCES user_account (id) ON DELETE CASCADE,
      token_hash  TEXT NOT NULL,
      expires_at  TIMESTAMPTZ NOT NULL,
      revoked_at  TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX idx_refresh_token_user ON refresh_token (user_id);
    CREATE INDEX idx_refresh_token_session ON refresh_token (session_id);
    CREATE UNIQUE INDEX idx_refresh_token_hash ON refresh_token (token_hash);
  `,
};
