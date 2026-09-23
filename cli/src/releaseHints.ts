import { getProblemTypeSuffix, type ProblemDetails } from "./problem-details";

/** The one command that blocks until a release's worker job settles. */
export function releaseInspectWaitCommand(releaseId: string): string {
  return `cmpatch release inspect --release-id ${releaseId} --wait`;
}

/**
 * A resolution hint the CLI derives from a server problem when the server
 * itself sends none. Both 409s below read alike to a user ("the deployment is
 * busy") but need opposite reactions: an active release job clears on its own
 * once the worker finishes, an active partial rollout never does — so each hint
 * says which, names the release involved when the problem carries it, and gives
 * the exact command to run. Human output only: `--format json` forwards the
 * server body untouched.
 */
export function deriveProblemHint(problem: ProblemDetails): string | null {
  switch (getProblemTypeSuffix(problem.type)) {
    case "active-release-job":
      return activeReleaseJobHint(problem);
    case "release-conflict":
      return ACTIVE_ROLLOUT_HINT;
    default:
      return null;
  }
}

const ACTIVE_ROLLOUT_HINT = [
  "Waiting does not resolve this: a deployment allows one partial rollout at a time.",
  "Complete the current rollout with `cmpatch release patch --release-id <release-id> --rollout-percentage 100`",
  "or stop it with `cmpatch release disable --release-id <release-id>`, then retry this command.",
  "`cmpatch release list` for this deployment shows which release is rolling out.",
].join(" ");

function activeReleaseJobHint(problem: ProblemDetails): string {
  const activeJob = problem.active_job;
  const releaseId = readString(activeJob, "release_id");
  if (releaseId === null) {
    return "Wait for the deployment's active release job to finish (`cmpatch release inspect --release-id <release-id> --wait` on that release), then retry this command.";
  }

  const status = readString(activeJob, "status");
  const job = status === null ? "an active release job" : `a ${status} release job`;
  return `Release ${releaseId} still has ${job} on this deployment. Wait for it to finish with \`${releaseInspectWaitCommand(releaseId)}\`, then retry this command.`;
}

function readString(record: unknown, key: string): string | null {
  if (typeof record !== "object" || record === null) {
    return null;
  }
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}
