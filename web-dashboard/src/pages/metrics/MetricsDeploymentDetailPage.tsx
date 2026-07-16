// Metrics deployment detail — summary cards plus quick app/deployment swap.

import { Link, useNavigate, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";

import { useApps } from "../../api/hooks/apps";
import { deploymentKeys, useDeployments } from "../../api/hooks/deployments";
import type { Deployment } from "../../model/deployment";
import { buttonVariants } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorState } from "../../components/ui/ErrorState";
import { CARD, CARD_PAD } from "../../components/ui/card";
import { INPUT, INPUT_STATE, SELECT_EXTRA } from "../../components/ui/form";
import { DeploymentCounters } from "./DeploymentCounters";
import { MetricsBodySkeleton, MetricsPageFrame } from "./MetricsPageFrame";
import {
  metricsAppPath,
  metricsDeploymentPath,
} from "./metricsPaths";

export function MetricsDeploymentDetailPage() {
  const teamId = useParams().teamId as string;
  const appId = useParams().appId as string;
  const depId = useParams().depId as string;

  const appsQuery = useApps(teamId);
  const deploymentsQuery = useDeployments(appId);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const deployment = deploymentsQuery.data?.find(
    (candidate) => candidate.id === depId,
  );
  const deploymentName = deployment?.name ?? "Deployment";

  const selectors =
    appsQuery.data !== undefined && deployment !== undefined ? (
      <>
        <select
          className={`${INPUT} ${INPUT_STATE.normal} ${SELECT_EXTRA} select min-w-[190px]`}
          aria-label="App"
          value={appId}
          onChange={(event) => {
            const nextAppId = event.target.value;
            if (nextAppId === appId) {
              return;
            }
            const cached = queryClient.getQueryData<readonly Deployment[]>(
              deploymentKeys.list(nextAppId),
            );
            const first = cached?.[0];
            if (first !== undefined) {
              void navigate(
                metricsDeploymentPath(teamId, nextAppId, first.id),
              );
            } else {
              void navigate(metricsAppPath(teamId, nextAppId));
            }
          }}
        >
          {appsQuery.data.map((app) => (
            <option key={app.id} value={app.id}>
              {app.name}
            </option>
          ))}
        </select>
        <select
          className={`${INPUT} ${INPUT_STATE.normal} ${SELECT_EXTRA} select min-w-[150px]`}
          aria-label="Deployment"
          value={deployment.id}
          onChange={(event) => {
            void navigate(
              metricsDeploymentPath(teamId, appId, event.target.value),
            );
          }}
        >
          {deploymentsQuery.data?.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
      </>
    ) : null;

  if (appsQuery.isPending || deploymentsQuery.isPending) {
    return (
      <MetricsPageFrame
        title={deploymentName}
        subtitle="Detailed adoption and reliability for this deployment."
        actions={selectors}
      >
        <MetricsBodySkeleton label="Loading deployment metrics" />
      </MetricsPageFrame>
    );
  }

  if (appsQuery.isError) {
    return (
      <MetricsPageFrame
        title={deploymentName}
        subtitle="Detailed adoption and reliability for this deployment."
      >
        <div className={`${CARD} ${CARD_PAD}`}>
          <ErrorState
            error={appsQuery.error}
            onRetry={() => {
              void appsQuery.refetch();
            }}
          />
        </div>
      </MetricsPageFrame>
    );
  }

  if (deploymentsQuery.isError) {
    return (
      <MetricsPageFrame
        title={deploymentName}
        subtitle="Detailed adoption and reliability for this deployment."
      >
        <div className={`${CARD} ${CARD_PAD}`}>
          <ErrorState
            error={deploymentsQuery.error}
            onRetry={() => {
              void deploymentsQuery.refetch();
            }}
          />
        </div>
      </MetricsPageFrame>
    );
  }

  if (deployment === undefined) {
    return (
      <MetricsPageFrame
        title="Deployment not found"
        subtitle="This deployment may have been removed."
      >
        <div className={`${CARD} ${CARD_PAD}`}>
          <EmptyState
            title="Deployment not found"
            description="Return to the app's metrics overview and pick another deployment."
            action={
              <Link
                className={buttonVariants({ intent: "primary" })}
                to={metricsAppPath(teamId, appId)}
              >
                Back to deployments
              </Link>
            }
          />
        </div>
      </MetricsPageFrame>
    );
  }

  return (
    <MetricsPageFrame
      title={deployment.name}
      subtitle="Detailed adoption and reliability for this deployment."
      actions={selectors}
    >
      <DeploymentCounters
        key={deployment.id}
        teamId={teamId}
        appId={appId}
        deployment={deployment}
      />
    </MetricsPageFrame>
  );
}
