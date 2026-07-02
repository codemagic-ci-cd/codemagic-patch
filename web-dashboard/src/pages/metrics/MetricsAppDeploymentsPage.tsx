// Metrics per app — deployments table with counters.

import { Link, useNavigate, useParams } from "react-router";

import { useApp } from "../../api/hooks/apps";
import { useDeployments } from "../../api/hooks/deployments";
import type { Deployment } from "../../model/deployment";
import { buttonVariants } from "../../components/ui/Button";
import { CELL_MAIN } from "../../components/ui/cell";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorState } from "../../components/ui/ErrorState";
import { CARD, CARD_PAD } from "../../components/ui/card";
import {
  TBL,
  TBL_NUM,
  TBL_RIGHT,
  TBL_TD,
  TBL_TH,
  TBL_TR,
  TBL_WRAP,
} from "../../components/ui/table";
import { MetricsRollupCells } from "./MetricsRollupCells";
import { MetricsPageFrame, MetricsTableSkeleton } from "./MetricsPageFrame";
import { metricsDeploymentPath } from "./metricsPaths";
import { useDeploymentMetricsRollup } from "./useMetricsRollup";

const METRIC_COLUMNS = [
  "Active",
  "Downloads",
  "Failed",
  "Success rate",
] as const;

export function MetricsAppDeploymentsPage() {
  const teamId = useParams().teamId as string;
  const appId = useParams().appId as string;
  const appQuery = useApp(appId);
  const deploymentsQuery = useDeployments(appId);

  const title = appQuery.data?.name ?? "App";
  const subtitle =
    "Metrics rolled up per deployment. Open one for version distribution and install outcomes.";

  if (appQuery.isPending || deploymentsQuery.isPending) {
    return (
      <MetricsPageFrame title={title} subtitle={subtitle}>
        <MetricsTableSkeleton label="Loading deployments" columns={METRIC_COLUMNS} />
      </MetricsPageFrame>
    );
  }

  if (appQuery.isError) {
    return (
      <MetricsPageFrame title={title} subtitle={subtitle}>
        <div className={`${CARD} ${CARD_PAD}`}>
          <ErrorState
            error={appQuery.error}
            onRetry={() => {
              void appQuery.refetch();
            }}
          />
        </div>
      </MetricsPageFrame>
    );
  }

  if (deploymentsQuery.isError) {
    return (
      <MetricsPageFrame title={title} subtitle={subtitle}>
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

  if (deploymentsQuery.data.length === 0) {
    return (
      <MetricsPageFrame title={title} subtitle={subtitle}>
        <div className={`${CARD} ${CARD_PAD}`}>
          <EmptyState
            icon={<LayersIcon />}
            title="No deployments in this app"
            description="Deployments are created from the app's settings. Add one to start collecting metrics."
            action={
              <Link
                className={buttonVariants({ intent: "primary" })}
                to={`/teams/${teamId}/apps/${appId}`}
              >
                Open app
              </Link>
            }
          />
        </div>
      </MetricsPageFrame>
    );
  }

  return (
    <MetricsPageFrame title={title} subtitle={subtitle}>
      <div className="rounded-lg border border-border bg-surface shadow-sm">
        <div className={TBL_WRAP}>
          <table className={TBL}>
            <thead>
              <tr>
                <th className={TBL_TH}>Deployment</th>
                {METRIC_COLUMNS.map((column) => (
                  <th key={column} className={`${TBL_TH} ${TBL_RIGHT}`}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {deploymentsQuery.data.map((deployment) => (
                <DeploymentMetricsRow
                  key={deployment.id}
                  teamId={teamId}
                  appId={appId}
                  deployment={deployment}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </MetricsPageFrame>
  );
}

function DeploymentMetricsRow({
  teamId,
  appId,
  deployment,
}: {
  teamId: string;
  appId: string;
  deployment: Deployment;
}) {
  const navigate = useNavigate();
  const { query, rollup } = useDeploymentMetricsRollup(deployment.id);
  const detailPath = metricsDeploymentPath(teamId, appId, deployment.id);

  return (
    <tr
      className={`${TBL_TR} cursor-pointer`}
      onClick={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest("a") !== null
        ) {
          return;
        }
        void navigate(detailPath);
      }}
    >
      <td className={TBL_TD}>
        <div className={CELL_MAIN}>
          <Link to={detailPath}>{deployment.name}</Link>
        </div>
      </td>
      <MetricsRollupCells
        label={deployment.name}
        isPending={query.isPending}
        isError={query.isError}
        rollup={rollup}
        onRetry={() => {
          void query.refetch();
        }}
      />
    </tr>
  );
}

function LayersIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m12 2 9 5-9 5-9-5 9-5z" />
      <path d="m3 12 9 5 9-5" />
      <path d="m3 17 9 5 9-5" />
    </svg>
  );
}
