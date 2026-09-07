// Host-level install status (health, disk, object storage, Patch releases).
// Every server probe arrives in the same `{ status, ... }` envelope; `skipped`
// rows are omitted rather than shown as failures, except Download URL, which
// stays visible as "Not checked" (the server skips loopback origins). Running
// version is `server/package.json` `version`. `topology` decides which cards
// apply: Disk only with a bundled Postgres/MinIO, Version only on self-host.

import { useQuery } from "@tanstack/react-query";

import {
  CARD,
  CARD_HEAD,
  CARD_HEAD_RIGHT,
  CARD_PAD,
} from "../components/ui/card";
import { CHIP, CHIP_TONE } from "../components/ui/chip";
import { DL, DL_DD, DL_DT } from "../components/ui/dl";
import { ErrorState } from "../components/ui/ErrorState";
import { PageHeader } from "../components/ui/PageHeader";
import { Skeleton } from "../components/ui/Skeleton";
import { useServerStatus } from "../api/hooks/serverStatus";
import { apiServerUrl } from "../lib/cliSnippet";
import { formatBytes } from "../model/artifactUpload";
import {
  diskBarSegments,
  downloadUrlLabel,
  formatDaysAgo,
  formatPatchServerVersion,
  healthReadyState,
  isLoopbackUrl,
  probeOpaqueUrl,
  probeReadiness,
  showDiskCard,
  showVersionCard,
  statusPageDescription,
  type DiskBarKey,
  type DiskBarSegment,
} from "../model/serverStatus";
import type {
  ServerStatus,
  ServerStatusDisk,
  ServerStatusProbe,
} from "../api/types";

export function ServerStatusPage() {
  const query = useServerStatus({ staleTime: 30_000 });

  return (
    <div className="mx-auto w-full max-w-[920px]">
      <PageHeader
        title="Status"
        description={
          query.data
            ? statusPageDescription(query.data.topology)
            : "Host health for this Patch install."
        }
      />

      {query.isPending ? (
        <div role="status" aria-label="Loading server status">
          <Skeleton height={140} className="mb-[18px]" />
          <Skeleton height={140} className="mb-[18px]" />
          <Skeleton height={140} />
        </div>
      ) : query.isError ? (
        <div className={`${CARD} ${CARD_PAD}`}>
          <ErrorState
            error={query.error}
            onRetry={() => {
              void query.refetch();
            }}
          />
        </div>
      ) : (
        <StatusBody status={query.data} />
      )}
    </div>
  );
}

function StatusBody({ status }: { status: ServerStatus }) {
  const disk = status.checks.disk;
  const diskFreeRatio =
    disk.status !== "ok" || disk.totalBytes === 0
      ? null
      : disk.freeBytes / disk.totalBytes;
  const databaseOk = status.checks.database.status === "ok";
  const apiUrl = apiServerUrl();
  const apiIsLocal = isLoopbackUrl(apiUrl);
  const apiProbe = useQuery({
    queryKey: ["api-url-probe", apiUrl],
    queryFn: async ({ signal }) => probeOpaqueUrl(apiUrl, { signal }),
    enabled: !apiIsLocal,
    retry: false,
    staleTime: 30_000,
  });
  const downloadUrl = status.checks.downloadUrl;
  const readyState = healthReadyState({ databaseOk, downloadUrl });

  return (
    <div className="flex flex-col gap-[18px]">
      <section className={CARD}>
        <div className={CARD_HEAD}>
          <h3>Health</h3>
          <span className={CARD_HEAD_RIGHT}>
            <span
              className={`${CHIP} ${
                readyState === "ready" ? CHIP_TONE.green : CHIP_TONE.red
              }`}
            >
              {readyState === "ready" ? "Ready" : "Not ready"}
            </span>
          </span>
        </div>
        <dl className={`${DL} ${CARD_PAD} pt-0`}>
          <ProbeRow label="Database" probe={status.checks.database} />
          <dt className={DL_DT}>Server</dt>
          <dd className={DL_DD}>Ready</dd>
          <ProbeRow label="Object storage" probe={status.checks.storage} />
          <dt className={DL_DT}>API URL</dt>
          <dd className={DL_DD}>{reachabilityLabel(apiUrl, apiProbe)}</dd>
          <dt className={DL_DT}>Download URL</dt>
          <dd
            className={DL_DD}
            title={
              downloadUrl.status === "error"
                ? downloadUrl.error
                : downloadUrl.status === "skipped"
                  ? downloadUrl.reason
                  : downloadUrl.url
            }
          >
            {downloadUrlLabel(downloadUrl)}
          </dd>
        </dl>
      </section>

      {showDiskCard(status.topology) ? (
        <section className={CARD}>
          <div className={CARD_HEAD}>
            <h3>Disk</h3>
            {diskFreeRatio !== null ? (
              <span className={CARD_HEAD_RIGHT}>
                <span
                  className={`${CHIP} ${diskFreeRatio < 0.15 ? CHIP_TONE.yellow : CHIP_TONE.green}`}
                >
                  {Math.round(diskFreeRatio * 100)}% free
                </span>
              </span>
            ) : null}
          </div>
          <div className={CARD_PAD}>
            {disk.status === "ok" ? (
              <DiskBar disk={disk} />
            ) : (
              <p className="text-fg-2 text-[13.5px]">
                {disk.status === "error" ? disk.error : disk.reason}
              </p>
            )}
          </div>
        </section>
      ) : null}

      {showVersionCard(status.topology) ? (
        <section className={CARD}>
          <div className={CARD_HEAD}>
            <h3>Patch server version</h3>
            <span className={CARD_HEAD_RIGHT}>
              <VersionChip status={status} />
            </span>
          </div>
          <dl className={`${DL} ${CARD_PAD} pt-0`}>
            <dt className={DL_DT}>This install</dt>
            <dd className={DL_DD}>
              {formatPatchServerVersion(status.version.running) ?? "Unknown"}
            </dd>
            <dt className={DL_DT}>Latest available</dt>
            <dd className={DL_DD}>
              <LatestVersionLabel status={status} />
            </dd>
          </dl>
          <p className="text-fg-3 px-[22px] pb-[18px] text-[13px]">
            Upgrading is an operator step: run{" "}
            <code className="font-mono text-[12.5px]">
              cmpatch selfhost upgrade
            </code>{" "}
            from a machine with SSH access to the host.
          </p>
        </section>
      ) : null}
    </div>
  );
}

/** One Health-card row per probe; a `skipped` probe renders nothing. */
function ProbeRow({
  label,
  probe,
}: {
  label: string;
  probe: ServerStatusProbe<object>;
}) {
  const readiness = probeReadiness(probe);
  if (readiness === null) {
    return null;
  }

  return (
    <>
      <dt className={DL_DT}>{label}</dt>
      <dd
        className={DL_DD}
        title={probe.status === "error" ? probe.error : undefined}
      >
        {readiness === "ready" ? "Ready" : "Not ready"}
      </dd>
    </>
  );
}

function reachabilityLabel(
  url: string,
  probe: { data?: boolean; isPending: boolean },
): string {
  if (isLoopbackUrl(url)) {
    return "Local";
  }
  if (probe.isPending || probe.data === undefined) {
    return "Checking…";
  }
  return probe.data ? "Reachable" : "Unreachable";
}

const DISK_BAR_COLOR: Record<DiskBarKey, string> = {
  used: "var(--color-blue)",
  free: "var(--color-border-strong)",
};

const DISK_BAR_LABEL: Record<DiskBarKey, string> = {
  used: "Used",
  free: "Free",
};

function DiskBar({ disk }: { disk: ServerStatusDisk }) {
  const segments = diskBarSegments({
    freeBytes: disk.freeBytes,
    totalBytes: disk.totalBytes,
  });
  const barSlices = segments.filter((segment) => segment.bytes > 0);
  const summary = diskBarSummary(segments, disk.totalBytes);

  return (
    <div>
      <div
        className="flex h-3 overflow-hidden rounded-pill bg-surface-3"
        role="img"
        aria-label={summary}
      >
        {barSlices.map((segment) => (
          <span
            key={segment.key}
            className="h-full min-w-0"
            style={{
              background: DISK_BAR_COLOR[segment.key],
              flexGrow: segment.bytes,
              flexShrink: 0,
              flexBasis: 0,
            }}
          />
        ))}
      </div>
      <div className="mt-3.5 flex flex-wrap gap-x-6 gap-y-3">
        {segments.map((segment) => (
          <DiskBarLegendItem key={segment.key} segment={segment} />
        ))}
      </div>
    </div>
  );
}

function DiskBarLegendItem({ segment }: { segment: DiskBarSegment }) {
  return (
    <div className="min-w-[88px]">
      <div className="flex items-center gap-2">
        <span
          className="size-[9px] shrink-0 rounded-[2px]"
          style={{ background: DISK_BAR_COLOR[segment.key] }}
          aria-hidden="true"
        />
        <span className="text-[12.5px] font-semibold text-fg-3">
          {DISK_BAR_LABEL[segment.key]}
        </span>
      </div>
      <div className="text-fg mt-0.5 pl-[17px] text-[13.5px] font-medium">
        {formatBytes(segment.bytes)}
      </div>
    </div>
  );
}

function diskBarSummary(
  segments: DiskBarSegment[],
  totalBytes: number,
): string {
  const parts = segments.map(
    (segment) => `${DISK_BAR_LABEL[segment.key]} ${formatBytes(segment.bytes)}`,
  );
  return `Disk ${formatBytes(totalBytes)}: ${parts.join(", ")}`;
}

function LatestVersionLabel({ status }: { status: ServerStatus }) {
  const latest = status.checks.latestRelease;
  if (latest.status === "skipped") {
    return <span title={latest.reason}>Not checked</span>;
  }
  if (latest.status === "error") {
    return <span title={latest.error}>Could not fetch</span>;
  }
  const version = formatPatchServerVersion(latest.version) ?? latest.tag;
  const age = formatDaysAgo(latest.publishedAt);
  const label = age === null ? version : `${version}, ${age}`;
  return (
    <a
      className="text-blue underline-offset-2 hover:underline"
      href={latest.htmlUrl}
      rel="noopener noreferrer"
      target="_blank"
    >
      {label}
    </a>
  );
}

function VersionChip({ status }: { status: ServerStatus }) {
  if (status.version.updateAvailable === true) {
    return (
      <span className={`${CHIP} ${CHIP_TONE.yellow}`}>Update available</span>
    );
  }
  if (status.version.updateAvailable === false) {
    return <span className={`${CHIP} ${CHIP_TONE.green}`}>Up to date</span>;
  }
  return <span className={`${CHIP} ${CHIP_TONE.neutral}`}>Cannot compare</span>;
}
