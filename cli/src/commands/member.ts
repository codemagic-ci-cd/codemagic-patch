import type {
  MemberAddCommand,
  MemberInviteCommand,
  MemberInviteListCommand,
  MemberInviteRevokeCommand,
  MemberListCommand,
  MemberProvisionCommand,
  MemberRemoveCommand,
  MemberRotateTokenCommand,
  MemberUpdateCommand,
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
import { assertMutationConfirmable, enforceMutationSafety } from "./mutationSafety";
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
    /** Set on a service account: the team that owns it. */
    ownerTeamId?: string;
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

export async function executeMemberRotateToken(
  command: MemberRotateTokenCommand,
  deps: CommandDeps,
): Promise<unknown> {
  const safety = {
    commandName: "member rotate-token",
    nonInteractive: command.nonInteractive === true,
    yes: command.yes === true,
  };
  // As in member remove: the note names the account the reads find.
  assertMutationConfirmable(deps, safety);

  const teamId = await resolveTeamId(
    command.team,
    command.serverUrl,
    command.token,
    deps,
  );
  const binding = (
    await listRoleBindings(teamId, command.serverUrl, command.token, deps)
  ).find((roleBinding) => sameEmail(roleBinding.user.email, command.email));

  if (binding === undefined) {
    throw new UsageError(
      `Email "${command.email}" is not a member of team "${teamId}".`,
    );
  }

  // The server answers this case with a plain 404; the list already says why.
  if (binding.user.ownerTeamId !== teamId) {
    throw new UsageError(
      `"${command.email}" is not a service account this team owns. A member who signs in creates their own tokens with \`cmpatch token create\`.`,
    );
  }

  await enforceMutationSafety(deps, {
    ...safety,
    fields: [
      ["serverUrl", command.serverUrl],
      ["teamId", teamId],
      ["userId", binding.user.id],
      ["email", binding.user.email],
      ["effect", "the account's current token stops working"],
    ],
  });

  return authenticatedRequest(deps, {
    init: {
      body: JSON.stringify({
        ...(command.expiresInDays !== undefined
          ? { expires_in_days: command.expiresInDays }
          : {}),
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
    url: buildApiUrl(
      command.serverUrl,
      `/v1/iam/users/${encodeURIComponent(binding.user.id)}/rotate-token`,
    ),
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
  // The invitation id is all the command has: the email and team would take a
  // team-scoped list read, so the note names the id the user passed.
  await enforceMutationSafety(deps, {
    commandName: "member invite-revoke",
    fields: [
      ["serverUrl", command.serverUrl],
      ["invitationId", command.invitationId],
    ],
    nonInteractive: command.nonInteractive === true,
    yes: command.yes === true,
  });

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
  const safety = {
    commandName: "member remove",
    nonInteractive: command.nonInteractive === true,
    yes: command.yes === true,
  };
  // The note names the member the reads find, so the confirm comes after
  // them; a run that could not answer it is refused before the first read.
  assertMutationConfirmable(deps, safety);

  let bindingId: string;
  let fields: Array<[string, string | undefined]>;

  if (command.bindingId !== undefined) {
    bindingId = command.bindingId;
    fields = [
      ["serverUrl", command.serverUrl],
      ["bindingId", bindingId],
    ];
  } else {
    const { binding, teamId } = await resolveRoleBinding(
      command.team,
      command.user,
      command.roleKey,
      command.serverUrl,
      command.token,
      deps,
    );
    bindingId = binding.id;
    fields = [
      ["serverUrl", command.serverUrl],
      ["teamId", teamId],
      ["userId", binding.user.id],
      ["email", binding.user.email],
      ["role", binding.role.key],
    ];
  }

  await enforceMutationSafety(deps, { ...safety, fields });

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

export async function executeMemberUpdate(
  command: MemberUpdateCommand,
  deps: CommandDeps,
): Promise<unknown> {
  const safety = {
    commandName: "member update",
    nonInteractive: command.nonInteractive === true,
    yes: command.yes === true,
  };
  // As in member remove: the confirm follows the reads that name the member
  // and check the new role, and a run that could not answer it reads nothing.
  assertMutationConfirmable(deps, safety);

  let bindingId: string;
  let fields: Array<[string, string | undefined]>;

  if (command.bindingId !== undefined) {
    bindingId = command.bindingId;
    fields = [
      ["serverUrl", command.serverUrl],
      ["bindingId", bindingId],
      ["role", command.roleKey],
    ];
  } else {
    const { binding, teamId } = await resolveRoleBinding(
      command.team,
      command.user,
      command.fromRoleKey,
      command.serverUrl,
      command.token,
      deps,
    );
    bindingId = binding.id;
    fields = [
      ["serverUrl", command.serverUrl],
      ["teamId", teamId],
      ["userId", binding.user.id],
      ["email", binding.user.email],
      ["fromRole", binding.role.key],
      ["role", command.roleKey],
    ];
  }

  const roleId = await resolveRoleId(
    command.roleKey,
    command.serverUrl,
    command.token,
    deps,
  );

  await enforceMutationSafety(deps, { ...safety, fields });

  return authenticatedRequest(deps, {
    init: {
      body: JSON.stringify({ role_id: roleId }),
      headers: {
        "content-type": "application/json",
      },
      method: "PATCH",
    },
    serverUrl: command.serverUrl,
    token: command.token,
    url: buildApiUrl(
      command.serverUrl,
      `/v1/iam/role-bindings/${encodeURIComponent(bindingId)}`,
    ),
  });
}

// `roleKey` narrows to a single binding when the member holds several roles.
// It is optional for `member update`, where the caller may omit --from-role.
async function resolveRoleBinding(
  team: MemberListCommand["team"],
  user: MemberUserSelector,
  roleKey: string | undefined,
  serverUrl: string,
  token: string | undefined,
  deps: CommandDeps,
): Promise<{ binding: RoleBinding; teamId: string }> {
  const teamId = await resolveTeamId(team, serverUrl, token, deps);
  const roleBindings = await listRoleBindings(teamId, serverUrl, token, deps);
  const matches = roleBindings.filter(
    (roleBinding) =>
      (roleKey === undefined || roleBinding.role.key === roleKey) &&
      userSelectorMatches(roleBinding, user),
  );

  if (matches.length === 1) {
    return { binding: matches[0], teamId };
  }

  const userDescription =
    user.userId !== undefined ? `user "${user.userId}"` : `email "${user.email}"`;
  const roleDescription =
    roleKey !== undefined ? ` with role "${roleKey}"` : "";

  if (matches.length === 0) {
    throw new UsageError(
      `Role binding for ${userDescription}${roleDescription} was not found in team "${teamId}".`,
    );
  }

  const matchingIds = matches.map((match) => match.id).join(", ");

  if (roleKey === undefined) {
    throw new UsageError(
      `Member ${userDescription} holds multiple roles in team "${teamId}". Pass --from-role or --binding-id to choose one. Matching binding IDs: ${matchingIds}`,
    );
  }

  throw new UsageError(
    `Role binding for ${userDescription}${roleDescription} is ambiguous. Matching binding IDs: ${matchingIds}`,
  );
}

async function listRoleBindings(
  teamId: string,
  serverUrl: string,
  token: string | undefined,
  deps: CommandDeps,
): Promise<RoleBinding[]> {
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

  return parseRoleBindingListResponse(response);
}

function userSelectorMatches(
  roleBinding: RoleBinding,
  user: MemberUserSelector,
): boolean {
  if (user.userId !== undefined) {
    return roleBinding.user.id === user.userId;
  }

  return sameEmail(roleBinding.user.email, user.email);
}

/** The server stores emails trimmed and lowercased; compare the way it does. */
function sameEmail(stored: string | undefined, given: string): boolean {
  return stored === given.trim().toLowerCase();
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
        ...(typeof roleBinding.user.owner_team_id === "string"
          ? { ownerTeamId: roleBinding.user.owner_team_id }
          : {}),
      },
    };
  });
}
