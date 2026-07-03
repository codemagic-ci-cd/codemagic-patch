import {
  DEFAULT_GITHUB_API_BASE_URL,
  getJson,
  postJson,
  readJsonObject,
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

interface GitHubWorkflowListResponse {
  workflows?: Array<{
    id?: unknown;
    name?: unknown;
    path?: unknown;
    state?: unknown;
  }>;
}

function workflowBasename(workflowFile: string): string {
  const trimmed = workflowFile.trim();
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

function workflowIdCandidates(workflowFile: string): string[] {
  const trimmed = workflowFile.trim();
  const basename = workflowBasename(trimmed);
  const candidates = [
    trimmed,
    basename,
    `.github/workflows/${basename}`,
  ];
  return [...new Set(candidates.filter((value) => value.length > 0))];
}

async function readGitHubErrorMessage(response: Response): Promise<string | null> {
  const body = await readJsonObject<{ message?: unknown }>(response);
  if (
    body &&
    typeof body.message === "string" &&
    body.message.trim().length > 0
  ) {
    return body.message.trim();
  }
  return null;
}

async function listWorkflowIds(
  fetchImpl: typeof globalThis.fetch,
  apiBaseUrl: string,
  accessToken: string,
  owner: string,
  repo: string,
  workflowFile: string,
): Promise<string[]> {
  const response = await getJson(
    fetchImpl,
    `${apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows`,
    accessToken,
  );

  if (!response.ok) {
    return [];
  }

  const body = await readJsonObject<GitHubWorkflowListResponse>(response);
  if (!body || !Array.isArray(body.workflows)) {
    return [];
  }

  const basename = workflowBasename(workflowFile);
  const ids: string[] = [];

  for (const workflow of body.workflows) {
    if (typeof workflow.id !== "number") {
      continue;
    }

    const path = typeof workflow.path === "string" ? workflow.path : "";
    const name = typeof workflow.name === "string" ? workflow.name : "";
    const matches =
      path === workflowFile.trim() ||
      path.endsWith(`/${basename}`) ||
      path === `.github/workflows/${basename}` ||
      name === basename;

    if (matches) {
      ids.push(String(workflow.id));
    }
  }

  return ids;
}

export async function dispatchWorkflow(
  input: DispatchWorkflowInput,
): Promise<DispatchWorkflowResult> {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const apiBaseUrl = trimTrailingSlash(
    input.apiBaseUrl ?? DEFAULT_GITHUB_API_BASE_URL,
  );

  const resolvedIds = await listWorkflowIds(
    fetchImpl,
    apiBaseUrl,
    input.accessToken,
    input.owner,
    input.repo,
    input.workflowFile,
  );

  const workflowIds = [
    ...resolvedIds,
    ...workflowIdCandidates(input.workflowFile),
  ];
  const uniqueWorkflowIds = [...new Set(workflowIds)];

  let lastNotFoundMessage =
    "GitHub workflow or repository was not found — check owner, repo, and workflow filename";

  for (const workflowId of uniqueWorkflowIds) {
    const url = `${apiBaseUrl}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`;

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
      const detail = await readGitHubErrorMessage(response);
      lastNotFoundMessage = detail
        ? `${detail} — verify owner (${input.owner}), repo (${input.repo}), workflow file (${input.workflowFile}), and branch (${input.defaultRef})`
        : `GitHub workflow or repository was not found for ${input.owner}/${input.repo} (${input.workflowFile} on ${input.defaultRef})`;
      continue;
    }

    if (!response.ok) {
      let detail = `GitHub workflow dispatch failed with HTTP ${response.status}`;
      const githubMessage = await readGitHubErrorMessage(response);
      if (githubMessage) {
        detail = githubMessage;
      }

      return {
        message: detail,
        outcome: "provider_error",
      };
    }

    const actionsWorkflowId = encodeURIComponent(workflowBasename(input.workflowFile));
    return {
      actionsUrl: `https://github.com/${input.owner}/${input.repo}/actions/workflows/${actionsWorkflowId}`,
      outcome: "success",
    };
  }

  return {
    message: lastNotFoundMessage,
    outcome: "not_found",
  };
}
