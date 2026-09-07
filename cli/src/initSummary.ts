/**
 * What `cmpatch init` says when it is done.
 *
 * The config it wrote is the smallest part of the answer. The person reading
 * this has a linked project and, usually, an app with no SDK in it yet — so
 * the summary reads back what was linked, then says what happens outside the
 * CLI next: wiring the SDK, publishing, and where in the dashboard the result
 * shows up. Rendered through the action view so `--format json` and piped
 * output keep the record this is built from.
 */

import { FIRST_RELEASE_DOCS_URL, NATIVE_SETUP_DOCS_URL } from "./branding";
import { isRecord } from "./output";
import type { ActionSummary } from "./resultView";

type LinkedPlatform = { app: string; deployment: string };

const PLATFORMS = ["ios", "android"] as const;

export function summarizeInit(result: unknown): ActionSummary | null {
  if (!isRecord(result) || !isRecord(result.config)) {
    return null;
  }

  const config = result.config;
  const serverUrl = typeof config.serverUrl === "string" ? config.serverUrl : null;
  const projectName =
    typeof result.projectName === "string" ? result.projectName : null;
  if (serverUrl === null || projectName === null) {
    return null;
  }

  const team = isRecord(result.team) && typeof result.team.name === "string"
    ? result.team.name
    : null;
  const apps = isRecord(config.apps) ? config.apps : {};
  const dashboard = isRecord(result.dashboard) ? result.dashboard : {};
  const linked = PLATFORMS.flatMap((platform) => {
    const entry = apps[platform];
    return isRecord(entry) &&
      typeof entry.app === "string" &&
      typeof entry.deployment === "string"
      ? [{ platform, ...(entry as LinkedPlatform) }]
      : [];
  });
  const previousServerUrl =
    typeof result.previousServerUrl === "string" ? result.previousServerUrl : null;

  const facts: Array<[string, string]> = [
    ["Server", serverUrl],
    ...(team === null ? [] : [["Team", team] as [string, string]]),
    ...linked.map(
      ({ platform, app, deployment }) =>
        [platform, `${app} → ${deployment}`] as [string, string],
    ),
    ...(typeof config.bundler === "string"
      ? [["Bundler", config.bundler] as [string, string]]
      : []),
  ];
  const width = Math.max(...facts.map(([label]) => label.length));

  return {
    details: [
      ...facts.map(([label, value]) => `${label.padEnd(width)}  ${value}`),
      "",
      "Next steps",
      "",
      ...(previousServerUrl !== null && isLocalStack(previousServerUrl)
        ? [
            "1. Point the SDK at the new server",
            `   This project was set up against ${previousServerUrl}. The SDK in the app still has that URL and the local deployment key; replace both with this server's, from the deployment page in the dashboard.`,
          ]
        : [
            "1. Wire the SDK into the app, if you have not yet",
            "   The SDK needs the server URL above and the deployment key, shown on the deployment page in the dashboard.",
          ]),
      `   ${NATIVE_SETUP_DOCS_URL}`,
      "",
      "2. Publish a release",
      "   cmpatch release-react --dry-run    shows what would be uploaded",
      "   cmpatch release-react              uploads it",
      `   ${FIRST_RELEASE_DOCS_URL}`,
      "",
      "3. Check it landed",
      ...linked.map(({ platform, deployment }) => {
        const url = dashboard[platform];
        return typeof url === "string"
          ? `   ${url}   ${platform} · ${deployment}`
          : `   ${serverUrl}/   ${platform} · ${deployment}`;
      }),
      "   The release is listed on the deployment's page.",
    ],
    summary: `Linked ${projectName} to ${serverUrl}`,
  };
}

/**
 * A local evaluation stack, by its address: the one server a project can have
 * been pointed at before its first real one, and the one whose URL and
 * deployment key an SDK wired against it still carries.
 */
function isLocalStack(serverUrl: string): boolean {
  try {
    const { hostname } = new URL(serverUrl);
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]" ||
      hostname === "0.0.0.0"
    );
  } catch {
    return false;
  }
}
