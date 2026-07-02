export function metricsIndexPath(teamId: string): string {
  return `/teams/${teamId}/metrics`;
}

export function metricsAppPath(teamId: string, appId: string): string {
  return `/teams/${teamId}/metrics/apps/${appId}`;
}

export function metricsDeploymentPath(
  teamId: string,
  appId: string,
  deploymentId: string,
): string {
  return `/teams/${teamId}/metrics/apps/${appId}/deployments/${deploymentId}`;
}
