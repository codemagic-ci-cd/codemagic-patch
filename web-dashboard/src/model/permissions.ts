// Wire-shape DTOs derived from server/src/domain/types.ts @ 25b9477
// Role→permission matrix mirrors the server seeds in
// server/src/db/migrations/0002_controlPlaneAuth.ts (+0007 adds app.manage to
// admin/owner) and the RBAC visibility matrix. The server stays the final
// authority — this matrix only drives UI gating.

export type Role = "viewer" | "developer" | "admin" | "owner";

export type ControlPlaneAction =
  | "team.read"
  | "app.read"
  | "app.create"
  | "app.manage"
  | "release.view"
  | "release.deploy"
  | "iam.manage";

const VIEWER_ACTIONS: readonly ControlPlaneAction[] = [
  "team.read",
  "app.read",
  "release.view",
];

const DEVELOPER_ACTIONS: readonly ControlPlaneAction[] = [
  ...VIEWER_ACTIONS,
  "release.deploy",
];

const ADMIN_ACTIONS: readonly ControlPlaneAction[] = [
  ...DEVELOPER_ACTIONS,
  "app.create",
  "app.manage",
  "iam.manage",
];

const ROLE_ACTIONS: Record<Role, ReadonlySet<ControlPlaneAction>> = {
  viewer: new Set(VIEWER_ACTIONS),
  developer: new Set(DEVELOPER_ACTIONS),
  admin: new Set(ADMIN_ACTIONS),
  owner: new Set(ADMIN_ACTIONS),
};

export function can(role: Role, action: ControlPlaneAction): boolean {
  return ROLE_ACTIONS[role].has(action);
}
