import type { ReleaseShowCommand } from "../commandTypes";
import { authenticatedRequest } from "../authenticatedRequest";
import { isRecord } from "../output";
import { readPath, type ObjectField } from "../resultView";
import { resolveReleaseId } from "./resolveNames";
import { buildApiUrl, type CommandDeps } from "./shared";

export async function executeReleaseShow(
  command: ReleaseShowCommand,
  deps: CommandDeps,
): Promise<unknown> {
  const releaseId = await resolveReleaseId(
    command.release,
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
    url: buildApiUrl(
      command.serverUrl,
      `/v1/releases/${encodeURIComponent(releaseId)}`,
    ),
  });
}

/**
 * The rows the dashboard's release page shows, under its names. Paths are the
 * server wire format (toReleaseWire, toReleaseJobWire), snake_case throughout.
 * Whatever is not named here still prints, under its raw path.
 */
export const RELEASE_SHOW_FIELDS: readonly ObjectField[] = [
  ["Label", "release.release_label"],
  ["Status", "release.status"],
  ["Target version", "release.target_binary_version"],
  ["Rollout", "release.rollout_percentage"],
  ["Mandatory", "release.is_mandatory"],
  ["Release ID", "release.id"],
  ["Notes", "release.release_notes"],
  ["Package hash", "release.target_package_hash"],
  ["Fingerprint", "release.fingerprint"],
  {
    cell: (record) => {
      const signature = readPath(record, "release.signature");

      if (signature === undefined) {
        return undefined;
      }

      if (typeof signature !== "string" || signature.length === 0) {
        return "no";
      }

      const algorithm = readPath(record, "release.signature_hash_algorithm");
      return typeof algorithm === "string" ? `yes (${algorithm})` : "yes";
    },
    label: "Signed",
    reads: ["release.signature", "release.signature_hash_algorithm"],
  },
  ["Rollback of", "release.rollback_of"],
  failureField("Failure", "release"),
  {
    cell: (record) => {
      const createdAt = readPath(record, "release.created_at");
      const createdBy = readPath(record, "release.created_by");

      if (typeof createdAt !== "string") {
        return undefined;
      }

      return typeof createdBy === "string"
        ? `${createdAt} by ${createdBy}`
        : createdAt;
    },
    label: "Created",
    reads: ["release.created_at", "release.created_by"],
  },
  ["Updated", "release.updated_at"],
  {
    cell: (record) => {
      const job = readPath(record, "job");

      if (!isRecord(job) || typeof job.status !== "string") {
        return undefined;
      }

      return [
        job.status,
        `attempt ${String(job.attempt_count ?? "-")}/${String(job.max_total_attempts ?? "-")}`,
        ...(typeof job.trigger_type === "string" ? [job.trigger_type] : []),
      ].join(" · ");
    },
    label: "Job",
    reads: [
      "job.status",
      "job.attempt_count",
      "job.max_total_attempts",
      "job.trigger_type",
    ],
  },
  failureField("Job failure", "job"),
  ["Job queued", "job.created_at"],
  ["Job updated", "job.updated_at"],
];

/**
 * Nulls that mean "nothing happened", not "not recorded": a release that is no
 * rollback, did not fail, or has no job. `job` is listed itself because a null
 * job flattens to the path `job`, not to its fields.
 */
export const RELEASE_SHOW_OMIT_NULL_PATHS: readonly string[] = [
  "release.rollback_of",
  "release.failure_stage",
  "release.failure_reason",
  "job",
  "job.failure_stage",
  "job.failure_reason",
];

/** `<stage>: <reason>`, or whichever of the two the server recorded. */
function failureField(label: string, owner: "job" | "release"): ObjectField {
  const reads = [`${owner}.failure_stage`, `${owner}.failure_reason`];

  return {
    cell: (record) => {
      const parts = reads
        .map((path) => readPath(record, path))
        .filter((part): part is string => typeof part === "string" && part.length > 0);

      return parts.length === 0 ? undefined : parts.join(": ");
    },
    label,
    reads,
  };
}
