// Deployment detail screen. The
// deployment record is selected from `useDeployments(appId)` — note:
// there is NO single-deployment GET — so an unknown `:depId` renders a
// synthetic `not-found` problem through ErrorState plus a breadcrumb-up link
// back to the app. Three independent regions (loading skeletons are
// per-region): header (deployments list), metrics summary strip
// (`useDeploymentMetrics`, derived EXCLUSIVELY via model/metrics.ts
// aggregateMetrics/successRate — a strip failure degrades to "—" cards + a
// retry callout without touching the table), and the release history table
// (`useReleases` infinite query, newest-first offset pages; "Load more" =
// fetchNextPage, exhaustion computed from `pagination.total` by the hook's
// getNextPageParam → hasNextPage). Actions are gated by role
// (`useTeamRole.can("release.deploy")`; denied → disabled + "Requires
// developer" tip per the RBAC matrix) × release status via model/release.ts
// (canDisable/canEnable/canPatchRollout; promote = any published; the header
// Rollback uses canRollback over the loaded rows' published count). Release
// `status` (StatusChip) renders in the history table; worker job status is
// omitted from this table (see release detail for job state). Lifecycle modals: every
// action funnels into the shared useReleaseActions coordinator's
// `openAction(type, release)`, which mounts RolloutModal / StatusModal /
// PromoteModal / RollbackModal. Empty history → New release CTA (CLI or bundle
// upload via NewReleaseModal).

import { Fragment, useEffect, useId, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
} from "react";

import { useApp } from "../api/hooks/apps";
import { useDeployments } from "../api/hooks/deployments";
import { useDeploymentMetrics } from "../api/hooks/metrics";
import { useReleases } from "../api/hooks/releases";
import { useUserLabel } from "../api/hooks/userLabels";
import { HttpProblemError } from "../api/problem";
import { apiServerUrl } from "../lib/cliSnippet";
import { Copyable } from "../components/ui/Copyable";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorState } from "../components/ui/ErrorState";
import { RolloutBar } from "../components/ui/RolloutBar";
import { Skeleton } from "../components/ui/Skeleton";
import { StatusChip } from "../components/ui/StatusChip";
import {
  activeVersionDistribution,
  aggregateMetrics,
  successRate,
} from "../model/metrics";
import {
  canDisable,
  canEnable,
  canPatchRollout,
  canRollback,
} from "../model/release";
import { useTeamRole } from "../rbac/useTeamRole";
import { NewReleaseModal } from "./release/modals/NewReleaseModal";
import {
  ReleaseHistoryTableHead,
  ReleaseNoteText,
  releaseHistoryCol,
} from "./release/releaseHistoryTable";
import { useReleaseActions } from "./release/modals/useReleaseActions";
import type { ReleaseListItem } from "../api/types";
import type { Deployment } from "../model/deployment";
import type { ReleaseMetrics } from "../model/metrics";
import type { Release } from "../model/release";
import { formatCount, formatDate, formatRelativeTime } from "../model/format";
import { buttonVariants } from "../components/ui/Button";
import { CALLOUT, CALLOUT_TONE } from "../components/ui/callout";
import { CELL_MAIN, CELL_SUB } from "../components/ui/cell";
import { CHIP, CHIP_TONE } from "../components/ui/chip";
import { PIN, PIN_TONE } from "../components/ui/pin";
import {
  STAT,
  STAT_ICO_ACCENT,
  STAT_ICO_BASE,
  STAT_META,
  STAT_TOP,
  STAT_VAL,
} from "../components/ui/stat";
import {
  TBL,
  TBL_TR,
  TBL_WRAP,
} from "../components/ui/table";
import {
  STATUS_LED,
  STATUS_PILL,
  STATUS_TONE,
} from "../components/ui/statusPill";
import {
  KEBAB,
  KEBAB_BTN,
  MENU_ITEM,
  MENU_ITEM_TONE,
  MENU_SEP,
} from "../components/ui/menu";
import { DropdownPanel } from "../components/ui/DropdownPanel";

/**
 * Lifecycle actions this screen can trigger. `release` is the target row for
 * the four row actions and null for the deployment-level rollback.
 */
export type DeploymentReleaseAction =
  | "patch-rollout"
  | "promote"
  | "disable"
  | "enable"
  | "rollback";

// ---------------------------------------------------------------------------

export function DeploymentDetailPage() {
  const { teamId = "", appId = "", depId = "" } = useParams();
  const deploymentsQuery = useDeployments(appId);

  if (deploymentsQuery.isPending) {
    return <DeploymentDetailSkeleton />;
  }

  if (deploymentsQuery.isError) {
    return (
      <div className="rounded-lg border border-border bg-surface shadow-sm">
        <ErrorState
          error={deploymentsQuery.error}
          onRetry={() => {
            void deploymentsQuery.refetch();
          }}
        />
      </div>
    );
  }

  const deployment = deploymentsQuery.data.find(
    (candidate) => candidate.id === depId,
  );

  if (deployment === undefined) {
    // No single-deployment GET exists, so an unknown id never yields
    // a server 404 — synthesize the `not-found` catalog row and offer the
    // breadcrumb-up path (that copy is non-retryable, hence the manual link).
    return (
      <div className="rounded-lg border border-border bg-surface shadow-sm">
        <ErrorState error={deploymentNotFoundError()} />
        <div className="flex justify-center pb-[26px]">
          <Link className={buttonVariants({ intent: "ghost" })} to={`/teams/${teamId}/apps/${appId}`}>
            <BackIcon /> Back to app
          </Link>
        </div>
      </div>
    );
  }

  // Keyed so per-deployment region state resets when :depId changes in place.
  return (
    <DeploymentDetail
      key={deployment.id}
      teamId={teamId}
      appId={appId}
      deployment={deployment}
    />
  );
}

function deploymentNotFoundError(): HttpProblemError {
  return new HttpProblemError(
    {
      type: "https://codemagic.io/patch/errors/not-found",
      title: "Deployment not found",
      detail:
        "This deployment isn't in this app — it may have been deleted, or you may not have access.",
      status: 404,
    },
    404,
  );
}

// ---------------------------------------------------------------------------
// Detail body (mounted only with a resolved deployment record)
// ---------------------------------------------------------------------------

function DeploymentDetail({
  teamId,
  appId,
  deployment,
}: {
  teamId: string;
  appId: string;
  deployment: Deployment;
}) {
  const { can, isLoading: roleLoading } = useTeamRole(teamId);
  // Resolves release authors (createdBy, an opaque user id) to member names
  // where the role bindings are readable; falls back to a shortened id.
  const resolveUser = useUserLabel(teamId);
  // App name only feeds the CLI snippet — usually a cache hit from the app
  // detail screen; a failure degrades to the id without erroring the page.
  const appQuery = useApp(appId);
  const releasesQuery = useReleases(deployment.id, { includeMetrics: true });

  const canDeploy = can("release.deploy");
  // Tooltip only once the role is resolved (no misleading hint mid-load);
  // every action here is `release.deploy` → developer+ (RBAC matrix).
  const deployTip = !canDeploy && !roleLoading ? "Requires developer" : undefined;

  // Wired: the lifecycle modals (RolloutModal / StatusModal /
  // PromoteModal / RollbackModal) mount via the shared useReleaseActions
  // coordinator — `openAction` is the single swap-in for the old no-op;
  // `release` is null for the deployment-level rollback.
  const { openAction, modals } = useReleaseActions({
    teamId,
    appId,
    deploymentId: deployment.id,
    deploymentName: deployment.name,
  });
  const [newReleaseOpen, setNewReleaseOpen] = useState(false);

  const pages = releasesQuery.data?.pages;
  const rows = pages?.flatMap((page) => page.releases) ?? [];
  // Freshest known total (every page reports it; the last is newest).
  const total = pages?.[pages.length - 1]?.pagination.total;

  // Gating over the LOADED rows only — conservative: unloaded pages can
  // only add published releases, and the newest-first 50-row first page
  // contains ≥2 published whenever any deployment realistically does.
  const publishedCount = rows.reduce(
    (count, row) => (row.release.status === "published" ? count + 1 : count),
    0,
  );
  const rollbackReady = canRollback(publishedCount);

  const appName = appQuery.data?.name ?? appId;
  const suggestedTargetBinaryVersion = rows[0]?.release.targetBinaryVersion ?? "";
  const newReleaseButton = (
    <span className="tip" data-tip={deployTip}>
      <button
        type="button"
        className={buttonVariants({ intent: "primary" })}
        disabled={!canDeploy}
        onClick={() => setNewReleaseOpen(true)}
      >
        <PlusIcon /> New release
      </button>
    </span>
  );

  const releasePath = (releaseId: string) =>
    `/teams/${teamId}/apps/${appId}/deployments/${deployment.id}/releases/${releaseId}`;

  let body: ReactNode;
  const isEmpty = releasesQuery.isSuccess && rows.length === 0;
  if (releasesQuery.isPending) {
    body = <ReleaseTableSkeleton />;
  } else if (releasesQuery.isError) {
    body = (
      <ErrorState
        error={releasesQuery.error}
        onRetry={() => {
          void releasesQuery.refetch();
        }}
      />
    );
  } else if (isEmpty) {
    // Empty release history → the CLI hint (uploads are
    // CLI-only, so the pre-filled command IS the call to action).
    body = (
      <EmptyState
        icon={<ActivityIcon />}
        title="No releases yet"
        description="Publish your first update via the CLI or by uploading a pre-built .cmpatch bundle."
        action={newReleaseButton}
      />
    );
  } else {
    body = (
      <>
        <div className={TBL_WRAP}>
          <table className={TBL}>
            <thead>
              <ReleaseHistoryTableHead />
            </thead>
            <tbody>
              {rows.map((item) => (
                <ReleaseRow
                  key={item.release.id}
                  item={item}
                  releasePath={releasePath(item.release.id)}
                  canDeploy={canDeploy}
                  deployTip={deployTip}
                  onAction={openAction}
                  resolveUser={resolveUser}
                />
              ))}
            </tbody>
          </table>
        </div>
        {releasesQuery.hasNextPage ? (
          <div className="flex justify-center p-[18px]">
            <button
              type="button"
              className={buttonVariants({ intent: "ghost", size: "sm" })}
              disabled={releasesQuery.isFetchingNextPage}
              aria-busy={releasesQuery.isFetchingNextPage || undefined}
              onClick={() => {
                void releasesQuery.fetchNextPage();
              }}
            >
              {releasesQuery.isFetchingNextPage ? (
                <span className="spinner sm" aria-hidden="true" />
              ) : (
                <RefreshIcon />
              )}{" "}
              Load more
              {total !== undefined ? ` (showing ${rows.length} of ${total})` : ""}
            </button>
          </div>
        ) : null}
      </>
    );
  }

  const historyCard = (
    <div className="rounded-lg border border-border bg-surface shadow-sm">
      <div className="flex items-center gap-3 border-b border-border px-[22px] py-[18px]">
        <span className="size-[18px] text-blue" aria-hidden="true">
          <ActivityIcon />
        </span>
        <h3 className="text-[15px] font-bold">Release history</h3>
        {total !== undefined ? (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-fg-3 text-[12.5px]">
              {total} {total === 1 ? "release" : "releases"}
            </span>
          </div>
        ) : null}
      </div>
      {body}
    </div>
  );

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start gap-[18px]">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-3 text-[27px] font-extrabold leading-[1.1] tracking-[-.025em]">
            {/* Header pill: the deployment name in the published-green
                pill (pure styling — deployments themselves carry no status). */}
            <span
              className={`${STATUS_PILL} ${STATUS_TONE.green}`}
              // fontSize/padding OVERRIDE STATUS_PILL's text-[12px]/py-1/pl-2/
              // pr-2.5 (this header pill is larger); conflicting utilities
              // cannot co-apply, so the overrides stay inline.
              style={{ fontSize: 13, padding: "6px 12px 6px 10px" }}
            >
              <span className={STATUS_LED} aria-hidden="true" />
              {deployment.name}
            </span>
          </h1>
          <div className="mt-3 flex flex-wrap items-center gap-2.5 text-[13px]">
            <Copyable
              value={deployment.deploymentKey}
              display="masked"
              maskHead={4}
              maskTail={4}
              label="Deployment key"
              ariaLabel={`Copy deployment key for ${deployment.name}`}
            />
            <span className={`${CHIP} ${CHIP_TONE.neutral}`}>
              SDK config value · not a secret
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          {newReleaseButton}
          <span className="tip" data-tip={deployTip}>
            <button
              type="button"
              className={buttonVariants({ intent: "ghost" })}
              disabled={!canDeploy || !rollbackReady}
              title={
                canDeploy && !rollbackReady
                  ? "Needs at least two published releases to roll back"
                  : undefined
              }
              onClick={() => openAction("rollback", null)}
            >
              <RollbackIcon /> Rollback
            </button>
          </span>
        </div>
      </div>

      <MetricsSummaryStrip deploymentId={deployment.id} />

      {historyCard}

      {modals}
      <NewReleaseModal
        open={newReleaseOpen}
        deploymentId={deployment.id}
        deploymentName={deployment.name}
        serverUrl={apiServerUrl()}
        appName={appName}
        suggestedTargetBinaryVersion={suggestedTargetBinaryVersion}
        codeSigningRequired={appQuery.data?.requireCodeSigning === true}
        onClose={() => setNewReleaseOpen(false)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Metrics summary strip (independent region)
// ---------------------------------------------------------------------------

function MetricsSummaryStrip({ deploymentId }: { deploymentId: string }) {
  // limit=100 is the server page maximum — the widest single-call aggregate
  // window (counters are hash-keyed, duplicates collapse in the derivation).
  const metricsQuery = useDeploymentMetrics(deploymentId, { limit: 100 });

  if (metricsQuery.isPending) {
    return (
      <div
        className="mb-[18px] grid-cols-[repeat(4,1fr)] gap-[18px] [display:grid] max-cols:grid-cols-[repeat(2,1fr)]"
        role="status"
        aria-label="Loading deployment metrics"
      >
        <Skeleton height={118} />
        <Skeleton height={118} />
        <Skeleton height={118} />
        <Skeleton height={118} />
      </div>
    );
  }

  if (metricsQuery.isError) {
    // Independent failure: "—" cards + retry; header/table stay usable.
    return (
      <>
        <StatCards totals={null} rate={null} activeVersionCount={null} />
        <div className={`${CALLOUT} ${CALLOUT_TONE.warn} mb-[18px]`} role="alert">
          <AlertIcon />
          <div>
            Couldn't load deployment metrics — the release history below is
            unaffected.{" "}
            <button
              type="button"
              className={buttonVariants({ intent: "ghost", size: "sm" })}
              onClick={() => {
                void metricsQuery.refetch();
              }}
            >
              <RefreshIcon /> Retry
            </button>
          </div>
        </div>
      </>
    );
  }

  // All derivation via model/metrics.ts — no math re-derived here.
  const entries = metricsQuery.data.releases;
  const totals = aggregateMetrics(entries.map((entry) => entry.metrics));
  const rate = successRate(totals);
  const activeVersionCount = activeVersionDistribution(
    entries.map((entry) => ({
      label: entry.releaseLabel,
      // A null hash (not yet processed) is its own group — key it by release.
      targetPackageHash: entry.targetPackageHash ?? `release:${entry.releaseId}`,
      metrics: entry.metrics,
    })),
  ).filter((share) => share.active > 0).length;

  return (
    <StatCards
      totals={totals}
      rate={rate}
      activeVersionCount={activeVersionCount}
    />
  );
}

/** The `.stat` strip; null totals render the "—" degraded variant. */
function StatCards({
  totals,
  rate,
  activeVersionCount,
}: {
  totals: ReleaseMetrics | null;
  rate: number | null;
  activeVersionCount: number | null;
}) {
  return (
    <div className="mb-[18px] grid-cols-[repeat(4,1fr)] gap-[18px] [display:grid] max-cols:grid-cols-[repeat(2,1fr)]">
      <div
        className={STAT}
        style={
          {
            "--accent": "var(--color-aqua)",
            "--accent-tint": "var(--color-aqua-tint)",
          } as CSSProperties
        }
      >
        <div className={STAT_TOP}>
          <span className={`${STAT_ICO_BASE} ${STAT_ICO_ACCENT}`}>
            <Users2Icon />
          </span>{" "}
          Active users
        </div>
        <div className={STAT_VAL}>
          {totals === null ? "—" : formatCount(totals.active)}
        </div>
        <div className={STAT_META}>
          {activeVersionCount === null
            ? "metrics unavailable"
            : `on ${activeVersionCount} active ${
                activeVersionCount === 1 ? "version" : "versions"
              }`}
        </div>
      </div>
      <div
        className={STAT}
        style={{ "--accent": "var(--color-blue)" } as CSSProperties}
      >
        <div className={STAT_TOP}>
          <span className={`${STAT_ICO_BASE} ${STAT_ICO_ACCENT}`}>
            <DownloadIcon />
          </span>{" "}
          Downloads
        </div>
        <div className={STAT_VAL}>
          {totals === null ? "—" : formatCount(totals.downloaded)}
        </div>
        <div className={STAT_META}>lifetime, this deployment</div>
      </div>
      <div
        className={STAT}
        style={
          {
            "--accent": "var(--color-green)",
            "--accent-tint": "var(--color-green-tint)",
          } as CSSProperties
        }
      >
        <div className={STAT_TOP}>
          <span className={`${STAT_ICO_BASE} ${STAT_ICO_ACCENT}`}>
            <CheckCircleIcon />
          </span>{" "}
          Success rate
        </div>
        <div className={STAT_VAL}>
          {rate === null ? (
            // successRate is null when no Success/Failed events exist.
            "—"
          ) : (
            <>
              {(rate * 100).toFixed(1)}
              <small>%</small>
            </>
          )}
        </div>
        <div className={STAT_META}>install success</div>
      </div>
      <div
        className={STAT}
        style={
          {
            "--accent": "var(--color-red)",
            "--accent-tint": "var(--color-red-tint)",
          } as CSSProperties
        }
      >
        <div className={STAT_TOP}>
          <span className={`${STAT_ICO_BASE} ${STAT_ICO_ACCENT}`}>
            <AlertIcon />
          </span>{" "}
          Failed
        </div>
        <div className={STAT_VAL}>
          {totals === null ? "—" : formatCount(totals.failed)}
        </div>
        <div className={STAT_META}>failed installs</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Release history rows
// ---------------------------------------------------------------------------

function ReleaseRow({
  item,
  releasePath,
  canDeploy,
  deployTip,
  onAction,
  resolveUser,
}: {
  item: ReleaseListItem;
  releasePath: string;
  canDeploy: boolean;
  deployTip: string | undefined;
  onAction: (action: DeploymentReleaseAction, release: Release) => void;
  resolveUser: (userId: string | null) => string | null;
}) {
  const { release, metrics } = item;

  // Status gating (model/release.ts) decides WHICH actions exist; role
  // gating decides enabled vs disabled-with-tooltip.
  const items: KebabItem[] = [];
  if (canPatchRollout(release)) {
    items.push({
      key: "patch-rollout",
      label: "Increase rollout",
      allowed: canDeploy,
      requiresTip: deployTip,
      onSelect: () => onAction("patch-rollout", release),
    });
  }
  // Promote is offered for ANY published release (destination rollout
  // defaults to 100 and is not inherited — gating is status-only here).
  if (release.status === "published") {
    items.push({
      key: "promote",
      label: "Promote…",
      allowed: canDeploy,
      requiresTip: deployTip,
      onSelect: () => onAction("promote", release),
    });
  }
  if (canDisable(release)) {
    items.push({
      key: "disable",
      label: "Disable",
      allowed: canDeploy,
      requiresTip: deployTip,
      onSelect: () => onAction("disable", release),
    });
  }
  if (canEnable(release)) {
    items.push({
      key: "enable",
      label: "Enable",
      allowed: canDeploy,
      requiresTip: deployTip,
      onSelect: () => onAction("enable", release),
    });
  }

  return (
    <tr className={TBL_TR}>
      <td className={releaseHistoryCol.td.release}>
        <div className={CELL_MAIN}>
          <Link className="font-semibold" to={releasePath}>
            {release.releaseLabel}
          </Link>{" "}
          {release.isMandatory ? (
            <span className={`${PIN} ${PIN_TONE.mandatory}`}>
              <AlertIcon />
              Mandatory
            </span>
          ) : null}{" "}
          {/* fontSize:10 OVERRIDES CHIP's text-[11.5px]; conflicting utilities
              cannot co-apply, so the override stays inline. */}
          {release.rollbackOf !== null ? (
            <span className={`${CHIP} ${CHIP_TONE.neutral}`} style={{ fontSize: 10 }}>
              rollback
            </span>
          ) : null}
        </div>
        <div className={CELL_SUB} title={release.createdBy ?? undefined}>
          {release.createdBy !== null ? (
            <>
              by{" "}
              {resolveUser(release.createdBy) ?? shortId(release.createdBy)} ·{" "}
            </>
          ) : null}
          {/* Relative time for at-a-glance recency; absolute date on
              hover via the <time> title. */}
          <time
            dateTime={release.createdAt}
            title={formatDate(release.createdAt)}
          >
            {formatRelativeTime(release.createdAt)}
          </time>
        </div>
      </td>
      <td className={releaseHistoryCol.td.note}>
        {release.releaseNotes === null || release.releaseNotes.trim() === "" ? (
          <span className="text-fg-3">—</span>
        ) : (
          <ReleaseNoteText text={release.releaseNotes} />
        )}
      </td>
      <td className={releaseHistoryCol.td.data}>
        <StatusChip status={release.status} />
      </td>
      <td className={releaseHistoryCol.td.data}>
        <RolloutBar
          percentage={release.rolloutPercentage}
          ariaLabel={`Rollout for ${release.releaseLabel}`}
          compact
        />
      </td>
      <td className={releaseHistoryCol.td.data}>
        {release.targetBinaryVersion}
      </td>
      <td className={releaseHistoryCol.td.data}>
        {metrics === undefined ? (
          <span className="text-fg-3">—</span>
        ) : (
          formatCount(metrics.active)
        )}
      </td>
      <td className={releaseHistoryCol.td.data}>
        {metrics === undefined ? (
          <span className="text-fg-3">—</span>
        ) : (
          formatCount(metrics.success)
        )}
      </td>
      <td className={releaseHistoryCol.td.data}>
        {metrics === undefined ? (
          <span className="text-fg-3">—</span>
        ) : (
          formatCount(metrics.failed)
        )}
      </td>
      <td className={releaseHistoryCol.td.actions}>
        {items.length === 0 ? null : (
          <RowKebab releaseLabel={release.releaseLabel} items={items} />
        )}
      </td>
    </tr>
  );
}

function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

// --- Row kebab menu (DeploymentTable's pattern, local per house convention) --

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
 * The `.kebab` dropdown with the AccountMenu keyboard contract: outside
 * pointerdown closes, Esc closes + refocuses the trigger, first item focused
 * on open, ArrowUp/Down cycle. Denied items stay focusable (`aria-disabled` +
 * tooltip) per the disable-with-tooltip discoverability convention.
 */
function RowKebab({
  releaseLabel,
  items,
}: {
  releaseLabel: string;
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
        aria-label={`Actions for ${releaseLabel}`}
        onClick={() => setOpen((value) => !value)}
      >
        <IconSvg>
          <circle cx="12" cy="5" r="1.6" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
          <circle cx="12" cy="19" r="1.6" fill="currentColor" stroke="none" />
        </IconSvg>
      </button>
      <DropdownPanel
        open={open}
        anchorRef={buttonRef}
        menuRef={menuRef}
        menuId={menuId}
        label={`${releaseLabel} actions`}
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

/** Home/End jump to the first/last menu item (denied items stay focusable here
 *  by design — they carry the "Requires {role}" discoverability tooltip). */
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

// ---------------------------------------------------------------------------
// Skeletons (per-region)
// ---------------------------------------------------------------------------

/** Whole-page skeleton while the deployments list (header source) loads. */
function DeploymentDetailSkeleton() {
  return (
    <div role="status" aria-label="Loading deployment">
      <div className="mb-6 flex flex-wrap items-start gap-[18px]">
        <div className="min-w-0 flex-1">
          <Skeleton width={180} height={34} />
          <div className="mt-3">
            <Skeleton width={300} variant="text" />
          </div>
        </div>
      </div>
      <div className="mb-[18px] grid-cols-[repeat(4,1fr)] gap-[18px] [display:grid] max-cols:grid-cols-[repeat(2,1fr)]">
        <Skeleton height={118} />
        <Skeleton height={118} />
        <Skeleton height={118} />
        <Skeleton height={118} />
      </div>
      <div className="rounded-lg border border-border bg-surface p-[22px] shadow-sm">
        <Skeleton variant="line" />
        <Skeleton variant="line" />
        <Skeleton variant="line" />
      </div>
    </div>
  );
}

function ReleaseTableSkeleton() {
  return (
    <div className={TBL_WRAP} role="status" aria-label="Loading releases">
      <table className={TBL}>
        <thead>
          <ReleaseHistoryTableHead actionsLabel={null} />
        </thead>
        <tbody>
          {[0, 1, 2].map((row) => (
            <tr key={row} className={TBL_TR}>
              <td className={releaseHistoryCol.td.release}>
                <Skeleton width={90} variant="text" />
              </td>
              <td className={releaseHistoryCol.td.note}>
                <Skeleton width="38ch" variant="text" />
              </td>
              <td className={releaseHistoryCol.td.data}>
                <Skeleton width={84} variant="text" />
              </td>
              <td className={releaseHistoryCol.td.data}>
                <Skeleton width={65} variant="text" />
              </td>
              <td className={releaseHistoryCol.td.data}>
                <Skeleton width={36} variant="text" />
              </td>
              <td className={releaseHistoryCol.td.data}>
                <Skeleton width={28} variant="text" />
              </td>
              <td className={releaseHistoryCol.td.data}>
                <Skeleton width={28} variant="text" />
              </td>
              <td className={releaseHistoryCol.td.data}>
                <Skeleton width={28} variant="text" />
              </td>
              <td className={releaseHistoryCol.td.actions} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Icon paths mirror the shared icon set (`users2`, `download`,
// `checkCircle`, `alert`, `activity`, `refresh`, `rollback`, `more`).

function IconSvg({ children }: { children: ReactNode }) {
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

function Users2Icon() {
  return (
    <IconSvg>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M3 20v-1a5 5 0 0 1 10 0v1" />
      <path d="M16 5.5a3.5 3.5 0 0 1 0 6.9M21 20v-1a5 5 0 0 0-3.5-4.75" />
    </IconSvg>
  );
}

function DownloadIcon() {
  return (
    <IconSvg>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </IconSvg>
  );
}

function CheckCircleIcon() {
  return (
    <IconSvg>
      <circle cx="12" cy="12" r="9" />
      <polyline points="16 9.5 11 14.5 8.5 12" />
    </IconSvg>
  );
}

function AlertIcon() {
  return (
    <IconSvg>
      <path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12" y2="17" />
    </IconSvg>
  );
}

function ActivityIcon() {
  return (
    <IconSvg>
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </IconSvg>
  );
}

function RefreshIcon() {
  return (
    <IconSvg>
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </IconSvg>
  );
}

function RollbackIcon() {
  return (
    <IconSvg>
      <polyline points="9 14 4 9 9 4" />
      <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
    </IconSvg>
  );
}

function PlusIcon() {
  return (
    <IconSvg>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </IconSvg>
  );
}

function BackIcon() {
  return (
    <IconSvg>
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
    </IconSvg>
  );
}
