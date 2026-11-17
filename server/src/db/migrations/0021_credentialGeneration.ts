import type { SqlMigration } from "./index";

/**
 * A credential is live only on its owner's current credential generation.
 * Revoke-all and linking a provisioned account to a provider identity advance
 * `user_account.credential_generation`; every credential lookup compares the
 * row's own generation against it, so a credential written on an earlier
 * generation stops resolving even if its revocation missed it.
 *
 * Default 0 keeps every existing credential live.
 */
export const credentialGenerationMigration: SqlMigration = {
  name: "0021_credential_generation",
  sql: `
    ALTER TABLE user_account
      ADD COLUMN credential_generation INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE api_token
      ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE oauth_session
      ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
  `,
};
