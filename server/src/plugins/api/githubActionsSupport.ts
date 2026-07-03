import { createProblem, type ProblemDetails } from "../../app/problemDetails";
import { singleFieldValidationProblem } from "./routeValidation";

const GITHUB_IDENTIFIER_PATTERN = /^[A-Za-z0-9._-]+$/;
const WORKFLOW_FILE_PATTERN = /^[\w./-]+\.ya?ml$/;

export function parseTeamGitHubIntegrationUpsertBody(body: unknown):
  | { kind: "error"; problem: ProblemDetails }
  | { kind: "success"; value: { token: string } } {
  if (body === null || typeof body !== "object") {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "request body must be a JSON object",
        "body",
        "invalid_type",
      ),
    };
  }

  const record = body as Record<string, unknown>;
  const token =
    typeof record.token === "string" ? record.token.trim() : undefined;

  if (!token || token.length < 10) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "token must be a non-empty GitHub personal access token",
        "token",
        "invalid_value",
      ),
    };
  }

  return {
    kind: "success",
    value: { token },
  };
}

export function parseDeploymentGitHubActionsUpsertBody(body: unknown):
  | { kind: "error"; problem: ProblemDetails }
  | {
      kind: "success";
      value: {
        defaultRef: string;
        enabled: boolean;
        owner: string;
        repo: string;
        workflowFile: string;
      };
    } {
  if (body === null || typeof body !== "object") {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "request body must be a JSON object",
        "body",
        "invalid_type",
      ),
    };
  }

  const record = body as Record<string, unknown>;
  const owner =
    typeof record.owner === "string" ? record.owner.trim() : undefined;
  const repo = typeof record.repo === "string" ? record.repo.trim() : undefined;
  const workflowFile =
    typeof record.workflow_file === "string"
      ? record.workflow_file.trim()
      : undefined;
  const defaultRef =
    typeof record.default_ref === "string" && record.default_ref.trim().length > 0
      ? record.default_ref.trim()
      : "main";
  const enabled = record.enabled === undefined ? true : record.enabled === true;

  if (!owner || !GITHUB_IDENTIFIER_PATTERN.test(owner)) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "owner must be a valid GitHub owner name",
        "owner",
        "invalid_value",
      ),
    };
  }

  if (!repo || !GITHUB_IDENTIFIER_PATTERN.test(repo)) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "repo must be a valid GitHub repository name",
        "repo",
        "invalid_value",
      ),
    };
  }

  if (!workflowFile || !WORKFLOW_FILE_PATTERN.test(workflowFile)) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "workflow_file must be a workflow path ending in .yml or .yaml",
        "workflow_file",
        "invalid_value",
      ),
    };
  }

  return {
    kind: "success",
    value: {
      defaultRef,
      enabled,
      owner,
      repo,
      workflowFile,
    },
  };
}

export function parseDeploymentGitHubActionsDispatchBody(body: unknown):
  | { kind: "error"; problem: ProblemDetails }
  | {
      kind: "success";
      value: {
        mandatory: boolean;
        platform: "android" | "ios";
        releaseNotes?: string;
        rolloutPercentage: number;
        targetBinaryVersion?: string;
      };
    } {
  if (body === null || typeof body !== "object") {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "request body must be a JSON object",
        "body",
        "invalid_type",
      ),
    };
  }

  const record = body as Record<string, unknown>;
  const platform = record.platform;
  if (platform !== "ios" && platform !== "android") {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "platform must be ios or android",
        "platform",
        "invalid_value",
      ),
    };
  }

  const rolloutRaw = record.rollout_percentage;
  const rolloutPercentage =
    rolloutRaw === undefined
      ? 100
      : typeof rolloutRaw === "number"
        ? rolloutRaw
        : Number.NaN;

  if (
    !Number.isInteger(rolloutPercentage) ||
    rolloutPercentage < 1 ||
    rolloutPercentage > 100
  ) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "rollout_percentage must be an integer between 1 and 100",
        "rollout_percentage",
        "out_of_range",
      ),
    };
  }

  const releaseNotes =
    typeof record.release_notes === "string" &&
    record.release_notes.trim().length > 0
      ? record.release_notes.trim()
      : undefined;
  const targetBinaryVersion =
    typeof record.target_binary_version === "string" &&
    record.target_binary_version.trim().length > 0
      ? record.target_binary_version.trim()
      : undefined;

  return {
    kind: "success",
    value: {
      mandatory: record.mandatory === true,
      platform,
      releaseNotes,
      rolloutPercentage,
      targetBinaryVersion,
    },
  };
}

export function createGitHubIntegrationNotConfiguredProblem(): ProblemDetails {
  return createProblem({
    detail: "GitHub Actions integration is not configured for this team",
    status: 409,
    typeSuffix: "github-integration-not-configured",
  });
}

export function createDeploymentGitHubActionsLinkNotFoundProblem(): ProblemDetails {
  return createProblem({
    detail: "GitHub Actions is not linked for this deployment",
    status: 409,
    typeSuffix: "github-actions-link-not-configured",
  });
}
