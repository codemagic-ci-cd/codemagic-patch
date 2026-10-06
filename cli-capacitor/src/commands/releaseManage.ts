// release list | show | inspect | patch | enable | disable | promote | rollback |
// metrics — cli/src/commands/release{List,Show,Inspect,Patch,Promote,Rollback,Metrics}.ts
// (@codemagic/patch-cli 0.4.0): the same endpoints, bodies and confirmation rule
// (patch, enable, disable, promote and rollback ask; the reads do not).
//
// One addition cmpatch does not have: a release uploaded by this CLI carries a
// `binary-version:<version>` label where cmpatch sends a native fingerprint, and the
// server records a release's fingerprint against whatever binary version it currently
// targets. Retargeting such a release — `patch --target-binary-version`, or `promote`
// with one — would make the server treat two binary versions as the same native build
// from then on, so this CLI refuses to do it (assertRetargetIsSafe).
// See cli-capacitor-tech-spec §4 and › Provenance.

import { authenticatedRequest, type ApiTarget } from "../authenticatedRequest";
import { assertExplicitBinaryVersion } from "../binaryVersion";
import { CLI_NAME } from "../branding";
import {
  APP_SELECTOR_FLAGS,
  CONNECTION_FLAGS,
  DEPLOYMENT_SELECTOR_FLAGS,
  DEPLOYMENT_USAGE,
  FORMAT_FLAG,
  PAGINATION_FLAGS,
  paginationFooter,
  readApiTarget,
  readBoolean,
  readDeploymentSelector,
  readFormat,
  readInteger,
  readMandatory,
  readPagination,
  readReleaseSelector,
  readString,
  RELEASE_SELECTOR_FLAGS,
  RELEASE_USAGE,
  YES_FLAG,
  type CommandDefinition,
  type CommandOutput,
  type FlagSpec,
  type FlagValues,
} from "../command";
import type { CliDeps } from "../deps";
import { UsageError, ValidationError } from "../errors";
import { BINARY_VERSION_FINGERPRINT_PREFIX } from "../fingerprint";
import { enforceMutationSafety } from "../mutation";
import { isRecord, writeLine } from "../output";
import { releaseActionOutput } from "../releaseOutput";
import { pathWithQuery, resolveDeploymentId, resolveReleaseId } from "../resolveNames";

const RELEASE_FIELDS = [
  ["label", "release.release_label"],
  ["id", "release.id"],
  ["status", "release.status"],
  ["target binary version", "release.target_binary_version"],
  ["rollout", "release.rollout_percentage"],
  ["mandatory", "release.is_mandatory"],
  ["release notes", "release.release_notes"],
  ["package hash", "release.target_package_hash"],
  ["fingerprint", "release.fingerprint"],
  ["deployment", "release.deployment_id"],
  ["created", "release.created_at"],
  ["job", "job.id"],
  ["job status", "job.status"],
] as const;

const MANDATORY_FLAGS: readonly FlagSpec[] = [
  { help: "Mark the release as mandatory", name: "mandatory", type: "boolean" },
  { help: "Mark the release as not mandatory", name: "not-mandatory", type: "boolean" },
];

function releaseRecord(result: unknown): CommandOutput {
  return { fields: RELEASE_FIELDS, json: result, kind: "record", record: result };
}

// --- reads -----------------------------------------------------------------

export async function releaseListOutput(
  values: FlagValues,
  deps: CliDeps,
  includeMetrics: boolean,
): Promise<CommandOutput> {
  const selector = readDeploymentSelector(values);
  const { limit, offset } = readPagination(values);
  const target = readApiTarget(values, deps);
  const deploymentId = await resolveDeploymentId(deps, target, selector);
  const result = await authenticatedRequest(
    deps,
    target,
    pathWithQuery(`/v1/deployments/${encodeURIComponent(deploymentId)}/releases`, {
      include: includeMetrics ? "metrics" : undefined,
      limit,
      offset,
    }),
    { method: "GET" },
  );
  const rows =
    isRecord(result) && Array.isArray(result.releases) ? result.releases.filter(isRecord) : [];

  return {
    columns: [
      { header: "LABEL", path: "release.release_label" },
      { header: "STATUS", path: "release.status" },
      { header: "TARGET", path: "release.target_binary_version" },
      { header: "ROLLOUT", path: "release.rollout_percentage" },
      { header: "MANDATORY", path: "release.is_mandatory" },
      ...(includeMetrics
        ? [
            { header: "ACTIVE", path: "metrics.active" },
            { header: "APPLIED", path: "metrics.success" },
            { header: "FAILED", path: "metrics.failed" },
          ]
        : []),
      { header: "CREATED", path: "release.created_at" },
      { header: "ID", path: "release.id" },
    ],
    empty: "This deployment has no releases yet.",
    ...paginationFooter(result, rows.length, "releases"),
    json: result,
    kind: "list",
    rows,
  };
}

const releaseList: CommandDefinition = {
  flags: [
    ...DEPLOYMENT_SELECTOR_FLAGS,
    {
      help: "`metrics` adds each release's adoption numbers",
      name: "include",
      type: "string",
      value: "metrics",
    },
    ...PAGINATION_FLAGS,
    ...CONNECTION_FLAGS,
    FORMAT_FLAG,
  ],
  path: ["release", "list"],
  run: async (values, deps) => {
    const include = readString(values, "include");
    if (include !== undefined && include !== "metrics") {
      throw new UsageError(`--include only knows "metrics" (got "${include}").`);
    }

    return releaseListOutput(values, deps, include === "metrics");
  },
  summary: "List a deployment's releases, newest first",
  usage: `${DEPLOYMENT_USAGE} [--include metrics] [--limit <n>] [--offset <n>] [flags]`,
};

const releaseShow: CommandDefinition = {
  flags: [...RELEASE_SELECTOR_FLAGS, ...CONNECTION_FLAGS, FORMAT_FLAG],
  path: ["release", "show"],
  run: async (values, deps) => {
    const selector = readReleaseSelector(values);
    const target = readApiTarget(values, deps);
    const releaseId = await resolveReleaseId(deps, target, selector);

    return releaseRecord(await readRelease(deps, target, releaseId));
  },
  summary: "Show one release and its processing job",
  usage: `${RELEASE_USAGE} [flags]`,
};

const releaseMetrics: CommandDefinition = {
  flags: [...RELEASE_SELECTOR_FLAGS, ...CONNECTION_FLAGS, FORMAT_FLAG],
  path: ["release", "metrics"],
  run: async (values, deps) => {
    const selector = readReleaseSelector(values);
    const target = readApiTarget(values, deps);
    const releaseId = await resolveReleaseId(deps, target, selector);
    const result = await authenticatedRequest(
      deps,
      target,
      `/v1/metrics/releases/${encodeURIComponent(releaseId)}`,
      { method: "GET" },
    );

    return {
      fields: [
        ["label", "release_label"],
        ["id", "release_id"],
        ["target binary version", "target_binary_version"],
        ["active", "metrics.active"],
        ["downloaded", "metrics.downloaded"],
        ["ready", "metrics.installed"],
        ["applied", "metrics.success"],
        ["failed", "metrics.failed"],
      ],
      json: result,
      kind: "record",
      record: isRecord(result) ? result.release : result,
    };
  },
  summary: "Show one release's adoption numbers",
  usage: `${RELEASE_USAGE} [flags]`,
};

const POLL_INTERVAL_MS = 2_000;
const DEFAULT_WAIT_TIMEOUT_SECONDS = 300;
const TERMINAL_JOB_STATUSES = new Set(["dead_letter", "failed", "succeeded"]);
const FAILED_JOB_STATUSES = new Set(["dead_letter", "failed"]);
const TERMINAL_RELEASE_STATUSES = new Set(["disabled", "failed", "published"]);

const releaseInspect: CommandDefinition = {
  flags: [
    ...RELEASE_SELECTOR_FLAGS,
    {
      help: "Wait until the server has finished processing the release; fail if it failed",
      name: "wait",
      type: "boolean",
    },
    {
      help: `How long --wait waits (default: ${DEFAULT_WAIT_TIMEOUT_SECONDS})`,
      name: "timeout-seconds",
      type: "string",
      value: "n",
    },
    ...CONNECTION_FLAGS,
    FORMAT_FLAG,
  ],
  notes: [
    "`release create` returns as soon as the upload is accepted; the server then builds",
    "the release in a job. `inspect --wait` is how a pipeline learns whether it published.",
  ],
  path: ["release", "inspect"],
  run: async (values, deps) => {
    const selector = readReleaseSelector(values);
    const wait = readBoolean(values, "wait");
    const timeoutSeconds =
      readInteger(values, "timeout-seconds", { min: 1 }) ?? DEFAULT_WAIT_TIMEOUT_SECONDS;
    const format = readFormat(values);
    const target = readApiTarget(values, deps);
    const releaseId = await resolveReleaseId(deps, target, selector);
    const deadline = deps.now() + timeoutSeconds * 1000;
    let lastReportedStatus: string | null = null;

    for (;;) {
      const inspection = inspect(await readRelease(deps, target, releaseId));

      if (!wait) {
        return inspection.output;
      }

      if (inspection.failure !== null) {
        throw new ValidationError(inspection.failure);
      }

      if (inspection.terminal) {
        return inspection.output;
      }

      if (deps.now() >= deadline) {
        throw new ValidationError(
          `Timed out after ${timeoutSeconds}s waiting for release ${releaseId}. Latest status: ${inspection.status}.`,
        );
      }

      if (inspection.status !== lastReportedStatus && format === "text") {
        lastReportedStatus = inspection.status;
        writeLine(deps.stderr, `Waiting for release ${releaseId} — status: ${inspection.status}`);
      }

      await deps.sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - deps.now())));
    }
  },
  summary: "Check whether a release was processed; --wait blocks until it is",
  usage: `${RELEASE_USAGE} [--wait] [--timeout-seconds <n>] [flags]`,
};

function inspect(result: unknown): {
  failure: string | null;
  output: CommandOutput;
  status: string;
  terminal: boolean;
} {
  if (!isRecord(result) || !isRecord(result.release)) {
    throw new Error('Malformed release response: expected { "release": object, "job": object|null }');
  }

  const release = result.release;
  const job = isRecord(result.job) ? result.job : null;
  const jobStatus = typeof job?.status === "string" ? job.status : null;
  const releaseStatus = typeof release.status === "string" ? release.status : "unknown";
  const status = jobStatus ?? releaseStatus;
  const terminal =
    jobStatus !== null
      ? TERMINAL_JOB_STATUSES.has(jobStatus)
      : TERMINAL_RELEASE_STATUSES.has(releaseStatus);
  const failed =
    jobStatus !== null && FAILED_JOB_STATUSES.has(jobStatus)
      ? job
      : releaseStatus === "failed"
        ? release
        : null;
  const failure =
    failed === null
      ? null
      : `Release ${String(release.id ?? "-")} failed (${status}): stage=${String(failed.failure_stage ?? "unknown")} reason=${String(failed.failure_reason ?? "unknown")}`;
  const inspection = { status, terminal };

  return {
    failure,
    output: {
      fields: [["state", "inspection.status"], ["finished", "inspection.terminal"], ...RELEASE_FIELDS],
      json: { inspection, job, release },
      kind: "record",
      record: { inspection, job, release },
    },
    status,
    terminal,
  };
}

async function readRelease(deps: CliDeps, target: ApiTarget, releaseId: string): Promise<unknown> {
  return authenticatedRequest(deps, target, `/v1/releases/${encodeURIComponent(releaseId)}`, {
    method: "GET",
  });
}

// --- mutations -------------------------------------------------------------

/**
 * Refuses to move a release this CLI uploaded onto another binary version. See the
 * header of this file; a release that carries a computed fingerprint (one published
 * with cmpatch) is cmpatch's to reason about and passes through.
 */
function assertRetargetIsSafe(release: unknown, targetBinaryVersion: string): void {
  const record = isRecord(release) && isRecord(release.release) ? release.release : {};
  const fingerprint = typeof record.fingerprint === "string" ? record.fingerprint : "";

  if (
    !fingerprint.startsWith(BINARY_VERSION_FINGERPRINT_PREFIX) ||
    fingerprint === `${BINARY_VERSION_FINGERPRINT_PREFIX}${targetBinaryVersion}`
  ) {
    return;
  }

  throw new UsageError(
    [
      `Release ${String(record.release_label ?? record.id ?? "")} was published for binary version ${fingerprint.slice(BINARY_VERSION_FINGERPRINT_PREFIX.length)} and cannot be moved to ${targetBinaryVersion}.`,
      "The server would record the two versions as the same native build and deliver every later release for one to the other as well.",
      `Next: publish the bundle again for ${targetBinaryVersion} with \`${CLI_NAME} release create --target-binary-version ${targetBinaryVersion}\`.`,
    ].join("\n"),
  );
}

async function patchRelease(
  values: FlagValues,
  deps: CliDeps,
  commandName: string,
  patch: Record<string, unknown>,
  verb: string,
): Promise<CommandOutput> {
  const selector = readReleaseSelector(values);
  const target = readApiTarget(values, deps);
  const releaseId = await resolveReleaseId(deps, target, selector);

  if (typeof patch.target_binary_version === "string") {
    assertRetargetIsSafe(await readRelease(deps, target, releaseId), patch.target_binary_version);
  }

  await enforceMutationSafety(deps, {
    commandName,
    fields: [
      ["serverUrl", target.serverUrl],
      ["releaseId", releaseId],
      ...Object.entries(patch).map(([key, value]) => [key, String(value)] as const),
    ],
    format: readFormat(values),
    yes: readBoolean(values, "yes"),
  });

  const result = await authenticatedRequest(
    deps,
    target,
    `/v1/releases/${encodeURIComponent(releaseId)}`,
    {
      body: JSON.stringify(patch),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    },
  );

  // 204: the release already is what the patch asks for. There is no release to
  // describe, and "Disabled release - (-)" would read as if something had happened.
  if (result === null) {
    return {
      json: { changed: false, id: releaseId },
      kind: "action",
      summary: `Nothing to change: release ${releaseId} already matches.`,
    };
  }

  return releaseActionOutput(result, ({ id, label }) => `${verb} release ${label} (${id}).`);
}

const releasePatch: CommandDefinition = {
  flags: [
    ...RELEASE_SELECTOR_FLAGS,
    {
      help: "Share of devices offered the release, 1-100. It can be raised, not lowered",
      name: "rollout-percentage",
      type: "string",
      value: "1-100",
    },
    ...MANDATORY_FLAGS,
    { help: "Replace the release notes", name: "release-notes", type: "string", value: "text" },
    {
      help: "Move the release to another binary version (refused for releases this CLI uploaded)",
      name: "target-binary-version",
      type: "string",
      value: "version",
    },
    YES_FLAG,
    ...CONNECTION_FLAGS,
    FORMAT_FLAG,
  ],
  notes: ["To take a release out of service and back, use `release disable` / `release enable`."],
  path: ["release", "patch"],
  run: async (values, deps) => {
    const rollout = readInteger(values, "rollout-percentage", { max: 100, min: 1 });
    const mandatory = readMandatory(values);
    const targetBinaryVersion = readString(values, "target-binary-version");
    if (targetBinaryVersion !== undefined) {
      assertExplicitBinaryVersion(targetBinaryVersion);
    }

    // Only what was asked for: the server treats an absent field as "leave it".
    const patch: Record<string, unknown> = {
      ...(mandatory !== undefined ? { is_mandatory: mandatory } : {}),
      ...(values["release-notes"] !== undefined ? { release_notes: values["release-notes"] } : {}),
      ...(rollout !== undefined ? { rollout_percentage: rollout } : {}),
      ...(targetBinaryVersion !== undefined ? { target_binary_version: targetBinaryVersion } : {}),
    };
    if (Object.keys(patch).length === 0) {
      throw new UsageError(
        "Specify at least one change: --rollout-percentage, --mandatory | --not-mandatory, --release-notes or --target-binary-version.",
      );
    }

    return patchRelease(values, deps, "release patch", patch, "Updated");
  },
  summary: "Change a release's rollout, mandatory flag, notes or target",
  usage: `${RELEASE_USAGE} [--rollout-percentage <1-100>] [--mandatory | --not-mandatory] [--release-notes <text>] [--yes] [flags]`,
};

const STATUS_FLAGS: readonly FlagSpec[] = [
  ...RELEASE_SELECTOR_FLAGS,
  YES_FLAG,
  ...CONNECTION_FLAGS,
  FORMAT_FLAG,
];

const releaseDisable: CommandDefinition = {
  flags: STATUS_FLAGS,
  notes: [
    "The deployment goes back to offering the release before this one (or, if there is",
    "none, the bundle built into the app) — to devices already running this release too,",
    "on their next check. `release enable` undoes it. For a recorded step back that gets",
    "a label of its own, use `release rollback` instead.",
  ],
  path: ["release", "disable"],
  run: async (values, deps) =>
    patchRelease(values, deps, "release disable", { status: "disabled" }, "Disabled"),
  summary: "Stop offering a release",
  usage: `${RELEASE_USAGE} [--yes] [flags]`,
};

const releaseEnable: CommandDefinition = {
  flags: STATUS_FLAGS,
  path: ["release", "enable"],
  run: async (values, deps) =>
    patchRelease(values, deps, "release enable", { status: "published" }, "Enabled"),
  summary: "Offer a disabled release again",
  usage: `${RELEASE_USAGE} [--yes] [flags]`,
};

const SOURCE_FLAGS = { deployment: "source-deployment", deploymentId: "source-deployment-id" };
const DEST_FLAGS = { deployment: "dest-deployment", deploymentId: "dest-deployment-id" };

const releasePromote: CommandDefinition = {
  flags: [
    ...APP_SELECTOR_FLAGS,
    { help: "Deployment the release is in, by name", name: "source-deployment", type: "string", value: "name" },
    { help: "Deployment the release is in, by id", name: "source-deployment-id", type: "string", value: "id" },
    { help: "Release to promote, by label", name: "label", type: "string", value: "label" },
    { help: "Release to promote, by id (instead of a source deployment with --label)", name: "release-id", type: "string", value: "id" },
    { help: "Deployment to promote into, by name (same app)", name: "dest-deployment", type: "string", value: "name" },
    { help: "Deployment to promote into, by id", name: "dest-deployment-id", type: "string", value: "id" },
    { help: "Share of devices offered the new release (default: 100)", name: "rollout-percentage", type: "string", value: "1-100" },
    ...MANDATORY_FLAGS,
    { help: "Promote without making the new release available", name: "disabled", type: "boolean" },
    { help: "Notes for the new release (default: the source's)", name: "release-notes", type: "string", value: "text" },
    { help: "Accept a bundle identical to the destination's latest release", name: "no-duplicate-release-error", type: "boolean" },
    {
      help: "Target another binary version (refused for releases this CLI uploaded)",
      name: "target-binary-version",
      type: "string",
      value: "version",
    },
    YES_FLAG,
    ...CONNECTION_FLAGS,
    FORMAT_FLAG,
  ],
  notes: [
    "Creates a new release in the destination from the source's bundle — the usual way",
    "to ship to Production exactly what was tested in Staging. Nothing is re-uploaded.",
    "",
    "A deployment *name* needs the app it belongs to: --app (or --app-id) covers the",
    "source and the destination alike, and is not needed when both are given by id.",
  ],
  path: ["release", "promote"],
  run: async (values, deps) => {
    const source = readReleaseSelector(values, SOURCE_FLAGS);
    const destination = readDeploymentSelector(values, DEST_FLAGS);
    const rollout = readInteger(values, "rollout-percentage", { max: 100, min: 1 }) ?? 100;
    const mandatory = readMandatory(values);
    const targetBinaryVersion = readString(values, "target-binary-version");
    if (targetBinaryVersion !== undefined) {
      assertExplicitBinaryVersion(targetBinaryVersion);
    }

    const target = readApiTarget(values, deps);
    const sourceReleaseId = await resolveReleaseId(deps, target, source);
    const destinationDeploymentId = await resolveDeploymentId(deps, target, destination);
    if (targetBinaryVersion !== undefined) {
      assertRetargetIsSafe(await readRelease(deps, target, sourceReleaseId), targetBinaryVersion);
    }

    const body: Record<string, unknown> = {
      destination_deployment_id: destinationDeploymentId,
      disabled: readBoolean(values, "disabled"),
      ...(mandatory !== undefined ? { is_mandatory: mandatory } : {}),
      no_duplicate_release_error: readBoolean(values, "no-duplicate-release-error"),
      ...(values["release-notes"] !== undefined ? { release_notes: values["release-notes"] } : {}),
      rollout_percentage: rollout,
      ...(targetBinaryVersion !== undefined ? { target_binary_version: targetBinaryVersion } : {}),
    };

    await enforceMutationSafety(deps, {
      commandName: "release promote",
      fields: [
        ["serverUrl", target.serverUrl],
        ["sourceReleaseId", sourceReleaseId],
        ["destinationDeploymentId", destinationDeploymentId],
        ["targetBinaryVersion", targetBinaryVersion],
        ["rollout", String(rollout)],
        ["mandatory", mandatory === undefined ? undefined : String(mandatory)],
        ["disabled", String(body.disabled)],
      ],
      format: readFormat(values),
      yes: readBoolean(values, "yes"),
    });

    return releaseActionOutput(
      await authenticatedRequest(
        deps,
        target,
        `/v1/releases/${encodeURIComponent(sourceReleaseId)}/promote`,
        {
          body: JSON.stringify(body),
          headers: {
            "content-type": "application/json",
            "idempotency-key": deps.randomUUID(),
          },
          method: "POST",
        },
      ),
      ({ id, label }) => `Promoted to release ${label} (${id}).`,
    );
  },
  summary: "Release a tested bundle to another deployment, e.g. Staging to Production",
  usage:
    "(--source-deployment <name> --label <label> | --source-deployment-id <id> --label <label> | --release-id <id>) (--dest-deployment <name> | --dest-deployment-id <id>) [--app <name> | --app-id <id>] [--yes] [flags]",
};

const releaseRollback: CommandDefinition = {
  flags: [
    ...DEPLOYMENT_SELECTOR_FLAGS,
    {
      help: "Release to go back to (default: the one before the latest)",
      name: "label",
      type: "string",
      value: "label",
    },
    YES_FLAG,
    ...CONNECTION_FLAGS,
    FORMAT_FLAG,
  ],
  notes: [
    "Publishes a new release with the bundle of an earlier one, so devices move back to",
    "it the way they move to any update.",
  ],
  path: ["release", "rollback"],
  run: async (values, deps) => {
    const selector = readDeploymentSelector(values);
    const label = readString(values, "label");
    const target = readApiTarget(values, deps);
    const deploymentId = await resolveDeploymentId(deps, target, selector);

    await enforceMutationSafety(deps, {
      commandName: "release rollback",
      fields: [
        ["serverUrl", target.serverUrl],
        ["deploymentId", deploymentId],
        ["targetReleaseLabel", label],
      ],
      format: readFormat(values),
      yes: readBoolean(values, "yes"),
    });

    return releaseActionOutput(
      await authenticatedRequest(
        deps,
        target,
        `/v1/deployments/${encodeURIComponent(deploymentId)}/rollback`,
        {
          body: JSON.stringify(label === undefined ? {} : { target_release_label: label }),
          headers: {
            "content-type": "application/json",
            "idempotency-key": deps.randomUUID(),
          },
          method: "POST",
        },
      ),
      ({ id, label }) => `Rolled back with release ${label} (${id}).`,
    );
  },
  summary: "Move a deployment back to an earlier release",
  usage: `${DEPLOYMENT_USAGE} [--label <label>] [--yes] [flags]`,
};

export const releaseManageCommands: readonly CommandDefinition[] = [
  releaseList,
  releaseShow,
  releaseInspect,
  releasePatch,
  releaseDisable,
  releaseEnable,
  releasePromote,
  releaseRollback,
  releaseMetrics,
];
