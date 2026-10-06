// deployment create | list | rename | remove | clear | metrics | history —
// cli/src/commands/deployment*.ts (@codemagic/patch-cli 0.4.0): the same endpoints and
// bodies, and the same rule for what needs confirmation (`remove` and `clear`).
// See cli-capacitor-tech-spec › Provenance.

import { authenticatedRequest } from "../authenticatedRequest";
import {
  APP_SELECTOR_FLAGS,
  APP_USAGE,
  CONNECTION_FLAGS,
  DEPLOYMENT_SELECTOR_FLAGS,
  DEPLOYMENT_USAGE,
  deletedOutput,
  describeSelector,
  FORMAT_FLAG,
  PAGINATION_FLAGS,
  paginationFooter,
  readApiTarget,
  readAppSelector,
  readBoolean,
  readDeploymentSelector,
  readFormat,
  readPagination,
  requireString,
  YES_FLAG,
  type CommandDefinition,
  type CommandOutput,
} from "../command";
import { assertConsentPossible, enforceMutationSafety } from "../mutation";
import { isRecord } from "../output";
import { pathWithQuery, resolveAppId, resolveDeploymentId } from "../resolveNames";
import { releaseListOutput } from "./releaseManage";

const DEPLOYMENT_FIELDS = [
  ["name", "name"],
  ["id", "id"],
  ["deployment key", "deployment_key"],
  ["app", "app_id"],
  ["created", "created_at"],
] as const;

function deploymentRecord(result: unknown): CommandOutput {
  return {
    fields: DEPLOYMENT_FIELDS,
    json: result,
    kind: "record",
    record: isRecord(result) ? result.deployment : result,
  };
}

const deploymentCreate: CommandDefinition = {
  flags: [
    { help: "Name of the new deployment, e.g. Beta", name: "name", type: "string", value: "name" },
    ...APP_SELECTOR_FLAGS,
    ...CONNECTION_FLAGS,
    FORMAT_FLAG,
  ],
  path: ["deployment", "create"],
  run: async (values, deps) => {
    const name = requireString(values, "name");
    const selector = readAppSelector(values);
    const target = readApiTarget(values, deps);
    const appId = await resolveAppId(deps, target, selector);

    return deploymentRecord(
      await authenticatedRequest(
        deps,
        target,
        `/v1/apps/${encodeURIComponent(appId)}/deployments`,
        {
          body: JSON.stringify({ name }),
          headers: {
            "content-type": "application/json",
            "idempotency-key": deps.randomUUID(),
          },
          method: "POST",
        },
      ),
    );
  },
  summary: "Add a deployment to an app",
  usage: `${APP_USAGE} --name <name> [flags]`,
};

const deploymentList: CommandDefinition = {
  flags: [...APP_SELECTOR_FLAGS, ...CONNECTION_FLAGS, FORMAT_FLAG],
  notes: [
    "The DEPLOYMENT KEY column is what the SDK's `deploymentKey` setting takes — one key",
    "per platform, from that platform's own app.",
  ],
  path: ["deployment", "list"],
  run: async (values, deps) => {
    const selector = readAppSelector(values);
    const target = readApiTarget(values, deps);
    const appId = await resolveAppId(deps, target, selector);
    const result = await authenticatedRequest(
      deps,
      target,
      `/v1/apps/${encodeURIComponent(appId)}/deployments`,
      { method: "GET" },
    );

    return {
      columns: [
        { header: "NAME", path: "name" },
        { header: "ID", path: "id" },
        { header: "DEPLOYMENT KEY", path: "deployment_key" },
      ],
      empty: "This app has no deployments.",
      json: result,
      kind: "list",
      rows:
        isRecord(result) && Array.isArray(result.deployments)
          ? result.deployments.filter(isRecord)
          : [],
    };
  },
  summary: "List an app's deployments and their deployment keys",
  usage: `${APP_USAGE} [flags]`,
};

const deploymentRename: CommandDefinition = {
  flags: [
    { help: "The deployment's new name", name: "new-name", type: "string", value: "name" },
    ...DEPLOYMENT_SELECTOR_FLAGS,
    ...CONNECTION_FLAGS,
    FORMAT_FLAG,
  ],
  notes: ["The deployment key does not change, so installed apps are unaffected."],
  path: ["deployment", "rename"],
  run: async (values, deps) => {
    const name = requireString(values, "new-name");
    const selector = readDeploymentSelector(values);
    const target = readApiTarget(values, deps);
    const deploymentId = await resolveDeploymentId(deps, target, selector);

    return deploymentRecord(
      await authenticatedRequest(
        deps,
        target,
        `/v1/deployments/${encodeURIComponent(deploymentId)}`,
        {
          body: JSON.stringify({ name }),
          headers: { "content-type": "application/json" },
          method: "PATCH",
        },
      ),
    );
  },
  summary: "Rename a deployment",
  usage: `${DEPLOYMENT_USAGE} --new-name <name> [flags]`,
};

const deploymentRemove: CommandDefinition = {
  flags: [...DEPLOYMENT_SELECTOR_FLAGS, YES_FLAG, ...CONNECTION_FLAGS, FORMAT_FLAG],
  notes: [
    "Deletes the deployment and its releases. Apps built with its deployment key stop",
    "receiving updates. This cannot be undone.",
  ],
  path: ["deployment", "remove"],
  run: async (values, deps) => {
    const selector = readDeploymentSelector(values);
    const target = readApiTarget(values, deps);
    const consent = {
      commandName: "deployment remove",
      format: readFormat(values),
      yes: readBoolean(values, "yes"),
    };
    // As in `app remove`: fail fast on a missing --yes, but ask about the resolved id.
    assertConsentPossible(deps, consent);
    const deploymentId = await resolveDeploymentId(deps, target, selector);
    await enforceMutationSafety(deps, {
      ...consent,
      fields: [
        ["serverUrl", target.serverUrl],
        ["deployment", describeSelector(selector)],
        ["deploymentId", deploymentId],
      ],
    });
    await authenticatedRequest(
      deps,
      target,
      `/v1/deployments/${encodeURIComponent(deploymentId)}`,
      { method: "DELETE" },
    );

    return deletedOutput("deployment", deploymentId, `Removed deployment ${deploymentId}.`);
  },
  summary: "Delete a deployment and its releases",
  usage: `${DEPLOYMENT_USAGE} [--yes] [flags]`,
};

const deploymentClear: CommandDefinition = {
  flags: [...DEPLOYMENT_SELECTOR_FLAGS, YES_FLAG, ...CONNECTION_FLAGS, FORMAT_FLAG],
  notes: [
    "Removes every release from the deployment; the deployment and its key remain.",
    "Devices fall back to the bundle built into the app.",
  ],
  path: ["deployment", "clear"],
  run: async (values, deps) => {
    const selector = readDeploymentSelector(values);
    const target = readApiTarget(values, deps);
    const deploymentId = await resolveDeploymentId(deps, target, selector);
    await enforceMutationSafety(deps, {
      commandName: "deployment clear",
      fields: [
        ["serverUrl", target.serverUrl],
        ["deploymentId", deploymentId],
      ],
      format: readFormat(values),
      yes: readBoolean(values, "yes"),
    });
    const result = await authenticatedRequest(
      deps,
      target,
      `/v1/deployments/${encodeURIComponent(deploymentId)}/clear`,
      { method: "POST" },
    );

    return {
      json: result,
      kind: "action",
      summary: `Cleared the release history of deployment ${deploymentId}.`,
    };
  },
  summary: "Remove every release from a deployment",
  usage: `${DEPLOYMENT_USAGE} [--yes] [flags]`,
};

const deploymentMetrics: CommandDefinition = {
  flags: [...DEPLOYMENT_SELECTOR_FLAGS, ...PAGINATION_FLAGS, ...CONNECTION_FLAGS, FORMAT_FLAG],
  path: ["deployment", "metrics"],
  run: async (values, deps) => {
    const selector = readDeploymentSelector(values);
    const pagination = readPagination(values);
    const target = readApiTarget(values, deps);
    const deploymentId = await resolveDeploymentId(deps, target, selector);
    const result = await authenticatedRequest(
      deps,
      target,
      pathWithQuery(`/v1/metrics/deployments/${encodeURIComponent(deploymentId)}`, pagination),
      { method: "GET" },
    );
    const rows =
      isRecord(result) && Array.isArray(result.releases) ? result.releases.filter(isRecord) : [];

    return {
      columns: [
        { header: "LABEL", path: "release_label" },
        { header: "TARGET", path: "target_binary_version" },
        { header: "ACTIVE", path: "metrics.active" },
        { header: "DOWNLOADED", path: "metrics.downloaded" },
        { header: "READY", path: "metrics.installed" },
        { header: "APPLIED", path: "metrics.success" },
        { header: "FAILED", path: "metrics.failed" },
      ],
      empty: "No release of this deployment has reported metrics yet.",
      ...paginationFooter(result, rows.length, "releases"),
      json: result,
      kind: "list",
      rows,
    };
  },
  summary: "Show adoption numbers for each release of a deployment",
  usage: `${DEPLOYMENT_USAGE} [--limit <n>] [--offset <n>] [flags]`,
};

const deploymentHistory: CommandDefinition = {
  flags: [...DEPLOYMENT_SELECTOR_FLAGS, ...PAGINATION_FLAGS, ...CONNECTION_FLAGS, FORMAT_FLAG],
  notes: ["The same as `release list --include metrics`."],
  path: ["deployment", "history"],
  run: async (values, deps) => releaseListOutput(values, deps, true),
  summary: "List a deployment's releases with their metrics",
  usage: `${DEPLOYMENT_USAGE} [--limit <n>] [--offset <n>] [flags]`,
};

export const deploymentCommands: readonly CommandDefinition[] = [
  deploymentCreate,
  deploymentList,
  deploymentRename,
  deploymentRemove,
  deploymentClear,
  deploymentMetrics,
  deploymentHistory,
];
