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

export class PromptAbortError extends Error {
  constructor() {
    super("Prompt aborted");
    this.name = "PromptAbortError";
  }
}

export function createInteractivePrompt(
  stdin: typeof process.stdin,
  stderr: typeof process.stderr,
): PromptFn {
  return async (request) => {
    let aborted = false;
    const answer = await prompts(buildQuestion(request, stdin, stderr), {
      onCancel: () => {
        aborted = true;
        return false;
      },
    });

    if (aborted || answer.value === undefined) {
      throw new PromptAbortError();
    }

    return answer.value as string | string[];
  };
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
