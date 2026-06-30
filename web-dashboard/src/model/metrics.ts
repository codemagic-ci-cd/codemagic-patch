// Wire-shape DTOs derived from server/src/domain/types.ts @ 25b9477
// Metrics counters are hash-keyed on the server: releases that share a
// target_package_hash report identical counter values.

export interface ReleaseMetrics {
  active: number;
  downloaded: number;
  failed: number;
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
    installed: 0,
    success: 0,
  };

  for (const metrics of list) {
    total.active += metrics.active;
    total.downloaded += metrics.downloaded;
    total.failed += metrics.failed;
    total.installed += metrics.installed;
    total.success += metrics.success;
  }

  return total;
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
