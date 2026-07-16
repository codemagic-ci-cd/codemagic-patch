// Team overview screen (route `/teams/:teamId`) — header + the "This team"
// composition. The overview is composed CLIENT-SIDE (no
// aggregate endpoint): count tiles from useApps / useRoleBindings /
// useInvitations(teamId, "pending"). Members and invitations are
// `iam.manage`-gated server-side — a 403 `forbidden` HIDES those tiles (and
// the members quick link) instead of erroring the page; other tile failures
// degrade to "—" + Retry without failing the page (the metric-cell
// convention). Header shows the team name/status via useTeam plus the lazy
// role badge (skeleton while resolving, inferred confidence tolerated).
// Quick links → apps/members/metrics. Mandatory states: per-region skeletons,
// page-level ErrorState (useTeam failure → retry; not-found/forbidden copy
// comes from the shared classifier). Breadcrumbs are omitted on this screen
// (see Breadcrumbs.tsx). TeamRoleBadge mirrors the TeamsPage helper by design
// helper by design (shared extraction would exceed this task's file set).

import { Link, useParams } from "react-router";
import type { CSSProperties, ReactNode } from "react";

import { useApps } from "../api/hooks/apps";
import { useInvitations, useRoleBindings } from "../api/hooks/iam";
import { useIsMultiTeam, useTeam } from "../api/hooks/teams";
import { classifyProblem, HttpProblemError } from "../api/problem";
import { ErrorState } from "../components/ui/ErrorState";
import { Skeleton } from "../components/ui/Skeleton";
import type { Role } from "../model/permissions";
import type { TeamStatus } from "../model/team";
import { useTeamRole } from "../rbac/useTeamRole";
import { buttonVariants } from "../components/ui/Button";
import { SUMMARY_ROW } from "../components/ui/summary";
import { CHIP, CHIP_TONE } from "../components/ui/chip";
import { PAGE_SUB, PAGE_TITLE } from "../components/ui/typography";
import {
  STAT,
  STAT_ICO_ACCENT,
  STAT_ICO_BASE,
  STAT_META,
  STAT_TOP,
  STAT_VAL,
} from "../components/ui/stat";

export function TeamOverviewPage() {
  const { teamId } = useParams();
  if (teamId === undefined) {
    // Unreachable under the route map; satisfies narrowing and fails
    // loudly (ErrorBoundary) if the route shape ever changes.
    throw new Error("TeamOverviewPage requires a :teamId route param");
  }
  return <TeamOverview teamId={teamId} />;
}

function TeamOverview({ teamId }: { teamId: string }) {
  const teamQuery = useTeam(teamId);
  // Same query the members tile (and useTeamRole) subscribe to — TanStack
  // dedupes by key; read here to drive the members quick-link visibility.
  const bindingsQuery = useRoleBindings(teamId);
  // Single-team OSS: the fixed `default-team` name is a machine slug, so only
  // name the team in the subtitle when there is more than one to disambiguate.
  const isMultiTeam = useIsMultiTeam();

  if (teamQuery.isError) {
    return (
      <div className="rounded-lg border border-border bg-surface p-[22px] shadow-sm">
        <ErrorState
          error={teamQuery.error}
          onRetry={() => void teamQuery.refetch()}
        />
      </div>
    );
  }

  const team = teamQuery.data;
  const membersHidden =
    bindingsQuery.isError && isForbiddenError(bindingsQuery.error);

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start gap-[18px]">
        <div className="min-w-0 flex-1">
          <h1 className={PAGE_TITLE}>
            Overview
            {team !== undefined ? (
              <TeamStatusChip status={team.status} />
            ) : null}
            <TeamRoleBadge teamId={teamId} />
          </h1>
          <p className={PAGE_SUB}>
            Real-time health of your OTA releases across every app
            {isMultiTeam ? (
              <>
                {" "}
                in{" "}
                {team !== undefined ? (
                  <b>{team.name}</b>
                ) : (
                  <Skeleton width={90} variant="text" />
                )}
              </>
            ) : null}
            .
          </p>
        </div>
      </div>

      <div className="mb-[18px] grid-cols-[repeat(3,1fr)] gap-[18px] [display:grid] max-cols:grid-cols-[1fr]">
        <AppsTile teamId={teamId} />
        <MembersTile teamId={teamId} />
        <InvitationsTile teamId={teamId} />
      </div>

      <div className="rounded-lg border border-border bg-surface p-[22px] shadow-sm">
        <div className="mb-[18px] flex items-center gap-2.5 text-[16px] font-bold tracking-[-.01em]">
          This team
        </div>
        <div className="flex flex-col gap-0">
          <QuickLink
            to={`/teams/${teamId}/apps`}
            icon={<AppsIcon />}
            iconBackground="var(--color-blue-tint)"
            iconColor="var(--color-blue)"
            title="Apps"
            subtitle="Manage apps & deployments"
          />
          {!membersHidden ? (
            <>
              <div className="h-px bg-border my-1" />
              <QuickLink
                to={`/teams/${teamId}/members`}
                icon={<UsersIcon />}
                iconBackground="var(--color-aqua-tint)"
                iconColor="#0496c0"
                title="Members"
                subtitle="Roles & access"
              />
            </>
          ) : null}
          <div className="h-px bg-border my-1" />
          <QuickLink
            to={`/teams/${teamId}/metrics`}
            icon={<ChartIcon />}
            iconBackground="var(--color-green-tint)"
            iconColor="var(--color-green-deep)"
            title="Metrics"
            subtitle="Release health & adoption"
          />
        </div>
      </div>
    </>
  );
}

// --- Count tiles (client-composed) -------------------------------------------

/** Apps count (`useApps`); failures degrade to "—" + Retry, never the page. */
function AppsTile({ teamId }: { teamId: string }) {
  const appsQuery = useApps(teamId);
  return (
    <CountTile
      accent="var(--color-blue)"
      icon={<AppsIcon />}
      label="Apps"
      count={appsQuery.data?.length}
      isPending={appsQuery.isPending}
      isError={appsQuery.isError}
      onRetry={() => void appsQuery.refetch()}
      to={`/teams/${teamId}/apps`}
      linkText="View apps"
    />
  );
}

/** Members count (`useRoleBindings`) — hidden entirely on 403 `forbidden`. */
function MembersTile({ teamId }: { teamId: string }) {
  const bindingsQuery = useRoleBindings(teamId);
  if (bindingsQuery.isError && isForbiddenError(bindingsQuery.error)) {
    return null;
  }
  return (
    <CountTile
      accent="var(--color-aqua)"
      accentTint="var(--color-aqua-tint)"
      icon={<UsersIcon />}
      label="Members"
      count={bindingsQuery.data?.length}
      isPending={bindingsQuery.isPending}
      isError={bindingsQuery.isError}
      onRetry={() => void bindingsQuery.refetch()}
      to={`/teams/${teamId}/members`}
      linkText="View members"
    />
  );
}

/** Pending invitations count (`useInvitations`) — hidden entirely on 403. */
function InvitationsTile({ teamId }: { teamId: string }) {
  const invitationsQuery = useInvitations(teamId, "pending");
  if (invitationsQuery.isError && isForbiddenError(invitationsQuery.error)) {
    return null;
  }
  return (
    <CountTile
      accent="var(--color-yellow)"
      accentTint="var(--color-yellow-tint)"
      icon={<MailIcon />}
      label="Pending invitations"
      count={invitationsQuery.data?.length}
      isPending={invitationsQuery.isPending}
      isError={invitationsQuery.isError}
      onRetry={() => void invitationsQuery.refetch()}
      to={`/teams/${teamId}/members`}
      linkText="View members"
    />
  );
}

function CountTile({
  accent,
  accentTint,
  icon,
  label,
  count,
  isPending,
  isError,
  onRetry,
  to,
  linkText,
}: {
  accent: string;
  accentTint?: string;
  icon: ReactNode;
  label: string;
  count: number | undefined;
  isPending: boolean;
  isError: boolean;
  onRetry: () => void;
  to: string;
  linkText: string;
}) {
  const style = {
    "--accent": accent,
    ...(accentTint !== undefined ? { "--accent-tint": accentTint } : {}),
  } as CSSProperties;
  return (
    <div className={STAT} style={style} aria-busy={isPending || undefined}>
      <div className={STAT_TOP}>
        <span className={`${STAT_ICO_BASE} ${STAT_ICO_ACCENT}`} aria-hidden="true">
          {icon}
        </span>{" "}
        {label}
      </div>
      <div className={STAT_VAL}>
        {isPending ? (
          <Skeleton width={56} height={30} />
        ) : isError ? (
          "—"
        ) : (
          count
        )}
      </div>
      <div className={STAT_META}>
        {isError ? (
          <button
            type="button"
            className={buttonVariants({ intent: "subtle", size: "sm" })}
            onClick={onRetry}
          >
            Retry
          </button>
        ) : (
          <Link to={to}>
            {linkText} <ChevRightIcon />
          </Link>
        )}
      </div>
    </div>
  );
}

// --- Quick links ("This team" rows) -------------------------------------------

function QuickLink({
  to,
  icon,
  iconBackground,
  iconColor,
  title,
  subtitle,
}: {
  to: string;
  icon: ReactNode;
  iconBackground: string;
  iconColor: string;
  title: string;
  subtitle: string;
}) {
  return (
    <Link
      className={`${SUMMARY_ROW} px-0`}
      to={to}
      // border:0 OVERRIDES SUMMARY_ROW's border-b; conflicting utilities cannot
      // co-apply, so the border reset stays inline (these rows are border-less).
      style={{ border: 0 }}
    >
      <span
        className={STAT_ICO_BASE}
        style={{ background: iconBackground, color: iconColor }}
        aria-hidden="true"
      >
        {icon}
      </span>
      <div>
        <div className="font-bold">{title}</div>
        <div className="mt-0.5 text-[12px] text-fg-3">{subtitle}</div>
      </div>
      <span className="text-fg-3 ml-auto" aria-hidden="true">
        <ChevRightIcon />
      </span>
    </Link>
  );
}

// --- Header fragments ---------------------------------------------------------

const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  developer: "Developer",
  viewer: "Viewer",
};

/** Lazy role badge — mirrors the TeamsPage helper (see module header). */
function TeamRoleBadge({ teamId }: { teamId: string }) {
  const { role, isLoading } = useTeamRole(teamId);
  if (isLoading) {
    return <Skeleton width={64} height={22} />;
  }
  if (role === null) {
    return null;
  }
  return <span className={`role role-${role}`}>{ROLE_LABELS[role]}</span>;
}

function TeamStatusChip({ status }: { status: TeamStatus }) {
  const active = status === "active";
  return (
    <span className={`${CHIP} ${active ? CHIP_TONE.green : CHIP_TONE.red}`}>
      <span
        className="size-1.5 rounded-pill bg-current"
        aria-hidden="true"
      />
      {active ? "Active" : "Disabled"}
    </span>
  );
}

// --- Shared -------------------------------------------------------------------

function isForbiddenError(error: unknown): boolean {
  return (
    error instanceof HttpProblemError && classifyProblem(error) === "forbidden"
  );
}

// --- Icons (lucide-style glyph paths) -----------------------------------------

function PageIcon({ children }: { children: ReactNode }) {
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

function AppsIcon() {
  return (
    <PageIcon>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </PageIcon>
  );
}

function UsersIcon() {
  return (
    <PageIcon>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </PageIcon>
  );
}

function MailIcon() {
  return (
    <PageIcon>
      <rect x="2" y="4" width="20" height="16" rx="2.5" />
      <path d="m3 7 9 6 9-6" />
    </PageIcon>
  );
}

function ChartIcon() {
  return (
    <PageIcon>
      <path d="M3 3v18h18" />
      <rect x="7" y="11" width="3" height="6" rx="1" fill="currentColor" stroke="none" />
      <rect x="12.5" y="7" width="3" height="10" rx="1" fill="currentColor" stroke="none" />
      <rect x="18" y="13" width="3" height="4" rx="1" fill="currentColor" stroke="none" />
    </PageIcon>
  );
}

function ChevRightIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={14}
      height={14}
      className="align-[-2px]"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}
