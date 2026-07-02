// Deployment-level metrics detail (summary cards, version distribution).
// Mounted only with a resolved deployment id on the metrics drill-down route.

import { Link } from "react-router";
import type { CSSProperties, ReactNode } from "react";

import { useDeploymentMetrics } from "../../api/hooks/metrics";
import { formatCount } from "../../model/format";
import {
  activeVersionDistribution,
  aggregateMetrics,
  successRate,
} from "../../model/metrics";
import type { Deployment } from "../../model/deployment";
import { buttonVariants } from "../../components/ui/Button";
import { CALLOUT, CALLOUT_TONE } from "../../components/ui/callout";
import { CARD, CARD_PAD } from "../../components/ui/card";
import { CHIP, CHIP_TONE } from "../../components/ui/chip";
import { DL, DL_DD, DL_DT } from "../../components/ui/dl";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorState } from "../../components/ui/ErrorState";
import {
  ROLLOUT,
  ROLLOUT_FILL,
  ROLLOUT_TRACK,
} from "../../components/ui/RolloutBar";
import {
  STAT,
  STAT_ICO_ACCENT,
  STAT_ICO_BASE,
  STAT_META,
  STAT_TOP,
  STAT_VAL,
} from "../../components/ui/stat";
import { SECTION_TITLE } from "../../components/ui/typography";
import { MetricsBodySkeleton } from "./MetricsPageFrame";

export function DeploymentCounters({
  teamId,
  appId,
  deployment,
}: {
  teamId: string;
  appId: string;
  deployment: Deployment;
}) {
  const metricsQuery = useDeploymentMetrics(deployment.id, { limit: 100 });

  if (metricsQuery.isPending) {
    return <MetricsBodySkeleton label="Loading deployment metrics" />;
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

  const totals = aggregateMetrics(entries.map((entry) => entry.metrics));
  const rate = successRate(totals);
  const distribution = activeVersionDistribution(
    entries.map((entry) => ({
      label: entry.releaseLabel,
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
            <span className={`${CHIP} ${CHIP_TONE.neutral}`}>
              grouped by package hash
            </span>
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
              <line
                className="stroke-border [stroke-dasharray:3_4] [stroke-width:1]"
                x1="0"
                y1="40"
                x2="720"
                y2="40"
              />
              <line
                className="stroke-border [stroke-dasharray:3_4] [stroke-width:1]"
                x1="0"
                y1="80"
                x2="720"
                y2="80"
              />
              <line
                className="stroke-border [stroke-dasharray:3_4] [stroke-width:1]"
                x1="0"
                y1="120"
                x2="720"
                y2="120"
              />
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
