// What to do about a server problem, in this CLI's commands. The server states a problem
// in terms of the domain and identifies it with a `reason`; which command to run and which
// flag to pass is for the client to say, because only the client knows what its commands
// are. So the server's own words are shown as they came, and the remedy is added as a
// hint. Every server *problem* (an error response) reaches the terminal through runCli.ts,
// which is where this is applied.
//
// Server text has two other ways to the terminal, and neither comes through here: the
// `warnings` of a successful response (releaseOutput.ts prints a warning's `detail`) and
// a release job's failure stage and reason (`release inspect`). That none of the three
// names a client is the server's own rule: a sentence that needs a remedy gets a
// `reason` there, and its hint here.

import { CLI_NAME } from "./branding";
import { isRecord } from "./output";
import { getProblemTypeSuffix, type ProblemDetails } from "./problem-details";

// An upload without a signature: the next run can carry one.
const UNSIGNED_UPLOAD_HINT =
  "Re-run with --private-key-path <pem>: the RSA private key whose public half the app ships as `publicKey`.";

// An existing release without one, about to be enabled, promoted or rolled back to.
// Nothing can sign it now, so the bundle has to be published again.
const UNSIGNED_RELEASE_HINT = `Publish the bundle again with \`${CLI_NAME} release create --private-key-path <pem>\`.`;

// The two 409s that read alike ("the deployment is busy") but need opposite reactions,
// worded as in the `cmpatch` CLI (upstream v0.5.0, cli/src/releaseHints.ts): an active
// release job clears on its own once the worker finishes; an active partial rollout never
// does. Neither problem carries a `reason`, so they are told apart by their type.
const ACTIVE_ROLLOUT_HINT = [
  "Waiting does not resolve this: a deployment allows one partial rollout at a time.",
  `Complete the current rollout with \`${CLI_NAME} release patch --release-id <release-id> --rollout-percentage 100\``,
  `or stop it with \`${CLI_NAME} release disable --release-id <release-id>\`, then retry this command.`,
  `\`${CLI_NAME} release list\` for this deployment shows which release is rolling out.`,
].join(" ");

/** The problem with this CLI's remedy for it. A hint the server sent itself wins. */
export function withServerProblemHint(problem: ProblemDetails): ProblemDetails {
  if (typeof problem.hint === "string" && problem.hint.length > 0) {
    return problem;
  }

  const hint = findHint(problem);
  return hint === undefined ? problem : { ...problem, hint };
}

function findHint(problem: ProblemDetails): string | undefined {
  if (problem.reason === "invalid_cli_authorization_code") {
    return `Run \`${CLI_NAME} login\` again.`;
  }

  if (problem.reason === "signature_required") {
    return missingSignatureHint(problem);
  }

  switch (getProblemTypeSuffix(problem.type)) {
    case "active-release-job":
      return activeReleaseJobHint(problem);
    case "release-conflict":
      return ACTIVE_ROLLOUT_HINT;
    default:
      return undefined;
  }
}

// Names the release whose job is still queued or running, from the problem's
// `active_job` extension, and the one command that waits for it.
function activeReleaseJobHint(problem: ProblemDetails): string {
  const activeJob = isRecord(problem.active_job) ? problem.active_job : {};
  const releaseId = nonEmptyString(activeJob.release_id);
  if (releaseId === undefined) {
    return `Wait for the deployment's active release job to finish (\`${CLI_NAME} release inspect --release-id <release-id> --wait\` on that release), then retry this command.`;
  }

  const status = nonEmptyString(activeJob.status);
  const job = status === undefined ? "an active release job" : `a ${status} release job`;
  return `Release ${releaseId} still has ${job} on this deployment. Wait for it to finish with \`${CLI_NAME} release inspect --release-id ${releaseId} --wait\`, then retry this command.`;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function missingSignatureHint(problem: ProblemDetails): string {
  const fieldErrors: unknown[] = Array.isArray(problem.errors) ? problem.errors : [];
  // The server reports which of the two it is by the field it calls `required`.
  const namesExistingRelease = fieldErrors.some(
    (fieldError) =>
      isRecord(fieldError) && fieldError.reason === "required" && fieldError.field === "signature",
  );

  return namesExistingRelease ? UNSIGNED_RELEASE_HINT : UNSIGNED_UPLOAD_HINT;
}
