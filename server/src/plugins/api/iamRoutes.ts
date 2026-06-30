import type { FastifyInstance } from "fastify";

import { createProblem, sendProblem } from "../../app/problemDetails";
import {
  createInvitationNotFoundProblem,
  createRoleBindingNotFoundProblem,
  parseIamInvitationCreateInput,
  parseIamInvitationListInput,
  parseIamRoleBindingCreateInput,
  parseIamRoleBindingListInput,
  parseIamUserProvisionInput,
  prepareIamInvitationCreateResponse,
  prepareIamInvitationRevokeResponse,
  prepareIamRoleBindingCreateResponse,
  prepareIamRoleBindingDeleteResponse,
  prepareIamUserProvisionResponse,
} from "./iamSupport";
import {
  authorizeVisibleResourceAccess,
  createTeamNotFoundProblem,
  requireControlPlanePrincipal,
  sendPreparedJsonResponse,
  writeAuditEventIfConfigured,
} from "./routeSupport";
import type {
  ApiRoutesOptions,
  IamInvitationBody,
  IamInvitationListQuery,
  IamInvitationParams,
  IamRoleBindingBody,
  IamRoleBindingListQuery,
  IamRoleBindingParams,
  IamUserProvisionBody,
} from "./routeTypes";
import {
  toInvitationWire,
  toRoleBindingWire,
  toRoleWire,
} from "./wireSerializers";

export function registerIamRoutes(
  controlPlane: FastifyInstance,
  options: ApiRoutesOptions,
): void {
  controlPlane.get("/iam/roles", async (request, reply) => {
    if (!options.iamRoleListHandler) {
      return sendProblem(
        reply,
        createProblem({
          detail: "IAM role listing is not implemented",
          status: 501,
        }),
      );
    }

    const result = await options.iamRoleListHandler();
    return {
      roles: result.roles.map(toRoleWire),
    };
  });

  controlPlane.get<{ Querystring: IamRoleBindingListQuery }>(
    "/iam/role-bindings",
    async (request, reply) => {
      if (!options.iamRoleBindingListHandler) {
        return sendProblem(
          reply,
          createProblem({
            detail: "IAM role binding listing is not implemented",
            status: 501,
          }),
        );
      }

      const input = parseIamRoleBindingListInput(request.query);
      if (input.kind === "error") {
        return sendProblem(reply, input.problem);
      }

      const authorization = await authorizeVisibleResourceAccess(
        options.authorizationService,
        request.controlPlanePrincipal,
        "iam.manage",
        () =>
          options.authorizationService!.resolveTeamScope(
            input.value.teamId,
          ),
        createTeamNotFoundProblem({
          outcome: "not_found",
          reason: "team_not_found",
        }),
      );
      if (authorization.kind === "error") {
        return sendProblem(reply, authorization.problem);
      }

      const result = await options.iamRoleBindingListHandler(
        input.value.teamId,
      );

      if (result.outcome === "found") {
        return {
          role_bindings: result.roleBindings.map(toRoleBindingWire),
        };
      }

      return sendProblem(reply, createTeamNotFoundProblem(result));
    },
  );

  controlPlane.post<{ Body: IamRoleBindingBody }>(
    "/iam/role-bindings",
    async (request, reply) => {
      const principal = requireControlPlanePrincipal(request);

      if (!options.iamRoleBindingCreateHandler) {
        return sendProblem(
          reply,
          createProblem({
            detail: "IAM role binding creation is not implemented",
            status: 501,
          }),
        );
      }

      const input = parseIamRoleBindingCreateInput(
        request.body,
        principal.userId,
      );
      if (input.kind === "error") {
        return sendProblem(reply, input.problem);
      }

      const authorization = await authorizeVisibleResourceAccess(
        options.authorizationService,
        request.controlPlanePrincipal,
        "iam.manage",
        () =>
          options.authorizationService!.resolveTeamScope(
            input.value.teamId,
          ),
        createTeamNotFoundProblem({
          outcome: "not_found",
          reason: "team_not_found",
        }),
      );
      if (authorization.kind === "error") {
        return sendProblem(reply, authorization.problem);
      }

      const result = await options.iamRoleBindingCreateHandler(input.value);
      if (result.outcome === "created") {
        await writeAuditEventIfConfigured(
          options.auditEventWriteHandler,
          request,
          {
            action: "iam.role_binding.created",
            afterState: {
              ...result.roleBinding,
              membershipCreated: result.membershipCreated,
            } as unknown as Record<string, unknown>,
            beforeState: null,
            resourceId: result.roleBinding.id,
            resourceType: "role_binding",
            result: "success",
            teamId: result.roleBinding.scope.id,
          },
        );
      }

      return sendPreparedJsonResponse(
        reply,
        prepareIamRoleBindingCreateResponse(result),
      );
    },
  );

  controlPlane.post<{ Body: IamUserProvisionBody }>(
    "/iam/users",
    async (request, reply) => {
      const principal = requireControlPlanePrincipal(request);

      if (!options.iamUserProvisionHandler) {
        return sendProblem(
          reply,
          createProblem({
            detail: "IAM user provisioning is not implemented",
            status: 501,
          }),
        );
      }

      const input = parseIamUserProvisionInput(request.body, principal.userId);
      if (input.kind === "error") {
        return sendProblem(reply, input.problem);
      }

      const authorization = await authorizeVisibleResourceAccess(
        options.authorizationService,
        request.controlPlanePrincipal,
        "iam.manage",
        () =>
          options.authorizationService!.resolveTeamScope(input.value.teamId),
        createTeamNotFoundProblem({
          outcome: "not_found",
          reason: "team_not_found",
        }),
      );
      if (authorization.kind === "error") {
        return sendProblem(reply, authorization.problem);
      }

      const result = await options.iamUserProvisionHandler(input.value);
      if (result.outcome === "provisioned") {
        await writeAuditEventIfConfigured(
          options.auditEventWriteHandler,
          request,
          {
            action: "iam.user.provisioned",
            afterState: {
              apiTokenId: result.apiToken.id,
              roleBindingId: result.roleBinding.id,
              userCreated: result.user.created,
              userId: result.user.id,
            },
            beforeState: null,
            resourceId: result.user.id,
            resourceType: "user",
            result: "success",
            teamId: result.roleBinding.scope.id,
          },
        );
      }

      return sendPreparedJsonResponse(
        reply,
        prepareIamUserProvisionResponse(result),
      );
    },
  );

  controlPlane.get<{ Querystring: IamInvitationListQuery }>(
    "/iam/invitations",
    async (request, reply) => {
      if (!options.iamInvitationListHandler) {
        return sendProblem(
          reply,
          createProblem({
            detail: "IAM invitation listing is not implemented",
            status: 501,
          }),
        );
      }

      const input = parseIamInvitationListInput(request.query);
      if (input.kind === "error") {
        return sendProblem(reply, input.problem);
      }

      const authorization = await authorizeVisibleResourceAccess(
        options.authorizationService,
        request.controlPlanePrincipal,
        "iam.manage",
        () =>
          options.authorizationService!.resolveTeamScope(
            input.value.teamId,
          ),
        createTeamNotFoundProblem({
          outcome: "not_found",
          reason: "team_not_found",
        }),
      );
      if (authorization.kind === "error") {
        return sendProblem(reply, authorization.problem);
      }

      const result = await options.iamInvitationListHandler(
        input.value.teamId,
        input.value.status,
      );

      if (result.outcome === "found") {
        return {
          invitations: result.invitations.map(toInvitationWire),
        };
      }

      return sendProblem(reply, createTeamNotFoundProblem(result));
    },
  );

  controlPlane.post<{ Body: IamInvitationBody }>(
    "/iam/invitations",
    async (request, reply) => {
      const principal = requireControlPlanePrincipal(request);

      if (!options.iamInvitationCreateHandler) {
        return sendProblem(
          reply,
          createProblem({
            detail: "IAM invitation creation is not implemented",
            status: 501,
          }),
        );
      }

      const input = parseIamInvitationCreateInput(
        request.body,
        principal.userId,
      );
      if (input.kind === "error") {
        return sendProblem(reply, input.problem);
      }

      const authorization = await authorizeVisibleResourceAccess(
        options.authorizationService,
        request.controlPlanePrincipal,
        "iam.manage",
        () =>
          options.authorizationService!.resolveTeamScope(
            input.value.teamId,
          ),
        createTeamNotFoundProblem({
          outcome: "not_found",
          reason: "team_not_found",
        }),
      );
      if (authorization.kind === "error") {
        return sendProblem(reply, authorization.problem);
      }

      const result = await options.iamInvitationCreateHandler(input.value);
      if (result.outcome === "pending" && result.created) {
        await writeAuditEventIfConfigured(
          options.auditEventWriteHandler,
          request,
          {
            action: "iam.invitation.created",
            afterState: result.invitation as unknown as Record<
              string,
              unknown
            >,
            beforeState: null,
            resourceId: result.invitation.id,
            resourceType: "team_invitation",
            result: "success",
            teamId: result.invitation.teamId,
          },
        );
      }

      return sendPreparedJsonResponse(
        reply,
        prepareIamInvitationCreateResponse(result),
      );
    },
  );

  controlPlane.delete<{ Params: IamRoleBindingParams }>(
    "/iam/role-bindings/:bindingId",
    async (request, reply) => {
      if (
        !options.iamRoleBindingReadHandler ||
        !options.iamRoleBindingDeleteHandler
      ) {
        return sendProblem(
          reply,
          createProblem({
            detail: "IAM role binding deletion is not implemented",
            status: 501,
          }),
        );
      }

      const existing = await options.iamRoleBindingReadHandler(
        request.params.bindingId,
      );
      if (existing.outcome === "not_found") {
        return sendProblem(reply, createRoleBindingNotFoundProblem());
      }

      const authorization = await authorizeVisibleResourceAccess(
        options.authorizationService,
        request.controlPlanePrincipal,
        "iam.manage",
        () =>
          options.authorizationService!.resolveTeamScope(
            existing.roleBinding.scope.id,
          ),
        createRoleBindingNotFoundProblem(),
        createRoleBindingNotFoundProblem(),
      );
      if (authorization.kind === "error") {
        return sendProblem(reply, authorization.problem);
      }

      const result = await options.iamRoleBindingDeleteHandler(
        request.params.bindingId,
      );
      if (result.outcome === "deleted") {
        await writeAuditEventIfConfigured(
          options.auditEventWriteHandler,
          request,
          {
            action: "iam.role_binding.deleted",
            afterState: null,
            beforeState: {
              ...result.roleBinding,
              membershipRemoved: result.membershipRemoved,
            } as unknown as Record<string, unknown>,
            resourceId: result.roleBinding.id,
            resourceType: "role_binding",
            result: "success",
            teamId: result.roleBinding.scope.id,
          },
        );
      }

      return sendPreparedJsonResponse(
        reply,
        prepareIamRoleBindingDeleteResponse(result),
      );
    },
  );

  controlPlane.delete<{ Params: IamInvitationParams }>(
    "/iam/invitations/:invitationId",
    async (request, reply) => {
      const principal = requireControlPlanePrincipal(request);

      if (
        !options.iamInvitationReadHandler ||
        !options.iamInvitationRevokeHandler
      ) {
        return sendProblem(
          reply,
          createProblem({
            detail: "IAM invitation revocation is not implemented",
            status: 501,
          }),
        );
      }

      const existing = await options.iamInvitationReadHandler(
        request.params.invitationId,
      );
      if (existing.outcome === "not_found") {
        return sendProblem(reply, createInvitationNotFoundProblem());
      }

      const authorization = await authorizeVisibleResourceAccess(
        options.authorizationService,
        request.controlPlanePrincipal,
        "iam.manage",
        () =>
          options.authorizationService!.resolveTeamScope(
            existing.invitation.teamId,
          ),
        createInvitationNotFoundProblem(),
        createInvitationNotFoundProblem(),
      );
      if (authorization.kind === "error") {
        return sendProblem(reply, authorization.problem);
      }

      const result = await options.iamInvitationRevokeHandler(
        request.params.invitationId,
        principal.userId,
      );
      if (result.outcome === "revoked") {
        await writeAuditEventIfConfigured(
          options.auditEventWriteHandler,
          request,
          {
            action: "iam.invitation.revoked",
            afterState: result.invitation as unknown as Record<
              string,
              unknown
            >,
            beforeState: existing.invitation as unknown as Record<
              string,
              unknown
            >,
            resourceId: result.invitation.id,
            resourceType: "team_invitation",
            result: "success",
            teamId: result.invitation.teamId,
          },
        );
      }

      return sendPreparedJsonResponse(
        reply,
        prepareIamInvitationRevokeResponse(result),
      );
    },
  );
}
