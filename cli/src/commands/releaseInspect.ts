import type { ReleaseInspectCommand } from "../commandTypes";
import { authenticatedRequest } from "../authenticatedRequest";
import { isRecord, readCell } from "../output";
import { buildApiUrl, type CommandDeps, UsageError, ValidationError } from "./shared";
import { resolveReleaseId } from "./resolveNames";

type ReleaseInspectResult = {
  inspection: {
    nextActions: string[];
    servedManifest: {
      note: string;
      targetBinaryVersion?: string;
    };
    status: string;
    terminal: boolean;
  };
  job: Record<string, unknown> | null;
  release: Record<string, unknown>;
};

const POLL_INTERVAL_MS = 2_000;
const TERMINAL_JOB_STATUSES = new Set(["dead_letter", "failed", "succeeded"]);
const FAILED_JOB_STATUSES = new Set(["dead_letter", "failed"]);
const TERMINAL_RELEASE_STATUSES = new Set(["disabled", "failed", "published"]);
const FAILED_RELEASE_STATUSES = new Set(["failed"]);

export async function executeReleaseInspect(
  command: ReleaseInspectCommand,
  deps: CommandDeps,
): Promise<unknown> {
  if (command.logs) {
    throw new UsageError(
      "release inspect --logs requires a server worker log or event-stream API. Current API responses expose release metadata and latest job status only.",
    );
  }

  const releaseId = await resolveReleaseId(
    command.release,
    command.serverUrl,
    command.token,
    deps,
  );
  const deadline = deps.now() + command.timeoutSeconds * 1000;

  while (true) {
    const result = await readReleaseInspection(command, deps, releaseId);
    const failure = describeFailure(result);
    if (!command.wait) {
      return result;
    }

    if (failure !== null) {
      throw new ValidationError(failure);
    }

    if (result.inspection.terminal) {
      return result;
    }

    if (deps.now() >= deadline) {
      throw new ValidationError(
        `Timed out waiting for release ${releaseId}. Latest status: ${result.inspection.status}.`,
      );
    }

    await deps.sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - deps.now())));
  }
}

export function renderReleaseInspectTable(result: unknown): string {
  if (!isRecord(result) || !isRecord(result.release) || !isRecord(result.inspection)) {
    throw new UsageError(
      'Cannot render table output: expected response fields "release" and "inspection"',
    );
  }

  const job = isRecord(result.job) ? result.job : null;
  const rows = [
    ["releaseId", readCell(result.release, "id")],
    ["label", readCell(result.release, "release_label")],
    ["releaseStatus", readCell(result.release, "status")],
    ["jobStatus", job === null ? "-" : readCell(job, "status")],
    ["targetBinaryVersion", readCell(result.release, "target_binary_version")],
    ["fingerprint", readCell(result.release, "fingerprint")],
    ["rollout", readCell(result.release, "rollout_percentage")],
    ["mandatory", readCell(result.release, "is_mandatory")],
    ["next", readNextAction(result.inspection)],
  ];
  const keyWidth = Math.max(...rows.map(([key]) => key.length));

  return `${rows
    .map(([key, value]) => `${key.padEnd(keyWidth)}  ${value}`)
    .join("\n")}\n`;
}

async function readReleaseInspection(
  command: ReleaseInspectCommand,
  deps: CommandDeps,
  releaseId: string,
): Promise<ReleaseInspectResult> {
  const response = await authenticatedRequest(deps, {
    init: {
      method: "GET",
    },
    serverUrl: command.serverUrl,
    token: command.token,
    url: buildApiUrl(command.serverUrl, `/v1/releases/${encodeURIComponent(releaseId)}`),
  });

  if (!isRecord(response) || !isRecord(response.release)) {
    throw new UsageError(
      'Malformed release inspect response: expected { "release": object, "job": object|null }',
    );
  }

  const job = isRecord(response.job) ? response.job : null;
  const release = response.release;
  const status = readStatus(release, job);

  return {
    inspection: {
      nextActions: nextActions(release, job),
      servedManifest: {
        note:
          "Use the deployment key with this target binary version to check the served client manifest.",
        ...(typeof release.target_binary_version === "string"
          ? { targetBinaryVersion: release.target_binary_version }
          : {}),
      },
      status,
      terminal: isTerminal(release, job),
    },
    job,
    release,
  };
}

function readStatus(
  release: Record<string, unknown>,
  job: Record<string, unknown> | null,
): string {
  if (typeof job?.status === "string") {
    return job.status;
  }

  return typeof release.status === "string" ? release.status : "unknown";
}

function isTerminal(
  release: Record<string, unknown>,
  job: Record<string, unknown> | null,
): boolean {
  if (typeof job?.status === "string") {
    return TERMINAL_JOB_STATUSES.has(job.status);
  }

  return (
    typeof release.status === "string" &&
    TERMINAL_RELEASE_STATUSES.has(release.status)
  );
}

function describeFailure(result: ReleaseInspectResult): string | null {
  const jobStatus = typeof result.job?.status === "string" ? result.job.status : null;
  if (jobStatus !== null && FAILED_JOB_STATUSES.has(jobStatus)) {
    const stage =
      typeof result.job?.failure_stage === "string" ? result.job.failure_stage : "unknown";
    const reason =
      typeof result.job?.failure_reason === "string" ? result.job.failure_reason : "unknown";
    return `Release worker job ${jobStatus}. stage=${stage} reason=${reason}`;
  }

  const releaseStatus =
    typeof result.release.status === "string" ? result.release.status : null;
  if (releaseStatus !== null && FAILED_RELEASE_STATUSES.has(releaseStatus)) {
    const stage =
      typeof result.release.failure_stage === "string"
        ? result.release.failure_stage
        : "unknown";
    const reason =
      typeof result.release.failure_reason === "string"
        ? result.release.failure_reason
        : "unknown";
    return `Release ${releaseStatus}. stage=${stage} reason=${reason}`;
  }

  return null;
}

function nextActions(
  release: Record<string, unknown>,
  job: Record<string, unknown> | null,
): string[] {
  const status = readStatus(release, job);
  const releaseId = readCell(release, "id");

  if (status === "queued" || status === "running") {
    return [`cmpatch release inspect --release-id ${releaseId} --wait`];
  }

  if (status === "published") {
    return [
      `cmpatch release list --deployment-id ${readCell(release, "deployment_id")}`,
      `cmpatch release patch --release-id ${releaseId} --rollout-percentage <1-100>`,
    ];
  }

  if (status === "disabled") {
    return [`cmpatch release enable --release-id ${releaseId}`];
  }

  return [
    `cmpatch release show --release-id ${releaseId}`,
    `cmpatch release rollback --deployment-id ${readCell(release, "deployment_id")}`,
  ];
}

function readNextAction(inspection: Record<string, unknown>): string {
  return Array.isArray(inspection.nextActions) &&
    typeof inspection.nextActions[0] === "string"
    ? inspection.nextActions[0]
    : "-";
}
