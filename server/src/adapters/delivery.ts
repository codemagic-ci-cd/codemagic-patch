/**
 * DeliveryAdapter — public download URL resolution and cache purge abstraction.
 *
 * The server never serves manifests or artifacts directly. The
 * DeliveryAdapter maps storage keys to publicly downloadable URLs and
 * triggers cache invalidation after manifest updates.
 *
 * Design rationale:
 *   - OSS deployments may serve directly from object storage.
 *   - Production deployments may put a CDN in front; provider-specific
 *     delivery adapters, such as CloudflareDeliveryAdapter, implement purge
 *     behind this same interface.
 *   - Purge is best-effort and must never fail a release job.
 */

// ---------------------------------------------------------------------------
// Core interface
// ---------------------------------------------------------------------------

export interface DeliveryAdapter {
  /**
   * Resolve a public storage key to a publicly downloadable URL.
   *
   * Example:
   *   resolveUrl("abc123/1.0.0/deadbeef/manifest.json")
   *   → "https://downloads.example.com/abc123/1.0.0/deadbeef/manifest.json"
   *
   * The returned URL must be stable for a given public key and suitable
   * for embedding in client-facing manifests. Request-scoped signed URLs
   * are not a valid implementation for this method.
   */
  resolveUrl(publicKey: string): string;

  /**
   * Request cache invalidation for the given paths.
   *
   * Purge is best-effort: implementations should not throw on failure.
   * Returns a result indicating success or partial failure for logging.
   *
   * @param paths - Public storage keys (not full URLs) to purge.
   */
  purge(paths: string[]): Promise<PurgeResult>;
}

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

export interface PurgeResult {
  /** Number of paths for which purge was requested. */
  requested: number;
  /** Number of paths successfully purged (or accepted by the cache layer). */
  succeeded: number;
  /** Paths that failed to purge, with error details. */
  failures: PurgeFailure[];
}

export interface PurgeFailure {
  path: string;
  reason: string;
}
