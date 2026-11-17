import type { ApiTokenId, OAuthSessionId, UserId } from "../domain";
import type { ApiTokenRow, OAuthSessionRow } from "./rowMappers";

/**
 * Credential generations (see migration 0021 and the server spec's
 * "Credential lifecycle" section).
 *
 * A credential is live only while its row's generation equals its owner's
 * `user_account.credential_generation`. Revoke-all and identity linking
 * advance the owner's generation; every lookup filters on
 * `ON_CURRENT_GENERATION`, so a credential written on an earlier generation
 * resolves as not found even where the revocation's row updates missed it.
 *
 * Every insert takes the owner's generation inside the statement, holding
 * `FOR SHARE OF u` on the owner's row. Revoke-all and identity linking update
 * that row, so an issue overlapping one waits for it and re-evaluates against
 * the new generation; concurrent issues for one user do not wait on each
 * other. Nothing else locks the row exclusively. Anything that ever needs to
 * must use `FOR NO KEY UPDATE`: `FOR UPDATE` would also block the `KEY SHARE`
 * locks that foreign-key inserts referencing `user_account` take.
 */

interface Queryable {
  query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

/** `alias` is the credential row (api_token or oauth_session), `u` its owner. */
export function onCurrentGeneration(alias: "s" | "t"): string {
  return `${alias}.generation = u.credential_generation`;
}

/**
 * The issuing session `s` (owned by `u`) is still live: not logged out and on
 * its owner's current generation. Authentication ran before the request body
 * arrived, so the session may have ended since; this is the check that counts.
 * Takes the session id and its user id as `$first` and `$first + 1`.
 */
function liveIssuingSession(first: number): string {
  return `
    s.id = $${first}::text
    AND s.user_id = $${first + 1}::text
    AND s.revoked_at IS NULL
    AND ${onCurrentGeneration("s")}
  `;
}

export interface IssuingSession {
  id: OAuthSessionId;
  userId: UserId;
}

export interface InsertApiTokenFromSessionInput {
  createdAt: Date;
  displayName: string;
  expiresAt: Date | null;
  id: ApiTokenId;
  issuingSession: IssuingSession;
  maskedPrefix: string;
  /** The token's owner: the issuer, or the account provisioning creates. */
  ownerId: UserId;
  tokenHash: string;
}

/** Null when the issuing session is no longer live. */
export async function insertApiTokenFromSession(
  client: Queryable,
  input: InsertApiTokenFromSessionInput,
): Promise<ApiTokenRow | null> {
  const result = await client.query<ApiTokenRow>(
    `
      INSERT INTO api_token (
        id,
        user_id,
        display_name,
        token_hash,
        masked_prefix,
        expires_at,
        created_at,
        generation
      )
      SELECT
        $3::text,
        o.id,
        $4::text,
        $5::text,
        $6::text,
        $7::timestamptz,
        $8::timestamptz,
        o.credential_generation
      FROM oauth_session s
      JOIN user_account u ON u.id = s.user_id
      JOIN user_account o ON o.id = $9::text
      WHERE ${liveIssuingSession(1)}
      FOR SHARE OF u
      RETURNING *
    `,
    [
      input.issuingSession.id,
      input.issuingSession.userId,
      input.id,
      input.displayName,
      input.tokenHash,
      input.maskedPrefix,
      input.expiresAt,
      input.createdAt,
      input.ownerId,
    ],
  );

  return result.rows[0] ?? null;
}

/**
 * A CLI login approved from a live session: same owner, same provider
 * identity and the approving session's `created_at`, so the CLI login shares
 * its absolute deadline. Null when the approving session is no longer live or
 * is already past its maximum age.
 */
export async function insertCliSessionFromApproval(
  client: Queryable,
  input: {
    approvingSession: IssuingSession;
    id: OAuthSessionId;
    maxAgeDays: number;
    now: Date;
  },
): Promise<OAuthSessionRow | null> {
  const result = await client.query<OAuthSessionRow>(
    `
      INSERT INTO oauth_session (
        id,
        user_id,
        provider,
        subject,
        created_at,
        generation
      )
      SELECT
        $3::text,
        u.id,
        s.provider,
        s.subject,
        s.created_at,
        u.credential_generation
      FROM oauth_session s
      JOIN user_account u ON u.id = s.user_id
      WHERE ${liveIssuingSession(1)}
        AND s.created_at + make_interval(days => $4::integer) > $5::timestamptz
      FOR SHARE OF u
      RETURNING *
    `,
    [
      input.approvingSession.id,
      input.approvingSession.userId,
      input.id,
      input.maxAgeDays,
      input.now,
    ],
  );

  return result.rows[0] ?? null;
}

/** A provider sign-in: the one issue with no issuing session. */
export async function insertProviderSignInSession(
  client: Queryable,
  input: {
    createdAt: Date;
    id: OAuthSessionId;
    provider: string;
    subject: string;
    userId: UserId;
  },
): Promise<OAuthSessionRow | null> {
  const result = await client.query<OAuthSessionRow>(
    `
      INSERT INTO oauth_session (
        id,
        user_id,
        provider,
        subject,
        created_at,
        generation
      )
      SELECT
        $1::text,
        u.id,
        $3::text,
        $4::text,
        $5::timestamptz,
        u.credential_generation
      FROM user_account u
      WHERE u.id = $2::text
      FOR SHARE OF u
      RETURNING *
    `,
    [input.id, input.userId, input.provider, input.subject, input.createdAt],
  );

  return result.rows[0] ?? null;
}

/**
 * Advances the caller's generation, but only while the calling session is
 * still live: a revoke-all delayed past a later revoke-all (or sent from a
 * session that has since ended) must not end a newer sign-in. False means the
 * calling session is gone and nothing changed. Two revoke-alls for one user
 * serialize on the user row; the second sees the new generation and loses.
 */
export async function advanceGenerationFromSession(
  client: Queryable,
  callingSession: IssuingSession,
): Promise<boolean> {
  const result = await client.query<{ id: string }>(
    `
      UPDATE user_account u
      SET credential_generation = u.credential_generation + 1
      FROM oauth_session s
      WHERE u.id = $2::text
        AND ${liveIssuingSession(1)}
      RETURNING u.id
    `,
    [callingSession.id, callingSession.userId],
  );

  return result.rows[0] !== undefined;
}

export interface RevokedCredentialCounts {
  apiTokenCount: number;
  sessionCount: number;
}

/**
 * Marks every session of the user revoked and deletes its API tokens. Run in
 * the transaction that advanced the user's generation, after that update.
 *
 * Row order matters: `refresh_token`, then `oauth_access_token`, then
 * `oauth_session`, the order `revokeOAuthSessionFamily` (logout, refresh-token
 * reuse) uses for one session. Logout holds the live refresh token, so it is
 * met at the first statement; reuse holds an already-revoked one that this
 * skips, so only the shared order keeps the two from waiting on each other.
 */
export async function revokeUserCredentials(
  client: Queryable,
  userId: UserId,
  revokedAt: Date,
): Promise<RevokedCredentialCounts> {
  await client.query(
    `
      UPDATE refresh_token
      SET revoked_at = $2
      WHERE user_id = $1
        AND revoked_at IS NULL
    `,
    [userId, revokedAt],
  );
  await client.query(
    `
      UPDATE oauth_access_token
      SET revoked_at = $2
      WHERE user_id = $1
        AND revoked_at IS NULL
    `,
    [userId, revokedAt],
  );
  const sessions = await client.query<{ id: string }>(
    `
      UPDATE oauth_session
      SET revoked_at = $2
      WHERE user_id = $1
        AND revoked_at IS NULL
      RETURNING id
    `,
    [userId, revokedAt],
  );
  const apiTokens = await client.query<{ id: string }>(
    "DELETE FROM api_token WHERE user_id = $1 RETURNING id",
    [userId],
  );

  return {
    apiTokenCount: apiTokens.rows.length,
    sessionCount: sessions.rows.length,
  };
}
