// App detail / settings screen. Header
// with inline-editable app name, Settings card with the code-signing toggle
// (optimistic vs async: the toggle flips the cached app optimistically
// and ROLLS BACK on error — the plain useUpdateApp hook reconciles via its
// own success invalidation), Danger Zone (Transfer with destination-team
// picker, Delete behind type-to-confirm), and the embedded DeploymentTable.
// RBAC: everything mutating is `app.manage` — viewer/developer get disabled
// controls with a "Requires admin" tooltip (the `.tip[data-tip]` wrapper), per the
// matrix "Disabled = rendered greyed with tooltip". Errors: rename/transfer
// `409 app-conflict` inline; transfer same-team is guarded client-side (the
// picker excludes the current team) AND the server `400` is surfaced;
// `409 active-release-job` renders as the ConfirmDialog blocking error slot
// with a Retry confirm (no auto-retry — a Retry press is a new mutate() and
// therefore a new Idempotency-Key, the shared hooks convention; the mandatory
// key is minted inside useTransferApp).

import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { FormEvent, ReactNode } from "react";

import {
  appKeys,
  useApp,
  useDeleteApp,
  useTransferApp,
  useUpdateApp,
} from "../api/hooks/apps";
import { useIsMultiTeam, useTeams } from "../api/hooks/teams";
import { classifyProblem, HttpProblemError } from "../api/problem";
import { ConfirmDialog } from "../components/overlay/ConfirmDialog";
import { useToast } from "../components/overlay/ToastProvider";
import { Copyable } from "../components/ui/Copyable";
import { ErrorState } from "../components/ui/ErrorState";
import { Skeleton } from "../components/ui/Skeleton";
import { useTeamRole } from "../rbac/useTeamRole";
import { DeploymentTable } from "./app/DeploymentTable";
import type { ProblemBehavior } from "../api/problem";
import type { App } from "../model/app";
import { buttonVariants } from "../components/ui/Button";
import { CALLOUT, CALLOUT_TONE } from "../components/ui/callout";
import { CELL_SUB } from "../components/ui/cell";
import { ICON_BTN } from "../components/ui/iconButton";
import { PIN, PIN_TONE } from "../components/ui/pin";
import {
  FIELD,
  FIELD_ERR,
  FIELD_HINT,
  FIELD_LABEL,
  INPUT,
  INPUT_STATE,
  SELECT_EXTRA,
  TOGGLE,
  TOGGLE_INPUT,
  TOGGLE_TRACK,
} from "../components/ui/form";

// --- Problem presentation helpers (file-local, shared by the dialogs) ------

function problemBehavior(error: unknown): ProblemBehavior | null {
  return error instanceof HttpProblemError ? classifyProblem(error) : null;
}

function describeProblem(error: unknown): string {
  if (error instanceof HttpProblemError) {
    return error.detail ?? error.title ?? "The request couldn't be completed.";
  }
  return "The request couldn't be completed. Check your connection and try again.";
}

/** Error catalog `active-release-job` row: blocking notice + Retry. */
function BlockingJobNotice() {
  return (
    <>
      <b>Another release job is in progress.</b> Wait for the active job to
      finish, then press Retry.
    </>
  );
}

/** Page-title icon (40px tile, off-grid 12px radius). */
const APP_ICON_CLASS =
  "size-10 rounded-[12px] text-[15px] bg-[linear-gradient(135deg,var(--color-blue),var(--color-blue-bright))]";

// Danger-zone row literals (legacy `.danger-zone__row` / `.dz-text`); the
// first row drops its top divider (legacy `:first-of-type{border-top:0}`).
const DANGER_ROW =
  "flex items-center gap-4 border-t border-border px-5 py-[18px] first-of-type:border-t-0";

const DZ_TEXT =
  "flex-1 [&_b]:text-[13.5px] [&_b]:font-bold [&_p]:mt-0.5 [&_p]:text-[12.5px] [&_p]:text-fg-2";

// ---------------------------------------------------------------------------

export function AppDetailPage() {
  const { teamId = "", appId = "" } = useParams();
  const appQuery = useApp(appId);
  const { can, isLoading: roleLoading } = useTeamRole(teamId);
  const toast = useToast();
  const queryClient = useQueryClient();

  // Two independent mutation instances so the rename pending state never
  // collides with an in-flight toggle (same PATCH endpoint, separate intents).
  const renameMutation = useUpdateApp();
  const signingMutation = useUpdateApp();

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // OSS ships a single fixed team, so there is nowhere to transfer an app to.
  // Keep the multi-team transfer path in the code, but only surface it once the
  // caller can actually see more than one team (commercial / multi-team mode).
  const isMultiTeam = useIsMultiTeam();

  if (appQuery.isPending) {
    return <AppDetailSkeleton />;
  }
  if (appQuery.isError) {
    return (
      <div className="rounded-lg border border-border bg-surface shadow-sm">
        <ErrorState
          error={appQuery.error}
          onRetry={() => {
            void appQuery.refetch();
          }}
        />
      </div>
    );
  }

  const app = appQuery.data;
  const canManage = can("app.manage");
  // Tooltip only once the role is resolved (no misleading hint mid-load).
  const manageTip = !canManage && !roleLoading ? "Requires admin" : undefined;

  // --- Inline rename ---------------------------------------------------------

  const startRename = () => {
    setNameDraft(app.name);
    setRenameError(null);
    renameMutation.reset();
    setEditingName(true);
  };

  const cancelRename = () => {
    setEditingName(false);
    setRenameError(null);
  };

  const submitRename = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (renameMutation.isPending) {
      return;
    }
    const trimmed = nameDraft.trim();
    if (trimmed.length === 0) {
      setRenameError("Enter an app name.");
      return;
    }
    if (trimmed === app.name) {
      cancelRename();
      return;
    }
    renameMutation.mutate(
      { appId, body: { name: trimmed } },
      {
        onSuccess: (updated) => {
          toast.success(`App renamed to ${updated.name}`);
          setEditingName(false);
          setRenameError(null);
        },
        onError: (error) => {
          setRenameError(
            problemBehavior(error) === "name-conflict"
              ? "An app with this name already exists in this team."
              : describeProblem(error),
          );
        },
      },
    );
  };

  // --- Code-signing toggle: optimistic flip + rollback-on-error ---------------

  const toggleCodeSigning = (next: boolean) => {
    if (!canManage || signingMutation.isPending) {
      return;
    }
    const detailKey = appKeys.detail(appId);
    const previous = queryClient.getQueryData<App>(detailKey);
    // Optimistic flip: the toggle reads from this cache entry, so it moves
    // immediately; the hook's own onSuccess invalidation reconciles after.
    queryClient.setQueryData<App>(detailKey, (current) =>
      current === undefined
        ? current
        : { ...current, requireCodeSigning: next },
    );
    signingMutation.mutate(
      { appId, body: { require_code_signing: next } },
      {
        onError: (error) => {
          // Rollback-on-error (optimistic vs async).
          queryClient.setQueryData(detailKey, previous);
          toast.error("Couldn't update code signing", {
            description: describeProblem(error),
          });
        },
      },
    );
  };

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start gap-[18px]">
        <div className="min-w-0 flex-1">
          {editingName ? (
            <div className="flex items-center gap-3 text-[27px] font-extrabold leading-[1.1] tracking-[-.025em]">
              <span
                className={`grid flex-none place-items-center font-extrabold text-white ${APP_ICON_CLASS}`}
                aria-hidden="true"
              >
                {app.name.slice(0, 2).toLowerCase()}
              </span>
              <form
                className="flex items-center gap-2"
                onSubmit={submitRename}
                aria-label="Rename app"
              >
                <input
                  className={`${INPUT} ${INPUT_STATE.normal}`}
                  // width:280 OVERRIDES INPUT's w-full; conflicting utilities
                  // cannot co-apply, so the fixed width stays inline.
                  style={{ width: 280 }}
                  aria-label="App name"
                  value={nameDraft}
                  autoFocus
                  onChange={(event) => {
                    setNameDraft(event.target.value);
                    setRenameError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      cancelRename();
                    }
                  }}
                  disabled={renameMutation.isPending}
                />
                <button
                  type="submit"
                  className={buttonVariants({ intent: "primary", size: "sm" })}
                  disabled={renameMutation.isPending}
                  aria-busy={renameMutation.isPending || undefined}
                >
                  {renameMutation.isPending ? (
                    <span className="spinner sm" aria-hidden="true" />
                  ) : null}
                  Save
                </button>
                <button
                  type="button"
                  className={buttonVariants({ intent: "subtle", size: "sm" })}
                  onClick={cancelRename}
                  disabled={renameMutation.isPending}
                >
                  Cancel
                </button>
              </form>
            </div>
          ) : (
            <h1 className="flex items-center gap-3 text-[27px] font-extrabold leading-[1.1] tracking-[-.025em]">
              <span
                className={`grid flex-none place-items-center font-extrabold text-white ${APP_ICON_CLASS}`}
                aria-hidden="true"
              >
                {app.name.slice(0, 2).toLowerCase()}
              </span>
              {app.name}
              <span className="tip" data-tip={canManage ? "Rename app" : manageTip}>
                <button
                  type="button"
                  className={`${ICON_BTN} size-8 rounded-control [&_svg]:size-[18px]`}
                  aria-label="Rename app"
                  disabled={!canManage}
                  onClick={startRename}
                >
                  <EditIcon />
                </button>
              </span>
            </h1>
          )}
          {editingName && renameError !== null ? (
            <div className="block mt-2">
              <span className={FIELD_ERR} role="alert">
                <AlertIcon />
                {renameError}
              </span>
            </div>
          ) : null}
          <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
            {app.requireCodeSigning ? (
              <span className={`${PIN} ${PIN_TONE.sign}`}>
                <ShieldIcon />
                Code signing on
              </span>
            ) : null}
            <Copyable
              label="app_id"
              value={app.id}
              display="masked"
              maskHead={6}
              maskTail={4}
            />
          </div>
        </div>
      </div>

      {/* Embedded deployment list (own file). */}
      <DeploymentTable teamId={teamId} appId={appId} />

      <div className="grid-cols-[repeat(2,1fr)] gap-[18px] [display:grid]">
        {/* Settings: code-signing toggle. */}
        <div className="rounded-lg border border-border bg-surface p-[22px] shadow-sm">
          <div className="mb-[18px] flex items-center gap-2.5 text-[16px] font-bold tracking-[-.01em]">
            Settings
          </div>
          <div className="flex items-center justify-between gap-[14px]">
            <div>
              <div className="text-[13.5px] font-bold">
                Require code signing
              </div>
              <div className={`${CELL_SUB} max-w-[34ch]`}>
                Unsigned releases are rejected at publish time.
              </div>
            </div>
            <span className="tip" data-tip={manageTip}>
              <label className={TOGGLE}>
                <input
                  type="checkbox"
                  className={TOGGLE_INPUT}
                  checked={app.requireCodeSigning}
                  disabled={!canManage || signingMutation.isPending}
                  onChange={(event) => toggleCodeSigning(event.target.checked)}
                  aria-label="Require code signing"
                />
                <span className={TOGGLE_TRACK} />
              </label>
            </span>
          </div>
          {app.requireCodeSigning ? (
            <div className={`${CALLOUT} ${CALLOUT_TONE.warn} mt-[18px]`}>
              <AlertIcon />
              <div>
                Signing is <b>on</b> — unsigned releases will be rejected at
                publish time.
              </div>
            </div>
          ) : null}
        </div>

        {/* Danger Zone: delete + transfer (both `app.manage`). */}
        <div className="overflow-hidden rounded-lg border border-red-tint bg-surface shadow-sm">
          <div className="flex items-center gap-2 bg-red-tint px-5 py-[14px] text-[13px] font-bold text-[#9a0a30]">
            <AlertIcon className="size-4" />
            Danger zone
          </div>
          {isMultiTeam && (
            <div className={DANGER_ROW}>
              <div className={DZ_TEXT}>
                <b>Transfer app</b>
                <p>
                  Move this app and its deployments to another team you can
                  create apps in.
                </p>
              </div>
              <span className="tip" data-tip={manageTip}>
                <button
                  type="button"
                  className={buttonVariants({ intent: "ghost" })}
                  disabled={!canManage}
                  onClick={() => setTransferOpen(true)}
                >
                  Transfer
                </button>
              </span>
            </div>
          )}
          <div className={DANGER_ROW}>
            <div className={DZ_TEXT}>
              <b>Delete app</b>
              <p>
                Permanently delete the app, deployments, and all release
                history.
              </p>
            </div>
            <span className="tip" data-tip={manageTip}>
              <button
                type="button"
                className={buttonVariants({ intent: "dangerGhost" })}
                disabled={!canManage}
                onClick={() => setDeleteOpen(true)}
              >
                Delete
              </button>
            </span>
          </div>
        </div>
      </div>

      {isMultiTeam && (
        <TransferAppDialog
          app={app}
          currentTeamId={teamId}
          open={transferOpen}
          onClose={() => setTransferOpen(false)}
        />
      )}
      <DeleteAppDialog
        app={app}
        teamId={teamId}
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
      />
    </>
  );
}

// --- Transfer -------------------------------------------------------------------

function TransferAppDialog({
  app,
  currentTeamId,
  open,
  onClose,
}: {
  app: App;
  currentTeamId: string;
  open: boolean;
  onClose: () => void;
}) {
  // Remount per open/close transition: clears the picker and any mutation
  // error from a previous attempt (the ConfirmDialog reset pattern).
  return (
    <TransferAppDialogContent
      key={open ? "open" : "closed"}
      app={app}
      currentTeamId={currentTeamId}
      open={open}
      onClose={onClose}
    />
  );
}

function TransferAppDialogContent({
  app,
  currentTeamId,
  open,
  onClose,
}: {
  app: App;
  currentTeamId: string;
  open: boolean;
  onClose: () => void;
}) {
  const teamsQuery = useTeams();
  const transferMutation = useTransferApp();
  const toast = useToast();
  const navigate = useNavigate();
  const [destinationId, setDestinationId] = useState("");
  const [pickError, setPickError] = useState<string | null>(null);

  // Same-team transfer is guarded client-side by excluding the current team
  // from the picker; the server 400 still surfaces below if it ever happens.
  const destinations = (teamsQuery.data ?? []).filter(
    (team) => team.id !== currentTeamId,
  );
  const currentTeam = teamsQuery.data?.find((team) => team.id === currentTeamId);
  const destination = destinations.find((team) => team.id === destinationId);

  const behavior = problemBehavior(transferMutation.error);
  const blocking = behavior === "blocking-job";

  const confirm = () => {
    if (transferMutation.isPending) {
      return;
    }
    if (destination === undefined) {
      setPickError("Choose a destination team.");
      return;
    }
    if (destination.id === currentTeamId) {
      // Unreachable through the filtered picker; kept as the explicit guard.
      setPickError("The app is already in this team — choose a different one.");
      return;
    }
    setPickError(null);
    transferMutation.mutate(
      { appId: app.id, body: { team_id: destination.id } },
      {
        onSuccess: ({ app: transferred }) => {
          toast.success(`Transferred ${transferred.name} to ${destination.name}`);
          onClose();
          void navigate(`/teams/${transferred.teamId}/apps/${transferred.id}`);
        },
      },
    );
  };

  const errorNode: ReactNode =
    pickError ??
    (transferMutation.isError
      ? blocking
        ? <BlockingJobNotice />
        : transferErrorMessage(transferMutation.error)
      : undefined);

  return (
    <ConfirmDialog
      open={open}
      variant="summary"
      onCancel={onClose}
      onConfirm={confirm}
      title="Transfer app"
      description="Requires manage on this app and create on the destination team."
      icon={<ArrowRightIcon />}
      confirmLabel={blocking ? "Retry" : "Transfer app"}
      busy={transferMutation.isPending}
      error={errorNode}
      summary={[
        { label: "App", value: app.name },
        { label: "From", value: currentTeam?.name ?? currentTeamId },
        { label: "To", value: destination?.name ?? "—" },
      ]}
    >
      <label className={FIELD}>
        <span className={FIELD_LABEL}>Destination team</span>
        {teamsQuery.isPending ? (
          <Skeleton height={38} />
        ) : teamsQuery.isError ? (
          <span className={FIELD_ERR} role="alert">
            <AlertIcon />
            Couldn't load your teams — close the dialog and try again.
          </span>
        ) : destinations.length === 0 ? (
          <span className={FIELD_HINT}>
            You're not a member of any other team, so there is nowhere to
            transfer this app.
          </span>
        ) : (
          <select
            // `select` class kept for the data-URI chevron (form.ts contract).
            className={`${INPUT} ${INPUT_STATE.normal} ${SELECT_EXTRA} select`}
            value={destinationId}
            onChange={(event) => {
              setDestinationId(event.target.value);
              setPickError(null);
            }}
            disabled={transferMutation.isPending}
            aria-label="Destination team"
          >
            <option value="" disabled>
              Select a team…
            </option>
            {destinations.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </select>
        )}
      </label>
      <div className={`${CALLOUT} ${CALLOUT_TONE.info}`}>
        <InfoIcon />
        <div>
          Deployment keys are preserved. Role bindings of this team are not
          carried over to the destination.
        </div>
      </div>
    </ConfirmDialog>
  );
}

function transferErrorMessage(error: unknown): ReactNode {
  switch (problemBehavior(error)) {
    case "name-conflict":
      return "An app with this name already exists in the destination team.";
    case "forbidden":
      return "You need permission to create apps in the destination team.";
    default:
      // Covers the server-side same-team 400 (validation-error detail).
      return describeProblem(error);
  }
}

// --- Delete ----------------------------------------------------------------------

function DeleteAppDialog({
  app,
  teamId,
  open,
  onClose,
}: {
  app: App;
  teamId: string;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <DeleteAppDialogContent
      key={open ? "open" : "closed"}
      app={app}
      teamId={teamId}
      open={open}
      onClose={onClose}
    />
  );
}

function DeleteAppDialogContent({
  app,
  teamId,
  open,
  onClose,
}: {
  app: App;
  teamId: string;
  open: boolean;
  onClose: () => void;
}) {
  const deleteMutation = useDeleteApp();
  const toast = useToast();
  const navigate = useNavigate();

  const blocking = problemBehavior(deleteMutation.error) === "blocking-job";

  const confirm = () => {
    if (deleteMutation.isPending) {
      return;
    }
    deleteMutation.mutate(
      { appId: app.id, teamId },
      {
        onSuccess: () => {
          toast.success(`App ${app.name} deleted`);
          onClose();
          void navigate(`/teams/${teamId}/apps`);
        },
      },
    );
  };

  return (
    <ConfirmDialog
      open={open}
      variant="typeToConfirm"
      confirmationText={app.name}
      onCancel={onClose}
      onConfirm={confirm}
      title="Delete app"
      description={`Permanently removes ${app.name}.`}
      icon={<TrashIcon />}
      confirmLabel={blocking ? "Retry" : "Delete app"}
      busy={deleteMutation.isPending}
      error={
        deleteMutation.isError ? (
          blocking ? (
            <BlockingJobNotice />
          ) : (
            describeProblem(deleteMutation.error)
          )
        ) : undefined
      }
    >
      <div className={`${CALLOUT} ${CALLOUT_TONE.danger} mb-[18px]`}>
        <AlertIcon />
        <div>
          This deletes the app, its deployments, and all release history.{" "}
          <b>Cannot be undone.</b>
        </div>
      </div>
    </ConfirmDialog>
  );
}

// --- Loading skeleton --------------------------------------------------------------

function AppDetailSkeleton() {
  return (
    <div role="status" aria-label="Loading app">
      <div className="mb-6 flex flex-wrap items-start gap-[18px]">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <Skeleton width={40} height={40} />
            <Skeleton width={240} height={22} />
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
            <Skeleton width={110} variant="text" />
            <Skeleton width={180} variant="text" />
          </div>
        </div>
      </div>
      <div className="mb-[18px] rounded-lg border border-border bg-surface p-[22px] shadow-sm">
        <Skeleton width={140} height={16} className="mb-[18px]" />
        <Skeleton height={14} variant="line" />
        <Skeleton height={14} variant="line" />
        <Skeleton height={14} variant="line" />
      </div>
      <div className="grid-cols-[repeat(2,1fr)] gap-[18px] [display:grid]">
        <div className="rounded-lg border border-border bg-surface p-[22px] shadow-sm">
          <Skeleton width={120} height={16} className="mb-[18px]" />
          <Skeleton height={14} variant="line" />
          <Skeleton height={14} variant="line" />
        </div>
        <div className="rounded-lg border border-border bg-surface p-[22px] shadow-sm">
          <Skeleton width={120} height={16} className="mb-[18px]" />
          <Skeleton height={14} variant="line" />
          <Skeleton height={14} variant="line" />
        </div>
      </div>
    </div>
  );
}

// --- Icons (paths mirror the shared icon set) ----------------------------------------

function SvgIcon({
  children,
  className,
  strokeWidth = 2,
}: {
  children: ReactNode;
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  );
}

function EditIcon() {
  return (
    <SvgIcon>
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z" />
    </SvgIcon>
  );
}

function AlertIcon({ className }: { className?: string }) {
  return (
    <SvgIcon className={className}>
      <path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12" y2="17" />
    </SvgIcon>
  );
}

function InfoIcon() {
  return (
    <SvgIcon>
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16" />
      <line x1="12" y1="8" x2="12" y2="8" />
    </SvgIcon>
  );
}

function TrashIcon() {
  return (
    <SvgIcon>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </SvgIcon>
  );
}

function ArrowRightIcon() {
  return (
    <SvgIcon>
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </SvgIcon>
  );
}

/** "Code signing on" pin glyph (strokeWidth 2.5). */
function ShieldIcon() {
  return (
    <SvgIcon strokeWidth={2.5} className="size-[13px]">
      <path d="M12 2 4 5v6c0 5 3.4 8.5 8 10 4.6-1.5 8-5 8-10V5l-8-3z" />
      <polyline points="9 11.5 11.5 14 15 9.5" />
    </SvgIcon>
  );
}
