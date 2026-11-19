// Team overview screen (route `/teams/:teamId`) — header + the "This team"
// composition. The overview is composed CLIENT-SIDE (no
// aggregate endpoint): count tiles from useApps / useRoleBindings /
// useInvitations(teamId, "pending"). Members and invitations are
// `iam.manage`-gated server-side — a 403 `forbidden` HIDES those tiles (and
// the members quick link) instead of erroring the page; other tile failures
// degrade to "—" + Retry without failing the page (the metric-cell
// convention). Header shows the team name via useTeam; a disabled team
// surfaces as plain text next to the title. Quick links → apps/members.
// Mandatory states: per-region skeletons, page-level ErrorState (useTeam
// failure → retry; not-found/forbidden copy comes from the shared
// classifier). Breadcrumbs are omitted on this screen (see Breadcrumbs.tsx).

import { Link, useParams } from "react-router";
import type { ReactNode } from "react";

import { useApps } from "../api/hooks/apps";
import { useInvitations, useRoleBindings } from "../api/hooks/iam";
import { useTeam } from "../api/hooks/teams";
import { classifyProblem, HttpProblemError } from "../api/problem";
import { ErrorState } from "../components/ui/ErrorState";
import { PageHeader } from "../components/ui/PageHeader";
import { Skeleton } from "../components/ui/Skeleton";
import { buttonVariants } from "../components/ui/Button";
import { SUMMARY_ROW } from "../components/ui/summary";
import { SECTION_TITLE } from "../components/ui/typography";
import {
  STAT_ICO_BASE,
  STAT_META,
  STAT_TOP,
  STAT_VAL,
} from "../components/ui/stat";

/** Overview count card without the coloured accent strip metrics counters use. */
const OVERVIEW_STAT =
  "relative overflow-hidden rounded-lg border border-border bg-surface px-5 py-[18px] shadow-sm";

const NEUTRAL_ICO = `${STAT_ICO_BASE} bg-surface-2 text-fg-2`;

const TITLE_META = "text-[14px] font-semibold tracking-normal text-fg-3";

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
  // Same query the members tile subscribes to — TanStack dedupes by key;
  // read here to drive the members quick-link visibility.
  const bindingsQuery = useRoleBindings(teamId);

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
      <PageHeader
        title={
          <>
            Overview
            {team !== undefined && team.status === "disabled" ? (
              <span className={TITLE_META}>Disabled</span>
            ) : null}
          </>
        }
      />

      <div className="mb-[18px] grid-cols-[repeat(3,1fr)] gap-[18px] [display:grid] max-cols:grid-cols-[1fr]">
        <AppsTile teamId={teamId} />
        <MembersTile teamId={teamId} />
        <InvitationsTile teamId={teamId} />
      </div>

      <div className="rounded-lg border border-border bg-surface p-[22px] shadow-sm">
        <div className={`${SECTION_TITLE} mb-[18px]`}>
          This team
        </div>
        <div className="flex flex-col gap-0">
          <QuickLink
            to={`/teams/${teamId}/apps`}
            icon={<AppsIcon />}
            title="Apps"
          />
          {!membersHidden ? (
            <>
              <div className="h-px bg-border my-1" />
              <QuickLink
                to={`/teams/${teamId}/members`}
                icon={<UsersIcon />}
                title="Members"
              />
            </>
          ) : null}
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
  icon,
  label,
  count,
  isPending,
  isError,
  onRetry,
  to,
  linkText,
}: {
  icon: ReactNode;
  label: string;
  count: number | undefined;
  isPending: boolean;
  isError: boolean;
  onRetry: () => void;
  to: string;
  linkText: string;
}) {
  return (
    <div className={OVERVIEW_STAT} aria-busy={isPending || undefined}>
      <div className={STAT_TOP}>
        <span className={NEUTRAL_ICO} aria-hidden="true">
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
  title,
}: {
  to: string;
  icon: ReactNode;
  title: string;
}) {
  return (
    <Link
      className={`${SUMMARY_ROW} px-0`}
      to={to}
      // border:0 OVERRIDES SUMMARY_ROW's border-b; conflicting utilities cannot
      // co-apply, so the border reset stays inline (these rows are border-less).
      style={{ border: 0 }}
    >
      <span className={NEUTRAL_ICO} aria-hidden="true">
        {icon}
      </span>
      <div>
        <div className="font-semibold text-fg">{title}</div>
      </div>
      <span className="text-fg-3 ml-auto" aria-hidden="true">
        <ChevRightIcon />
      </span>
    </Link>
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
