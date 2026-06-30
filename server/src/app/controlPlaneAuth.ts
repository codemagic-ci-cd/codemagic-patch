import type { FastifyRequest } from "fastify";

import { hashApiToken } from "./apiToken";
import { hashOAuthAccessToken } from "./oauthToken";
import type { AuthRepository } from "../repositories";

export type ControlPlanePrincipal =
  | {
      kind: "user";
      userId: string;
    }
  | {
      kind: "api-token";
      tokenId: string;
      userId: string;
    };

export type ControlPlaneAuthResult =
  | {
      outcome: "authenticated";
      principal: ControlPlanePrincipal;
    }
  | {
      outcome: "forbidden";
      reason: "account_disabled";
    }
  | {
      outcome: "unauthenticated";
      reason: "invalid" | "missing";
    };

export interface ControlPlaneAuthHandler {
  (
    request: FastifyRequest,
  ): Promise<ControlPlaneAuthResult> | ControlPlaneAuthResult;
}

export function createDbApiTokenControlPlaneAuth(
  authRepository: AuthRepository,
  now: () => Date = () => new Date(),
): ControlPlaneAuthHandler {
  return async (request) => {
    const parsed = parseBearerAuthorization(request.headers.authorization);
    if (!("token" in parsed)) {
      return {
        outcome: "unauthenticated",
        reason: parsed.reason,
      };
    }

    const timestamp = now();
    const resolved = await authRepository.resolveApiTokenHash(
      hashApiToken(parsed.token),
      timestamp,
    );

    if (resolved.outcome === "expired") {
      return {
        outcome: "unauthenticated",
        reason: "invalid",
      };
    }

    if (resolved.outcome === "user_disabled") {
      return {
        outcome: "forbidden",
        reason: "account_disabled",
      };
    }

    if (resolved.outcome === "found") {
      await authRepository
        .updateApiTokenLastUsedAt(resolved.token.id, timestamp)
        .catch(() => undefined);

      return {
        outcome: "authenticated",
        principal: {
          kind: "api-token",
          tokenId: resolved.token.id,
          userId: resolved.user.id,
        },
      };
    }

    const oauthResolved = await authRepository.resolveOAuthAccessTokenHash(
      hashOAuthAccessToken(parsed.token),
      timestamp,
    );

    if (
      oauthResolved.outcome === "not_found" ||
      oauthResolved.outcome === "expired" ||
      oauthResolved.outcome === "revoked" ||
      oauthResolved.outcome === "session_revoked"
    ) {
      return {
        outcome: "unauthenticated",
        reason: "invalid",
      };
    }

    if (oauthResolved.outcome === "user_disabled") {
      return {
        outcome: "forbidden",
        reason: "account_disabled",
      };
    }

    await authRepository
      .updateOAuthAccessTokenLastUsedAt(oauthResolved.token.id, timestamp)
      .catch(() => undefined);

    return {
      outcome: "authenticated",
      principal: {
        kind: "user",
        userId: oauthResolved.user.id,
      },
    };
  };
}

function parseBearerAuthorization(
  authorization: string | string[] | undefined,
):
  | {
      reason: "missing";
    }
  | {
      reason: "invalid";
    }
  | {
      token: string;
    } {
  if (authorization === undefined) {
    return { reason: "missing" };
  }

  if (typeof authorization !== "string") {
    return { reason: "invalid" };
  }

  const parts = authorization.trim().split(/\s+/);
  if (parts.length !== 2) {
    return { reason: "invalid" };
  }

  const [scheme, token] = parts;
  if (scheme.toLowerCase() !== "bearer" || token.length === 0) {
    return { reason: "invalid" };
  }

  return { token };
}

declare module "fastify" {
  interface FastifyRequest {
    controlPlanePrincipal?: ControlPlanePrincipal;
  }
}
