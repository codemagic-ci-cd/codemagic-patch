// Route-derived breadcrumbs for app hierarchy screens ("Apps › App ›
// Deployment › Release; IDs resolve to names (skeleton text while resolving)").
// In single-team OSS mode team-level leaf routes (overview, apps list,
// members, metrics) omit breadcrumbs — the page <h1> already carries the
// title. In multi-team mode every team-scoped trail is prefixed with the
// team-name crumb (link to the team overview) since it disambiguates, and
// team-level leaves keep a static label after it. Entity ids come
// from the route params (teamId/appId/depId/releaseId) and resolve through
// the existing query hooks, cache-first — a navigation from a list that
// already populated the cache paints names instantly, otherwise a small inline
// Skeleton shows. Deployment names come from the app's deployment list
// (`useDeployments`) because no single-deployment GET exists
// (api/hooks/deployments.ts). Account routes keep a short trail
// (Account › Profile / API tokens). DOM/classes follow the `.crumbs` nav
// structure (`›` separators, `.cur` leaf); each name component falls back to
// the raw id when resolution fails so the trail never blanks.

import { Fragment } from "react";
import { Link, useLocation, useParams } from "react-router";
import type { ReactNode } from "react";

import { useApp } from "../../api/hooks/apps";
import { useDeployments } from "../../api/hooks/deployments";
import { useRelease } from "../../api/hooks/releases";
import { useIsMultiTeam, useTeam } from "../../api/hooks/teams";
import { Skeleton } from "../ui/Skeleton";
import { readLastTeamId } from "./lastTeam";

interface Crumb {
  key: string;
  /** Link target; crumbs without one (and the leaf) render as plain text. */
  to?: string;
  node: ReactNode;
}

export function Breadcrumbs() {
  const params = useParams();
  const { pathname } = useLocation();
  const isMultiTeam = useIsMultiTeam();

  const crumbs = buildCrumbs(params, pathname, isMultiTeam);
  if (crumbs.length === 0) {
    return null;
  }
  const lastIndex = crumbs.length - 1;

  return (
    <nav
      className="mb-[18px] flex items-center gap-2 text-[13px] font-medium text-fg-3"
      aria-label="Breadcrumb"
    >
      {crumbs.map((crumb, index) => {
        const isLast = index === lastIndex;
        return (
          <Fragment key={crumb.key}>
            {index > 0 && <span className="text-fg-faint">›</span>}
            {!isLast && crumb.to !== undefined ? (
              <Link className="hover:text-blue" to={crumb.to}>
                {crumb.node}
              </Link>
            ) : (
              <span
                className={isLast ? "font-semibold text-fg" : undefined}
                aria-current={isLast ? "page" : undefined}
              >
                {crumb.node}
              </span>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}

/** Static labels for team-scoped leaf segments (multi-team trails only). */
const TEAM_LEAF_LABELS = new Map<string, string>([
  ["apps", "Releases"],
  ["members", "Members"],
  ["metrics", "Metrics"],
]);

function buildCrumbs(
  params: Readonly<Record<string, string | undefined>>,
  pathname: string,
  isMultiTeam: boolean,
): Crumb[] {
  const { teamId, appId, depId, releaseId } = params;
  const segments = pathname.split("/").filter((segment) => segment.length > 0);

  if (teamId !== undefined) {
    // Single-team OSS: the team root crumb is just the fixed `default-team`
    // slug, so omit it; show it only in multi-team mode where it disambiguates.
    const crumbs: Crumb[] = isMultiTeam
      ? [
          {
            key: "team",
            to: `/teams/${teamId}`,
            node: <TeamName teamId={teamId} />,
          },
        ]
      : [];

    // Metrics drill-down (`metrics/apps/:appId[/deployments/:depId]`).
    // Position-anchored on segments[2] — the section slug always sits right
    // after `/teams/:teamId` — so a team named "metrics" can't hijack the
    // trail. The bare `/metrics` index has no appId param and falls through
    // to the static leaf-label handling below.
    if (segments[2] === "metrics" && appId !== undefined) {
      crumbs.push(
        {
          key: "metrics",
          to: `/teams/${teamId}/metrics`,
          node: "Metrics",
        },
        {
          key: "app",
          to: `/teams/${teamId}/metrics/apps/${appId}`,
          node: <AppName appId={appId} />,
        },
      );
      if (depId !== undefined) {
        crumbs.push({
          key: "deployment",
          node: <DeploymentName appId={appId} deploymentId={depId} />,
        });
      }
      return crumbs;
    }

    if (appId !== undefined) {
      crumbs.push(
        { key: "apps", to: `/teams/${teamId}/apps`, node: "Releases" },
        {
          key: "app",
          to: `/teams/${teamId}/apps/${appId}`,
          node: <AppName appId={appId} />,
        },
      );
      if (depId !== undefined) {
        crumbs.push({
          key: "deployment",
          to: `/teams/${teamId}/apps/${appId}/deployments/${depId}`,
          node: <DeploymentName appId={appId} deploymentId={depId} />,
        });
        if (releaseId !== undefined) {
          crumbs.push({
            key: "release",
            node: <ReleaseLabel releaseId={releaseId} />,
          });
        }
      }
      return crumbs;
    }

    // Team-level screens (overview, apps list, members, …): in single-team
    // mode no breadcrumb — the page <h1> is the title. In multi-team mode the
    // team crumb carries the disambiguating context, so keep the trail with a
    // static leaf label.
    if (!isMultiTeam) {
      return [];
    }
    const leaf = segments[2];
    if (leaf !== undefined) {
      const leafLabel = TEAM_LEAF_LABELS.get(leaf);
      if (leafLabel !== undefined) {
        crumbs.push({ key: leaf, node: leafLabel });
      }
    } else if (segments.length === 2) {
      crumbs.push({ key: "overview", node: "Overview" });
    }
    return crumbs;
  }

  if (segments[0] === "account") {
    const leafLabel =
      segments[1] === "profile"
        ? "Profile"
        : segments[1] === "tokens"
          ? "API tokens"
          : undefined;
    if (leafLabel !== undefined) {
      // Account pages are team-less routes, but the breadcrumbs keep the team-name
      // root crumb (a link back to the team overview) for context — resolve it
      // from the last visited team, omitting it only when none is known.
      const lastTeamId = readLastTeamId();
      const crumbs: Crumb[] = [];
      if (lastTeamId !== null && isMultiTeam) {
        crumbs.push({
          key: "team",
          to: `/teams/${lastTeamId}`,
          node: <TeamName teamId={lastTeamId} />,
        });
      }
      crumbs.push(
        { key: "account", node: "Account" },
        { key: "account-leaf", node: leafLabel },
      );
      return crumbs;
    }
  }

  return [];
}

// --- Id → name resolvers (hooks isolated per crumb so they only run when
// --- their param exists; pending → inline skeleton, failure → raw id) ------

function TeamName({ teamId }: { teamId: string }) {
  const query = useTeam(teamId);
  if (query.isPending) {
    return <Skeleton width={90} variant="text" />;
  }
  return <>{query.data?.name ?? teamId}</>;
}

function AppName({ appId }: { appId: string }) {
  const query = useApp(appId);
  if (query.isPending) {
    return <Skeleton width={90} variant="text" />;
  }
  return <>{query.data?.name ?? appId}</>;
}

function DeploymentName({
  appId,
  deploymentId,
}: {
  appId: string;
  deploymentId: string;
}) {
  const query = useDeployments(appId);
  if (query.isPending) {
    return <Skeleton width={80} variant="text" />;
  }
  const name = query.data?.find(
    (deployment) => deployment.id === deploymentId,
  )?.name;
  return <>{name ?? deploymentId}</>;
}

function ReleaseLabel({ releaseId }: { releaseId: string }) {
  const query = useRelease(releaseId);
  if (query.isPending) {
    return <Skeleton width={48} variant="text" />;
  }
  return <>{query.data?.release.releaseLabel ?? releaseId}</>;
}
