// Members screen (through the single Add-member modal). The ENTIRE screen is
// `iam.manage`-gated: while useTeamRole resolves → skeleton; non-managers
// (exact viewer/developer binding, or the bindings 403 inference) get a
// FULL-PAGE permission notice instead of a broken table; non-403 bindings
// failures render the problem-mapped ErrorState with retry. Invitations are
// merged into the members table (Status column): pending rows sit on top,
// expired rows sit greyed-out below the members as history; revoked and
// accepted invitations are hidden (accepted ones exist as member rows). Only
// pending rows carry a Revoke action — the server 409s on any other status.
// Removal follows
// the optimistic pattern — the confirm closes immediately, the row is
// dropped from the cached bindings list (in-flight fetches cancelled first)
// and restored on error; `409 last-owner` renders the inline blocking callout
// instead of a toast. Role changes are NOT optimistic: the confirm dialog
// stays open until the PATCH lands, so both 409s (last-owner, the member
// already holds the role) surface in its inline error slot where the user can
// pick a different role. The sole owner's kebab disables both actions. The
// Add-member modal is ONE flow over the three IAM endpoints: it tries
// role-bindings first and falls back to an invitation on 404 user_not_found
// (no invitation is ever "sent" — access materializes on the invitee's next
// sign-in, and the copy says so), goes straight to an invitation for GitHub
// handles (the only handle kind the server can resolve; gated on a configured
// GitHub provider via web-config), and uses provisioning when "Provision with
// an API token" is checked (new accounts only — 409 user-exists renders the
// add-without-token callout). 201-created vs 200-already_exists is discriminated by
// comparing the returned binding id against the pre-mutation cache (the hook
// envelope carries no status), and a fresh-vs-already-pending invitation the
// same way against the cached invitation list. Provision success swaps to the
// show-once PAT modal (`disableEscapeClose`, Copyable full token — bindings
// refresh is already handled by useProvisionMember's invalidation). Helpers
// (Glyph icons, gate, dates) are file-local — promote to components/ui if a
// third consumer appears.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import type {
  CSSProperties,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
} from "react";

import {
  iamKeys,
  useAddRoleBinding,
  useCreateInvitation,
  useInvitations,
  useProvisionMember,
  useRemoveRoleBinding,
  useRevokeInvitation,
  useRoleBindings,
  useRoles,
  useUpdateRoleBinding,
} from "../api/hooks/iam";
import { useWebConfig } from "../api/hooks/webConfig";
import { LOCAL_DEV_MODE, providerDisplayName } from "../auth/webConfig";
import { classifyProblem, HttpProblemError } from "../api/problem";
import { ConfirmDialog } from "../components/overlay/ConfirmDialog";
import { Modal } from "../components/overlay/Modal";
import { useToast } from "../components/overlay/ToastProvider";
import { avatarClassFor } from "../components/ui/avatar";
import { Copyable } from "../components/ui/Copyable";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorState } from "../components/ui/ErrorState";
import { Skeleton } from "../components/ui/Skeleton";
import { useTeamRole } from "../rbac/useTeamRole";
import type {
  IamInvitationCreateBody,
  IamRoleBindingCreateBody,
  IamUserProvisionBody,
  IamUserProvisionResponse,
} from "../api/types";
import type {
  RoleBinding,
  RoleDefinition,
  TeamInvitation,
} from "../model/iam";
import { formatDate } from "../model/format";
import { buttonVariants } from "../components/ui/Button";
import { CALLOUT, CALLOUT_BLOCK, CALLOUT_TONE } from "../components/ui/callout";
import { CELL_APP, CELL_MAIN, CELL_SUB } from "../components/ui/cell";
import { CHIP, CHIP_TONE } from "../components/ui/chip";
import {
  FIELD,
  FIELD_HINT,
  FIELD_LABEL,
  INPUT,
  INPUT_STATE,
  SELECT_EXTRA,
} from "../components/ui/form";
import {
  TBL,
  TBL_RIGHT,
  TBL_TD,
  TBL_TH,
  TBL_TR,
  TBL_WRAP,
} from "../components/ui/table";
import {
  KEBAB,
  KEBAB_BTN,
  MENU_ICON,
  MENU_ITEM,
  MENU_ITEM_TONE,
  MENU_SEP,
} from "../components/ui/menu";
import { DropdownPanel } from "../components/ui/DropdownPanel";
import { PAGE_TITLE, PAGE_SUB } from "../components/ui/typography";
import { SUMMARY_ARROW } from "../components/ui/summary";

export function MembersPage() {
  const { teamId } = useParams();
  if (teamId === undefined) {
    // Unreachable: the route declares `:teamId` (router.tsx).
    return null;
  }
  return <MembersScreen teamId={teamId} />;
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

function MembersScreen({ teamId }: { teamId: string }) {
  const { isLoading, can } = useTeamRole(teamId);
  // Same query key as the one useTeamRole reads — a single fetch serves both
  // the gate and the table.
  const bindingsQuery = useRoleBindings(teamId);
  const removeBinding = useRemoveRoleBinding();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [addOpen, setAddOpen] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState<RoleBinding | null>(
    null,
  );
  const [pendingRoleChange, setPendingRoleChange] = useState<RoleBinding | null>(
    null,
  );
  const [lastOwnerBlocked, setLastOwnerBlocked] = useState(false);
  const [provisionResult, setProvisionResult] =
    useState<IamUserProvisionResponse | null>(null);

  const canManage = !isLoading && can("iam.manage");

  const closeAddModal = () => {
    setAddOpen(false);
  };

  /**
   * Confirmed removal — optimistic vs async: removals flip
   * optimistically and roll back on error. In-flight list fetches are
   * cancelled first so a racing response cannot resurrect the row, then the
   * binding is dropped from the cache; the hook's own onSuccess invalidation
   * reconciles with the server.
   */
  const removeMember = (binding: RoleBinding) => {
    setPendingRemoval(null);
    setLastOwnerBlocked(false);
    const queryKey = iamKeys.roleBindingList(teamId);
    void queryClient.cancelQueries({ queryKey }).then(() => {
      const snapshot = queryClient.getQueryData<RoleBinding[]>(queryKey);
      queryClient.setQueryData<RoleBinding[]>(queryKey, (current) =>
        current?.filter((entry) => entry.id !== binding.id),
      );
      removeBinding.mutate(
        { bindingId: binding.id, teamId },
        {
          onError: (error) => {
            queryClient.setQueryData(queryKey, snapshot);
            if (
              error instanceof HttpProblemError &&
              error.typeSuffix === "last-owner"
            ) {
              // Blocking inline message, not a toast.
              setLastOwnerBlocked(true);
            } else {
              toast.error("Couldn't remove the member", {
                description: problemDescription(error),
              });
            }
          },
          onSuccess: () => {
            toast.success("Member removed", {
              description: `${binding.user.email} no longer has access to this team.`,
            });
          },
        },
      );
    });
  };

  const handleProvisioned = (result: IamUserProvisionResponse) => {
    // Bindings were already invalidated by useProvisionMember's onSuccess —
    // only the modal handoff happens here.
    closeAddModal();
    setProvisionResult(result);
  };

  let body: ReactNode;
  if (isLoading) {
    body = <LoadingCard label="Loading members" />;
  } else if (canManage) {
    body = (
      <>
        {lastOwnerBlocked ? (
          <div
            className={`${CALLOUT} ${CALLOUT_TONE.danger} ${CALLOUT_BLOCK} mb-4`}
            role="alert"
          >
            <AlertIcon />
            <div>
              <b>Can&apos;t remove the last owner.</b> Assign another owner
              first, then try again.
            </div>
          </div>
        ) : null}
        <ManagedMembersTable
          teamId={teamId}
          bindingsQuery={bindingsQuery}
          onRemove={(binding) => {
            setLastOwnerBlocked(false);
            setPendingRemoval(binding);
          }}
          onChangeRole={(binding) => {
            setLastOwnerBlocked(false);
            setPendingRoleChange(binding);
          }}
        />
      </>
    );
  } else if (
    bindingsQuery.isError &&
    !isForbiddenProblem(bindingsQuery.error)
  ) {
    // Non-403 failure: the role could not be resolved at all — surface the
    // problem instead of pretending it is a permissions issue.
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
            Members
          </h1>
          <p className={PAGE_SUB}>
            People with access to this team, including pending and expired
            invitations.
          </p>
        </div>
        {canManage ? (
          <button
            type="button"
            className={buttonVariants({ intent: "primary" })}
            onClick={() => setAddOpen(true)}
          >
            <PlusIcon /> Add member
          </button>
        ) : null}
      </div>
      {body}
      {canManage ? (
        <AddMemberModal
          teamId={teamId}
          open={addOpen}
          onClose={closeAddModal}
          onProvisioned={handleProvisioned}
        />
      ) : null}
      <ConfirmDialog
        open={pendingRemoval !== null}
        variant="summary"
        destructive
        icon={<TrashIcon />}
        title="Remove member"
        description="They immediately lose access to this team's apps and releases."
        summary={
          pendingRemoval === null
            ? []
            : [
                { label: "Member", value: pendingRemoval.user.email },
                { label: "Role", value: pendingRemoval.role.key },
              ]
        }
        confirmLabel="Remove member"
        onCancel={() => setPendingRemoval(null)}
        onConfirm={() => {
          if (pendingRemoval !== null) {
            removeMember(pendingRemoval);
          }
        }}
      />
      {pendingRoleChange !== null ? (
        <ChangeRoleDialog
          binding={pendingRoleChange}
          teamId={teamId}
          onClose={() => setPendingRoleChange(null)}
        />
      ) : null}
      {provisionResult !== null ? (
        <ProvisionedTokenModal
          result={provisionResult}
          onAcknowledge={() => setProvisionResult(null)}
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// ManagedMembersTable (bindings + pending invitations, revoke confirm)
// ---------------------------------------------------------------------------

function ManagedMembersTable({
  teamId,
  bindingsQuery,
  onRemove,
  onChangeRole,
}: {
  teamId: string;
  bindingsQuery: ReturnType<typeof useRoleBindings>;
  onRemove: (binding: RoleBinding) => void;
  onChangeRole: (binding: RoleBinding) => void;
}) {
  // One query for every status: the server flips lapsed pending invitations
  // to expired on read, and the pending/expired split happens client-side.
  const invitationsQuery = useInvitations(teamId, "all");
  const revokeInvitation = useRevokeInvitation();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [pendingRevoke, setPendingRevoke] = useState<TeamInvitation | null>(
    null,
  );
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const confirmRevoke = () => {
    if (pendingRevoke === null || revokeInvitation.isPending) {
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
            setPendingRevoke(null);
            toast.error("Invitation is no longer pending", {
              description:
                "It was accepted, revoked, or expired elsewhere — refreshing the list.",
            });
            void queryClient.invalidateQueries({
              queryKey: iamKeys.invitationLists(teamId),
            });
          } else {
            setRevokeError(problemDescription(error));
          }
        },
      },
    );
  };

  if (bindingsQuery.isPending || invitationsQuery.isPending) {
    return <LoadingCard label="Loading members" />;
  }

  // No bindings error branch: this table only mounts behind `iam.manage`,
  // and useTeamRole reads the same bindings query — a bindings error would
  // have kept the gate closed (MembersScreen handles it).
  if (
    invitationsQuery.isError &&
    invitationsQuery.data === undefined &&
    !isForbiddenProblem(invitationsQuery.error)
  ) {
    return (
      <div className="rounded-lg border border-border bg-surface p-[22px] shadow-sm">
        <ErrorState
          error={invitationsQuery.error}
          onRetry={() => {
            void invitationsQuery.refetch();
          }}
        />
      </div>
    );
  }

  const invitations = invitationsQuery.data ?? [];
  const pendingInvitations = invitations.filter(
    (invitation) => invitation.status === "pending",
  );
  const expiredInvitations = invitations.filter(
    (invitation) => invitation.status === "expired",
  );

  return (
    <>
      <MemberTable
        bindings={bindingsQuery.data ?? []}
        pendingInvitations={pendingInvitations}
        expiredInvitations={expiredInvitations}
        onRemove={onRemove}
        onChangeRole={onChangeRole}
        onRevokeInvitation={(invitation) => {
          setRevokeError(null);
          setPendingRevoke(invitation);
        }}
      />
      <ConfirmDialog
        open={pendingRevoke !== null}
        variant="summary"
        destructive
        icon={<TrashIcon />}
        title="Revoke invitation"
        description="They will no longer be able to accept this invitation."
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
                      {" · "}
                      {relativeExpiry(pendingRevoke.expiresAt)}
                    </span>
                  ),
                },
              ]
        }
        confirmLabel="Revoke invitation"
        busy={revokeInvitation.isPending}
        error={revokeError}
        onCancel={() => {
          setPendingRevoke(null);
          setRevokeError(null);
        }}
        onConfirm={confirmRevoke}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// MemberTable (pending invitations on top, members, expired history below)
// ---------------------------------------------------------------------------

type MemberTableRow =
  | { kind: "member"; binding: RoleBinding }
  | { kind: "invitation"; invitation: TeamInvitation };

function MemberTable({
  bindings,
  pendingInvitations,
  expiredInvitations,
  onRemove,
  onChangeRole,
  onRevokeInvitation,
}: {
  bindings: readonly RoleBinding[];
  pendingInvitations: readonly TeamInvitation[];
  expiredInvitations: readonly TeamInvitation[];
  onRemove: (binding: RoleBinding) => void;
  onChangeRole: (binding: RoleBinding) => void;
  onRevokeInvitation: (invitation: TeamInvitation) => void;
}) {
  const ownerCount = useMemo(
    () => bindings.filter((entry) => entry.role.key === "owner").length,
    [bindings],
  );
  // `createdBy` is a user id — resolvable when the granter is still a member.
  const emailById = useMemo(
    () => new Map(bindings.map((entry) => [entry.user.id, entry.user.email])),
    [bindings],
  );
  // The server lists invitations created_at ASC regardless of status — the
  // display order (newest pending first, most recently expired first) is
  // entirely this sort's responsibility.
  const rows = useMemo((): MemberTableRow[] => {
    const pending = [...pendingInvitations].sort(
      (left, right) =>
        new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
    );
    const expired = [...expiredInvitations].sort(
      (left, right) =>
        new Date(right.expiresAt).getTime() - new Date(left.expiresAt).getTime(),
    );
    return [
      ...pending.map(
        (invitation): MemberTableRow => ({
          kind: "invitation",
          invitation,
        }),
      ),
      ...bindings.map(
        (binding): MemberTableRow => ({
          kind: "member",
          binding,
        }),
      ),
      // Expired invitations trail the active members as greyed-out history.
      ...expired.map(
        (invitation): MemberTableRow => ({
          kind: "invitation",
          invitation,
        }),
      ),
    ];
  }, [bindings, pendingInvitations, expiredInvitations]);

  return (
    <div className="rounded-lg border border-border bg-surface shadow-sm">
      {rows.length === 0 ? (
        <EmptyState
          icon={<UsersIcon />}
          title="No members yet"
          description="Add a member to get started — existing accounts get access immediately, everyone else on their first sign-in."
        />
      ) : (
        <div className={TBL_WRAP}>
          <table className={TBL}>
            <thead>
              <tr>
                <th className={TBL_TH}>User</th>
                <th className={TBL_TH}>Role</th>
                <th className={TBL_TH}>Status</th>
                <th className={TBL_TH}>Granted</th>
                <th className={TBL_TH}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) =>
                row.kind === "invitation" ? (
                  <InvitationRow
                    key={`invitation:${row.invitation.id}`}
                    invitation={row.invitation}
                    onRevoke={onRevokeInvitation}
                  />
                ) : (
                  <tr key={`member:${row.binding.id}`} className={TBL_TR}>
                    <td className={TBL_TD}>
                      <div className={CELL_APP}>
                        <span
                          className={avatarClassFor(row.binding.user.id, "sm")}
                          aria-hidden="true"
                        >
                          {initialsOf(
                            row.binding.user.displayName,
                            row.binding.user.email,
                          )}
                        </span>
                        <div>
                          <div className={CELL_MAIN}>
                            {row.binding.user.displayName ??
                              row.binding.user.email}
                          </div>
                          {row.binding.user.displayName !== null ? (
                            <div className={CELL_SUB}>
                              {row.binding.user.email}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </td>
                    <td className={TBL_TD}>
                      <span className={`role role-${row.binding.role.key}`}>
                        {row.binding.role.key}
                      </span>
                    </td>
                    <td className={TBL_TD}>
                      <span className={ACTIVE_STATUS_CHIP.className}>
                        {ACTIVE_STATUS_CHIP.label}
                      </span>
                    </td>
                    <td className={TBL_TD}>
                      <span className="text-fg-3 text-[13px]">
                        {grantedLine(row.binding, emailById)}
                      </span>
                    </td>
                    <td className={`${TBL_TD} ${TBL_RIGHT}`}>
                      <RowKebab
                        binding={row.binding}
                        // Proactive last-owner guard; the 409
                        // remains the server-authoritative fallback. It blocks
                        // Change role too — every role change away from owner
                        // demotes the sole owner.
                        lastOwner={
                          row.binding.role.key === "owner" && ownerCount === 1
                        }
                        onRemove={onRemove}
                        onChangeRole={onChangeRole}
                      />
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Invitation row, pending or expired. Expired rows are greyed-out history:
 * neutral chip, absolute expiry date, and no Revoke — the server 409s
 * (`invitation-not-pending`) on anything but a pending invitation.
 */
function InvitationRow({
  invitation,
  onRevoke,
}: {
  invitation: TeamInvitation;
  onRevoke: (invitation: TeamInvitation) => void;
}) {
  const pending = invitation.status === "pending";
  const chip = pending ? PENDING_STATUS_CHIP : EXPIRED_STATUS_CHIP;

  return (
    <tr className={pending ? TBL_TR : `${TBL_TR} opacity-60`}>
      <td className={TBL_TD}>
        <div className={CELL_APP}>
          <span
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-fg-3"
            aria-hidden="true"
          >
            <MailIcon className="size-4" />
          </span>
          <div>
            <div className={CELL_MAIN}>{invitationContactValue(invitation)}</div>
            <div className={CELL_SUB}>
              {pending ? "Pending invitation" : "Expired invitation"}
            </div>
          </div>
        </div>
      </td>
      <td className={TBL_TD}>
        <span className={`role role-${invitation.role.key}`}>
          {invitation.role.key}
        </span>
      </td>
      <td className={TBL_TD}>
        <div>
          <span className={chip.className}>{chip.label}</span>
          <div className="text-fg-3 mt-1 text-[12px]">
            {pending
              ? relativeExpiry(invitation.expiresAt)
              : formatDate(invitation.expiresAt)}
          </div>
        </div>
      </td>
      <td className={TBL_TD}>
        <span className="text-fg-3 text-[13px]">
          Invited {formatDate(invitation.createdAt)}
        </span>
      </td>
      <td className={`${TBL_TD} ${TBL_RIGHT}`}>
        {pending ? (
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
    </tr>
  );
}

/**
 * Row kebab → Change role / Remove (AccountMenu's outside-close/Esc/
 * first-item-focus pattern).
 */
function RowKebab({
  binding,
  lastOwner,
  onRemove,
  onChangeRole,
}: {
  binding: RoleBinding;
  lastOwner: boolean;
  onRemove: (binding: RoleBinding) => void;
  onChangeRole: (binding: RoleBinding) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      // The panel is portaled out of `rootRef`, so it must be treated as
      // "inside" too — otherwise a pointerdown on a menu item closes the menu
      // before its click fires.
      if (
        event.target instanceof Node &&
        rootRef.current?.contains(event.target) !== true &&
        menuRef.current?.contains(event.target) !== true
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (open) {
      menuRef.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus();
    }
  }, [open]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (open && event.key === "Escape") {
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    }
  };

  return (
    <div className={KEBAB} ref={rootRef} onKeyDown={handleKeyDown}>
      <button
        type="button"
        className={KEBAB_BTN}
        ref={buttonRef}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Actions for ${binding.user.email}`}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreIcon />
      </button>
      <DropdownPanel
        open={open}
        anchorRef={buttonRef}
        menuRef={menuRef}
        menuId={menuId}
        label={`Actions for ${binding.user.email}`}
      >
        {lastOwner ? (
            // aria-disabled (not `disabled`) keeps the items focusable so the
            // reason is discoverable by keyboard/screen-reader users.
            <>
              <button
                type="button"
                className={`${MENU_ITEM} cursor-not-allowed opacity-50`}
                role="menuitem"
                aria-disabled="true"
                title="Can't change the last owner's role"
                onClick={(event) => event.preventDefault()}
              >
                <ShieldIcon /> Change role
              </button>
              <button
                type="button"
                className={`${MENU_ITEM} ${MENU_ITEM_TONE.danger} cursor-not-allowed opacity-50`}
                role="menuitem"
                aria-disabled="true"
                title="Can't remove the last owner"
                onClick={(event) => event.preventDefault()}
              >
                <TrashIcon /> Remove
              </button>
              <div className={MENU_SEP} />
              <div className="text-fg-3 pt-1 px-[11px] pb-2 text-[12px]">
                Assign another owner first.
              </div>
            </>
          ) : (
            <>
              <button
                type="button"
                className={MENU_ITEM}
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onChangeRole(binding);
                }}
              >
                <ShieldIcon /> Change role
              </button>
              <div className={MENU_SEP} />
              <button
                type="button"
                className={`${MENU_ITEM} ${MENU_ITEM_TONE.danger}`}
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onRemove(binding);
                }}
              >
                <TrashIcon /> Remove
              </button>
            </>
          )}
      </DropdownPanel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Change role dialog
// ---------------------------------------------------------------------------

/**
 * Tier-1 confirm around `PATCH /iam/role-bindings/:id`: a role picker plus a
 * `viewer → admin` summary of the pending move. Mounted only while a binding is
 * pending, so the picker resets with the dialog.
 *
 * Errors stay inline rather than becoming toasts: both 409s (last-owner,
 * role-binding-exists) are blocking conditions the user resolves right here.
 */
function ChangeRoleDialog({
  binding,
  teamId,
  onClose,
}: {
  binding: RoleBinding;
  teamId: string;
  onClose: () => void;
}) {
  const rolesQuery = useRoles();
  const updateBinding = useUpdateRoleBinding();
  const toast = useToast();

  const [roleId, setRoleId] = useState<string>(binding.role.id);
  const [error, setError] = useState<string | null>(null);

  const selectedRole = rolesQuery.data?.find((role) => role.id === roleId);
  const unchanged = roleId === binding.role.id;

  const confirm = () => {
    if (updateBinding.isPending) {
      return;
    }
    if (unchanged) {
      // The server treats this as a no-op 200; say so instead of closing as if
      // something changed.
      setError("Pick a different role to change it.");
      return;
    }
    setError(null);
    updateBinding.mutate(
      { bindingId: binding.id, roleId, teamId },
      {
        onSuccess: (updated) => {
          onClose();
          toast.success("Role updated", {
            description: `${binding.user.email} is now ${updated.role.key}.`,
          });
        },
        onError: (mutationError) => {
          setError(problemDescription(mutationError));
        },
      },
    );
  };

  return (
    <ConfirmDialog
      open
      variant="summary"
      icon={<ShieldIcon />}
      title="Change role"
      description="The new role takes effect immediately, on their next request."
      summary={[
        { label: "Member", value: binding.user.email },
        {
          label: "Role",
          value: (
            <>
              <span className={`role role-${binding.role.key}`}>
                {binding.role.key}
              </span>
              <span className={SUMMARY_ARROW}>→</span>
              {selectedRole === undefined ? (
                <span className="text-fg-3">…</span>
              ) : (
                <span className={`role role-${selectedRole.key}`}>
                  {selectedRole.key}
                </span>
              )}
            </>
          ),
        },
      ]}
      confirmLabel="Change role"
      busy={updateBinding.isPending}
      error={error}
      onCancel={onClose}
      onConfirm={confirm}
    >
      <RoleField
        roles={rolesQuery.data}
        isError={rolesQuery.isError}
        value={roleId}
        onChange={(next) => {
          setError(null);
          setRoleId(next);
        }}
        disabled={updateBinding.isPending}
      />
    </ConfirmDialog>
  );
}

// ---------------------------------------------------------------------------
// Add member modal (one flow over role-bindings / invitations / provision)
// ---------------------------------------------------------------------------

interface AddMemberModalProps {
  teamId: string;
  open: boolean;
  onClose: () => void;
  onProvisioned: (result: IamUserProvisionResponse) => void;
}

// Segmented control (legacy `.segmented` + `.segmented button` / `.active`).
// File-local: this modal is the only remaining consumer. The button's
// background / color / shadow swap wholesale per state (active vs idle), so the
// base button string carries none of them — two co-applied classes never set
// the same property (no-merge contract, see Button.tsx).
const SEGMENTED =
  "inline-flex gap-[3px] rounded-control border border-border bg-surface-2 p-[3px]";
const SEGMENTED_BTN =
  "rounded-[8px] border-0 px-[14px] py-[7px] text-[13px] font-semibold [transition:.13s]";
const SEGMENTED_BTN_IDLE = "bg-transparent text-fg-2";
const SEGMENTED_BTN_ACTIVE = "bg-surface text-blue shadow-xs";

// Target kind, chosen explicitly (no @-sniffing): email/user-ID goes through
// role-bindings (with the invitation fallback), a handle binds to the GitHub
// account id. The handle target only renders when web-config lists a GitHub
// provider — it is the sole handle kind the server can resolve, and saying so
// beats a 422 after the fact (Bitbucket exposes no handle-lookup API).
const ADD_TARGETS = [
  { value: "email", label: "Email" },
  { value: "githubHandle", label: "GitHub handle" },
] as const;

type AddTarget = (typeof ADD_TARGETS)[number]["value"];

function AddMemberModal(props: AddMemberModalProps) {
  // Remount on every open/close transition so a reopen never carries stale
  // fields or errors (ConfirmDialog's effect-free reset pattern).
  return (
    <AddMemberModalContent key={props.open ? "open" : "closed"} {...props} />
  );
}

function AddMemberModalContent({
  teamId,
  open,
  onClose,
  onProvisioned,
}: AddMemberModalProps) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const rolesQuery = useRoles();
  // Provider list, fetched only once the modal opens (session-cached after) —
  // gates the GitHub-handle target on an actually-configured GitHub provider.
  const webConfigQuery = useWebConfig({ enabled: open });
  const addBinding = useAddRoleBinding();
  const createInvitation = useCreateInvitation();
  const provisionMember = useProvisionMember();

  const [target, setTarget] = useState<AddTarget>("email");
  const [identifier, setIdentifier] = useState(""); // email/user ID, or handle
  const [roleId, setRoleId] = useState<string | null>(null);
  const [inviteExpires, setInviteExpires] = useState(""); // 1–90, blank → server default
  const [mintToken, setMintToken] = useState(false);
  const [tokenName, setTokenName] = useState("");
  const [tokenExpires, setTokenExpires] = useState(""); // PAT expiry: 1–3650
  const [formError, setFormError] = useState<string | null>(null);
  // Set on provision 409 user-exists — renders the add-without-token callout.
  const [tokenConflictEmail, setTokenConflictEmail] = useState<string | null>(
    null,
  );

  const idBase = useId();
  const formId = `${idBase}-form`;

  const roles = rolesQuery.data;
  const selectedRoleId = roleId ?? defaultRoleId(roles);
  const githubConfigured =
    webConfigQuery.data?.providers.some(
      (provider) => provider.provider === "github",
    ) ?? false;
  // "GitHub", "GitHub or Bitbucket", … for the email hint; local-dev (and an
  // unloaded config) fall back to provider-less copy.
  const oauthProviderNames = (webConfigQuery.data?.providers ?? [])
    .filter((provider) => provider.provider !== LOCAL_DEV_MODE)
    .map((provider) => providerDisplayName(provider.provider))
    .join(" or ");
  const busy =
    addBinding.isPending ||
    createInvitation.isPending ||
    provisionMember.isPending;

  const requestClose = () => {
    if (!busy) {
      onClose();
    }
  };

  const switchTarget = (next: AddTarget) => {
    if (busy || next === target) {
      return;
    }
    setTarget(next);
    setIdentifier("");
    setFormError(null);
    setTokenConflictEmail(null);
  };

  /**
   * Invitation leg, shared by the email fallback and the handle path. Nothing
   * is ever "sent" — the row turns up as pending and access materializes on
   * the invitee's next sign-in, and the copy promises exactly that.
   * `outcome: "pending"` covers both a fresh invitation and an already-pending
   * one (the envelope doesn't distinguish), so fresh-vs-duplicate is decided
   * against the pre-mutation invitation cache — same pattern as the binding
   * 201-vs-200 discrimination below.
   */
  const submitInvitation = (
    invitationTarget: { email: string } | { githubHandle: string },
    subject: string,
    roleIdValue: string,
  ) => {
    const expires = parseDays(inviteExpires, 90);
    if (expires === "invalid") {
      setFormError("Expiry must be a whole number between 1 and 90 days.");
      return;
    }
    const cached = queryClient.getQueryData<TeamInvitation[]>(
      iamKeys.invitationList(teamId, "all"),
    );
    const alreadyPending =
      cached?.some(
        (invitation) =>
          invitation.status === "pending" &&
          ("email" in invitationTarget
            ? invitation.email?.toLowerCase() ===
              invitationTarget.email.toLowerCase()
            : invitation.githubHandle?.toLowerCase() ===
              invitationTarget.githubHandle.toLowerCase()),
      ) ?? false;
    const body: IamInvitationCreateBody = {
      ...invitationTarget,
      roleId: roleIdValue,
      teamId,
    };
    if (expires !== null) {
      body.expiresInDays = expires;
    }
    createInvitation.mutate(body, {
      onSuccess: (result) => {
        if (result.outcome === "pending") {
          if (alreadyPending) {
            toast.info("Already added", {
              description: `${subject} already has a pending spot in this team.`,
            });
          } else {
            const signIn =
              "githubHandle" in invitationTarget
                ? "sign in with GitHub"
                : "sign in";
            toast.success("Member added", {
              description: `${subject} doesn't have an account yet — they get access when they next ${signIn}.`,
            });
          }
        } else if (result.outcome === "accepted_existing_user") {
          toast.success("Member added", {
            description: `${subject} already has an account — access was granted immediately.`,
          });
        } else {
          toast.info("Already a member", {
            description: `${subject} already holds a role in this team.`,
          });
        }
        onClose();
      },
      // Includes 409 invitation-conflict and 422 github-handle-not-found, inline.
      onError: (error) => setFormError(problemDescription(error)),
    });
  };

  /** Email/user-ID path: role binding first, invitation fallback on the 404. */
  const submitViaRoleBinding = (roleIdValue: string) => {
    const trimmed = identifier.trim();
    if (trimmed === "") {
      setFormError("Enter an email or user ID.");
      return;
    }
    const isEmail = trimmed.includes("@");
    // The fallback's expiry validates up front — failing AFTER the 404 would
    // waste the round trip.
    if (isEmail && parseDays(inviteExpires, 90) === "invalid") {
      setFormError("Expiry must be a whole number between 1 and 90 days.");
      return;
    }
    // Exactly one selector — values containing @ are emails.
    const body: IamRoleBindingCreateBody = isEmail
      ? { teamId, roleId: roleIdValue, email: trimmed }
      : { teamId, roleId: roleIdValue, userId: trimmed };
    // 201-created vs 200-already_exists is not surfaced by the hook (the
    // envelope is identical) — compare against the pre-mutation cache.
    const before = queryClient.getQueryData<RoleBinding[]>(
      iamKeys.roleBindingList(teamId),
    );
    addBinding.mutate(body, {
      onSuccess: (binding) => {
        const alreadyExisted =
          before?.some((entry) => entry.id === binding.id) ?? false;
        if (alreadyExisted) {
          toast.info("Already a member", {
            description: `${binding.user.email} already holds the ${binding.role.key} role.`,
          });
        } else {
          toast.success("Member added", {
            description: `${binding.user.email} is now ${binding.role.key} in this team.`,
          });
        }
        onClose();
      },
      onError: (error) => {
        if (error instanceof HttpProblemError && error.status === 404) {
          if (isEmail) {
            // No account yet — same submit continues into the invitation leg.
            submitInvitation({ email: trimmed }, trimmed, roleIdValue);
            return;
          }
          // A user ID can't be turned into an invitation — only the server
          // knows ids, and this one doesn't exist.
          setFormError(
            "No account matches that user ID. Add by email instead — people without an account get access on their first sign-in.",
          );
          return;
        }
        // Covers 400 role-not-supported and the rest, inline.
        setFormError(problemDescription(error));
      },
    });
  };

  /** Mint-token path (`POST /iam/users`) — new accounts only, email required. */
  const submitWithToken = (roleIdValue: string) => {
    const trimmedEmail = identifier.trim();
    if (!trimmedEmail.includes("@")) {
      setFormError(
        "Minting a token creates the account, so an email address is required.",
      );
      return;
    }
    const expires = parseDays(tokenExpires, 3650);
    if (expires === "invalid") {
      setFormError(
        "Token expiry must be a whole number between 1 and 3650 days.",
      );
      return;
    }
    const body: IamUserProvisionBody = {
      teamId,
      email: trimmedEmail,
      roleId: roleIdValue,
    };
    const trimmedTokenName = tokenName.trim();
    if (trimmedTokenName !== "") {
      body.tokenDisplayName = trimmedTokenName;
    }
    if (expires !== null) {
      body.expiresInDays = expires;
    }
    provisionMember.mutate(body, {
      // Owner closes this modal and opens the show-once PAT modal.
      onSuccess: (result) => onProvisioned(result),
      onError: (error) => {
        if (
          error instanceof HttpProblemError &&
          error.typeSuffix === "user-exists"
        ) {
          // Tokens are mintable only while creating the account (an admin
          // must not mint one that impersonates an existing user) — offer
          // the plain add instead.
          setTokenConflictEmail(trimmedEmail);
          return;
        }
        setFormError(problemDescription(error));
      },
    });
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    setTokenConflictEmail(null);
    if (selectedRoleId === null) {
      setFormError("Choose a role.");
      return;
    }
    if (target === "githubHandle") {
      // A leading @ on a handle is absorbed defensively.
      const handle = identifier.trim().replace(/^@/, "");
      if (handle === "") {
        setFormError("Enter a GitHub handle.");
        return;
      }
      submitInvitation({ githubHandle: handle }, `@${handle}`, selectedRoleId);
    } else if (mintToken) {
      submitWithToken(selectedRoleId);
    } else {
      submitViaRoleBinding(selectedRoleId);
    }
  };

  /** The token-conflict callout's escape hatch: same email, plain add. */
  const addWithoutToken = () => {
    if (busy || selectedRoleId === null) {
      return;
    }
    setMintToken(false);
    setFormError(null);
    setTokenConflictEmail(null);
    submitViaRoleBinding(selectedRoleId);
  };

  // The provision path is a direct add (the account exists the moment it
  // succeeds), so its label uses the explicit "provision" verb.
  const submitLabel =
    mintToken && target === "email" ? "Provision member" : "Add member";

  return (
    <Modal
      open={open}
      onClose={requestClose}
      wide
      icon={<Users2Icon />}
      title="Add member"
      description="Existing accounts get access immediately; everyone else shows up as pending and gets access on their first sign-in."
      footer={
        <>
          <button
            type="button"
            className={buttonVariants({ intent: "subtle" })}
            onClick={requestClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="submit"
            form={formId}
            className={buttonVariants({ intent: "primary" })}
            disabled={busy || roles === undefined}
            aria-busy={busy || undefined}
          >
            {busy ? <span className="spinner sm" aria-hidden="true" /> : null}
            {submitLabel}
          </button>
        </>
      }
    >
      <form id={formId} onSubmit={handleSubmit}>
        {githubConfigured ? (
          <div
            className={`${SEGMENTED} mb-3`}
            role="group"
            aria-label="Add by"
          >
            {ADD_TARGETS.map((entry) => (
              <button
                key={entry.value}
                type="button"
                aria-pressed={target === entry.value}
                className={`${SEGMENTED_BTN} ${
                  target === entry.value
                    ? SEGMENTED_BTN_ACTIVE
                    : SEGMENTED_BTN_IDLE
                }`}
                onClick={() => switchTarget(entry.value)}
                disabled={busy}
              >
                {entry.label}
              </button>
            ))}
          </div>
        ) : null}
        {target === "email" ? (
          <label className={FIELD}>
            <span className={FIELD_LABEL}>Email or user ID</span>
            <input
              className={`${INPUT} ${INPUT_STATE.normal}`}
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
              placeholder={
                mintToken
                  ? "ci-bot@example.com"
                  : "teammate@example.com or usr_xxxxx"
              }
              autoComplete="off"
              disabled={busy}
            />
            <span className={FIELD_HINT}>
              {mintToken
                ? "The new account is created with this email."
                : oauthProviderNames === ""
                  ? "Use the verified primary email of the account they sign in with."
                  : `Use the verified primary email of their ${oauthProviderNames} account — that's what matches them on sign-in.`}
            </span>
          </label>
        ) : (
          <label className={FIELD}>
            <span className={FIELD_LABEL}>GitHub handle</span>
            <input
              className={`${INPUT} ${INPUT_STATE.normal}`}
              type="text"
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
              placeholder="octocat"
              autoComplete="off"
              disabled={busy}
            />
            <span className={FIELD_HINT}>
              GitHub accounts only — resolved to the account&apos;s id right
              away, so later renames don&apos;t matter. Add Bitbucket users
              by email instead.
            </span>
          </label>
        )}
        <RoleField
          roles={roles}
          isError={rolesQuery.isError}
          value={selectedRoleId}
          onChange={setRoleId}
          disabled={busy}
        />
        {mintToken && target === "email" ? null : (
          <label className={FIELD}>
            <span className={FIELD_LABEL}>Invitation expires in (days)</span>
            <input
              className={`${INPUT} ${INPUT_STATE.normal}`}
              type="number"
              min={1}
              max={90}
              value={inviteExpires}
              onChange={(event) => setInviteExpires(event.target.value)}
              placeholder="30"
              disabled={busy}
            />
            <span className={FIELD_HINT}>
              Only used when they don&apos;t have an account yet. Leave empty
              for the server default; maximum 90 days.
            </span>
          </label>
        )}
        {target === "email" ? (
          <>
            <label className="mb-3.5 flex items-center gap-2.5 text-[13px] font-semibold">
              <input
                type="checkbox"
                checked={mintToken}
                onChange={(event) => {
                  setMintToken(event.target.checked);
                  setFormError(null);
                  setTokenConflictEmail(null);
                }}
                disabled={busy}
              />
              Provision with an API token
            </label>
            {mintToken ? (
              <>
                <label className={FIELD}>
                  <span className={FIELD_LABEL}>Token display name</span>
                  <input
                    className={`${INPUT} ${INPUT_STATE.normal}`}
                    value={tokenName}
                    onChange={(event) => setTokenName(event.target.value)}
                    placeholder="CI deploy token"
                    autoComplete="off"
                    disabled={busy}
                  />
                  <span className={FIELD_HINT}>
                    Optional — how the minted personal API token is listed.
                  </span>
                </label>
                <label className={FIELD}>
                  <span className={FIELD_LABEL}>Token expires in (days)</span>
                  <input
                    className={`${INPUT} ${INPUT_STATE.normal}`}
                    type="number"
                    min={1}
                    max={3650}
                    value={tokenExpires}
                    onChange={(event) => setTokenExpires(event.target.value)}
                    placeholder="365"
                    disabled={busy}
                  />
                  <span className={FIELD_HINT}>
                    Optional — leave empty for the server default. Maximum 3650
                    days.
                  </span>
                </label>
                <div className={`${CALLOUT} ${CALLOUT_TONE.warn}`}>
                  <AlertIcon />
                  <div>
                    The account is created immediately (no sign-in needed, new
                    accounts only) and the token is <b>shown only once</b> on
                    success — be ready to copy it.
                  </div>
                </div>
              </>
            ) : null}
          </>
        ) : null}
        {tokenConflictEmail !== null ? (
          <div
            className={`${CALLOUT} ${CALLOUT_TONE.info} mt-3.5`}
            role="alert"
          >
            <InfoIcon />
            <div>
              An account for <b>{tokenConflictEmail}</b> already exists, and a
              token can only be minted while creating one — they can mint
              their own from the Tokens page instead.
              <div className="mt-2.5">
                <button
                  type="button"
                  className={buttonVariants({ intent: "ghost", size: "sm" })}
                  onClick={addWithoutToken}
                >
                  Add without a token
                </button>
              </div>
            </div>
          </div>
        ) : null}
        {formError !== null ? (
          <div
            className={`${CALLOUT} ${CALLOUT_TONE.danger} ${CALLOUT_BLOCK} mt-3.5`}
            role="alert"
          >
            <AlertIcon />
            <div>{formError}</div>
          </div>
        ) : null}
      </form>
    </Modal>
  );
}

/** Role picker fed by `GET /v1/iam/roles`. */
function RoleField({
  roles,
  isError,
  value,
  onChange,
  disabled,
}: {
  roles: readonly RoleDefinition[] | undefined;
  isError: boolean;
  value: string | null;
  onChange: (roleId: string) => void;
  disabled: boolean;
}) {
  return (
    <label className={FIELD}>
      <span className={FIELD_LABEL}>Role</span>
      {/* Compose INPUT + SELECT_EXTRA + the legacy `select` class: the chevron
          is a data-URI background-image that can't be a utility (Stage-11
          keep-list). */}
      <select
        className={`${INPUT} ${INPUT_STATE.normal} ${SELECT_EXTRA} select`}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled || roles === undefined}
      >
        {roles === undefined ? (
          <option value="">
            {isError ? "Couldn't load roles" : "Loading roles…"}
          </option>
        ) : (
          roles.map((role) => (
            <option key={role.id} value={role.id}>
              {role.displayName}
            </option>
          ))
        )}
      </select>
      <span className={FIELD_HINT}>
        Roles are team-wide. Admins and owners can manage members.
      </span>
    </label>
  );
}

function defaultRoleId(
  roles: readonly RoleDefinition[] | undefined,
): string | null {
  if (roles === undefined || roles.length === 0) {
    return null;
  }
  const developer = roles.find((role) => role.key === "developer");
  return (developer ?? roles[0]).id;
}

/** "" → null (server default); non-integer or out of [1, max] → "invalid". */
function parseDays(raw: string, max: number): number | null | "invalid" {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }
  const value = Number(trimmed);
  return Number.isInteger(value) && value >= 1 && value <= max
    ? value
    : "invalid";
}

// ---------------------------------------------------------------------------
// Show-once PAT modal (non-dismissible until acknowledged)
// ---------------------------------------------------------------------------

function ProvisionedTokenModal({
  result,
  onAcknowledge,
}: {
  result: IamUserProvisionResponse;
  onAcknowledge: () => void;
}) {
  return (
    <Modal
      open
      // Unreachable: disableEscapeClose also removes overlay-click and the X.
      onClose={onAcknowledge}
      disableEscapeClose
      icon={<KeyIcon />}
      tone="green"
      title="Copy the personal access token"
      description={`${result.user.email} was provisioned as ${result.roleBinding.role.key}. This is the only time the full token is shown.`}
      footer={
        <button
          type="button"
          className={buttonVariants({ intent: "primary" })}
          onClick={onAcknowledge}
        >
          I&apos;ve copied it — done
        </button>
      }
    >
      <div
        className={`${CALLOUT} ${CALLOUT_TONE.warn} ${CALLOUT_BLOCK} mb-3.5`}
        role="alert"
      >
        <AlertIcon />
        <div>
          <b>You won&apos;t see this token again.</b> Store it somewhere safe
          now — once this dialog closes the token cannot be retrieved.
        </div>
      </div>
      <Copyable value={result.token} ariaLabel="Copy personal access token" />
      <p className="text-fg-3 mt-3 text-[12.5px]">
        Hand the token to {result.user.email}
        {result.user.created
          ? " (account created)"
          : " (existing account reused)"}
        . A human teammate can simply sign in with GitHub afterwards.
      </p>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Shared screen states + helpers (file-local)
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

const ACTIVE_STATUS_CHIP = {
  className: `${CHIP} ${CHIP_TONE.green}`,
  label: "Active",
} as const;

const PENDING_STATUS_CHIP = {
  className: `${CHIP} ${CHIP_TONE.blue}`,
  label: "Pending",
} as const;

const EXPIRED_STATUS_CHIP = {
  className: `${CHIP} ${CHIP_TONE.neutral}`,
  label: "Expired",
} as const;

const DAY_MS = 86_400_000;

function invitationContactValue(invitation: TeamInvitation): string {
  return invitation.email ?? `@${invitation.githubHandle ?? ""}`;
}

function invitationContactLabel(invitation: TeamInvitation): string {
  return invitation.email !== null ? "Email" : "GitHub handle";
}

/** Pending rows show the relative expiry ("in 14 days"). */
function relativeExpiry(iso: string): string {
  const expiresAt = new Date(iso).getTime();
  if (Number.isNaN(expiresAt)) {
    return iso;
  }
  const days = Math.ceil((expiresAt - Date.now()) / DAY_MS);
  if (days <= 0) {
    return "expired";
  }
  return days === 1 ? "in 1 day" : `in ${days} days`;
}

function grantedLine(
  binding: RoleBinding,
  emailById: ReadonlyMap<string, string>,
): string {
  const date = formatDate(binding.createdAt);
  if (binding.createdBy === null) {
    return `by system · ${date}`;
  }
  const granter = emailById.get(binding.createdBy);
  return granter === undefined ? date : `by ${granter} · ${date}`;
}

/** Up to two initials from `displayName ?? email` (email → its local part). */
function initialsOf(displayName: string | null, email: string): string {
  const atIndex = email.indexOf("@");
  const source = displayName ?? (atIndex > 0 ? email.slice(0, atIndex) : email);
  const words = source
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  const first = words[0];
  if (first === undefined) {
    return "?";
  }
  const second = words[1];
  return second === undefined
    ? first.slice(0, 2).toUpperCase()
    : `${first.charAt(0)}${second.charAt(0)}`.toUpperCase();
}

// --- Icons (paths mirror the shared icon set) ------------------------------

function Glyph({
  style,
  className,
  children,
}: {
  style?: CSSProperties;
  className?: string;
  children: ReactNode;
}) {
  return (
    <svg
      style={style}
      className={className}
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

function UsersIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </Glyph>
  );
}

function MailIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <rect x="2" y="4" width="20" height="16" rx="2.5" />
      <path d="m3 7 9 6 9-6" />
    </Glyph>
  );
}

function Users2Icon() {
  return (
    <Glyph>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M3 20v-1a5 5 0 0 1 10 0v1" />
      <path d="M16 5.5a3.5 3.5 0 0 1 0 6.9M21 20v-1a5 5 0 0 0-3.5-4.75" />
    </Glyph>
  );
}

function PlusIcon() {
  return (
    <Glyph>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </Glyph>
  );
}

function MoreIcon() {
  return (
    <Glyph>
      <circle cx="12" cy="5" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="19" r="1.6" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

function TrashIcon() {
  // 17px in menu rows; the ConfirmDialog icon-tile usage is re-sized to 21px
  // by MODAL_ICON's higher-specificity [&_svg] rule.
  return (
    <Glyph className={MENU_ICON}>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </Glyph>
  );
}

function ShieldIcon() {
  // Menu-row sibling of TrashIcon; MODAL_ICON re-sizes it in the dialog tile.
  return (
    <Glyph className={MENU_ICON}>
      <path d="M12 2 4 5v6c0 5 3.4 8.5 8 10 4.6-1.5 8-5 8-10V5l-8-3z" />
    </Glyph>
  );
}

function KeyIcon() {
  return (
    <Glyph>
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="m10.7 12.3 8.8-8.8M16 6l3 3M14 8l2 2" />
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

function InfoIcon() {
  return (
    <Glyph>
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16" />
      <line x1="12" y1="8" x2="12" y2="8" />
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
