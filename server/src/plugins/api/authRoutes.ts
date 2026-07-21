import type { FastifyInstance } from "fastify";

import { createProblem, sendProblem } from "../../app/problemDetails";
import {
  createAuthenticationRequiredProblem,
  createOAuthAuthFailedProblem,
  createOAuthCliExchangeFailedProblem,
  createRegistrationClosedProblem,
  parseApiTokenCreateInput,
  parseOAuthCallbackInput,
  parseOAuthCliAuthorizationIssueInput,
  parseOAuthCliExchangeInput,
  parseOAuthRefreshTokenInput,
  publicAuthAuditContextFromRequest,
} from "./authSupport";
import {
  createAccountDisabledProblem,
  requireControlPlanePrincipal,
} from "./routeSupport";
import type {
  ApiRoutesOptions,
  ApiTokenCreateBody,
  ApiTokenParams,
  OAuthCallbackBody,
  OAuthCliAuthorizationIssueBody,
  OAuthCliExchangeBody,
  OAuthRefreshBody,
} from "./routeTypes";
import {
  toApiTokenWire,
  toOAuthCliAuthorizationWire,
  toOAuthRefreshWire,
  toOAuthSessionWire,
  toOAuthWebConfigWire,
  toUserWire,
} from "./wireSerializers";

export function registerPublicAuthRoutes(
  app: FastifyInstance,
  options: ApiRoutesOptions,
): void {
  app.get("/v1/auth/oauth/web-config", async (_request, reply) => {
    if (!options.oauthWebConfig) {
      // Deliberately no typeSuffix: the about:blank 404 lets clients
      // distinguish "web OAuth unconfigured" from a resource not-found.
      return sendProblem(
        reply,
        createProblem({
          detail: "web OAuth is not configured",
          status: 404,
        }),
      );
    }

    return toOAuthWebConfigWire(options.oauthWebConfig);
  });

  app.post<{ Body: OAuthCallbackBody }>(
    "/v1/auth/oauth/callback",
    async (request, reply) => {
      if (!options.oauthCallbackHandler) {
        return sendProblem(
          reply,
          createProblem({
            detail: "OAuth callback is not implemented",
            status: 501,
          }),
        );
      }

      const input = parseOAuthCallbackInput(request.body);
      if (input.kind === "error") {
        return sendProblem(reply, input.problem);
      }

      const result = await options.oauthCallbackHandler({
        ...input.value,
        auditContext: publicAuthAuditContextFromRequest(request),
      });
      if (result.outcome === "created") {
        return toOAuthSessionWire(result);
      }

      if (result.outcome === "conflict") {
        return sendProblem(
          reply,
          createProblem({
            detail: "OAuth identity is already linked to another user",
            extensions: {
              outcome: result.outcome,
              reason: result.reason,
            },
            status: 409,
          }),
        );
      }

      if (result.outcome === "account_disabled") {
        return sendProblem(reply, createAccountDisabledProblem(result.reason));
      }

      if (result.outcome === "registration_closed") {
        return sendProblem(reply, createRegistrationClosedProblem());
      }

      return sendProblem(
        reply,
        createOAuthAuthFailedProblem(result.reason),
      );
    },
  );

  app.post<{ Body: OAuthCliExchangeBody }>(
    "/v1/auth/oauth/cli/exchange",
    async (request, reply) => {
      if (!options.oauthCliExchangeHandler) {
        return sendProblem(
          reply,
          createProblem({
            detail: "CLI browser login is not configured",
            status: 501,
          }),
        );
      }

      const input = parseOAuthCliExchangeInput(request.body);
      if (input.kind === "error") {
        return sendProblem(reply, input.problem);
      }

      const result = await options.oauthCliExchangeHandler({
        ...input.value,
        auditContext: publicAuthAuditContextFromRequest(request),
      });
      if (result.outcome === "created") {
        return toOAuthSessionWire(result);
      }

      if (result.outcome === "account_disabled") {
        return sendProblem(reply, createAccountDisabledProblem(result.reason));
      }

      if (result.outcome === "auth_failed") {
        return sendProblem(reply, createOAuthCliExchangeFailedProblem());
      }

      return result satisfies never;
    },
  );

  // The OAuth device flow no longer exists; only the 501 stubs remain because
  // pre-loopback CLIs recognize exactly this status as "device login
  // unsupported" and fall back to token login on their own.
  for (const deviceRoute of [
    "/v1/auth/oauth/device/start",
    "/v1/auth/oauth/device/poll",
  ]) {
    app.post(deviceRoute, async (_request, reply) => {
      return sendProblem(
        reply,
        createProblem({
          detail:
            "The OAuth device flow has been removed — upgrade the codemagic-patch CLI (its `cmpatch login` signs in through the browser) or use `cmpatch login --token`",
          status: 501,
        }),
      );
    });
  }

  app.post<{ Body: OAuthRefreshBody }>(
    "/v1/auth/refresh",
    async (request, reply) => {
      if (!options.oauthRefreshHandler) {
        return sendProblem(
          reply,
          createProblem({
            detail: "OAuth session refresh is not implemented",
            status: 501,
          }),
        );
      }

      const input = parseOAuthRefreshTokenInput(request.body);
      if (input.kind === "error") {
        return sendProblem(reply, input.problem);
      }

      const result = await options.oauthRefreshHandler(input.value);
      if (result.outcome === "rotated") {
        return toOAuthRefreshWire(result);
      }

      if (result.outcome === "account_disabled") {
        return sendProblem(reply, createAccountDisabledProblem(result.reason));
      }

      return sendProblem(reply, createAuthenticationRequiredProblem());
    },
  );

  app.post<{ Body: OAuthRefreshBody }>(
    "/v1/auth/logout",
    async (request, reply) => {
      if (!options.oauthLogoutHandler) {
        return sendProblem(
          reply,
          createProblem({
            detail: "OAuth session logout is not implemented",
            status: 501,
          }),
        );
      }

      const input = parseOAuthRefreshTokenInput(request.body);
      if (input.kind === "error") {
        return sendProblem(reply, input.problem);
      }

      await options.oauthLogoutHandler(input.value);
      reply.status(204);
      return undefined;
    },
  );
}

export function registerControlPlaneAuthRoutes(
  controlPlane: FastifyInstance,
  options: ApiRoutesOptions,
): void {
  controlPlane.get("/users/me", async (request, reply) => {
    const principal = requireControlPlanePrincipal(request);

    if (!options.userProfileHandler) {
      return sendProblem(
        reply,
        createProblem({
          detail: "user profile lookup is not implemented",
          status: 501,
        }),
      );
    }

    const result = await options.userProfileHandler(principal.userId);
    if (result.outcome === "found") {
      return {
        user: toUserWire(result.user),
      };
    }

    return sendProblem(
      reply,
      createProblem({
        detail: "user was not found",
        extensions: {
          outcome: result.outcome,
          reason: result.reason,
        },
        status: 404,
        typeSuffix: "not-found",
      }),
    );
  });

  controlPlane.post<{ Body: OAuthCliAuthorizationIssueBody }>(
    "/auth/cli/authorizations",
    async (request, reply) => {
      const principal = requireControlPlanePrincipal(request);

      if (!options.oauthCliAuthorizationIssueHandler) {
        return sendProblem(
          reply,
          createProblem({
            detail: "CLI browser login is not configured",
            status: 501,
          }),
        );
      }

      const input = parseOAuthCliAuthorizationIssueInput(request.body);
      if (input.kind === "error") {
        return sendProblem(reply, input.problem);
      }

      const result = await options.oauthCliAuthorizationIssueHandler({
        ...input.value,
        userId: principal.userId,
      });

      reply.status(201);
      return toOAuthCliAuthorizationWire(result);
    },
  );

  controlPlane.post<{ Body: ApiTokenCreateBody }>(
    "/auth/tokens",
    async (request, reply) => {
      const principal = requireControlPlanePrincipal(request);

      if (!options.apiTokenCreateHandler) {
        return sendProblem(
          reply,
          createProblem({
            detail: "api token creation is not implemented",
            status: 501,
          }),
        );
      }

      const input = parseApiTokenCreateInput(request.body, principal.userId);
      if (input.kind === "error") {
        return sendProblem(reply, input.problem);
      }

      const result = await options.apiTokenCreateHandler(input.value);

      reply.status(201);
      return {
        api_token: toApiTokenWire(result.apiToken),
        token: result.plaintextToken,
      };
    },
  );

  controlPlane.get("/auth/tokens", async (request, reply) => {
    const principal = requireControlPlanePrincipal(request);

    if (!options.apiTokenListHandler) {
      return sendProblem(
        reply,
        createProblem({
          detail: "api token listing is not implemented",
          status: 501,
        }),
      );
    }

    const result = await options.apiTokenListHandler(principal.userId);
    return {
      api_tokens: result.apiTokens.map(toApiTokenWire),
    };
  });

  controlPlane.delete<{ Params: ApiTokenParams }>(
    "/auth/tokens/:tokenId",
    async (request, reply) => {
      const principal = requireControlPlanePrincipal(request);

      if (!options.apiTokenDeleteHandler) {
        return sendProblem(
          reply,
          createProblem({
            detail: "api token deletion is not implemented",
            status: 501,
          }),
        );
      }

      const result = await options.apiTokenDeleteHandler(
        principal.userId,
        request.params.tokenId,
      );

      if (result.outcome === "deleted") {
        reply.status(204);
        return reply.send();
      }

      return sendProblem(
        reply,
        createProblem({
          detail: "api token was not found",
          status: 404,
          typeSuffix: "not-found",
        }),
      );
    },
  );
}
