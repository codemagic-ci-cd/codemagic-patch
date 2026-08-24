import {
  confirm as clackConfirm,
  isCancel,
  multiselect as clackMultiselect,
  password as clackPassword,
  select as clackSelect,
  text as clackText,
} from "@clack/prompts";

export type SelectChoice = {
  title: string;
  value: string;
};

export type PromptRequest =
  | { initial?: string; message: string; type: "text" }
  | { message: string; type: "password" }
  | {
      choices: SelectChoice[];
      initial?: number;
      message: string;
      type: "select";
    }
  | {
      choices: Array<SelectChoice & { selected?: boolean }>;
      message: string;
      min?: number;
      type: "multiselect";
    };

export type PromptFn = (request: PromptRequest) => Promise<string | string[]>;

// Confirm prompts are kept separate from PromptFn so existing callers that
// consume a string answer stay strictly typed; a confirm resolves to a boolean.
export type ConfirmRequest = {
  initial?: boolean;
  message: string;
};

export type ConfirmFn = (request: ConfirmRequest) => Promise<boolean>;

export class PromptAbortError extends Error {
  constructor() {
    super("Prompt aborted");
    this.name = "PromptAbortError";
  }
}

/**
 * Single owner of the clack cancel protocol. Every prompt resolves to either a
 * value or the cancel symbol, so Ctrl-C handling cannot drift between the
 * text/select prompts and the confirm prompt.
 */
function unwrap<Value>(answer: Value | symbol): Value {
  if (isCancel(answer)) {
    throw new PromptAbortError();
  }

  return answer as Value;
}

function requireNonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? undefined
    : "Value cannot be empty";
}

export function createInteractivePrompt(
  stdin: typeof process.stdin,
  stderr: typeof process.stderr,
): PromptFn {
  // The prompt UI is written to stderr on purpose: stdout carries the
  // machine-readable command result (`--format json`), and must stay clean
  // even while the CLI is asking the user a question.
  const streams = { input: stdin, output: stderr };

  return async (request) => {
    switch (request.type) {
      case "text":
        return unwrap(
          await clackText({
            ...streams,
            initialValue: request.initial,
            message: request.message,
            validate: requireNonEmpty,
          }),
        );
      case "password":
        return unwrap(
          await clackPassword({
            ...streams,
            message: request.message,
            validate: requireNonEmpty,
          }),
        );
      case "select":
        return unwrap(
          await clackSelect({
            ...streams,
            initialValue: request.choices[request.initial ?? 0]?.value,
            message: request.message,
            options: request.choices.map((choice) => ({
              label: choice.title,
              value: choice.value,
            })),
          }),
        );
      case "multiselect":
        return unwrap(
          await clackMultiselect({
            ...streams,
            initialValues: request.choices
              .filter((choice) => choice.selected === true)
              .map((choice) => choice.value),
            message: request.message,
            options: request.choices.map((choice) => ({
              label: choice.title,
              value: choice.value,
            })),
            required: (request.min ?? 0) > 0,
          }),
        );
    }
  };
}

export function createInteractiveConfirm(
  stdin: typeof process.stdin,
  stderr: typeof process.stderr,
): ConfirmFn {
  return async ({ initial, message }) =>
    unwrap(
      await clackConfirm({
        initialValue: initial ?? false,
        input: stdin,
        message,
        output: stderr,
      }),
    );
}
