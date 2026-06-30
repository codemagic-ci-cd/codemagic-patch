// Wire-shape DTOs derived from server/src/domain/types.ts @ 25b9477
// The IAM endpoints do NOT emit the raw domain entities: they emit the route
// models defined in server/src/app/types.ts (IamRoleRouteModel,
// IamRoleBindingRouteModel, IamInvitationRouteModel) with nested user/role/
// scope objects. These mirror those wire shapes (Date → ISO string).

import type { ControlPlaneAction } from "./permissions";

/** Nested role reference emitted inside role bindings and invitations. */
export interface RoleRef {
  id: string;
  key: string;
  displayName: string;
}

/** Wire shape of `GET /v1/iam/roles` elements (server `IamRoleRouteModel`). */
export interface RoleDefinition {
  id: string;
  key: string;
  displayName: string;
  isSystem: boolean;
  permissions: ControlPlaneAction[];
}

/** Wire shape of `GET /v1/iam/role-bindings` elements (server `IamRoleBindingRouteModel`). */
export interface RoleBinding {
  id: string;
  principalType: "user";
  user: {
    id: string;
    email: string;
    displayName: string | null;
  };
  role: RoleRef;
  scope: {
    type: "team";
    id: string;
  };
  createdAt: string;
  createdBy: string | null;
}

export type TeamInvitationStatus =
  | "pending"
  | "accepted"
  | "revoked"
  | "expired";

/** Wire shape of `GET /v1/iam/invitations` elements (server `IamInvitationRouteModel`). */
export interface TeamInvitation {
  id: string;
  teamId: string;
  // Exactly one is set: email for email invites, githubHandle for handle invites.
  email: string | null;
  githubHandle: string | null;
  role: RoleRef;
  status: TeamInvitationStatus;
  createdAt: string;
  expiresAt: string;
  createdBy: string;
  acceptedAt: string | null;
  acceptedBy: string | null;
  roleBindingId: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
}
