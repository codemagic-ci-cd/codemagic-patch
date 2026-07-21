import { randomUUID } from "node:crypto";

import type {
  AuthNAdapter,
  OAuthProviderIdentity,
} from "./authNAdapter";
import type {
  OAuthAccessTokenId,
  OAuthSessionId,
  RefreshTokenId,
  UserId,
} from "../domain";
import type { AuthRepository } from "../repositories";
import type {
  OAuthCallbackRouteHandler,
  OAuthCliAuthorizationIssueRouteHandler,
  OAuthCliExchangeRouteHandler,
  OAuthLogoutRouteHandler,
  OAuthRefreshRouteHandler,
  OAuthSessionCreatedHandlerResult,
  PublicAuthAuditContext,
} from "./types";
import {
  createOAuthCliAuthorizationCode,
  pkceChallengeMatches,
  verifyOAuthCliAuthorizationCode,
} from "./oauthCliAuthorizationCode";
import {
  generateOAuthAccessToken,
  generateOAuthRefreshToken,
  hashOAuthRefreshToken,
} from "./oauthToken";

export interface OAuthSessionHandlerIdGenerator {
  createOAuthAccessTokenId(): OAuthAccessTokenId;
  createOAuthSessionId(): OAuthSessionId;
  createRefreshTokenId(): RefreshTokenId;
  createUserId(): UserId;
}

export interface OAuthInvitationFulfillmentInput {
  acceptedAt: Date;
  auditContext?: PublicAuthAuditContext;
  // The signing-in OAuth identity — matches handle-based invitations.
  oauthProvider: string;
  oauthSubject: string;
  userEmail: string;
  userId: UserId;
}

export interface OAuthInvitationFulfillmentService {
  acceptPendingTeamInvitationsForUser(
    input: OAuthInvitationFulfillmentInput,
  ): Promise<void>;
}

export interface OAuthInitialAdminTeamMembershipInput {
  auditContext?: PublicAuthAuditContext;
  now: Date;
  userEmail: string;
  userId: UserId;
}

/**
 * Grants the configured initial admin(s) ownership of the bootstrap team on
 * sign-in (self-host single-team mode). A no-op for non-admin emails or when no
 * bootstrap team is configured. Idempotent: safe to run on every sign-in.
 */
export interface OAuthInitialAdminTeamMembershipService {
  ensureOwnershipForUser(
    input: OAuthInitialAdminTeamMembershipInput,
  ): Promise<void>;
}

/**
 * Hook invoked after every successful OAuth web sign-in to grant memberships
 * or roles. Embedders can supply their own implementation; the default is the
 * initial-admin bootstrap-team grant. (The CLI code exchange deliberately
 * skips it — the grants already ran during the web sign-in that approved it.)
 */
export type OAuthSignInGrantService = OAuthInitialAdminTeamMembershipService;

export const DEFAULT_CLI_AUTHORIZATION_CODE_TTL_SECONDS = 60;

export interface CreateOAuthSessionRouteHandlersOptions {
  accessTokenTtlSeconds: number;
  authNAdapter?: AuthNAdapter;
  /** Enables the CLI loopback issue/exchange handlers when set. */
  cliAuthSecret?: string;
  cliAuthorizationCodeTtlSeconds?: number;
  idGenerator?: OAuthSessionHandlerIdGenerator;
  initialAdminEmails?: string[];
  initialAdminTeamMembershipService?: OAuthInitialAdminTeamMembershipService;
  invitationFulfillmentService?: OAuthInvitationFulfillmentService;
  logger?: {
    warn(message: string, error?: unknown): void;
  };
  now?: () => Date;
  refreshTokenTtlDays: number;
  registrationMode: "invite_only" | "open";
  repository: AuthRepository;
}

export interface OAuthSessionRouteHandlers {
  oauthCallbackHandler?: OAuthCallbackRouteHandler;
  oauthCliAuthorizationIssueHandler?: OAuthCliAuthorizationIssueRouteHandler;
  oauthCliExchangeHandler?: OAuthCliExchangeRouteHandler;
  oauthLogoutHandler: OAuthLogoutRouteHandler;
  oauthRefreshHandler: OAuthRefreshRouteHandler;
}

type OAuthSessionIdentityResult =
  | OAuthSessionCreatedHandlerResult
  | {
      outcome: "conflict";
      reason: "oauth_identity_conflict";
    }
  | {
      outcome: "account_disabled";
      reason: "user_disabled";
    }
  | {
      outcome: "registration_closed";
      reason: "registration_invite_only";
    }
  | {
      outcome: "auth_failed";
      reason: "unverified_email";
    };

export function createOAuthSessionRouteHandlers(
  options: CreateOAuthSessionRouteHandlersOptions,
): OAuthSessionRouteHandlers {
  const idGenerator =
    options.idGenerator ?? createDefaultOAuthSessionHandlerIdGenerator();
  const getNow = options.now ?? (() => new Date());
  const issueSessionForUser = async (
    user: {
      createdAt: Date;
      displayName: string | null;
      email: string;
      id: UserId;
    },
    provider: string,
    subject: string,
    now: Date,
  ): Promise<OAuthSessionCreatedHandlerResult> => {
    const accessToken = generateOAuthAccessToken();
    const refreshToken = generateOAuthRefreshToken();
    const accessTokenExpiresAt = addSeconds(
      now,
      options.accessTokenTtlSeconds,
    );
    const refreshTokenExpiresAt = addDays(now, options.refreshTokenTtlDays);

    await options.repository.createOAuthSession({
      accessToken: {
        expiresAt: accessTokenExpiresAt,
        id: idGenerator.createOAuthAccessTokenId(),
        tokenHash: accessToken.tokenHash,
      },
      createdAt: now,
      provider,
      refreshToken: {
        expiresAt: refreshTokenExpiresAt,
        id: idGenerator.createRefreshTokenId(),
        tokenHash: refreshToken.tokenHash,
      },
      sessionId: idGenerator.createOAuthSessionId(),
      subject,
      userId: user.id,
    });

    return {
      accessToken: accessToken.token,
      accessTokenExpiresAt,
      outcome: "created",
      refreshToken: refreshToken.token,
      refreshTokenExpiresAt,
      user: {
        createdAt: user.createdAt,
        displayName: user.displayName,
        email: user.email,
        id: user.id,
      },
    };
  };
  const createSessionFromIdentity = async (
    identity: OAuthProviderIdentity,
    auditContext?: PublicAuthAuditContext,
  ): Promise<OAuthSessionIdentityResult> => {
    const now = getNow();
    const resolved = await options.repository.resolveOAuthIdentity({
      createdAt: now,
      identity,
      initialAdminEmails: options.initialAdminEmails,
      newUserId: idGenerator.createUserId(),
      registrationMode: options.registrationMode,
    });

    if (resolved.outcome === "conflict") {
      return {
        outcome: "conflict",
        reason: resolved.reason,
      };
    }

    if (resolved.outcome === "registration_closed") {
      return {
        outcome: "registration_closed",
        reason: resolved.reason,
      };
    }

    if (resolved.outcome === "unverified_email") {
      return {
        outcome: "auth_failed",
        reason: "unverified_email",
      };
    }

    if (resolved.user.status === "disabled") {
      return {
        outcome: "account_disabled",
        reason: "user_disabled",
      };
    }

    const created = await issueSessionForUser(
      resolved.user,
      identity.provider,
      identity.subject,
      now,
    );

    try {
      await options.initialAdminTeamMembershipService?.ensureOwnershipForUser({
        auditContext,
        now,
        userEmail: resolved.user.email,
        userId: resolved.user.id,
      });
    } catch (error) {
      (options.logger ?? console).warn(
        "OAuth initial-admin team membership grant failed",
        error,
      );
    }

    try {
      await options.invitationFulfillmentService?.acceptPendingTeamInvitationsForUser(
        {
          acceptedAt: now,
          auditContext,
          oauthProvider: identity.provider,
          oauthSubject: identity.subject,
          userEmail: resolved.user.email,
          userId: resolved.user.id,
        },
      );
    } catch (error) {
      (options.logger ?? console).warn(
        "OAuth invitation fulfillment failed",
        error,
      );
    }

    return created;
  };

  const handlers: OAuthSessionRouteHandlers = {
    async oauthLogoutHandler(input) {
      await options.repository.revokeOAuthSessionByRefreshTokenHash({
        refreshTokenHash: hashOAuthRefreshToken(input.refreshToken),
        revokedAt: getNow(),
      });

      return {
        outcome: "logged_out",
      };
    },

    async oauthRefreshHandler(input) {
      const now = getNow();
      const accessToken = generateOAuthAccessToken();
      const refreshToken = generateOAuthRefreshToken();
      const accessTokenExpiresAt = addSeconds(
        now,
        options.accessTokenTtlSeconds,
      );
      const refreshTokenExpiresAt = addDays(now, options.refreshTokenTtlDays);
      const result = await options.repository.rotateOAuthRefreshToken({
        accessToken: {
          expiresAt: accessTokenExpiresAt,
          id: idGenerator.createOAuthAccessTokenId(),
          tokenHash: accessToken.tokenHash,
        },
        now,
        refreshToken: {
          expiresAt: refreshTokenExpiresAt,
          id: idGenerator.createRefreshTokenId(),
          tokenHash: refreshToken.tokenHash,
        },
        refreshTokenHash: hashOAuthRefreshToken(input.refreshToken),
      });

      if (result.outcome === "rotated") {
        return {
          accessToken: accessToken.token,
          accessTokenExpiresAt,
          outcome: "rotated",
          refreshToken: refreshToken.token,
          refreshTokenExpiresAt,
        };
      }

      if (result.outcome === "user_disabled") {
        return {
          outcome: "account_disabled",
          reason: "user_disabled",
        };
      }

      return {
        outcome: "authentication_failed",
      };
    },
  };

  if (options.authNAdapter) {
    const authNAdapter = options.authNAdapter;

    handlers.oauthCallbackHandler = async (input) => {
      const exchanged = await authNAdapter.exchangeCode(input);
      if (exchanged.outcome !== "success") {
        return {
          outcome: "auth_failed",
          reason: exchanged.outcome,
        };
      }

      return createSessionFromIdentity(exchanged.identity, input.auditContext);
    };
  }

  if (options.cliAuthSecret) {
    const cliAuthSecret = options.cliAuthSecret;
    const codeTtlSeconds =
      options.cliAuthorizationCodeTtlSeconds ??
      DEFAULT_CLI_AUTHORIZATION_CODE_TTL_SECONDS;

    handlers.oauthCliAuthorizationIssueHandler = async (input) => {
      return {
        code: createOAuthCliAuthorizationCode({
          codeChallenge: input.codeChallenge,
          expiresAt: addSeconds(getNow(), codeTtlSeconds),
          port: input.port,
          secret: cliAuthSecret,
          userId: input.userId,
        }),
        expiresInSeconds: codeTtlSeconds,
        outcome: "issued",
      };
    };

    handlers.oauthCliExchangeHandler = async (input) => {
      const invalid = {
        outcome: "auth_failed",
        reason: "invalid_cli_authorization_code",
      } as const;
      const now = getNow();
      const verified = verifyOAuthCliAuthorizationCode(input.code, {
        now,
        secret: cliAuthSecret,
      });
      if (verified.outcome !== "valid") {
        return invalid;
      }

      if (!pkceChallengeMatches(input.codeVerifier, verified.codeChallenge)) {
        return invalid;
      }

      const user = await options.repository.getUserById(
        verified.userId as UserId,
      );
      if (!user) {
        return invalid;
      }

      if (user.status === "disabled") {
        return {
          outcome: "account_disabled",
          reason: "user_disabled",
        };
      }

      // No sign-in grants here: the user approved from an already signed-in
      // dashboard session, so invitation fulfillment and the initial-admin
      // grant ran at that web sign-in. Session bookkeeping mirrors the
      // linked OAuth identity; the "cli" fallback covers the theoretical
      // caller without one (e.g. a PAT-provisioned account driving the
      // issuance endpoint directly).
      return issueSessionForUser(
        user,
        user.oauthProvider ?? "cli",
        user.oauthSubject ?? user.id,
        now,
      );
    };
  }

  return handlers;
}

function createDefaultOAuthSessionHandlerIdGenerator(): OAuthSessionHandlerIdGenerator {
  return {
    createOAuthAccessTokenId() {
      return createRandomPrefixedId("oat") as OAuthAccessTokenId;
    },
    createOAuthSessionId() {
      return createRandomPrefixedId("os") as OAuthSessionId;
    },
    createRefreshTokenId() {
      return createRandomPrefixedId("ort") as RefreshTokenId;
    },
    createUserId() {
      return createRandomPrefixedId("usr") as UserId;
    },
  };
}

function createRandomPrefixedId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

function addDays(date: Date, days: number): Date {
  return addSeconds(date, days * 24 * 60 * 60);
}
