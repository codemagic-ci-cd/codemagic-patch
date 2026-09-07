// Wire-shape DTOs derived from server/src/domain/types.ts @ 25b9477
// Metrics counters are hash-keyed on the server: releases that share a
// target_package_hash report identical counter values.

export interface ReleaseMetrics {
  active: number;
  downloaded: number;
  failed: number;
  /** Failed counts keyed by client-reported reason; unreported → "unknown". Values sum to `failed`. */
  failureReasons: Record<string, number>;
  /**
   * How many of each reason's failures carried a payload — the reasons whose
   * drill-down has something to show. Reasons with none are absent.
   */
  failureReasonDetailCounts: Record<string, number>;
  installed: number;
  success: number;
}

/** Install success rate as a 0..1 fraction; null when no Success/Failed events exist. */
export function successRate(metrics: ReleaseMetrics): number | null {
  const attempts = metrics.success + metrics.failed;
  if (attempts === 0) {
    return null;
  }

  return metrics.success / attempts;
}

/** Field-wise sum; an empty list yields all-zero counters. */
export function aggregateMetrics(list: ReleaseMetrics[]): ReleaseMetrics {
  const total: ReleaseMetrics = {
    active: 0,
    downloaded: 0,
    failed: 0,
    failureReasonDetailCounts: {},
    failureReasons: {},
    installed: 0,
    success: 0,
  };

  for (const metrics of list) {
    total.active += metrics.active;
    total.downloaded += metrics.downloaded;
    total.failed += metrics.failed;
    total.installed += metrics.installed;
    total.success += metrics.success;
    for (const [reason, count] of Object.entries(metrics.failureReasons)) {
      total.failureReasons[reason] = (total.failureReasons[reason] ?? 0) + count;
    }
    for (const [reason, count] of Object.entries(
      metrics.failureReasonDetailCounts,
    )) {
      total.failureReasonDetailCounts[reason] =
        (total.failureReasonDetailCounts[reason] ?? 0) + count;
    }
  }

  return total;
}

export interface FailureReasonShare {
  reason: string;
  /** Human-readable label for the known reason taxonomy; raw reason otherwise. */
  label: string;
  count: number;
  /** This reason's share of all failures as a 0..1 fraction. */
  share: number;
  /**
   * True when at least one of this reason's failures carried a payload, so a
   * drill-down has something to show. False makes the row inert — offering to
   * open a dialog that can only say "nothing reported" is a dead end.
   */
  hasDetail: boolean;
}

// Reason taxonomy from client/specs/metrics/Spec.md §`Failed` Event Reason
// Values; "unknown" is the server-side bucket for events without a reason.
const FAILURE_REASON_LABELS: Record<string, string> = {
  install_fail: "Install failed (crash rollback)",
  integrity: "Integrity check failed",
  invalid_manifest: "Invalid manifest",
  missing_binary_version: "Missing binary version",
  network: "Network error",
  signature_verification: "Signature verification failed",
  unknown: "Unknown reason",
};

/**
 * Failure breakdown sorted by count (desc), ties by reason for a stable
 * order. Empty when no failures were reported.
 */
export function failureReasonShares(
  metrics: ReleaseMetrics,
): FailureReasonShare[] {
  const entries = Object.entries(metrics.failureReasons).filter(
    ([, count]) => count > 0,
  );
  let totalCount = 0;
  for (const [, count] of entries) {
    totalCount += count;
  }

  return entries
    .sort(([reasonA, countA], [reasonB, countB]) =>
      countB !== countA ? countB - countA : reasonA.localeCompare(reasonB),
    )
    .map(([reason, count]) => ({
      reason,
      label: failureReasonLabel(reason),
      count,
      share: totalCount === 0 ? 0 : count / totalCount,
      hasDetail: (metrics.failureReasonDetailCounts[reason] ?? 0) > 0,
    }));
}

// --- Failure detail (PROTOCOL.md §Metric Event `Failed` Payload) -------------

/**
 * Failures sharing one `payload.code`. `code` is null for failures reported
 * without a decodable payload: SDKs older than the payload contract and
 * malformed blobs both land in that bucket.
 *
 * The bucket's detail (distributions, raw events) is fetched only when a
 * reader opens it, so a code nobody opens costs nothing beyond this row.
 */
export interface FailureCodeBreakdown {
  code: string | null;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** Human-readable label for a reason; falls back to the raw value. */
export function failureReasonLabel(reason: string): string {
  return FAILURE_REASON_LABELS[reason] ?? reason;
}

export interface FailureCodeLabel {
  /** True when the text is a machine code, so callers can render it in mono. */
  isCode: boolean;
  text: string;
}

/**
 * Display label for a payload code.
 *
 * `network` codes are HTTP statuses (PROTOCOL.md §Metric Event `Failed`
 * Payload), where `"0"` is the sentinel for "the request produced no HTTP
 * response". Both sentinels are spelled out rather than shown raw: a bare `0`
 * in a column of counts reads as a count, not as a status.
 *
 * Reasons whose payload schema is not yet defined fall through to the raw
 * code, so a new schema renders sensibly before this function knows about it.
 */
export function failureCodeLabel(
  reason: string,
  code: string | null,
): FailureCodeLabel {
  if (code === null) {
    return { isCode: false, text: "No code reported" };
  }

  if (reason !== "network") {
    return { isCode: true, text: code };
  }

  return code === "0"
    ? { isCode: false, text: "No HTTP response" }
    : { isCode: true, text: `HTTP ${code}` };
}

export interface FailureCodeShare extends FailureCodeBreakdown {
  /** This code's share of the reason's failures as a 0..1 fraction. */
  share: number;
}

/**
 * Per-code shares within one reason, preserving the server's count-desc order.
 *
 * The denominator is the reason's own total from the counters card, not the
 * sum of the loaded page — otherwise a code's share would climb as the reader
 * scrolls more pages in.
 */
export function failureCodeShares(
  codes: FailureCodeBreakdown[],
  reasonTotal: number,
): FailureCodeShare[] {
  return codes.map((code) => ({
    ...code,
    share: reasonTotal === 0 ? 0 : code.count / reasonTotal,
  }));
}

/** One bar in a code bucket's distribution chart. */
export interface FailureDistributionEntry {
  count: number;
  value: string;
}

/**
 * A code bucket's top value distributions, aggregated over the whole bucket
 * rather than over the event pages the reader has scrolled in. A chart derived
 * from the loaded pages would describe the newest N events and would keep
 * shifting as the reader scrolls, which is the opposite of what a distribution
 * is for.
 */
export interface FailureDistribution {
  /** Distinct `payload.android_previous_process_exit` values; empty off Android. */
  exitReasons: FailureDistributionEntry[];
  /** Distinct `payload.message` values, highest count first. */
  messages: FailureDistributionEntry[];
  /** Events in the bucket, so percentages account for the untruncated tail. */
  total: number;
}

/** One raw `Failed` event inside a code bucket. */
export interface FailureEvent {
  androidPreviousProcessExit: string | null;
  deviceId: string;
  emittedAt: string;
  id: string;
  message: string | null;
}

/**
 * One keyset page of raw events. The cursor is opaque to the dashboard: it
 * encodes `(emitted_at, id)` so a page boundary stays put while new events
 * keep arriving, which an offset cannot do on a continuously written table.
 */
export interface FailureEventPage {
  events: FailureEvent[];
  /** Null once the last page has been served. */
  nextCursor: string | null;
}

export interface FailureDistributionBar extends FailureDistributionEntry {
  /** Share of the whole bucket, 0..1 — the figure written out. */
  share: number;
  /** Width relative to the largest bar, 0..1 — the figure drawn. */
  width: number;
}

/**
 * Prepares distribution entries for drawing.
 *
 * The width is relative to the largest entry while the percentage stays
 * relative to the bucket. Drawing to the total instead would flatten every bar
 * into an unreadable sliver whenever one value dominates, and one value
 * dominating is the common case for a failure code.
 */
export function failureDistributionBars(
  entries: readonly FailureDistributionEntry[],
  total: number,
): FailureDistributionBar[] {
  let max = 0;
  for (const entry of entries) {
    max = Math.max(max, entry.count);
  }

  return entries.map((entry) => ({
    ...entry,
    share: total === 0 ? 0 : entry.count / total,
    width: max === 0 ? 0 : entry.count / max,
  }));
}

export interface ActiveVersionEntry {
  label: string;
  targetPackageHash: string;
  metrics: ReleaseMetrics;
}

export interface ActiveVersionShare {
  label: string;
  targetPackageHash: string;
  active: number;
  /** This hash's share of total active installs as a 0..1 fraction (0 when no active installs). */
  share: number;
}

/**
 * Active-install distribution grouped by `targetPackageHash`.
 *
 * Counters are hash-keyed, so entries sharing a hash carry identical counts —
 * each hash is counted exactly once. The first entry seen for a hash provides
 * its label (newest-first inputs therefore label groups by their latest
 * release). Input order is preserved in the output.
 */
export function activeVersionDistribution(
  entries: ActiveVersionEntry[],
): ActiveVersionShare[] {
  const byHash = new Map<string, { active: number; label: string }>();

  for (const entry of entries) {
    if (!byHash.has(entry.targetPackageHash)) {
      byHash.set(entry.targetPackageHash, {
        active: entry.metrics.active,
        label: entry.label,
      });
    }
  }

  let totalActive = 0;
  for (const group of byHash.values()) {
    totalActive += group.active;
  }

  return [...byHash.entries()].map(([targetPackageHash, group]) => ({
    label: group.label,
    targetPackageHash,
    active: group.active,
    share: totalActive === 0 ? 0 : group.active / totalActive,
  }));
}
