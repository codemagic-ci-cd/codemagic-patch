// Invitations screen. Like MembersPage the ENTIRE screen is
// `iam.manage`-gated through useTeamRole — non-managers (or a bindings 403)
// get the full-page permission notice, never a broken table; the
// `iam.manage`-gated invitations query itself only mounts once the gate
// passed. Status filter tabs (Pending default / Accepted / Revoked / Expired
// / All) drive `useInvitations(teamId, status)` — each tab is its own query
// key so switching back is cache-warm. Revoke renders only on pending rows.
// A `409 invitation-not-pending` means the invitation changed under us:
// toast + refetch every status tab of the team. Empty states carry per-tab
// copy. Helpers (Glyph icons, gate, dates) are file-local twins of
// MembersPage's — promote to components/ui if a third consumer appears.

import { useId, useState } from "react";
import { useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
} from "react";

import {
  iamKeys,
  useInvitations,
  useRevokeInvitation,
  useRoleBindings,
} from "../api/hooks/iam";
import { classifyProblem, HttpProblemError } from "../api/problem";
import { ConfirmDialog } from "../components/overlay/ConfirmDialog";
import { useToast } from "../components/overlay/ToastProvider";
import { CHIP, CHIP_TONE } from "../components/ui/chip";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorState } from "../components/ui/ErrorState";
import { Skeleton } from "../components/ui/Skeleton";
import { useTeamRole } from "../rbac/useTeamRole";
import { formatDate } from "../model/format";
import { PAGE_TITLE, PAGE_SUB } from "../components/ui/typography";
import type { InvitationStatusFilter } from "../api/hooks/iam";
import type { TeamInvitation, TeamInvitationStatus } from "../model/iam";
import { buttonVariants } from "../components/ui/Button";

export function InvitationsPage() {
  const { teamId } = useParams();
  if (teamId === undefined) {
    // Unreachable: the route declares `:teamId` (router.tsx).
    return null;
  }
  return <InvitationsScreen teamId={teamId} />;
}

// ---------------------------------------------------------------------------
// Screen gate (identical decision tree to MembersPage)
// ---------------------------------------------------------------------------

function InvitationsScreen({ teamId }: { teamId: string }) {
  const { isLoading, can } = useTeamRole(teamId);
  // Same query key as the one useTeamRole reads — gating costs no extra fetch.
  const bindingsQuery = useRoleBindings(teamId);

  let body: ReactNode;
  if (isLoading) {
    body = <LoadingCard label="Loading invitations" />;
  } else if (can("iam.manage")) {
    body = <InvitationsContent teamId={teamId} />;
  } else if (
    bindingsQuery.isError &&
    !isForbiddenProblem(bindingsQuery.error)
  ) {
    body = (
      <div className="rounded-lg border border-border bg-surface p-[22px] shadow-sm">
        <ErrorState
          error={bindingsQuery.error}
          onRetry={() => {
            void bindingsQuery.refetch();
          }}
        />
      </div>
    );
  } else {
    body = <PermissionNotice />;
  }

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start gap-[18px]">
        <div className="min-w-0 flex-1">
          <h1 className={PAGE_TITLE}>
            Invitations
          </h1>
          <p className={PAGE_SUB}>
            Pending and historical invitations by email or GitHub handle. Access
            is granted on the invitee&apos;s next GitHub login.
          </p>
        </div>
      </div>
      {body}
    </>
  );
}

// ---------------------------------------------------------------------------
// Tabs + table (mounted only behind the iam.manage gate)
// ---------------------------------------------------------------------------

const STATUS_TABS: readonly { value: InvitationStatusFilter; label: string }[] =
  [
    { value: "pending", label: "Pending" },
    { value: "accepted", label: "Accepted" },
    { value: "revoked", label: "Revoked" },
    { value: "expired", label: "Expired" },
    { value: "all", label: "All" },
  ];

const EMPTY_COPY: Record<
  InvitationStatusFilter,
  { title: string; description: string }
> = {
  pending: {
    title: "No pending invitations",
    description:
      "Invitations sent from the Members page appear here while they await the invitee's first sign-in.",
  },
  accepted: {
    title: "No accepted invitations",
    description:
      "Invitations turn accepted when the invitee signs in with the invited email.",
  },
  revoked: {
    title: "No revoked invitations",
    description:
      "Invitations you revoke before they are accepted will appear here.",
  },
  expired: {
    title: "No expired invitations",
    description:
      "Invitations that lapse before being accepted will appear here.",
  },
  all: {
    title: "No invitations yet",
    description:
      "Invite teammates from the Members page — every invitation shows up here.",
  },
};

// Status-filter tab (legacy `.tabs`/`.tab`). The tab only ever overrode its
// border-bottom, so the shipped look keeps Chromium's UA button frame on the
// other three sides — painted as flat 2px rgb(84,84,84) top/left + rgb(0,0,0)
// right (outset shading, measured from the baseline now that base.css zeroes
// borders preflight-style). Text color + the bottom-border color swap wholesale
// per state (no-merge contract, see Button.tsx) — hover lives only on idle.
const TAB =
  "-mb-px flex items-center gap-2 border-2 border-t-[rgb(84,84,84)] border-l-[rgb(84,84,84)] border-r-[rgb(0,0,0)] px-4 py-3 text-[13.5px] font-semibold [transition:.13s]";
const TAB_IDLE = "border-b-transparent text-fg-2 hover:text-fg";
const TAB_ACTIVE = "border-b-blue text-blue";

// Pending-count pill (legacy `.badge.soft`, scaled 90% inside the tab).
const BADGE_SOFT =
  "inline-grid h-[19px] min-w-[19px] scale-90 place-items-center rounded-pill bg-blue-tint px-1.5 text-[11px] font-extrabold text-blue";

function InvitationsContent({ teamId }: { teamId: string }) {
  const [status, setStatus] = useState<InvitationStatusFilter>("pending");
  const invitationsQuery = useInvitations(teamId, status);
  const revokeInvitation = useRevokeInvitation();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [pendingRevoke, setPendingRevoke] = useState<TeamInvitation | null>(
    null,
  );
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const idBase = useId();
  const tabId = (value: InvitationStatusFilter) => `${idBase}-tab-${value}`;
  const panelId = `${idBase}-panel`;

  const handleTablistKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }
    event.preventDefault();
    const index = STATUS_TABS.findIndex((entry) => entry.value === status);
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const next =
      STATUS_TABS[(index + delta + STATUS_TABS.length) % STATUS_TABS.length];
    setStatus(next.value);
    document.getElementById(tabId(next.value))?.focus();
  };

  const confirmRevoke = () => {
    if (pendingRevoke === null) {
      return;
    }
    const invitation = pendingRevoke;
    setRevokeError(null);
    revokeInvitation.mutate(
      { invitationId: invitation.id, teamId },
      {
        onSuccess: () => {
          setPendingRevoke(null);
          toast.success("Invitation revoked", {
            description: `${invitationContactValue(invitation)} can no longer use this invitation.`,
          });
        },
        onError: (error) => {
          if (
            error instanceof HttpProblemError &&
            error.typeSuffix === "invitation-not-pending"
          ) {
            // It was accepted/revoked/expired elsewhere — toast + refetch.
            setPendingRevoke(null);
            toast.error("Invitation is no longer pending", {
              description:
                "It was accepted, revoked, or expired elsewhere — refreshing the list.",
            });
            void queryClient.invalidateQueries({
              queryKey: iamKeys.invitationLists(teamId),
            });
          } else {
            // Other failures stay inside the confirm dialog (assertive slot).
            setRevokeError(problemDescription(error));
          }
        },
      },
    );
  };

  // Pending-tab count badge — only when that data is loaded.
  const pendingCount =
    status === "pending" && invitationsQuery.data !== undefined
      ? invitationsQuery.data.length
      : null;

  let panel: ReactNode;
  if (invitationsQuery.isPending) {
    panel = <LoadingCard label="Loading invitations" />;
  } else if (invitationsQuery.isError) {
    panel = (
      <div className="rounded-lg border border-border bg-surface p-[22px] shadow-sm">
        <ErrorState
          error={invitationsQuery.error}
          onRetry={() => {
            void invitationsQuery.refetch();
          }}
        />
      </div>
    );
  } else if (invitationsQuery.data.length === 0) {
    const copy = EMPTY_COPY[status];
    panel = (
      <div className="rounded-lg border border-border bg-surface shadow-sm">
        <EmptyState
          icon={<MailIcon />}
          title={copy.title}
          description={copy.description}
        />
      </div>
    );
  } else {
    panel = (
      <InvitationTable
        invitations={invitationsQuery.data}
        onRevoke={(invitation) => {
          setRevokeError(null);
          setPendingRevoke(invitation);
        }}
      />
    );
  }

  return (
    <div>
      <div
        className="flex gap-1 border-b border-border"
        role="tablist"
        aria-label="Invitation status"
        onKeyDown={handleTablistKeyDown}
      >
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            id={tabId(tab.value)}
            role="tab"
            aria-selected={status === tab.value}
            aria-controls={panelId}
            tabIndex={status === tab.value ? 0 : -1}
            className={`${TAB} ${status === tab.value ? TAB_ACTIVE : TAB_IDLE}`}
            onClick={() => setStatus(tab.value)}
          >
            {tab.label}
            {tab.value === "pending" && pendingCount !== null ? (
              <span className={BADGE_SOFT}>{pendingCount}</span>
            ) : null}
          </button>
        ))}
      </div>
      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={tabId(status)}
        className="pt-[18px]"
      >
        {panel}
      </div>
      <ConfirmDialog
        open={pendingRevoke !== null}
        variant="summary"
        destructive
        icon={<AlertIcon />}
        title="Revoke invitation"
        description="The invitee will no longer be able to use this invitation."
        summary={
          pendingRevoke === null
            ? []
            : [
                {
                  label: invitationContactLabel(pendingRevoke),
                  value: invitationContactValue(pendingRevoke),
                },
                { label: "Role", value: pendingRevoke.role.key },
                {
                  label: "Expires",
                  value: (
                    <span>
                      {formatDate(pendingRevoke.expiresAt)}
                    </span>
                  ),
                },
              ]
        }
        confirmLabel="Revoke"
        busy={revokeInvitation.isPending}
        error={revokeError}
        onCancel={() => setPendingRevoke(null)}
        onConfirm={confirmRevoke}
      />
    </div>
  );
}

// An invitation targets an email or a GitHub handle; display whichever is set.
function invitationContactValue(invitation: TeamInvitation): string {
  return invitation.email ?? `@${invitation.githubHandle ?? ""}`;
}

function invitationContactLabel(invitation: TeamInvitation): string {
  return invitation.email !== null ? "Email" : "GitHub handle";
}

const STATUS_CHIP: Record<
  TeamInvitationStatus,
  { className: string; label: string }
> = {
  pending: { className: `${CHIP} ${CHIP_TONE.blue}`, label: "Pending" },
  accepted: { className: `${CHIP} ${CHIP_TONE.green}`, label: "Accepted" },
  revoked: { className: `${CHIP} ${CHIP_TONE.red}`, label: "Revoked" },
  expired: { className: `${CHIP} ${CHIP_TONE.neutral}`, label: "Expired" },
};

function InvitationTable({
  invitations,
  onRevoke,
}: {
  invitations: readonly TeamInvitation[];
  onRevoke: (invitation: TeamInvitation) => void;
}) {
  const hasPendingRows = invitations.some(
    (invitation) => invitation.status === "pending",
  );

  return (
    <div className="rounded-lg border border-border bg-surface shadow-sm">
      <div className="overflow-auto">
        <table className="w-full border-collapse text-[13.5px]">
          <thead>
            <tr>
              <th className={TBL_TH}>Invitee</th>
              <th className={TBL_TH}>Role</th>
              <th className={TBL_TH}>Invited</th>
              <th className={TBL_TH}>Expires</th>
              <th className={TBL_TH}>Status</th>
              {hasPendingRows ? (
                <th className={TBL_TH}>
                  <span className="sr-only">Actions</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {invitations.map((invitation) => {
              const chip = STATUS_CHIP[invitation.status];
              return (
                <tr key={invitation.id} className={TBL_TR}>
                  <td className={TBL_TD}>
                    <span className="font-semibold">
                      {invitationContactValue(invitation)}
                    </span>
                  </td>
                  <td className={TBL_TD}>
                    <span className={`role role-${invitation.role.key}`}>
                      {invitation.role.key}
                    </span>
                  </td>
                  <td className={TBL_TD}>
                    <span
                      className="text-[13px] text-fg-3"
                    >
                      {formatDate(invitation.createdAt)}
                    </span>
                  </td>
                  <td className={TBL_TD}>
                    <span
                      className="text-[13px] text-fg-3"
                    >
                      {invitation.status === "pending"
                        ? relativeExpiry(invitation.expiresAt)
                        : formatDate(invitation.expiresAt)}
                    </span>
                  </td>
                  <td className={TBL_TD}>
                    <span className={chip.className}>{chip.label}</span>
                  </td>
                  {hasPendingRows ? (
                    <td className={`${TBL_TD} text-right`}>
                      {invitation.status === "pending" ? (
                        <button
                          type="button"
                          className={buttonVariants({
                            intent: "dangerGhost",
                            size: "sm",
                          })}
                          onClick={() => onRevoke(invitation)}
                        >
                          Revoke
                        </button>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Table literals (legacy `.tbl` th/td/row rules). Header/cell styling lives on
// each th/td; the row carries the hover tint and drops the divider on the last
// row's cells (legacy `tbody tr:last-child td`).
const TBL_TH =
  "border-b border-border bg-surface-2 px-[18px] py-[13px] text-left text-[11px] font-bold uppercase tracking-[.06em] whitespace-nowrap text-fg-3";

const TBL_TD = "border-b border-border px-[18px] py-[15px] align-middle";

const TBL_TR =
  "[transition:.12s] hover:bg-surface-2 [&:last-child>td]:border-b-0";

// ---------------------------------------------------------------------------
// Shared screen states + helpers (file-local twins of MembersPage's)
// ---------------------------------------------------------------------------

/** Full-page permission notice (deep link without `iam.manage`). */
function PermissionNotice() {
  return (
    <div className="rounded-lg border border-border bg-surface p-[22px] shadow-sm">
      <EmptyState
        icon={<LockIcon />}
        title="Requires admin"
        description="Members and invitations are managed by team admins — ask a team admin for access."
      />
    </div>
  );
}

function LoadingCard({ label }: { label: string }) {
  return (
    <div
      className="rounded-lg border border-border bg-surface p-[22px] shadow-sm"
      role="status"
      aria-label={label}
    >
      <Skeleton width="38%" height={18} />
      <div className="mt-4 gap-2.5 [display:grid]">
        <Skeleton height={36} />
        <Skeleton height={36} />
        <Skeleton height={36} />
      </div>
    </div>
  );
}

function isForbiddenProblem(error: unknown): boolean {
  return (
    error instanceof HttpProblemError && classifyProblem(error) === "forbidden"
  );
}

function problemDescription(error: unknown): string {
  if (error instanceof HttpProblemError) {
    return error.detail ?? error.title ?? "The request couldn't be completed.";
  }
  return "The request couldn't be completed. Check your connection and try again.";
}

const DAY_MS = 86_400_000;

/** Pending rows show the relative expiry ("in 14 days"). */
function relativeExpiry(iso: string): string {
  const expiresAt = new Date(iso).getTime();
  if (Number.isNaN(expiresAt)) {
    return iso;
  }
  const days = Math.ceil((expiresAt - Date.now()) / DAY_MS);
  if (days <= 0) {
    // Defensive: the server flips status on read, but clocks can skew.
    return "expired";
  }
  return days === 1 ? "in 1 day" : `in ${days} days`;
}

// --- Icons (paths mirror the shared icon set) ------------------------------

function Glyph({
  style,
  children,
}: {
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <svg
      style={style}
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

function MailIcon() {
  return (
    <Glyph>
      <rect x="2" y="4" width="20" height="16" rx="2.5" />
      <path d="m3 7 9 6 9-6" />
    </Glyph>
  );
}

function LockIcon() {
  return (
    <Glyph>
      <rect x="4" y="11" width="16" height="10" rx="2.5" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </Glyph>
  );
}

function AlertIcon() {
  return (
    <Glyph>
      <path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12" y2="17" />
    </Glyph>
  );
}
