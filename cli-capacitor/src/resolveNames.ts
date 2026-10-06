// Name → id resolution: the team → app → deployment → release walk of
// cli/src/commands/resolveNames.ts (@codemagic/patch-cli 0.4.0), with the same
// endpoints and the same matching rule (exact name, then a unique case-insensitive
// match; release labels match exactly). Deliberate differences: there is no
// interactive picker, a miss lists what the server does have, and one `--team` takes
// a name or an id. See cli-capacitor-tech-spec › Provenance.

import { buildApiUrlWithQuery } from "./api";
import { teamAppsPath } from "./appFramework";
import {
  authenticatedRequest,
  type ApiTarget,
  type AuthenticatedRequestDeps,
} from "./authenticatedRequest";
import { CLI_NAME } from "./branding";
import { UsageError } from "./errors";
import { isRecord } from "./output";

export type AppSelector = { appId: string } | { app: string; team?: string };

export type DeploymentSelector =
  | { deploymentId: string }
  | { app: AppSelector; deployment: string };

export type ReleaseSelector =
  | { releaseId: string }
  | { deployment: DeploymentSelector; label: string };

type NamedResource = {
  id: string;
  name: string;
};

type ResourceLabel = "App" | "Deployment" | "Team";

const RELEASE_RESOLUTION_PAGE_SIZE = 100;

export async function resolveTeamId(
  deps: AuthenticatedRequestDeps,
  target: ApiTarget,
  requestedTeam: string | undefined,
): Promise<string> {
  return (await resolveTeam(deps, target, requestedTeam)).id;
}

export async function resolveAppId(
  deps: AuthenticatedRequestDeps,
  target: ApiTarget,
  selector: AppSelector,
): Promise<string> {
  return (await resolveApp(deps, target, selector)).id;
}

async function resolveApp(
  deps: AuthenticatedRequestDeps,
  target: ApiTarget,
  selector: AppSelector,
): Promise<NamedResource> {
  if ("appId" in selector) {
    return { id: selector.appId, name: selector.appId };
  }

  const team = await resolveTeam(deps, target, selector.team);
  const apps = await requestNamedResources(deps, target, teamAppsPath(team.id), "apps");
  const app = matchNamedResource(apps, selector.app, "App");
  if (app === null) {
    throw new UsageError(
      [
        `App "${selector.app}" not found in team "${team.name}" (${team.id}).`,
        `Available apps: ${formatNamedResources(apps)}`,
        `Context: server ${target.serverUrl}.`,
      ].join("\n"),
    );
  }

  return app;
}

export async function resolveDeploymentId(
  deps: AuthenticatedRequestDeps,
  target: ApiTarget,
  selector: DeploymentSelector,
): Promise<string> {
  if ("deploymentId" in selector) {
    return selector.deploymentId;
  }

  const app = await resolveApp(deps, target, selector.app);
  const deployments = await requestNamedResources(
    deps,
    target,
    `/v1/apps/${encodeURIComponent(app.id)}/deployments`,
    "deployments",
  );
  const deployment = matchNamedResource(
    deployments,
    selector.deployment,
    "Deployment",
  );
  if (deployment === null) {
    throw new UsageError(
      [
        app.name === app.id
          ? `Deployment "${selector.deployment}" not found for app ${app.id}.`
          : `Deployment "${selector.deployment}" not found for app "${app.name}" (${app.id}).`,
        `Available deployments: ${formatNamedResources(deployments)}`,
        `Context: server ${target.serverUrl}.`,
      ].join("\n"),
    );
  }

  return deployment.id;
}

export async function resolveReleaseId(
  deps: AuthenticatedRequestDeps,
  target: ApiTarget,
  selector: ReleaseSelector,
): Promise<string> {
  if ("releaseId" in selector) {
    return selector.releaseId;
  }

  const deploymentId = await resolveDeploymentId(deps, target, selector.deployment);
  let offset = 0;

  for (;;) {
    const page = parseReleasePage(
      await authenticatedRequest(
        deps,
        target,
        pathWithQuery(`/v1/deployments/${encodeURIComponent(deploymentId)}/releases`, {
          limit: RELEASE_RESOLUTION_PAGE_SIZE,
          offset,
        }),
        { method: "GET" },
      ),
    );
    const matches = page.releases.filter(
      (candidate) => candidate.label === selector.label,
    );

    if (matches.length === 1 && matches[0] !== undefined) {
      return matches[0].id;
    }

    if (matches.length > 1) {
      throw new UsageError(
        `Release label "${selector.label}" is ambiguous. Matching IDs: ${matches
          .map((match) => match.id)
          .join(", ")}`,
      );
    }

    const nextOffset = page.offset + page.limit;
    if (nextOffset >= page.total) {
      break;
    }

    if (nextOffset <= offset) {
      throw new Error("Malformed releases response: pagination did not advance");
    }

    offset = nextOffset;
  }

  throw new UsageError(
    [
      `Release label "${selector.label}" not found in deployment ${deploymentId}.`,
      `Next: run \`${CLI_NAME} release list --deployment-id ${deploymentId}\` to see its releases.`,
    ].join("\n"),
  );
}

/** A request path with a query string; `undefined` values are left out. */
export function pathWithQuery(
  pathname: string,
  query: Record<string, number | string | undefined>,
): string {
  const url = new URL(buildApiUrlWithQuery("http://placeholder.invalid", pathname, query));
  return `${url.pathname}${url.search}`;
}

async function resolveTeam(
  deps: AuthenticatedRequestDeps,
  target: ApiTarget,
  requestedTeam: string | undefined,
): Promise<NamedResource> {
  const teams = await requestNamedResources(deps, target, "/v1/teams", "teams");

  if (requestedTeam !== undefined) {
    // A team id in the name slot is accepted: ids are prefixed and unambiguous.
    const team =
      matchNamedResource(teams, requestedTeam, "Team") ??
      teams.find((candidate) => candidate.id === requestedTeam) ??
      null;
    if (team === null) {
      throw new UsageError(
        [
          `Team "${requestedTeam}" not found.`,
          `Available teams: ${formatNamedResources(teams)}`,
          `Context: server ${target.serverUrl}.`,
        ].join("\n"),
      );
    }
    return team;
  }

  // A sole team is not a choice; several are, and only the caller can make it.
  const [only] = teams;
  if (teams.length === 1 && only !== undefined) {
    return only;
  }

  if (teams.length === 0) {
    throw new UsageError(
      [
        "No teams are available to this account.",
        `Context: server ${target.serverUrl}.`,
      ].join("\n"),
    );
  }

  throw new UsageError(
    [
      `The server has ${teams.length} teams and no team was selected.`,
      `Available teams: ${formatNamedResources(teams)}`,
      "Next: pass --team <name or id>, or select the resource directly by id.",
    ].join("\n"),
  );
}

async function requestNamedResources(
  deps: AuthenticatedRequestDeps,
  target: ApiTarget,
  pathname: string,
  wrapperKey: "apps" | "deployments" | "teams",
): Promise<NamedResource[]> {
  const response = await authenticatedRequest(deps, target, pathname, {
    method: "GET",
  });

  if (!isRecord(response) || !Array.isArray(response[wrapperKey])) {
    throw new Error(
      `Malformed ${wrapperKey} response: expected { "${wrapperKey}": [{ "id": string, "name": string }] }`,
    );
  }

  return response[wrapperKey].map((resource: unknown, index: number) => {
    if (
      !isRecord(resource) ||
      typeof resource.id !== "string" ||
      resource.id.length === 0 ||
      typeof resource.name !== "string" ||
      resource.name.length === 0
    ) {
      throw new Error(
        `Malformed ${wrapperKey} response: item ${index} must include string id and name`,
      );
    }

    return {
      id: resource.id,
      name: resource.name,
    };
  });
}

function parseReleasePage(response: unknown): {
  limit: number;
  offset: number;
  releases: Array<{ id: string; label: string }>;
  total: number;
} {
  if (
    !isRecord(response) ||
    !Array.isArray(response.releases) ||
    !isRecord(response.pagination) ||
    typeof response.pagination.limit !== "number" ||
    typeof response.pagination.offset !== "number" ||
    typeof response.pagination.total !== "number"
  ) {
    throw new Error(
      'Malformed releases response: expected { "pagination": { "limit", "offset", "total" }, "releases": [{ "release": { "id", "release_label" } }] }',
    );
  }

  return {
    limit: response.pagination.limit,
    offset: response.pagination.offset,
    releases: response.releases.map((item: unknown, index: number) => {
      if (
        !isRecord(item) ||
        !isRecord(item.release) ||
        typeof item.release.id !== "string" ||
        typeof item.release.release_label !== "string"
      ) {
        throw new Error(
          `Malformed releases response: item ${index} must include release.id and release.release_label`,
        );
      }

      return { id: item.release.id, label: item.release.release_label };
    }),
    total: response.pagination.total,
  };
}

function matchNamedResource(
  resources: NamedResource[],
  requestedName: string,
  label: ResourceLabel,
): NamedResource | null {
  const exactMatches = resources.filter(
    (resource) => resource.name === requestedName,
  );

  if (exactMatches.length === 1) {
    return exactMatches[0] ?? null;
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

  return caseInsensitiveMatches[0] ?? null;
}

function ambiguousResourceError(
  label: ResourceLabel,
  requestedName: string,
  matches: NamedResource[],
): UsageError {
  return new UsageError(
    [
      `${label} "${requestedName}" is ambiguous. Matching resources: ${formatNamedResources(matches)}`,
      label === "Team"
        ? "Next: pass the team's id instead of its name: --team <id>."
        : `Next: select it by id instead: --${label.toLowerCase()}-id <id>.`,
    ].join("\n"),
  );
}

function formatNamedResources(resources: NamedResource[]): string {
  if (resources.length === 0) {
    return "(none)";
  }

  return resources
    .map((resource) => `${resource.name} (${resource.id})`)
    .join(", ");
}
