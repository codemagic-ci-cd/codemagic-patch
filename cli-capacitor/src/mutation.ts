// The consent gate in front of every command that changes what devices receive or
// deletes something — the rule of cli/src/commands/mutationSafety.ts
// (@codemagic/patch-cli 0.4.0): --yes, or a "yes" to a prompt that is only offered
// on a real terminal, outside CI, and never with --format json.
// See cli-capacitor-tech-spec › Provenance.

import { PRODUCT_NAME } from "./branding";
import { canPrompt } from "./confirm";
import type { CliDeps } from "./deps";
import { DeclinedError, UsageError } from "./errors";
import { renderFields, writeLine, type OutputFormat } from "./output";

export interface MutationSafetyInput {
  commandName: string;
  /** Pass it (true or false) only for commands that have --dry-run: the advice names the flag. */
  dryRun?: boolean;
  /** What is about to change. Undefined values are shown as "-". */
  fields: ReadonlyArray<readonly [label: string, value: string | undefined]>;
  format: OutputFormat;
  yes: boolean;
}

/**
 * Fails — without the network, and without asking — when consent can neither be given
 * by flag nor asked for. Commands call it before they resolve names, so that a missing
 * --yes in CI costs no request; the question itself (enforceMutationSafety) comes after,
 * when it can name exactly what is about to change.
 */
export function assertConsentPossible(
  deps: CliDeps,
  input: Pick<MutationSafetyInput, "commandName" | "dryRun" | "format" | "yes">,
): void {
  if (input.dryRun === true || input.yes) {
    return;
  }

  // JSON output promises a run that never stops to ask.
  if (input.format === "json" || !canPrompt(deps)) {
    const dryRunHint =
      input.dryRun === undefined
        ? ""
        : ", or use --dry-run to inspect the payload first";
    throw new UsageError(
      `Missing --yes for ${input.commandName}. Re-run with --yes after validating the command inputs${dryRunHint}.`,
    );
  }
}

export async function enforceMutationSafety(
  deps: CliDeps,
  input: MutationSafetyInput,
): Promise<void> {
  assertConsentPossible(deps, input);
  if (input.dryRun === true || input.yes) {
    return;
  }

  writeLine(deps.stderr, `${input.commandName} will change ${PRODUCT_NAME} state:`);
  for (const line of renderFields(
    input.fields.map(([label, value]) => [label, value ?? "-"]),
  )) {
    writeLine(deps.stderr, line);
  }

  if (!(await deps.confirm(`Proceed with ${input.commandName}?`))) {
    throw new DeclinedError(`Aborted: ${input.commandName} was not confirmed.`);
  }
}
