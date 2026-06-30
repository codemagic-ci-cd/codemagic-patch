import { randomUUID } from "node:crypto";

import type {
  AuthNAdapter,
  OAuthProviderIdentity,
} from "./authNAdapter";
import type { OAuthDeviceAuthAdapter } from "./githubDeviceAuthAdapter";
import type {
  OAuthAccessTokenId,
  OAuthSessionId,
  RefreshTokenId,
  UserId,
} from "../domain";
import type { AuthRepository } from "../repositories";
import type {
  OAuthCallbackRouteHandler,
  OAuthDevicePollRouteHandler,
  OAuthDeviceStartRouteHandler,
  OAuthLogoutRouteHandler,
  OAuthRefreshRouteHandler,
  OAuthSessionCreatedHandlerResult,
  PublicAuthAuditContext,
} from "./types";
import {
  createOAuthDevicePollToken,
  verifyOAuthDevicePollToken,
} from "./oauthDevicePollToken";
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

export interface CreateOAuthSessionRouteHandlersOptions {
  accessTokenTtlSeconds: number;
  authNAdapter?: AuthNAdapter;
  deviceAuthAdapter?: OAuthDeviceAuthAdapter;
  idGenerator?: OAuthSessionHandlerIdGenerator;
  initialAdminEmails?: string[];
  initialAdminTeamMembershipService?: OAuthInitialAdminTeamMembershipService;
  invitationFulfillmentService?: OAuthInvitationFulfillmentService;
  logger?: {
    warn(message: string, error?: unknown): void;
  };
  now?: () => Date;
  pollTokenSecret?: string;
  refreshTokenTtlDays: number;
  registrationMode: "invite_only" | "open";
  repository: AuthRepository;
}

export interface OAuthSessionRouteHandlers {
  oauthCallbackHandler?: OAuthCallbackRouteHandler;
  oauthDevicePollHandler?: OAuthDevicePollRouteHandler;
  oauthDeviceStartHandler?: OAuthDeviceStartRouteHandler;
  oauthLogoutHandler: OAuthLogoutRouteHandler;
  oauthRefreshHandler: OAuthRefreshRouteHandler;
}

type OAuthSessionIdentityResult<
  TUnverifiedEmailReason extends "unverified_email" | "verified_email_required",
> =
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
      reason: TUnverifiedEmailReason;
    };

export function createOAuthSessionRouteHandlers(
  options: CreateOAuthSessionRouteHandlersOptions,
): OAuthSessionRouteHandlers {
  const idGenerator =
    options.idGenerator ?? createDefaultOAuthSessionHandlerIdGenerator();
  const getNow = options.now ?? (() => new Date());
  const createSessionFromIdentity = async <
    TUnverifiedEmailReason extends
      | "unverified_email"
      | "verified_email_required",
  >(
    identity: OAuthProviderIdentity,
    unverifiedEmailReason: TUnverifiedEmailReason,
    auditContext?: PublicAuthAuditContext,
  ): Promise<OAuthSessionIdentityResult<TUnverifiedEmailReason>> => {
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
        reason: unverifiedEmailReason,
      };
    }

    if (resolved.user.status === "disabled") {
      return {
        outcome: "account_disabled",
        reason: "user_disabled",
      };
    }

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
      provider: identity.provider,
      refreshToken: {
        expiresAt: refreshTokenExpiresAt,
        id: idGenerator.createRefreshTokenId(),
        tokenHash: refreshToken.tokenHash,
      },
      sessionId: idGenerator.createOAuthSessionId(),
      subject: identity.subject,
      userId: resolved.user.id,
    });

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

    return {
      accessToken: accessToken.token,
      accessTokenExpiresAt,
      outcome: "created",
      refreshToken: refreshToken.token,
      refreshTokenExpiresAt,
      user: {
        createdAt: resolved.user.createdAt,
        displayName: resolved.user.displayName,
        email: resolved.user.email,
        id: resolved.user.id,
      },
    };
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

      return createSessionFromIdentity(
        exchanged.identity,
        "unverified_email",
        input.auditContext,
      );
    };
  }

  if (options.deviceAuthAdapter && options.pollTokenSecret) {
    const deviceAuthAdapter = options.deviceAuthAdapter;
    const pollTokenSecret = options.pollTokenSecret;

    handlers.oauthDeviceStartHandler = async (input) => {
      const started = await deviceAuthAdapter.startDeviceAuthorization(input);
      if (started.outcome === "unknown_provider") {
        return {
          outcome: "auth_failed",
          reason: "unknown_provider",
        };
      }

      if (started.outcome === "provider_error") {
        return {
          outcome: "auth_failed",
          reason: "provider_error",
        };
      }

      const pollToken = createOAuthDevicePollToken({
        deviceCode: started.deviceCode,
        expiresAt: addSeconds(getNow(), started.expiresInSeconds),
        intervalSeconds: started.intervalSeconds,
        provider: started.provider,
        secret: pollTokenSecret,
      });

      return {
        expiresInSeconds: started.expiresInSeconds,
        intervalSeconds: started.intervalSeconds,
        outcome: "started",
        pollToken,
        provider: started.provider,
        userCode: started.userCode,
        verificationUri: started.verificationUri,
      };
    };

    handlers.oauthDevicePollHandler = async (input) => {
      const verifiedPollToken = verifyOAuthDevicePollToken(input.pollToken, {
        expectedProvider: input.provider,
        now: getNow(),
        secret: pollTokenSecret,
      });
      if (verifiedPollToken.outcome !== "valid") {
        return {
          outcome: "auth_failed",
          reason: "invalid_poll_token",
        };
      }

      const polled = await deviceAuthAdapter.pollDeviceAuthorization({
        deviceCode: verifiedPollToken.deviceCode,
        intervalSeconds: verifiedPollToken.intervalSeconds,
        provider: input.provider,
      });

      if (polled.outcome === "authorization_pending") {
        return {
          intervalSeconds: polled.intervalSeconds,
          outcome: "authorization_pending",
        };
      }

      if (polled.outcome === "slow_down") {
        return {
          intervalSeconds: polled.intervalSeconds,
          outcome: "slow_down",
        };
      }

      if (polled.outcome === "success") {
        return createSessionFromIdentity(
          polled.identity,
          "verified_email_required",
          input.auditContext,
        );
      }

      if (polled.outcome === "provider_error") {
        return {
          outcome: "auth_failed",
          reason: "provider_error",
        };
      }

      return {
        outcome: "auth_failed",
        reason: polled.outcome,
      };
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
