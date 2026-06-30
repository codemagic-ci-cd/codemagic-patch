import type { Pool } from "pg";

import type {
  ApiTokenId,
  ApiTokenMetadata,
  MembershipId,
  OAuthAccessTokenId,
  OAuthAccessTokenMetadata,
  OAuthSession,
  OAuthSessionId,
  RefreshTokenId,
  RefreshTokenMetadata,
  RoleBindingId,
  Team,
  TeamId,
  UserAccount,
  UserId,
} from "../domain";
import { canonicalizeEmail } from "../app/email";
import type { OAuthProviderIdentity } from "../app/authNAdapter";
import type { DatabasePool } from "../db";
import { withTransaction } from "../db";
import {
  mapApiTokenRow,
  mapOAuthAccessTokenRow,
  mapOAuthSessionRow,
  mapRefreshTokenRow,
  mapTeamRow,
  mapUserAccountRow,
  type ApiTokenRow,
  type OAuthAccessTokenRow,
  type OAuthSessionRow,
  type RefreshTokenRow,
  type TeamRow,
  type UserAccountRow,
} from "./rowMappers";

const UNIQUE_VIOLATION_CODE = "23505";
const OWNER_ROLE_DEFINITION_ID = "role_owner";

export interface CreateUserInput {
  createdAt: Date;
  displayName: string | null;
  email: string;
  id: UserId;
}

export type CreateUserResult =
  | {
      outcome: "created";
      user: UserAccount;
    }
  | {
      outcome: "conflict";
      reason: "email_exists";
    };

export interface CreateApiTokenInput {
  createdAt: Date;
  displayName: string;
  expiresAt: Date | null;
  id: ApiTokenId;
  maskedPrefix: string;
  tokenHash: string;
  userId: UserId;
}

export interface ResolveOAuthIdentityInput {
  createdAt: Date;
  identity: OAuthProviderIdentity;
  /**
   * Raw allowlist of admin emails permitted to create the first account even
   * under invite-only registration. Compared after canonicalization.
   */
  initialAdminEmails?: string[];
  newUserId: UserId;
  registrationMode: "invite_only" | "open";
}

export type ResolveOAuthIdentityResult =
  | {
      outcome: "found";
      user: UserAccount;
    }
  | {
      outcome: "linked";
      user: UserAccount;
    }
  | {
      outcome: "created";
      user: UserAccount;
    }
  | {
      outcome: "conflict";
      reason: "oauth_identity_conflict";
      user: UserAccount;
    }
  | {
      outcome: "registration_closed";
      reason: "registration_invite_only";
    }
  | {
      outcome: "unverified_email";
      reason: "unverified_email";
    };

export interface CreateOAuthSessionInput {
  accessToken: {
    expiresAt: Date;
    id: OAuthAccessTokenId;
    tokenHash: string;
  };
  createdAt: Date;
  provider: string;
  refreshToken: {
    expiresAt: Date;
    id: RefreshTokenId;
    tokenHash: string;
  };
  sessionId: OAuthSessionId;
  subject: string;
  userId: UserId;
}

export interface CreateOAuthSessionResult {
  accessToken: OAuthAccessTokenMetadata;
  refreshToken: RefreshTokenMetadata;
  session: OAuthSession;
}

export type ResolveApiTokenResult =
  | {
      outcome: "found";
      token: ApiTokenMetadata;
      user: UserAccount;
    }
  | {
      outcome: "not_found";
    }
  | {
      outcome: "expired";
    }
  | {
      outcome: "user_disabled";
      token: ApiTokenMetadata;
      user: UserAccount;
    };

export type ResolveOAuthAccessTokenResult =
  | {
      outcome: "found";
      session: OAuthSession;
      token: OAuthAccessTokenMetadata;
      user: UserAccount;
    }
  | {
      outcome: "not_found";
    }
  | {
      outcome: "expired";
    }
  | {
      outcome: "revoked";
    }
  | {
      outcome: "session_revoked";
    }
  | {
      outcome: "user_disabled";
      session: OAuthSession;
      token: OAuthAccessTokenMetadata;
      user: UserAccount;
    };

export interface RotateOAuthRefreshTokenInput {
  accessToken: {
    expiresAt: Date;
    id: OAuthAccessTokenId;
    tokenHash: string;
  };
  now: Date;
  refreshToken: {
    expiresAt: Date;
    id: RefreshTokenId;
    tokenHash: string;
  };
  refreshTokenHash: string;
}

export type RotateOAuthRefreshTokenResult =
  | {
      accessToken: OAuthAccessTokenMetadata;
      outcome: "rotated";
      refreshToken: RefreshTokenMetadata;
      session: OAuthSession;
      user: UserAccount;
    }
  | {
      outcome: "not_found";
    }
  | {
      outcome: "expired";
    }
  | {
      outcome: "session_revoked";
    }
  | {
      outcome: "reused";
      session: OAuthSession;
      token: RefreshTokenMetadata;
      user: UserAccount;
    }
  | {
      outcome: "user_disabled";
      session: OAuthSession;
      token: RefreshTokenMetadata;
      user: UserAccount;
    };

export interface RevokeOAuthSessionByRefreshTokenHashInput {
  refreshTokenHash: string;
  revokedAt: Date;
}

export type RevokeOAuthSessionByRefreshTokenHashResult =
  | {
      outcome: "revoked";
    }
  | {
      outcome: "not_found";
    };

export interface GrantTeamRoleInput {
  createdAt: Date;
  createdBy: UserId | null;
  id: RoleBindingId;
  roleDefinitionId: string;
  scopeId: TeamId;
  userId: UserId;
}

export interface CreateMembershipInput {
  createdAt: Date;
  id: MembershipId;
  teamId: TeamId;
  userId: UserId;
}

export interface CreateTeamForUserInput {
  createdAt: Date;
  membershipId: MembershipId;
  name: string;
  roleBindingId: RoleBindingId;
  teamId: TeamId;
  userId: UserId;
}

export type CreateTeamForUserResult =
  | {
      membershipId: MembershipId;
      outcome: "created";
      roleBindingId: RoleBindingId;
      team: Team;
    }
  | {
      outcome: "conflict";
      reason: "team_name_exists";
    }
  | {
      outcome: "not_found";
      reason: "user_not_found";
    }
  | {
      outcome: "account_disabled";
      reason: "user_disabled";
    };

export interface GrantTeamOwnerByEmailInput {
  createdAt: Date;
  email: string;
  membershipId: MembershipId;
  roleBindingId: RoleBindingId;
  teamId: TeamId;
}

export type GrantTeamOwnerByEmailResult =
  | {
      membershipCreated: boolean;
      outcome: "granted";
      ownerRoleBindingCreated: boolean;
      team: Team;
      user: UserAccount;
    }
  | {
      outcome: "not_found";
      reason: "team_not_found" | "user_not_found";
    }
  | {
      outcome: "account_disabled";
      reason: "team_disabled" | "user_disabled";
    };

export interface AuthRepository {
  createApiToken(input: CreateApiTokenInput): Promise<ApiTokenMetadata>;
  createMembership(input: CreateMembershipInput): Promise<void>;
  createOAuthSession(
    input: CreateOAuthSessionInput,
  ): Promise<CreateOAuthSessionResult>;
  createTeamForUser(
    input: CreateTeamForUserInput,
  ): Promise<CreateTeamForUserResult>;
  createUser(input: CreateUserInput): Promise<CreateUserResult>;
  deleteApiTokenForUser(userId: UserId, tokenId: ApiTokenId): Promise<boolean>;
  getUserByEmail(email: string): Promise<UserAccount | null>;
  getUserById(userId: UserId): Promise<UserAccount | null>;
  grantTeamOwnerByEmail(
    input: GrantTeamOwnerByEmailInput,
  ): Promise<GrantTeamOwnerByEmailResult>;
  grantTeamRole(input: GrantTeamRoleInput): Promise<void>;
  listApiTokensForUser(userId: UserId): Promise<ApiTokenMetadata[]>;
  resolveApiTokenHash(
    tokenHash: string,
    now: Date,
  ): Promise<ResolveApiTokenResult>;
  resolveOAuthIdentity(
    input: ResolveOAuthIdentityInput,
  ): Promise<ResolveOAuthIdentityResult>;
  resolveOAuthAccessTokenHash(
    tokenHash: string,
    now: Date,
  ): Promise<ResolveOAuthAccessTokenResult>;
  revokeOAuthSessionByRefreshTokenHash(
    input: RevokeOAuthSessionByRefreshTokenHashInput,
  ): Promise<RevokeOAuthSessionByRefreshTokenHashResult>;
  rotateOAuthRefreshToken(
    input: RotateOAuthRefreshTokenInput,
  ): Promise<RotateOAuthRefreshTokenResult>;
  updateApiTokenLastUsedAt(tokenId: ApiTokenId, lastUsedAt: Date): Promise<void>;
  updateOAuthAccessTokenLastUsedAt(
    tokenId: OAuthAccessTokenId,
    lastUsedAt: Date,
  ): Promise<void>;
}

interface Queryable {
  query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

interface TokenWithUserRow extends ApiTokenRow {
  user_created_at: Date;
  user_display_name: string | null;
  user_email: string;
  user_id_value: string;
  user_oauth_provider: string | null;
  user_oauth_subject: string | null;
  user_status: UserAccount["status"];
  user_updated_at: Date;
}

interface OAuthAccessTokenWithSessionAndUserRow extends OAuthAccessTokenRow {
  session_created_at: Date;
  session_id_value: string;
  session_provider: string;
  session_revoked_at: Date | null;
  session_subject: string;
  session_user_id: string;
  user_created_at: Date;
  user_display_name: string | null;
  user_email: string;
  user_id_value: string;
  user_oauth_provider: string | null;
  user_oauth_subject: string | null;
  user_status: UserAccount["status"];
  user_updated_at: Date;
}

interface RefreshTokenWithSessionAndUserRow extends RefreshTokenRow {
  session_created_at: Date;
  session_id_value: string;
  session_provider: string;
  session_revoked_at: Date | null;
  session_subject: string;
  session_user_id: string;
  user_created_at: Date;
  user_display_name: string | null;
  user_email: string;
  user_id_value: string;
  user_oauth_provider: string | null;
  user_oauth_subject: string | null;
  user_status: UserAccount["status"];
  user_updated_at: Date;
}

interface RefreshTokenWithSessionRow extends RefreshTokenRow {
  session_id_value: string;
}

export function createPostgresAuthRepository(
  pool: DatabasePool | Pool,
): AuthRepository {
  return {
    async grantTeamOwnerByEmail(input) {
      return withTransaction(pool, async (client) => {
        const user = await getUserByEmail(client, input.email);
        if (!user) {
          return {
            outcome: "not_found",
            reason: "user_not_found",
          };
        }

        if (user.status === "disabled") {
          return {
            outcome: "account_disabled",
            reason: "user_disabled",
          };
        }

        const team = await getTeamById(client, input.teamId);
        if (!team) {
          return {
            outcome: "not_found",
            reason: "team_not_found",
          };
        }

        if (team.status === "disabled") {
          return {
            outcome: "account_disabled",
            reason: "team_disabled",
          };
        }

        const membershipCreated = await insertMembershipIfMissing(client, {
          createdAt: input.createdAt,
          id: input.membershipId,
          teamId: team.id,
          userId: user.id,
        });
        const ownerRoleBindingCreated = await insertTeamRoleBindingIfMissing(
          client,
          {
            createdAt: input.createdAt,
            createdBy: null,
            id: input.roleBindingId,
            roleDefinitionId: OWNER_ROLE_DEFINITION_ID,
            scopeId: team.id,
            userId: user.id,
          },
        );

        return {
          membershipCreated,
          outcome: "granted",
          ownerRoleBindingCreated,
          team,
          user,
        };
      });
    },

    async createApiToken(input) {
      const result = await pool.query<ApiTokenRow>(
        `
          INSERT INTO api_token (
            id,
            user_id,
            display_name,
            token_hash,
            masked_prefix,
            expires_at,
            created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING *
        `,
        [
          input.id,
          input.userId,
          input.displayName,
          input.tokenHash,
          input.maskedPrefix,
          input.expiresAt,
          input.createdAt,
        ],
      );

      return mapApiTokenRow(requireRow(result.rows[0], "api_token"));
    },

    async createMembership(input) {
      await insertMembership(pool, input);
    },

    async createOAuthSession(input) {
      return withTransaction(pool, async (client) => {
        const sessionResult = await client.query<OAuthSessionRow>(
          `
            INSERT INTO oauth_session (
              id,
              user_id,
              provider,
              subject,
              created_at
            ) VALUES ($1, $2, $3, $4, $5)
            RETURNING *
          `,
          [
            input.sessionId,
            input.userId,
            input.provider,
            input.subject,
            input.createdAt,
          ],
        );
        const accessTokenResult = await client.query<OAuthAccessTokenRow>(
          `
            INSERT INTO oauth_access_token (
              id,
              session_id,
              user_id,
              token_hash,
              expires_at,
              created_at
            ) VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
          `,
          [
            input.accessToken.id,
            input.sessionId,
            input.userId,
            input.accessToken.tokenHash,
            input.accessToken.expiresAt,
            input.createdAt,
          ],
        );
        const refreshTokenResult = await client.query<RefreshTokenRow>(
          `
            INSERT INTO refresh_token (
              id,
              session_id,
              user_id,
              token_hash,
              expires_at,
              created_at
            ) VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
          `,
          [
            input.refreshToken.id,
            input.sessionId,
            input.userId,
            input.refreshToken.tokenHash,
            input.refreshToken.expiresAt,
            input.createdAt,
          ],
        );

        return {
          accessToken: mapOAuthAccessTokenRow(
            requireRow(accessTokenResult.rows[0], "oauth_access_token"),
          ),
          refreshToken: mapRefreshTokenRow(
            requireRow(refreshTokenResult.rows[0], "refresh_token"),
          ),
          session: mapOAuthSessionRow(
            requireRow(sessionResult.rows[0], "oauth_session"),
          ),
        };
      });
    },

    async createTeamForUser(input) {
      return withTransaction(pool, async (client) => {
        const user = await getUserById(client, input.userId);
        if (!user) {
          return {
            outcome: "not_found",
            reason: "user_not_found",
          };
        }

        if (user.status === "disabled") {
          return {
            outcome: "account_disabled",
            reason: "user_disabled",
          };
        }

        try {
          const teamResult = await client.query<TeamRow>(
            `
              INSERT INTO team (id, name, created_at, updated_at)
              VALUES ($1, $2, $3, $3)
              RETURNING *
            `,
            [input.teamId, input.name, input.createdAt],
          );

          await insertMembership(client, {
            createdAt: input.createdAt,
            id: input.membershipId,
            teamId: input.teamId,
            userId: input.userId,
          });
          await insertTeamRoleBinding(client, {
            createdAt: input.createdAt,
            createdBy: input.userId,
            id: input.roleBindingId,
            roleDefinitionId: OWNER_ROLE_DEFINITION_ID,
            scopeId: input.teamId,
            userId: input.userId,
          });

          return {
            membershipId: input.membershipId,
            outcome: "created",
            roleBindingId: input.roleBindingId,
            team: mapTeamRow(requireRow(teamResult.rows[0], "team")),
          };
        } catch (error) {
          if (uniqueConstraint(error) === "idx_team_name") {
            return {
              outcome: "conflict",
              reason: "team_name_exists",
            };
          }

          throw error;
        }
      });
    },

    async createUser(input) {
      const email = canonicalizeEmail(input.email);

      try {
        const result = await pool.query<UserAccountRow>(
          `
            INSERT INTO user_account (
              id,
              email,
              display_name,
              created_at,
              updated_at
            ) VALUES ($1, $2, $3, $4, $4)
            RETURNING *
          `,
          [input.id, email, input.displayName, input.createdAt],
        );

        return {
          outcome: "created",
          user: mapUserAccountRow(requireRow(result.rows[0], "user_account")),
        };
      } catch (error) {
        if (uniqueConstraint(error) === "idx_user_account_email") {
          return {
            outcome: "conflict",
            reason: "email_exists",
          };
        }

        throw error;
      }
    },

    async deleteApiTokenForUser(userId, tokenId) {
      const result = await pool.query<{ id: string }>(
        `
          DELETE FROM api_token
          WHERE id = $1
            AND user_id = $2
          RETURNING id
        `,
        [tokenId, userId],
      );

      return result.rows[0] !== undefined;
    },

    async getUserByEmail(email) {
      return getUserByEmail(pool, email);
    },

    async getUserById(userId) {
      return getUserById(pool, userId);
    },

    async grantTeamRole(input) {
      await insertTeamRoleBinding(pool, input);
    },

    async listApiTokensForUser(userId) {
      const result = await pool.query<ApiTokenRow>(
        `
          SELECT *
          FROM api_token
          WHERE user_id = $1
          ORDER BY created_at ASC, id ASC
        `,
        [userId],
      );

      return result.rows.map(mapApiTokenRow);
    },

    async resolveApiTokenHash(tokenHash, now) {
      const result = await pool.query<TokenWithUserRow>(
        `
          SELECT
            t.*,
            u.id AS user_id_value,
            u.email AS user_email,
            u.display_name AS user_display_name,
            u.status AS user_status,
            u.oauth_provider AS user_oauth_provider,
            u.oauth_subject AS user_oauth_subject,
            u.created_at AS user_created_at,
            u.updated_at AS user_updated_at
          FROM api_token t
          JOIN user_account u ON u.id = t.user_id
          WHERE t.token_hash = $1
        `,
        [tokenHash],
      );
      const row = result.rows[0];

      if (!row) {
        return {
          outcome: "not_found",
        };
      }

      const token = mapApiTokenRow(row);
      const user = mapUserAccountRow({
        created_at: row.user_created_at,
        display_name: row.user_display_name,
        email: row.user_email,
        id: row.user_id_value,
        oauth_provider: row.user_oauth_provider,
        oauth_subject: row.user_oauth_subject,
        status: row.user_status,
        updated_at: row.user_updated_at,
      });

      if (token.expiresAt && token.expiresAt <= now) {
        return {
          outcome: "expired",
        };
      }

      if (user.status === "disabled") {
        return {
          outcome: "user_disabled",
          token,
          user,
        };
      }

      return {
        outcome: "found",
        token,
        user,
      };
    },

    async resolveOAuthIdentity(input) {
      return withTransaction(pool, async (client) => {
        if (input.identity.emailVerified !== true) {
          return {
            outcome: "unverified_email",
            reason: "unverified_email",
          };
        }

        const identityUser = await getUserByOAuthIdentity(
          client,
          input.identity.provider,
          input.identity.subject,
        );
        if (identityUser) {
          return {
            outcome: "found",
            user: identityUser,
          };
        }

        const email = canonicalizeEmail(input.identity.email);
        const emailUser = await getUserByEmail(client, email);
        if (emailUser) {
          if (
            emailUser.oauthProvider !== null ||
            emailUser.oauthSubject !== null
          ) {
            return {
              outcome: "conflict",
              reason: "oauth_identity_conflict",
              user: emailUser,
            };
          }

          const linked = await linkUserOAuthIdentity(client, {
            displayName: input.identity.displayName,
            provider: input.identity.provider,
            subject: input.identity.subject,
            updatedAt: input.createdAt,
            userId: emailUser.id,
          });

          return {
            outcome: "linked",
            user: linked,
          };
        }

        const isInitialAdminEmail = (input.initialAdminEmails ?? []).some(
          (adminEmail) => canonicalizeEmail(adminEmail) === email,
        );

        if (
          input.registrationMode === "invite_only" &&
          !isInitialAdminEmail &&
          !(await existsPendingTeamInvitationForIdentity(client, {
            email,
            now: input.createdAt,
            provider: input.identity.provider,
            subject: input.identity.subject,
          }))
        ) {
          return {
            outcome: "registration_closed",
            reason: "registration_invite_only",
          };
        }

        const created = await insertOAuthUser(client, {
          createdAt: input.createdAt,
          displayName: input.identity.displayName,
          email,
          id: input.newUserId,
          provider: input.identity.provider,
          subject: input.identity.subject,
        });

        return {
          outcome: "created",
          user: created,
        };
      });
    },

    async resolveOAuthAccessTokenHash(tokenHash, now) {
      const result = await pool.query<OAuthAccessTokenWithSessionAndUserRow>(
        `
          SELECT
            t.*,
            s.id AS session_id_value,
            s.user_id AS session_user_id,
            s.provider AS session_provider,
            s.subject AS session_subject,
            s.created_at AS session_created_at,
            s.revoked_at AS session_revoked_at,
            u.id AS user_id_value,
            u.email AS user_email,
            u.display_name AS user_display_name,
            u.status AS user_status,
            u.oauth_provider AS user_oauth_provider,
            u.oauth_subject AS user_oauth_subject,
            u.created_at AS user_created_at,
            u.updated_at AS user_updated_at
          FROM oauth_access_token t
          JOIN oauth_session s ON s.id = t.session_id
          JOIN user_account u ON u.id = t.user_id
          WHERE t.token_hash = $1
        `,
        [tokenHash],
      );
      const row = result.rows[0];

      if (!row) {
        return {
          outcome: "not_found",
        };
      }

      const token = mapOAuthAccessTokenRow(row);
      const session = mapOAuthSessionRow({
        created_at: row.session_created_at,
        id: row.session_id_value,
        provider: row.session_provider,
        revoked_at: row.session_revoked_at,
        subject: row.session_subject,
        user_id: row.session_user_id,
      });
      const user = mapUserAccountRow({
        created_at: row.user_created_at,
        display_name: row.user_display_name,
        email: row.user_email,
        id: row.user_id_value,
        oauth_provider: row.user_oauth_provider,
        oauth_subject: row.user_oauth_subject,
        status: row.user_status,
        updated_at: row.user_updated_at,
      });

      if (token.revokedAt) {
        return {
          outcome: "revoked",
        };
      }

      if (session.revokedAt) {
        return {
          outcome: "session_revoked",
        };
      }

      if (token.expiresAt <= now) {
        return {
          outcome: "expired",
        };
      }

      if (user.status === "disabled") {
        return {
          outcome: "user_disabled",
          session,
          token,
          user,
        };
      }

      return {
        outcome: "found",
        session,
        token,
        user,
      };
    },

    async revokeOAuthSessionByRefreshTokenHash(input) {
      return withTransaction(pool, async (client) => {
        const result = await client.query<RefreshTokenWithSessionRow>(
          `
            SELECT
              rt.*,
              s.id AS session_id_value
            FROM refresh_token rt
            JOIN oauth_session s ON s.id = rt.session_id
            WHERE rt.token_hash = $1
              AND rt.revoked_at IS NULL
              AND rt.expires_at > $2
              AND s.revoked_at IS NULL
            FOR UPDATE OF rt
          `,
          [input.refreshTokenHash, input.revokedAt],
        );
        const row = result.rows[0];

        if (!row) {
          return {
            outcome: "not_found",
          };
        }

        await revokeOAuthSessionFamily(
          client,
          row.session_id_value,
          input.revokedAt,
        );

        return {
          outcome: "revoked",
        };
      });
    },

    async rotateOAuthRefreshToken(input) {
      return withTransaction(pool, async (client) => {
        const result = await client.query<RefreshTokenWithSessionAndUserRow>(
          `
            SELECT
              rt.*,
              s.id AS session_id_value,
              s.user_id AS session_user_id,
              s.provider AS session_provider,
              s.subject AS session_subject,
              s.created_at AS session_created_at,
              s.revoked_at AS session_revoked_at,
              u.id AS user_id_value,
              u.email AS user_email,
              u.display_name AS user_display_name,
              u.status AS user_status,
              u.oauth_provider AS user_oauth_provider,
              u.oauth_subject AS user_oauth_subject,
              u.created_at AS user_created_at,
              u.updated_at AS user_updated_at
            FROM refresh_token rt
            JOIN oauth_session s ON s.id = rt.session_id
            JOIN user_account u ON u.id = rt.user_id
            WHERE rt.token_hash = $1
            FOR UPDATE OF rt
          `,
          [input.refreshTokenHash],
        );
        const row = result.rows[0];

        if (!row) {
          return {
            outcome: "not_found",
          };
        }

        const token = mapRefreshTokenRow(row);
        const session = mapOAuthSessionRow({
          created_at: row.session_created_at,
          id: row.session_id_value,
          provider: row.session_provider,
          revoked_at: row.session_revoked_at,
          subject: row.session_subject,
          user_id: row.session_user_id,
        });
        const user = mapUserAccountRow({
          created_at: row.user_created_at,
          display_name: row.user_display_name,
          email: row.user_email,
          id: row.user_id_value,
          oauth_provider: row.user_oauth_provider,
          oauth_subject: row.user_oauth_subject,
          status: row.user_status,
          updated_at: row.user_updated_at,
        });

        if (session.revokedAt) {
          return {
            outcome: "session_revoked",
          };
        }

        if (token.revokedAt) {
          await revokeOAuthSessionFamily(client, session.id, input.now);
          return {
            outcome: "reused",
            session,
            token,
            user,
          };
        }

        if (token.expiresAt <= input.now) {
          return {
            outcome: "expired",
          };
        }

        if (user.status === "disabled") {
          return {
            outcome: "user_disabled",
            session,
            token,
            user,
          };
        }

        await client.query(
          `
            UPDATE refresh_token
            SET revoked_at = $2
            WHERE id = $1
              AND revoked_at IS NULL
          `,
          [token.id, input.now],
        );
        await client.query(
          `
            UPDATE oauth_access_token
            SET revoked_at = $2
            WHERE session_id = $1
              AND revoked_at IS NULL
          `,
          [session.id, input.now],
        );

        const accessTokenResult = await client.query<OAuthAccessTokenRow>(
          `
            INSERT INTO oauth_access_token (
              id,
              session_id,
              user_id,
              token_hash,
              expires_at,
              created_at
            ) VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
          `,
          [
            input.accessToken.id,
            session.id,
            user.id,
            input.accessToken.tokenHash,
            input.accessToken.expiresAt,
            input.now,
          ],
        );
        const refreshTokenResult = await client.query<RefreshTokenRow>(
          `
            INSERT INTO refresh_token (
              id,
              session_id,
              user_id,
              token_hash,
              expires_at,
              created_at
            ) VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
          `,
          [
            input.refreshToken.id,
            session.id,
            user.id,
            input.refreshToken.tokenHash,
            input.refreshToken.expiresAt,
            input.now,
          ],
        );

        return {
          accessToken: mapOAuthAccessTokenRow(
            requireRow(accessTokenResult.rows[0], "oauth_access_token"),
          ),
          outcome: "rotated",
          refreshToken: mapRefreshTokenRow(
            requireRow(refreshTokenResult.rows[0], "refresh_token"),
          ),
          session,
          user,
        };
      });
    },

    async updateApiTokenLastUsedAt(tokenId, lastUsedAt) {
      await pool.query(
        `
          UPDATE api_token
          SET last_used_at = $2
          WHERE id = $1
        `,
        [tokenId, lastUsedAt],
      );
    },

    async updateOAuthAccessTokenLastUsedAt(tokenId, lastUsedAt) {
      await pool.query(
        `
          UPDATE oauth_access_token
          SET last_used_at = $2
          WHERE id = $1
        `,
        [tokenId, lastUsedAt],
      );
    },
  };
}

async function getUserByOAuthIdentity(
  pool: Queryable,
  provider: string,
  subject: string,
): Promise<UserAccount | null> {
  const result = await pool.query<UserAccountRow>(
    `
      SELECT *
      FROM user_account
      WHERE oauth_provider = $1
        AND oauth_subject = $2
    `,
    [provider, subject],
  );

  return result.rows[0] ? mapUserAccountRow(result.rows[0]) : null;
}

async function getUserById(
  pool: Queryable,
  userId: UserId,
): Promise<UserAccount | null> {
  const result = await pool.query<UserAccountRow>(
    "SELECT * FROM user_account WHERE id = $1",
    [userId],
  );

  return result.rows[0] ? mapUserAccountRow(result.rows[0]) : null;
}

// The invite-only gate is satisfied by a pending invitation matching EITHER the
// verified email or the signing-in GitHub identity (handle-based invitations).
async function existsPendingTeamInvitationForIdentity(
  pool: Queryable,
  input: {
    email: string;
    now: Date;
    provider: string;
    subject: string;
  },
): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM team_invitation
        WHERE status = 'pending'
          AND expires_at > $3
          AND (
            email = $1
            OR (oauth_provider = $2 AND oauth_subject = $4)
          )
      ) AS exists
    `,
    [
      canonicalizeEmail(input.email),
      input.provider,
      input.now,
      input.subject,
    ],
  );

  return result.rows[0]?.exists === true;
}

async function getUserByEmail(
  pool: Queryable,
  email: string,
): Promise<UserAccount | null> {
  const result = await pool.query<UserAccountRow>(
    "SELECT * FROM user_account WHERE email = $1",
    [canonicalizeEmail(email)],
  );

  return result.rows[0] ? mapUserAccountRow(result.rows[0]) : null;
}

async function getTeamById(
  pool: Queryable,
  teamId: TeamId,
): Promise<Team | null> {
  const result = await pool.query<TeamRow>(
    "SELECT * FROM team WHERE id = $1",
    [teamId],
  );

  return result.rows[0] ? mapTeamRow(result.rows[0]) : null;
}

async function linkUserOAuthIdentity(
  pool: Queryable,
  input: {
    displayName: string | null;
    provider: string;
    subject: string;
    updatedAt: Date;
    userId: UserId;
  },
): Promise<UserAccount> {
  const result = await pool.query<UserAccountRow>(
    `
      UPDATE user_account
      SET
        display_name = COALESCE(display_name, $2),
        oauth_provider = $3,
        oauth_subject = $4,
        updated_at = $5
      WHERE id = $1
        AND oauth_provider IS NULL
        AND oauth_subject IS NULL
      RETURNING *
    `,
    [
      input.userId,
      input.displayName,
      input.provider,
      input.subject,
      input.updatedAt,
    ],
  );

  return mapUserAccountRow(requireRow(result.rows[0], "user_account"));
}

async function insertOAuthUser(
  pool: Queryable,
  input: {
    createdAt: Date;
    displayName: string | null;
    email: string;
    id: UserId;
    provider: string;
    subject: string;
  },
): Promise<UserAccount> {
  const result = await pool.query<UserAccountRow>(
    `
      INSERT INTO user_account (
        id,
        email,
        display_name,
        oauth_provider,
        oauth_subject,
        created_at,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $6)
      RETURNING *
    `,
    [
      input.id,
      input.email,
      input.displayName,
      input.provider,
      input.subject,
      input.createdAt,
    ],
  );

  return mapUserAccountRow(requireRow(result.rows[0], "user_account"));
}

async function insertMembership(
  pool: Queryable,
  input: CreateMembershipInput,
): Promise<void> {
  await pool.query(
    `
      INSERT INTO membership (id, team_id, user_id, created_at)
      VALUES ($1, $2, $3, $4)
    `,
    [input.id, input.teamId, input.userId, input.createdAt],
  );
}

async function insertMembershipIfMissing(
  pool: Queryable,
  input: CreateMembershipInput,
): Promise<boolean> {
  const result = await pool.query<{ id: string }>(
    `
      INSERT INTO membership (id, team_id, user_id, created_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (team_id, user_id) DO NOTHING
      RETURNING id
    `,
    [input.id, input.teamId, input.userId, input.createdAt],
  );

  return result.rows[0] !== undefined;
}

async function insertTeamRoleBinding(
  pool: Queryable,
  input: GrantTeamRoleInput,
): Promise<void> {
  await pool.query(
    `
      INSERT INTO role_binding (
        id,
        principal_type,
        principal_id,
        role_definition_id,
        scope_type,
        scope_id,
        created_at,
        created_by
      ) VALUES ($1, 'user', $2, $3, 'team', $4, $5, $6)
    `,
    [
      input.id,
      input.userId,
      input.roleDefinitionId,
      input.scopeId,
      input.createdAt,
      input.createdBy,
    ],
  );
}

async function insertTeamRoleBindingIfMissing(
  pool: Queryable,
  input: GrantTeamRoleInput,
): Promise<boolean> {
  const result = await pool.query<{ id: string }>(
    `
      INSERT INTO role_binding (
        id,
        principal_type,
        principal_id,
        role_definition_id,
        scope_type,
        scope_id,
        created_at,
        created_by
      ) VALUES ($1, 'user', $2, $3, 'team', $4, $5, $6)
      ON CONFLICT (
        principal_type,
        principal_id,
        role_definition_id,
        scope_type,
        scope_id
      ) DO NOTHING
      RETURNING id
    `,
    [
      input.id,
      input.userId,
      input.roleDefinitionId,
      input.scopeId,
      input.createdAt,
      input.createdBy,
    ],
  );

  return result.rows[0] !== undefined;
}

async function revokeOAuthSessionFamily(
  pool: Queryable,
  sessionId: OAuthSessionId | string,
  revokedAt: Date,
): Promise<void> {
  await pool.query(
    `
      UPDATE oauth_session
      SET revoked_at = $2
      WHERE id = $1
        AND revoked_at IS NULL
    `,
    [sessionId, revokedAt],
  );
  await pool.query(
    `
      UPDATE refresh_token
      SET revoked_at = $2
      WHERE session_id = $1
        AND revoked_at IS NULL
    `,
    [sessionId, revokedAt],
  );
  await pool.query(
    `
      UPDATE oauth_access_token
      SET revoked_at = $2
      WHERE session_id = $1
        AND revoked_at IS NULL
    `,
    [sessionId, revokedAt],
  );
}

function requireRow<T>(row: T | undefined, tableName: string): T {
  if (!row) {
    throw new Error(`expected ${tableName} row to be returned`);
  }

  return row;
}

function uniqueConstraint(error: unknown): string | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === UNIQUE_VIOLATION_CODE &&
    "constraint" in error &&
    typeof error.constraint === "string"
  ) {
    return error.constraint;
  }

  return null;
}
