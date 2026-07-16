// Application route tree (route map). createBrowserRouter
// (react-router v7 data mode): `/login` and `/auth/callback` are the only
// public routes; everything else nests under the RequireAuth layout (redirects
// to /login?returnTo=… per the redirect contract).
//
// AppShell scope: the shell wraps ALL guarded routes, not
// just /teams/:teamId/*. The navigation is team-scoped, but account pages must
// keep the topbar/account menu; AppShell already handles team-less
// routes by falling back to the persisted last team for the sidebar/switcher,
// so /teams, /account/* and the 404 keep a stable chrome instead of swapping
// layouts. AppShell reads `:teamId` via useParams param merging, so the param
// segments declared below reach the layout above them.
//
// Pages were filled in incrementally via one-line swaps of an inline <RouteStub/>;
// the last stub (release detail) has been replaced, so the stub helper is gone.

import { createBrowserRouter, Navigate } from "react-router";

import { useTeams } from "./api/hooks/teams";
import { RequireAuth } from "./auth/RequireAuth";
import { AppShell } from "./components/shell/AppShell";
import { ErrorState } from "./components/ui/ErrorState";
import { Skeleton } from "./components/ui/Skeleton";
import { readLastTeamId } from "./components/shell/lastTeam";
import { resolveHomeTeamId } from "./components/shell/teamResolution";
import { AppDetailPage } from "./pages/AppDetailPage";
import { AppsPage } from "./pages/AppsPage";
import { CallbackPage } from "./pages/CallbackPage";
import { DeploymentDetailPage } from "./pages/DeploymentDetailPage";
import { LocalConsentPage } from "./pages/LocalConsentPage";
import { LoginPage } from "./pages/LoginPage";
import { MembersPage } from "./pages/MembersPage";
import { MetricsAppsPage } from "./pages/metrics/MetricsAppsPage";
import { MetricsAppDeploymentsPage } from "./pages/metrics/MetricsAppDeploymentsPage";
import { MetricsDeploymentDetailPage } from "./pages/metrics/MetricsDeploymentDetailPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { ProfilePage } from "./pages/ProfilePage";
import { ReleaseDetailPage } from "./pages/ReleaseDetailPage";
import { TeamOverviewPage } from "./pages/TeamOverviewPage";
import { TokensPage } from "./pages/TokensPage";

/**
 * `/` → a team's apps. Self-host runs a single fixed team (team creation and
 * listing are removed from the UI), so instead of a team list we resolve where
 * to land from `GET /v1/teams` (visibility-filtered to the caller):
 * `resolveHomeTeamId` prefers the remembered team (localStorage lastTeamId)
 * when the caller still belongs to it, else the first visible team. Validating
 * here — rather than the old loader that redirected to the remembered id
 * sight-unseen — is what stops a stale id (e.g. a self-host DB reset
 * re-bootstraps `default-team` with a new random id) from redirecting into a
 * team that no longer exists. Signed-out visits still funnel into /login
 * because RequireAuth re-gates the redirect target. On no visible team, surface
 * a clear message rather than an empty list.
 */
function HomeRedirect() {
  const teamsQuery = useTeams();

  if (teamsQuery.isPending) {
    return (
      <div className="mx-auto w-full max-w-[var(--maxw)] p-7" role="status" aria-label="Loading">
        <Skeleton width="40%" variant="line" />
        <Skeleton width="100%" height={120} className="mt-4" />
      </div>
    );
  }

  if (teamsQuery.isError) {
    return (
      <div className="mx-auto w-full max-w-[var(--maxw)] p-7">
        <ErrorState
          error={teamsQuery.error}
          onRetry={() => void teamsQuery.refetch()}
        />
      </div>
    );
  }

  const targetTeamId = resolveHomeTeamId(teamsQuery.data, readLastTeamId());
  if (targetTeamId === null) {
    return (
      <div className="mx-auto w-full max-w-[var(--maxw)] p-7 text-[14px] text-fg-2">
        No team is provisioned for your account yet. Contact your administrator.
      </div>
    );
  }

  return <Navigate to={`/teams/${targetTeamId}/apps`} replace />;
}

export const router = createBrowserRouter([
  // Public routes (the only unauthenticated ones).
  { path: "/login", element: <LoginPage /> },
  // Local evaluation consent page — the same-origin authorize target when
  // web-config reports mode "local-dev"; a standalone 404 otherwise (the
  // route ships inert in production bundles).
  { path: "/login/oauth/authorize", element: <LocalConsentPage /> },
  { path: "/auth/callback", element: <CallbackPage /> },

  // Guarded: RequireAuth gate → AppShell chrome → routed screens.
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppShell />,
        children: [
          { index: true, element: <HomeRedirect /> },
          {
            path: "teams/:teamId",
            children: [
              { index: true, element: <TeamOverviewPage /> },
              { path: "apps", element: <AppsPage /> },
              { path: "apps/:appId", element: <AppDetailPage /> },
              { path: "apps/:appId/deployments/:depId", element: <DeploymentDetailPage /> },
              { path: "apps/:appId/deployments/:depId/releases/:releaseId", element: <ReleaseDetailPage /> },
              { path: "members", element: <MembersPage /> },
              {
                path: "metrics",
                children: [
                  { index: true, element: <MetricsAppsPage /> },
                  {
                    path: "apps/:appId",
                    children: [
                      { index: true, element: <MetricsAppDeploymentsPage /> },
                      {
                        path: "deployments/:depId",
                        element: <MetricsDeploymentDetailPage />,
                      },
                    ],
                  },
                ],
              },
            ],
          },
          { path: "account/tokens", element: <TokensPage /> },
          { path: "account/profile", element: <ProfilePage /> },
          { path: "*", element: <NotFoundPage /> },
        ],
      },
    ],
  },
]);
