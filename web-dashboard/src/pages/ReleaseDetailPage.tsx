// Release detail / inspect screen.
// `GET /v1/releases/:releaseId` via useRelease — the WorkerJobPanel's
// auto-poll toggle maps straight onto the hook's `{ poll }` option, whose
// refetchInterval already stops at a terminal job (`succeeded | failed |
// dead_letter`, model/release.ts isTerminalJobStatus) or a job-less release,
// so the toggle defaults ON safely (dashboard equivalent of CLI
// `release inspect --wait`); the Refresh button is a plain manual refetch.
// Release `status` (StatusChip) and worker `job.status` (JobBadge) are
// independent fields rendered side by side and NEVER conflated (domain
// model hard rule). Regions degrade independently (loading
// skeletons are per-region): the release envelope owns the page; the
// MetricsPanel (useReleaseMetrics, derivation via model/metrics.ts
// successRate — no math re-derived here) fails to "—" + retry without
// touching the rest. Actions are gated by role (`useTeamRole.can
// ("release.deploy")`; denied → disabled + "Requires developer" tip per the
// RBAC matrix) × release status via model/release.ts (canDisable/canEnable/
// canPatchRollout; promote = any published; Edit metadata = any status,
// carries no status gate) and funnel into the shared useReleaseActions
// coordinator, which mounts RolloutModal / StatusModal /
// PromoteModal / EditMetadataModal (same handoff as DeploymentDetailPage).
// Wire note: the Release DTO (server domain types @ 25b9477) carries
// `rollbackOf` but no `source_bundle_release_id`, so of the two
// source links only the rollback one can render today — the Source row
// gains the promoted-from link when that field lands on the wire. An
// unknown :releaseId is a real server 404 → ErrorState + breadcrumb-up link
// (error catalog "not-found").

import { useState } from "react";
import { Link, useParams } from "react-router";
import type { ReactNode } from "react";

import { useReleaseMetrics } from "../api/hooks/metrics";
import { RELEASE_POLL_INTERVAL_MS, useRelease } from "../api/hooks/releases";
import { useUserLabel } from "../api/hooks/userLabels";
import { Copyable } from "../components/ui/Copyable";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorState } from "../components/ui/ErrorState";
import { JobBadge } from "../components/ui/JobBadge";
import {
  ROLLOUT,
  ROLLOUT_FILL,
  ROLLOUT_FILL_FULL,
  ROLLOUT_TRACK,
  RolloutBar,
} from "../components/ui/RolloutBar";
import { Skeleton } from "../components/ui/Skeleton";
import { StatusChip } from "../components/ui/StatusChip";
import { successRate } from "../model/metrics";
import {
  canDisable,
  canEnable,
  canPatchRollout,
  isTerminalJobStatus,
} from "../model/release";
import { useTeamRole } from "../rbac/useTeamRole";
import { useReleaseActions } from "./release/modals/useReleaseActions";
import type { ReleaseMetrics } from "../model/metrics";
import type { ReleaseJob } from "../model/release";
import { buttonVariants } from "../components/ui/Button";
import { CALLOUT, CALLOUT_TONE } from "../components/ui/callout";
import { CARD, CARD_HEAD, CARD_HEAD_RIGHT, CARD_PAD } from "../components/ui/card";
import { CELL_SUB } from "../components/ui/cell";
import { CHIP, CHIP_TONE } from "../components/ui/chip";
import { DL, DL_DD, DL_DT } from "../components/ui/dl";
import { ICON_BTN } from "../components/ui/iconButton";
import { PIN, PIN_TONE } from "../components/ui/pin";
import { SECTION_TITLE } from "../components/ui/typography";
import { formatCount, formatDateTime } from "../model/format";

/**
 * Lifecycle actions this screen can trigger; `release` is always THE viewed
 * release. Same handoff shape as DeploymentDetailPage's onAction — both
 * screens wire into the shared useReleaseActions modals identically.
 */
export type ReleaseDetailAction =
  | "patch-rollout"
  | "promote"
  | "disable"
  | "enable"
  | "edit-metadata";

// ---------------------------------------------------------------------------

export function ReleaseDetailPage() {
  const { teamId = "", appId = "", depId = "", releaseId = "" } = useParams();

  // Keyed so the auto-poll toggle (and any panel state) resets when
  // :releaseId changes in place — the rollback-of link navigates within this
  // very route.
  return (
    <ReleaseDetail
      key={releaseId}
      teamId={teamId}
      appId={appId}
      depId={depId}
      releaseId={releaseId}
    />
  );
}

// ---------------------------------------------------------------------------
// Detail body
// ---------------------------------------------------------------------------

function ReleaseDetail({
  teamId,
  appId,
  depId,
  releaseId,
}: {
  teamId: string;
  appId: string;
  depId: string;
  releaseId: string;
}) {
  // Auto-poll defaults ON (toggle ships checked): the hook stops
  // polling by itself once the job is terminal or absent, so an idle toggle
  // costs nothing — flipping it OFF is the manual-only inspect mode.
  const [autoPoll, setAutoPoll] = useState(true);
  const releaseQuery = useRelease(releaseId, { poll: autoPoll });
  const { can, isLoading: roleLoading } = useTeamRole(teamId);
  // Resolves release.createdBy (an opaque user id) to a member name where the
  // bindings are readable; falls back to a shortened id otherwise.
  const resolveUser = useUserLabel(teamId);

  // Wired: lifecycle actions open the shared modals via the
  // coordinator — `openAction` replaced the old no-op (single swap point).
  // Scoped by the URL params this page mounted under (rollback is not
  // offered here, so the deployment name is irrelevant).
  const { openAction, modals } = useReleaseActions({
    teamId,
    appId,
    deploymentId: depId,
  });

  // Breadcrumb-up target ("not-found" row): the deployment we came from.
  const deploymentPath = `/teams/${teamId}/apps/${appId}/deployments/${depId}`;

  if (releaseQuery.isPending) {
    return <ReleaseDetailSkeleton />;
  }

  if (releaseQuery.isError) {
    return (
      <div className={CARD}>
        <ErrorState
          error={releaseQuery.error}
          onRetry={() => {
            void releaseQuery.refetch();
          }}
        />
        <div className="flex justify-center pb-[26px]">
          <Link className={buttonVariants({ intent: "ghost" })} to={deploymentPath}>
            <BackIcon /> Back to deployment
          </Link>
        </div>
      </div>
    );
  }

  const { release, job } = releaseQuery.data;

  const canDeploy = can("release.deploy");
  // Tooltip only once the role is resolved (no misleading hint mid-load);
  // every action here is `release.deploy` → developer+ (RBAC matrix).
  const deployTip = !canDeploy && !roleLoading ? "Requires developer" : undefined;

  // Links to other releases are built from the DTO's own scope fields (not
  // the URL params) so a deep-linked page still points at the right place.
  const releasePath = (targetReleaseId: string) =>
    `/teams/${release.teamId}/apps/${release.appId}/deployments/${release.deploymentId}/releases/${targetReleaseId}`;

  // Status gating (model/release.ts) decides WHICH actions exist; role
  // gating decides enabled vs disabled-with-tooltip (RBAC matrix).
  const actions: { key: ReleaseDetailAction; label: string; icon: ReactNode }[] =
    [];
  if (canPatchRollout(release)) {
    actions.push({
      key: "patch-rollout",
      label: "Increase rollout",
      icon: <TrendUpIcon />,
    });
  }
  // Promote is offered for ANY published release (destination rollout
  // defaults to 100 and is not inherited — gating is status-only here).
  if (release.status === "published") {
    actions.push({ key: "promote", label: "Promote", icon: <RocketIcon /> });
  }
  if (canDisable(release)) {
    actions.push({ key: "disable", label: "Disable", icon: <PauseIcon /> });
  }
  if (canEnable(release)) {
    actions.push({ key: "enable", label: "Enable", icon: <PlayIcon /> });
  }
  // Non-rollout metadata carries no status restriction —
  // offered for every status; the server stays the final authority.
  actions.push({
    key: "edit-metadata",
    label: "Edit metadata",
    icon: <PencilIcon />,
  });

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start gap-[18px]">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-3 text-[27px] font-extrabold leading-[1.1] tracking-[-.025em]">
            {release.releaseLabel}{" "}
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
          </h1>
          {/* The two independent state fields, side by side and labeled —
              release `status` is NOT the worker `job.status` (domain model hard rule). */}
          <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
            <span className="text-fg-3">Release status</span>
            <StatusChip status={release.status} />
            <span className="ml-2 text-fg-3">
              Worker job
            </span>
            {job === null ? (
              <span className="text-fg-3">—</span>
            ) : (
              <JobBadge status={job.status} />
            )}
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          {actions.map((action) => (
            <span key={action.key} className="tip" data-tip={deployTip}>
              <button
                type="button"
                className={buttonVariants({ intent: "ghost" })}
                disabled={!canDeploy}
                onClick={() => openAction(action.key, release)}
              >
                {action.icon} {action.label}
              </button>
            </span>
          ))}
        </div>
      </div>

      <div className="grid-cols-[1fr_360px] items-start gap-[22px] [display:grid] max-cols:grid-cols-[1fr]">
        {/* LEFT: metadata, notes, metrics */}
        <div className="flex flex-col gap-[22px]">
          <div className={`${CARD} ${CARD_PAD}`}>
            <div className={`${SECTION_TITLE} mb-[18px]`}>Release metadata</div>
            <dl className={DL}>
              <dt className={DL_DT}>Target binary version</dt>
              <dd className={DL_DD}>
                <code className="mono">{release.targetBinaryVersion}</code>
              </dd>
              <dt className={DL_DT}>Rollout</dt>
              <dd className={DL_DD}>
                <div className="min-w-[180px]">
                  <RolloutBar
                    percentage={release.rolloutPercentage}
                    ariaLabel={`Rollout for ${release.releaseLabel}`}
                  />
                </div>
              </dd>
              <dt className={DL_DT}>Mandatory</dt>
              <dd className={DL_DD}>
                {release.isMandatory ? (
                  <span className={`${PIN} ${PIN_TONE.mandatory}`}>
                    <CheckIcon />
                    Yes
                  </span>
                ) : (
                  <span className="text-fg-3">No</span>
                )}
              </dd>
              <dt className={DL_DT}>Fingerprint</dt>
              <dd className={DL_DD}>
                {release.fingerprint === null ? (
                  // Null while fingerprint support is deferred (model note).
                  <span className="text-fg-3">— not recorded</span>
                ) : (
                  <Copyable
                    value={release.fingerprint}
                    display="masked"
                    maskHead={7}
                    maskTail={4}
                    ariaLabel="Copy fingerprint"
                  />
                )}
              </dd>
              <dt className={DL_DT}>Package hash</dt>
              <dd className={DL_DD}>
                {release.targetPackageHash === null ? (
                  <span className="text-fg-3">pending — computed by the worker</span>
                ) : (
                  <Copyable
                    value={release.targetPackageHash}
                    display="masked"
                    maskHead={11}
                    maskTail={4}
                    ariaLabel="Copy package hash"
                  />
                )}
              </dd>
              <dt className={DL_DT}>Signature</dt>
              <dd className={DL_DD}>
                {release.signature === null ? (
                  <span className="text-fg-3">Not signed</span>
                ) : (
                  <span className={`${PIN} ${PIN_TONE.sign}`}>
                    <ShieldIcon />
                    Signed
                    {release.signatureHashAlgorithm === null
                      ? ""
                      : ` · ${release.signatureHashAlgorithm}`}
                  </span>
                )}
              </dd>
              {release.rollbackOf !== null ? (
                <>
                  <dt className={DL_DT}>Source</dt>
                  <dd className={DL_DD}>
                    <Link
                      to={releasePath(release.rollbackOf)}
                      className="font-semibold text-blue"
                    >
                      Rollback of release{" "}
                      <span title={release.rollbackOf}>
                        {shortId(release.rollbackOf)}
                      </span>
                    </Link>
                  </dd>
                </>
              ) : null}
              <dt className={DL_DT}>Created</dt>
              <dd className={DL_DD} title={release.createdBy ?? undefined}>
                {release.createdBy === null ? (
                  formatDateTime(release.createdAt)
                ) : (
                  <>
                    by{" "}
                    <b>
                      {resolveUser(release.createdBy) ??
                        shortId(release.createdBy)}
                    </b>{" "}
                    · {formatDateTime(release.createdAt)}
                  </>
                )}
              </dd>
              <dt className={DL_DT}>Updated</dt>
              <dd className={DL_DD}>{formatDateTime(release.updatedAt)}</dd>
            </dl>
          </div>

          <div className={`${CARD} ${CARD_PAD}`}>
            <div className={`${SECTION_TITLE} mb-[18px]`}>Release notes</div>
            {release.releaseNotes === null ? (
              <p className="m-0 text-[13.5px] text-fg-3">No release notes.</p>
            ) : (
              <p className="m-0 whitespace-pre-wrap text-[13.5px] leading-[1.65] text-fg-2">
                {release.releaseNotes}
              </p>
            )}
          </div>

          <MetricsPanel releaseId={release.id} />
        </div>

        {/* RIGHT: worker job */}
        <div className="flex flex-col gap-[22px]">
          <WorkerJobPanel
            job={job}
            autoPoll={autoPoll}
            onAutoPollChange={setAutoPoll}
            isRefreshing={releaseQuery.isFetching}
            onRefresh={() => {
              void releaseQuery.refetch();
            }}
          />
          <JobStateReferenceCard />
        </div>
      </div>

      {modals}
    </>
  );
}

// ---------------------------------------------------------------------------
// Worker job panel (inspect — refresh + auto-poll until terminal)
// ---------------------------------------------------------------------------

function WorkerJobPanel({
  job,
  autoPoll,
  onAutoPollChange,
  isRefreshing,
  onRefresh,
}: {
  job: ReleaseJob | null;
  autoPoll: boolean;
  onAutoPollChange: (value: boolean) => void;
  isRefreshing: boolean;
  onRefresh: () => void;
}) {
  // "Active" = the poll has something to wait for; terminal/absent jobs make
  // the hook's refetchInterval return false even while the toggle is ON.
  const active = job !== null && !isTerminalJobStatus(job.status);

  return (
    <div className={`${CARD} border-blue-tint-2`}>
      <div className={`${CARD_HEAD} bg-blue-tint border-b-blue-tint-2`}>
        <span className="size-[18px] text-blue" aria-hidden="true">
          <ServerIcon />
        </span>
        <h3>Worker job</h3>
        <div className={CARD_HEAD_RIGHT}>
          <button
            type="button"
            className={`${ICON_BTN} tip size-8 rounded-control [&_svg]:size-[18px]`}
            data-tip="Refresh"
            aria-label="Refresh job status"
            disabled={isRefreshing}
            aria-busy={isRefreshing || undefined}
            onClick={onRefresh}
          >
            <RefreshIcon />
          </button>
        </div>
      </div>
      <div className={CARD_PAD}>
        {job === null ? (
          <p className="m-0 text-[13.5px] text-fg-3">
            No worker job recorded for this release — lifecycle actions queue
            one; refresh to pick it up.
          </p>
        ) : (
          <>
            <div className="flex items-center gap-3">
              {active ? (
                <span
                  className="spinner sm blue m-0"
                  aria-hidden="true"
                />
              ) : null}
              <JobBadge status={job.status} />
              <span className="ml-auto text-[12px] text-fg-3">
                attempt {job.attemptCount} / {job.maxTotalAttempts}
              </span>
            </div>
            <JobCallout job={job} />
            <dl className={`${DL} mt-[18px]`}>
              <dt className={DL_DT}>Trigger</dt>
              <dd className={DL_DD}>
                <code className="mono text-[12px]">
                  {job.triggerType}
                </code>
              </dd>
              {job.failureStage !== null ? (
                <>
                  <dt className={DL_DT}>Failure stage</dt>
                  <dd className={DL_DD}>
                    <code className="mono text-[12px]">
                      {job.failureStage}
                    </code>
                  </dd>
                </>
              ) : null}
              {job.failureReason !== null ? (
                <>
                  <dt className={DL_DT}>Failure reason</dt>
                  <dd className={`${DL_DD} text-[13px]`}>{job.failureReason}</dd>
                </>
              ) : null}
              <dt className={DL_DT}>Queued</dt>
              <dd className={DL_DD}>{formatDateTime(job.createdAt)}</dd>
              <dt className={DL_DT}>Updated</dt>
              <dd className={DL_DD}>{formatDateTime(job.updatedAt)}</dd>
              <dt className={DL_DT}>Attempts</dt>
              <dd className={DL_DD}>
                {job.attemptCount} of {job.maxTotalAttempts}
              </dd>
            </dl>
          </>
        )}
        <label className="toggle mt-[18px] text-[13px]">
          <input
            type="checkbox"
            checked={autoPoll}
            onChange={(event) => onAutoPollChange(event.currentTarget.checked)}
          />
          <span className="track" /> Auto-refresh until terminal
        </label>
        {autoPoll && active ? (
          <div
            className="mt-2.5 flex items-center gap-[7px] text-[12px] text-blue"
            role="status"
          >
            <span
              className="spinner sm blue size-[13px] m-0"
              aria-hidden="true"
            />
            polling every {RELEASE_POLL_INTERVAL_MS / 1000}s…
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Per-status guidance (failed/dead_letter verbatim). */
function JobCallout({ job }: { job: ReleaseJob }) {
  if (job.status === "queued") {
    return (
      <div className={`${CALLOUT} ${CALLOUT_TONE.info} mt-[18px]`}>
        <InfoIcon />
        <div>
          Waiting for a worker to pick this job up. The release becomes{" "}
          <b>Published</b> only when it succeeds — this panel updates live
          while auto-refresh is on.
        </div>
      </div>
    );
  }
  if (job.status === "running") {
    return (
      <div className={`${CALLOUT} ${CALLOUT_TONE.info} mt-[18px]`}>
        <InfoIcon />
        <div>
          Building manifest &amp; signing. The release becomes <b>Published</b>{" "}
          only when this job succeeds — this panel updates live while
          auto-refresh is on.
        </div>
      </div>
    );
  }
  if (job.status === "succeeded") {
    return (
      <div className={`${CALLOUT} ${CALLOUT_TONE.green} mt-[18px]`}>
        <CheckIcon />
        <div>Job succeeded — the manifest is live.</div>
      </div>
    );
  }
  if (job.status === "failed") {
    return (
      <div className={`${CALLOUT} ${CALLOUT_TONE.danger} mt-[18px]`}>
        <AlertIcon />
        <div>
          The job failed. Previous healthy manifests remain authoritative —
          clients keep receiving the last published release.
        </div>
      </div>
    );
  }
  // dead_letter — the only status left.
  return (
    <div className={`${CALLOUT} ${CALLOUT_TONE.danger} mt-[18px]`}>
      <AlertIcon />
      <div>
        Gave up after {job.attemptCount} attempts — contact an operator.
      </div>
    </div>
  );
}

/** Static legend in the right rail (copy aligned to the model: `failed` is terminal). */
function JobStateReferenceCard() {
  return (
    <div className={`${CARD} ${CARD_PAD}`}>
      <div className={`${SECTION_TITLE} mb-[18px]`}>Job state reference</div>
      <div className="flex flex-col gap-[9px]">
        <div className="flex items-center gap-[9px]">
          <JobBadge status="queued" />
          <span className={CELL_SUB}>waiting for a worker</span>
        </div>
        <div className="flex items-center gap-[9px]">
          <JobBadge status="running" />
          <span className={CELL_SUB}>building &amp; signing</span>
        </div>
        <div className="flex items-center gap-[9px]">
          <JobBadge status="succeeded" />
          <span className={CELL_SUB}>manifest is live</span>
        </div>
        <div className="flex items-center gap-[9px]">
          <JobBadge status="failed" />
          <span className={CELL_SUB}>did not publish — prior manifests stay</span>
        </div>
        <div className="flex items-center gap-[9px]">
          <JobBadge status="dead_letter" />
          <span className={CELL_SUB}>gave up — contact an operator</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Metrics panel (independent region, edge case "fetch isolation")
// ---------------------------------------------------------------------------

function MetricsPanel({ releaseId }: { releaseId: string }) {
  const metricsQuery = useReleaseMetrics(releaseId);

  let body: ReactNode;
  if (metricsQuery.isPending) {
    body = (
      <div role="status" aria-label="Loading release metrics">
        <Skeleton variant="line" />
        <Skeleton variant="line" />
      </div>
    );
  } else if (metricsQuery.isError) {
    // Independent failure: "—" counters + retry; the rest of the page stays.
    body = (
      <>
        <CounterGrid metrics={null} />
        <div className={`${CALLOUT} ${CALLOUT_TONE.warn} mt-[18px]`} role="alert">
          <AlertIcon />
          <div>
            Couldn't load metrics for this release — the rest of the page is
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
  } else {
    const metrics = metricsQuery.data.metrics;
    const reported =
      metrics.active +
      metrics.downloaded +
      metrics.installed +
      metrics.success +
      metrics.failed;
    if (reported === 0) {
      body = (
        <EmptyState
          icon={<ChartIcon />}
          title="No metric data yet"
          description="Counters appear once clients report deployment status for this release."
        />
      );
    } else {
      // Rate via model/metrics.ts successRate — null (no Success/Failed
      // events yet) renders as "—", not 0%.
      const rate = successRate(metrics);
      body = (
        <>
          <CounterGrid metrics={metrics} />
          <div className="my-5 h-px bg-border" />
          <div className="flex items-center justify-between gap-3.5">
            <span className="text-[13px] text-fg-2">Install success rate</span>
            <span
              className="font-extrabold"
              style={{ color: rate === null ? undefined : "var(--color-green-deep)" }}
            >
              {rate === null ? "—" : `${(rate * 100).toFixed(1)}%`}
            </span>
          </div>
          {rate !== null ? (
            // Decorative restatement of the % above.
            <div className={`${ROLLOUT} mt-2.5`} aria-hidden="true">
              <div className={ROLLOUT_TRACK}>
                <div
                  className={rate >= 1 ? ROLLOUT_FILL_FULL : ROLLOUT_FILL}
                  style={{ width: `${rate * 100}%` }}
                />
              </div>
            </div>
          ) : null}
        </>
      );
    }
  }

  return (
    <div className={`${CARD} ${CARD_PAD}`}>
      <div className="mb-[18px] flex items-center justify-between gap-3.5">
        <div className={SECTION_TITLE}>
          <span className="size-[18px] text-blue" aria-hidden="true">
            <ChartIcon />
          </span>
          Metrics
        </div>
        <span className={`${CHIP} ${CHIP_TONE.neutral}`}>grouped by package hash</span>
      </div>
      {body}
    </div>
  );
}

/** Counter grid; null metrics render the "—" degraded variant. */
function CounterGrid({ metrics }: { metrics: ReleaseMetrics | null }) {
  return (
    <div className="grid-cols-[repeat(4,1fr)] gap-3 [display:grid] max-cols:grid-cols-[repeat(2,1fr)]">
      <Counter label="Active" value={metrics === null ? null : metrics.active} />
      <Counter
        label="Downloaded"
        value={metrics === null ? null : metrics.downloaded}
      />
      <Counter
        label="Installed"
        value={metrics === null ? null : metrics.installed}
      />
      <Counter
        label="Success"
        value={metrics === null ? null : metrics.success}
        accent="var(--color-green-deep)"
      />
      <Counter
        label="Failed"
        value={metrics === null ? null : metrics.failed}
        accent="var(--color-red)"
      />
    </div>
  );
}

function Counter({
  label,
  value,
  accent,
}: {
  label: string;
  value: number | null;
  accent?: string;
}) {
  return (
    <div>
      <div className="text-[12px] font-semibold text-fg-3">{label}</div>
      <div
        className="text-[22px] font-extrabold tabular-nums"
        style={{ color: value === null ? undefined : accent }}
      >
        {value === null ? "—" : formatCount(value)}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skeleton (page-level: the release envelope owns the whole layout)
// ---------------------------------------------------------------------------

function ReleaseDetailSkeleton() {
  return (
    <div role="status" aria-label="Loading release">
      <div className="mb-6 flex flex-wrap items-start gap-[18px]">
        <div className="min-w-0 flex-1">
          <Skeleton width={160} height={34} />
          <div className="mt-3">
            <Skeleton width={280} variant="text" />
          </div>
        </div>
      </div>
      <div className="grid-cols-[1fr_360px] items-start gap-[22px] [display:grid] max-cols:grid-cols-[1fr]">
        <div className="flex flex-col gap-[22px]">
          <div className={`${CARD} ${CARD_PAD}`}>
            <Skeleton variant="line" />
            <Skeleton variant="line" />
            <Skeleton variant="line" />
            <Skeleton variant="line" />
          </div>
          <div className={`${CARD} ${CARD_PAD}`}>
            <Skeleton variant="line" />
            <Skeleton variant="line" />
          </div>
        </div>
        <div className={`${CARD} ${CARD_PAD}`}>
          <Skeleton variant="line" />
          <Skeleton variant="line" />
          <Skeleton variant="line" />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Opaque ids (user / release) shortened for display; full value in `title`/copy. */
function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

// Icon paths use lucide-style glyphs (`server`, `refresh`, `shield`,
// `info`, `alert`, `chart`, `trendUp`, `rocket`, `pause`, `check`) plus a
// local lucide-style `pencil`.

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

function ServerIcon() {
  return (
    <IconSvg>
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <line x1="7" y1="7.5" x2="7" y2="7.5" />
      <line x1="7" y1="16.5" x2="7" y2="16.5" />
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

function ShieldIcon() {
  return (
    <IconSvg>
      <path d="M12 2 4 5v6c0 5 3.4 8.5 8 10 4.6-1.5 8-5 8-10V5l-8-3z" />
    </IconSvg>
  );
}

function InfoIcon() {
  return (
    <IconSvg>
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16" />
      <line x1="12" y1="8" x2="12" y2="8" />
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

function ChartIcon() {
  return (
    <IconSvg>
      <path d="M3 3v18h18" />
      <rect x="7" y="11" width="3" height="6" rx="1" fill="currentColor" stroke="none" />
      <rect x="12.5" y="7" width="3" height="10" rx="1" fill="currentColor" stroke="none" />
      <rect x="18" y="13" width="3" height="4" rx="1" fill="currentColor" stroke="none" />
    </IconSvg>
  );
}

function TrendUpIcon() {
  return (
    <IconSvg>
      <polyline points="3 17 9 11 13 15 21 7" />
      <polyline points="15 7 21 7 21 13" />
    </IconSvg>
  );
}

function RocketIcon() {
  return (
    <IconSvg>
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
      <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </IconSvg>
  );
}

function PauseIcon() {
  return (
    <IconSvg>
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </IconSvg>
  );
}

function PlayIcon() {
  return (
    <IconSvg>
      <polygon points="7 5 19 12 7 19 7 5" />
    </IconSvg>
  );
}

function PencilIcon() {
  return (
    <IconSvg>
      <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
    </IconSvg>
  );
}

function CheckIcon() {
  return (
    <IconSvg>
      <polyline points="20 6 9 17 4 12" />
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
