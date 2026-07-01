import prompts from "prompts";

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

// Single owner of the prompts() cancel/abort protocol so Ctrl-C handling
// cannot drift between the text/select prompts and the confirm prompt.
async function askQuestion(
  question: prompts.PromptObject<"value">,
): Promise<unknown> {
  let aborted = false;
  const answer = await prompts(question, {
    onCancel: () => {
      aborted = true;
      return false;
    },
  });

  if (aborted || answer.value === undefined) {
    throw new PromptAbortError();
  }

  return answer.value;
}

export function createInteractivePrompt(
  stdin: typeof process.stdin,
  stderr: typeof process.stderr,
): PromptFn {
  return async (request) =>
    (await askQuestion(buildQuestion(request, stdin, stderr))) as
      | string
      | string[];
}

export function createInteractiveConfirm(
  stdin: typeof process.stdin,
  stderr: typeof process.stderr,
): ConfirmFn {
  return async ({ initial, message }) =>
    (await askQuestion({
      initial: initial ?? false,
      message,
      name: "value",
      stdin,
      stdout: stderr,
      type: "confirm",
    })) === true;
}

function buildQuestion(
  request: PromptRequest,
  stdin: typeof process.stdin,
  stdout: typeof process.stderr,
): prompts.PromptObject<"value"> {
  const base = { name: "value" as const, stdin, stdout };

  switch (request.type) {
    case "text":
      return {
        ...base,
        initial: request.initial,
        message: request.message,
        type: "text",
        validate: (value: string) =>
          typeof value === "string" && value.trim().length > 0
            ? true
            : "Value cannot be empty",
      };
    case "password":
      return {
        ...base,
        message: request.message,
        type: "password",
        validate: (value: string) =>
          typeof value === "string" && value.trim().length > 0
            ? true
            : "Value cannot be empty",
      };
    case "select":
      return {
        ...base,
        choices: request.choices,
        initial: request.initial ?? 0,
        message: request.message,
        type: "select",
      };
    case "multiselect":
      return {
        ...base,
        choices: request.choices,
        instructions: false,
        message: request.message,
        min: request.min,
        type: "multiselect",
      };
  }
}
