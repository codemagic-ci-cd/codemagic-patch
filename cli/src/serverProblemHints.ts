// What to do about a server problem, in this CLI's commands.
//
// The server states the problem and leaves the remedy to whoever asked: it
// answers `cmpatch`, `cmpatch-capacitor` and the dashboard from the same
// routes, so a sentence naming a `cmpatch` command could only ever be right for
// one of the three. It is also self-hosted, which means a server installed
// today still answers CLIs released years from now — and only the program that
// defines a command can still name it correctly by then.
//
// The top-level `reason` is the whole key: it is the stable machine-readable
// code, where the prose is wording the server is free to change. Its absence
// matters just as much. A server old enough not to send it is a server whose
// `detail` still spells out the `cmpatch` command to run, so adding a hint
// there would say the same thing twice.

import { SOURCE_REPO_URL } from "./branding";
import { isRecord } from "./output";
import type { ProblemDetails } from "./problem-details";

const CODE_SIGNING_DOCS_URL = `${SOURCE_REPO_URL}#code-signing-optional`;

const SIGNING_COMMANDS =
  "`cmpatch bundle --private-key-path <pem>` or `cmpatch release-react --private-key-path <pem>`";

/** Which of the two missing-signature cases the server reported as `required`. */
type MissingSignatureField = "metadata.signature" | "signature";

const SIGNATURE_REQUIRED_HINTS: Readonly<
  Record<MissingSignatureField, string>
> = {
  // An upload that arrived unsigned: the next build can carry the signature.
  "metadata.signature": `Rebuild with the app's code-signing private key: ${SIGNING_COMMANDS}. See ${CODE_SIGNING_DOCS_URL}`,
  // A release already stored on the server, about to be enabled, promoted or
  // rolled back to. Nothing can add a signature to it now, so the honest advice
  // is to publish the bundle again rather than to re-run the failed command.
  // The server's own sentence says why; the hint adds only the commands.
  signature: `Publish the bundle again, signed: ${SIGNING_COMMANDS}. See ${CODE_SIGNING_DOCS_URL}`,
};

/**
 * The problem as `cmpatch` shows it: the server's own words, plus what to run
 * next. A hint the server sent itself wins — it knows something this table
 * cannot.
 */
export function withServerProblemHint(problem: ProblemDetails): ProblemDetails {
  if (typeof problem.hint === "string" && problem.hint.length > 0) {
    return problem;
  }

  const hint = findHint(problem);

  return hint === undefined ? problem : { ...problem, hint };
}

function findHint(problem: ProblemDetails): string | undefined {
  if (problem.reason === "invalid_cli_authorization_code") {
    return "Run `cmpatch login` again.";
  }

  if (problem.reason === "signature_required") {
    return SIGNATURE_REQUIRED_HINTS[missingSignatureField(problem)];
  }

  return undefined;
}

function missingSignatureField(
  problem: ProblemDetails,
): MissingSignatureField {
  const fieldErrors = Array.isArray(problem.errors) ? problem.errors : [];
  const namesStoredRelease = fieldErrors.some(
    (fieldError) =>
      isRecord(fieldError) &&
      fieldError.reason === "required" &&
      fieldError.field === "signature",
  );

  // An upload is the other case, and the one a server that named no field can
  // still be helped with: it is the only one where re-running is the answer.
  return namesStoredRelease ? "signature" : "metadata.signature";
}
