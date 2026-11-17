// TanStack Query bindings for the IAM endpoints.
// Conventions as established in teams.ts: single-field envelopes
// unwrap (`{ roles }` → roles); multi-field ones (invitation outcomes,
// provision) return as-is. Role bindings and invitations are `iam.manage`-
// gated server-side: a 403 `forbidden` from useRoleBindings is EXPECTED for
// viewer/developer members and propagates untouched — useTeamRole
// catches it and falls back to non-IAM role inference. Nothing is caught or
// remapped here. Provisioning and service-account token rotation return the
// show-once plaintext PAT in `token` as mutation data. Both mutations set
// `gcTime: 0`, so the result leaves the mutation cache as soon as the dialog
// that ran it unmounts instead of lingering for the default five minutes.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { TeamInvitationStatus } from "../../model/iam";
import { authenticatedRequest } from "../client";
import type {
  IamInvitationCreateBody,
  IamRoleBindingCreateBody,
  IamRoleBindingUpdateBody,
  IamUserProvisionBody,
  IamUserTokenRotateBody,
} from "../types";
import {
  fromIamUserProvisionWireResponse,
  fromIamUserTokenRotateWireResponse,
  fromInvitationCreateWireResponse,
  fromInvitationWire,
  fromRoleBindingWire,
  fromRoleWire,
  toIamInvitationWireBody,
  toIamRoleBindingUpdateWireBody,
  toIamRoleBindingWireBody,
  toIamUserProvisionWireBody,
  toIamUserTokenRotateWireBody,
  type IamUserProvisionWireResponse,
  type IamUserTokenRotateWireResponse,
  type InvitationCreateWireResponse,
  type InvitationsListWireResponse,
  type RoleBindingCreateWireResponse,
  type RoleBindingsListWireResponse,
  type RolesListWireResponse,
} from "../wire";
import { isSessionEnded } from "./tokens";

/** `status` filter accepted by `GET /v1/iam/invitations`. */
export type InvitationStatusFilter = TeamInvitationStatus | "all";

/** Query keys for the IAM domain, lists scoped by team. */
export const iamKeys = {
  all: ["iam"] as const,
  roles: () => [...iamKeys.all, "roles"] as const,
  roleBindingList: (teamId: string) =>
    [...iamKeys.all, "role-bindings", teamId] as const,
  /** Prefix covering every status tab of one team — mutation invalidation target. */
  invitationLists: (teamId: string) =>
    [...iamKeys.all, "invitations", teamId] as const,
  invitationList: (teamId: string, status: InvitationStatusFilter) =>
    [...iamKeys.invitationLists(teamId), status] as const,
};

/** `GET /v1/iam/roles` (authenticated) — populates role pickers. */
export function useRoles() {
  return useQuery({
    queryKey: iamKeys.roles(),
    queryFn: async ({ signal }) => {
      const { roles } = await authenticatedRequest<RolesListWireResponse>({
        method: "GET",
        path: "/iam/roles",
        signal,
      });
      return roles.map(fromRoleWire);
    },
  });
}

/**
 * `GET /v1/iam/role-bindings?team_id=` (`iam.manage`). 403 `forbidden` is
 * the EXPECTED outcome for non-`iam.manage` members — let it surface; the
 * RBAC hook handles the fallback.
 */
export function useRoleBindings(teamId: string) {
  return useQuery({
    queryKey: iamKeys.roleBindingList(teamId),
    queryFn: async ({ signal }) => {
      const { role_bindings: roleBindings } =
        await authenticatedRequest<RoleBindingsListWireResponse>({
        method: "GET",
        path: `/iam/role-bindings?${new URLSearchParams({ team_id: teamId }).toString()}`,
        signal,
      });
      return roleBindings.map(fromRoleBindingWire);
    },
  });
}

/**
 * `POST /v1/iam/role-bindings` — exactly one of `userId` | `email`
 * (`iam.manage`; 201 created / 200 already existed). A 404 `user_not_found`
 * propagates so the modal can offer Invite or Provision.
 */
export function useAddRoleBinding() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: IamRoleBindingCreateBody) => {
      const { role_binding: roleBinding } =
        await authenticatedRequest<RoleBindingCreateWireResponse>({
        method: "POST",
        path: "/iam/role-bindings",
        body: toIamRoleBindingWireBody(body),
      });
      return fromRoleBindingWire(roleBinding);
    },
    onSuccess: async (_data, { teamId }) => {
      await queryClient.invalidateQueries({
        queryKey: iamKeys.roleBindingList(teamId),
      });
    },
  });
}

/**
 * `PATCH /v1/iam/role-bindings/:bindingId` (`iam.manage`) → 200 with the updated
 * binding. 409 `last-owner` (demoting the sole owner) and 409 `role-binding-exists`
 * (member already holds the target role) propagate to the caller.
 */
export function useUpdateRoleBinding() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: IamRoleBindingUpdateBody) => {
      const { role_binding: roleBinding } =
        await authenticatedRequest<RoleBindingCreateWireResponse>({
        method: "PATCH",
        path: `/iam/role-bindings/${encodeURIComponent(body.bindingId)}`,
        body: toIamRoleBindingUpdateWireBody(body),
      });
      return fromRoleBindingWire(roleBinding);
    },
    onSuccess: async (_data, { teamId }) => {
      await queryClient.invalidateQueries({
        queryKey: iamKeys.roleBindingList(teamId),
      });
    },
  });
}

export interface RemoveRoleBindingVariables {
  bindingId: string;
  /** Needed for list invalidation — `DELETE` returns 204 with no body. */
  teamId: string;
}

/** `DELETE /v1/iam/role-bindings/:bindingId` (`iam.manage`) → 204; 409 `last-owner` propagates. */
export function useRemoveRoleBinding() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ bindingId }: RemoveRoleBindingVariables) =>
      authenticatedRequest<void>({
        method: "DELETE",
        path: `/iam/role-bindings/${encodeURIComponent(bindingId)}`,
      }),
    onSuccess: async (_data, { teamId }) => {
      await queryClient.invalidateQueries({
        queryKey: iamKeys.roleBindingList(teamId),
      });
    },
  });
}

/** `GET /v1/iam/invitations?team_id=&status=` (`iam.manage`) — default `pending`. */
export function useInvitations(
  teamId: string,
  status: InvitationStatusFilter = "pending",
) {
  return useQuery({
    queryKey: iamKeys.invitationList(teamId, status),
    queryFn: async ({ signal }) => {
      const { invitations } = await authenticatedRequest<InvitationsListWireResponse>({
        method: "GET",
        path: `/iam/invitations?${new URLSearchParams({ team_id: teamId, status }).toString()}`,
        signal,
      });
      return invitations.map(fromInvitationWire);
    },
  });
}

/**
 * `POST /v1/iam/invitations` (`iam.manage`) — returns the envelope:
 * discriminate on `outcome` (`pending` | `accepted_existing_user` |
 * `already_granted`). The latter two touch role bindings, so both the team's
 * invitation tabs and its member list are invalidated.
 */
export function useCreateInvitation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: IamInvitationCreateBody) =>
      authenticatedRequest<InvitationCreateWireResponse>({
        method: "POST",
        path: "/iam/invitations",
        body: toIamInvitationWireBody(body),
      }).then(fromInvitationCreateWireResponse),
    onSuccess: async (_data, { teamId }) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: iamKeys.invitationLists(teamId),
        }),
        queryClient.invalidateQueries({
          queryKey: iamKeys.roleBindingList(teamId),
        }),
      ]);
    },
  });
}

export interface RevokeInvitationVariables {
  invitationId: string;
  /** Needed for list invalidation — `DELETE` returns 204 with no body. */
  teamId: string;
}

/** `DELETE /v1/iam/invitations/:invitationId` (`iam.manage`) → 204; pending only — 409 `invitation-not-pending` propagates. */
export function useRevokeInvitation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ invitationId }: RevokeInvitationVariables) =>
      authenticatedRequest<void>({
        method: "DELETE",
        path: `/iam/invitations/${encodeURIComponent(invitationId)}`,
      }),
    onSuccess: async (_data, { teamId }) => {
      await queryClient.invalidateQueries({
        queryKey: iamKeys.invitationLists(teamId),
      });
    },
  });
}

/**
 * `POST /v1/iam/users` (`iam.manage`) — provisions the account, grants
 * the role binding, and mints a personal API token. Returns the envelope:
 * its `token` is the show-once plaintext PAT, surfaced untouched for the
 * secret modal.
 */
export function useProvisionMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: IamUserProvisionBody) =>
      authenticatedRequest<IamUserProvisionWireResponse>({
        method: "POST",
        path: "/iam/users",
        body: toIamUserProvisionWireBody(body),
      }).then(fromIamUserProvisionWireResponse),
    gcTime: 0,
    onSuccess: async (_data, { teamId }) => {
      await queryClient.invalidateQueries({
        queryKey: iamKeys.roleBindingList(teamId),
      });
    },
  });
}

/**
 * `POST /v1/iam/users/:userId/rotate-token` (`iam.manage`, browser session) —
 * replaces a service account's token; its earlier tokens stop working. The
 * envelope's `token` is the show-once plaintext PAT. Nothing cached changes
 * (bindings stay, and the token list is the caller's own), so nothing is
 * invalidated. A 401 means the admin's sign-in ended before the rotation (the
 * server rolled it back) and the client has cleared the session, so the route
 * guard unmounts the page: `onSessionEnded` runs here, where it survives
 * that, as in useRevokeAllCredentials. Other problems propagate.
 */
export function useRotateServiceAccountToken(callbacks: {
  onSessionEnded: () => void;
}) {
  return useMutation({
    mutationFn: (body: IamUserTokenRotateBody) =>
      authenticatedRequest<IamUserTokenRotateWireResponse>({
        method: "POST",
        path: `/iam/users/${encodeURIComponent(body.userId)}/rotate-token`,
        body: toIamUserTokenRotateWireBody(body),
      }).then(fromIamUserTokenRotateWireResponse),
    gcTime: 0,
    onError: (error) => {
      if (isSessionEnded(error)) {
        callbacks.onSessionEnded();
      }
    },
  });
}
