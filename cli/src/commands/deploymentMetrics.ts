import type { DeploymentMetricsCommand } from "../commandTypes";
import { authenticatedRequest } from "../authenticatedRequest";
import {
  formatSuccessRate,
  isRecord,
  readCell,
  renderTable,
  type Palette,
} from "../output";
import { resolveDeploymentId } from "./resolveNames";
import {
  buildApiUrlWithQuery,
  type CommandDeps,
  UsageError,
} from "./shared";

export async function executeDeploymentMetrics(
  command: DeploymentMetricsCommand,
  deps: CommandDeps,
): Promise<unknown> {
  const deploymentId = await resolveDeploymentId(
    command.deployment,
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
    url: buildApiUrlWithQuery(
      command.serverUrl,
      `/v1/metrics/deployments/${encodeURIComponent(deploymentId)}`,
      {
        limit: command.limit,
        offset: command.offset,
      },
    ),
  });
}

const HEADERS = ["ID", "LABEL", "TARGET", "ACTIVE", "DOWNLOADED", "READY", "FAILED", "APPLIED"];
const METRIC_KEYS = ["active", "downloaded", "installed", "failed", "success"];

/**
 * What the server's `summary.coverage` says the totals cover. A page's totals
 * are not the deployment's and cannot be added to another page's, since a
 * package hash can recur across pages, so the label always names the scope;
 * a coverage this CLI does not know gets no total rather than a wrong label.
 */
const SUMMARY_SCOPE = new Map([
  [
    "deployment",
    { rate: "unique packages in this deployment", total: "TOTAL (all releases)" },
  ],
  ["page", { rate: "unique packages on this page", total: "TOTAL (this page)" }],
]);

/**
 * One row per release, then the server's `summary` as a total row and a
 * success-rate line. Nothing here is computed: the server counts each package
 * hash once and decides the coverage, and a server without `summary` gets the
 * release rows alone.
 */
export function renderDeploymentMetricsTable(
  result: unknown,
  palette: Palette,
): string {
  if (!isRecord(result) || !Array.isArray(result.releases)) {
    throw new UsageError(
      'Cannot render table output: expected response field "releases" to be an array',
    );
  }

  const releases = result.releases.filter(isRecord);

  if (releases.length === 0) {
    return "No release metrics found. Publish a release with `cmpatch release-react --deployment <name>`.\n";
  }

  const metricCells = (metrics: unknown) =>
    METRIC_KEYS.map((key) => (isRecord(metrics) ? readCell(metrics, key, "") : ""));
  const rows = releases.map((release) => [
    readCell(release, "release_id", ""),
    readCell(release, "release_label", ""),
    readCell(release, "target_binary_version", ""),
    ...metricCells(release.metrics),
  ]);
  const summary = isRecord(result.summary) ? result.summary : {};
  const totals = isRecord(summary.metrics) ? summary.metrics : null;
  const scope = SUMMARY_SCOPE.get(String(summary.coverage));

  if (totals === null || scope === undefined) {
    return renderTable(HEADERS, rows);
  }

  const table = renderTable(HEADERS, [
    ...rows,
    [scope.total, "", "", ...metricCells(totals)],
  ]);
  const rate = formatSuccessRate(totals.success_rate);

  return `${table}\n${palette.dim(`Success rate (${scope.rate}): ${rate}`)}\n`;
}
