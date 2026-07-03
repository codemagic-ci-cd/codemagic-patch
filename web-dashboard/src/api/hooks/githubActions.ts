// TanStack Query bindings for GitHub Actions integration endpoints.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { authenticatedRequest } from "../client";
import { HttpProblemError } from "../problem";
import type {
  DeploymentGitHubActionsDispatchBody,
  DeploymentGitHubActionsLink,
  DeploymentGitHubActionsUpsertBody,
  GitHubIntegrationStatus,
  TeamGitHubIntegrationUpsertBody,
} from "../types";
import type {
  DeploymentGitHubActionsDispatchWireResponse,
  DeploymentGitHubActionsLinkWire,
  GitHubIntegrationStatusWire,
} from "../wire";

export const githubActionsKeys = {
  all: ["github-actions"] as const,
  deployment: (deploymentId: string) =>
    [...githubActionsKeys.all, "deployment", deploymentId] as const,
  team: (teamId: string) => [...githubActionsKeys.all, "team", teamId] as const,
};

function fromGitHubIntegrationStatusWire(
  wire: GitHubIntegrationStatusWire,
): GitHubIntegrationStatus {
  if (!wire.configured) {
    return { configured: false };
  }

  return {
    configured: true,
    tokenLast4: wire.token_last4,
  };
}

function fromDeploymentGitHubActionsLinkWire(
  wire: DeploymentGitHubActionsLinkWire,
): DeploymentGitHubActionsLink {
  return {
    defaultRef: wire.default_ref,
    deploymentId: wire.deployment_id,
    enabled: wire.enabled,
    owner: wire.owner,
    repo: wire.repo,
    workflowFile: wire.workflow_file,
  };
}

export function useTeamGitHubIntegration(teamId: string) {
  return useQuery({
    enabled: teamId.length > 0,
    queryKey: githubActionsKeys.team(teamId),
    queryFn: async ({ signal }) => {
      const wire = await authenticatedRequest<GitHubIntegrationStatusWire>({
        method: "GET",
        path: `/teams/${encodeURIComponent(teamId)}/integrations/github`,
        signal,
      });
      return fromGitHubIntegrationStatusWire(wire);
    },
  });
}

export function useUpsertTeamGitHubIntegration(teamId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: TeamGitHubIntegrationUpsertBody) =>
      authenticatedRequest<GitHubIntegrationStatusWire>({
        method: "PUT",
        path: `/teams/${encodeURIComponent(teamId)}/integrations/github`,
        body,
      }).then(fromGitHubIntegrationStatusWire),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: githubActionsKeys.team(teamId),
      });
    },
  });
}

export function useRevokeTeamGitHubIntegration(teamId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      authenticatedRequest<void>({
        method: "DELETE",
        path: `/teams/${encodeURIComponent(teamId)}/integrations/github`,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: githubActionsKeys.team(teamId),
      });
    },
  });
}

export function useDeploymentGitHubActions(deploymentId: string) {
  return useQuery({
    enabled: deploymentId.length > 0,
    queryKey: githubActionsKeys.deployment(deploymentId),
    queryFn: async ({ signal }) => {
      try {
        const wire = await authenticatedRequest<DeploymentGitHubActionsLinkWire>({
          method: "GET",
          path: `/deployments/${encodeURIComponent(deploymentId)}/github-actions`,
          signal,
        });
        return fromDeploymentGitHubActionsLinkWire(wire);
      } catch (error) {
        if (
          error instanceof HttpProblemError &&
          (error.status === 404 || error.status === 409)
        ) {
          return null;
        }
        throw error;
      }
    },
    retry: false,
  });
}

export function useUpsertDeploymentGitHubActions(deploymentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: DeploymentGitHubActionsUpsertBody) =>
      authenticatedRequest<DeploymentGitHubActionsLinkWire>({
        method: "PUT",
        path: `/deployments/${encodeURIComponent(deploymentId)}/github-actions`,
        body,
      }).then(fromDeploymentGitHubActionsLinkWire),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: githubActionsKeys.deployment(deploymentId),
      });
    },
  });
}

export function useDispatchGitHubRelease(deploymentId: string) {
  return useMutation({
    mutationFn: (body: DeploymentGitHubActionsDispatchBody) =>
      authenticatedRequest<DeploymentGitHubActionsDispatchWireResponse>({
        method: "POST",
        path: `/deployments/${encodeURIComponent(deploymentId)}/github-actions/dispatch`,
        body,
      }).then((response) => ({ actionsUrl: response.actions_url })),
  });
}
