import type {
  AppSelector,
  DeploymentSelector,
  ReleaseSelector,
  TeamSelector,
} from "../commandTypes";
import { authenticatedRequest } from "../authenticatedRequest";
import { isRecord } from "../output";
import {
  buildApiUrl,
  buildApiUrlWithQuery,
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
    deployment.teamId ?? deployment.teamName,
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
): Promise<string> {
  if (deployment.deploymentId !== undefined) {
    return deployment.deploymentId;
  }

  const appId = await resolveAppId(
    deployment.teamId !== undefined
      ? { appName: deployment.appName, teamId: deployment.teamId }
      : deployment.teamName !== undefined
        ? { appName: deployment.appName, teamName: deployment.teamName }
        : { appName: deployment.appName },
    serverUrl,
    token,
    deps,
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
    throw new UsageError(
      [
        `Deployment "${deployment.deploymentName}" not found for app "${deployment.appName}" (${appId}).`,
        `Context: server ${serverUrl}; app ${appId}; deployment source: --deployment/project config value "${deployment.deploymentName}".`,
        `Next: run \`cmpatch deployment list --server-url ${serverUrl} --app-id ${appId}\` or update codemagic-patch.config.json.`,
      ].join("\n"),
    );
  }

  return resolvedDeployment.id;
}

export async function resolveTeamId(
  team: TeamSelector,
  serverUrl: string,
  token: string | undefined,
  deps: CommandDeps,
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
    if (teams.length === 1) {
      return teams[0].id;
    }

    if (teams.length === 0) {
      throw new UsageError(
        [
          "No teams are available.",
          `Context: server ${serverUrl}.`,
          "Next: ask an admin to confirm the server provisioned its default team (default-team).",
        ].join("\n"),
      );
    }

    throw new UsageError(
      [
        `Expected a single team but the server returned ${teams.length}. This build resolves the default team automatically and does not support manual team selection. Available teams: ${formatNamedResources(teams)}`,
        `Context: server ${serverUrl}.`,
        "Next: ask an admin to verify the server is provisioned with a single team (default-team).",
      ].join("\n"),
    );
  }

  const resolvedTeam = matchNamedResource(teams, team.teamName, "Team");

  if (!resolvedTeam) {
    throw new UsageError(
      [
        `Team "${team.teamName}" not found.`,
        `Context: server ${serverUrl}; team source: --team/config value "${team.teamName}".`,
        "Next: this build uses the server's single default team; run `cmpatch config unset team` to clear the override.",
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
        `Next: run \`cmpatch app list --server-url ${serverUrl} --team-id ${teamId}\` or update codemagic-patch.config.json.`,
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
): Promise<string> {
  if (release.releaseId !== undefined) {
    return release.releaseId;
  }

  const deploymentId = await resolveDeploymentId(
    release.deployment,
    serverUrl,
    token,
    deps,
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
