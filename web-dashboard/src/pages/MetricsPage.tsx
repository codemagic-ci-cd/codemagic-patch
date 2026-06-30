// Metrics dashboard.
// Visible to ALL roles (`release.view` includes viewer) — no RBAC gating here.
// Scope cascade: App selector (useApps) → Deployment selector (useDeployments)
// → counters from `GET /v1/metrics/deployments/:id` via useDeploymentMetrics.
// Every derived number comes from model/metrics.ts: aggregateMetrics
// (summary cards), successRate (null → "—" when no Success/Failed events),
// and activeVersionDistribution (hash-keyed grouping, share as 0..1) — this
// page does NOT re-derive any math. Component layering exists because hooks
// can't be conditional: <ScopedMetrics> mounts only with a non-empty app
// list, <DeploymentCounters> only with a resolved deployment, so every hook
// call always has a valid id. Time-series/adoption-over-time is out of MVP
// — rendered as the muted "coming soon" note, never fetched.

import { useState } from "react";
import { Link, useParams } from "react-router";
import type { CSSProperties, ReactNode } from "react";

import { useApps } from "../api/hooks/apps";
import { useDeployments } from "../api/hooks/deployments";
import { useDeploymentMetrics } from "../api/hooks/metrics";
import { formatCount } from "../model/format";
import {
  activeVersionDistribution,
  aggregateMetrics,
  successRate,
} from "../model/metrics";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorState } from "../components/ui/ErrorState";
import { Skeleton } from "../components/ui/Skeleton";
import type { App } from "../model/app";
import type { Deployment } from "../model/deployment";
import { buttonVariants } from "../components/ui/Button";
import { CALLOUT, CALLOUT_TONE } from "../components/ui/callout";
import { CARD, CARD_PAD } from "../components/ui/card";
import { CHIP, CHIP_TONE } from "../components/ui/chip";
import { DL, DL_DT, DL_DD } from "../components/ui/dl";
import { INPUT, INPUT_STATE, SELECT_EXTRA } from "../components/ui/form";
import { ROLLOUT, ROLLOUT_FILL, ROLLOUT_TRACK } from "../components/ui/RolloutBar";
import {
  STAT,
  STAT_ICO_ACCENT,
  STAT_ICO_BASE,
  STAT_META,
  STAT_TOP,
  STAT_VAL,
} from "../components/ui/stat";
import { PAGE_SUB, PAGE_TITLE, SECTION_TITLE } from "../components/ui/typography";

export function MetricsPage() {
  const { teamId } = useParams<{ teamId: string }>();
  const appsQuery = useApps(teamId ?? "");

  if (appsQuery.isPending) {
    return (
      <PageFrame>
        <BodySkeleton label="Loading metrics" />
      </PageFrame>
    );
  }

  if (appsQuery.isError) {
    return (
      <PageFrame>
        <div className={`${CARD} ${CARD_PAD}`}>
          <ErrorState
            error={appsQuery.error}
            onRetry={() => {
              void appsQuery.refetch();
            }}
          />
        </div>
      </PageFrame>
    );
  }

  if (appsQuery.data.length === 0) {
    // Selector-empty state: metrics are per-deployment, so without apps
    // there is nothing to select — point at the apps screen.
    return (
      <PageFrame>
        <div className={`${CARD} ${CARD_PAD}`}>
          <EmptyState
            icon={<LayersIcon />}
            title="No apps yet"
            description="Metrics are reported per deployment. Create an app to get its deployments, then come back here."
            action={
              <Link className={buttonVariants({ intent: "primary" })} to={`/teams/${teamId}/apps`}>
                Go to apps
              </Link>
            }
          />
        </div>
      </PageFrame>
    );
  }

  return <ScopedMetrics teamId={teamId ?? ""} apps={appsQuery.data} />;
}

// ---------------------------------------------------------------------------
// App → Deployment scope (mounted only with a non-empty app list)
// ---------------------------------------------------------------------------

function ScopedMetrics({ teamId, apps }: { teamId: string; apps: App[] }) {
  const [selectedAppId, setSelectedAppId] = useState(apps[0].id);
  const [selectedDepId, setSelectedDepId] = useState<string | null>(null);

  // Survive a refetch that drops the selected app (e.g. deleted elsewhere).
  const appId = apps.some((app) => app.id === selectedAppId)
    ? selectedAppId
    : apps[0].id;

  const deploymentsQuery = useDeployments(appId);
  const deployments = deploymentsQuery.data;
  const deployment =
    deployments?.find((candidate) => candidate.id === selectedDepId) ??
    deployments?.[0];

  const selectors = (
    <>
      <select
        className={`${INPUT} ${INPUT_STATE.normal} ${SELECT_EXTRA} select min-w-[190px]`}
        aria-label="App"
        value={appId}
        onChange={(event) => {
          setSelectedAppId(event.target.value);
          setSelectedDepId(null);
        }}
      >
        {apps.map((app) => (
          <option key={app.id} value={app.id}>
            {app.name}
          </option>
        ))}
      </select>
      {deployments !== undefined && deployment !== undefined ? (
        <select
          className={`${INPUT} ${INPUT_STATE.normal} ${SELECT_EXTRA} select min-w-[150px]`}
          aria-label="Deployment"
          value={deployment.id}
          onChange={(event) => setSelectedDepId(event.target.value)}
        >
          {deployments.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
      ) : null}
    </>
  );

  return (
    <PageFrame actions={selectors}>
      {deploymentsQuery.isPending ? (
        <BodySkeleton label="Loading deployments" />
      ) : deploymentsQuery.isError ? (
        <div className={`${CARD} ${CARD_PAD}`}>
          <ErrorState
            error={deploymentsQuery.error}
            onRetry={() => {
              void deploymentsQuery.refetch();
            }}
          />
        </div>
      ) : deployment === undefined ? (
        // Selector-empty state: the chosen app has no deployments.
        <div className={`${CARD} ${CARD_PAD}`}>
          <EmptyState
            icon={<LayersIcon />}
            title="No deployments in this app"
            description="Deployments are created from the app's settings. Add one to start collecting metrics."
            action={
              <Link
                className={buttonVariants({ intent: "primary" })}
                to={`/teams/${teamId}/apps/${appId}`}
              >
                Open app
              </Link>
            }
          />
        </div>
      ) : (
        <DeploymentCounters
          key={deployment.id}
          teamId={teamId}
          appId={appId}
          deployment={deployment}
        />
      )}
    </PageFrame>
  );
}

// ---------------------------------------------------------------------------
// Counters for one deployment (mounted only with a resolved deployment)
// ---------------------------------------------------------------------------

function DeploymentCounters({
  teamId,
  appId,
  deployment,
}: {
  teamId: string;
  appId: string;
  deployment: Deployment;
}) {
  // limit=100 is the server's page maximum — the widest single-call window
  // for the aggregate (counters are hash-keyed, duplicates collapse anyway).
  const metricsQuery = useDeploymentMetrics(deployment.id, { limit: 100 });

  if (metricsQuery.isPending) {
    return <BodySkeleton label="Loading deployment metrics" />;
  }

  if (metricsQuery.isError) {
    return (
      <div className={`${CARD} ${CARD_PAD}`}>
        <ErrorState
          error={metricsQuery.error}
          onRetry={() => {
            void metricsQuery.refetch();
          }}
        />
      </div>
    );
  }

  const entries = metricsQuery.data.releases;

  if (entries.length === 0) {
    return (
      <div className={`${CARD} ${CARD_PAD}`}>
        <EmptyState
          icon={<ActivityIcon />}
          title="No metric data yet"
          description="Install metrics appear once clients download and report releases from this deployment."
        />
      </div>
    );
  }

  // All derivation via model/metrics.ts — no math re-derived here.
  const totals = aggregateMetrics(entries.map((entry) => entry.metrics));
  const rate = successRate(totals);
  const distribution = activeVersionDistribution(
    entries.map((entry) => ({
      label: entry.releaseLabel,
      // A null hash (not yet processed) is its own group — key it by release.
      targetPackageHash: entry.targetPackageHash ?? `release:${entry.releaseId}`,
      metrics: entry.metrics,
    })),
  );
  const activeVersionCount = distribution.filter(
    (share) => share.active > 0,
  ).length;
  const attempts = totals.success + totals.failed;

  return (
    <>
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
          <div className={STAT_VAL}>{formatCount(totals.active)}</div>
          <div className={STAT_META}>
            on {activeVersionCount}{" "}
            {activeVersionCount === 1 ? "active version" : "active versions"}
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
          <div className={STAT_VAL}>{formatCount(totals.downloaded)}</div>
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
          <div className={STAT_META}>success / (success + failed)</div>
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
          <div className={STAT_VAL}>{formatCount(totals.failed)}</div>
          <div className={STAT_META}>failed installs</div>
        </div>
      </div>

      <div className="grid-cols-[1fr_360px] items-start gap-[22px] [display:grid] max-cols:grid-cols-[1fr]">
        <div className={`${CARD} ${CARD_PAD}`}>
          <div className="mb-[18px] flex items-center justify-between gap-3.5">
            <div className={SECTION_TITLE}>
              <span className="size-[18px] text-blue" aria-hidden="true">
                <LayersIcon />
              </span>{" "}
              Active version distribution
            </div>
            <span className={`${CHIP} ${CHIP_TONE.neutral}`}>grouped by package hash</span>
          </div>

          <div className="mt-1.5 flex flex-col gap-[18px]">
            {distribution.map((share) => (
              <div key={share.targetPackageHash}>
                <div className="mb-[7px] flex items-center justify-between gap-3.5">
                  <div className="flex items-center gap-2.5">
                    <b>{share.label}</b>
                  </div>
                  <span className="mono text-[12.5px] text-fg-2">
                    {formatCount(share.active)} ·{" "}
                    {(share.share * 100).toFixed(1)}%
                  </span>
                </div>
                <div className={ROLLOUT}>
                  <div
                    className={ROLLOUT_TRACK}
                    // height:10 OVERRIDES ROLLOUT_TRACK's h-[7px] (these
                    // distribution bars are taller); conflicting utilities
                    // cannot co-apply, so the height stays inline.
                    style={{ height: 10 }}
                    role="progressbar"
                    aria-label={`${share.label} share of active installs`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(share.share * 100)}
                    aria-valuetext={`${(share.share * 100).toFixed(1)}%`}
                  >
                    <div
                      className={ROLLOUT_FILL}
                      style={{ width: `${share.share * 100}%` }}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="my-5 h-px bg-border" />
          {/* Muted note: time-series is out of MVP — nothing is fetched. */}
          <div className={`${CALLOUT} ${CALLOUT_TONE.info}`}>
            <InfoIcon />
            <div>
              <b>Adoption over time</b> is coming soon. Time-series needs a
              server aggregate endpoint and stays off until one exists.
            </div>
          </div>
          <div className="relative mt-3.5">
            <svg
              className="block h-auto w-full opacity-[.18]"
              viewBox="0 0 720 150"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <polyline
                fill="none"
                stroke="var(--color-blue)"
                strokeWidth={3}
                points="0,120 90,90 180,100 270,60 360,70 450,40 540,55 630,30 720,35"
              />
              {/* Static grid lines (legacy `.chart .grid-line`); the polyline
                  geometry above stays inline (dynamic chart scaffolding). */}
              <line className="stroke-border [stroke-dasharray:3_4] [stroke-width:1]" x1="0" y1="40" x2="720" y2="40" />
              <line className="stroke-border [stroke-dasharray:3_4] [stroke-width:1]" x1="0" y1="80" x2="720" y2="80" />
              <line className="stroke-border [stroke-dasharray:3_4] [stroke-width:1]" x1="0" y1="120" x2="720" y2="120" />
            </svg>
            <div className="absolute inset-0 place-items-center [display:grid]">
              <span className={`${CHIP} ${CHIP_TONE.neutral}`}>
                <ClockIcon /> Time-series coming soon
              </span>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-[22px]">
          <div className={`${CARD} ${CARD_PAD}`}>
            <div className={`${SECTION_TITLE} mb-[18px]`}>Install outcomes</div>
            {attempts === 0 ? (
              <p className="text-[13px] text-fg-2">
                No install outcomes reported yet.
              </p>
            ) : (
              <>
                <div className="flex h-4 overflow-hidden rounded-pill bg-surface-3 [&_span]:h-full">
                  <span
                    className="bg-green"
                    style={{ width: `${(totals.success / attempts) * 100}%` }}
                  />
                  <span
                    className="bg-red"
                    style={{ width: `${(totals.failed / attempts) * 100}%` }}
                  />
                </div>
                <div className="mt-[14px] flex flex-wrap gap-[14px]">
                  <span className="flex items-center gap-[7px] text-[12.5px] text-fg-2 [&_b]:tabular-nums [&_b]:text-fg">
                    <span className="size-[10px] flex-none rounded-[4px] bg-green" />
                    Succeeded <b>{formatCount(totals.success)}</b>
                  </span>
                  <span className="flex items-center gap-[7px] text-[12.5px] text-fg-2 [&_b]:tabular-nums [&_b]:text-fg">
                    <span className="size-[10px] flex-none rounded-[4px] bg-red" />
                    Failed <b>{formatCount(totals.failed)}</b>
                  </span>
                </div>
              </>
            )}
            <div className="my-5 h-px bg-border" />
            <dl className={DL}>
              <dt className={DL_DT}>Active</dt>
              <dd className={`${DL_DD} mono`}>{formatCount(totals.active)}</dd>
              <dt className={DL_DT}>Downloaded</dt>
              <dd className={`${DL_DD} mono`}>{formatCount(totals.downloaded)}</dd>
              <dt className={DL_DT}>Installed</dt>
              <dd className={`${DL_DD} mono`}>{formatCount(totals.installed)}</dd>
              <dt className={DL_DT}>Success</dt>
              <dd className={`${DL_DD} mono`}>{formatCount(totals.success)}</dd>
              <dt className={DL_DT}>Failed</dt>
              <dd className={`${DL_DD} mono text-red`}>
                {formatCount(totals.failed)}
              </dd>
            </dl>
          </div>
          <div className={`${CARD} ${CARD_PAD}`}>
            <div className={`${SECTION_TITLE} mb-[18px]`}>Per release</div>
            <p className="text-[13px] text-fg-2">
              Open a release to see its isolated metrics and worker job.
            </p>
            <Link
              className={`${buttonVariants({ intent: "ghost", block: true })} mt-2.5`}
              to={`/teams/${teamId}/apps/${appId}/deployments/${deployment.id}`}
            >
              <ActivityIcon /> View release history
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Frame + skeleton
// ---------------------------------------------------------------------------

function PageFrame({
  actions,
  children,
}: {
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <div className="mb-6 flex flex-wrap items-start gap-[18px]">
        <div className="min-w-0 flex-1">
          <h1 className={PAGE_TITLE}>
            Metrics
          </h1>
          <p className={PAGE_SUB}>
            Adoption and reliability per deployment, derived live from release
            metrics. Visible to everyone on the team.
          </p>
        </div>
        {actions !== undefined ? (
          <div className="flex items-center gap-2.5">{actions}</div>
        ) : null}
      </div>
      {children}
    </>
  );
}

function BodySkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label}>
      <div className="mb-[18px] grid-cols-[repeat(4,1fr)] gap-[18px] [display:grid] max-cols:grid-cols-[repeat(2,1fr)]">
        <Skeleton height={118} />
        <Skeleton height={118} />
        <Skeleton height={118} />
        <Skeleton height={118} />
      </div>
      <div className={`${CARD} ${CARD_PAD}`}>
        <Skeleton variant="line" />
        <Skeleton variant="line" />
        <Skeleton variant="line" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Icon paths use lucide-style glyphs (`users2`, `download`,
// `checkCircle`, `alert`, `layers`, `info`, `clock`, `activity`).

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

function LayersIcon() {
  return (
    <IconSvg>
      <path d="m12 2 9 5-9 5-9-5 9-5z" />
      <path d="m3 12 9 5 9-5" />
      <path d="m3 17 9 5 9-5" />
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

function ClockIcon() {
  return (
    <IconSvg>
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15 14" />
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
