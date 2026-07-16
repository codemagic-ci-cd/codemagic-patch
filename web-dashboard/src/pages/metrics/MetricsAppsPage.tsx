// Metrics index — app picker that leads into deployment-level metrics.

import { Link, useNavigate, useParams } from "react-router";

import { useApps } from "../../api/hooks/apps";
import { gradientFor, initialsFor } from "../../lib/appTile";
import type { App } from "../../model/app";
import { buttonVariants } from "../../components/ui/Button";
import { APP_ICO, CELL_APP, CELL_MAIN } from "../../components/ui/cell";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorState } from "../../components/ui/ErrorState";
import { CARD, CARD_PAD } from "../../components/ui/card";
import {
  TBL,
  TBL_TD,
  TBL_TH,
  TBL_TR,
  TBL_WRAP,
} from "../../components/ui/table";
import { MetricsPageFrame, MetricsTableSkeleton } from "./MetricsPageFrame";
import { metricsAppPath } from "./metricsPaths";

const PAGE_SUBTITLE =
  "Select an app to compare metrics across its deployments.";

export function MetricsAppsPage() {
  const teamId = useParams().teamId as string;
  const appsQuery = useApps(teamId);

  if (appsQuery.isPending) {
    return (
      <MetricsPageFrame title="Metrics" subtitle={PAGE_SUBTITLE}>
        <MetricsTableSkeleton label="Loading apps" columns={[]} />
      </MetricsPageFrame>
    );
  }

  if (appsQuery.isError) {
    return (
      <MetricsPageFrame title="Metrics" subtitle={PAGE_SUBTITLE}>
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

  if (appsQuery.data.length === 0) {
    return (
      <MetricsPageFrame title="Metrics" subtitle={PAGE_SUBTITLE}>
        <div className={`${CARD} ${CARD_PAD}`}>
          <EmptyState
            icon={<LayersIcon />}
            title="No apps yet"
            description="Metrics are reported per deployment. Create an app to get its deployments, then come back here."
            action={
              <Link
                className={buttonVariants({ intent: "primary" })}
                to={`/teams/${teamId}/apps`}
              >
                Go to Releases
              </Link>
            }
          />
        </div>
      </MetricsPageFrame>
    );
  }

  return (
    <MetricsPageFrame title="Metrics" subtitle={PAGE_SUBTITLE}>
      <div className="rounded-lg border border-border bg-surface shadow-sm">
        <div className={TBL_WRAP}>
          <table className={TBL}>
            <thead>
              <tr>
                <th className={TBL_TH}>App</th>
              </tr>
            </thead>
            <tbody>
              {appsQuery.data.map((app) => (
                <AppRow key={app.id} teamId={teamId} app={app} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </MetricsPageFrame>
  );
}

function AppRow({ teamId, app }: { teamId: string; app: App }) {
  const navigate = useNavigate();
  const detailPath = metricsAppPath(teamId, app.id);

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
        <div className={CELL_APP}>
          <span
            className={APP_ICO}
            style={{ background: gradientFor(app.id) }}
            aria-hidden="true"
          >
            {initialsFor(app.name)}
          </span>
          <div>
            <div className={CELL_MAIN}>
              <Link to={detailPath}>{app.name}</Link>
            </div>
          </div>
        </div>
      </td>
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
