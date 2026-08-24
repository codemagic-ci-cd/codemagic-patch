import type {
  AppSelector,
  DeploymentSelector,
  ReleaseSelector,
  TeamSelector,
} from "../commandTypes";
import { authenticatedRequest } from "../authenticatedRequest";
import { promptResource } from "../flagPrompts";
import { isRecord } from "../output";
import {
  buildApiUrl,
  buildApiUrlWithQuery,
  canPromptOnStderr,
  type CommandDeps,
  UsageError,
} from "./shared";

type NamedResource = {
  id: string;
  name: string;
};

type ReleaseResource = {
  id: string;
  releaseLabel: string;
};

const RELEASE_RESOLUTION_PAGE_SIZE = 100;

/**
 * Human-readable rendering of a deployment selector for prompts and errors:
 * the raw id when selected by id, otherwise the full `team/app/deployment`
 * path so name-based targets stay unambiguous across apps.
 */
export function formatDeploymentSelector(
  deployment: DeploymentSelector,
): string {
  if (deployment.deploymentId !== undefined) {
    return deployment.deploymentId;
  }

  return [
    deployment.teamId ?? deployment.teamName ?? deployment.appId,
    deployment.appName,
    deployment.deploymentName,
  ]
    .filter((value): value is string => value !== undefined)
    .join("/");
}

/** Sibling of formatDeploymentSelector for app selectors (`team/app`). */
export function formatAppSelector(app: AppSelector): string {
  if (app.appId !== undefined) {
    return app.appId;
  }

  return [app.teamId ?? app.teamName, app.appName]
    .filter((value): value is string => value !== undefined)
    .join("/");
}

export async function resolveDeploymentId(
  deployment: DeploymentSelector,
  serverUrl: string,
  token: string | undefined,
  deps: CommandDeps,
  options: ResolveOptions = {},
): Promise<string> {
  if (deployment.deploymentId !== undefined) {
    return deployment.deploymentId;
  }

  const appId = await resolveAppId(
    deployment.appId !== undefined
      ? { appId: deployment.appId }
      : deployment.teamId !== undefined
        ? { appName: deployment.appName, teamId: deployment.teamId }
        : deployment.teamName !== undefined
          ? { appName: deployment.appName, teamName: deployment.teamName }
          : { appName: deployment.appName },
    serverUrl,
    token,
    deps,
    options,
  );

  const deployments = await requestNamedResourceList(
    deps,
    serverUrl,
    `/v1/apps/${encodeURIComponent(appId)}/deployments`,
    token,
    "deployments",
  );
  const resolvedDeployment = matchNamedResource(
    deployments,
    deployment.deploymentName,
    "Deployment",
  );

  if (!resolvedDeployment) {
    const appDescription = deployment.appId ?? deployment.appName;
    throw new UsageError(
      [
        `Deployment "${deployment.deploymentName}" not found for app "${appDescription}" (${appId}).`,
        `Context: server ${serverUrl}; app ${appId}; deployment source: --deployment/project config value "${deployment.deploymentName}".`,
        `Next: run \`cmpatch deployment list --server-url ${serverUrl} --app-id ${appId}\` or update codemagic-patch.config.json.`,
      ].join("\n"),
    );
  }

  return resolvedDeployment.id;
}

/** Options threaded down the resolver chain to the team prompt gate. */
export type ResolveOptions = {
  /**
   * True when the command was told not to ask (--non-interactive, or --yes,
   * which promises a run with no interactive stops). Resolution then falls
   * back to the flag-spelling error instead of a select prompt.
   */
  nonInteractive?: boolean;
};

export function noTeamsAvailableError(serverUrl: string): UsageError {
  return new UsageError(
    [
      "No teams are available.",
      `Context: server ${serverUrl}.`,
      "Next: ask an admin to confirm the server provisioned its default team (default-team).",
    ].join("\n"),
  );
}

/**
 * The team this run operates on when none was named. A sole team is taken
 * silently — it is not a choice. Several teams are a real choice: ask when
 * there is a person on the other end, otherwise spell out the flags that make
 * the run unambiguous. Shared with the interactive picker so both paths agree
 * on what a multi-team server means.
 */
export async function resolveDefaultTeam(
  teams: NamedResource[],
  serverUrl: string,
  deps: CommandDeps,
  options: ResolveOptions = {},
): Promise<NamedResource> {
  const [only] = teams;

  if (teams.length === 1 && only !== undefined) {
    return only;
  }

  if (teams.length === 0) {
    throw noTeamsAvailableError(serverUrl);
  }

  if (
    deps.prompt !== undefined &&
    canPromptOnStderr(deps, options.nonInteractive === true)
  ) {
    return promptResource(deps.prompt, "Select team", teams, "team");
  }

  throw new UsageError(
    [
      `The server has ${teams.length} teams and no team was selected. Available teams: ${formatNamedResources(teams)}`,
      `Context: server ${serverUrl}.`,
      "Next: pass --team <name> or --team-id <id>, or run `cmpatch config set team <name>` to store a default.",
    ].join("\n"),
  );
}

export async function resolveTeamId(
  team: TeamSelector,
  serverUrl: string,
  token: string | undefined,
  deps: CommandDeps,
  options: ResolveOptions = {},
): Promise<string> {
  if (team.teamId !== undefined) {
    return team.teamId;
  }

  const teams = await requestNamedResourceList(
    deps,
    serverUrl,
    "/v1/teams",
    token,
    "teams",
  );

  if (team.teamName === undefined) {
    const resolved = await resolveDefaultTeam(teams, serverUrl, deps, options);
    return resolved.id;
  }

  // A team id in the name slot is accepted: ids are prefixed and unambiguous,
  // and stored configs from the single-team era hold the id under `team`.
  const resolvedTeam =
    matchNamedResource(teams, team.teamName, "Team") ??
    teams.find((candidate) => candidate.id === team.teamName) ??
    null;

  if (!resolvedTeam) {
    throw new UsageError(
      [
        `Team "${team.teamName}" not found. Available teams: ${formatNamedResources(teams)}`,
        `Context: server ${serverUrl}; team source: --team/config value "${team.teamName}".`,
        "Next: pass --team with one of the teams above, or run `cmpatch config unset team` to clear a stored override.",
      ].join("\n"),
    );
  }

  return resolvedTeam.id;
}

export async function resolveAppId(
  app: AppSelector,
  serverUrl: string,
  token: string | undefined,
  deps: CommandDeps,
  options: ResolveOptions = {},
): Promise<string> {
  if (app.appId !== undefined) {
    return app.appId;
  }

  const teamId =
    app.teamId !== undefined
      ? app.teamId
      : await resolveTeamId(
          app.teamName !== undefined ? { teamName: app.teamName } : {},
          serverUrl,
          token,
          deps,
          options,
        );
  const apps = await requestNamedResourceList(
    deps,
    serverUrl,
    `/v1/teams/${encodeURIComponent(teamId)}/apps`,
    token,
    "apps",
  );
  const resolvedApp = matchNamedResource(apps, app.appName, "App");

  if (!resolvedApp) {
    const teamDescription =
      app.teamId !== undefined
        ? app.teamId
        : app.teamName !== undefined
          ? app.teamName
          : teamId;
    throw new UsageError(
      [
        `App "${app.appName}" not found in team "${teamDescription}" (${teamId}).`,
        `Context: server ${serverUrl}; team ${teamId}; app source: --app/project config value "${app.appName}".`,
        `Next: run \`cmpatch app list --server-url ${serverUrl}\` or update codemagic-patch.config.json.`,
      ].join("\n"),
    );
  }

  return resolvedApp.id;
}

export async function resolveReleaseId(
  release: ReleaseSelector,
  serverUrl: string,
  token: string | undefined,
  deps: CommandDeps,
  options: ResolveOptions = {},
): Promise<string> {
  if (release.releaseId !== undefined) {
    return release.releaseId;
  }

  const deploymentId = await resolveDeploymentId(
    release.deployment,
    serverUrl,
    token,
    deps,
    options,
  );
  let offset = 0;

  while (true) {
    const response = await authenticatedRequest(deps, {
      init: {
        method: "GET",
      },
      serverUrl,
      token,
      url: buildApiUrlWithQuery(
        serverUrl,
        `/v1/deployments/${encodeURIComponent(deploymentId)}/releases`,
        {
          limit: RELEASE_RESOLUTION_PAGE_SIZE,
          offset,
        },
      ),
    });
    const page = parseReleaseListResponse(response);
    const matches = page.releases.filter(
      (candidate) => candidate.releaseLabel === release.releaseLabel,
    );

    if (matches.length === 1) {
      return matches[0].id;
    }

    if (matches.length > 1) {
      throw new UsageError(
        `Release label "${release.releaseLabel}" is ambiguous. Matching IDs: ${matches
          .map((match) => match.id)
          .join(", ")}`,
      );
    }

    const nextOffset = page.pagination.offset + page.pagination.limit;

    if (nextOffset >= page.pagination.total) {
      break;
    }

    if (nextOffset <= offset) {
      throw new UsageError(
        "Malformed releases response: pagination did not advance",
      );
    }

    offset = nextOffset;
  }

  throw new UsageError(
    [
      `Release label "${release.releaseLabel}" not found.`,
      `Context: server ${serverUrl}; deployment ${deploymentId}; label "${release.releaseLabel}".`,
      `Next: run \`cmpatch release list --server-url ${serverUrl} --deployment-id ${deploymentId}\` to see available releases.`,
    ].join("\n"),
  );
}

async function requestNamedResourceList(
  deps: CommandDeps,
  serverUrl: string,
  pathname: string,
  token: string | undefined,
  wrapperKey: "apps" | "deployments" | "teams",
): Promise<NamedResource[]> {
  const response = await authenticatedRequest(deps, {
    init: {
      method: "GET",
    },
    serverUrl,
    token,
    url: buildApiUrl(serverUrl, pathname),
  });

  return parseNamedResourceList(response, wrapperKey);
}

function parseNamedResourceList(
  response: unknown,
  wrapperKey: "apps" | "deployments" | "teams",
): NamedResource[] {
  if (!isRecord(response) || !Array.isArray(response[wrapperKey])) {
    throw new UsageError(
      `Malformed ${wrapperKey} response: expected { "${wrapperKey}": [{ "id": string, "name": string }] }`,
    );
  }

  return response[wrapperKey].map((resource, index) => {
    if (
      !isRecord(resource) ||
      typeof resource.id !== "string" ||
      resource.id.length === 0 ||
      typeof resource.name !== "string" ||
      resource.name.length === 0
    ) {
      throw new UsageError(
        `Malformed ${wrapperKey} response: item ${index} must include string id and name`,
      );
    }

    return {
      id: resource.id,
      name: resource.name,
    };
  });
}

function parseReleaseListResponse(response: unknown): {
  pagination: {
    limit: number;
    offset: number;
    total: number;
  };
  releases: ReleaseResource[];
} {
  if (
    !isRecord(response) ||
    !Array.isArray(response.releases) ||
    !isRecord(response.pagination) ||
    typeof response.pagination.limit !== "number" ||
    typeof response.pagination.offset !== "number" ||
    typeof response.pagination.total !== "number"
  ) {
    throw new UsageError(
      'Malformed releases response: expected { "pagination": { "limit": number, "offset": number, "total": number }, "releases": [{ "release": { "id": string, "release_label": string } }] }',
    );
  }

  return {
    pagination: {
      limit: response.pagination.limit,
      offset: response.pagination.offset,
      total: response.pagination.total,
    },
    releases: response.releases.map((item, index) => {
      if (
        !isRecord(item) ||
        !isRecord(item.release) ||
        typeof item.release.id !== "string" ||
        item.release.id.length === 0 ||
        typeof item.release.release_label !== "string" ||
        item.release.release_label.length === 0
      ) {
        throw new UsageError(
          `Malformed releases response: item ${index} must include release.id and release.release_label`,
        );
      }

      return {
        id: item.release.id,
        releaseLabel: item.release.release_label,
      };
    }),
  };
}

function matchNamedResource(
  resources: NamedResource[],
  requestedName: string,
  label: "App" | "Deployment" | "Team",
): NamedResource | null {
  const exactMatches = resources.filter(
    (resource) => resource.name === requestedName,
  );

  if (exactMatches.length === 1) {
    return exactMatches[0];
  }

  if (exactMatches.length > 1) {
    throw ambiguousResourceError(label, requestedName, exactMatches);
  }

  const normalizedName = requestedName.toLocaleLowerCase();
  const caseInsensitiveMatches = resources.filter(
    (resource) => resource.name.toLocaleLowerCase() === normalizedName,
  );

  if (caseInsensitiveMatches.length === 0) {
    return null;
  }

  if (caseInsensitiveMatches.length > 1) {
    throw ambiguousResourceError(label, requestedName, caseInsensitiveMatches);
  }

  return caseInsensitiveMatches[0];
}

function ambiguousResourceError(
  label: "App" | "Deployment" | "Team",
  requestedName: string,
  matches: NamedResource[],
): UsageError {
  return new UsageError(
    [
      `${label} "${requestedName}" is ambiguous. Matching resources: ${matches
        .map((match) => `${match.name} (${match.id})`)
        .join(", ")}`,
      `Context: matched ${matches.length} ${label.toLowerCase()} resources by name.`,
      `Next: choose an ID explicitly with --${label.toLowerCase()}-id where this command supports it.`,
    ].join("\n"),
  );
}

function formatNamedResources(resources: NamedResource[]): string {
  return resources
    .map((resource) => `${resource.name} (${resource.id})`)
    .join(", ");
}
