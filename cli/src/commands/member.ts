import type {
  MemberAddCommand,
  MemberInviteCommand,
  MemberInviteListCommand,
  MemberInviteRevokeCommand,
  MemberListCommand,
  MemberProvisionCommand,
  MemberRemoveCommand,
  MemberUserSelector,
} from "../commandTypes";
import { authenticatedRequest } from "../authenticatedRequest";
import { isRecord } from "../output";
import {
  buildApiUrl,
  buildApiUrlWithQuery,
  type CommandDeps,
  UsageError,
} from "./shared";
import { resolveTeamId } from "./resolveNames";

type Role = {
  id: string;
  key: string;
};

type RoleBinding = {
  id: string;
  role: {
    id?: string;
    key: string;
  };
  user: {
    email?: string;
    id: string;
  };
};

export async function executeMemberList(
  command: MemberListCommand,
  deps: CommandDeps,
): Promise<unknown> {
  const teamId = await resolveTeamId(
    command.team,
    command.serverUrl,
    command.token,
    deps,
  );

  return authenticatedRequest(deps, {
    init: {
      method: "GET",
    },
    serverUrl: command.serverUrl,
    token: command.token,
    url: buildApiUrlWithQuery(command.serverUrl, "/v1/iam/role-bindings", {
      team_id: teamId,
    }),
  });
}

export async function executeMemberAdd(
  command: MemberAddCommand,
  deps: CommandDeps,
): Promise<unknown> {
  const teamId = await resolveTeamId(
    command.team,
    command.serverUrl,
    command.token,
    deps,
  );
  const roleId = await resolveRoleId(
    command.roleKey,
    command.serverUrl,
    command.token,
    deps,
  );

  return authenticatedRequest(deps, {
    init: {
      body: JSON.stringify({
        role_id: roleId,
        team_id: teamId,
        ...toUserSelectorRequestBody(command.user),
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    },
    serverUrl: command.serverUrl,
    token: command.token,
    url: buildApiUrl(command.serverUrl, "/v1/iam/role-bindings"),
  });
}

export async function executeMemberInvite(
  command: MemberInviteCommand,
  deps: CommandDeps,
): Promise<unknown> {
  const teamId = await resolveTeamId(
    command.team,
    command.serverUrl,
    command.token,
    deps,
  );
  const roleId = await resolveRoleId(
    command.roleKey,
    command.serverUrl,
    command.token,
    deps,
  );

  return authenticatedRequest(deps, {
    init: {
      body: JSON.stringify({
        ...(command.target.email !== undefined
          ? { email: command.target.email }
          : { github_handle: command.target.githubHandle }),
        ...(command.expiresInDays !== undefined
          ? { expires_in_days: command.expiresInDays }
          : {}),
        role_id: roleId,
        team_id: teamId,
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    },
    serverUrl: command.serverUrl,
    token: command.token,
    url: buildApiUrl(command.serverUrl, "/v1/iam/invitations"),
  });
}

export async function executeMemberProvision(
  command: MemberProvisionCommand,
  deps: CommandDeps,
): Promise<unknown> {
  const teamId = await resolveTeamId(
    command.team,
    command.serverUrl,
    command.token,
    deps,
  );
  const roleId = await resolveRoleId(
    command.roleKey,
    command.serverUrl,
    command.token,
    deps,
  );

  return authenticatedRequest(deps, {
    init: {
      body: JSON.stringify({
        email: command.email,
        ...(command.displayName !== undefined
          ? { display_name: command.displayName }
          : {}),
        ...(command.expiresInDays !== undefined
          ? { expires_in_days: command.expiresInDays }
          : {}),
        role_id: roleId,
        team_id: teamId,
        ...(command.tokenDisplayName !== undefined
          ? { token_display_name: command.tokenDisplayName }
          : {}),
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    },
    serverUrl: command.serverUrl,
    token: command.token,
    url: buildApiUrl(command.serverUrl, "/v1/iam/users"),
  });
}

export async function executeMemberInviteList(
  command: MemberInviteListCommand,
  deps: CommandDeps,
): Promise<unknown> {
  const teamId = await resolveTeamId(
    command.team,
    command.serverUrl,
    command.token,
    deps,
  );

  return authenticatedRequest(deps, {
    init: {
      method: "GET",
    },
    serverUrl: command.serverUrl,
    token: command.token,
    url: buildApiUrlWithQuery(command.serverUrl, "/v1/iam/invitations", {
      ...(command.status !== undefined ? { status: command.status } : {}),
      team_id: teamId,
    }),
  });
}

export async function executeMemberInviteRevoke(
  command: MemberInviteRevokeCommand,
  deps: CommandDeps,
): Promise<unknown> {
  return authenticatedRequest(deps, {
    init: {
      method: "DELETE",
    },
    serverUrl: command.serverUrl,
    token: command.token,
    url: buildApiUrl(
      command.serverUrl,
      `/v1/iam/invitations/${encodeURIComponent(command.invitationId)}`,
    ),
  });
}

export async function executeMemberRemove(
  command: MemberRemoveCommand,
  deps: CommandDeps,
): Promise<unknown> {
  const bindingId =
    command.bindingId ??
    (await resolveRoleBindingId(
      command.team,
      command.user,
      command.roleKey,
      command.serverUrl,
      command.token,
      deps,
    ));

  return authenticatedRequest(deps, {
    init: {
      method: "DELETE",
    },
    serverUrl: command.serverUrl,
    token: command.token,
    url: buildApiUrl(
      command.serverUrl,
      `/v1/iam/role-bindings/${encodeURIComponent(bindingId)}`,
    ),
  });
}

async function resolveRoleId(
  roleKey: string,
  serverUrl: string,
  token: string | undefined,
  deps: CommandDeps,
): Promise<string> {
  const response = await authenticatedRequest(deps, {
    init: {
      method: "GET",
    },
    serverUrl,
    token,
    url: buildApiUrl(serverUrl, "/v1/iam/roles"),
  });
  const roles = parseRoleListResponse(response);
  const matchingRole = roles.find((role) => role.key === roleKey);

  if (!matchingRole) {
    const availableRoles = roles.map((role) => role.key).join(", ");
    throw new UsageError(
      `Role "${roleKey}" not found${availableRoles.length > 0 ? `. Available roles: ${availableRoles}` : ""}.`,
    );
  }

  return matchingRole.id;
}

async function resolveRoleBindingId(
  team: MemberListCommand["team"],
  user: MemberUserSelector,
  roleKey: string,
  serverUrl: string,
  token: string | undefined,
  deps: CommandDeps,
): Promise<string> {
  const teamId = await resolveTeamId(team, serverUrl, token, deps);
  const response = await authenticatedRequest(deps, {
    init: {
      method: "GET",
    },
    serverUrl,
    token,
    url: buildApiUrlWithQuery(serverUrl, "/v1/iam/role-bindings", {
      team_id: teamId,
    }),
  });
  const roleBindings = parseRoleBindingListResponse(response);
  const matches = roleBindings.filter(
    (roleBinding) =>
      roleBinding.role.key === roleKey && userSelectorMatches(roleBinding, user),
  );

  if (matches.length === 1) {
    return matches[0].id;
  }

  const userDescription =
    user.userId !== undefined ? `user "${user.userId}"` : `email "${user.email}"`;

  if (matches.length === 0) {
    throw new UsageError(
      `Role binding for ${userDescription} with role "${roleKey}" was not found in team "${teamId}".`,
    );
  }

  throw new UsageError(
    `Role binding for ${userDescription} with role "${roleKey}" is ambiguous. Matching binding IDs: ${matches
      .map((match) => match.id)
      .join(", ")}`,
  );
}

function userSelectorMatches(
  roleBinding: RoleBinding,
  user: MemberUserSelector,
): boolean {
  if (user.userId !== undefined) {
    return roleBinding.user.id === user.userId;
  }

  return roleBinding.user.email === user.email;
}

function toUserSelectorRequestBody(
  user: MemberUserSelector,
): { email: string } | { user_id: string } {
  return user.userId !== undefined
    ? { user_id: user.userId }
    : { email: user.email };
}

function parseRoleListResponse(response: unknown): Role[] {
  if (!isRecord(response) || !Array.isArray(response.roles)) {
    throw new UsageError(
      'Malformed IAM roles response: expected { "roles": [{ "id": string, "key": string }] }',
    );
  }

  return response.roles.map((role, index) => {
    if (
      !isRecord(role) ||
      typeof role.id !== "string" ||
      role.id.length === 0 ||
      typeof role.key !== "string" ||
      role.key.length === 0
    ) {
      throw new UsageError(
        `Malformed IAM roles response: item ${index} must include string id and key`,
      );
    }

    return {
      id: role.id,
      key: role.key,
    };
  });
}

function parseRoleBindingListResponse(response: unknown): RoleBinding[] {
  if (!isRecord(response) || !Array.isArray(response.role_bindings)) {
    throw new UsageError(
      'Malformed IAM role bindings response: expected { "role_bindings": [...] }',
    );
  }

  return response.role_bindings.map((roleBinding, index) => {
    if (
      !isRecord(roleBinding) ||
      typeof roleBinding.id !== "string" ||
      roleBinding.id.length === 0 ||
      !isRecord(roleBinding.user) ||
      typeof roleBinding.user.id !== "string" ||
      roleBinding.user.id.length === 0 ||
      !isRecord(roleBinding.role) ||
      typeof roleBinding.role.key !== "string" ||
      roleBinding.role.key.length === 0
    ) {
      throw new UsageError(
        `Malformed IAM role bindings response: item ${index} must include binding id, user id, and role key`,
      );
    }

    if (
      roleBinding.user.email !== undefined &&
      typeof roleBinding.user.email !== "string"
    ) {
      throw new UsageError(
        `Malformed IAM role bindings response: item ${index} user email must be a string when provided`,
      );
    }

    return {
      id: roleBinding.id,
      role: {
        ...(typeof roleBinding.role.id === "string"
          ? { id: roleBinding.role.id }
          : {}),
        key: roleBinding.role.key,
      },
      user: {
        ...(roleBinding.user.email !== undefined
          ? { email: roleBinding.user.email }
          : {}),
        id: roleBinding.user.id,
      },
    };
  });
}
