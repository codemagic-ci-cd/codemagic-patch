import {
  DEFAULT_GITHUB_API_BASE_URL,
  postJson,
  trimTrailingSlash,
} from "./githubApi";

export interface DispatchWorkflowInput {
  accessToken: string;
  apiBaseUrl?: string;
  defaultRef: string;
  fetch?: typeof globalThis.fetch;
  inputs: Record<string, string | boolean>;
  owner: string;
  repo: string;
  workflowFile: string;
}

export type DispatchWorkflowResult =
  | {
      actionsUrl: string;
      outcome: "success";
    }
  | {
      message: string;
      outcome: "unauthorized";
    }
  | {
      message: string;
      outcome: "not_found";
    }
  | {
      message: string;
      outcome: "provider_error";
    };

export async function dispatchWorkflow(
  input: DispatchWorkflowInput,
): Promise<DispatchWorkflowResult> {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const apiBaseUrl = trimTrailingSlash(
    input.apiBaseUrl ?? DEFAULT_GITHUB_API_BASE_URL,
  );
  const workflowId = encodeURIComponent(input.workflowFile);
  const url = `${apiBaseUrl}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/actions/workflows/${workflowId}/dispatches`;

  const response = await postJson(fetchImpl, url, input.accessToken, {
    inputs: input.inputs,
    ref: input.defaultRef,
  });

  if (response.status === 401 || response.status === 403) {
    return {
      message: "GitHub rejected the stored personal access token",
      outcome: "unauthorized",
    };
  }

  if (response.status === 404) {
    return {
      message:
        "GitHub workflow or repository was not found — check owner, repo, and workflow filename",
      outcome: "not_found",
    };
  }

  if (!response.ok) {
    let detail = `GitHub workflow dispatch failed with HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { message?: unknown };
      if (typeof body.message === "string" && body.message.length > 0) {
        detail = body.message;
      }
    } catch {
      // ignore parse errors
    }

    return {
      message: detail,
      outcome: "provider_error",
    };
  }

  return {
    actionsUrl: `https://github.com/${input.owner}/${input.repo}/actions/workflows/${workflowId}`,
    outcome: "success",
  };
}
