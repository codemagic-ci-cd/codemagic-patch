// What every command that creates or changes a release answers with: one sentence
// about the release it produced, then its status, its processing job, whatever the
// command wants to add, and the server's warnings.

import type { CommandOutput } from "./command";
import { isRecord } from "./output";

type ReleaseIdentity = { id: string; label: string };

export function releaseActionOutput(
  result: unknown,
  summary: (release: ReleaseIdentity) => string,
  extraDetails: (release: ReleaseIdentity) => readonly string[] = () => [],
): CommandOutput {
  const release = isRecord(result) && isRecord(result.release) ? result.release : {};
  const job = isRecord(result) && isRecord(result.job) ? result.job : null;
  const warnings =
    isRecord(result) && Array.isArray(result.warnings) ? result.warnings.filter(isRecord) : [];
  const identity: ReleaseIdentity = {
    id: String(release.id ?? "-"),
    label: String(release.release_label ?? "-"),
  };

  return {
    details: [
      `status:       ${String(release.status ?? "-")}`,
      ...(job === null
        ? []
        : [`job:          ${String(job.id ?? "-")} (${String(job.status ?? "-")})`]),
      ...extraDetails(identity),
      ...warnings.map((warning) => `warning:      ${describeWarning(warning)}`),
    ],
    json: result,
    kind: "action",
    summary: summary(identity),
  };
}

function describeWarning(warning: Record<string, unknown>): string {
  // The server's own wording ("may be native-incompatible") assumes both values
  // are native fingerprints. Here one of them is this CLI's binary-version
  // label, so say what the mismatch actually means.
  if (
    warning.code === "fingerprint-disagreement" &&
    typeof warning.binary_version === "string" &&
    typeof warning.stored_fingerprint === "string"
  ) {
    return (
      `binary version ${warning.binary_version} of this deployment already has the native fingerprint ` +
      `${warning.stored_fingerprint} on record, from a release published with another tool. ` +
      "cmpatch-capacitor computes no fingerprint — it scopes a release to its binary version — " +
      "so the server reports the two as different. The release was accepted."
    );
  }

  return typeof warning.detail === "string" ? warning.detail : JSON.stringify(warning);
}
