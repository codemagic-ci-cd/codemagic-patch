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

import { CODE_SIGNING_DOCS_URL } from "./branding";
import { isRecord } from "./output";
import { getProblemTypeSuffix, type ProblemDetails } from "./problem-details";

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

  // A write an API token may not make (credentials, access, app transfer). The
  // CLI sends `--token` first, then CODEMAGIC_PATCH_TOKEN, then the stored
  // login, so a browser login alone would not be used while either is set.
  if (problem.reason === "session_required") {
    return "This command needs a browser sign-in. Remove --token and unset CODEMAGIC_PATCH_TOKEN, then run `cmpatch login` (without --token).";
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

/** What `app transfer` knows about the request a problem answered. */
export type AppTransferProblemContext = {
  appName: string;
  /** The destination's name when one was resolved, otherwise its id. */
  destTeam: string;
};

/**
 * The transfer route's problems carry no `reason`, and the statuses they use
 * mean something else on other routes — a 403 anywhere is "forbidden" — so
 * these are keyed on status, type and field error, and applied only to the
 * transfer request itself, never at the point every problem enters the CLI.
 */
export function withAppTransferProblemHint(
  problem: ProblemDetails,
  context: AppTransferProblemContext,
): ProblemDetails {
  if (typeof problem.hint === "string" && problem.hint.length > 0) {
    return problem;
  }

  const hint = findAppTransferHint(problem, context);

  return hint === undefined ? problem : { ...problem, hint };
}

function findAppTransferHint(
  problem: ProblemDetails,
  { appName, destTeam }: AppTransferProblemContext,
): string | undefined {
  const typeSuffix = getProblemTypeSuffix(problem.type);

  // The same-team refusal: the only `team_id` error the route reports as an
  // invalid value (a missing or blank one is `required` / `invalid_type`).
  if (
    problem.status === 400 &&
    typeSuffix === "validation-error" &&
    hasFieldError(problem, "team_id", "invalid_value")
  ) {
    return `App ${appName} is already in team ${destTeam}. Pass another team with --dest-team or --dest-team-id; \`cmpatch team list\` shows them.`;
  }

  // The route checks manage on the app, then create in the destination, and
  // answers both refusals the same way.
  if (problem.status === 403 && typeSuffix === "forbidden") {
    return `You cannot create apps in team ${destTeam}, or cannot manage app ${appName}; a transfer needs both. Ask an admin of team ${destTeam} for a role that can create apps.`;
  }

  // The name clash, not the active-release-job conflict, which carries the
  // job it is waiting for.
  if (
    problem.status === 409 &&
    typeSuffix === "app-conflict" &&
    problem.active_job === undefined
  ) {
    return `Team ${destTeam} already has an app named ${appName}. Rename one of them first with \`cmpatch app rename\`.`;
  }

  return undefined;
}

function hasFieldError(
  problem: ProblemDetails,
  field: string,
  reason: string,
): boolean {
  const fieldErrors = Array.isArray(problem.errors) ? problem.errors : [];

  return fieldErrors.some(
    (fieldError) =>
      isRecord(fieldError) &&
      fieldError.field === field &&
      fieldError.reason === reason,
  );
}
