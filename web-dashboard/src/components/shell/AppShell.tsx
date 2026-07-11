// App shell layout frame: collapsible team-scoped Sidebar + TopBar + the
// routed page, in the ported `.app / .main / .content` grid — rebuilt as
// React components (no global DB, no injected DOM, no `.html` hrefs). The
// active team comes from the route params (`/teams/:teamId/...`, react-router
// merges descendant params into the layout's useParams); team-less routes
// (/teams, /account/*) fall back to the persisted last team so the
// sidebar/switcher stay populated, preserving an always-on team context. A
// team route visit is synced into localStorage lastTeamId (./lastTeam) only
// once the teamId is confirmed in GET /v1/teams, so the `/` redirect tracks
// deep links without ever remembering a stale or foreign team; an unvisitable
// teamId is cleared and self-heals to `/` (see teamResolution).
// Sidebar collapse persists in localStorage; the `data-collapsed` attribute
// lives on the `group/app` wrapper so children react via group-data-collapsed/
// app: variants (the Tailwind port of the legacy `.app.collapsed` cascade).
// The chrome renders immediately — only data-dependent labels skeleton (inside
// TeamSwitcher/AccountMenu/Breadcrumbs). `.content stagger` is the load-in
// animation; base.css disables it under prefers-reduced-motion.

import { useCallback, useEffect, useState } from "react";
import { Navigate, Outlet, useParams } from "react-router";

import { useIsLocalDevSession } from "../../api/hooks/me";
import { useTeams } from "../../api/hooks/teams";
import { Breadcrumbs } from "./Breadcrumbs";
import { clearLastTeamId, readLastTeamId, writeLastTeamId } from "./lastTeam";
import { EVAL_BANNER_HEIGHT_PX, LocalEvalBanner } from "./LocalEvalBanner";
import { MobileNavDrawer } from "./MobileNavDrawer";
import { Sidebar } from "./Sidebar";
import { classifyTeamRoute } from "./teamResolution";
import { TopBar } from "./TopBar";

const SIDEBAR_COLLAPSED_STORAGE_KEY = "codemagic-patch.dashboard.sidebarCollapsed";

function readCollapsed(): boolean {
  try {
    return (
      window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "1"
    );
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(
      SIDEBAR_COLLAPSED_STORAGE_KEY,
      collapsed ? "1" : "0",
    );
  } catch {
    // Storage unavailable — collapse preference lives for this page load only.
  }
}

export function AppShell() {
  const { teamId } = useParams();
  // Validate the URL's teamId against the caller's visible teams. "pending"
  // (list still loading/errored) must not trigger a persist or a redirect;
  // team-less routes (/account/*, the 404) have no teamId to classify.
  const teamsQuery = useTeams();
  const teamRouteStatus =
    teamId === undefined
      ? "team-less"
      : classifyTeamRoute(teamId, teamsQuery.data);

  const [collapsed, setCollapsed] = useState(readCollapsed);
  // The drawer closes itself on every in-drawer nav link (onNavigate → onClose),
  // on Esc / overlay-click, and on resize past the breakpoint; routes outside
  // the shell (e.g. /login) unmount it entirely.
  const [navDrawerOpen, setNavDrawerOpen] = useState(false);
  // Drives the --eval-banner-h sticky-offset reservation (see the grid div).
  // Session-derived (whoami is already fetched for RBAC) — no extra request.
  const localDevMode = useIsLocalDevSession();

  // Remember only a team the caller is confirmed to belong to. Persisting an
  // unvalidated teamId is what let a stale id (self-host DB reset → new
  // default-team id, revoked membership, foreign deep link) become the
  // remembered team and make `/` redirect back into a dead team forever; an
  // "unknown" team also drops any stale memory so the next `/` re-resolves.
  useEffect(() => {
    if (teamRouteStatus === "known" && teamId !== undefined) {
      writeLastTeamId(teamId);
    } else if (teamRouteStatus === "unknown") {
      clearLastTeamId();
    }
  }, [teamRouteStatus, teamId]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((current) => {
      const next = !current;
      writeCollapsed(next);
      return next;
    });
  }, []);

  // Self-heal: the caller provably doesn't belong to this team, so don't render
  // a dead shell (forbidden/empty pages, a phantom team in the sidebar) — bounce
  // to `/`, where HomeRedirect resolves a valid landing team from GET /v1/teams.
  if (teamRouteStatus === "unknown") {
    return <Navigate to="/" replace />;
  }

  // Stable between events: only our own writes change it, and those happen
  // alongside navigations that re-render this component anyway.
  const activeTeamId = teamId ?? readLastTeamId();

  return (
    <>
    <LocalEvalBanner />
    {/* `[display:grid]` not `grid`: the legacy `.grid{display:grid;gap:18px}`
        component class (still used by page grids) shares the `grid` token and
        would inject an 18px column gap between the sidebar and main column.
        `--eval-banner-h` reserves the sticky evaluation banner's height so
        the TopBar/Sidebar sticky offsets clear it instead of sliding under
        it on scroll (0px whenever the banner is absent). */}
    <div
      className="group/app [display:grid] min-h-screen grid-cols-[var(--sb-w)_1fr] data-collapsed:[--sb-w:76px] max-shell:grid-cols-[1fr]"
      data-collapsed={collapsed || undefined}
      style={
        {
          "--eval-banner-h": localDevMode
            ? `${EVAL_BANNER_HEIGHT_PX}px`
            : "0px",
        } as React.CSSProperties
      }
    >
      {/* Skip-to-content (WCAG 2.4.1): first focusable element, off-screen until
          focused, jumps past the sidebar to the routed content. */}
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      <Sidebar
        teamId={activeTeamId}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
      />
      <MobileNavDrawer
        open={navDrawerOpen}
        onClose={() => setNavDrawerOpen(false)}
        teamId={activeTeamId}
      />
      <main className="flex min-w-0 flex-col">
        <TopBar
          onOpenNav={() => setNavDrawerOpen(true)}
          homeTo={activeTeamId === null ? "/" : `/teams/${activeTeamId}`}
        />
        <div
          id="main-content"
          tabIndex={-1}
          className="stagger mx-auto w-full max-w-[var(--maxw)] flex-1 p-7 outline-none max-shell:p-[18px]"
        >
          <Breadcrumbs />
          <Outlet />
        </div>
      </main>
    </div>
    </>
  );
}
