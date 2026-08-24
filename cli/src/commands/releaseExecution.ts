export interface InteractionContext {
  mode: "interactive" | "non-interactive";
  explicitYes: boolean;
  /**
   * The run's effective stdout is machine-parsed JSON (explicit --format json,
   * or the piped-stdout default). Machine-output runs never stop on a
   * publication prompt, and their response body must stay verbatim. Mutation
   * confirms are deliberately not gated on this: they stay available to piped
   * runs (see runCli's execution-deps note).
   */
  machineOutput: boolean;
}

export interface ReleaseExecutionContext {
  mutationSafety: "required" | "already-satisfied";
}

export function interactionContextFromCommand(command: {
  machineOutput?: true;
  nonInteractive?: true;
  yes?: true;
}): InteractionContext {
  return {
    explicitYes: command.yes === true,
    machineOutput: command.machineOutput === true,
    mode: command.nonInteractive === true ? "non-interactive" : "interactive",
  };
}
