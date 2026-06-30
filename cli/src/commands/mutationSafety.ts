import { PRODUCT_NAME } from "../branding";
import { isInteractiveOutput, writeLine } from "../output";
import { type CommandDeps, UsageError } from "./shared";

export type MutationSafetyInput = {
  commandName: string;
  dryRun?: boolean;
  fields: Array<[string, string | undefined]>;
  nonInteractive: boolean;
  yes: boolean;
};

export function enforceMutationSafety(
  deps: CommandDeps,
  input: MutationSafetyInput,
): void {
  if (input.dryRun === true || input.yes) {
    return;
  }

  if (deps.stderr !== undefined && isInteractiveOutput(deps.stderr)) {
    writeLine(
      deps.stderr,
      `${input.commandName} will mutate ${PRODUCT_NAME} state:`,
    );
    for (const [key, value] of input.fields) {
      writeLine(deps.stderr, `  ${key}: ${value ?? "-"}`);
    }
  }

  throw new UsageError(
    `Missing --yes for ${input.commandName}. Re-run with --yes after validating the command inputs, or use --dry-run to inspect the payload first.`,
  );
}
