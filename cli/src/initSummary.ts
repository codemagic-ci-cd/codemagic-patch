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
import { isRecord, PLAIN_PALETTE, type Palette } from "./output";
import type { ActionSummary } from "./resultView";
import { renderNextSteps, renderWireHeadlineLine, renderWireReport } from "./wire/render";
import type { WireResult } from "./wire/types";

type LinkedPlatform = { app: string; deployment: string };

const PLATFORMS = ["ios", "android"] as const;

export function summarizeInit(
  result: unknown,
  _command?: unknown,
  palette: Palette = PLAIN_PALETTE,
): ActionSummary | null {
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
  const wiring = isWireResult(result.wiring) ? result.wiring : null;
  const wiringFailure =
    isRecord(result.wiring) && result.wiring.status === "failed" && typeof result.wiring.error === "string"
      ? result.wiring.error
      : null;
  const dryRun = result.dryRun === true;
  const linkedLine = dryRun
    ? `Would link ${projectName} to ${serverUrl} (dry run)`
    : `Linked ${projectName} to ${serverUrl}`;

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
  const factLines = facts.map(([label, value]) => `${palette.dim(label.padEnd(width))}  ${value}`);
  // A command to type, then what it does, in the columns the plain text keeps.
  const command = (text: string, note = "") =>
    `   ${palette.value(text)}${note === "" ? "" : `${" ".repeat(Math.max(1, 35 - text.length))}${palette.dim(note)}`}`;
  const docs = (url: string) => `   ${palette.dim(url)}`;

  const landed = [
    ...linked.map(({ platform, deployment }) => {
      const url = dashboard[platform];
      return `   ${palette.value(typeof url === "string" ? url : `${serverUrl}/`)}   ${palette.dim(`${platform} · ${deployment}`)}`;
    }),
    palette.dim("   The release is listed on the deployment's page."),
  ];
  const heading = (text: string) => palette.bold(text);

  if (wiringFailure !== null) {
    return {
      details: [
        ...factLines,
        "",
        palette.err(`${palette.bold("✗ SDK wiring could not run:")} ${wiringFailure}`),
        `${palette.value("→")} Fix that, then run ${palette.value("cmpatch wire")}; the connection above is saved.`,
      ],
      summary: `${linkedLine}; SDK wiring failed`,
      tone: "err",
    };
  }

  // Wiring ran: its own steps and next steps replace the hand-wiring advice.
  if (wiring !== null) {
    const complete = wiring.result === "complete" && !dryRun;
    return {
      details: [
        ...factLines,
        "",
        renderWireHeadlineLine(wiring, palette),
        ...withBlankBefore(renderWireReport(wiring, palette)),
        "",
        heading("Next steps"),
        "",
        ...renderNextSteps(wiring.nextSteps, palette),
        ...(complete ? [`${wiring.nextSteps.length + 1}. Check it landed`, ...landed] : []),
      ],
      summary:
        wiring.result === "complete"
          ? linkedLine
          : `${linkedLine}; SDK wiring ${wiring.result}`,
      tone: wiring.result === "complete" ? "ok" : wiring.result === "failed" ? "err" : "warn",
    };
  }

  return {
    details: [
      ...factLines,
      "",
      heading("Next steps"),
      "",
      ...(previousServerUrl !== null && isLocalStack(previousServerUrl)
        ? [
            "1. Point the SDK at the new server",
            `   This project was set up against ${previousServerUrl}. The SDK in the app still has that URL and the local deployment key; replace both with this server's.`,
            command("cmpatch wire", "rewrites the app's deployment key and URLs"),
          ]
        : [
            "1. Wire the SDK into the app, if you have not yet",
            command("cmpatch wire", "installs the SDK and writes the key, URLs and startup hooks"),
          ]),
      docs(NATIVE_SETUP_DOCS_URL),
      "",
      "2. Publish a release",
      command("cmpatch release-react --dry-run", "shows what would be uploaded"),
      command("cmpatch release-react", "uploads it"),
      docs(FIRST_RELEASE_DOCS_URL),
      "",
      "3. Check it landed",
      ...landed,
    ],
    summary: `Linked ${projectName} to ${serverUrl}`,
  };
}

function withBlankBefore(lines: string[]): string[] {
  return lines.length === 0 ? [] : ["", ...lines];
}

function isWireResult(value: unknown): value is WireResult {
  return isRecord(value) && value.command === "wire" && Array.isArray(value.steps);
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
