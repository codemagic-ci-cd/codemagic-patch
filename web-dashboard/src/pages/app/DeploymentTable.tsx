// Embedded deployment list for the App detail screen.
// Rows come from `useDeployments(appId)`; the three lazy cells
// (Latest release / Active users / Downloads) come from ONE per-row
// `useDeploymentMetrics(dep.id, { limit: 1 })` query so name/key render fast
// and a metrics failure degrades to "—" + a small retry without failing the
// table (per-region skeletons / cell-level failure). Actions follow the
// RBAC matrix: create `app.create`, rename/delete `app.manage`, clear history
// `release.deploy` (developers CAN clear); denied controls render
// disabled with a "Requires {role}" tooltip (`.tip[data-tip]`).
// Lifecycle errors: `409 deployment-conflict` inline on the name field,
// `409 active-release-job` as the ConfirmDialog blocking error slot with a
// Retry confirm (no auto-retry — each press is a new mutate() = new
// Idempotency-Key per the shared hooks convention). A `403 forbidden` on clear from
// an inferred-developer downgrades the team to viewer (useTeamRole contract).

import { Fragment, useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import type {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
} from "react";

import {
  useClearDeployment,
  useCreateDeployment,
  useDeleteDeployment,
  useDeployments,
  useRenameDeployment,
} from "../../api/hooks/deployments";
import { metricsKeys, useDeploymentMetrics } from "../../api/hooks/metrics";
import { classifyProblem, HttpProblemError } from "../../api/problem";
import { SDK_DISPLAY_NAME } from "../../branding";
import { ConfirmDialog } from "../../components/overlay/ConfirmDialog";
import { Modal } from "../../components/overlay/Modal";
import { useToast } from "../../components/overlay/ToastProvider";
import { Copyable } from "../../components/ui/Copyable";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorState } from "../../components/ui/ErrorState";
import { Skeleton } from "../../components/ui/Skeleton";
import { useTeamRole } from "../../rbac/useTeamRole";
import type { ProblemBehavior } from "../../api/problem";
import type { Deployment } from "../../model/deployment";
import { formatCount } from "../../model/format";
import { buttonVariants } from "../../components/ui/Button";
import { CALLOUT, CALLOUT_TONE } from "../../components/ui/callout";
import { CELL_MAIN } from "../../components/ui/cell";
import { CHIP, CHIP_TONE } from "../../components/ui/chip";
import { ICON_BTN } from "../../components/ui/iconButton";
import {
  FIELD,
  FIELD_ERR,
  FIELD_HINT,
  FIELD_LABEL,
  INPUT,
  INPUT_STATE,
} from "../../components/ui/form";
import {
  TBL,
  TBL_NUM,
  TBL_RIGHT,
  TBL_TD,
  TBL_TH,
  TBL_TR,
  TBL_WRAP,
} from "../../components/ui/table";
import {
  KEBAB,
  KEBAB_BTN,
  MENU_ITEM,
  MENU_ITEM_TONE,
  MENU_SEP,
} from "../../components/ui/menu";
import { DropdownPanel } from "../../components/ui/DropdownPanel";

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

/** `active-release-job` error: blocking notice + Retry. */
function BlockingJobNotice() {
  return (
    <>
      <b>Another release job is in progress.</b> Wait for the active job to
      finish, then press Retry.
    </>
  );
}

// ---------------------------------------------------------------------------

export interface DeploymentTableProps {
  teamId: string;
  appId: string;
}

export function DeploymentTable({ teamId, appId }: DeploymentTableProps) {
  const deploymentsQuery = useDeployments(appId);
  const { can, isLoading: roleLoading, confidence, downgradeToViewer } =
    useTeamRole(teamId);
  const toast = useToast();
  const queryClient = useQueryClient();

  const clearMutation = useClearDeployment();
  const deleteMutation = useDeleteDeployment();

  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Deployment | null>(null);
  const [clearTarget, setClearTarget] = useState<Deployment | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Deployment | null>(null);

  const canCreate = can("app.create");
  const canManage = can("app.manage");
  const canClear = can("release.deploy");
  // Tooltip text only once the role is resolved (no misleading hint while
  // gating is still pending). app.create/app.manage need admin; clear needs
  // developer (RBAC matrix).
  const adminTip = !roleLoading ? "Requires admin" : undefined;
  const developerTip = !roleLoading ? "Requires developer" : undefined;

  const openClear = (deployment: Deployment) => {
    clearMutation.reset();
    setClearTarget(deployment);
  };
  const openDelete = (deployment: Deployment) => {
    deleteMutation.reset();
    setDeleteTarget(deployment);
  };

  const confirmClear = () => {
    if (clearTarget === null) {
      return;
    }
    clearMutation.mutate(
      { deploymentId: clearTarget.id },
      {
        onSuccess: ({ deletedReleaseCount, deployment }) => {
          // Release-history/metrics caches live in the deployment key space — the
          // hook only invalidates the deployment list (see hooks comment).
          void queryClient.invalidateQueries({
            queryKey: [...metricsKeys.all, "deployment", deployment.id],
          });
          toast.success(
            `Cleared ${deletedReleaseCount} release${deletedReleaseCount === 1 ? "" : "s"} from ${deployment.name}`,
            {
              description:
                "Clients without a matching release fall back to the embedded app-store bundle.",
            },
          );
          setClearTarget(null);
        },
        onError: (error) => {
          // RBAC inference: first denied mutation downgrades an
          // inferred developer to viewer for this team.
          if (
            confidence === "inferred" &&
            problemBehavior(error) === "forbidden"
          ) {
            downgradeToViewer();
          }
        },
      },
    );
  };

  const confirmDelete = () => {
    if (deleteTarget === null) {
      return;
    }
    deleteMutation.mutate(
      { deploymentId: deleteTarget.id, appId },
      {
        onSuccess: () => {
          toast.success(`Deployment ${deleteTarget.name} deleted`);
          setDeleteTarget(null);
        },
      },
    );
  };

  const clearBehavior = problemBehavior(clearMutation.error);
  const deleteBehavior = problemBehavior(deleteMutation.error);

  const createButton = (className: string) => (
    <span className="tip" data-tip={canCreate ? undefined : adminTip}>
      <button
        type="button"
        className={className}
        disabled={!canCreate}
        onClick={() => setCreateOpen(true)}
      >
        <SvgIcon>
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </SvgIcon>{" "}
        New deployment
      </button>
    </span>
  );

  let body: ReactNode;
  if (deploymentsQuery.isPending) {
    body = <DeploymentTableSkeleton />;
  } else if (deploymentsQuery.isError) {
    body = (
      <ErrorState
        error={deploymentsQuery.error}
        onRetry={() => {
          void deploymentsQuery.refetch();
        }}
      />
    );
  } else if (deploymentsQuery.data.length === 0) {
    body = (
      <EmptyState
        icon={<LayersIcon />}
        title="No deployments yet"
        description={`Create a deployment to get a key for your app's ${SDK_DISPLAY_NAME} configuration.`}
        action={createButton(buttonVariants({ intent: "primary" }))}
      />
    );
  } else {
    body = (
      <div className={TBL_WRAP}>
        <table className={TBL}>
          <thead>
            <tr>
              <th className={TBL_TH}>Deployment</th>
              <th className={TBL_TH}>Deployment key</th>
              <th className={TBL_TH}>Latest release</th>
              <th className={`${TBL_TH} ${TBL_RIGHT}`}>Active users</th>
              <th className={`${TBL_TH} ${TBL_RIGHT}`}>Downloads</th>
              <th className={TBL_TH}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {deploymentsQuery.data.map((deployment) => (
              <DeploymentRow
                key={deployment.id}
                deployment={deployment}
                teamId={teamId}
                canManage={canManage}
                canClear={canClear}
                adminTip={adminTip}
                developerTip={developerTip}
                onRename={() => setRenameTarget(deployment)}
                onClear={() => openClear(deployment)}
                onDelete={() => openDelete(deployment)}
              />
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="mb-[18px] overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
      <div className="flex items-center gap-3 border-b border-border px-[22px] py-[18px]">
        <SvgIcon className="size-[18px] text-blue">
          <path d="m12 2 9 5-9 5-9-5 9-5z" />
          <path d="m3 12 9 5 9-5" />
          <path d="m3 17 9 5 9-5" />
        </SvgIcon>
        <h3 className="text-[15px] font-bold">Deployments</h3>
        {deploymentsQuery.isSuccess ? (
          <span className={`${CHIP} ${CHIP_TONE.neutral} ml-1`}>
            {deploymentsQuery.data.length}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          {createButton(buttonVariants({ intent: "ghost", size: "sm" }))}
        </div>
      </div>
      {body}

      <CreateDeploymentModal
        open={createOpen}
        appId={appId}
        onClose={() => setCreateOpen(false)}
      />
      <RenameDeploymentModal
        deployment={renameTarget}
        onClose={() => setRenameTarget(null)}
      />

      {/* Clear history — irreversible: type-to-confirm + embedded-bundle warning. */}
      <ConfirmDialog
        open={clearTarget !== null}
        variant="typeToConfirm"
        confirmationText={clearTarget?.name ?? ""}
        onCancel={() => setClearTarget(null)}
        onConfirm={confirmClear}
        title="Clear deployment history"
        description="Deletes all releases in this deployment."
        icon={<AlertIcon />}
        confirmLabel={clearBehavior === "blocking-job" ? "Retry" : "Clear history"}
        busy={clearMutation.isPending}
        error={
          clearMutation.isError ? (
            clearBehavior === "blocking-job" ? (
              <BlockingJobNotice />
            ) : (
              describeProblem(clearMutation.error)
            )
          ) : undefined
        }
      >
        <div className={`${CALLOUT} ${CALLOUT_TONE.danger} mb-[18px]`}>
          <AlertIcon />
          <div>
            Clients with no matching release will{" "}
            <b>fall back to the embedded app-store bundle</b>. This cannot be
            undone.
          </div>
        </div>
      </ConfirmDialog>

      {/* Delete deployment — irreversible: type-to-confirm. */}
      <ConfirmDialog
        open={deleteTarget !== null}
        variant="typeToConfirm"
        confirmationText={deleteTarget?.name ?? ""}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
        title="Delete deployment"
        description={
          deleteTarget !== null
            ? `Permanently removes ${deleteTarget.name}.`
            : undefined
        }
        icon={<TrashIcon />}
        confirmLabel={
          deleteBehavior === "blocking-job" ? "Retry" : "Delete deployment"
        }
        busy={deleteMutation.isPending}
        error={
          deleteMutation.isError ? (
            deleteBehavior === "blocking-job" ? (
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
            This deletes the deployment and its release history. Clients using
            its key stop receiving updates. <b>Cannot be undone.</b>
          </div>
        </div>
      </ConfirmDialog>
    </div>
  );
}

// --- Rows -------------------------------------------------------------------

interface DeploymentRowProps {
  deployment: Deployment;
  teamId: string;
  canManage: boolean;
  canClear: boolean;
  adminTip: string | undefined;
  developerTip: string | undefined;
  onRename: () => void;
  onClear: () => void;
  onDelete: () => void;
}

function DeploymentRow({
  deployment,
  teamId,
  canManage,
  canClear,
  adminTip,
  developerTip,
  onRename,
  onClear,
  onDelete,
}: DeploymentRowProps) {
  return (
    <tr className={TBL_TR}>
      <td className={TBL_TD}>
        <div className={CELL_MAIN}>
          <Link
            to={`/teams/${teamId}/apps/${deployment.appId}/deployments/${deployment.id}`}
          >
            {deployment.name}
          </Link>
        </div>
      </td>
      <td className={TBL_TD}>
        <Copyable
          value={deployment.deploymentKey}
          display="masked"
          maskHead={4}
          maskTail={4}
          ariaLabel={`Copy deployment key for ${deployment.name}`}
        />
      </td>
      <MetricCells deployment={deployment} />
      <td className={`${TBL_TD} ${TBL_RIGHT}`}>
        <RowKebab
          deploymentName={deployment.name}
          items={[
            {
              key: "rename",
              label: "Rename",
              allowed: canManage,
              requiresTip: adminTip,
              onSelect: onRename,
            },
            {
              key: "clear",
              label: "Clear history…",
              allowed: canClear,
              requiresTip: developerTip,
              onSelect: onClear,
            },
            {
              key: "delete",
              label: "Delete",
              danger: true,
              separatorBefore: true,
              allowed: canManage,
              requiresTip: adminTip,
              onSelect: onDelete,
            },
          ]}
        />
      </td>
    </tr>
  );
}

/**
 * Lazy metric cells: one `limit: 1` deployment-metrics
 * query per row feeds Latest release + Active users + Downloads. Failure
 * renders "—" with a small per-cell retry and never fails the table.
 */
function MetricCells({ deployment }: { deployment: Deployment }) {
  const metricsQuery = useDeploymentMetrics(deployment.id, { limit: 1 });

  if (metricsQuery.isPending) {
    return (
      <>
        <td className={TBL_TD}>
          <Skeleton width={84} variant="text" />
        </td>
        <td className={`${TBL_TD} ${TBL_NUM}`}>
          <span className="flex justify-end">
            <Skeleton width={48} variant="text" />
          </span>
        </td>
        <td className={`${TBL_TD} ${TBL_NUM}`}>
          <span className="flex justify-end">
            <Skeleton width={48} variant="text" />
          </span>
        </td>
      </>
    );
  }

  if (metricsQuery.isError) {
    const retry = () => {
      void metricsQuery.refetch();
    };
    return (
      <>
        <td className={TBL_TD}>
          <MetricCellRetry
            onRetry={retry}
            ariaLabel={`Retry loading latest release for ${deployment.name}`}
          />
        </td>
        <td className={`${TBL_TD} ${TBL_NUM}`}>
          <MetricCellRetry
            onRetry={retry}
            ariaLabel={`Retry loading active users for ${deployment.name}`}
          />
        </td>
        <td className={`${TBL_TD} ${TBL_NUM}`}>
          <MetricCellRetry
            onRetry={retry}
            ariaLabel={`Retry loading downloads for ${deployment.name}`}
          />
        </td>
      </>
    );
  }

  const latest = metricsQuery.data.releases[0];
  if (latest === undefined) {
    return (
      <>
        <td className={TBL_TD}>
          <span className="text-fg-3">No releases</span>
        </td>
        <td className={`${TBL_TD} ${TBL_NUM}`}>
          <span className="text-fg-3">—</span>
        </td>
        <td className={`${TBL_TD} ${TBL_NUM}`}>
          <span className="text-fg-3">—</span>
        </td>
      </>
    );
  }

  return (
    <>
      <td className={TBL_TD}>
        <b>{latest.releaseLabel}</b>
      </td>
      <td className={`${TBL_TD} ${TBL_NUM}`}>
        {formatCount(latest.metrics.active)}
      </td>
      <td className={`${TBL_TD} ${TBL_NUM}`}>
        {formatCount(latest.metrics.downloaded)}
      </td>
    </>
  );
}

function MetricCellRetry({
  onRetry,
  ariaLabel,
}: {
  onRetry: () => void;
  ariaLabel: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 align-middle">
      <span className="text-fg-3" aria-hidden="true">
        —
      </span>
      <button
        type="button"
        className={`${ICON_BTN} size-6 rounded-[7px]`}
        aria-label={ariaLabel}
        onClick={onRetry}
      >
        <SvgIcon className="size-[13px]">
          <polyline points="23 4 23 10 17 10" />
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
        </SvgIcon>
      </button>
    </span>
  );
}

// --- Row kebab menu ----------------------------------------------------------

interface KebabItem {
  key: string;
  label: string;
  danger?: boolean;
  separatorBefore?: boolean;
  allowed: boolean;
  /** "Requires {role}" tooltip shown on the disabled item (undefined hides it). */
  requiresTip: string | undefined;
  onSelect: () => void;
}

/**
 * `.kebab` dropdown with the AccountMenu keyboard contract: outside
 * pointerdown closes, Esc closes + refocuses the trigger, first item focused
 * on open, ArrowUp/Down cycle. Denied items stay focusable (`aria-disabled` +
 * tooltip) per the disable-with-tooltip discoverability convention.
 */
function RowKebab({
  deploymentName,
  items,
}: {
  deploymentName: string;
  items: KebabItem[];
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
    if (!open) {
      return;
    }
    if (event.key === "Escape") {
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveMenuItemFocus(menuRef.current, event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      focusMenuItemEdge(menuRef.current, event.key === "Home" ? "first" : "last");
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
        aria-label={`Actions for ${deploymentName}`}
        onClick={() => setOpen((value) => !value)}
      >
        <SvgIcon>
          <circle cx="12" cy="5" r="1.6" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
          <circle cx="12" cy="19" r="1.6" fill="currentColor" stroke="none" />
        </SvgIcon>
      </button>
      <DropdownPanel
        open={open}
        anchorRef={buttonRef}
        menuRef={menuRef}
        menuId={menuId}
        label={`${deploymentName} actions`}
      >
        {items.map((item) => (
          <Fragment key={item.key}>
            {item.separatorBefore === true ? (
              <div className={MENU_SEP} />
            ) : null}
            <button
              type="button"
              role="menuitem"
              className={`${MENU_ITEM} ${
                item.danger === true
                  ? MENU_ITEM_TONE.danger
                  : MENU_ITEM_TONE.default
              }${item.allowed ? "" : " tip"}`}
              aria-disabled={item.allowed ? undefined : true}
              data-tip={item.allowed ? undefined : item.requiresTip}
              style={
                item.allowed
                  ? undefined
                  : { opacity: 0.55, cursor: "not-allowed" }
              }
              onClick={() => {
                if (!item.allowed) {
                  return;
                }
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          </Fragment>
        ))}
      </DropdownPanel>
    </div>
  );
}

/** ArrowUp/Down focus cycling among the menu's items (wraps). */
function moveMenuItemFocus(menu: HTMLElement | null, delta: number): void {
  if (menu === null) {
    return;
  }
  const items = Array.from(
    menu.querySelectorAll<HTMLElement>("[role='menuitem']"),
  );
  if (items.length === 0) {
    return;
  }
  const index = items.findIndex((item) => item === document.activeElement);
  const nextIndex =
    index === -1
      ? delta > 0
        ? 0
        : items.length - 1
      : (index + delta + items.length) % items.length;
  items[nextIndex]?.focus();
}

/** Home/End jump to the first/last menu item. */
function focusMenuItemEdge(menu: HTMLElement | null, edge: "first" | "last"): void {
  if (menu === null) {
    return;
  }
  const items = Array.from(
    menu.querySelectorAll<HTMLElement>("[role='menuitem']"),
  );
  if (items.length === 0) {
    return;
  }
  (edge === "first" ? items[0] : items[items.length - 1])?.focus();
}

// --- Create deployment --------------------------------------------------------

function CreateDeploymentModal({
  open,
  appId,
  onClose,
}: {
  open: boolean;
  appId: string;
  onClose: () => void;
}) {
  // Remount on every open/close transition so the form and the post-create
  // success step never leak into a reopen (the ConfirmDialog reset pattern).
  return (
    <CreateDeploymentModalContent
      key={open ? "open" : "closed"}
      open={open}
      appId={appId}
      onClose={onClose}
    />
  );
}

function CreateDeploymentModalContent({
  open,
  appId,
  onClose,
}: {
  open: boolean;
  appId: string;
  onClose: () => void;
}) {
  const createMutation = useCreateDeployment();
  const [name, setName] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [created, setCreated] = useState<Deployment | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  const busy = createMutation.isPending;

  const submit = () => {
    if (busy) {
      return;
    }
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setFieldError("Enter a deployment name.");
      return;
    }
    setFieldError(null);
    createMutation.mutate(
      { appId, body: { name: trimmed } },
      {
        onSuccess: (deployment) => setCreated(deployment),
        onError: (error) => {
          if (problemBehavior(error) === "name-conflict") {
            setFieldError("A deployment with this name already exists.");
          }
        },
      },
    );
  };

  const requestClose = () => {
    if (!busy) {
      onClose();
    }
  };

  // Success step: reveal the new deploymentKey prominently.
  if (created !== null) {
    return (
      <Modal
        open={open}
        onClose={onClose}
        title="Deployment created"
        description={`${created.name} is ready to use.`}
        icon={<LayersIcon />}
        tone="green"
        footer={
          <button type="button" className={buttonVariants({ intent: "primary" })} onClick={onClose}>
            Done
          </button>
        }
      >
        <div className={FIELD}>
          <span className={FIELD_LABEL}>Deployment key</span>
          <Copyable
            value={created.deploymentKey}
            display="full"
            ariaLabel={`Copy deployment key for ${created.name}`}
          />
        </div>
        <div className={`${CALLOUT} ${CALLOUT_TONE.info}`}>
          <InfoIcon />
          <div>
            Use this key in the {SDK_DISPLAY_NAME} configuration. It stays available
            in the deployments table.
          </div>
        </div>
      </Modal>
    );
  }

  const generalError =
    createMutation.isError && fieldError === null
      ? describeProblem(createMutation.error)
      : null;

  return (
    <Modal
      open={open}
      onClose={requestClose}
      title="New deployment"
      description="A fresh deployment key is generated and revealed after creation."
      icon={<LayersIcon />}
      initialFocusRef={nameInputRef}
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
            type="button"
            className={buttonVariants({ intent: "primary" })}
            onClick={submit}
            disabled={busy}
            aria-busy={busy || undefined}
          >
            {busy ? <span className="spinner sm" aria-hidden="true" /> : null}
            Create deployment
          </button>
        </>
      }
    >
      <form
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          submit();
        }}
      >
        <label className={FIELD}>
          <span className={FIELD_LABEL}>Deployment name</span>
          <input
            ref={nameInputRef}
            className={`${INPUT} ${INPUT_STATE.normal}`}
            placeholder="e.g. Beta"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setFieldError(null);
            }}
            disabled={busy}
          />
          {fieldError !== null ? (
            <span className={FIELD_ERR} role="alert">
              <AlertIcon />
              {fieldError}
            </span>
          ) : (
            <span className={FIELD_HINT}>
              Common names: Production, Staging, Development.
            </span>
          )}
        </label>
        {generalError !== null ? (
          <div className={`${CALLOUT} ${CALLOUT_TONE.danger}`} role="alert">
            <AlertIcon />
            <div>{generalError}</div>
          </div>
        ) : null}
      </form>
    </Modal>
  );
}

// --- Rename deployment ---------------------------------------------------------

function RenameDeploymentModal({
  deployment,
  onClose,
}: {
  deployment: Deployment | null;
  onClose: () => void;
}) {
  return (
    <RenameDeploymentModalContent
      key={deployment === null ? "closed" : deployment.id}
      deployment={deployment}
      onClose={onClose}
    />
  );
}

function RenameDeploymentModalContent({
  deployment,
  onClose,
}: {
  deployment: Deployment | null;
  onClose: () => void;
}) {
  const renameMutation = useRenameDeployment();
  const toast = useToast();
  const [name, setName] = useState(deployment?.name ?? "");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  const busy = renameMutation.isPending;

  const submit = () => {
    if (deployment === null || busy) {
      return;
    }
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setFieldError("Enter a deployment name.");
      return;
    }
    if (trimmed === deployment.name) {
      onClose();
      return;
    }
    setFieldError(null);
    renameMutation.mutate(
      { deploymentId: deployment.id, body: { name: trimmed } },
      {
        onSuccess: (renamed) => {
          toast.success(`Deployment renamed to ${renamed.name}`);
          onClose();
        },
        onError: (error) => {
          if (problemBehavior(error) === "name-conflict") {
            setFieldError("A deployment with this name already exists.");
          }
        },
      },
    );
  };

  const requestClose = () => {
    if (!busy) {
      onClose();
    }
  };

  const generalError =
    renameMutation.isError && fieldError === null
      ? describeProblem(renameMutation.error)
      : null;

  return (
    <Modal
      open={deployment !== null}
      onClose={requestClose}
      title="Rename deployment"
      description={
        deployment !== null ? `Renames ${deployment.name}.` : undefined
      }
      icon={<LayersIcon />}
      initialFocusRef={nameInputRef}
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
            type="button"
            className={buttonVariants({ intent: "primary" })}
            onClick={submit}
            disabled={busy}
            aria-busy={busy || undefined}
          >
            {busy ? <span className="spinner sm" aria-hidden="true" /> : null}
            Save
          </button>
        </>
      }
    >
      <form
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          submit();
        }}
      >
        <label className={FIELD}>
          <span className={FIELD_LABEL}>Deployment name</span>
          <input
            ref={nameInputRef}
            className={`${INPUT} ${INPUT_STATE.normal}`}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setFieldError(null);
            }}
            disabled={busy}
          />
          {fieldError !== null ? (
            <span className={FIELD_ERR} role="alert">
              <AlertIcon />
              {fieldError}
            </span>
          ) : (
            <span className={FIELD_HINT}>Must be unique within the app.</span>
          )}
        </label>
        {generalError !== null ? (
          <div className={`${CALLOUT} ${CALLOUT_TONE.danger}`} role="alert">
            <AlertIcon />
            <div>{generalError}</div>
          </div>
        ) : null}
      </form>
    </Modal>
  );
}

// --- Icons (lucide-style glyph paths) -----------------------------------------

function SvgIcon({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  );
}

function LayersIcon() {
  return (
    <SvgIcon>
      <path d="m12 2 9 5-9 5-9-5 9-5z" />
      <path d="m3 12 9 5 9-5" />
      <path d="m3 17 9 5 9-5" />
    </SvgIcon>
  );
}

function AlertIcon() {
  return (
    <SvgIcon>
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

// --- Loading skeleton ----------------------------------------------------------

function DeploymentTableSkeleton() {
  return (
    <div className={TBL_WRAP} role="status" aria-label="Loading deployments">
      <table className={TBL}>
        <thead>
          <tr>
            <th className={TBL_TH}>Deployment</th>
            <th className={TBL_TH}>Deployment key</th>
            <th className={TBL_TH}>Latest release</th>
            <th className={`${TBL_TH} ${TBL_RIGHT}`}>Active users</th>
            <th className={`${TBL_TH} ${TBL_RIGHT}`}>Downloads</th>
            <th className={TBL_TH} aria-hidden="true" />
          </tr>
        </thead>
        <tbody>
          {[0, 1, 2].map((row) => (
            <tr key={row} className={TBL_TR}>
              <td className={TBL_TD}>
                <Skeleton width={110} variant="text" />
              </td>
              <td className={TBL_TD}>
                <Skeleton width={96} variant="text" />
              </td>
              <td className={TBL_TD}>
                <Skeleton width={84} variant="text" />
              </td>
              <td className={`${TBL_TD} ${TBL_NUM}`}>
                <span className="flex justify-end">
                  <Skeleton width={48} variant="text" />
                </span>
              </td>
              <td className={`${TBL_TD} ${TBL_NUM}`}>
                <span className="flex justify-end">
                  <Skeleton width={48} variant="text" />
                </span>
              </td>
              <td className={TBL_TD} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
