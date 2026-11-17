import type { ReleaseMetrics } from "../domain/types";

/** Applied over Applied + Failed; null while no device has reached either. */
export function successRate(counts: {
  failed: number;
  success: number;
}): number | null {
  const decided = counts.success + counts.failed;
  return decided === 0 ? null : counts.success / decided;
}

export interface DeploymentMetricsSummary {
  /** "deployment" only when the page holds every release of the deployment. */
  coverage: "deployment" | "page";
  metrics: ReleaseMetrics;
}

/**
 * Sums one page of deployment metrics rows. Counters are keyed by package
 * hash, so rows sharing a hash (every rollback re-inserts its target's hash)
 * carry the same counters and are counted once. Rows without a hash have no
 * counters. Hashes recur across pages, so page summaries cannot be added up.
 */
export function summarizeDeploymentMetrics(page: {
  pagination: { offset: number; total: number };
  releases: ReadonlyArray<{
    metrics: ReleaseMetrics;
    targetPackageHash: string | null;
  }>;
}): DeploymentMetricsSummary {
  const metrics: ReleaseMetrics = {
    active: 0,
    downloaded: 0,
    failed: 0,
    failureReasonDetailCounts: {},
    failureReasons: {},
    installed: 0,
    success: 0,
  };
  const seenHashes = new Set<string>();
  for (const row of page.releases) {
    if (row.targetPackageHash === null || seenHashes.has(row.targetPackageHash)) {
      continue;
    }
    seenHashes.add(row.targetPackageHash);
    metrics.active += row.metrics.active;
    metrics.downloaded += row.metrics.downloaded;
    metrics.failed += row.metrics.failed;
    metrics.installed += row.metrics.installed;
    metrics.success += row.metrics.success;
    addCounts(metrics.failureReasons, row.metrics.failureReasons);
    addCounts(
      metrics.failureReasonDetailCounts,
      row.metrics.failureReasonDetailCounts,
    );
  }

  return {
    coverage:
      page.pagination.offset === 0 &&
      page.releases.length === page.pagination.total
        ? "deployment"
        : "page",
    metrics,
  };
}

function addCounts(
  into: Record<string, number>,
  from: Record<string, number>,
): void {
  for (const [key, count] of Object.entries(from)) {
    // Reasons are client-reported strings; "constructor" must not read the
    // inherited property as an existing count.
    into[key] = (Object.hasOwn(into, key) ? into[key] : 0) + count;
  }
}
