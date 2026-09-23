// Where the app will fetch updates from: the deployment key of each
// platform's linked deployment, the API URL and the download base URL, all
// read from the connected server on every run. Nothing here is guessed:
// a value the server does not return is a failure for that platform, not
// a placeholder written into the app.

import { authenticatedRequest, isAuthenticationFailure } from "../authenticatedRequest";
import { readSdkDownloadBaseUrl } from "../commands/localConfig";
import { resolveAppId } from "../commands/resolveNames";
import { assertHttpUrl, buildApiUrl, type CommandDeps } from "../commands/shared";
import type { AppSelector } from "../commandTypes";
import type { ProjectConfig } from "../configStore";
import { isRecord } from "../output";
import type { NativePlatform } from "../projectAnalysis";
import type { WireDestination } from "./types";

export type DestinationResolution = {
  destinations: WireDestination[];
  /** Platforms whose destination could not be established, with why and what to do about it. */
  failures: DestinationFailure[];
};

export type DestinationFailure = { platform: NativePlatform; reason: string; hint: string };

const RELINK_HINT = "Run `cmpatch init` to link another app and deployment.";

export async function resolveDestinations(
  deps: CommandDeps,
  connection: Pick<ProjectConfig, "apps" | "serverUrl" | "teamId">,
  platforms: NativePlatform[],
  token: string | undefined,
): Promise<DestinationResolution> {
  const serverUrl = assertHttpUrl(connection.serverUrl ?? "");
  const apiUrl = serverUrl.replace(/\/+$/, "");
  const result: DestinationResolution = { destinations: [], failures: [] };
  let downloadBaseUrl: string;
  try {
    downloadBaseUrl = readSdkDownloadBaseUrl(await get(deps, serverUrl, "/v1/sdk-config", token));
  } catch (error) {
    if (isAuthenticationFailure(error)) throw error;
    const failure = serverFailure(error);
    return { destinations: [], failures: platforms.map((platform) => ({ platform, ...failure })) };
  }
  for (const platform of platforms) {
    const linked = connection.apps?.[platform];
    if (
      linked === undefined ||
      (linked.app === undefined && linked.appId === undefined) ||
      linked.deployment === undefined
    ) {
      result.failures.push({
        platform,
        reason: "no app and deployment are linked for this platform",
        hint: "Run `cmpatch init` to link one.",
      });
      continue;
    }
    try {
      const appId =
        linked.appId ??
        (await resolveAppId(
          { appName: linked.app!, ...(connection.teamId !== undefined ? { teamId: connection.teamId } : {}) } as AppSelector,
          serverUrl,
          token,
          deps,
          { nonInteractive: true },
        ));
      const app = readNamed(await get(deps, serverUrl, `/v1/apps/${encodeURIComponent(appId)}`, token), "app");
      const deployments = readNamedList(
        await get(deps, serverUrl, `/v1/apps/${encodeURIComponent(app.id)}/deployments`, token),
        "deployments",
      );
      const deployment = deployments.find((candidate) => candidate.name === linked.deployment);
      if (deployment === undefined) {
        result.failures.push({
          platform,
          reason: `deployment "${linked.deployment}" was not found in app ${app.name}`,
          hint: `Create it with \`cmpatch deployment create --server-url ${shellWord(apiUrl)} --app-id ${app.id} --name ${shellWord(linked.deployment)}\`, or run \`cmpatch init\` to link another deployment.`,
        });
        continue;
      }
      if (deployment.deploymentKey === undefined) {
        result.failures.push({
          platform,
          reason: `the server returned no deployment key for ${app.name} / ${deployment.name}`,
          hint: RELINK_HINT,
        });
        continue;
      }
      result.destinations.push({
        platform,
        app: { id: app.id, name: app.name },
        deployment: { id: deployment.id, name: deployment.name },
        deploymentKey: deployment.deploymentKey,
        apiUrl,
        downloadBaseUrl,
      });
    } catch (error) {
      if (isAuthenticationFailure(error)) throw error;
      result.failures.push({ platform, ...(isNetworkFailure(error) ? serverFailure(error) : { reason: failureReason(error), hint: RELINK_HINT }) });
    }
  }
  return result;
}

type NamedResource = { id: string; name: string; deploymentKey?: string };

async function get(
  deps: CommandDeps,
  serverUrl: string,
  pathname: string,
  token: string | undefined,
): Promise<unknown> {
  return authenticatedRequest(deps, {
    init: { method: "GET" },
    serverUrl,
    ...(token !== undefined ? { token } : {}),
    url: buildApiUrl(serverUrl, pathname),
  });
}

function readNamed(value: unknown, label: string): NamedResource {
  const record = isRecord(value) && isRecord(value[label]) ? value[label] : value;
  if (!isRecord(record) || typeof record.id !== "string" || typeof record.name !== "string") {
    throw new Error(`Malformed ${label} response`);
  }
  return {
    id: record.id,
    name: record.name,
    ...(typeof record.deployment_key === "string" ? { deploymentKey: record.deployment_key } : {}),
  };
}

function readNamedList(value: unknown, label: string): NamedResource[] {
  if (!isRecord(value) || !Array.isArray(value[label])) {
    throw new Error(`Malformed ${label} response`);
  }
  return value[label].map((item) => readNamed(item, label));
}

function shellWord(value: string): string {
  return /^[\w.@/:-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function isNetworkFailure(error: unknown): boolean {
  return error instanceof Error && error.name === "RequestNetworkError";
}

/**
 * The server could not be asked at all. Its generic message points at a
 * `--server-url` flag wire does not have: here the URL is the project's.
 */
function serverFailure(error: unknown): Omit<DestinationFailure, "platform"> {
  if (!isNetworkFailure(error)) return { reason: failureReason(error), hint: "Run `cmpatch wire` again; if it keeps failing, check the server's logs." };
  const message = failureReason(error);
  return {
    reason: /^(.*?\.)(?: |$)/.exec(message)?.[1] ?? message,
    hint: "Check that the server is running and reachable from here. The URL is the one in codemagic-patch.config.json; to connect another server, run `cmpatch init`.",
  };
}

function failureReason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0]!;
}
