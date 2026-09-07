// Team-scoped sidebar: brand, main nav (Apps, Metrics), and a foot section
// (Profile, Status, Members for `iam.manage`, GitHub repo link) above Collapse.
// against the route map — the DOM/class structure is ported, its hardcoded
// `.html` hrefs and global `DB` are not. Members is HIDDEN, not disabled,
// when the resolved role lacks `iam.manage` (useTeamRole — inferred developer
// and still-loading states both hide it, so forbidden links never flash).
// Profile (`/account/profile`) and Status (`/account/server`) are
// account-scoped; Profile is always shown, Status only once
// `GET /v1/server/status` has answered anything but 501 (a deployment
// without a status handler). API tokens and log out live on the Profile page.
// Profile's active match covers `/account/profile` and `/account/tokens`
// only, so Status can light independently. The chrome
// renders immediately: nav needs only the route's teamId; on team-less
// routes (/teams, /account/*) the shell passes the last-team fallback, and
// with no team at all only brand/footer/collapse render. Collapse state is
// owned by AppShell (the wrapper's `data-collapsed` drives the
// group-data-collapsed/app: variants here); the button reports the toggle.

import { Link, NavLink, useLocation } from "react-router";
import type { ReactElement, ReactNode } from "react";

import { PRODUCT_NAME, SOURCE_REPO_URL } from "../../branding";
import { PatchBrand } from "../brand/PatchBrand";
import { useServerStatusAvailability } from "../../api/hooks/serverStatus";
import { useTeamRole } from "../../rbac/useTeamRole";

// nav-item is split base + state under the no-merge contract: the idle/active
// skins swap wholesale (background, color, and the svg opacity/tint), so each
// state carries its own `[&_svg]:opacity-*` and the base carries none. `hover`
// lives ONLY in the idle state — legacy `.nav-item.active` beat `:hover` by
// source order, so active items must not gain a hover: background/color that
// would win under co-application. `nav-active-bar` anchors the ::before
// indicator (keep-list); active links add `is-active` to light it. Labels are
// <span>s — collapsed hides them (legacy `.app.collapsed .nav-item span`); no
// .badge is rendered here so its legacy margin/hide rules drop with the rule.
const NAV_ITEM =
  "nav-active-bar relative flex items-center gap-3 whitespace-nowrap rounded-[10px] px-[9px] py-[9px] text-[15px] font-medium [transition:.15s] [&_svg]:size-[18px] [&_svg]:flex-none group-data-collapsed/app:justify-center group-data-collapsed/app:p-2.5 group-data-collapsed/app:[&_span]:hidden";

const NAV_ITEM_IDLE =
  "text-sb-text hover:bg-surface-2 hover:text-fg [&_svg]:opacity-85";

const NAV_ITEM_ACTIVE =
  "is-active bg-nav-active text-white shadow-xs [&_svg]:text-white [&_svg]:opacity-100";

export interface SidebarProps {
  /** Active team id (route param or last-team fallback); null hides team nav. */
  teamId: string | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

export function Sidebar(props: SidebarProps) {
  // top offset + height clear the sticky evaluation banner when present
  // (--eval-banner-h is 0px outside local evaluation mode — see AppShell).
  return (
    <aside className="sb-art sticky top-[var(--eval-banner-h,0px)] flex h-[calc(100vh-var(--eval-banner-h,0px))] flex-col overflow-hidden border-r border-sb-border bg-sb-bg text-sb-text max-shell:hidden">
      <SidebarBody {...props} />
    </aside>
  );
}

export interface SidebarBodyProps {
  teamId: string | null;
  collapsed: boolean;
  /** Omitted in the mobile drawer (no collapse control there). */
  onToggleCollapsed?: () => void;
  /** Called after any in-app navigation — the mobile drawer closes itself. */
  onNavigate?: () => void;
}

/**
 * Sidebar contents (brand, nav, footer), shared verbatim by the
 * desktop `<aside>` and the sub-760px MobileNavDrawer. The drawer renders this
 * with no collapse control and an `onNavigate` that closes the drawer on a link
 * tap; the `group-data-collapsed/app:` variants stay inert there (no collapsed
 * ancestor), so it always renders expanded.
 */
export function SidebarBody({
  teamId,
  collapsed,
  onToggleCollapsed,
  onNavigate,
}: SidebarBodyProps) {
  return (
    <>
      <Link
        className="flex items-center px-[33px] pb-3 pt-5 group-data-collapsed/app:justify-center group-data-collapsed/app:px-2.5"
        to={teamId === null ? "/" : `/teams/${teamId}`}
        aria-label={PRODUCT_NAME}
        onClick={onNavigate}
      >
        <PatchBrand
          decorative
          className="h-7 w-auto group-data-collapsed/app:hidden"
        />
        <PatchBrand
          variant="mark"
          decorative
          className="hidden size-7 group-data-collapsed/app:block"
        />
      </Link>
      {teamId !== null && <TeamNav teamId={teamId} onNavigate={onNavigate} />}
      <div className="flex-1" />
      <SidebarFoot teamId={teamId} onNavigate={onNavigate} />
      {onToggleCollapsed !== undefined && (
        <button
          type="button"
          className="mx-3 mb-3 flex items-center justify-center gap-2 rounded-sm border border-sb-border bg-surface-2 p-[7px] text-[13px] text-sb-text [transition:.15s] hover:bg-surface-3 hover:text-fg [&_svg]:size-4 [&_svg]:[transition:.2s] group-data-collapsed/app:[&_svg]:rotate-180 group-data-collapsed/app:[&_span]:hidden"
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <NavIcon>
            <polyline points="11 17 6 12 11 7" />
            <polyline points="18 17 13 12 18 7" />
          </NavIcon>
          <span>Collapse</span>
        </button>
      )}
      <div className="border-t border-sb-border p-3.5 text-[12px] text-fg-3">
        Codemagic © 2026
      </div>
    </>
  );
}

// --- Team-scoped navigation (separate component so hooks stay unconditional)

interface TeamNavItem {
  key: string;
  label: string;
  /** Path segment under `/teams/:teamId`. */
  segment: string;
  icon: ReactElement;
}

const MAIN_NAV_ITEMS: readonly TeamNavItem[] = [
  {
    key: "apps",
    label: "Apps",
    segment: "apps",
    icon: (
      <NavIcon>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </NavIcon>
    ),
  },
  {
    key: "metrics",
    label: "Metrics",
    segment: "metrics",
    icon: (
      <NavIcon>
        <path d="M3 3v18h18" />
        <rect x="7" y="11" width="3" height="6" rx="1" fill="currentColor" stroke="none" />
        <rect x="12.5" y="7" width="3" height="10" rx="1" fill="currentColor" stroke="none" />
        <rect x="18" y="13" width="3" height="4" rx="1" fill="currentColor" stroke="none" />
      </NavIcon>
    ),
  },
];

const MEMBERS_NAV_ITEM: TeamNavItem = {
  key: "members",
  label: "Members",
  segment: "members",
  icon: (
    <NavIcon>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </NavIcon>
  ),
};

function TeamNav({
  teamId,
  onNavigate,
}: {
  teamId: string;
  onNavigate?: () => void;
}) {
  return (
    <div className="px-3 pb-1 pt-1">
      <nav className="flex flex-col gap-[2px] px-3" aria-label="Team">
        {MAIN_NAV_ITEMS.map((item) => (
          <SidebarNavLink
            key={item.key}
            teamId={teamId}
            item={item}
            onNavigate={onNavigate}
          />
        ))}
      </nav>
    </div>
  );
}

function SidebarFoot({
  teamId,
  onNavigate,
}: {
  teamId: string | null;
  onNavigate?: () => void;
}) {
  return (
    <div className="border-t border-sb-border px-3 pb-1 pt-3">
      <nav className="flex flex-col gap-[2px] px-3" aria-label="More">
        <ProfileNavLink onNavigate={onNavigate} />
        <StatusNavLink onNavigate={onNavigate} />
        {teamId !== null ? (
          <MembersNavLink teamId={teamId} onNavigate={onNavigate} />
        ) : null}
        <a
          href={SOURCE_REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          className={`${NAV_ITEM} ${NAV_ITEM_IDLE}`}
          onClick={onNavigate}
        >
          <GitHubNavIcon />
          <span>Repo</span>
        </a>
      </nav>
    </div>
  );
}

function ProfileNavLink({ onNavigate }: { onNavigate?: () => void }) {
  const { pathname } = useLocation();
  const isActive =
    pathname === "/account/profile" || pathname === "/account/tokens";

  return (
    <Link
      to="/account/profile"
      className={`${NAV_ITEM} ${isActive ? NAV_ITEM_ACTIVE : NAV_ITEM_IDLE}`}
      aria-current={isActive ? "page" : undefined}
      onClick={onNavigate}
    >
      <NavIcon>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21v-1a6 6 0 0 1 12 0v1" />
      </NavIcon>
      <span>Profile</span>
    </Link>
  );
}

function StatusNavLink({ onNavigate }: { onNavigate?: () => void }) {
  // HIDDEN, not disabled, until the server says the page exists: a
  // deployment without a status handler answers 501 and never shows it; the
  // entry appears once the server answers anything else.
  const availability = useServerStatusAvailability();
  if (availability !== "available") {
    return null;
  }

  return (
    <NavLink
      to="/account/server"
      className={({ isActive }) =>
        `${NAV_ITEM} ${isActive ? NAV_ITEM_ACTIVE : NAV_ITEM_IDLE}`
      }
      onClick={onNavigate}
    >
      <NavIcon>
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <path d="M6 21h12M12 17v4" />
      </NavIcon>
      <span>Status</span>
    </NavLink>
  );
}

function MembersNavLink({
  teamId,
  onNavigate,
}: {
  teamId: string;
  onNavigate?: () => void;
}) {
  const { can } = useTeamRole(teamId);
  if (!can("iam.manage")) {
    return null;
  }

  return (
    <SidebarNavLink
      teamId={teamId}
      item={MEMBERS_NAV_ITEM}
      onNavigate={onNavigate}
    />
  );
}

function SidebarNavLink({
  teamId,
  item,
  onNavigate,
}: {
  teamId: string;
  item: TeamNavItem;
  onNavigate?: () => void;
}) {
  return (
    <NavLink
      to={`/teams/${teamId}/${item.segment}`}
      className={({ isActive }) =>
        `${NAV_ITEM} ${isActive ? NAV_ITEM_ACTIVE : NAV_ITEM_IDLE}`
      }
      onClick={onNavigate}
    >
      {item.icon}
      <span>{item.label}</span>
    </NavLink>
  );
}

// --- Ported icon set (lucide-style strokes) --------------------------------

function NavIcon({ children }: { children: ReactNode }) {
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
      {children}
    </svg>
  );
}

function GitHubNavIcon() {
  return (
    <NavIcon>
      <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
    </NavIcon>
  );
}
